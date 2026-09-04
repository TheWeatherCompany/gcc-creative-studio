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
"""Tests for recovering a violated constraint name from an IntegrityError.

The shapes asserted here were captured from a real Postgres 16 round trip, not
invented. Getting this wrong is silent: the extraction yields None, every
IntegrityError looks alike, and a 409 degrades into a 500.
"""

from types import SimpleNamespace

from sqlalchemy.exc import IntegrityError

from src.common.db_errors import constraint_name_of

CONSTRAINT = "uq_folders_workspace_root_name_active"


def build(orig) -> IntegrityError:
    return IntegrityError("INSERT INTO folders ...", {}, orig)


class TestConstraintNameOf:
    """Each driver puts the constraint name somewhere different."""

    def test_reads_asyncpg_shape_from_the_wrapped_cause(self):
        """asyncpg: exc.orig is an adapter; the real error is __cause__.

        Verified against Postgres 16: exc.orig is
        sqlalchemy.dialects.postgresql.asyncpg.IntegrityError, which exposes
        only sqlstate/pgcode, and exc.orig.__cause__ is
        asyncpg.exceptions.UniqueViolationError carrying constraint_name.
        """
        orig = SimpleNamespace(sqlstate="23505")
        orig.__cause__ = SimpleNamespace(constraint_name=CONSTRAINT)

        assert constraint_name_of(build(orig)) == CONSTRAINT

    def test_reads_psycopg_shape_from_diag(self):
        """psycopg2/psycopg3 expose it on exc.orig.diag instead."""
        orig = SimpleNamespace(diag=SimpleNamespace(constraint_name=CONSTRAINT))

        assert constraint_name_of(build(orig)) == CONSTRAINT

    def test_falls_back_to_parsing_the_message(self):
        """Neither attribute present, but Postgres quotes the name."""
        orig = SimpleNamespace()

        error = IntegrityError(
            "INSERT INTO folders ...",
            {},
            orig,
        )
        # str(exc.orig) is what the parse reads, so make that the message.
        error.orig = Exception(
            "duplicate key value violates unique constraint "
            f'"{CONSTRAINT}"\nDETAIL: Key ...'
        )

        assert constraint_name_of(error) == CONSTRAINT

    def test_returns_none_when_nothing_identifies_the_constraint(self):
        """None means "unrecognised", so callers must not treat it as a match."""
        orig = SimpleNamespace()
        orig.__cause__ = None

        assert constraint_name_of(build(orig)) is None

    def test_prefers_the_asyncpg_cause_over_a_stale_diag(self):
        """If both are somehow present, the driver in use wins."""
        orig = SimpleNamespace(
            diag=SimpleNamespace(constraint_name="some_other_index")
        )
        orig.__cause__ = SimpleNamespace(constraint_name=CONSTRAINT)

        assert constraint_name_of(build(orig)) == CONSTRAINT
