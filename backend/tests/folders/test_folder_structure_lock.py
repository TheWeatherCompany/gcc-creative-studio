# Copyright 2026 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Post-lock re-validation of folder structure changes, on a real session.

SQLite has no advisory locks, so lock_workspace_structure is replaced here
by a stand-in that records which workspaces were locked and then lands the
write a concurrent request committed while this one waited. Every statement
after the lock sees that write, as under READ COMMITTED on PostgreSQL, but
ORM objects read before the lock are stale unless re-read. Each test checks
that the operation validates against the post-lock tree. The races
themselves, on two real PostgreSQL sessions, were verified out of tree.
"""

import json
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, status
from sqlalchemy import event, text
from sqlalchemy.dialects import sqlite as sqlite_dialect
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.types import ARRAY

from src.common.schema.media_item_model import MediaItem
from src.folders.dto.folder_dto import (
    CopyItemsDto,
    FolderCreateDto,
    FolderUpdateDto,
    MoveItemsDto,
)
from src.folders.folder_service import FolderService
from src.folders.repository.folder_repository import FolderRepository
from src.folders.schema.folder_model import Folder
from src.galleries.dto.bulk_copy_dto import BulkCopyDto, BulkCopyItemDto
from src.galleries.dto.bulk_move_dto import (
    BulkMoveDto,
    BulkMoveFailureReason,
    BulkMoveItemDto,
)
from src.galleries.gallery_service import GalleryService
from src.source_assets.schema.source_asset_model import SourceAsset
from src.tags.schema.tags_model import media_item_tags, source_asset_tags
from src.users.user_model import UserModel, UserRoleEnum

OWNER = 1
USER = UserModel(id=OWNER, email="a@b", roles=[UserRoleEnum.ADMIN], name="A")


def _ddl(table):
    """CREATE TABLE for SQLite; ARRAY and JSONB columns are stored as JSON."""
    columns = []
    for column in table.columns:
        try:
            type_sql = column.type.compile(dialect=sqlite_dialect.dialect())
        except Exception:  # pylint: disable=broad-exception-caught
            type_sql = "JSON"
        columns.append(f"{column.name} {type_sql}")
    key = ", ".join(table.primary_key.columns.keys())
    columns.append(f"PRIMARY KEY ({key})")
    column_list = ", ".join(columns)
    return f"CREATE TABLE {table.name} ({column_list})"


@pytest.fixture(name="engine")
async def _engine(tmp_path):
    path = tmp_path / "db.sqlite"
    eng = create_async_engine(f"sqlite+aiosqlite:///{path}")
    eng.dialect.colspecs = {
        **eng.dialect.colspecs,
        ARRAY: sqlite_dialect.JSON,
    }

    # pysqlite's own transaction handling breaks SAVEPOINT, which bulk_move
    # and bulk_copy use; this is the SQLAlchemy-documented workaround.
    @event.listens_for(eng.sync_engine, "connect")
    def _connect(dbapi_conn, _):
        dbapi_conn.isolation_level = None

    @event.listens_for(eng.sync_engine, "begin")
    def _begin(conn):
        conn.exec_driver_sql("BEGIN")

    # SQLite has no = ANY(array); json_each over a JSON list is equivalent.
    @event.listens_for(eng.sync_engine, "before_cursor_execute", retval=True)
    def _any(conn, cursor, statement, parameters, *_):
        del conn, cursor
        if "= ANY(?)" in statement:
            statement = statement.replace(
                "= ANY(?)", "IN (SELECT value FROM json_each(?))"
            )
            parameters = tuple(
                json.dumps(p) if isinstance(p, list) else p for p in parameters
            )
        return statement, parameters

    try:
        async with eng.begin() as conn:
            for table in (
                Folder.__table__,
                MediaItem.__table__,
                SourceAsset.__table__,
                media_item_tags,
                source_asset_tags,
            ):
                await conn.execute(text(_ddl(table)))
        yield eng
    finally:
        await eng.dispose()


async def _folders(eng, *rows):
    """Inserts (id, workspace_id, parent_id) folders named F<id>."""
    async with eng.begin() as conn:
        for folder_id, workspace_id, parent_id in rows:
            await conn.execute(
                text(
                    "INSERT INTO folders (id, workspace_id, user_id,"
                    " user_email, name, parent_id, created_at, updated_at)"
                    " VALUES (:id, :ws, :u, 'a@b', :name, :parent,"
                    " '2026-01-01 00:00:00', '2026-01-01 00:00:00')"
                ),
                {
                    "id": folder_id,
                    "ws": workspace_id,
                    "u": OWNER,
                    "name": f"F{folder_id}",
                    "parent": parent_id,
                },
            )


async def _tree(eng):
    """{id: (workspace_id, parent_id)} for every live folder."""
    async with eng.connect() as conn:
        rows = await conn.execute(
            text(
                "SELECT id, workspace_id, parent_id FROM folders"
                " WHERE deleted_at IS NULL"
            )
        )
        return {r.id: (r.workspace_id, r.parent_id) for r in rows}


@pytest.fixture(name="locks")
def fixture_locks(monkeypatch):
    """Replaces the advisory lock with a recorder that lands `committed`.

    `committed` is the SQL a concurrent request committed while this one
    waited for the lock. It runs on the waiting request's own connection, so
    every later statement sees it while ORM objects already loaded keep
    their pre-lock values, which is what a real waiter would see.
    """
    state = {"calls": [], "committed": []}

    async def lock(self, *workspace_ids):
        state["calls"].append(sorted(set(workspace_ids)))
        committed, state["committed"] = state["committed"], []
        for sql in committed:
            await self.db.execute(text(sql))

    monkeypatch.setattr(FolderRepository, "lock_workspace_structure", lock)
    return state


def _folder_service(session):
    return FolderService(folder_repo=FolderRepository(db=session))


def _gallery_service(session):
    svc = GalleryService.__new__(GalleryService)
    svc.db = session
    svc.folder_repo = FolderRepository(db=session)
    svc.workspace_auth = AsyncMock()
    return svc


async def _patch(session, folder_id, parent_id):
    """PATCH /api/folders/{id}: the controller's unlocked read, then update."""
    svc = _folder_service(session)
    folder = await svc.get_raw_folder(folder_id=folder_id)
    return await svc.update_folder(
        folder_id, FolderUpdateDto(parent_id=parent_id), USER, folder=folder
    )


