# Copyright 2025 Google LLC
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
"""Tests for User Service."""


from unittest.mock import AsyncMock

import pytest

from src.users.user_model import UserRoleEnum
from src.users.user_service import UserService


@pytest.fixture(name="mock_user_repo")
def fixture_mock_user_repo():
    """Provides a mocked UserRepository."""
    # We mock the UserRepository class itself to avoid DB dependency
    repo = AsyncMock()
    return repo


@pytest.fixture(name="user_service")
def fixture_user_service(mock_user_repo):
    """Provides a UserService with a mocked repository."""
    return UserService(user_repo=mock_user_repo)


class TestCreateOrSyncUser:
    """Tests for UserService.create_or_sync_user."""

    @pytest.mark.anyio
    async def test_creates_user_with_roles_from_the_token(
        self, user_service, mock_user_repo, mock_user
    ):
        mock_user_repo.get_by_email.return_value = None
        mock_user_repo.create.return_value = mock_user

        result = await user_service.create_or_sync_user(
            email="new@example.com",
            name="New User",
            picture="http://pic.jpg",
            roles=["admin", "user"],
        )

        assert result == mock_user
        mock_user_repo.get_by_email.assert_called_once_with("new@example.com")
        created = mock_user_repo.create.call_args[0][0]
        assert created["email"] == "new@example.com"
        assert created["name"] == "New User"
        assert created["roles"] == ["admin", "user"]

    @pytest.mark.anyio
    async def test_falls_back_to_the_email_local_part_for_a_missing_name(
        self, user_service, mock_user_repo, mock_user
    ):
        """UserCreateDto requires two characters, so an empty Okta
        displayName would otherwise 500 on the user's first request."""
        mock_user_repo.get_by_email.return_value = None
        mock_user_repo.create.return_value = mock_user

        await user_service.create_or_sync_user(
            email="nameless@example.com",
            name="",
            picture="",
            roles=["user"],
        )

        assert mock_user_repo.create.call_args[0][0]["name"] == "nameless"

    @pytest.mark.anyio
    async def test_no_write_when_nothing_changed(
        self, user_service, mock_user_repo, mock_user
    ):
        """This runs on every request across 14 controllers.

        A naive reconcile would issue an UPDATE per API call, so the
        no-op path must not touch the database at all.
        """
        mock_user_repo.get_by_email.return_value = mock_user

        result = await user_service.create_or_sync_user(
            email="user@example.com",
            name="Regular User",
            picture="http://example.com/user.jpg",
            roles=["user"],
        )

        assert result == mock_user
        mock_user_repo.create.assert_not_called()
        mock_user_repo.update.assert_not_called()

    @pytest.mark.anyio
    async def test_role_order_and_duplicates_do_not_trigger_a_write(
        self, user_service, mock_user_repo, mock_admin
    ):
        mock_admin.roles = [UserRoleEnum.ADMIN, UserRoleEnum.USER]
        mock_user_repo.get_by_email.return_value = mock_admin

        await user_service.create_or_sync_user(
            email="admin@example.com",
            name="Admin User",
            picture="http://example.com/admin.jpg",
            roles=["user", "admin"],
        )

        mock_user_repo.update.assert_not_called()

    @pytest.mark.anyio
    async def test_promotes_a_user_whose_groups_gained_admin(
        self, user_service, mock_user_repo, mock_user, mock_admin
    ):
        mock_user_repo.get_by_email.return_value = mock_user
        mock_user_repo.update.return_value = mock_admin

        result = await user_service.create_or_sync_user(
            email="user@example.com",
            name="Regular User",
            picture="http://example.com/user.jpg",
            roles=["admin", "user"],
        )

        assert result == mock_admin
        mock_user_repo.update.assert_called_once_with(
            1, {"roles": ["admin", "user"]}
        )

    @pytest.mark.anyio
    async def test_demotes_a_user_removed_from_the_admin_group(
        self, user_service, mock_user_repo, mock_admin, mock_user
    ):
        """Removal from an Okta group has to take effect, not just addition."""
        mock_user_repo.get_by_email.return_value = mock_admin
        mock_user_repo.update.return_value = mock_user

        await user_service.create_or_sync_user(
            email="admin@example.com",
            name="Admin User",
            picture="http://example.com/admin.jpg",
            roles=["user"],
        )

        mock_user_repo.update.assert_called_once_with(2, {"roles": ["user"]})

    @pytest.mark.anyio
    async def test_updates_a_changed_name_and_picture(
        self, user_service, mock_user_repo, mock_user
    ):
        mock_user_repo.get_by_email.return_value = mock_user
        mock_user_repo.update.return_value = mock_user

        await user_service.create_or_sync_user(
            email="user@example.com",
            name="Renamed User",
            picture="http://example.com/new.jpg",
            roles=["user"],
        )

        mock_user_repo.update.assert_called_once_with(
            1,
            {"name": "Renamed User", "picture": "http://example.com/new.jpg"},
        )

    @pytest.mark.anyio
    async def test_empty_claims_do_not_blank_a_stored_name_or_picture(
        self, user_service, mock_user_repo, mock_user
    ):
        mock_user_repo.get_by_email.return_value = mock_user

        await user_service.create_or_sync_user(
            email="user@example.com",
            name="",
            picture="",
            roles=["user"],
        )

        mock_user_repo.update.assert_not_called()


class TestGetUserById:
    """Tests for UserService.get_user_by_id."""

    @pytest.mark.anyio
    async def test_get_user_found(
        self, user_service, mock_user_repo, mock_user
    ):
        mock_user_repo.get_by_id.return_value = mock_user

        result = await user_service.get_user_by_id(1)

        assert result == mock_user
        mock_user_repo.get_by_id.assert_called_once_with(1)

    @pytest.mark.anyio
    async def test_get_user_not_found(self, user_service, mock_user_repo):
        mock_user_repo.get_by_id.return_value = None

        result = await user_service.get_user_by_id(999)

        assert result is None
        mock_user_repo.get_by_id.assert_called_once_with(999)
