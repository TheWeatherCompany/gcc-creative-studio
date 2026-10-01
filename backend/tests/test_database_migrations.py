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
"""Tests for the first connection made before startup migrations."""


from unittest.mock import AsyncMock, patch

import asyncpg
import pytest

from src import database_migrations


@pytest.mark.anyio
async def test_first_connection_rides_out_network_not_ready():
    # Direct VPC egress can drop the first connections of a new instance.
    get_connection = AsyncMock(
        side_effect=[TimeoutError(), ConnectionRefusedError(), "conn"]
    )
    with (
        patch.object(database_migrations, "get_connection", get_connection),
        patch.object(database_migrations.asyncio, "sleep", AsyncMock()),
    ):
        assert await database_migrations.first_connection() == "conn"
    assert get_connection.await_count == 3


@pytest.mark.anyio
async def test_first_connection_gives_up_after_deadline():
    get_connection = AsyncMock(side_effect=TimeoutError())
    with (
        patch.object(database_migrations, "get_connection", get_connection),
        patch.object(database_migrations, "FIRST_CONNECT_DEADLINE_SECONDS", 0),
        patch.object(database_migrations.asyncio, "sleep", AsyncMock()),
    ):
        with pytest.raises(TimeoutError):
            await database_migrations.first_connection()
    assert get_connection.await_count == 1


@pytest.mark.anyio
async def test_first_connection_does_not_retry_auth_failure():
    get_connection = AsyncMock(
        side_effect=asyncpg.InvalidPasswordError("bad password")
    )
    with (
        patch.object(database_migrations, "get_connection", get_connection),
        patch.object(database_migrations.asyncio, "sleep", AsyncMock()),
    ):
        with pytest.raises(asyncpg.InvalidPasswordError):
            await database_migrations.first_connection()
    assert get_connection.await_count == 1
