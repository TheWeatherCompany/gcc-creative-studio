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
"""Tests for Gallery Service."""


from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

from src.common.base_dto import (
    AspectRatioEnum,
    GenerationModelEnum,
    MimeTypeEnum,
)
from src.common.schema.media_item_model import (
    AssetRoleEnum,
    JobStatusEnum,
    MediaItemModel,
    SourceAssetLink,
)
from src.folders.repository.folder_repository import FolderSubtreeChangedError
from src.galleries.dto.bulk_move_dto import BulkMoveDto, BulkMoveItemDto
from src.galleries.dto.gallery_search_dto import GallerySearchDto
from src.galleries.dto.unified_gallery_response import (
    UnifiedGalleryItemResponse,
)
from src.galleries.gallery_service import GalleryService
from src.users.user_model import UserModel, UserRoleEnum


@pytest.fixture(name="service")
def fixture_service():
    mock_media_repo = AsyncMock()
    mock_source_asset_repo = AsyncMock()
    mock_unified_gallery_repo = AsyncMock()
    mock_user_repo = AsyncMock()
    mock_workspace_repo = AsyncMock()
    mock_iam_signer = MagicMock()
    mock_workspace_auth = AsyncMock()
    mock_imagen_service = AsyncMock()
    mock_gcs_service = MagicMock()
    mock_tags_repo = AsyncMock()
    mock_favorites_repo = AsyncMock()
    mock_folder_repo = AsyncMock()
    mock_db = AsyncMock()
    # Conditional moves succeed by default; tests that exercise a lost race
    # override this with rowcount 0.
    mock_db.execute.return_value = MagicMock(rowcount=1)

    service = GalleryService(
        media_repo=mock_media_repo,
        source_asset_repo=mock_source_asset_repo,
        unified_gallery_repo=mock_unified_gallery_repo,
        user_repo=mock_user_repo,
        workspace_repo=mock_workspace_repo,
        iam_signer_credentials=mock_iam_signer,
        workspace_auth=locals().get("workspace_auth", mock_workspace_auth),
        imagen_service=mock_imagen_service,
        gcs_service=mock_gcs_service,
        tags_repo=mock_tags_repo,
        favorites_repo=mock_favorites_repo,
        folder_repo=mock_folder_repo,
        db=mock_db,
    )

    # Attach mocks for ease of use in tests
    service.mock_media_repo = mock_media_repo
    service.mock_source_asset_repo = mock_source_asset_repo
    service.mock_unified_gallery_repo = mock_unified_gallery_repo
    service.mock_user_repo = mock_user_repo
    service.mock_workspace_repo = mock_workspace_repo
    service.mock_iam_signer = mock_iam_signer
    service.mock_workspace_auth = mock_workspace_auth
    service.mock_gcs_service = mock_gcs_service
    service.mock_tags_repo = mock_tags_repo
    service.mock_favorites_repo = mock_favorites_repo
    service.mock_folder_repo = mock_folder_repo
    service.mock_db = mock_db

    return service


@pytest.mark.anyio
async def test_enrich_source_asset_link(service):
    # Setup link
    link = SourceAssetLink(asset_id=123, role=AssetRoleEnum.INPUT)

    # Mock source_asset_repo.get_by_id
    mock_asset = MagicMock()
    mock_asset.gcs_uri = "gs://bucket/asset.jpg"
    mock_asset.thumbnail_gcs_uri = "gs://bucket/thumb.jpg"
    mock_asset.mime_type = "image/jpeg"
    service.mock_source_asset_repo.get_by_id.return_value = mock_asset

    # Mock iam_signer_credentials
    service.mock_iam_signer.generate_presigned_url.side_effect = [
        "https://signed.url/asset.jpg",
        "https://signed.url/thumb.jpg",
    ]

    result = await service._enrich_source_asset_link(link)

    assert result is not None
    assert result.presigned_url == "https://signed.url/asset.jpg"
    assert result.presigned_thumbnail_url == "https://signed.url/thumb.jpg"
    service.mock_source_asset_repo.get_by_id.assert_called_once_with(123)


@pytest.mark.anyio
async def test_get_paginated_gallery_admin(service):
    # Setup User and Search DTO
    current_user = UserModel(
        id=1,
        email="admin@test.com",
        name="Admin",
        roles=[UserRoleEnum.ADMIN],
    )

    search_dto = GallerySearchDto(limit=10, offset=0)

    # Mock unified_gallery_repo.query
    mock_query_result = MagicMock()
    mock_item = UnifiedGalleryItemResponse(
        id=1,
        workspace_id=99,
        created_at=datetime.now(),
        item_type="media_item",
        gcs_uris=["gs://bucket/image.png"],
        thumbnail_uris=[],
    )

    mock_query_result.data = [mock_item]
    mock_query_result.count = 1
    mock_query_result.page = 1
    mock_query_result.page_size = 10
    mock_query_result.total_pages = 1

    service.mock_unified_gallery_repo.query.return_value = mock_query_result
    service.mock_iam_signer.generate_presigned_url.return_value = (
        "https://signed.url/image.png"
    )

    result = await service.get_paginated_gallery(search_dto, current_user)

    assert result.count == 1
    assert len(result.data) == 1
    assert result.data[0].presigned_urls[0] == "https://signed.url/image.png"


