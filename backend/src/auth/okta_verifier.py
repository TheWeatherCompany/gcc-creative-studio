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
"""Okta JWT verification.

Deliberately token-agnostic: this module validates whatever RS256 JWT
arrives against the configured issuer and audience. Phase 1 sends the ID
token because Okta API Access Management is not yet active in the tenant;
phase 2 sends an audience-scoped access token from a custom authorization
server. Both are verified by the exact same code, so the switch is a change
to OKTA_ISSUER / OKTA_AUDIENCE and nothing else.

No /introspect call is made. Introspection would add a network round trip
to every single API request, and signature plus iss/aud/exp checks are
sufficient for a stateless bearer token.
"""

import logging

import jwt
from jwt import PyJWKClient

from src.config.config_service import config_service

logger = logging.getLogger(__name__)

# Tolerance for clock skew between Okta and this service.
LEEWAY_SECONDS = 30

# Cache size for signing keys. PyJWKClient refetches the JWKS automatically
# when it sees a `kid` it does not know about, so key rotation needs no
# intervention here.
_JWKS_CACHE_KEYS = 16


class _VerifierState:
    """Holds the lazily-built JWKS client, keyed by the URI it was built for.

    Built lazily rather than at import time so that importing this module
    never performs network I/O, and so tests can change configuration
    between cases without a stale client hanging around.
    """

    def __init__(self) -> None:
        self.jwks_uri: str | None = None
        self.client: PyJWKClient | None = None

    def client_for(self, jwks_uri: str) -> PyJWKClient:
        if self.client is None or self.jwks_uri != jwks_uri:
            logger.info("Building Okta JWKS client for %s", jwks_uri)
            self.client = PyJWKClient(
                jwks_uri,
                cache_keys=True,
                max_cached_keys=_JWKS_CACHE_KEYS,
            )
            self.jwks_uri = jwks_uri
        return self.client

    def reset(self) -> None:
        """Drops the cached client. Used by tests."""
        self.client = None
        self.jwks_uri = None


_state = _VerifierState()


def reset_jwks_client() -> None:
    """Discards the cached JWKS client so the next verify() rebuilds it."""
    _state.reset()


class OktaConfigurationError(RuntimeError):
    """Raised when Okta verification is requested but not configured."""


def verify(token: str) -> dict:
    """Verifies an Okta-issued JWT and returns its claims.

    Checks the RS256 signature against the tenant JWKS, an exact issuer
    match, an exact audience match, and exp/iat with a small leeway.

    Raises:
        OktaConfigurationError: OKTA_ISSUER or OKTA_AUDIENCE is unset.
        jwt.PyJWTError: The token is invalid for any reason (bad signature,
            expired, wrong audience, wrong issuer, malformed).

    """
    issuer = config_service.OKTA_ISSUER.rstrip("/")
    audience = config_service.OKTA_AUDIENCE

    if not issuer or not audience:
        raise OktaConfigurationError(
            "Okta verification requires both OKTA_ISSUER and OKTA_AUDIENCE "
            "to be set.",
        )

    jwks_client = _state.client_for(config_service.OKTA_JWKS_URI)
    signing_key = jwks_client.get_signing_key_from_jwt(token)

    claims = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        audience=audience,
        issuer=issuer,
        leeway=LEEWAY_SECONDS,
        options={
            "require": ["exp", "iat", "iss", "aud"],
            "verify_signature": True,
            "verify_exp": True,
            "verify_iat": True,
            "verify_iss": True,
            "verify_aud": True,
        },
    )

    # Optional defence in depth: when OKTA_CLIENT_ID is set and the token
    # carries a `cid` claim, it must match. Okta access tokens carry `cid`;
    # ID tokens do not, so a missing claim is not an error.
    expected_cid = config_service.OKTA_CLIENT_ID
    if expected_cid:
        token_cid = claims.get("cid")
        if token_cid is not None and token_cid != expected_cid:
            raise jwt.InvalidTokenError(
                f"Token client id '{token_cid}' does not match the expected "
                "Okta client id.",
            )

    return claims


def validate_configuration() -> None:
    """Fails fast when the Okta settings cannot serve a single request.

    Called once at startup. Everything it touches is otherwise evaluated
    lazily per request, so without this a typo in OKTA_GROUP_ROLE_MAP (which
    is hand-written JSON inside a .tfvars string) surfaces only as a 500 on
    every authenticated call, with nothing at deploy time pointing at the
    cause. Raising here means Cloud Run refuses to shift traffic to the
    broken revision, which is the failure mode you want.

    Raises:
        OktaConfigurationError: A required setting is missing, or
            OKTA_GROUP_ROLE_MAP does not parse into group -> roles, or it
            parses to nothing and would 403 every user.

    """
    missing = [
        name
        for name in ("OKTA_ISSUER", "OKTA_AUDIENCE")
        if not getattr(config_service, name, "").strip()
    ]
    if missing:
        raise OktaConfigurationError(
            f"Okta verification requires {' and '.join(missing)} to be set.",
        )

    try:
        # json.JSONDecodeError subclasses ValueError, so this covers both a
        # malformed document and a well-formed one of the wrong shape.
        role_map = config_service.OKTA_GROUP_ROLE_MAP
    except (TypeError, ValueError) as exc:
        raise OktaConfigurationError(
            f"OKTA_GROUP_ROLE_MAP could not be parsed: {exc}",
        ) from exc

    if not role_map:
        raise OktaConfigurationError(
            "OKTA_GROUP_ROLE_MAP is empty, so no Okta group confers a role "
            "and every user would be rejected with a 403.",
        )

    logger.info(
        "Okta configuration valid: issuer=%s, groups mapped to roles: %s",
        config_service.OKTA_ISSUER,
        ", ".join(sorted(role_map)),
    )


def mapped_group_names() -> list[str]:
    """The Okta groups that confer a role, for user-facing messages.

    Derived from configuration rather than hardcoded so the application does
    not carry any particular tenant's group names.
    """
    return sorted(config_service.OKTA_GROUP_ROLE_MAP)


def roles_from_groups(groups: list[str]) -> list[str]:
    """Maps Okta group names to application role strings.

    Order and duplicates in the group claim are irrelevant; the result is
    sorted so that comparing it against what is stored in Postgres is a
    stable equality check.
    """
    role_map = config_service.OKTA_GROUP_ROLE_MAP
    roles = {
        role
        for group in groups
        if group in role_map
        for role in role_map[group]
    }
    return sorted(roles)
