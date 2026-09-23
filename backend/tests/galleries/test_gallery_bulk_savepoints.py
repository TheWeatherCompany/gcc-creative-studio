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

"""Bulk move and bulk copy on a real AsyncSession.

The tests in test_gallery_service.py mock begin_nested and commit, so they
cannot see a helper committing inside the per-item savepoint. On a real
session that commit ends the outer transaction and the item's next
statement fails. These run the service on aiosqlite, with SAVEPOINT
support, and read the outcome back from the database.
"""

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, status
from sqlalchemy import event, text
from sqlalchemy.dialects import sqlite as sqlite_dialect
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.types import ARRAY

from src.common.schema.media_item_model import MediaItem
from src.folders.repository.folder_repository import FolderRepository
from src.folders.schema.folder_model import Folder
from src.galleries.dto.bulk_copy_dto import BulkCopyDto, BulkCopyItemDto
from src.galleries.dto.bulk_move_dto import BulkMoveDto, BulkMoveItemDto
from src.galleries.gallery_service import GalleryService
from src.images.repository.media_item_repository import MediaRepository
from src.source_assets.repository.source_asset_repository import (
    SourceAssetRepository,
)
from src.source_assets.schema.source_asset_model import SourceAsset
from src.tags.repository.tags_repository import TagsRepository
from src.tags.schema.tags_model import Tag, media_item_tags, source_asset_tags
from src.users.user_model import UserModel, UserRoleEnum

SOURCE_WS = 1
TARGET_WS = 2
OTHER_WS = 3
OWNER = 1
# Two tags per item, so a helper that commits mid-item is caught even when
# its commit is otherwise the item's last statement.
TAGS = (98, 99)
FOLDER = 30


def _ddl(table):
    """CREATE TABLE for SQLite, keeping the primary key so ids autoincrement.

    Types SQLite cannot render (ARRAY, JSONB) are stored as JSON text.
    """
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
    # Postgres ARRAY columns round-trip as JSON, as SQLite has no arrays.
    eng.dialect.colspecs = {
        **eng.dialect.colspecs,
        ARRAY: sqlite_dialect.JSON,
    }

    # pysqlite's own transaction handling breaks SAVEPOINT; this is the
    # SQLAlchemy-documented workaround.
    @event.listens_for(eng.sync_engine, "connect")
    def _connect(dbapi_conn, _):
        dbapi_conn.isolation_level = None

    @event.listens_for(eng.sync_engine, "begin")
    def _begin(conn):
        conn.exec_driver_sql("BEGIN")

    try:
        await _create_schema(eng)
        yield eng
    finally:
        await eng.dispose()


async def _create_schema(eng):
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
        for tag_id in TAGS:
            await conn.execute(
                text(
                    "INSERT INTO tags (id, name, color, workspace_id,"
                    f" created_at, updated_at) VALUES ({tag_id}, 't', 'red',"
                    f" {SOURCE_WS}, '2026-01-01 00:00:00',"
                    " '2026-01-01 00:00:00')"
                )
            )


async def _sql(eng, sql):
    async with eng.begin() as conn:
        await conn.execute(text(sql))


async def _scalar(eng, sql):
    async with eng.connect() as conn:
        return (await conn.execute(text(sql))).scalar()


async def _seed(
    eng, media_ids=(), asset_ids=(), folder_id=None, workspace_id=SOURCE_WS
):
    """Inserts media items and source assets, each tagged with TAGS, inside
    folder_id when given."""
    async with eng.begin() as conn:
        for item_id in media_ids:
            await conn.execute(
                text(
                    "INSERT INTO media_items (id, workspace_id, folder_id,"
                    " user_id, user_email, mime_type, model, aspect_ratio,"
                    " status, gcs_uris, thumbnail_uris, created_at,"
                    " updated_at) VALUES (:id, :ws, :f, :u, 'a@b', 'image/png',"
                    " 'imagen-4.0-generate-001', '1:1', 'completed',"
                    " '[\"gs://b/m.png\"]', '[]', '2026-01-01 00:00:00',"
                    " '2026-01-01 00:00:00')"
                ),
                {"id": item_id, "ws": workspace_id, "f": folder_id, "u": OWNER},
            )
            for tag_id in TAGS:
                await conn.execute(
                    text(
                        "INSERT INTO media_item_tags (media_item_id, tag_id)"
                        " VALUES (:id, :tag)"
                    ),
                    {"id": item_id, "tag": tag_id},
                )
        for item_id in asset_ids:
            await conn.execute(
                text(
                    "INSERT INTO source_assets (id, workspace_id, folder_id,"
                    " user_id, gcs_uri, original_filename, mime_type,"
                    " file_hash, aspect_ratio, scope, asset_type, created_at,"
                    " updated_at) VALUES (:id, :ws, :f, :u, 'gs://b/x.png',"
                    " 'x.png', 'image/png', 'h', '1:1', 'private',"
                    " 'generic_image', '2026-01-01 00:00:00',"
                    " '2026-01-01 00:00:00')"
                ),
                {"id": item_id, "ws": workspace_id, "f": folder_id, "u": OWNER},
            )
            for tag_id in TAGS:
                await conn.execute(
                    text(
                        "INSERT INTO source_asset_tags"
                        " (source_asset_id, tag_id) VALUES (:id, :tag)"
                    ),
                    {"id": item_id, "tag": tag_id},
                )


