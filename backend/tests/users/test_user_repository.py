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
"""Tests for UserRepository.get_by_email.

Email is the JIT provisioning key, so how this query matches decides whether
one person is one row or two. The session is faked and the emitted statement
inspected, which is enough to pin the case-insensitivity without standing up
Postgres.
"""

import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from src.users.repository.user_repository import UserRepository
from src.users.user_model import User


def _row(user_id: int, email: str) -> User:
    """An unattached ORM instance, enough for model_validate.

    created_at/updated_at are set explicitly: their defaults are server-side,
    so a row that never hit Postgres has them as None and UserModel rejects it.
    """
    now = datetime.datetime.now(datetime.UTC)
    return User(
        id=user_id,
        email=email,
        name="Test User",
        picture="",
        roles=["user"],
        created_at=now,
        updated_at=now,
    )


@pytest.fixture(name="fake_db")
def fixture_fake_db():
    """An AsyncSession whose execute() returns whatever rows a test sets."""
    db = AsyncMock()
    db.rows = []

    async def execute(statement):
        db.last_statement = statement
        result = MagicMock()
        result.scalars.return_value.all.return_value = db.rows
        return result

    db.execute = AsyncMock(side_effect=execute)
    return db


@pytest.fixture(name="repo")
def fixture_repo(fake_db):
    return UserRepository(db=fake_db)


class TestGetByEmail:
    """Lookup has to ignore case, or one address becomes two people."""

    @pytest.mark.anyio
    async def test_compares_on_lowered_email(self, repo, fake_db):
        await repo.get_by_email("Test.User@Example.COM")

        sql = str(fake_db.last_statement).lower()
        assert "lower(users.email)" in sql

    @pytest.mark.anyio
    async def test_finds_a_row_stored_in_a_different_case(self, repo, fake_db):
        """The exact-match version returned None here and created a duplicate."""
        fake_db.rows = [_row(7, "test.user@example.com")]

        user = await repo.get_by_email("Test.User@EXAMPLE.com")

        assert user is not None
        assert user.id == 7

    @pytest.mark.anyio
    async def test_surrounding_whitespace_does_not_defeat_the_match(
        self, repo, fake_db
    ):
        fake_db.rows = [_row(7, "test.user@example.com")]

        user = await repo.get_by_email("  test.user@example.com ")

        assert user is not None

    @pytest.mark.anyio
    async def test_no_rows_returns_none(self, repo, fake_db):
        fake_db.rows = []

        assert await repo.get_by_email("nobody@example.com") is None

    @pytest.mark.anyio
    async def test_existing_duplicates_return_the_oldest_and_warn(
        self, repo, fake_db, caplog
    ):
        """Data written before normalisation may already hold two spellings.

        Raising MultipleResultsFound here would present as an outage at
        login. Picking the oldest row deterministically and warning leaves
        the merge as out-of-hours work.
        """
        fake_db.rows = [
            _row(3, "test.user@example.com"),
            _row(9, "Test.User@example.com"),
        ]

        with caplog.at_level("WARNING"):
            user = await repo.get_by_email("test.user@example.com")

        assert user is not None
        assert user.id == 3
        assert "need merging" in caplog.text
