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
"""Tests for FavoritesRepository."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.favorites.repository.favorites_repository import FavoritesRepository


@pytest.mark.anyio
async def test_add_favorite_commits():
    """add_favorite issues an upsert and commits (idempotent)."""
    mock_db = AsyncMock()
    repo = FavoritesRepository(db=mock_db)

    await repo.add_favorite(user_id=1, media_item_id=10)

    assert mock_db.execute.call_count == 1
    mock_db.commit.assert_called_once()


@pytest.mark.anyio
async def test_remove_favorite_returns_true_when_deleted():
    """remove_favorite returns True when a row was removed."""
    mock_db = AsyncMock()
    mock_result = MagicMock()
    mock_result.rowcount = 1
    mock_db.execute.return_value = mock_result

    repo = FavoritesRepository(db=mock_db)
    result = await repo.remove_favorite(user_id=1, media_item_id=10)

    assert result is True
    mock_db.commit.assert_called_once()


@pytest.mark.anyio
async def test_remove_favorite_returns_false_when_absent():
    """remove_favorite returns False when nothing was favorited."""
    mock_db = AsyncMock()
    mock_result = MagicMock()
    mock_result.rowcount = 0
    mock_db.execute.return_value = mock_result

    repo = FavoritesRepository(db=mock_db)
    result = await repo.remove_favorite(user_id=1, media_item_id=99)

    assert result is False


@pytest.mark.anyio
async def test_is_favorite_true_and_false():
    """is_favorite reflects whether a row exists for the user/item pair."""
    mock_db = AsyncMock()

    present = MagicMock()
    present.scalar_one_or_none.return_value = 5
    absent = MagicMock()
    absent.scalar_one_or_none.return_value = None
    mock_db.execute.side_effect = [present, absent]

    repo = FavoritesRepository(db=mock_db)

    assert await repo.is_favorite(user_id=1, media_item_id=10) is True
    assert await repo.is_favorite(user_id=1, media_item_id=11) is False


@pytest.mark.anyio
async def test_favorite_media_item_ids_empty_input_short_circuits():
    """An empty id list returns an empty set without touching the db."""
    mock_db = AsyncMock()
    repo = FavoritesRepository(db=mock_db)

    result = await repo.favorite_media_item_ids(user_id=1, media_item_ids=[])

    assert result == set()
    mock_db.execute.assert_not_called()


@pytest.mark.anyio
async def test_favorite_media_item_ids_returns_subset():
    """favorite_media_item_ids returns the favorited subset."""
    mock_db = AsyncMock()
    mock_result = MagicMock()
    mock_result.scalars.return_value.all.return_value = [10, 30]
    mock_db.execute.return_value = mock_result

    repo = FavoritesRepository(db=mock_db)
    result = await repo.favorite_media_item_ids(
        user_id=1, media_item_ids=[10, 20, 30]
    )

    assert result == {10, 30}
