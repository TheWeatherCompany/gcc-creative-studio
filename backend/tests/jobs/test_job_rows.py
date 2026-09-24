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
"""Guards the three media_items writes and reads the job path depends on."""

import datetime

import pytest
import pytest_asyncio
from sqlalchemy import DateTime, bindparam, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from src.jobs.job_rows import (
    fail_processing_job,
    fail_stale_jobs,
    is_processing,
)

# media_items uses Postgres-only column types, so the real table can't be
# created in SQLite. These statements only touch these columns. updated_at is
# here because the model's onupdate adds it to every UPDATE, and deleted_at
# because the soft-delete listener (src/common/events.py) filters every SELECT.
_CREATE_MEDIA_ITEMS = """
CREATE TABLE media_items (
    id INTEGER PRIMARY KEY,
    status VARCHAR NOT NULL,
    error_message VARCHAR,
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    deleted_at TIMESTAMP
)
"""

# Bound through DateTime so the stored text matches how SQLAlchemy binds the
# cutoff, which is what the SQLite comparison runs on.
_INSERT_ROW = text(
    "INSERT INTO media_items (id, status, error_message, created_at)"
    " VALUES (:id, :status, :error_message, :created_at)"
).bindparams(bindparam("created_at", type_=DateTime(timezone=True)))

NOW = datetime.datetime(2026, 9, 24, 18, 0, 0, tzinfo=datetime.timezone.utc)


@pytest_asyncio.fixture(name="db")
async def fixture_db(tmp_path):
    """A session on a throwaway SQLite media_items table."""
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path}/rows.db")
    async with engine.begin() as conn:
        await conn.execute(text(_CREATE_MEDIA_ITEMS))
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False)

    async def seed(*rows):
        async with engine.begin() as conn:
            for row in rows:
                await conn.execute(_INSERT_ROW, row)

    async def fetch():
        async with engine.connect() as conn:
            result = await conn.execute(
                text("SELECT id, status, error_message FROM media_items")
            )
            return {r.id: (r.status, r.error_message) for r in result}

    async with sessionmaker() as session:
        yield session, seed, fetch
    await engine.dispose()


def _row(id_, status, minutes_old=0, error=None):
    return {
        "id": id_,
        "status": status,
        "error_message": error,
        "created_at": NOW - datetime.timedelta(minutes=minutes_old),
    }


@pytest.mark.asyncio
async def test_fail_processing_job_leaves_finished_rows_alone(db):
    session, seed, fetch = db
    await seed(
        _row(1, "processing"),
        _row(2, "completed"),
        _row(3, "failed", error="own"),
    )

    changed = [
        await fail_processing_job(session, id_, "boom") for id_ in (1, 2, 3)
    ]

    assert changed == [True, False, False]
    assert await fetch() == {
        1: ("failed", "boom"),
        2: ("completed", None),
        3: ("failed", "own"),
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,expected",
    [
        ("processing", True),
        ("completed", False),
        ("failed", False),
        (None, False),
    ],
    ids=["processing", "completed", "failed", "missing row"],
)
async def test_is_processing(db, status, expected):
    session, seed, _ = db
    if status is not None:
        await seed(_row(1, status))
    assert await is_processing(session, 1) is expected


@pytest.mark.asyncio
async def test_fail_stale_jobs_only_touches_old_processing_rows(db):
    session, seed, fetch = db
    await seed(
        _row(1, "processing", minutes_old=90),
        _row(2, "processing", minutes_old=5),
        _row(3, "completed", minutes_old=90),
    )

    count = await fail_stale_jobs(
        session, "stuck", cutoff=NOW - datetime.timedelta(minutes=40)
    )

    assert count == 1
    assert await fetch() == {
        1: ("failed", "stuck"),
        2: ("processing", None),
        3: ("completed", None),
    }
