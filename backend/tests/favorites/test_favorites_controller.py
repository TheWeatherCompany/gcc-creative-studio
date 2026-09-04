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
"""Tests for the gallery favorite/unfavorite endpoints."""

from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.auth.auth_guard import get_current_user
from src.galleries.gallery_controller import router
from src.galleries.gallery_service import GalleryService
from src.favorites.dto.favorite_response_dto import FavoriteResponseDto
from src.users.user_model import UserModel, UserRoleEnum
from src.workspaces.workspace_auth_guard import WorkspaceAuth


@pytest.fixture(name="mock_user")
def fixture_mock_user():
    return UserModel(
        id=2,
        email="user@example.com",
        name="User",
        roles=[UserRoleEnum.USER],
    )


@pytest.fixture(name="mock_service")
def fixture_mock_service():
    service = AsyncMock()
    service.favorite_item = AsyncMock(
        return_value=FavoriteResponseDto(is_favorite=True)
    )
    service.unfavorite_item = AsyncMock(
        return_value=FavoriteResponseDto(is_favorite=False)
    )
    return service


@pytest.fixture(name="client")
def fixture_client(mock_user, mock_service):
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_current_user] = lambda: mock_user
    app.dependency_overrides[GalleryService] = lambda: mock_service
    app.dependency_overrides[WorkspaceAuth] = lambda: AsyncMock()
    return TestClient(app)


def test_favorite_item(client, mock_service):
    response = client.post("/api/gallery/item/10/favorite")
    assert response.status_code == 200
    assert response.json() == {"isFavorite": True}
    mock_service.favorite_item.assert_called_once()
    _, kwargs = mock_service.favorite_item.call_args
    assert kwargs["item_id"] == 10


def test_unfavorite_item(client, mock_service):
    response = client.delete("/api/gallery/item/10/favorite")
    assert response.status_code == 200
    assert response.json() == {"isFavorite": False}
    mock_service.unfavorite_item.assert_called_once()
    _, kwargs = mock_service.unfavorite_item.call_args
    assert kwargs["item_id"] == 10
