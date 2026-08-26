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
"""Test keypair and JWKS stubbing for the Okta verifier.

These fixtures mint genuine RS256 tokens and stub only the network fetch of
the JWKS document. Everything downstream of that (signature verification,
iss/aud/exp checks) is the real implementation, so a test failure means the
verifier is wrong rather than that a mock drifted.
"""

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from src.auth import okta_verifier
from src.config.config_service import config_service

TEST_ISSUER = "https://weather.okta.com"
TEST_AUDIENCE = "0oaTestClientId123"
TEST_KID = "test-signing-key"

# Sentinel letting a test drop a default claim entirely. A plain string
# rather than an object identity check, because pytest can load this
# conftest under a different module name than an explicit import of it,
# which would give the test and the fixture two distinct sentinels.
OMIT = "__OMIT_CLAIM__"


@pytest.fixture(name="rsa_keypair", scope="session")
def fixture_rsa_keypair():
    """A single RSA keypair reused across the module; generation is slow."""
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private_key


@pytest.fixture(name="jwks_document")
def fixture_jwks_document(rsa_keypair):
    """The JWKS document a stubbed Okta tenant would serve."""
    public_jwk = jwt.algorithms.RSAAlgorithm.to_jwk(
        rsa_keypair.public_key(), as_dict=True
    )
    public_jwk.update({"kid": TEST_KID, "use": "sig", "alg": "RS256"})
    return {"keys": [public_jwk]}


@pytest.fixture(name="okta_config", autouse=True)
def fixture_okta_config():
    """Points config at the test issuer and restores it afterwards."""
    original = (
        config_service.OKTA_ISSUER,
        config_service.OKTA_AUDIENCE,
        config_service.OKTA_CLIENT_ID,
        config_service.OKTA_GROUP_ROLE_MAP_STR,
        config_service.ENVIRONMENT,
    )

    config_service.OKTA_ISSUER = TEST_ISSUER
    config_service.OKTA_AUDIENCE = TEST_AUDIENCE
    config_service.OKTA_CLIENT_ID = ""
    config_service.OKTA_GROUP_ROLE_MAP_STR = (
        '{"Creative Studio PortalAdmins": "admin", '
        '"Creative Studio Users": "user", '
        '"Creative Studio Workflows": "workflows"}'
    )

    yield

    (
        config_service.OKTA_ISSUER,
        config_service.OKTA_AUDIENCE,
        config_service.OKTA_CLIENT_ID,
        config_service.OKTA_GROUP_ROLE_MAP_STR,
        config_service.ENVIRONMENT,
    ) = original
    okta_verifier.reset_jwks_client()


@pytest.fixture(name="stub_jwks", autouse=True)
def fixture_stub_jwks(monkeypatch, jwks_document):
    """Serves the test JWKS instead of hitting the network."""
    okta_verifier.reset_jwks_client()
    monkeypatch.setattr(
        "jwt.jwks_client.PyJWKClient.fetch_data",
        lambda self: jwks_document,
    )
    yield
    okta_verifier.reset_jwks_client()


@pytest.fixture(name="mint_token")
def fixture_mint_token(rsa_keypair):
    """Mints a signed RS256 token, with per-test claim overrides."""

    def _mint(
        key=None,
        kid: str = TEST_KID,
        **claim_overrides,
    ) -> str:
        now = int(time.time())
        claims = {
            "iss": TEST_ISSUER,
            "aud": TEST_AUDIENCE,
            "iat": now,
            "exp": now + 3600,
            "sub": "00uTestUser",
            "email": "test@example.com",
            "name": "Test User",
            "picture": "http://example.com/pic.jpg",
            "groups": ["Creative Studio Users"],
        }
        claims.update(claim_overrides)
        claims = {k: v for k, v in claims.items() if v != OMIT}
        return jwt.encode(
            claims,
            key or rsa_keypair,
            algorithm="RS256",
            headers={"kid": kid},
        )

    return _mint
