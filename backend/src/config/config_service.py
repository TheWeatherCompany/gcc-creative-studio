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

import json
from typing import Any

import google.auth
from google.auth.exceptions import DefaultCredentialsError
from pydantic import Field, computed_field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ConfigService(BaseSettings):
    """Manages application configuration using Pydantic.
    It automatically reads from environment variables, provides type safety,
    and fails fast if critical settings are missing.
    """

    # This tells Pydantic to look for a .env file for local development.
    # In production (e.g., Cloud Run), where this file doesn't exist,
    # Pydantic will automatically and correctly fall back to using
    # system environment variables.
    # The path is relative to this file's location (src/config/).
    model_config = SettingsConfigDict(
        case_sensitive=True,
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # --- Core Project Settings ---
    PROJECT_ID: str = ""
    LOCATION: str = "global"
    ENVIRONMENT: str = "development"
    FRONTEND_URL: str = "http://localhost:4200"
    BACKEND_URL: str = "http://localhost:8080"
    LOG_LEVEL: str = "INFO"
    INIT_VERTEX: bool = True

    # --- Generation Concurrency ---
    # Size of the shared ThreadPoolExecutor that runs blocking generation work
    # (Veo, Imagen, etc.). The true ceiling is NOT this number: it is the
    # Vertex Veo per-project/region online-prediction quota. Raising this beyond
    # ~4 only helps if there is confirmed quota headroom, otherwise the extra
    # workers just queue against the same quota and fail. Override via the
    # GENERATION_MAX_WORKERS env var (e.g. on Cloud Run) after a quota check.
    GENERATION_MAX_WORKERS: int = 4

    # --- Okta ---
    # Phase 1 (no API Access Management): the org authorization server, e.g.
    # "https://your-org.okta.com", with the SPA client ID as the audience.
    # Phase 2: a custom authorization server, e.g.
    # "https://your-org.okta.com/oauth2/creative-studio" with audience
    # "api://creative-studio". Nothing but these two values changes.
    OKTA_ISSUER: str = ""
    OKTA_AUDIENCE: str = ""
    # Optional. When set, a `cid` claim present on the token must match.
    OKTA_CLIENT_ID: str = ""
    # Optional override. Leave unset and OKTA_JWKS_URI derives the correct
    # endpoint for either issuer shape.
    OKTA_JWKS_URI_OVERRIDE: str = ""
    # JSON object mapping Okta group name -> application role. The value may
    # be a single role or a list, for a group that should confer several, e.g.
    # {"<your admin group>": "admin",
    #  "<your user group>": "user",
    #  "<your workflow group>": ["user", "workflows"]}
    OKTA_GROUP_ROLE_MAP_STR: str = Field(
        default="", alias="OKTA_GROUP_ROLE_MAP"
    )

    # --- Storage ---
    # The defaults will be set in the validator below to prevent recursion.
    GENMEDIA_BUCKET: str = ""

    # --- Gemini ---
    GEMINI_MODEL_ID: str = "gemini-2.5-pro"
    GEMINI_AUDIO_ANALYSIS_MODEL_ID: str = "gemini-2.5-pro"

    # --- Database Configuration ---
    INSTANCE_CONNECTION_NAME: str = ""
    DB_USER: str = "postgres"
    DB_PASS: str = "password"
    DB_NAME: str = "creative_studio"
    USE_CLOUD_SQL_AUTH_PROXY: bool = False
    DB_HOST: str = "localhost"
    DB_PORT: str = "5432"

    # --- Veo ---
    VEO_MODEL_ID: str = "veo-3.1-generate-001"

    # --- VTO ---
    VTO_MODEL_ID: str = "virtual-try-on-001"

    # --- Lyria ---
    LYRIA_MODEL_VERSION: str = "lyria-002"
    LYRIA_PROJECT_ID: str = ""

    # --- Imagen ---
    MODEL_IMAGEN_PRODUCT_RECONTEXT: str = (
        "imagen-product-recontext-preview-06-30"
    )
    IMAGEN_GENERATED_SUBFOLDER: str = "generated_images"
    IMAGEN_EDITED_SUBFOLDER: str = "edited_images"
    IMAGEN_RECONTEXT_SUBFOLDER: str = "recontext_images"

    # --- Email Service ---
    SENDER_EMAIL: str = (
        ""  # The email address to send from (e.g., no-reply@your-domain.com)
    )
    ADMIN_USER_EMAIL: str = "system"

    # --- Workflows ---
    WORKFLOWS_LOCATION: str = "us-central1"
    WORKFLOWS_EXECUTOR_URL: str = (
        "http://localhost:8080"  # This service could be deployed alone in the future
    )
    BACKEND_SERVICE_ACCOUNT_EMAIL: str = ""

    @model_validator(mode="before")
    @classmethod
    def get_default_project_id(cls, values: Any) -> Any:
        """Sets the default PROJECT_ID from ADC if not provided in the environment."""
        if not values.get("PROJECT_ID"):
            try:
                _, project_id = google.auth.default()
                if project_id:
                    values["PROJECT_ID"] = project_id
            except DefaultCredentialsError:
                pass  # Fail gracefully, let required fields catch this if needed.
        return values

    @field_validator("ENVIRONMENT", mode="before")
    @classmethod
    def default_environment_if_empty(cls, v: Any) -> Any:
        """Sets ENVIRONMENT to default 'development' if empty or whitespace."""
        if v is None or not str(v).strip():
            return "development"
        return str(v).strip()

    # <<< FIX 2: New validator to handle dependent default values >>>
    @model_validator(mode="after")
    def set_dependent_defaults(self) -> "ConfigService":
        """Sets default values for fields that depend on other fields (like PROJECT_ID),
        after the initial values have been loaded and validated.
        """
        if not self.PROJECT_ID:
            raise ValueError(
                "PROJECT_ID could not be determined. Please set it via environment variable.",
            )

        # If these fields were not set by environment variables, set their default now.
        if not self.GENMEDIA_BUCKET:
            self.GENMEDIA_BUCKET = f"{self.PROJECT_ID}-assets"

        return self

    @computed_field
    @property
    def OKTA_JWKS_URI(self) -> str:
        """The JWKS endpoint for the configured issuer.

        The two Okta issuer shapes put the keys in different places. The org
        authorization server ("https://your-org.okta.com") serves them from
        /oauth2/v1/keys, while a custom authorization server
        ("https://your-org.okta.com/oauth2/creative-studio") serves them from
        <issuer>/v1/keys. Deriving this rather than hardcoding it is what
        keeps the phase 2 cutover to a pair of config values.
        """
        if self.OKTA_JWKS_URI_OVERRIDE:
            return self.OKTA_JWKS_URI_OVERRIDE

        issuer = self.OKTA_ISSUER.rstrip("/")
        if not issuer:
            return ""
        if "/oauth2/" in issuer:
            return f"{issuer}/v1/keys"
        return f"{issuer}/oauth2/v1/keys"

    @computed_field
    @property
    def OKTA_GROUP_ROLE_MAP(self) -> dict[str, list[str]]:
        """Parsed group-to-role mapping.

        A malformed value is a deployment error, not something to paper over
        at request time, so this raises rather than silently returning {} and
        locking every user out with an empty role set.

        Each value may be a single role or a list of roles. Some roles gate
        only a narrow set of routes, so a group meant for people who also need
        ordinary access has to confer more than one.
        """
        raw = self.OKTA_GROUP_ROLE_MAP_STR.strip()
        if not raw:
            return {}

        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError(
                "OKTA_GROUP_ROLE_MAP must be a JSON object mapping group "
                "name to a role or list of roles.",
            )

        mapping: dict[str, list[str]] = {}
        for group, value in parsed.items():
            if isinstance(value, str):
                roles = [value]
            elif isinstance(value, list):
                roles = [str(role) for role in value]
            else:
                raise ValueError(
                    f"OKTA_GROUP_ROLE_MAP value for {group!r} must be a role "
                    "name or a list of role names.",
                )
            mapping[str(group)] = roles
        return mapping

    @computed_field
    @property
    def VIDEO_BUCKET(self) -> str:
        return f"{self.GENMEDIA_BUCKET}/videos"

    @computed_field
    @property
    def IMAGE_BUCKET(self) -> str:
        return f"{self.GENMEDIA_BUCKET}/images"


# Create a single, cached instance of the settings to be used throughout the app.
config_service = ConfigService()