@pytest.mark.anyio
async def test_reparent_that_waited_behind_another_is_refused_as_a_cycle(
    engine, locks
):
    """Two concurrent reparents used to commit a cycle (review finding 1).

    F1(1) > D1(2) and F2(3) > D2(4). A moves F1 under D2 and commits while
    B, moving F2 under D1, waits for the workspace lock. B must see A's
    move, so its cycle check finds D1 under F2 and refuses.
    """
    await _folders(engine, (1, 1, None), (2, 1, 1), (3, 1, None), (4, 1, 3))
    locks["committed"] = ["UPDATE folders SET parent_id = 4 WHERE id = 1"]

    async with AsyncSession(engine) as session:
        with pytest.raises(HTTPException) as exc_info:
            await _patch(session, 3, 2)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST
        await session.commit()  # keep A's write; B's must not be there

    assert locks["calls"] == [[1]]
    tree = await _tree(engine)
    assert tree[3] == (1, None)  # B did not move F2
    assert tree[1] == (1, 4)
    async with AsyncSession(engine) as session:
        # Every walk still terminates; a cycle would raise here.
        repo = FolderRepository(db=session)
        assert sorted(await repo.get_descendant_ids(3)) == [1, 2, 3, 4]


@pytest.mark.anyio
async def test_reparent_after_a_cross_workspace_move_is_refused(engine, locks):
    """A reparent racing a move to another workspace (review finding 2).

    The PATCH read F in workspace 1 and waits while a bulk move re-homes F
    to workspace 2. Applied anyway, F would live in workspace 2 under D in
    workspace 1, and its breadcrumbs would show workspace 2 readers D's name.
    """
    await _folders(engine, (1, 1, None), (2, 1, None))
    locks["committed"] = [
        "UPDATE folders SET workspace_id = 2, parent_id = NULL WHERE id = 1"
    ]

    async with AsyncSession(engine) as session:
        with pytest.raises(HTTPException) as exc_info:
            await _patch(session, 1, 2)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        await session.commit()

    assert await _tree(engine) == {1: (2, None), 2: (1, None)}
    async with AsyncSession(engine) as session:
        crumbs = await _folder_service(session).get_breadcrumbs(
            1, workspace_id=2
        )
    assert [(c.id, c.workspace_id) for c in crumbs] == [(1, 2)]


