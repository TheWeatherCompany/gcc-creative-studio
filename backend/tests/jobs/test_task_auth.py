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
"""Guards who may call the internal job endpoints.

The API service is publicly invocable (Firebase proxies to it without
credentials), so during the self-targeting stage this check is the only thing
between the internet and /internal/jobs/run.
"""

from unittest.mock import patch

import pytest
from fastapi import HTTPException
from google.auth import exceptions as google_auth_exceptions

from src.config.config_service import config_service
from src.jobs import task_auth
from src.jobs.task_auth import verify_task_token

INVOKER = "invoker@p.iam.gserviceaccount.com"
WORKER = "https://worker.example"


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(config_service, "JOB_TASKS_INVOKER_SA", INVOKER)
    monkeypatch.setattr(config_service, "JOB_WORKER_URL", WORKER)


def _verify_returns(claims=None, error=None):
    return patch.object(
        task_auth.id_token,
        "verify_oauth2_token",
        side_effect=error,
        return_value=claims,
    )


@pytest.mark.asyncio
async def test_invoker_token_passes_checked_against_worker_audience():
    with _verify_returns({"email": INVOKER, "email_verified": True}) as verify:
        await verify_task_token(authorization="Bearer good")
    assert verify.call_args.args[0] == "good"
    assert verify.call_args.args[2] == WORKER


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "authorization,claims,error,status",
    [
        (None, None, None, 401),
        ("Basic abc", None, None, 401),
        # google-auth raises MalformedError / InvalidValue (both ValueError)
        # for bad signatures, expiry and wrong audience.
        ("Bearer bad", None, ValueError("bad signature"), 401),
        # A wrong issuer is a bare GoogleAuthError, not a ValueError.
        (
            "Bearer t",
            None,
            google_auth_exceptions.GoogleAuthError("Wrong issuer."),
            401,
        ),
        # Google's cert endpoint unreachable: must neither pass nor 500.
        (
            "Bearer t",
            None,
            google_auth_exceptions.TransportError("certs unreachable"),
            503,
        ),
        (
            "Bearer t",
            {
                "email": "someone@p.iam.gserviceaccount.com",
                "email_verified": True,
            },
            None,
            403,
        ),
        ("Bearer t", {"email": INVOKER, "email_verified": False}, None, 403),
    ],
    ids=[
        "no header",
        "not bearer",
        "bad token",
        "wrong issuer",
        "cert fetch outage",
        "wrong identity",
        "unverified email",
    ],
)
async def test_other_callers_are_rejected(authorization, claims, error, status):
    with _verify_returns(claims, error):
        with pytest.raises(HTTPException) as exc_info:
            await verify_task_token(authorization=authorization)
    assert exc_info.value.status_code == status


@pytest.mark.asyncio
async def test_endpoints_are_closed_when_not_configured(monkeypatch):
    monkeypatch.setattr(config_service, "JOB_TASKS_INVOKER_SA", "")
    with _verify_returns({"email": "", "email_verified": True}):
        with pytest.raises(HTTPException) as exc_info:
            await verify_task_token(authorization="Bearer t")
    assert exc_info.value.status_code == 403