@pytest.mark.anyio
async def test_get_paginated_gallery_regular_user(service):
    # Status should be forced to COMPLETED for regular user
    current_user = UserModel(
        id=2,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )

    search_dto = GallerySearchDto(
        limit=10, offset=0, status=JobStatusEnum.FAILED
    )

    mock_query_result = MagicMock()
    mock_query_result.data = []
    service.mock_unified_gallery_repo.query.return_value = mock_query_result

    await service.get_paginated_gallery(search_dto, current_user)

    # Verify status is overwritten
    assert search_dto.status == JobStatusEnum.COMPLETED


@pytest.mark.anyio
async def test_get_paginated_gallery_with_folder_id_success(service):
    current_user = UserModel(
        id=2,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )
    search_dto = GallerySearchDto(
        workspace_id=1, folder_id=10, limit=10, offset=0
    )

    mock_folder = MagicMock()
    mock_folder.id = 10
    mock_folder.workspace_id = 1
    mock_folder.name = "Folder 10"
    service.mock_folder_repo.get_folder_by_id.return_value = mock_folder

    mock_query_result = MagicMock()
    mock_query_result.data = []
    mock_query_result.count = 0
    mock_query_result.page = 1
    mock_query_result.page_size = 10
    mock_query_result.total_pages = 0
    service.mock_unified_gallery_repo.query.return_value = mock_query_result

    res = await service.get_paginated_gallery(search_dto, current_user)
    assert res.count == 0


@pytest.mark.anyio
async def test_get_paginated_gallery_with_folder_id_not_found(service):
    current_user = UserModel(
        id=2,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )
    search_dto = GallerySearchDto(
        workspace_id=1, folder_id=999, limit=10, offset=0
    )

    service.mock_folder_repo.get_folder_by_id.return_value = None

    with pytest.raises(HTTPException) as exc_info:
        await service.get_paginated_gallery(search_dto, current_user)
    assert exc_info.value.status_code == 404
    assert "not found in this workspace" in exc_info.value.detail


@pytest.mark.anyio
async def test_get_paginated_gallery_with_folder_id_workspace_mismatch(service):
    current_user = UserModel(
        id=2,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )
    search_dto = GallerySearchDto(
        workspace_id=1, folder_id=10, limit=10, offset=0
    )

    # Folder belongs to workspace 2 instead of workspace 1
    mock_folder = MagicMock()
    mock_folder.id = 10
    mock_folder.workspace_id = 2
    mock_folder.name = "Folder in WS2"
    service.mock_folder_repo.get_folder_by_id.return_value = mock_folder

    with pytest.raises(HTTPException) as exc_info:
        await service.get_paginated_gallery(search_dto, current_user)
    assert exc_info.value.status_code == 404
    assert "not found in this workspace" in exc_info.value.detail


@pytest.mark.anyio
async def test_get_media_by_id_success(service):
    current_user = UserModel(
        id=1,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )

    # Use real MediaItemModel
    item = MediaItemModel(
        workspace_id=99,
        user_email="user@test.com",
        mime_type=MimeTypeEnum.IMAGE_PNG,
        model=GenerationModelEnum.IMAGEN_3_001,
        aspect_ratio=AspectRatioEnum.RATIO_1_1,
        gcs_uris=["gs://bucket/img.jpg"],
    )
    service.mock_media_repo.get_by_id.return_value = item

    # Mock workspace repo
    mock_workspace = MagicMock()
    service.mock_workspace_repo.get_by_id.return_value = mock_workspace

    service.mock_iam_signer.generate_presigned_url.return_value = (
        "https://signed.url/img.jpg"
    )

    result = await service.get_media_by_id(123, current_user)

    assert result is not None
    service.mock_workspace_auth.authorize.assert_called_once_with(
        workspace_id=99,
        user=current_user,
    )
    assert result.presigned_urls[0] == "https://signed.url/img.jpg"


