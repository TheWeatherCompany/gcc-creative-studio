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
"""Tests for the Okta JWT verifier."""

import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from src.auth import okta_verifier
from src.auth.okta_verifier import OktaConfigurationError
from src.config.config_service import config_service
from tests.auth.conftest import (
    GROUP_ADMIN,
    GROUP_MULTI_ROLE,
    GROUP_UNMAPPED,
    GROUP_USER,
    OMIT,
    TEST_AUDIENCE,
    TEST_ISSUER,
)


class TestVerify:
    """Signature, issuer, audience and lifetime checks."""

    def test_valid_token_returns_claims(self, mint_token):
        claims = okta_verifier.verify(mint_token())

        assert claims["email"] == "test@example.com"
        assert claims["iss"] == TEST_ISSUER
        assert claims["aud"] == TEST_AUDIENCE
        assert claims["groups"] == [GROUP_USER]

    def test_expired_token_is_rejected(self, mint_token):
        now = int(time.time())
        token = mint_token(iat=now - 7200, exp=now - 3600)

        with pytest.raises(jwt.ExpiredSignatureError):
            okta_verifier.verify(token)

    def test_wrong_audience_is_rejected(self, mint_token):
        token = mint_token(aud="0oaSomeOtherApp")

        with pytest.raises(jwt.InvalidAudienceError):
            okta_verifier.verify(token)

    def test_wrong_issuer_is_rejected(self, mint_token):
        token = mint_token(iss="https://attacker.okta.com")

        with pytest.raises(jwt.InvalidIssuerError):
            okta_verifier.verify(token)

    def test_token_signed_by_another_key_is_rejected(self, mint_token):
        """A token whose `kid` matches but whose signature does not.

        This is the case a naive implementation gets wrong by trusting the
        header, so it is worth asserting explicitly.
        """
        attacker_key = rsa.generate_private_key(
            public_exponent=65537, key_size=2048
        )
        token = mint_token(key=attacker_key)

        with pytest.raises(jwt.InvalidSignatureError):
            okta_verifier.verify(token)

    def test_unknown_kid_is_rejected(self, mint_token):
        token = mint_token(kid="a-key-that-was-never-published")

        with pytest.raises(jwt.PyJWKClientError):
            okta_verifier.verify(token)

    def test_missing_exp_is_rejected(self, mint_token):
        token = mint_token(exp=OMIT)

        with pytest.raises(jwt.MissingRequiredClaimError):
            okta_verifier.verify(token)

    def test_clock_skew_within_leeway_is_accepted(self, mint_token):
        """A token that expired one second ago still verifies.

        Okta and Cloud Run clocks are not identical; without leeway this
        produces intermittent 401s at the top of every hour.
        """
        now = int(time.time())
        token = mint_token(iat=now - 3601, exp=now - 1)

        assert okta_verifier.verify(token)["email"] == "test@example.com"

    def test_unconfigured_issuer_raises_configuration_error(self, mint_token):
        token = mint_token()
        config_service.OKTA_ISSUER = ""

        with pytest.raises(OktaConfigurationError):
            okta_verifier.verify(token)

    def test_unconfigured_audience_raises_configuration_error(self, mint_token):
        token = mint_token()
        config_service.OKTA_AUDIENCE = ""

        with pytest.raises(OktaConfigurationError):
            okta_verifier.verify(token)


class TestClientIdCheck:
    """The optional `cid` cross-check."""

    def test_matching_cid_is_accepted(self, mint_token):
        config_service.OKTA_CLIENT_ID = TEST_AUDIENCE
        token = mint_token(cid=TEST_AUDIENCE)

        assert okta_verifier.verify(token)["cid"] == TEST_AUDIENCE

    def test_mismatched_cid_is_rejected(self, mint_token):
        config_service.OKTA_CLIENT_ID = TEST_AUDIENCE
        token = mint_token(cid="0oaSomeOtherClient")

        with pytest.raises(jwt.InvalidTokenError):
            okta_verifier.verify(token)

    def test_absent_cid_is_accepted(self, mint_token):
        """ID tokens carry no `cid`, so its absence must not be fatal."""
        config_service.OKTA_CLIENT_ID = TEST_AUDIENCE

        assert okta_verifier.verify(mint_token())["email"]


class TestRolesFromGroups:
    """Group claim to application role mapping."""

    def test_maps_known_groups(self):
        assert okta_verifier.roles_from_groups([GROUP_ADMIN]) == ["admin"]

    def test_a_group_may_confer_several_roles(self):
        """Some roles gate only a narrow set of routes, so a group intended for
        people who also need ordinary access maps to a list.
        """
        assert okta_verifier.roles_from_groups([GROUP_MULTI_ROLE]) == [
            "user",
            "workflows",
        ]

    def test_group_outside_the_map_confers_nothing(self):
        """A tenant may put groups in the claim that are not application roles,
        for example an approvals group. Those must never grant access.
        """
        assert okta_verifier.roles_from_groups([GROUP_UNMAPPED]) == []

    def test_maps_multiple_groups_sorted_and_deduplicated(self):
        roles = okta_verifier.roles_from_groups(
            [GROUP_ADMIN, GROUP_USER, GROUP_USER],
        )

        assert roles == ["admin", "user"]

    def test_overlapping_groups_do_not_duplicate_roles(self):
        """GROUP_MULTI_ROLE and GROUP_USER both confer "user"."""
        roles = okta_verifier.roles_from_groups([GROUP_MULTI_ROLE, GROUP_USER])

        assert roles == ["user", "workflows"]

    def test_ignores_unmapped_groups(self):
        roles = okta_verifier.roles_from_groups(
            [GROUP_USER, GROUP_UNMAPPED],
        )

        assert roles == ["user"]

    def test_empty_groups_yields_no_roles(self):
        assert okta_verifier.roles_from_groups([]) == []

    def test_only_unknown_groups_yields_no_roles(self):
        """The case that must end in a 403 rather than a default role."""
        assert okta_verifier.roles_from_groups(["Marketing Team"]) == []


