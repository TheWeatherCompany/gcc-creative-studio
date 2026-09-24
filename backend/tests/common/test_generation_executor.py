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
"""Tests for failing a process's in-flight generation jobs on shutdown."""

import asyncio
import threading
from unittest.mock import patch

import pytest
import pytest_asyncio
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from main import lifespan
from src.common import generation_executor
from src.common.generation_executor import (
    INTERRUPTED_ERROR_MESSAGE,
    GenerationExecutor,
    fail_inflight_jobs,
)

# media_items uses Postgres-only column types, so the real table can't be
# created in SQLite. The shutdown UPDATE only touches these columns, which is
# enough to run the actual statement against a real database.
_CREATE_MEDIA_ITEMS = """
CREATE TABLE media_items (
    id INTEGER PRIMARY KEY,
    status VARCHAR NOT NULL,
    error_message VARCHAR,
    updated_at TIMESTAMP
)
"""


@pytest_asyncio.fixture(name="db")
async def fixture_db(tmp_path):
    """Points the shutdown write at a throwaway SQLite media_items table."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/jobs.db")
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)

    async def seed(rows):
        async with engine.begin() as conn:
            await conn.execute(text(_CREATE_MEDIA_ITEMS))
            for row in rows:
                await conn.execute(
                    text(
                        "INSERT INTO media_items (id, status, error_message)"
                        " VALUES (:id, :status, :error_message)"
                    ),
                    row,
                )

    async def fetch():
        async with engine.connect() as conn:
            result = await conn.execute(
                text("SELECT id, status, error_message FROM media_items")
            )
            return {r.id: (r.status, r.error_message) for r in result}

    with patch.object(generation_executor, "async_session_local", sessionmaker):
        yield seed, fetch
    await engine.dispose()


@pytest.mark.asyncio
async def test_shutdown_fails_only_tracked_rows_still_processing(db):
    seed, fetch = db
    # (id, tracked by this process, status before, error before, expected after)
    cases = [
        (1, True, "processing", None, ("failed", INTERRUPTED_ERROR_MESSAGE)),
        (2, True, "completed", None, ("completed", None)),
        (3, True, "failed", "Quota exceeded", ("failed", "Quota exceeded")),
        # Another worker process's job: not ours to fail.
        (4, False, "processing", None, ("processing", None)),
    ]
    await seed(
        [{"id": c[0], "status": c[2], "error_message": c[3]} for c in cases]
    )

    await fail_inflight_jobs([c[0] for c in cases if c[1]])

    after = await fetch()
    assert {c[0]: after[c[0]] for c in cases} == {c[0]: c[4] for c in cases}


@pytest.mark.parametrize(
    "job",
    [lambda: None, lambda: 1 / 0],
    ids=["job returns", "job raises"],
)
def test_finished_job_leaves_the_registry(job):
    executor = GenerationExecutor(max_workers=1)
    executor.submit_job(7, job)
    # Joins the worker, so its done-callback has run.
    executor.shutdown(wait=True)

    assert executor.inflight_job_ids() == []


class _HangingSession:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, unused_statement):
        await asyncio.sleep(60)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["db error", "db hangs"])
async def test_shutdown_write_failure_does_not_raise(tmp_path, failure):
    if failure == "db error":
        # No media_items table, so the UPDATE itself errors.
        engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/x.db")
        session_factory = async_sessionmaker(engine)
    else:
        session_factory = _HangingSession

    with (
        patch.object(
            generation_executor, "async_session_local", session_factory
        ),
        patch.object(
            generation_executor, "SHUTDOWN_WRITE_TIMEOUT_SECONDS", 0.1
        ),
    ):
        # The outer bound only exists so a missing timeout fails, not hangs.
        await asyncio.wait_for(fail_inflight_jobs([1]), timeout=5)
    if failure == "db error":
        await engine.dispose()


@pytest.mark.asyncio
async def test_lifespan_fails_running_job_before_waiting_on_it(db):
    seed, fetch = db
    await seed([{"id": 1, "status": "processing", "error_message": None}])
    release = threading.Event()
    app = FastAPI()

    async with lifespan(app):
        # Still running at shutdown; it never writes its own status.
        app.state.executor.submit_job(1, release.wait, 0.5)

    release.set()
    assert (await fetch())[1] == ("failed", INTERRUPTED_ERROR_MESSAGE)
