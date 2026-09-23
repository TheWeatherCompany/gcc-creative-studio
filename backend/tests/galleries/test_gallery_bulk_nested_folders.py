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

"""Bulk move and bulk copy of a folder together with its own descendant.

The descendant travels with its ancestor's subtree, so handling it on its
own as well used to either report it as ALREADY_IN_TARGET after it had
moved, or, when it came first in the request, detach it to the target root
and flatten the tree. Copy made it twice. These run on aiosqlite and read
the tree back from the database.
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
from src.folders.dto.folder_dto import ConflictStrategyEnum
from src.folders.repository.folder_repository import FolderRepository
from src.folders.schema.folder_model import Folder
from src.galleries.dto.bulk_copy_dto import BulkCopyDto, BulkCopyItemDto
from src.galleries.dto.bulk_move_dto import (
    BulkMoveDto,
    BulkMoveFailureReason,
    BulkMoveItemDto,
)
from src.galleries.gallery_service import GalleryService
from src.images.repository.media_item_repository import MediaRepository
from src.source_assets.repository.source_asset_repository import (
    SourceAssetRepository,
)
from src.source_assets.schema.source_asset_model import SourceAsset
from src.tags.repository.tags_repository import TagsRepository
from src.tags.schema.tags_model import Tag, media_item_tags, source_asset_tags
from src.users.user_model import UserModel, UserRoleEnum

SOURCE_WS = 3
TARGET_WS = 1
OWNER = 1
USER = UserModel(id=OWNER, email="a@b", roles=[UserRoleEnum.ADMIN], name="A")
# F1 > F2 > F3, with one media item in F2.
TREE = ((1, SOURCE_WS, None), (2, SOURCE_WS, 1), (3, SOURCE_WS, 2))
MEDIA_IN_F2 = 50


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
                Tag.__table__,
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


async def _seed(eng, *rows):
    """The TREE (plus any extra folders) and one media item in F2."""
    await _folders(eng, *TREE, *rows)
    async with eng.begin() as conn:
        await conn.execute(
            text(
                "INSERT INTO media_items (id, workspace_id, folder_id,"
                " user_id, user_email, mime_type, model, aspect_ratio,"
                " status, gcs_uris, thumbnail_uris, created_at,"
                " updated_at) VALUES (:id, :ws, 2, :u, 'a@b', 'image/png',"
                " 'imagen-4.0-generate-001', '1:1', 'completed',"
                " '[\"gs://b/m.png\"]', '[]', '2026-01-01 00:00:00',"
                " '2026-01-01 00:00:00')"
            ),
            {"id": MEDIA_IN_F2, "ws": SOURCE_WS, "u": OWNER},
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


async def _copies(eng, workspace_id):
    """Sorted (name, parent name) pairs for the live folders in a workspace."""
    async with eng.connect() as conn:
        rows = (
            await conn.execute(
                text(
                    "SELECT id, name, parent_id FROM folders"
                    " WHERE deleted_at IS NULL AND workspace_id = :ws"
                ),
                {"ws": workspace_id},
            )
        ).all()
    names = {r.id: r.name for r in rows}
    return sorted((r.name, names.get(r.parent_id)) for r in rows)


def _service(session):
    svc = GalleryService.__new__(GalleryService)
    svc.db = session
    svc.media_repo = MediaRepository(db=session)
    svc.source_asset_repo = SourceAssetRepository(db=session)
    svc.tags_repo = TagsRepository(db=session)
    svc.folder_repo = FolderRepository(db=session)
    svc.workspace_auth = AsyncMock()
    return svc


async def _move(eng, folder_ids, target=TARGET_WS, conflict_strategy=None):
    async with AsyncSession(eng) as session:
        return await _service(session).bulk_move(
            BulkMoveDto(
                target_workspace_id=target,
                items=[
                    BulkMoveItemDto(id=i, type="folder") for i in folder_ids
                ],
                conflict_strategy=conflict_strategy,
            ),
            USER,
        )


async def _copy(eng, folder_ids, target=TARGET_WS, conflict_strategy=None):
    async with AsyncSession(eng) as session:
        return await _service(session).bulk_copy(
            BulkCopyDto(
                target_workspace_id=target,
                items=[
                    BulkCopyItemDto(id=i, type="folder") for i in folder_ids
                ],
                conflict_strategy=conflict_strategy,
            ),
            USER,
        )


def _outcome(res):
    """The response with its lists sorted, to compare across orders."""
    return (
        res["moved_count"],
        sorted(m.id for m in res["moved"]),
        sorted((f.id, f.reason) for f in res["failed"]),
    )


@pytest.mark.anyio
@pytest.mark.parametrize("order", [[1, 2], [2, 1], [3, 2, 1], [1, 3]])
async def test_bulk_move_carries_a_requested_descendant_in_any_order(
    engine, order
):
    """F2 and F3 move inside F1's subtree whatever the request order: none
    is detached to the target root, and each is reported as moved.
    moved_count is F1's rows only (three folders and a media item), as a
    carried folder moved no rows of its own."""
    await _seed(engine)

    res = await _move(engine, order)

    assert _outcome(res) == (4, sorted(order), [])
    assert await _tree(engine) == {
        1: (TARGET_WS, None),
        2: (TARGET_WS, 1),
        3: (TARGET_WS, 2),
    }


@pytest.mark.anyio
async def test_bulk_move_leaves_requested_siblings_independent(engine):
    """F2 and F4 are siblings, so neither is inside the other's subtree:
    both move to the target root on their own."""
    await _seed(engine, (4, SOURCE_WS, 1))

    res = await _move(engine, [4, 2])

    assert _outcome(res) == (4, [2, 4], [])
    tree = await _tree(engine)
    assert tree[1] == (SOURCE_WS, None)
    assert tree[2] == (TARGET_WS, None)
    assert tree[3] == (TARGET_WS, 2)
    assert tree[4] == (TARGET_WS, None)


@pytest.mark.anyio
@pytest.mark.parametrize("order", [[1, 2], [2, 1]])
async def test_bulk_move_carried_folder_shares_a_failed_carrier_outcome(
    engine, order, monkeypatch
):
    """When F1's move fails its savepoint rolls back, so F2 did not move
    either and is reported with F1's reason, not as moved."""
    await _seed(engine)

    async def fail(self, **_):
        del self
        raise RuntimeError("boom")

    monkeypatch.setattr(FolderRepository, "move_folder_to_workspace", fail)

    res = await _move(engine, order)

    assert _outcome(res) == (
        0,
        [],
        [
            (1, BulkMoveFailureReason.MOVE_FAILED),
            (2, BulkMoveFailureReason.MOVE_FAILED),
        ],
    )
    assert await _tree(engine) == dict(
        (fid, (SOURCE_WS, parent)) for fid, _, parent in TREE
    )