@pytest.mark.anyio
async def test_bulk_delete_success(service):
    from src.galleries.dto.bulk_delete_dto import (
        BulkDeleteDto,
        BulkDeleteItemDto,
    )

    bulk_dto = BulkDeleteDto(
        workspace_id=99,
        items=[
            BulkDeleteItemDto(id=1, type="media_item"),
            BulkDeleteItemDto(id=2, type="source_asset"),
        ],
    )
    current_user = UserModel(
        id=1,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )

    mock_media = MagicMock(user_id=1, workspace_id=99)
    service.mock_media_repo.get_by_id.return_value = mock_media

    mock_asset = MagicMock(user_id=1, workspace_id=99)
    service.mock_source_asset_repo.get_by_id.return_value = mock_asset

    result = await service.bulk_delete(bulk_dto, current_user)

    assert result["deleted_count"] == 2
    service.mock_media_repo.soft_delete.assert_called_once_with(1, deleted_by=1)
    service.mock_source_asset_repo.soft_delete.assert_called_once_with(
        2, deleted_by=1
    )


@pytest.mark.anyio
async def test_bulk_copy_success(service):
    from pydantic import BaseModel

    from src.galleries.dto.bulk_copy_dto import BulkCopyDto, BulkCopyItemDto

    # Create dummy models due to exclude fields setups
    class DummyMedia(BaseModel):
        id: int
        workspace_id: int
        folder_id: int | None = None
        user_id: int
        user_email: str
        gcs_uris: list

    bulk_dto = BulkCopyDto(
        target_workspace_id=88,
        items=[BulkCopyItemDto(id=1, type="media_item")],
    )
    current_user = UserModel(
        id=1,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )

    mock_media = DummyMedia(
        id=1,
        workspace_id=99,
        folder_id=12,
        user_id=1,
        user_email="user@test.com",
        gcs_uris=[],
    )
    service.mock_media_repo.get_by_id.return_value = mock_media

    result = await service.bulk_copy(bulk_dto, current_user)

    assert result["copied_count"] == 1
    # Verify create was called with target_workspace_id and updated user references
    service.mock_media_repo.create.assert_called_once()
    args, kwargs = service.mock_media_repo.create.call_args
    assert args[0]["workspace_id"] == 88
    assert "folder_id" not in args[0]


@pytest.mark.anyio
async def test_bulk_download_success(service):
    from src.galleries.dto.bulk_download_dto import (
        BulkDownloadDto,
        BulkDownloadItemDto,
    )

    bulk_dto = BulkDownloadDto(
        workspace_id=99,
        items=[BulkDownloadItemDto(id=1, type="media_item")],
    )
    current_user = UserModel(
        id=1,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )

    mock_media = MagicMock(id=1, gcs_uris=["gs://bucket/image.png"])
    # Return string representation like "image/png" to bypass validation splits
    mock_media.mime_type = "image/png"
    service.mock_media_repo.get_by_id.return_value = mock_media

    service.mock_gcs_service.download_bytes_from_gcs.return_value = (
        b"fake-content"
    )
    service.mock_workspace_auth.authorize.return_value = None

    response = await service.bulk_download(bulk_dto, current_user)

    assert response.status_code == 200
    assert "application/zip" in response.headers["Content-Type"]


@pytest.mark.anyio
async def test_get_media_by_id_with_source_media_items(service):
    from src.common.schema.media_item_model import SourceMediaItemLink

    current_user = UserModel(
        id=1,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )

    item = MediaItemModel(
        workspace_id=99,
        user_email="user@test.com",
        mime_type=MimeTypeEnum.IMAGE_PNG,
        model=GenerationModelEnum.IMAGEN_3_001,
        aspect_ratio=AspectRatioEnum.RATIO_1_1,
        gcs_uris=["gs://bucket/img.jpg"],
        source_media_items=[
            SourceMediaItemLink(
                media_item_id=456,
                media_index=0,
                role=AssetRoleEnum.INPUT,
            ),
        ],
    )

    parent_sourced = MediaItemModel(
        id=456,
        workspace_id=99,
        user_email="u",
        mime_type=MimeTypeEnum.IMAGE_PNG,
        model=GenerationModelEnum.IMAGEN_3_001,
        aspect_ratio=AspectRatioEnum.RATIO_1_1,
        gcs_uris=["gs://bucket/parent.jpg"],
    )

    def get_by_id_side_effect(id, **kwargs):
        if id == 123:
            return item
        if id == 456:
            return parent_sourced
        return None

    service.mock_media_repo.get_by_id.side_effect = get_by_id_side_effect

    service.mock_workspace_repo.get_by_id.return_value = MagicMock()
    service.mock_iam_signer.generate_presigned_url.return_value = (
        "https://signed.url"
    )

    result = await service.get_media_by_id(123, current_user)

    assert result is not None
    assert len(result.enriched_source_media_items) == 1
    assert (
        result.enriched_source_media_items[0].presigned_url
        == "https://signed.url"
    )


