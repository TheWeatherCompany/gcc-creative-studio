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


from unittest.mock import AsyncMock, MagicMock, Mock, patch

import asyncpg
import pytest

from src import database_migrations

# conftest swaps run_pending_migrations for a mock for the whole session so the
# app's lifespan skips it. This import runs at collection, before that patch.
from src.database_migrations import (
    run_pending_migrations as real_run_pending_migrations,
)


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


class _FakeClock:
    """Stands in for the module's asyncio: sleep() advances time()."""

    def __init__(self):
        self.now = 0.0

    def get_running_loop(self):
        return self

    def time(self):
        return self.now

    async def sleep(self, seconds):
        self.now += seconds


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("deadline", "expected_attempts"),
    [
        # Attempts at t=0, 5 and 10; a fourth at t=15 would pass the deadline.
        (12.0, 3),
        # An attempt landing exactly on the deadline (t=10) is still made.
        (10.0, 3),
    ],
)
async def test_first_connection_retries_until_deadline_then_raises(
    deadline, expected_attempts
):
    # A bounded side_effect list: a loop that never gives up exhausts it and
    # fails with StopAsyncIteration instead of hanging the suite.
    get_connection = AsyncMock(side_effect=[OSError("unreachable")] * 20)
    with (
        patch.object(database_migrations, "get_connection", get_connection),
        patch.object(database_migrations, "asyncio", _FakeClock()),
        patch.object(
            database_migrations, "FIRST_CONNECT_DEADLINE_SECONDS", deadline
        ),
        patch.object(
            database_migrations, "FIRST_CONNECT_RETRY_INTERVAL_SECONDS", 5.0
        ),
    ):
        with pytest.raises(OSError, match="unreachable"):
            await database_migrations.first_connection()
    assert get_connection.await_count == expected_attempts


@pytest.mark.anyio
async def test_run_pending_migrations_retries_the_first_connection():
    # The migration lock connection is the first one a process opens, so it
    # must go through the retrying helper, not a bare get_connection().
    assert not isinstance(real_run_pending_migrations, Mock)
    conn = AsyncMock()
    process = MagicMock(returncode=0)
    process.communicate = AsyncMock(return_value=(b"", b""))
    first_connection = AsyncMock(return_value=conn)
    get_connection = AsyncMock(return_value=conn)
    with (
        patch.object(database_migrations, "first_connection", first_connection),
        patch.object(database_migrations, "get_connection", get_connection),
        patch.object(
            database_migrations.asyncio,
            "create_subprocess_exec",
            AsyncMock(return_value=process),
        ),
    ):
        await real_run_pending_migrations()
    first_connection.assert_awaited_once()
    get_connection.assert_not_awaited()


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
