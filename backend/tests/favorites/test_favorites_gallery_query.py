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
"""Tests for per-user favorite state in the unified gallery query."""

import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.galleries.dto.gallery_search_dto import GallerySearchDto
from src.galleries.repository.unified_gallery_repository import (
    UnifiedGalleryRepository,
)


class MockItem:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)


def _row(**kwargs):
    base = dict(
        workspace_id=10,
        user_id=1,
        created_at=datetime.datetime.now(),
        status="completed",
        gcs_uris=["gs://b/1"],
        thumbnail_uris=[],
        deleted_at=None,
        metadata_={"mime_type": "image/png"},
    )
    base.update(kwargs)
    return MockItem(**base)


@pytest.mark.anyio
async def test_is_favorite_populated_for_current_user():
    """is_favorite is set for media items the requesting user favorited."""
    mock_db = AsyncMock()

    count_result = MagicMock()
    count_result.scalar_one.return_value = 2

    data_result = MagicMock()
    data_result.scalars.return_value.all.return_value = [
        _row(id=1, item_type="media_item"),
        _row(id=2, item_type="media_item"),
    ]

    favorites_result = MagicMock()
    favorites_result.scalars.return_value.all.return_value = [1]

    mock_db.execute.side_effect = [count_result, data_result, favorites_result]

    repo = UnifiedGalleryRepository(db=mock_db)
    res = await repo.query(
        GallerySearchDto(workspace_id=10, limit=10, offset=0),
        current_user_id=1,
    )

    by_id = {item.id: item for item in res.data}
    assert by_id[1].is_favorite is True
    assert by_id[2].is_favorite is False
    # count + data + favorites lookup
    assert mock_db.execute.call_count == 3


@pytest.mark.anyio
async def test_source_assets_never_favorited():
    """Source assets never carry is_favorite and skip the favorites lookup."""
    mock_db = AsyncMock()

    count_result = MagicMock()
    count_result.scalar_one.return_value = 1

    data_result = MagicMock()
    data_result.scalars.return_value.all.return_value = [
        _row(id=1, item_type="source_asset"),
    ]

    mock_db.execute.side_effect = [count_result, data_result]

    repo = UnifiedGalleryRepository(db=mock_db)
    res = await repo.query(
        GallerySearchDto(workspace_id=10, limit=10, offset=0),
        current_user_id=1,
    )

    assert res.data[0].is_favorite is False
    # No media items on the page, so no favorites lookup is issued.
    assert mock_db.execute.call_count == 2


@pytest.mark.anyio
async def test_favorites_only_filter_no_extra_query_when_no_user():
    """favorites_only is ignored without a requesting user (no is_favorite)."""
    mock_db = AsyncMock()

    count_result = MagicMock()
    count_result.scalar_one.return_value = 0
    data_result = MagicMock()
    data_result.scalars.return_value.all.return_value = []
    mock_db.execute.side_effect = [count_result, data_result]

    repo = UnifiedGalleryRepository(db=mock_db)
    res = await repo.query(
        GallerySearchDto(workspace_id=10, favorites_only=True, limit=10),
    )

    assert res.data == []
    assert mock_db.execute.call_count == 2