@pytest.mark.anyio
async def test_restore_item_media_item(service):
    admin_user = UserModel(
        id=1,
        email="admin@test.com",
        name="Admin",
        roles=[UserRoleEnum.ADMIN],
    )
    service.mock_media_repo.restore.return_value = True

    result = await service.restore_item(1, "media_item", admin_user)
    assert result is True
    service.mock_media_repo.restore.assert_called_once_with(1)


@pytest.mark.anyio
async def test_restore_item_source_asset(service):
    admin_user = UserModel(
        id=1,
        email="admin@test.com",
        name="Admin",
        roles=[UserRoleEnum.ADMIN],
    )
    service.mock_source_asset_repo.restore.return_value = True

    result = await service.restore_item(1, "source_asset", admin_user)
    assert result is True
    service.mock_source_asset_repo.restore.assert_called_once_with(1)


@pytest.mark.anyio
async def test_restore_item_forbidden(service):
    regular_user = UserModel(
        id=2,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )
    with pytest.raises(HTTPException) as exc:
        await service.restore_item(1, "media_item", regular_user)
    assert exc.value.status_code == 403


@pytest.mark.anyio
async def test_bulk_copy_source_asset(service):
    from src.galleries.dto.bulk_copy_dto import BulkCopyDto, BulkCopyItemDto
    from src.source_assets.schema.source_asset_model import (
        AssetScopeEnum,
        AssetTypeEnum,
        SourceAssetModel,
    )

    bulk_dto = BulkCopyDto(
        target_workspace_id=88,
        items=[BulkCopyItemDto(id=5, type="source_asset")],
    )
    current_user = UserModel(
        id=1,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )

    asset = SourceAssetModel(
        id=5,
        workspace_id=99,
        folder_id=15,
        user_id=1,
        gcs_uri="gs://b",
        original_filename="a",
        file_hash="h",
        scope=AssetScopeEnum.PRIVATE,
        mime_type=MimeTypeEnum.IMAGE_PNG,
        asset_type=AssetTypeEnum.GENERIC_IMAGE,
    )
    service.mock_source_asset_repo.get_by_id.return_value = asset

    result = await service.bulk_copy(bulk_dto, current_user)
    assert result["copied_count"] == 1
    service.mock_source_asset_repo.create.assert_called_once()
    args, kwargs = service.mock_source_asset_repo.create.call_args
    assert args[0]["workspace_id"] == 88
    assert "folder_id" not in args[0]


@pytest.mark.anyio
async def test_bulk_delete_different_workspace(service):
    from src.galleries.dto.bulk_delete_dto import (
        BulkDeleteDto,
        BulkDeleteItemDto,
    )

    bulk_dto = BulkDeleteDto(
        workspace_id=99,
        items=[BulkDeleteItemDto(id=1, type="media_item")],
    )
    current_user = UserModel(
        id=1, email="u@t.com", name="U", roles=[UserRoleEnum.USER]
    )

    # Item in DIFFERENT workspace (88 vs 99)
    mock_media = MagicMock(id=1, workspace_id=88, user_id=1)
    service.mock_media_repo.get_by_id.return_value = mock_media

    result = await service.bulk_delete(bulk_dto, current_user)
    assert result["deleted_count"] == 0
    assert not service.mock_media_repo.soft_delete.called


@pytest.mark.anyio
async def test_bulk_delete_unauthorized(service):
    from src.galleries.dto.bulk_delete_dto import (
        BulkDeleteDto,
        BulkDeleteItemDto,
    )

    bulk_dto = BulkDeleteDto(
        workspace_id=99,
        items=[BulkDeleteItemDto(id=1, type="media_item")],
    )
    current_user = UserModel(
        id=1, email="u@t.com", name="U", roles=[UserRoleEnum.USER]
    )

    # Item owned by someone else (2 vs 1)
    mock_media = MagicMock(id=1, workspace_id=99, user_id=2)
    service.mock_media_repo.get_by_id.return_value = mock_media

    result = await service.bulk_delete(bulk_dto, current_user)
    assert result["deleted_count"] == 0
    assert not service.mock_media_repo.soft_delete.called


@pytest.mark.anyio
async def test_restore_item_unsupported_type(service):
    admin_user = UserModel(
        id=1, email="a@t.com", name="A", roles=[UserRoleEnum.ADMIN]
    )
    with pytest.raises(HTTPException) as exc:
        await service.restore_item(1, "unknown_type", admin_user)
    assert exc.value.status_code == 400


