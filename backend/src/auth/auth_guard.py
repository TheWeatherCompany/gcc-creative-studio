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
"""Authentication guards and user retrieval."""


import asyncio
import logging

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer

from src.auth import okta_verifier
from src.users.user_model import UserModel, UserRoleEnum
from src.users.user_service import UserService

# This scheme will require the client to send a token in the Authorization
# header. It tells FastAPI how to find the token but doesn't validate it
# itself.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")


logger = logging.getLogger(__name__)


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    user_service: UserService = Depends(UserService),
) -> UserModel:
    """Dependency that handles authentication and user provisioning.

    1. Verifies the Okta JWT.
    2. Extracts identity (email, name, picture) and the `groups` claim.
    3. Maps groups to application roles.
    4. Creates the user row on first sight, or syncs its roles if group
       membership has changed since the last request.
    5. Returns the user.

    Access is governed entirely by Okta app assignment and group
    membership. There is no email-domain check: a user who reaches this
    function has already been let through by Okta, and a user with no
    mapped group gets a 403 below.
    """
    try:
        decoded_token = await asyncio.to_thread(okta_verifier.verify, token)

        # Normalised once, here, so every lookup and insert downstream agrees
        # on a single spelling. Okta can hand back a different case to what is
        # already stored, and the unique index on users.email compares exact
        # strings, so two spellings of one address would become two people.
        raw_email = decoded_token.get("email")
        email = raw_email.strip().lower() if raw_email else None
        name = decoded_token.get("name") or ""
        picture = decoded_token.get("picture", "")
        groups = decoded_token.get("groups") or []

        if not email:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "Forbidden: User identity could not be confirmed from "
                    "token."
                ),
            )

        roles = okta_verifier.roles_from_groups(groups)

        # The backstop that replaces the old hosted-domain check. Reachable
        # when the Okta app is assigned to an individual directly instead of
        # through a group, which would otherwise silently grant the default
        # 'user' role.
        if not roles:
            logger.warning(
                "Rejecting %s: no role-conferring group in token groups %s",
                email,
                groups,
            )
            known = okta_verifier.mapped_group_names()
            groups_hint = (
                f" Access is granted through membership of: "
                f"{', '.join(known)}."
                if known
                else ""
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "You are not a member of an Okta group that grants access "
                    "to this application. Ask an administrator to add you."
                    + groups_hint
                ),
            )

        user_doc = await user_service.create_or_sync_user(
            email=email,
            name=name,
            picture=picture,
            roles=roles,
        )

        if not user_doc:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Could not create or retrieve user profile.",
            )

        return user_doc

    except jwt.ExpiredSignatureError as exc:
        logger.error("[get_current_user] Okta token expired.")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token has expired.",
        ) from exc
    except jwt.PyJWTError as exc:
        logger.error("[get_current_user] Invalid Okta token: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid authentication token: {exc}",
        ) from exc
    except HTTPException as e:
        logger.error("[get_current_user - Exception]: %s", e)
        raise e
    except Exception as e:
        # Deliberately says nothing. This path is reachable without
        # credentials, because Firebase Hosting proxies /api/** unauthenticated
        # and the service grants run.invoker to allUsers. The exceptions that
        # land here carry internals worth keeping out of a response body:
        # OktaConfigurationError names the unset settings, driver errors name
        # the database instance. The stack trace goes to the log instead.
        logger.exception(
            "[get_current_user] Unexpected authentication failure",
        )
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Authentication is temporarily unavailable.",
        ) from e


class RoleChecker:
    """Dependency that checks if the authenticated user has the required roles.
    It depends on `get_current_user` to ensure the user is authenticated first.
    """

    def __init__(self, allowed_roles: list[UserRoleEnum]):
        self.allowed_roles = allowed_roles

    def __call__(self, user: UserModel = Depends(get_current_user)):
        """Checks the user's roles against the allowed roles."""
        is_authorized = any(role in self.allowed_roles for role in user.roles)

        if not is_authorized:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "You do not have sufficient permissions to perform this "
                    "action."
                ),
            )
