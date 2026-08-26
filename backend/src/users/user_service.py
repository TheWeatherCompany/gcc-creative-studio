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


import logging
from typing import Any

from fastapi import Depends

from src.common.dto.pagination_response_dto import PaginationResponseDto
from src.users.dto.user_create_dto import UserCreateDto
from src.users.dto.user_search_dto import UserSearchDto
from src.users.repository.user_repository import UserRepository
from src.users.user_model import UserModel

logger = logging.getLogger(__name__)


class UserService:
    """Handles the business logic for user management."""

    def __init__(self, user_repo: UserRepository = Depends()):
        self.user_repo = user_repo

    async def create_or_sync_user(
        self,
        email: str,
        name: str,
        picture: str | None,
        roles: list[str],
    ) -> UserModel:
        """Provisions the user on first sight, or reconciles their roles.

        Okta group membership is authoritative for roles, so they are
        reconciled from the token rather than read from the row. Users are
        keyed on email, which is what Okta's userNameTemplate resolves to in
        this org, so rows predating the migration are matched, not duplicated.

        This runs on every authenticated request across every controller, so
        it only issues an UPDATE when something actually differs. A naive
        reconcile here would cost one write per API call.
        """
        existing_user = await self.user_repo.get_by_email(email)

        if not existing_user:
            new_user_dto = UserCreateDto(
                email=email,
                # UserCreateDto requires at least two characters. An Okta
                # profile with no displayName would otherwise fail validation
                # and surface as a 500 on the user's very first request.
                name=name if len(name) >= 2 else email.split("@")[0],
                picture=picture or "",
            )
            user_data = new_user_dto.model_dump()
            user_data["roles"] = list(roles)
            return await self.user_repo.create(user_data)

        changes: dict[str, Any] = {}

        # UserModel is configured with use_enum_values, so roles come back as
        # plain strings; getattr keeps this correct either way.
        current_roles = sorted(
            getattr(role, "value", role) for role in existing_user.roles
        )
        if current_roles != sorted(roles):
            changes["roles"] = list(roles)

        # Name and picture come from the identity provider too, but they are
        # cosmetic: only fill them in, never blank out a stored value with an
        # empty claim.
        if name and existing_user.name != name:
            changes["name"] = name
        if picture and existing_user.picture != picture:
            changes["picture"] = picture

        if not changes:
            return existing_user

        logger.info(
            "Syncing user %s from Okta claims: %s",
            email,
            sorted(changes.keys()),
        )
        updated = await self.user_repo.update(existing_user.id, changes)
        return updated or existing_user

    async def get_user_by_id(self, user_id: int) -> UserModel | None:
        """Finds a single user by their ID."""
        return await self.user_repo.get_by_id(user_id)

    async def find_all_users(
        self,
        search_dto: UserSearchDto,
    ) -> PaginationResponseDto[UserModel]:
        """Retrieves a paginated list of all users."""
        return await self.user_repo.query(search_dto)

    async def delete_user(
        self, user_id: int, deleted_by: int | None = None
    ) -> bool:
        """Soft deletes a user."""
        return await self.user_repo.soft_delete(user_id, deleted_by=deleted_by)

    async def restore_user(self, user_id: int) -> bool:
        """Restores a soft-deleted user."""
        return await self.user_repo.restore(user_id)