@pytest.mark.anyio
async def test_get_media_by_id_with_both_source_references(service):
    from src.common.schema.media_item_model import SourceMediaItemLink

    current_user = UserModel(
        id=1,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )

    item = MediaItemModel(
        workspace_id=99,
        user_email="user@test.com",
        mime_type=MimeTypeEnum.IMAGE_PNG,
        model=GenerationModelEnum.IMAGEN_3_001,
        aspect_ratio=AspectRatioEnum.RATIO_1_1,
        gcs_uris=["gs://bucket/img.jpg"],
        source_assets=[
            SourceAssetLink(
                asset_id=123,
                role=AssetRoleEnum.INPUT,
            )
        ],
        source_media_items=[
            SourceMediaItemLink(
                media_item_id=456,
                media_index=0,
                role=AssetRoleEnum.INPUT,
            ),
        ],
    )

    parent_sourced = MediaItemModel(
        id=456,
        workspace_id=99,
        user_email="u",
        mime_type=MimeTypeEnum.IMAGE_PNG,
        model=GenerationModelEnum.IMAGEN_3_001,
        aspect_ratio=AspectRatioEnum.RATIO_1_1,
        gcs_uris=["gs://bucket/parent.jpg"],
    )

    source_asset = MagicMock()
    source_asset.gcs_uri = "gs://bucket/asset.jpg"
    source_asset.thumbnail_gcs_uri = "gs://bucket/thumb.jpg"
    source_asset.mime_type = "image/jpeg"

    def get_by_id_side_effect(id, **kwargs):
        if id == 123:
            return item
        if id == 456:
            return parent_sourced
        return None

    service.mock_media_repo.get_by_id.side_effect = get_by_id_side_effect
    service.mock_source_asset_repo.get_by_id.return_value = source_asset

    service.mock_workspace_repo.get_by_id.return_value = MagicMock()
    service.mock_iam_signer.generate_presigned_url.return_value = (
        "https://signed.url"
    )

    result = await service.get_media_by_id(123, current_user)

    assert result is not None
    assert len(result.enriched_source_media_items) == 1
    assert (
        result.enriched_source_media_items[0].presigned_url
        == "https://signed.url"
    )
    assert len(result.enriched_source_assets) == 1
    assert (
        result.enriched_source_assets[0].presigned_url == "https://signed.url"
    )


def make_row(item_id: int, workspace_id: int = 99, user_id: int | None = 1):
    """Minimal media item / source asset shape that bulk_move reads."""
    return SimpleNamespace(
        id=item_id,
        workspace_id=workspace_id,
        user_id=user_id,
        folder_id=7,
    )


def make_folder(folder_id: int, workspace_id: int = 99):
    """Minimal folder shape that bulk_move reads off the locked row."""
    return SimpleNamespace(
        id=folder_id,
        workspace_id=workspace_id,
        name="Campaigns",
    )


def move_dto(*items):
    """Builds a BulkMoveDto targeting workspace 88 from (id, type) pairs."""
    return BulkMoveDto(
        target_workspace_id=88,
        items=[
            BulkMoveItemDto(id=item_id, type=item_type)
            for item_id, item_type in items
        ],
    )


def executed_statements(mock_db) -> list:
    """The statements handed to db.execute, in call order."""
    return [call.args[0] for call in mock_db.execute.await_args_list]


def as_pairs(results) -> list[tuple[str, int]]:
    """The (type, id) identity of each result row."""
    return [(row.type, row.id) for row in results]


def integrity_error(constraint_name: str) -> IntegrityError:
    """Builds an IntegrityError carrying a psycopg style constraint name."""
    orig = SimpleNamespace(
        diag=SimpleNamespace(constraint_name=constraint_name)
    )
    return IntegrityError("UPDATE folders ...", {}, orig)


def record_transaction_calls(mock_db) -> list[str]:
    """Records commit/rollback on the session in the order they happen."""
    calls: list[str] = []

    async def commit():
        calls.append("commit")

    async def rollback():
        calls.append("rollback")

    mock_db.commit.side_effect = commit
    mock_db.rollback.side_effect = rollback
    return calls


MOVER = UserModel(
    id=1,
    email="user@test.com",
    name="User",
    roles=[UserRoleEnum.USER],
)


@pytest.mark.anyio
async def test_bulk_move_media_item_success(service):
    service.mock_media_repo.get_by_id.return_value = make_row(1)

    result = await service.bulk_move(move_dto((1, "media_item")), MOVER)

    assert as_pairs(result.moved) == [("media_item", 1)]
    assert result.failed == []

    # The write pins identity, the authorized source workspace and active
    # state, so authorization and the update hit the same row atomically.
    statement = executed_statements(service.mock_db)[0]
    sql = str(statement)
    assert "UPDATE media_items" in sql
    assert "media_items.id = :id_1" in sql
    assert "media_items.workspace_id = :workspace_id_1" in sql
    assert "media_items.deleted_at IS NULL" in sql
    assert "updated_at=now()" in sql
    params = statement.compile().params
    assert params["id_1"] == 1
    assert params["workspace_id_1"] == 99
    assert params["workspace_id"] == 88
    assert params["folder_id"] is None

    # base_repository.update commits internally, so it can never be the write
    # a service-owned transaction wraps.
    service.mock_media_repo.update.assert_not_called()