async def _authorize(workspace_id, user):
    del user
    if workspace_id == OTHER_WS:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)


def _service(session):
    svc = GalleryService.__new__(GalleryService)
    svc.db = session
    svc.media_repo = MediaRepository(db=session)
    svc.source_asset_repo = SourceAssetRepository(db=session)
    svc.tags_repo = TagsRepository(db=session)
    svc.folder_repo = FolderRepository(db=session)
    svc.workspace_auth = AsyncMock()
    svc.workspace_auth.authorize.side_effect = _authorize
    return svc


async def _seed_folder(eng):
    await _sql(
        eng,
        "INSERT INTO folders (id, workspace_id, user_id, user_email, name,"
        f" created_at, updated_at) VALUES ({FOLDER}, {SOURCE_WS}, {OWNER},"
        " 'a@b', 'F', '2026-01-01 00:00:00', '2026-01-01 00:00:00')",
    )


def _user():
    return UserModel(
        id=OWNER, email="a@b", roles=[UserRoleEnum.ADMIN], name="Owner"
    )


async def _move(eng, items):
    async with AsyncSession(eng) as session:
        return await _service(session).bulk_move(
            BulkMoveDto(
                target_workspace_id=TARGET_WS,
                items=[BulkMoveItemDto(id=i, type=t) for t, i in items],
            ),
            _user(),
        )


async def _copy(eng, items, target=TARGET_WS):
    async with AsyncSession(eng) as session:
        return await _service(session).bulk_copy(
            BulkCopyDto(
                target_workspace_id=target,
                items=[BulkCopyItemDto(id=i, type=t) for t, i in items],
            ),
            _user(),
        )


def _moved_ids(res):
    return [m.id for m in res["moved"]]


@pytest.mark.anyio
async def test_bulk_move_media_item_moves_it_and_clears_its_tags(engine):
    await _seed(engine, media_ids=[7])

    res = await _move(engine, [("media_item", 7)])

    assert res["failed"] == []
    assert _moved_ids(res) == [7]
    assert res["moved_count"] == 1
    ws = "SELECT workspace_id FROM media_items WHERE id = 7"
    assert await _scalar(engine, ws) == TARGET_WS
    tags = "SELECT count(*) FROM media_item_tags WHERE media_item_id = 7"
    assert await _scalar(engine, tags) == 0


@pytest.mark.anyio
async def test_bulk_move_source_asset_moves_it_and_clears_its_tags(engine):
    await _seed(engine, asset_ids=[5])

    res = await _move(engine, [("source_asset", 5)])

    assert res["failed"] == []
    assert _moved_ids(res) == [5]
    assert res["moved_count"] == 1
    ws = "SELECT workspace_id FROM source_assets WHERE id = 5"
    assert await _scalar(engine, ws) == TARGET_WS
    tags = "SELECT count(*) FROM source_asset_tags WHERE source_asset_id = 5"
    assert await _scalar(engine, tags) == 0


@pytest.mark.anyio
async def test_bulk_move_failed_item_keeps_its_tags_and_others_move(engine):
    await _seed(engine, media_ids=[7, 8], asset_ids=[5])
    # The database rejects item 8's move after its tag delete has run.
    async with engine.begin() as conn:
        await conn.execute(
            text(
                "CREATE TRIGGER no_move_8 BEFORE UPDATE ON media_items"
                " WHEN OLD.id = 8 BEGIN SELECT RAISE(ABORT, 'no'); END"
            )
        )

    res = await _move(
        engine,
        [("media_item", 7), ("media_item", 8), ("source_asset", 5)],
    )

    assert [(f.id, f.reason.value) for f in res["failed"]] == [
        (8, "MOVE_FAILED")
    ]
    assert _moved_ids(res) == [7, 5]
    assert res["moved_count"] == 2
    moved = "SELECT count(*) FROM media_items WHERE workspace_id = 2"
    assert await _scalar(engine, moved) == 1
    kept = "SELECT count(*) FROM media_item_tags WHERE media_item_id = 8"
    assert await _scalar(engine, kept) == len(TAGS)
    all_media_tags = "SELECT count(*) FROM media_item_tags"
    assert await _scalar(engine, all_media_tags) == len(TAGS)
    assert await _scalar(engine, "SELECT count(*) FROM source_asset_tags") == 0


