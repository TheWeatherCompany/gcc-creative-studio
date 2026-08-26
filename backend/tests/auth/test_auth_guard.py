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

import time
from unittest.mock import AsyncMock

import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from src.auth.auth_guard import RoleChecker, get_current_user
from src.users.user_model import UserModel, UserRoleEnum
from tests.auth.conftest import OMIT


@pytest.fixture(name="mock_user_service")
def fixture_mock_user_service():
    service = AsyncMock()
    service.create_or_sync_user.return_value = UserModel(
        id=1,
        email="test@example.com",
        roles=["user"],
        name="Test User",
    )
    return service


class TestGetCurrentUser:
    """Tests for get_current_user.

    These drive real signed tokens through the real verifier; only the JWKS
    fetch and the user service are stubbed.
    """

    @pytest.mark.anyio
    async def test_valid_token_provisions_user(
        self, mint_token, mock_user_service
    ):
        user = await get_current_user(
            token=mint_token(),
            user_service=mock_user_service,
        )

        assert user.email == "test@example.com"
        mock_user_service.create_or_sync_user.assert_called_once_with(
            email="test@example.com",
            name="Test User",
            picture="http://example.com/pic.jpg",
            roles=["user"],
        )

    @pytest.mark.anyio
    async def test_roles_come_from_the_groups_claim(
        self, mint_token, mock_user_service
    ):
        """The whole point of the migration: the token decides the roles."""
        await get_current_user(
            token=mint_token(
                groups=[
                    "Creative Studio PortalAdmins",
                    "Creative Studio Users",
                ],
            ),
            user_service=mock_user_service,
        )

        _, kwargs = mock_user_service.create_or_sync_user.call_args
        assert kwargs["roles"] == ["admin", "user"]

    @pytest.mark.anyio
    async def test_unmapped_groups_are_ignored(
        self, mint_token, mock_user_service
    ):
        await get_current_user(
            token=mint_token(
                groups=["Creative Studio Users", "Marketing Team"],
            ),
            user_service=mock_user_service,
        )

        _, kwargs = mock_user_service.create_or_sync_user.call_args
        assert kwargs["roles"] == ["user"]

    @pytest.mark.anyio
    async def test_no_matching_group_returns_403(
        self, mint_token, mock_user_service
    ):
        """The backstop that replaces the old hosted-domain check.

        Reachable by assigning the Okta app to an individual rather than to a
        group. It must not fall through to a default 'user' role.
        """
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(
                token=mint_token(groups=["Some Other Group"]),
                user_service=mock_user_service,
            )

        assert exc_info.value.status_code == 403
        assert "Creative Studio Okta group" in exc_info.value.detail
        mock_user_service.create_or_sync_user.assert_not_called()

    @pytest.mark.anyio
    async def test_empty_groups_claim_returns_403(
        self, mint_token, mock_user_service
    ):
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(
                token=mint_token(groups=[]),
                user_service=mock_user_service,
            )

        assert exc_info.value.status_code == 403
        mock_user_service.create_or_sync_user.assert_not_called()

    @pytest.mark.anyio
    async def test_absent_groups_claim_returns_403(
        self, mint_token, mock_user_service
    ):
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(
                token=mint_token(groups=OMIT),
                user_service=mock_user_service,
            )

        assert exc_info.value.status_code == 403

    @pytest.mark.anyio
    async def test_admin_group_grants_admin(
        self, mint_token, mock_user_service
    ):
        await get_current_user(
            token=mint_token(groups=["Creative Studio PortalAdmins"]),
            user_service=mock_user_service,
        )

        _, kwargs = mock_user_service.create_or_sync_user.call_args
        assert kwargs["roles"] == ["admin"]

    @pytest.mark.anyio
    async def test_expired_token_returns_401(
        self, mint_token, mock_user_service
    ):
        now = int(time.time())
        token = mint_token(iat=now - 7200, exp=now - 3600)

        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(token=token, user_service=mock_user_service)

        assert exc_info.value.status_code == 401
        assert "expired" in exc_info.value.detail

    @pytest.mark.anyio
    async def test_wrong_audience_returns_401(
        self, mint_token, mock_user_service
    ):
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(
                token=mint_token(aud="0oaSomeOtherApp"),
                user_service=mock_user_service,
            )

        assert exc_info.value.status_code == 401
        assert "Invalid authentication token" in exc_info.value.detail

    @pytest.mark.anyio
    async def test_wrong_issuer_returns_401(
        self, mint_token, mock_user_service
    ):
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(
                token=mint_token(iss="https://attacker.okta.com"),
                user_service=mock_user_service,
            )

        assert exc_info.value.status_code == 401

    @pytest.mark.anyio
    async def test_bad_signature_returns_401(
        self, mint_token, mock_user_service
    ):
        attacker_key = rsa.generate_private_key(
            public_exponent=65537, key_size=2048
        )

        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(
                token=mint_token(key=attacker_key),
                user_service=mock_user_service,
            )

        assert exc_info.value.status_code == 401

    @pytest.mark.anyio
    async def test_missing_email_returns_403(
        self, mint_token, mock_user_service
    ):
        with pytest.raises(HTTPException) as exc_info:
            await get_current_user(
                token=mint_token(email=OMIT),
                user_service=mock_user_service,
            )

        assert exc_info.value.status_code == 403
        assert "User identity could not be confirmed" in exc_info.value.detail

    @pytest.mark.anyio
    async def test_hosted_domain_claim_is_not_consulted(
        self, mint_token, mock_user_service
    ):
        """A foreign `hd` must not matter: Okta assignment is the gate now."""
        user = await get_current_user(
            token=mint_token(hd="some-other-company.com"),
            user_service=mock_user_service,
        )

        assert user.email == "test@example.com"


class TestRoleChecker:
    """Tests for RoleChecker class."""

    def test_role_checker_authorized(self):
        checker = RoleChecker(allowed_roles=[UserRoleEnum.ADMIN])
        user = UserModel(
            id=1,
            email="admin@example.com",
            roles=["admin"],
            name="Admin User",
        )

        # Should not raise exception
        checker(user=user)

    def test_role_checker_forbidden(self):
        checker = RoleChecker(allowed_roles=[UserRoleEnum.ADMIN])
        user = UserModel(
            id=1,
            email="user@example.com",
            roles=["user"],
            name="Regular User",
        )

        with pytest.raises(HTTPException) as exc_info:
            checker(user=user)

        assert exc_info.value.status_code == 403
        assert "do not have sufficient permissions" in exc_info.value.detail