@pytest.mark.anyio
async def test_bulk_move_source_asset_success(service):
    service.mock_source_asset_repo.get_by_id.return_value = make_row(5)

    result = await service.bulk_move(move_dto((5, "source_asset")), MOVER)

    assert as_pairs(result.moved) == [("source_asset", 5)]
    assert result.failed == []

    statement = executed_statements(service.mock_db)[0]
    sql = str(statement)
    assert "UPDATE source_assets" in sql
    assert "source_assets.workspace_id = :workspace_id_1" in sql
    assert "source_assets.deleted_at IS NULL" in sql
    params = statement.compile().params
    assert params["id_1"] == 5
    assert params["workspace_id_1"] == 99
    assert params["workspace_id"] == 88
    service.mock_source_asset_repo.update.assert_not_called()


@pytest.mark.anyio
async def test_bulk_move_folder_success(service):
    service.mock_folder_repo.get_folder_for_update.return_value = make_folder(
        10,
    )

    result = await service.bulk_move(move_dto((10, "folder")), MOVER)

    assert as_pairs(result.moved) == [("folder", 10)]
    assert result.failed == []

    # The root is locked first, and the workspace we authorize against is the
    # locked row's, which is also what every subtree write is predicated on.
    service.mock_folder_repo.get_folder_for_update.assert_awaited_once_with(10)
    service.mock_workspace_auth.authorize.assert_any_call(
        workspace_id=88, user=MOVER
    )
    service.mock_workspace_auth.authorize.assert_any_call(
        workspace_id=99, user=MOVER
    )
    service.mock_folder_repo.move_folder_to_workspace.assert_awaited_once_with(
        folder_id=10,
        target_workspace_id=88,
        authorized_source_workspace_id=99,
        commit=False,
    )
    assert service.mock_db.commit.await_count == 1


@pytest.mark.anyio
async def test_bulk_move_folder_same_workspace(service):
    service.mock_folder_repo.get_folder_for_update.return_value = make_folder(
        10,
        workspace_id=88,
    )

    result = await service.bulk_move(move_dto((10, "folder")), MOVER)

    assert result.moved == []
    assert as_pairs(result.failed) == [("folder", 10)]
    assert result.failed[0].reason == "Already in the target workspace"
    service.mock_folder_repo.move_folder_to_workspace.assert_not_called()
    service.mock_db.commit.assert_not_called()
    assert service.mock_db.rollback.await_count == 1


@pytest.mark.anyio
async def test_bulk_move_partial_success_success_then_failure(service):
    """The first item stays committed and the second is left untouched."""
    service.mock_media_repo.get_by_id.return_value = make_row(1)
    service.mock_source_asset_repo.get_by_id.return_value = make_row(
        2,
        workspace_id=77,
    )
    # The source asset lost its row: the conditional update matches nothing.
    service.mock_db.execute.side_effect = [
        MagicMock(rowcount=1),
        MagicMock(rowcount=0),
    ]
    calls = record_transaction_calls(service.mock_db)

    result = await service.bulk_move(
        move_dto((1, "media_item"), (2, "source_asset")),
        MOVER,
    )

    assert as_pairs(result.moved) == [("media_item", 1)]
    assert as_pairs(result.failed) == [("source_asset", 2)]
    assert result.failed[0].reason == "item changed or not found"

    # The commit for item 1 landed before item 2 was rolled back, so the
    # first item's move survives the second item's failure.
    assert calls == ["commit", "rollback"]


@pytest.mark.anyio
async def test_bulk_move_partial_success_failure_then_success(service):
    """A failed first item does not stop the loop from moving the second."""
    service.mock_source_asset_repo.get_by_id.return_value = make_row(
        2,
        user_id=42,
    )
    service.mock_media_repo.get_by_id.return_value = make_row(1)
    calls = record_transaction_calls(service.mock_db)

    result = await service.bulk_move(
        move_dto((2, "source_asset"), (1, "media_item")),
        MOVER,
    )

    assert as_pairs(result.failed) == [("source_asset", 2)]
    assert result.failed[0].reason == "Not authorized"
    assert as_pairs(result.moved) == [("media_item", 1)]
    assert calls == ["rollback", "commit"]


@pytest.mark.anyio
async def test_bulk_move_folder_subtree_failure_rolls_back(service):
    """A subtree that changed mid-move loses every write it made."""
    service.mock_folder_repo.get_folder_for_update.return_value = make_folder(
        10,
    )
    service.mock_folder_repo.move_folder_to_workspace.side_effect = (
        FolderSubtreeChangedError("subtree changed")
    )

    result = await service.bulk_move(move_dto((10, "folder")), MOVER)

    assert result.moved == []
    assert as_pairs(result.failed) == [("folder", 10)]
    assert result.failed[0].reason == "item changed or not found"
    service.mock_db.commit.assert_not_called()
    assert service.mock_db.rollback.await_count == 1