class TestJwksUriDerivation:
    """Phase 1 and phase 2 issuers put the keys in different places."""

    def test_org_authorization_server(self):
        config_service.OKTA_ISSUER = "https://your-org.okta.com"

        assert (
            config_service.OKTA_JWKS_URI
            == "https://your-org.okta.com/oauth2/v1/keys"
        )

    def test_trailing_slash_is_tolerated(self):
        config_service.OKTA_ISSUER = "https://your-org.okta.com/"

        assert (
            config_service.OKTA_JWKS_URI
            == "https://your-org.okta.com/oauth2/v1/keys"
        )

    def test_custom_authorization_server(self):
        config_service.OKTA_ISSUER = (
            "https://your-org.okta.com/oauth2/creative-studio"
        )

        assert config_service.OKTA_JWKS_URI == (
            "https://your-org.okta.com/oauth2/creative-studio/v1/keys"
        )

    def test_explicit_override_wins(self):
        config_service.OKTA_JWKS_URI_OVERRIDE = "https://example.test/keys"
        try:
            assert config_service.OKTA_JWKS_URI == "https://example.test/keys"
        finally:
            config_service.OKTA_JWKS_URI_OVERRIDE = ""


class TestGroupRoleMapParsing:
    """OKTA_GROUP_ROLE_MAP is JSON in an environment variable."""

    def test_empty_string_is_an_empty_map(self):
        config_service.OKTA_GROUP_ROLE_MAP_STR = ""

        assert config_service.OKTA_GROUP_ROLE_MAP == {}

    def test_malformed_json_raises(self):
        config_service.OKTA_GROUP_ROLE_MAP_STR = "{not json"

        with pytest.raises(ValueError):
            _ = config_service.OKTA_GROUP_ROLE_MAP

    def test_non_object_json_raises(self):
        config_service.OKTA_GROUP_ROLE_MAP_STR = '["admin"]'

        with pytest.raises(ValueError):
            _ = config_service.OKTA_GROUP_ROLE_MAP


class TestValidateConfiguration:
    """Startup validation.

    The point of these is that a bad deploy never receives traffic. Every
    value checked here is otherwise read lazily per request, so the failure
    would otherwise be a 500 on every authenticated call.
    """

    def test_a_good_configuration_passes(self):
        okta_verifier.validate_configuration()

    def test_missing_issuer_is_rejected(self):
        config_service.OKTA_ISSUER = ""

        with pytest.raises(okta_verifier.OktaConfigurationError) as exc_info:
            okta_verifier.validate_configuration()

        assert "OKTA_ISSUER" in str(exc_info.value)

    def test_missing_audience_is_rejected(self):
        config_service.OKTA_AUDIENCE = ""

        with pytest.raises(okta_verifier.OktaConfigurationError) as exc_info:
            okta_verifier.validate_configuration()

        assert "OKTA_AUDIENCE" in str(exc_info.value)

    def test_whitespace_only_issuer_is_rejected(self):
        config_service.OKTA_ISSUER = "   "

        with pytest.raises(okta_verifier.OktaConfigurationError):
            okta_verifier.validate_configuration()

    def test_malformed_group_map_is_rejected_as_a_config_error(self):
        """The .tfvars value is hand-written JSON inside a string."""
        config_service.OKTA_GROUP_ROLE_MAP_STR = '{"Group": "user",}'

        with pytest.raises(okta_verifier.OktaConfigurationError) as exc_info:
            okta_verifier.validate_configuration()

        assert "OKTA_GROUP_ROLE_MAP" in str(exc_info.value)

    def test_group_map_of_the_wrong_shape_is_rejected(self):
        config_service.OKTA_GROUP_ROLE_MAP_STR = '["Group A", "Group B"]'

        with pytest.raises(okta_verifier.OktaConfigurationError):
            okta_verifier.validate_configuration()

    def test_group_map_with_a_bad_value_is_rejected(self):
        config_service.OKTA_GROUP_ROLE_MAP_STR = '{"Group": 42}'

        with pytest.raises(okta_verifier.OktaConfigurationError):
            okta_verifier.validate_configuration()

    def test_an_empty_group_map_is_rejected(self):
        """Empty parses fine but would 403 every single user."""
        config_service.OKTA_GROUP_ROLE_MAP_STR = ""

        with pytest.raises(okta_verifier.OktaConfigurationError) as exc_info:
            okta_verifier.validate_configuration()

        assert "403" in str(exc_info.value)
