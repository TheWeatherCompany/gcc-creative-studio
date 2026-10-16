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
"""Tests for the Cloud SQL connection that alembic/env.py opens."""


import runpy
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from google.cloud.sql.connector import IPTypes

from src.config.config_service import config_service

ENV_PY = Path(__file__).resolve().parent.parent / "alembic" / "env.py"


def _load_env_py():
    """Executes env.py in offline mode against a stand-in alembic context, so
    nothing connects or migrates, and returns its module globals."""
    context = MagicMock()
    context.config.config_file_name = None
    context.is_offline_mode.return_value = True
    with patch("alembic.context", context):
        return runpy.run_path(str(ENV_PY))


@pytest.mark.anyio
async def test_alembic_connection_dials_configured_ip_type():
    # `alembic upgrade head` runs on every startup; if it dials PUBLIC after
    # the public IP is removed, migrations fail and the revision never starts.
    connector = MagicMock()
    connector.connect_async = AsyncMock(return_value="alembic_conn")
    with (
        patch("google.cloud.sql.connector.Connector", return_value=connector),
        patch.object(config_service, "INSTANCE_CONNECTION_NAME", "p:r:i"),
        patch.object(config_service, "DB_IP_TYPE", "PRIVATE"),
    ):
        env = _load_env_py()
        assert await env["alembic_get_connection"]() == "alembic_conn"

    assert (
        connector.connect_async.call_args.kwargs["ip_type"] is IPTypes.PRIVATE
    )