@pytest.mark.anyio
async def test_reparent_under_a_parent_that_left_the_workspace_is_refused(
    engine, locks
):
    await _folders(engine, (1, 1, None), (2, 1, None))
    locks["committed"] = [
        "UPDATE folders SET workspace_id = 2, parent_id = NULL WHERE id = 2"
    ]

    async with AsyncSession(engine) as session:
        with pytest.raises(HTTPException) as exc_info:
            await _patch(session, 1, 2)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND

    assert (await _tree(engine))[1] == (1, None)


@pytest.mark.anyio
async def test_delete_of_a_folder_that_left_the_workspace_is_refused(
    engine, locks
):
    await _folders(engine, (1, 1, None), (2, 1, 1))
    locks["committed"] = [
        "UPDATE folders SET workspace_id = 2 WHERE id IN (1, 2)"
    ]

    async with AsyncSession(engine) as session:
        svc = _folder_service(session)
        folder = await svc.get_raw_folder(folder_id=1)
        with pytest.raises(HTTPException) as exc_info:
            await svc.delete_folder(1, USER, folder=folder)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        await session.commit()

    assert locks["calls"] == [[1]]
    assert await _tree(engine) == {1: (2, None), 2: (2, 1)}


@pytest.mark.anyio
async def test_create_under_a_parent_that_left_the_workspace_is_refused(
    engine, locks
):
    await _folders(engine, (1, 1, None))
    locks["committed"] = [
        "UPDATE folders SET workspace_id = 2, parent_id = NULL WHERE id = 1"
    ]

    async with AsyncSession(engine) as session:
        with pytest.raises(HTTPException) as exc_info:
            await _folder_service(session).create_folder(
                FolderCreateDto(name="Child", workspace_id=1, parent_id=1),
                USER,
            )
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        await session.commit()

    assert locks["calls"] == [[1]]
    assert await _tree(engine) == {1: (2, None)}


@pytest.mark.anyio
async def test_move_items_sees_a_destination_ancestry_changed_while_waiting(
    engine, locks
):
    """F1 into D4 is fine until a concurrent move puts D4's parent under F1."""
    await _folders(engine, (1, 1, None), (2, 1, None), (4, 1, 2))
    locks["committed"] = ["UPDATE folders SET parent_id = 1 WHERE id = 2"]

    async with AsyncSession(engine) as session:
        with pytest.raises(HTTPException) as exc_info:
            await _folder_service(session).move_items(
                MoveItemsDto(
                    workspace_id=1, folder_ids=[1], destination_folder_id=4
                ),
                USER,
            )
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST
        await session.commit()

    assert locks["calls"] == [[1]]
    assert (await _tree(engine))[1] == (1, None)


@pytest.mark.anyio
async def test_copy_items_sees_a_destination_that_left_the_workspace(
    engine, locks
):
    await _folders(engine, (1, 1, None), (2, 1, None))
    locks["committed"] = [
        "UPDATE folders SET workspace_id = 2, parent_id = NULL WHERE id = 2"
    ]

    async with AsyncSession(engine) as session:
        with pytest.raises(HTTPException) as exc_info:
            await _folder_service(session).copy_items(
                CopyItemsDto(
                    workspace_id=1, folder_ids=[1], destination_folder_id=2
                ),
                USER,
            )
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND

    assert locks["calls"] == [[1]]
    assert len(await _tree(engine)) == 2


