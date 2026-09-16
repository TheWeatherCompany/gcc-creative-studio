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
"""Tests for UnifiedGalleryRepository using mocks."""

import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.dialects import postgresql

from src.common.base_dto import GenerationModelEnum, MimeTypeEnum
from src.common.schema.media_item_model import JobStatusEnum
from src.galleries.dto.gallery_search_dto import GallerySearchDto
from src.galleries.repository.unified_gallery_repository import (
    UnifiedGalleryRepository,
)


class MockItem:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


@pytest.fixture(name="mock_db")
def fixture_mock_db():
    return AsyncMock()


@pytest.mark.anyio
async def test_query_various_filters(mock_db):
    repo = UnifiedGalleryRepository(db=mock_db)

    # Mock the count and data results
    mock_count_result = MagicMock()
    mock_count_result.scalar_one.return_value = 5

    mock_data_result = MagicMock()
    # Use real object instead of mock to satisfy Pydantic validation
    mock_item = MockItem(
        id=1,
        workspace_id=10,
        user_id=1,
        created_at=datetime.datetime.now(),
        item_type="media_item",
        status="completed",
        gcs_uris=["gs://b/1"],
        thumbnail_uris=[],
        deleted_at=None,
        metadata_={"mime_type": "image/png"},
    )

    mock_data_result.scalars.return_value.all.return_value = [mock_item]

    mock_db.execute.side_effect = [mock_count_result, mock_data_result]

    # 1. Test query with many filters to hit all branches
    search_dto = GallerySearchDto(
        workspace_id=10,
        status=JobStatusEnum.COMPLETED,
        user_email="test@test.com",
        mime_type=MimeTypeEnum.IMAGE_PNG,
        model=GenerationModelEnum.IMAGEN_3_001,
        start_date=datetime.date(2025, 1, 1),
        end_date=datetime.date(2025, 1, 31),
        query="sunset",
        limit=10,
        offset=0,
    )
    # Give it an item_type if it supports it
    search_dto.item_type = "media_item"

    res = await repo.query(search_dto, user_id=1)

    assert res.count == 5
    assert len(res.data) == 1
    assert mock_db.execute.call_count == 2


@pytest.mark.anyio
async def test_query_free_text_matches_tag_substring(mock_db):
    """A free-text query folds tag names into the ILIKE OR so a partial tag
    term (e.g. "sun" for a "sunset" tag) matches the item."""
    repo = UnifiedGalleryRepository(db=mock_db)

    mock_count_result = MagicMock()
    mock_count_result.scalar_one.return_value = 1

    mock_data_result = MagicMock()
    tagged_item = MockItem(
        id=7,
        workspace_id=10,
        user_id=1,
        created_at=datetime.datetime.now(),
        item_type="media_item",
        status="completed",
        gcs_uris=["gs://b/7"],
        thumbnail_uris=[],
        deleted_at=None,
        metadata_={
            "mime_type": "image/png",
            "prompt": "a calm scene",
            "tags": [
                {
                    "id": 1,
                    "name": "sunset",
                    "color": "#E8EAED",
                    "workspace_id": 10,
                }
            ],
        },
    )
    mock_data_result.scalars.return_value.all.return_value = [tagged_item]

    mock_db.execute.side_effect = [mock_count_result, mock_data_result]

    search_dto = GallerySearchDto(
        workspace_id=10,
        query="sun",
        limit=10,
        offset=0,
    )

    res = await repo.query(search_dto)

    # The item whose only "sun" hit is the tag name is returned.
    assert res.count == 1
    assert [item.id for item in res.data] == [7]

    # Prove the tag names are part of the free-text OR: the compiled data
    # query extracts tag names via a JSON path and ILIKEs them alongside the
    # existing prompt/file_name/model/original_filename columns.
    data_stmt = mock_db.execute.call_args_list[1].args[0]
    compiled = str(
        data_stmt.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    ).lower()
    assert "jsonb_path_query_array" in compiled
    assert "$[*].name" in compiled
    assert "ilike" in compiled


