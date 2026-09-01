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
"""Tests for Media Item Repository."""


from unittest.mock import AsyncMock, MagicMock

import pytest

from src.common.base_dto import GenerationModelEnum, MimeTypeEnum
from src.common.schema.media_item_model import JobStatusEnum, MediaItem
from src.galleries.dto.gallery_search_dto import GallerySearchDto
from src.images.repository.media_item_repository import MediaRepository


@pytest.mark.anyio
async def test_media_repository_query_success():
    mock_db = AsyncMock()

    mock_count_result = MagicMock()
    mock_count_result.scalar_one.return_value = 1

    from datetime import datetime

    mock_item = MediaItem(
        id=1,
        workspace_id=1,
        user_email="test@example.com",
        mime_type="image/png",
        model="gemini-3.1-flash-image",
        aspect_ratio="1:1",
        status="completed",
        created_at=datetime.now(),
        updated_at=datetime.now(),
        gcs_uris=[],
        thumbnail_uris=[],
    )

    mock_result = MagicMock()
    mock_result.scalars().all.return_value = [mock_item]

    mock_db.execute.side_effect = [mock_count_result, mock_result]

    repo = MediaRepository(db=mock_db)

    search_dto = GallerySearchDto(
        limit=10,
        offset=0,
        user_email="test@example.com",
        mime_type=MimeTypeEnum.IMAGE_PNG,
        model=GenerationModelEnum.GEMINI_3_1_FLASH_IMAGE_PREVIEW,
        status=JobStatusEnum.COMPLETED,
    )

    response = await repo.query(search_dto=search_dto, workspace_id=1)

    assert response.count == 1
    assert len(response.data) == 1
    assert response.data[0].id == 1
    assert mock_db.execute.call_count == 2


@pytest.mark.anyio
async def test_media_repository_query_wildcard():
    mock_db = AsyncMock()
    mock_count = MagicMock()
    mock_count.scalar_one.return_value = 0
    mock_result = MagicMock()
    mock_result.scalars().all.return_value = []
    mock_db.execute.side_effect = [mock_count, mock_result]

    repo = MediaRepository(db=mock_db)

    search_dto = GallerySearchDto(limit=10, offset=0)
    search_dto.mime_type = MagicMock()
    search_dto.mime_type.value = "image/*"

    response = await repo.query(search_dto=search_dto)

    assert response.count == 0


@pytest.mark.anyio
async def test_media_repository_query_custom_model_value():
    mock_db = AsyncMock()

    mock_count_result = MagicMock()
    mock_count_result.scalar_one.return_value = 1

    from datetime import datetime

    # Database has custom model name "custom-model-id"
    mock_item = MediaItem(
        id=1,
        workspace_id=1,
        user_email="test@example.com",
        mime_type="video/mp4",
        model="custom-model-id",
        aspect_ratio="16:9",
        status="completed",
        created_at=datetime.now(),
        updated_at=datetime.now(),
        gcs_uris=[],
        thumbnail_uris=[],
    )

    mock_result = MagicMock()
    mock_result.scalars().all.return_value = [mock_item]

    mock_db.execute.side_effect = [mock_count_result, mock_result]

    repo = MediaRepository(db=mock_db)

    search_dto = GallerySearchDto(
        limit=10,
        offset=0,
    )

    response = await repo.query(search_dto=search_dto, workspace_id=1)

    assert response.count == 1
    assert len(response.data) == 1
    # Check that model is successfully validated and stored as "custom-model-id" string
    assert response.data[0].model == "custom-model-id"


@pytest.mark.anyio
async def test_count_active_generations_predicates():
    """The cap is only correct if the count query filters on exactly the right
    rows, so assert on the compiled WHERE clause rather than a mocked return.
    """
    mock_db = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one.return_value = 3
    mock_db.execute.return_value = mock_result

    repo = MediaRepository(db=mock_db)

    count = await repo.count_active_generations(
        user_id=42,
        mime_type_prefix="video/",
    )

    assert count == 3
    query = mock_db.execute.call_args.args[0]
    compiled = str(
        query.compile(compile_kwargs={"literal_binds": True})
    ).lower()

    assert "media_items.user_id = 42" in compiled
    assert f"status = '{JobStatusEnum.PROCESSING.value}'" in compiled
    assert "deleted_at is null" in compiled
    assert "mime_type like 'video/%'" in compiled
    # The staleness bound keeps orphaned PROCESSING rows (killed mid-run by a
    # deploy) from counting against the user forever.
    assert "created_at >=" in compiled


@pytest.mark.anyio
async def test_count_active_generations_excludes_stale_rows():
    """The cutoff must match the admin stuck-job cleanup window."""
    from datetime import datetime, timedelta, timezone

    from src.common.job_policy import STUCK_JOB_STALE_AFTER

    mock_db = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalar_one.return_value = 0
    mock_db.execute.return_value = mock_result

    repo = MediaRepository(db=mock_db)
    before = datetime.now(timezone.utc)
    await repo.count_active_generations(user_id=1)
    after = datetime.now(timezone.utc)

    query = mock_db.execute.call_args.args[0]
    cutoffs = [
        value
        for value in query.compile().params.values()
        if isinstance(value, datetime)
    ]
    assert len(cutoffs) == 1
    assert (
        before - STUCK_JOB_STALE_AFTER
        <= cutoffs[0]
        <= after - STUCK_JOB_STALE_AFTER
    )
    assert STUCK_JOB_STALE_AFTER == timedelta(hours=1)

    # No mime-type prefix means the cap is not scoped to one media type.
    compiled = str(query.compile(compile_kwargs={"literal_binds": True}))
    assert "mime_type LIKE" not in compiled