@pytest.mark.anyio
async def test_bulk_move_results_identify_items_by_id_and_type(service):
    """media_item 5 and folder 5 are different rows with the same id."""
    service.mock_media_repo.get_by_id.return_value = make_row(5)
    service.mock_folder_repo.get_folder_for_update.return_value = make_folder(5)
    service.mock_folder_repo.move_folder_to_workspace.side_effect = (
        FolderSubtreeChangedError("subtree changed")
    )

    result = await service.bulk_move(
        move_dto((5, "media_item"), (5, "folder")),
        MOVER,
    )

    assert as_pairs(result.moved) == [("media_item", 5)]
    assert as_pairs(result.failed) == [("folder", 5)]
    assert result.moved[0].model_dump() == {"id": 5, "type": "media_item"}
    assert result.failed[0].model_dump() == {
        "id": 5,
        "type": "folder",
        "reason": "item changed or not found",
    }


@pytest.mark.anyio
async def test_bulk_move_lost_source_workspace_race_is_reported_failed(service):
    """A row that left the authorized workspace matches no rows and fails."""
    service.mock_media_repo.get_by_id.return_value = make_row(1)
    service.mock_db.execute.return_value = MagicMock(rowcount=0)

    result = await service.bulk_move(move_dto((1, "media_item")), MOVER)

    assert result.moved == []
    assert as_pairs(result.failed) == [("media_item", 1)]
    assert result.failed[0].reason == "item changed or not found"
    service.mock_db.commit.assert_not_called()
    assert service.mock_db.rollback.await_count == 1


@pytest.mark.anyio
async def test_bulk_move_commits_once_after_the_service_owned_write(service):
    """No collaborator commits before the service's own per-item commit."""
    calls: list[str] = []
    service.mock_media_repo.get_by_id.return_value = make_row(1)
    service.mock_folder_repo.get_folder_for_update.return_value = make_folder(
        10,
    )

    def record_execute(*_args, **_kwargs):
        calls.append("execute")
        return MagicMock(rowcount=1)

    async def record_move(commit, **_kwargs):
        # commit=False is what leaves the transaction to the service.
        calls.append(f"move_folder(commit={commit})")

    async def record_commit():
        calls.append("commit")

    service.mock_db.execute.side_effect = record_execute
    service.mock_folder_repo.move_folder_to_workspace.side_effect = record_move
    service.mock_db.commit.side_effect = record_commit

    result = await service.bulk_move(
        move_dto((1, "media_item"), (10, "folder")),
        MOVER,
    )

    assert len(result.moved) == 2
    assert calls == [
        "execute",
        "commit",
        "move_folder(commit=False)",
        "commit",
    ]
    service.mock_db.rollback.assert_not_called()


@pytest.mark.anyio
async def test_bulk_move_target_workspace_denied_is_top_level_403(service):
    """Target authorization is common to the request, so it is not per item."""
    service.mock_workspace_auth.authorize.side_effect = HTTPException(
        status_code=403,
        detail="You do not have permission to access this workspace.",
    )
    service.mock_media_repo.get_by_id.return_value = make_row(1)

    with pytest.raises(HTTPException) as exc_info:
        await service.bulk_move(move_dto((1, "media_item")), MOVER)

    assert exc_info.value.status_code == 403
    service.mock_media_repo.get_by_id.assert_not_called()
    service.mock_db.execute.assert_not_called()
    service.mock_db.commit.assert_not_called()


@pytest.mark.anyio
async def test_bulk_move_source_workspace_denied_reason_is_sanitized(service):
    """WorkspaceAuth's raw detail never reaches the client."""
    service.mock_media_repo.get_by_id.return_value = make_row(1)

    async def authorize(workspace_id, user):  # pylint: disable=unused-argument
        if workspace_id == 99:
            raise HTTPException(
                status_code=403,
                detail="You do not have permission to access this workspace.",
            )

    service.mock_workspace_auth.authorize.side_effect = authorize

    result = await service.bulk_move(move_dto((1, "media_item")), MOVER)

    assert as_pairs(result.failed) == [("media_item", 1)]
    assert result.failed[0].reason == "Not authorized"
    service.mock_db.execute.assert_not_called()


@pytest.mark.anyio
async def test_bulk_move_missing_item_is_reported_failed(service):
    service.mock_media_repo.get_by_id.return_value = None
    service.mock_folder_repo.get_folder_for_update.return_value = None

    result = await service.bulk_move(
        move_dto((1, "media_item"), (10, "folder")),
        MOVER,
    )

    assert result.moved == []
    assert as_pairs(result.failed) == [("media_item", 1), ("folder", 10)]
    assert {row.reason for row in result.failed} == {"Not found"}
    service.mock_db.execute.assert_not_called()
    service.mock_folder_repo.move_folder_to_workspace.assert_not_called()