@pytest.mark.anyio
async def test_query_threads_current_user_id_into_favorites_subquery(mock_db):
    """`favorites_only` compiles to a correlated EXISTS against
    media_item_favorites that is scoped to the requesting user.

    Honest about the limit: this asserts the `current_user_id` parameter is
    threaded into the statement the repository builds, not that the SQL is
    semantically correct (nothing here touches a real engine). That is
    deliberate. The regression being guarded is the parameter disappearing from
    `query()` entirely, which would widen the favorites filter to every user's
    favorites while still returning rows and still passing every other test.
    """
    repo = UnifiedGalleryRepository(db=mock_db)

    mock_count_result = MagicMock()
    mock_count_result.scalar_one.return_value = 1

    mock_data_result = MagicMock()
    favorited_item = MockItem(
        id=42,
        workspace_id=10,
        user_id=1,
        created_at=datetime.datetime.now(),
        item_type="media_item",
        status="completed",
        gcs_uris=["gs://b/42"],
        thumbnail_uris=[],
        deleted_at=None,
        metadata_={"mime_type": "image/png"},
    )
    mock_data_result.scalars.return_value.all.return_value = [favorited_item]

    # Third execute: the per-user favorite-state lookup for the rows on this
    # page, which also has to carry the requesting user's id.
    mock_favorite_result = MagicMock()
    mock_favorite_result.scalars.return_value.all.return_value = [42]

    mock_db.execute.side_effect = [
        mock_count_result,
        mock_data_result,
        mock_favorite_result,
    ]

    search_dto = GallerySearchDto(
        workspace_id=10,
        limit=10,
        offset=0,
    )
    search_dto.favorites_only = True

    res = await repo.query(search_dto, current_user_id=99)

    data_stmt = mock_db.execute.call_args_list[1].args[0]
    compiled_data = str(
        data_stmt.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    ).lower()

    # The correlation itself: an EXISTS over the favorites join table tied to
    # the gallery row, scoped to the caller, and guarded to media items so a
    # source_asset sharing an id cannot match.
    assert "exists" in compiled_data
    assert "media_item_favorites" in compiled_data
    assert "media_item_favorites.user_id = 99" in compiled_data
    assert "media_item_favorites.media_item_id = unified_gallery_view.id" in (
        compiled_data
    )
    assert "unified_gallery_view.item_type = 'media_item'" in compiled_data

    # And the per-row `is_favorite` hydration is scoped to the same user.
    favorite_stmt = mock_db.execute.call_args_list[2].args[0]
    compiled_favorites = str(
        favorite_stmt.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    ).lower()
    assert "media_item_favorites.user_id = 99" in compiled_favorites

    assert mock_db.execute.call_count == 3
    assert [item.id for item in res.data] == [42]
    assert res.data[0].is_favorite is True


@pytest.mark.anyio
async def test_query_without_current_user_id_skips_favorite_lookup(mock_db):
    """No requesting user means no favorites correlation and no extra round
    trip: `is_favorite` stays false rather than leaking another user's state.
    """
    repo = UnifiedGalleryRepository(db=mock_db)

    mock_count_result = MagicMock()
    mock_count_result.scalar_one.return_value = 1

    mock_data_result = MagicMock()
    mock_data_result.scalars.return_value.all.return_value = [
        MockItem(
            id=42,
            workspace_id=10,
            user_id=1,
            created_at=datetime.datetime.now(),
            item_type="media_item",
            status="completed",
            gcs_uris=["gs://b/42"],
            thumbnail_uris=[],
            deleted_at=None,
            metadata_={"mime_type": "image/png"},
        )
    ]
    mock_db.execute.side_effect = [mock_count_result, mock_data_result]

    search_dto = GallerySearchDto(workspace_id=10, limit=10, offset=0)
    search_dto.favorites_only = True

    res = await repo.query(search_dto)

    data_stmt = mock_db.execute.call_args_list[1].args[0]
    compiled_data = str(
        data_stmt.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    ).lower()
    assert "media_item_favorites" not in compiled_data

    assert mock_db.execute.call_count == 2
    assert res.data[0].is_favorite is False


@pytest.mark.anyio
async def test_query_mime_type_wildcard(mock_db):
    repo = UnifiedGalleryRepository(db=mock_db)

    mock_count_result = MagicMock()
    mock_count_result.scalar_one.return_value = 2
    mock_data_result = MagicMock()
    mock_data_result.scalars.return_value.all.return_value = []
    mock_db.execute.side_effect = [mock_count_result, mock_data_result]

    search_dto = GallerySearchDto(
        mime_type="image/*",
        limit=10,
        offset=0,
    )

    await repo.query(search_dto)
    assert mock_db.execute.call_count == 2
