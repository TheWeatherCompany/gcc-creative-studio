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

import json
import time
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException
from google.auth import crypt, jwt
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


# The clock skew tests below sign a real token, so google-auth's own iat
# check runs instead of a mock.
KEY_ID = "test-key"


@pytest.fixture(name="sign_token", scope="module")
def fixture_sign_token():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_key = key.public_key()
    public_pem = public_key.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    signer = crypt.RSASigner.from_string(private_pem, key_id=KEY_ID)

    def sign(issued_in_seconds: int) -> str:
        issued_at = int(time.time()) + issued_in_seconds
        claims = {
            "iss": "https://accounts.google.com",
            "aud": WORKER,
            "email": INVOKER,
            "email_verified": True,
            "iat": issued_at,
            "exp": issued_at + 3600,
        }
        return jwt.encode(signer, claims).decode()

    return sign, public_pem


@pytest.fixture(name="early_token")
def fixture_early_token(monkeypatch, sign_token):
    """A token issued 5s ahead of this machine's clock, as seen from an
    instance whose clock lags Google's. The transport serves the test key
    where google-auth fetches Google's signing certs."""
    sign, public_pem = sign_token
    certs = json.dumps({KEY_ID: public_pem}).encode()
    monkeypatch.setattr(
        task_auth,
        "_transport",
        lambda url, method="GET", **_: SimpleNamespace(
            status=200, headers={}, data=certs
        ),
    )
    return sign(issued_in_seconds=5)


@pytest.mark.asyncio
async def test_a_token_from_a_clock_slightly_ahead_is_accepted(early_token):
    # A 401 here would spend the job's one Cloud Tasks retry.
    await verify_task_token(authorization=f"Bearer {early_token}")


@pytest.mark.asyncio
async def test_the_same_token_is_rejected_without_the_tolerance(
    monkeypatch, early_token
):
    monkeypatch.setattr(task_auth, "CLOCK_SKEW_SECONDS", 0)
    with pytest.raises(HTTPException) as exc_info:
        await verify_task_token(authorization=f"Bearer {early_token}")
    assert exc_info.value.status_code == 401