@pytest.mark.anyio
async def test_bulk_move_counts_only_items_whose_savepoint_released(engine):
    await _seed(engine, media_ids=[7, 9])
    await _seed_folder(engine)
    await _seed(engine, media_ids=[31], folder_id=FOLDER)
    # The folder's own row is written by the flush at savepoint release,
    # after its contents have moved and been counted.
    await _sql(
        engine,
        "CREATE TRIGGER no_folder_move BEFORE UPDATE ON folders"
        " BEGIN SELECT RAISE(ABORT, 'no'); END",
    )

    res = await _move(
        engine,
        [("media_item", 7), ("folder", FOLDER), ("media_item", 9)],
    )

    assert [f.id for f in res["failed"]] == [FOLDER]
    assert _moved_ids(res) == [7, 9]
    assert res["moved_count"] == len(res["moved"]) == 2
    stayed = "SELECT workspace_id FROM media_items WHERE id = 31"
    assert await _scalar(engine, stayed) == SOURCE_WS
    kept = "SELECT count(*) FROM media_item_tags WHERE media_item_id = 31"
    assert await _scalar(engine, kept) == len(TAGS)


@pytest.mark.anyio
async def test_bulk_copy_creates_the_copies_it_counts(engine):
    await _seed(engine, media_ids=[7], asset_ids=[5])

    res = await _copy(engine, [("media_item", 7), ("source_asset", 5)])

    media = "SELECT count(*) FROM media_items WHERE workspace_id = 2"
    assets = "SELECT count(*) FROM source_assets WHERE workspace_id = 2"
    created = await _scalar(engine, media) + await _scalar(engine, assets)
    assert created == 2
    assert res == {"copied_count": created}


@pytest.mark.anyio
async def test_bulk_copy_within_a_workspace_copies_tags(engine):
    await _seed(engine, media_ids=[7], asset_ids=[5])

    res = await _copy(
        engine, [("media_item", 7), ("source_asset", 5)], target=SOURCE_WS
    )

    assert res == {"copied_count": 2}
    assert await _scalar(engine, "SELECT count(*) FROM media_items") == 2
    assert await _scalar(engine, "SELECT count(*) FROM source_assets") == 2
    for table in ("media_item_tags", "source_asset_tags"):
        count = f"SELECT count(*) FROM {table}"
        assert await _scalar(engine, count) == 2 * len(TAGS)


@pytest.mark.anyio
async def test_bulk_copy_counts_only_items_whose_savepoint_released(engine):
    await _seed(engine, asset_ids=[5, 7])
    await _seed_folder(engine)
    await _seed(engine, asset_ids=[31], folder_id=FOLDER)
    # A copied folder's assets are written by the flush at savepoint
    # release, after the folder has been counted.
    await _sql(
        engine,
        "CREATE TRIGGER no_foldered_asset BEFORE INSERT ON source_assets"
        " WHEN NEW.folder_id IS NOT NULL BEGIN SELECT RAISE(ABORT, 'no'); END",
    )

    res = await _copy(
        engine,
        [("source_asset", 5), ("folder", FOLDER), ("source_asset", 7)],
    )

    assets = "SELECT count(*) FROM source_assets WHERE workspace_id = 2"
    folders = "SELECT count(*) FROM folders WHERE workspace_id = 2"
    assert await _scalar(engine, assets) == 2
    assert await _scalar(engine, folders) == 0
    assert res == {"copied_count": 2}


@pytest.mark.anyio
async def test_bulk_move_refused_item_leaves_the_batch_unwritten(engine):
    await _seed(engine, media_ids=[7], asset_ids=[5])
    await _seed(engine, media_ids=[8], workspace_id=OTHER_WS)

    with pytest.raises(HTTPException) as exc:
        await _move(
            engine,
            [("media_item", 7), ("source_asset", 5), ("media_item", 8)],
        )

    assert exc.value.status_code == status.HTTP_403_FORBIDDEN
    moved = "SELECT count(*) FROM media_items WHERE workspace_id = 2"
    assert await _scalar(engine, moved) == 0
    media_tags = "SELECT count(*) FROM media_item_tags"
    assert await _scalar(engine, media_tags) == 2 * len(TAGS)
    asset_tags = "SELECT count(*) FROM source_asset_tags"
    assert await _scalar(engine, asset_tags) == len(TAGS)


@pytest.mark.anyio
async def test_bulk_copy_refused_item_leaves_the_batch_unwritten(engine):
    await _seed(engine, media_ids=[7], asset_ids=[5])
    await _seed(engine, media_ids=[8], workspace_id=OTHER_WS)

    with pytest.raises(HTTPException) as exc:
        await _copy(
            engine,
            [("media_item", 7), ("source_asset", 5), ("media_item", 8)],
            target=SOURCE_WS,
        )

    assert exc.value.status_code == status.HTTP_403_FORBIDDEN
    assert await _scalar(engine, "SELECT count(*) FROM media_items") == 2
    assert await _scalar(engine, "SELECT count(*) FROM source_assets") == 1
    media_tags = "SELECT count(*) FROM media_item_tags"
    assert await _scalar(engine, media_tags) == 2 * len(TAGS)
    asset_tags = "SELECT count(*) FROM source_asset_tags"
    assert await _scalar(engine, asset_tags) == len(TAGS)
