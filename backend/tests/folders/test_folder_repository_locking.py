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

"""Tests for FolderRepository's locking read.

Kept apart from test_folder_repository.py so this divergence from upstream
stays a self-contained addition.
"""

from unittest.mock import AsyncMock, MagicMock
import pytest
from sqlalchemy.dialects import postgresql

from src.folders.repository.folder_repository import FolderRepository
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