@pytest.mark.anyio
async def test_bulk_move_locks_both_workspaces_and_rereads_the_folders(
    engine, locks
):
    """The source workspace comes from an unlocked read, so after locking
    it and the target the folders are read again. One that a concurrent
    move took to a third workspace is outside the locks: not found."""
    await _folders(engine, (1, 3, None), (2, 3, None))
    locks["committed"] = ["UPDATE folders SET workspace_id = 5 WHERE id = 2"]

    async with AsyncSession(engine) as session:
        res = await _gallery_service(session).bulk_move(
            BulkMoveDto(
                target_workspace_id=1,
                items=[
                    BulkMoveItemDto(id=1, type="folder"),
                    BulkMoveItemDto(id=2, type="folder"),
                ],
            ),
            USER,
        )

    assert locks["calls"] == [[1, 3]]
    assert [m.id for m in res["moved"]] == [1]
    assert [(f.id, f.reason) for f in res["failed"]] == [
        (2, BulkMoveFailureReason.NOT_FOUND)
    ]
    assert await _tree(engine) == {1: (1, None), 2: (5, None)}


@pytest.mark.anyio
async def test_bulk_copy_locks_both_workspaces_and_rereads_the_folders(
    engine, locks
):
    await _folders(engine, (1, 3, None), (2, 3, None))
    locks["committed"] = ["UPDATE folders SET workspace_id = 5 WHERE id = 2"]

    async with AsyncSession(engine) as session:
        res = await _gallery_service(session).bulk_copy(
            BulkCopyDto(
                target_workspace_id=4,
                items=[
                    BulkCopyItemDto(id=1, type="folder"),
                    BulkCopyItemDto(id=2, type="folder"),
                ],
            ),
            USER,
        )

    assert locks["calls"] == [[3, 4]]
    assert res["copied_count"] == 1
    tree = await _tree(engine)
    assert sorted(ws for ws, _ in tree.values()) == [3, 4, 5]


def _member_of(svc, *workspace_ids):
    """Makes svc authorize only the given workspaces; returns the calls."""
    calls = []

    async def authorize(workspace_id, user):
        del user
        calls.append(workspace_id)
        if workspace_id not in workspace_ids:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden"
            )

    svc.workspace_auth.authorize.side_effect = authorize
    return calls


def _bulk(svc, operation, target, *folder_ids):
    items = [{"id": i, "type": "folder"} for i in folder_ids]
    if operation == "move":
        return svc.bulk_move(
            BulkMoveDto(target_workspace_id=target, items=items), USER
        )
    return svc.bulk_copy(
        BulkCopyDto(target_workspace_id=target, items=items), USER
    )


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["move", "copy"])
async def test_bulk_request_naming_a_foreign_folder_locks_nothing(
    engine, locks, operation
):
    """A member of 1 and 3 names a folder from 5. The request is refused
    before any lock, so it cannot hold 5's structure lock while it works
    through the rest of the request."""
    await _folders(engine, (1, 3, None), (2, 5, None))

    async with AsyncSession(engine) as session:
        svc = _gallery_service(session)
        _member_of(svc, 1, 3)
        with pytest.raises(HTTPException) as exc_info:
            await _bulk(svc, operation, 1, 1, 2)

    assert exc_info.value.status_code == status.HTTP_403_FORBIDDEN
    assert locks["calls"] == []
    assert await _tree(engine) == {1: (3, None), 2: (5, None)}


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["move", "copy"])
async def test_bulk_request_skips_a_folder_moved_to_a_foreign_workspace(
    engine, locks, operation
):
    """Folder 2 was in 3, which the caller may use, when first read, and a
    concurrent request moved it to 5, which the caller may not, while this
    one waited. 5 is neither locked nor authorized, and 2 is not found."""
    await _folders(engine, (1, 3, None), (2, 3, None))
    locks["committed"] = ["UPDATE folders SET workspace_id = 5 WHERE id = 2"]

    async with AsyncSession(engine) as session:
        svc = _gallery_service(session)
        authorized = _member_of(svc, 1, 3)
        res = await _bulk(svc, operation, 1, 1, 2)

    assert locks["calls"] == [[1, 3]]
    assert 5 not in authorized
    tree = await _tree(engine)
    assert tree[2] == (5, None)
    if operation == "move":
        assert [(f.id, f.reason) for f in res["failed"]] == [
            (2, BulkMoveFailureReason.NOT_FOUND)
        ]
        assert tree[1] == (1, None)
    else:
        assert res["copied_count"] == 1
        assert sorted(ws for ws, _ in tree.values()) == [1, 3, 5]