@pytest.mark.anyio
async def test_bulk_move_rejects_a_row_the_caller_does_not_own(service):
    """Same per-item ownership guard bulk_delete applies in this file."""
    service.mock_media_repo.get_by_id.return_value = make_row(1, user_id=42)

    result = await service.bulk_move(move_dto((1, "media_item")), MOVER)

    assert result.moved == []
    assert as_pairs(result.failed) == [("media_item", 1)]
    assert result.failed[0].reason == "Not authorized"
    service.mock_db.execute.assert_not_called()


@pytest.mark.anyio
async def test_bulk_move_admin_may_move_a_row_owned_by_someone_else(service):
    admin = UserModel(
        id=2,
        email="admin@test.com",
        name="Admin",
        roles=[UserRoleEnum.ADMIN],
    )
    service.mock_media_repo.get_by_id.return_value = make_row(1, user_id=42)

    result = await service.bulk_move(move_dto((1, "media_item")), admin)

    assert as_pairs(result.moved) == [("media_item", 1)]


@pytest.mark.anyio
async def test_bulk_move_unsupported_item_type_is_reported_failed(service):
    result = await service.bulk_move(move_dto((3, "playlist")), MOVER)

    assert result.moved == []
    assert as_pairs(result.failed) == [("playlist", 3)]
    assert result.failed[0].reason == "Unsupported item type"
    service.mock_db.commit.assert_not_called()


@pytest.mark.anyio
async def test_bulk_move_folder_name_conflict_is_its_own_reason(service):
    """Two movers racing for the same destination name is a known class."""
    service.mock_folder_repo.get_folder_for_update.return_value = make_folder(
        10,
    )
    service.mock_folder_repo.move_folder_to_workspace.side_effect = (
        integrity_error("uq_folders_workspace_root_name_active")
    )

    result = await service.bulk_move(move_dto((10, "folder")), MOVER)

    assert result.moved == []
    assert result.failed[0].reason == "Name conflict at destination"
    service.mock_db.commit.assert_not_called()
    assert service.mock_db.rollback.await_count == 1


@pytest.mark.anyio
async def test_bulk_move_other_integrity_error_is_not_a_name_conflict(service):
    service.mock_folder_repo.get_folder_for_update.return_value = make_folder(
        10,
    )
    service.mock_folder_repo.move_folder_to_workspace.side_effect = (
        integrity_error("folders_workspace_id_fkey")
    )

    result = await service.bulk_move(move_dto((10, "folder")), MOVER)

    assert result.moved == []
    assert result.failed[0].reason == "Move failed"
    assert service.mock_db.rollback.await_count == 1


@pytest.mark.anyio
async def test_bulk_move_unexpected_error_reason_is_sanitized(service):
    service.mock_media_repo.get_by_id.return_value = make_row(1)
    service.mock_db.execute.side_effect = RuntimeError(
        "connection to db-prod-1 as svc-account failed",
    )

    result = await service.bulk_move(move_dto((1, "media_item")), MOVER)

    assert result.moved == []
    assert result.failed[0].reason == "Move failed"
    service.mock_db.commit.assert_not_called()
    assert service.mock_db.rollback.await_count == 1


@pytest.mark.anyio
async def test_bulk_copy_folder_success(service):
    from pydantic import BaseModel
    from src.galleries.dto.bulk_copy_dto import BulkCopyDto, BulkCopyItemDto

    class DummyFolder(BaseModel):
        id: int
        workspace_id: int
        name: str

    bulk_dto = BulkCopyDto(
        target_workspace_id=88,
        items=[BulkCopyItemDto(id=10, type="folder")],
    )
    current_user = UserModel(
        id=1,
        email="user@test.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )

    folder = DummyFolder(id=10, workspace_id=99, name="Campaigns")
    service.mock_folder_repo.get_folder_by_id.return_value = folder
    service.mock_folder_repo.copy_folder_to_workspace.return_value = {
        "folders_copied": 2,
        "media_copied": 3,
        "assets_copied": 1,
    }

    result = await service.bulk_copy(bulk_dto, current_user)
    assert result["copied_count"] == 1
    service.mock_workspace_auth.authorize.assert_any_call(
        workspace_id=88, user=current_user
    )
    service.mock_workspace_auth.authorize.assert_any_call(
        workspace_id=99, user=current_user
    )
    service.mock_folder_repo.copy_folder_to_workspace.assert_called_once_with(
        folder_id=10,
        target_workspace_id=88,
        user_id=1,
        user_email="user@test.com",
    )
