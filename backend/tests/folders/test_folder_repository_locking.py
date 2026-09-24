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

"""Tests for FolderRepository's locking reads and the structure lock.

Kept apart from test_folder_repository.py so this divergence from upstream
stays a self-contained addition.
"""

from unittest.mock import AsyncMock, MagicMock
import pytest
from sqlalchemy.dialects import postgresql

from src.database_migrations import MIGRATION_LOCK_ID
from src.folders.repository.folder_repository import (
    FOLDER_STRUCTURE_LOCK_NAMESPACE,
    FolderRepository,
)
from src.folders.schema.folder_model import Folder


@pytest.fixture(name="mock_db")
def fixture_mock_db():
    """Provides a mocked AsyncSession."""
    return AsyncMock()


@pytest.fixture(name="folder_repo")
def fixture_folder_repo(mock_db):
    """Provides a FolderRepository instance."""
    return FolderRepository(db=mock_db)


class TestGetFolderForUpdate:
    """The destination read that move and copy validate against."""

    @pytest.mark.anyio
    async def test_reads_the_active_row_under_a_row_lock(
        self, folder_repo, mock_db
    ):
        folder = Folder(id=5, workspace_id=1, user_email="a@b.com", name="D")
        mock_result = MagicMock()
        mock_result.scalars.return_value.first.return_value = folder
        mock_db.execute.return_value = mock_result

        assert await folder_repo.get_folder_for_update(5) is folder

        query = mock_db.execute.call_args.args[0]
        sql = str(query.compile(dialect=postgresql.dialect()))
        assert sql.rstrip().endswith("FOR UPDATE")
        # A soft-deleted destination must read as missing, not as valid.
        assert "folders.deleted_at IS NULL" in sql
        # Without this the identity map could hand back a stale copy of the
        # row, and validation would run against pre-lock values.
        assert query.get_execution_options()["populate_existing"] is True

    @pytest.mark.anyio
    async def test_returns_none_when_the_row_is_gone(
        self, folder_repo, mock_db
    ):
        mock_result = MagicMock()
        mock_result.scalars.return_value.first.return_value = None
        mock_db.execute.return_value = mock_result

        assert await folder_repo.get_folder_for_update(5) is None


class TestLockWorkspaceStructure:
    """The advisory lock that serializes folder structure changes."""

    @staticmethod
    def on_dialect(mock_db, name):
        mock_db.bind = MagicMock()
        mock_db.bind.dialect.name = name

    @pytest.mark.anyio
    async def test_locks_each_workspace_once_in_ascending_order(
        self, folder_repo, mock_db
    ):
        self.on_dialect(mock_db, "postgresql")

        await folder_repo.lock_workspace_structure(7, 2, 7, 5)

        calls = mock_db.execute.call_args_list
        assert [c.args[1]["workspace_id"] for c in calls] == [2, 5, 7]
        for c in calls:
            assert "pg_advisory_xact_lock(" in str(c.args[0])
            assert c.args[1]["namespace"] == FOLDER_STRUCTURE_LOCK_NAMESPACE

    @pytest.mark.anyio
    async def test_is_a_no_op_off_postgresql(self, folder_repo, mock_db):
        self.on_dialect(mock_db, "sqlite")

        await folder_repo.lock_workspace_structure(1, 2)

        mock_db.execute.assert_not_called()

    @pytest.mark.anyio
    async def test_is_a_no_op_without_a_bind(self, mock_db):
        del mock_db.bind
        await FolderRepository(db=mock_db).lock_workspace_structure(1)
        mock_db.execute.assert_not_called()

    def test_namespace_fits_int4_and_is_not_the_migration_lock(self):
        assert 0 < FOLDER_STRUCTURE_LOCK_NAMESPACE < 2**31
        assert FOLDER_STRUCTURE_LOCK_NAMESPACE != MIGRATION_LOCK_ID


class TestGetFoldersByIdsReread:
    """The batch re-read bulk requests make after taking the lock."""

    @pytest.mark.anyio
    @pytest.mark.parametrize("reread", [True, False])
    async def test_populate_existing_only_when_asked(
        self, folder_repo, mock_db, reread
    ):
        mock_db.execute.return_value = MagicMock()

        await folder_repo.get_folders_by_ids([1], populate_existing=reread)

        query = mock_db.execute.call_args.args[0]
        options = query.get_execution_options()
        assert options.get("populate_existing", False) is reread
