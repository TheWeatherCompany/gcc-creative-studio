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

"""Verifies the OIDC tokens Cloud Tasks and Cloud Scheduler attach.

Both sign as JOB_TASKS_INVOKER_SA with JOB_WORKER_URL as the audience. On the
worker, Cloud Run's invoker IAM already checks this; on the public API service
(self-targeting stage) nothing else does, so the check lives here for both.
"""

import asyncio
import logging

from fastapi import Header, HTTPException, status
from google.auth import exceptions as google_auth_exceptions
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from src.config.config_service import config_service

logger = logging.getLogger(__name__)

# Building this only opens a requests.Session; no network I/O at import.
_transport = google_requests.Request()


async def verify_task_token(
    authorization: str | None = Header(default=None),
) -> None:
    """FastAPI dependency: passes only tokens from the job invoker."""
    expected_sa = config_service.JOB_TASKS_INVOKER_SA
    audience = config_service.JOB_WORKER_URL
    if not expected_sa or not audience:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Internal job endpoints are disabled.",
        )

    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token.",
        )

    try:
        claims = await asyncio.to_thread(
            id_token.verify_oauth2_token, token, _transport, audience
        )
    except google_auth_exceptions.TransportError as e:
        # Google's signing certs could not be fetched. Not the caller's fault,
        # so not a 401, but the token is unverified, so it must not pass.
        # Cloud Tasks retries on a 503.
        logger.error("[verify_task_token] Could not fetch Google certs: %s", e)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Token verification is temporarily unavailable.",
        ) from e
    except (ValueError, google_auth_exceptions.GoogleAuthError) as e:
        # ValueError covers bad signature, expiry and wrong audience; a wrong
        # issuer is a bare GoogleAuthError.
        logger.warning("[verify_task_token] Rejected token: %s", e)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token.",
        ) from e

    if claims.get("email") != expected_sa or not claims.get("email_verified"):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token is not from the job invoker.",
        )