@pytest.mark.anyio
async def test_bulk_move_subtree_already_in_target_moves_nothing(engine):
    """The whole subtree is already in the target, so F2 shares F1's
    ALREADY_IN_TARGET and the tree is unchanged."""
    await _seed(engine)

    res = await _move(engine, [2, 1], target=SOURCE_WS)

    assert _outcome(res) == (
        0,
        [],
        [
            (1, BulkMoveFailureReason.ALREADY_IN_TARGET),
            (2, BulkMoveFailureReason.ALREADY_IN_TARGET),
        ],
    )
    assert await _tree(engine) == dict(
        (fid, (SOURCE_WS, parent)) for fid, _, parent in TREE
    )


async def _rename(eng, folder_id, name):
    async with eng.begin() as conn:
        await conn.execute(
            text("UPDATE folders SET name = :n WHERE id = :id"),
            {"n": name, "id": folder_id},
        )


@pytest.mark.anyio
async def test_bulk_move_carried_folder_is_not_a_root_name_conflict(engine):
    """The target root already has an F2, but the requested F2 lands under
    F1, not at the root, so it is no conflict."""
    await _seed(engine, (9, TARGET_WS, None))
    await _rename(engine, 9, "F2")

    res = await _move(engine, [2, 1])

    assert _outcome(res) == (4, [1, 2], [])


@pytest.mark.anyio
async def test_bulk_move_conflict_lists_only_the_carrier(engine):
    await _seed(engine, (9, TARGET_WS, None), (10, TARGET_WS, None))
    await _rename(engine, 9, "F1")
    await _rename(engine, 10, "F2")

    with pytest.raises(HTTPException) as exc_info:
        await _move(engine, [2, 1])

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    conflicts = exc_info.value.detail["conflicts"]
    assert [c["folder_id"] for c in conflicts] == [1]


@pytest.mark.anyio
@pytest.mark.parametrize("order", [[1, 2], [2, 1], [3, 1]])
async def test_bulk_copy_copies_a_requested_descendant_once(engine, order):
    """F1's copy already contains F2 and F3, so they are not copied again:
    one copy of the tree, three folders and the media item."""
    await _seed(engine)

    res = await _copy(engine, order, target=4)

    assert res == {"copied_count": 4}
    assert await _copies(engine, 4) == [
        ("F1", None),
        ("F2", "F1"),
        ("F3", "F2"),
    ]


@pytest.mark.anyio
async def test_bulk_copy_within_the_workspace_copies_a_descendant_once(
    engine,
):
    """The same holds for a copy into the source workspace, where the
    ancestor is not moving anywhere."""
    await _seed(engine)

    res = await _copy(
        engine,
        [2, 1],
        target=SOURCE_WS,
        conflict_strategy=ConflictStrategyEnum.KEEP_BOTH,
    )

    assert res == {"copied_count": 4}
    # The original tree and one copy of it, disambiguated at the root.
    assert await _copies(engine, SOURCE_WS) == [
        ("F1", None),
        ("F1 (1)", None),
        ("F2", "F1"),
        ("F2", "F1 (1)"),
        ("F3", "F2"),
        ("F3", "F2"),
    ]


@pytest.mark.anyio
async def test_bulk_move_merge_carries_the_descendant(engine):
    """With MERGE into an existing F1 at the target root, F2 still travels
    inside F1's merge rather than being moved on its own first."""
    await _seed(engine, (9, TARGET_WS, None))
    await _rename(engine, 9, "F1")

    res = await _move(
        engine, [2, 1], conflict_strategy=ConflictStrategyEnum.MERGE
    )

    assert sorted(m.id for m in res["moved"]) == [1, 2]
    assert not res["failed"]
    tree = await _tree(engine)
    assert all(ws == TARGET_WS for ws, _ in tree.values())
    assert [fid for fid, (_, parent) in tree.items() if parent is None] == [9]
