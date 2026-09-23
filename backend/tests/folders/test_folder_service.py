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

"""Tests for Folder Service."""

from unittest.mock import AsyncMock, MagicMock
import pytest
from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError

from src.folders.dto.folder_dto import (
    ConflictStrategyEnum,
    FolderBreadcrumbDto,
    FolderCreateDto,
    FolderResponseDto,
    FolderTreeNodeDto,
    FolderUpdateDto,
    MoveItemsDto,
    CopyItemsDto,
)
from src.folders.folder_service import FolderService
from src.folders.schema.folder_model import Folder
from src.users.user_model import UserModel, UserRoleEnum


PARENT_NAME_INDEX = "uq_folders_workspace_parent_name_active"
ROOT_NAME_INDEX = "uq_folders_workspace_root_name_active"


def db_integrity_error(
    sqlstate: str,
    constraint_name: str | None,
    message: str,
    statement: str = "INSERT INTO folders ...",
    params: tuple = (),
) -> IntegrityError:
    """Builds an IntegrityError shaped the way SQLAlchemy's asyncpg raises one.

    ``exc.orig`` is the dialect's adapter exception, which carries only
    ``pgcode``/``sqlstate``; the asyncpg error holding ``constraint_name`` is
    its ``__cause__``. Building anything else (a bare ``Exception("Unique
    violation")``, or a psycopg ``diag``) asserts a shape production never sees.
    """
    cause = Exception(message)
    cause.sqlstate = sqlstate
    cause.constraint_name = constraint_name
    orig = Exception(f"<class 'asyncpg.exceptions.IntegrityError'>: {message}")
    orig.pgcode = orig.sqlstate = sqlstate
    orig.__cause__ = cause
    return IntegrityError(statement, params, orig)


def name_clash(constraint_name: str = ROOT_NAME_INDEX) -> IntegrityError:
    """A clash on one of the folder name indexes."""
    return db_integrity_error(
        "23505",
        constraint_name,
        f'duplicate key value violates unique constraint "{constraint_name}"',
    )


def fk_violation(constraint_name: str, column: str) -> IntegrityError:
    """A foreign key violation on the given folders column."""
    return db_integrity_error(
        "23503",
        constraint_name,
        'insert or update on table "folders" violates foreign key constraint '
        f'"{constraint_name}"\nDETAIL: Key ({column})=(999) is not present.',
        # The statement names every column, so wording must not come from it.
        statement="INSERT INTO folders (workspace_id, user_id, user_email, "
        "name, parent_id, color) VALUES (...)",
    )


def check_violation() -> IntegrityError:
    """A CHECK violation, which no folder name index can explain."""
    return db_integrity_error(
        "23514",
        "folders_name_check",
        'new row for relation "folders" violates check constraint '
        '"folders_name_check"',
    )


@pytest.fixture(name="mock_folder_repo")
def fixture_mock_folder_repo():
    """Provides a mocked FolderRepository."""
    mock = AsyncMock()
    mock.db = AsyncMock()
    mock.db.add = MagicMock()
    mock.is_folder_name_taken.return_value = False
    mock.get_folder_depth.return_value = 1
    mock.get_subtree_depth.return_value = 1
    mock.get_folders_by_ids.return_value = []
    mock.get_existing_folders_map.return_value = {}
    mock.get_folder_counts.return_value = (0, 0)
    mock.get_descendant_ids_batch.return_value = []

    # A locked read returns whatever the plain read is configured to, so
    # tests that set get_folder_by_id keep working. Lock-specific tests
    # override this to tell the two reads apart.
    async def locked_read(folder_id):
        return await mock.get_folder_by_id(folder_id)

    mock.get_folder_for_update.side_effect = locked_read
    return mock


@pytest.fixture(name="folder_service")
def fixture_folder_service(mock_folder_repo):
    """Provides a FolderService instance."""
    return FolderService(folder_repo=mock_folder_repo)


@pytest.fixture(name="sample_user")
def fixture_sample_user():
    return UserModel(
        id=10,
        email="test@example.com",
        roles=[UserRoleEnum.USER],
        name="Test User",
    )


class TestCreateFolder:
    """Tests for FolderService.create_folder."""

    @pytest.mark.anyio
    async def test_create_root_folder_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        dto = FolderCreateDto(
            name="My Folder",
            workspace_id=1,
            parent_id=None,
            color="#FF5500",
        )

        async def fake_refresh(f):
            f.id = 100

        mock_folder_repo.db.refresh.side_effect = fake_refresh

        result = await folder_service.create_folder(dto, sample_user)

        assert result.id == 100
        assert result.name == "My Folder"
        assert result.workspace_id == 1
        assert result.color == "#FF5500"
        mock_folder_repo.db.add.assert_called_once()
        mock_folder_repo.db.commit.assert_called_once()

    @pytest.mark.anyio
    async def test_create_subfolder_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        dto = FolderCreateDto(
            name="Subfolder",
            workspace_id=1,
            parent_id=5,
        )
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Parent"
        )

        async def fake_refresh(f):
            f.id = 101

        mock_folder_repo.db.refresh.side_effect = fake_refresh

        result = await folder_service.create_folder(dto, sample_user)
        assert result.id == 101
        assert result.parent_id == 5

    @pytest.mark.anyio
    async def test_create_folder_duplicate_conflict(
        self, folder_service, mock_folder_repo, sample_user
    ):
        dto = FolderCreateDto(
            name="Existing Folder",
            workspace_id=1,
            parent_id=None,
        )
        mock_folder_repo.is_folder_name_taken.return_value = True

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_409_CONFLICT
        assert "already exists" in exc_info.value.detail

    @pytest.mark.anyio
    async def test_create_folder_empty_name_error(
        self, folder_service, sample_user
    ):
        dto = FolderCreateDto(
            name="   ",
            workspace_id=1,
            parent_id=None,
        )
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.anyio
    async def test_create_subfolder_max_depth_exceeded(
        self, folder_service, mock_folder_repo, sample_user
    ):
        dto = FolderCreateDto(
            name="TooDeep",
            workspace_id=1,
            parent_id=5,
        )
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Parent"
        )
        mock_folder_repo.get_folder_depth.return_value = 20

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST
        assert (
            "maximum folder tree depth of 20 levels reached"
            in exc_info.value.detail
        )

    @pytest.mark.anyio
    async def test_create_subfolder_parent_not_found(
        self, folder_service, mock_folder_repo, sample_user
    ):
        dto = FolderCreateDto(
            name="Subfolder",
            workspace_id=1,
            parent_id=999,
        )
        mock_folder_repo.get_folder_by_id.return_value = None

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.anyio
    async def test_create_folder_integrity_error_unique_violation(
        self, folder_service, mock_folder_repo, sample_user
    ):
        dto = FolderCreateDto(
            name="New Folder",
            workspace_id=1,
            parent_id=None,
        )
        mock_folder_repo.db.commit.side_effect = name_clash()

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_409_CONFLICT
        assert "already exists" in exc_info.value.detail
        mock_folder_repo.db.rollback.assert_called_once()

    @pytest.mark.anyio
    async def test_create_folder_integrity_error_pgcode_unique(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """SQLSTATE 23505 alone is not a name clash: the index must match."""
        dto = FolderCreateDto(
            name="New Folder",
            workspace_id=1,
            parent_id=None,
        )
        error = name_clash("folders_pkey")
        mock_folder_repo.db.commit.side_effect = error

        with pytest.raises(IntegrityError) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value is error
        mock_folder_repo.db.rollback.assert_called_once()

    @pytest.mark.anyio
    async def test_create_folder_integrity_error_foreign_key_workspace(
        self, folder_service, mock_folder_repo, sample_user
    ):
        dto = FolderCreateDto(
            name="New Folder",
            workspace_id=999,
            parent_id=None,
        )
        mock_folder_repo.db.commit.side_effect = fk_violation(
            "folders_workspace_id_fkey", "workspace_id"
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "workspace does not exist" in exc_info.value.detail
        mock_folder_repo.db.rollback.assert_called_once()

    @pytest.mark.anyio
    async def test_create_folder_integrity_error_foreign_key_user(
        self, folder_service, mock_folder_repo, sample_user
    ):
        dto = FolderCreateDto(
            name="New Folder",
            workspace_id=1,
            parent_id=None,
        )
        mock_folder_repo.db.commit.side_effect = fk_violation(
            "folders_user_id_fkey", "user_id"
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "user does not exist" in exc_info.value.detail
        mock_folder_repo.db.rollback.assert_called_once()

    @pytest.mark.anyio
    async def test_create_folder_integrity_error_foreign_key_parent(
        self, folder_service, mock_folder_repo, sample_user
    ):
        dto = FolderCreateDto(
            name="New Folder",
            workspace_id=1,
            parent_id=5,
        )
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Parent"
        )
        mock_folder_repo.db.commit.side_effect = fk_violation(
            "folders_parent_id_fkey", "parent_id"
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "parent folder does not exist" in exc_info.value.detail
        mock_folder_repo.db.rollback.assert_called_once()

    @pytest.mark.anyio
    async def test_create_folder_integrity_error_foreign_key_generic(
        self, folder_service, mock_folder_repo, sample_user
    ):
        dto = FolderCreateDto(
            name="New Folder",
            workspace_id=1,
            parent_id=None,
        )
        mock_folder_repo.db.commit.side_effect = fk_violation(
            "folders_deleted_by_fkey", "deleted_by"
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "Referenced entity" in exc_info.value.detail
        mock_folder_repo.db.rollback.assert_called_once()

    @pytest.mark.anyio
    async def test_create_folder_integrity_error_other(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """An unrecognised integrity failure is a server fault, not a 400."""
        dto = FolderCreateDto(
            name="New Folder",
            workspace_id=1,
            parent_id=None,
        )
        error = check_violation()
        mock_folder_repo.db.commit.side_effect = error

        with pytest.raises(IntegrityError) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value is error
        mock_folder_repo.db.rollback.assert_called_once()


class TestGetFolder:
    """Tests for FolderService get operations."""

    @pytest.mark.anyio
    async def test_get_folders_list(self, folder_service, mock_folder_repo):
        mock_folder_repo.list_by_parent.return_value = [
            FolderResponseDto(
                id=1,
                workspace_id=1,
                user_email="a@b.com",
                name="F1",
                parent_id=None,
            )
        ]
        result = await folder_service.get_folders(
            workspace_id=1, parent_id=None
        )
        assert len(result) == 1
        assert result[0].name == "F1"


class TestGetRawFolder:
    """Tests for FolderService.get_raw_folder."""

    @pytest.mark.anyio
    async def test_get_raw_folder_found(self, folder_service, mock_folder_repo):
        folder = Folder(
            id=1,
            workspace_id=1,
            user_id=1,
            user_email="a@b.com",
            name="F1",
            parent_id=None,
        )
        mock_folder_repo.get_folder_by_id.return_value = folder

        result = await folder_service.get_raw_folder(folder_id=1)
        assert result.id == 1
        assert result.name == "F1"
        mock_folder_repo.get_folder_counts.assert_not_called()

    @pytest.mark.anyio
    async def test_get_raw_folder_not_found(
        self, folder_service, mock_folder_repo
    ):
        mock_folder_repo.get_folder_by_id.return_value = None

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.get_raw_folder(folder_id=999)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.anyio
    async def test_get_raw_folder_workspace_mismatch(
        self, folder_service, mock_folder_repo
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=1, workspace_id=2, user_email="a@b.com", name="Folder in WS2"
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.get_raw_folder(folder_id=1, workspace_id=1)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "not found in this workspace" in exc_info.value.detail


class TestGetFolderById:
    """Tests for FolderService.get_folder_by_id."""

    @pytest.mark.anyio
    async def test_get_folder_by_id_found(
        self, folder_service, mock_folder_repo
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=1,
            workspace_id=1,
            user_id=1,
            user_email="a@b.com",
            name="F1",
            parent_id=None,
        )
        mock_folder_repo.get_folder_counts.return_value = (10, 2)

        result = await folder_service.get_folder_by_id(folder_id=1)
        assert result.id == 1
        assert result.item_count == 10
        assert result.subfolder_count == 2
        mock_folder_repo.get_folder_counts.assert_called_once_with(1)
        mock_folder_repo.list_by_parent.assert_not_called()

    @pytest.mark.anyio
    async def test_get_folder_by_id_not_found(
        self, folder_service, mock_folder_repo
    ):
        mock_folder_repo.get_folder_by_id.return_value = None

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.get_folder_by_id(folder_id=999)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.anyio
    async def test_get_folder_by_id_workspace_mismatch(
        self, folder_service, mock_folder_repo
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=1, workspace_id=2, user_email="a@b.com", name="Folder in WS2"
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.get_folder_by_id(folder_id=1, workspace_id=1)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "not found in this workspace" in exc_info.value.detail

    @pytest.mark.anyio
    async def test_get_breadcrumbs(self, folder_service, mock_folder_repo):
        mock_folder_repo.get_breadcrumbs.return_value = [
            FolderBreadcrumbDto(
                id=1, name="Root", parent_id=None, workspace_id=1
            ),
            FolderBreadcrumbDto(id=2, name="Sub", parent_id=1, workspace_id=1),
        ]

        result = await folder_service.get_breadcrumbs(
            folder_id=2, workspace_id=1
        )
        assert len(result) == 2
        assert result[0].name == "Root"

    @pytest.mark.anyio
    async def test_get_breadcrumbs_not_found(
        self, folder_service, mock_folder_repo
    ):
        mock_folder_repo.get_breadcrumbs.return_value = []

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.get_breadcrumbs(folder_id=999)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.anyio
    async def test_get_breadcrumbs_workspace_mismatch(
        self, folder_service, mock_folder_repo
    ):
        mock_folder_repo.get_breadcrumbs.return_value = [
            FolderBreadcrumbDto(
                id=1, name="Root", parent_id=None, workspace_id=2
            ),
            FolderBreadcrumbDto(id=2, name="Sub", parent_id=1, workspace_id=2),
        ]

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.get_breadcrumbs(folder_id=2, workspace_id=1)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "not found in this workspace" in exc_info.value.detail

    @pytest.mark.anyio
    async def test_get_tree(self, folder_service, mock_folder_repo):
        mock_folder_repo.get_tree.return_value = [
            FolderTreeNodeDto(id=1, name="Root", parent_id=None, children=[])
        ]
        result = await folder_service.get_folder_tree(workspace_id=1)
        assert len(result) == 1
        assert result[0].name == "Root"


class TestUpdateFolder:
    """Tests for FolderService.update_folder."""

    @pytest.mark.anyio
    async def test_update_name_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1, workspace_id=1, user_email="a@b.com", name="Old Name"
        )
        mock_folder_repo.get_folder_by_id.return_value = folder
        mock_folder_repo.is_folder_name_taken.return_value = False
        mock_folder_repo.list_by_parent.return_value = [
            FolderResponseDto(
                id=1,
                workspace_id=1,
                user_email="a@b.com",
                name="New Name",
                parent_id=None,
            )
        ]

        dto = FolderUpdateDto(name="New Name")
        result = await folder_service.update_folder(1, dto, sample_user)
        assert folder.name == "New Name"
        assert result.name == "New Name"

    @pytest.mark.anyio
    async def test_update_folder_with_preloaded_folder(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1, workspace_id=1, user_email="a@b.com", name="Old Name"
        )
        mock_folder_repo.is_folder_name_taken.return_value = False
        mock_folder_repo.get_folder_counts.return_value = (5, 1)

        dto = FolderUpdateDto(name="New Name")
        result = await folder_service.update_folder(
            1, dto, sample_user, folder=folder
        )
        assert folder.name == "New Name"
        assert result.name == "New Name"
        assert result.item_count == 5
        assert result.subfolder_count == 1
        mock_folder_repo.get_folder_by_id.assert_not_called()
        mock_folder_repo.get_folder_counts.assert_called_once_with(1)

    @pytest.mark.anyio
    async def test_update_name_conflict_error(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1, workspace_id=1, user_email="a@b.com", name="Old Name"
        )
        mock_folder_repo.get_folder_by_id.return_value = folder
        mock_folder_repo.is_folder_name_taken.return_value = True

        dto = FolderUpdateDto(name="Existing Name")
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_409_CONFLICT
        assert "already exists" in exc_info.value.detail

    @pytest.mark.anyio
    async def test_update_name_empty_error(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1, workspace_id=1, user_email="a@b.com", name="Old Name"
        )
        mock_folder_repo.get_folder_by_id.return_value = folder

        dto = FolderUpdateDto(name="   ")
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.anyio
    async def test_update_folder_move_auto_disambiguation(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Colliding",
            parent_id=None,
        )
        target_parent = Folder(
            id=5,
            workspace_id=1,
            user_email="a@b.com",
            name="TargetParent",
            parent_id=None,
        )
        mock_folder_repo.get_folder_by_id.side_effect = lambda fid: (
            folder if fid == 1 else target_parent
        )
        mock_folder_repo.get_descendant_ids.return_value = []
        mock_folder_repo.get_unique_folder_name.return_value = "Colliding (1)"
        mock_folder_repo.list_by_parent.return_value = [
            FolderResponseDto(
                id=1,
                workspace_id=1,
                user_email="a@b.com",
                name="Colliding (1)",
                parent_id=5,
            )
        ]

        dto = FolderUpdateDto(parent_id=5)
        result = await folder_service.update_folder(1, dto, sample_user)
        assert folder.parent_id == 5
        assert folder.name == "Colliding (1)"
        assert result.name == "Colliding (1)"

    @pytest.mark.anyio
    async def test_update_parent_cycle_error(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1, workspace_id=1, user_email="a@b.com", name="Parent"
        )
        mock_folder_repo.get_folder_by_id.side_effect = lambda fid: (
            folder
            if fid == 1
            else Folder(
                id=3, workspace_id=1, user_email="a@b.com", name="Child"
            )
        )
        # Child 3 is a descendant of 1
        mock_folder_repo.get_descendant_ids.return_value = [1, 2, 3]

        dto = FolderUpdateDto(parent_id=3)
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.anyio
    async def test_update_parent_itself_error(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1, workspace_id=1, user_email="a@b.com", name="Parent"
        )
        mock_folder_repo.get_folder_by_id.return_value = folder

        dto = FolderUpdateDto(parent_id=1)
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.anyio
    async def test_update_parent_max_depth_exceeded(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Folder1",
            parent_id=None,
        )
        mock_folder_repo.get_folder_by_id.side_effect = [
            folder,
            Folder(
                id=4,
                workspace_id=1,
                user_email="a@b.com",
                name="TargetParent",
            ),
        ]
        mock_folder_repo.get_descendant_ids.return_value = [1]
        mock_folder_repo.get_folder_depth.return_value = 19
        mock_folder_repo.get_subtree_depth.return_value = 2

        dto = FolderUpdateDto(parent_id=4)
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST
        assert (
            "would exceed maximum folder tree depth of 20 levels"
            in exc_info.value.detail
        )

    @pytest.mark.anyio
    async def test_update_folder_integrity_error_unique_violation(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1, workspace_id=1, user_email="a@b.com", name="Old Name"
        )
        mock_folder_repo.get_folder_by_id.return_value = folder
        mock_folder_repo.db.commit.side_effect = name_clash(PARENT_NAME_INDEX)

        dto = FolderUpdateDto(name="New Name")
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_409_CONFLICT
        assert "already exists" in exc_info.value.detail
        mock_folder_repo.db.rollback.assert_called_once()

    @pytest.mark.anyio
    async def test_update_folder_integrity_error_foreign_key(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1, workspace_id=1, user_email="a@b.com", name="Old Name"
        )
        mock_folder_repo.get_folder_by_id.return_value = folder
        mock_folder_repo.db.commit.side_effect = fk_violation(
            "folders_parent_id_fkey", "parent_id"
        )

        dto = FolderUpdateDto(name="New Name")
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "parent folder does not exist" in exc_info.value.detail
        mock_folder_repo.db.rollback.assert_called_once()

    @pytest.mark.anyio
    async def test_update_folder_integrity_error_other(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            id=1, workspace_id=1, user_email="a@b.com", name="Old Name"
        )
        mock_folder_repo.get_folder_by_id.return_value = folder
        error = check_violation()
        mock_folder_repo.db.commit.side_effect = error

        dto = FolderUpdateDto(name="New Name")
        with pytest.raises(IntegrityError) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value is error
        mock_folder_repo.db.rollback.assert_called_once()


class TestDeleteFolder:
    """Tests for FolderService.delete_folder."""

    @pytest.mark.anyio
    async def test_delete_folder_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(id=1, workspace_id=1, user_email="a@b.com", name="F")
        mock_folder_repo.get_folder_by_id.return_value = folder
        mock_folder_repo.soft_delete.return_value = True

        result = await folder_service.delete_folder(1, sample_user)
        assert result["success"] is True
        mock_folder_repo.get_folder_by_id.assert_called_once_with(1)
        mock_folder_repo.soft_delete.assert_called_once_with(
            folder_id=1, user_id=sample_user.id
        )

    @pytest.mark.anyio
    async def test_delete_folder_with_prefetched_folder(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(id=1, workspace_id=1, user_email="a@b.com", name="F")
        mock_folder_repo.soft_delete.return_value = True

        result = await folder_service.delete_folder(
            1, sample_user, folder=folder
        )
        assert result["success"] is True
        mock_folder_repo.get_folder_by_id.assert_not_called()
        mock_folder_repo.soft_delete.assert_called_once_with(
            folder_id=1, user_id=sample_user.id
        )

    @pytest.mark.anyio
    async def test_delete_folder_not_found(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = None

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.delete_folder(999, sample_user)

        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "Folder with ID 999 not found." in exc_info.value.detail
        mock_folder_repo.soft_delete.assert_not_called()


class TestMoveItems:
    """Tests for FolderService.move_items."""

    @pytest.mark.anyio
    async def test_move_items_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.get_descendant_ids_batch.return_value = [2]
        mock_folder_repo.move_media_items.return_value = 2
        mock_folder_repo.move_source_assets.return_value = 1
        mock_folder_repo.move_folders.return_value = 1

        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[10, 11],
            source_asset_ids=[20],
            folder_ids=[2],
            destination_folder_id=5,
        )

        result = await folder_service.move_items(dto, sample_user)
        assert result["total_moved"] == 4
        assert result["media_items_moved"] == 2
        assert result["source_assets_moved"] == 1
        assert result["folders_moved"] == 1

    @pytest.mark.anyio
    async def test_move_items_into_itself_error(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )

        dto = MoveItemsDto(
            workspace_id=1,
            folder_ids=[5],
            destination_folder_id=5,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.anyio
    async def test_move_items_folder_max_depth_exceeded(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.get_descendant_ids_batch.return_value = [2]
        mock_folder_repo.get_folder_depth.return_value = 19
        mock_folder_repo.get_subtree_depth.return_value = 2

        dto = MoveItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=5,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST
        assert (
            "would exceed maximum folder tree depth of 20 levels"
            in exc_info.value.detail
        )

    @pytest.mark.anyio
    async def test_move_items_cycle_subfolder_error(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        # Folder 5 is in descendants of folder 2 (cycle)
        mock_folder_repo.get_descendant_ids_batch.return_value = [2, 5]

        dto = MoveItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=5,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST
        assert (
            "Cannot move folder into one of its own subfolders."
            in exc_info.value.detail
        )

    @pytest.mark.anyio
    async def test_move_items_foreign_folder_raises_404(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        # Folder 999 belongs to another workspace, so get_folders_by_ids returns empty
        mock_folder_repo.get_folders_by_ids.return_value = []

        dto = MoveItemsDto(
            workspace_id=1,
            folder_ids=[999],
            destination_folder_id=5,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert (
            "One or more specified folders were not found in this workspace."
            in exc_info.value.detail
        )
        mock_folder_repo.get_folders_by_ids.assert_awaited_once_with(
            folder_ids=[999], workspace_id=1
        )
        mock_folder_repo.get_descendant_ids_batch.assert_not_called()
        mock_folder_repo.get_subtree_depth.assert_not_called()
        mock_folder_repo.move_folders.assert_not_called()

    @pytest.mark.anyio
    async def test_move_items_mixed_valid_and_foreign_folders_raises_404(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        # Folder 2 belongs to workspace 1, folder 999 belongs to workspace 2
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]

        dto = MoveItemsDto(
            workspace_id=1,
            folder_ids=[2, 999],
            destination_folder_id=5,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert (
            "One or more specified folders were not found in this workspace."
            in exc_info.value.detail
        )
        mock_folder_repo.get_folders_by_ids.assert_awaited_once_with(
            folder_ids=[2, 999], workspace_id=1
        )
        mock_folder_repo.get_descendant_ids_batch.assert_not_called()
        mock_folder_repo.get_subtree_depth.assert_not_called()
        mock_folder_repo.move_folders.assert_not_called()

    @pytest.mark.anyio
    async def test_move_items_duplicate_folder_ids_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_folder_depth.return_value = 1
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.get_descendant_ids_batch.return_value = [2]
        mock_folder_repo.get_subtree_depth.return_value = 1
        mock_folder_repo.get_existing_folders_map.return_value = {}
        mock_folder_repo.move_media_items.return_value = 0
        mock_folder_repo.move_source_assets.return_value = 0
        mock_folder_repo.move_folders.return_value = 1

        dto = MoveItemsDto(
            workspace_id=1,
            folder_ids=[2, 2],
            destination_folder_id=5,
        )

        result = await folder_service.move_items(dto, sample_user)
        mock_folder_repo.get_folders_by_ids.assert_awaited_once_with(
            folder_ids=[2], workspace_id=1
        )
        mock_folder_repo.move_folders.assert_awaited_once_with(
            folder_ids=[2],
            workspace_id=1,
            destination_folder_id=5,
            conflict_strategy=ConflictStrategyEnum.KEEP_BOTH,
            user_id=10,
            user_email="test@example.com",
            commit=False,
        )
        assert result["folders_moved"] == 1

    @pytest.mark.anyio
    async def test_move_items_to_root_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.move_media_items.return_value = 0
        mock_folder_repo.move_source_assets.return_value = 0
        mock_folder_repo.move_folders.return_value = 1

        dto = MoveItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=None,
        )

        result = await folder_service.move_items(dto, sample_user)
        mock_folder_repo.get_folders_by_ids.assert_awaited_once_with(
            folder_ids=[2], workspace_id=1
        )
        mock_folder_repo.get_descendant_ids_batch.assert_not_called()
        mock_folder_repo.get_subtree_depth.assert_not_called()
        mock_folder_repo.move_folders.assert_awaited_once_with(
            folder_ids=[2],
            workspace_id=1,
            destination_folder_id=None,
            conflict_strategy=ConflictStrategyEnum.KEEP_BOTH,
            user_id=10,
            user_email="test@example.com",
            commit=False,
        )
        assert result["folders_moved"] == 1
        assert result["total_moved"] == 1

    @pytest.mark.anyio
    async def test_move_items_conflict_detection_409(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        colliding_folder = Folder(
            id=2,
            workspace_id=1,
            user_email="a@b.com",
            name="ExistingSub",
            parent_id=1,
        )
        target_folder = Folder(
            id=50,
            workspace_id=1,
            user_email="a@b.com",
            name="ExistingSub",
            parent_id=5,
        )
        mock_folder_repo.get_folders_by_ids.return_value = [colliding_folder]
        mock_folder_repo.get_descendant_ids_batch.return_value = [2]
        mock_folder_repo.get_existing_folders_map.return_value = {
            "existingsub": target_folder
        }

        dto = MoveItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=5,
            conflict_strategy=None,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_409_CONFLICT
        assert exc_info.value.detail["code"] == "FOLDER_COLLISION"
        assert len(exc_info.value.detail["conflicts"]) == 1
        assert exc_info.value.detail["conflicts"][0]["folder_id"] == 2

    @pytest.mark.anyio
    async def test_move_items_with_merge_strategy(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        colliding_folder = Folder(
            id=2,
            workspace_id=1,
            user_email="a@b.com",
            name="ExistingSub",
            parent_id=1,
        )
        mock_folder_repo.get_folders_by_ids.return_value = [colliding_folder]
        mock_folder_repo.get_descendant_ids_batch.return_value = [2]
        mock_folder_repo.move_media_items.return_value = 0
        mock_folder_repo.move_source_assets.return_value = 0
        mock_folder_repo.move_folders.return_value = 1

        dto = MoveItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=5,
            conflict_strategy=ConflictStrategyEnum.MERGE,
        )

        result = await folder_service.move_items(dto, sample_user)
        assert result["folders_moved"] == 1
        mock_folder_repo.move_folders.assert_awaited_once_with(
            folder_ids=[2],
            workspace_id=1,
            destination_folder_id=5,
            conflict_strategy=ConflictStrategyEnum.MERGE,
            user_id=10,
            user_email="test@example.com",
            commit=False,
        )

    @pytest.mark.anyio
    async def test_move_items_transactional_commit(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.move_media_items.return_value = 3
        mock_folder_repo.move_source_assets.return_value = 2
        mock_folder_repo.move_folders.return_value = 0

        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[1, 2, 3],
            source_asset_ids=[10, 11],
            folder_ids=[],
            destination_folder_id=None,
        )

        result = await folder_service.move_items(dto, sample_user)
        assert result["total_moved"] == 5
        mock_folder_repo.db.commit.assert_called_once()
        mock_folder_repo.db.rollback.assert_not_called()

    @pytest.mark.anyio
    async def test_move_items_transactional_rollback_on_folder_failure(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.move_media_items.return_value = 1
        mock_folder_repo.move_source_assets.return_value = 1
        mock_folder_repo.move_folders.side_effect = RuntimeError(
            "Folder move failed"
        )

        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[1],
            source_asset_ids=[10],
            folder_ids=[2],
            destination_folder_id=None,
        )

        with pytest.raises(RuntimeError, match="Folder move failed"):
            await folder_service.move_items(dto, sample_user)

        mock_folder_repo.db.rollback.assert_called_once()
        mock_folder_repo.db.commit.assert_not_called()

    @pytest.mark.anyio
    async def test_move_items_transactional_rollback_on_integrity_error(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.move_media_items.return_value = 1
        mock_folder_repo.move_source_assets.return_value = 1
        mock_folder_repo.move_folders.side_effect = name_clash(
            PARENT_NAME_INDEX
        )

        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[1],
            source_asset_ids=[10],
            folder_ids=[2],
            destination_folder_id=None,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)

        assert exc_info.value.status_code == status.HTTP_409_CONFLICT
        assert (
            "A database conflict occurred while moving items."
            in exc_info.value.detail
        )
        mock_folder_repo.db.rollback.assert_called_once()
        mock_folder_repo.db.commit.assert_not_called()

    @pytest.mark.anyio
    async def test_move_items_transactional_rollback_on_media_failure(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.move_media_items.side_effect = Exception(
            "Media move error"
        )

        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[1],
            source_asset_ids=[10],
            folder_ids=[],
            destination_folder_id=None,
        )

        with pytest.raises(Exception, match="Media move error"):
            await folder_service.move_items(dto, sample_user)

        mock_folder_repo.db.rollback.assert_called_once()
        mock_folder_repo.db.commit.assert_not_called()


class TestCopyItems:
    """Tests for batch copying items within workspace."""

    @pytest.mark.anyio
    async def test_copy_items_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_folder_depth.return_value = 1
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.get_subtree_depth.return_value = 1
        mock_folder_repo.get_existing_folders_map.return_value = {}
        mock_folder_repo.copy_items.return_value = {
            "media_items_copied": 2,
            "source_assets_copied": 1,
            "folders_copied": 1,
            "total_copied": 4,
        }

        dto = CopyItemsDto(
            workspace_id=1,
            media_item_ids=[10, 11],
            source_asset_ids=[20],
            folder_ids=[2],
            destination_folder_id=5,
        )

        result = await folder_service.copy_items(dto, sample_user)
        assert result["total_copied"] == 4
        assert result["media_items_copied"] == 2
        assert result["source_assets_copied"] == 1
        assert result["folders_copied"] == 1
        mock_folder_repo.copy_items.assert_awaited_once_with(
            workspace_id=1,
            media_item_ids=[10, 11],
            source_asset_ids=[20],
            folder_ids=[2],
            destination_folder_id=5,
            conflict_strategy=ConflictStrategyEnum.KEEP_BOTH,
            user_id=10,
            user_email="test@example.com",
        )
        mock_folder_repo.get_existing_folders_map.assert_awaited_once_with(
            workspace_id=1,
            parent_id=5,
            exclude_folder_ids=[2],
        )

    @pytest.mark.anyio
    async def test_copy_items_in_place_duplication_no_conflict(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=10, workspace_id=1, user_email="a@b.com", name="Parent"
        )
        mock_folder_repo.get_folder_depth.return_value = 1
        source_folder = Folder(
            id=20,
            workspace_id=1,
            user_email="a@b.com",
            name="DupeMe",
            parent_id=10,
        )
        mock_folder_repo.get_folders_by_ids.return_value = [source_folder]
        mock_folder_repo.get_subtree_depth.return_value = 1
        mock_folder_repo.get_existing_folders_map.return_value = {}
        mock_folder_repo.copy_items.return_value = {
            "media_items_copied": 0,
            "source_assets_copied": 0,
            "folders_copied": 1,
            "total_copied": 1,
        }

        dto = CopyItemsDto(
            workspace_id=1,
            folder_ids=[20],
            destination_folder_id=10,
        )

        result = await folder_service.copy_items(dto, sample_user)
        assert result["folders_copied"] == 1
        mock_folder_repo.get_existing_folders_map.assert_awaited_once_with(
            workspace_id=1,
            parent_id=10,
            exclude_folder_ids=[20],
        )

    @pytest.mark.anyio
    async def test_copy_items_dest_not_found(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = None

        dto = CopyItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=999,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.copy_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "Destination folder not found" in exc_info.value.detail

    @pytest.mark.anyio
    async def test_copy_items_dest_workspace_mismatch(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=2, user_email="a@b.com", name="Foreign"
        )

        dto = CopyItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=5,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.copy_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.anyio
    async def test_copy_items_source_folder_not_found_raises_404(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_folder_depth.return_value = 1
        mock_folder_repo.get_folders_by_ids.return_value = []

        dto = CopyItemsDto(
            workspace_id=1,
            folder_ids=[999],
            destination_folder_id=5,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.copy_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert (
            "One or more specified folders were not found in this workspace."
            in exc_info.value.detail
        )
        mock_folder_repo.get_folders_by_ids.assert_awaited_once_with(
            folder_ids=[999], workspace_id=1
        )
        mock_folder_repo.copy_items.assert_not_called()

    @pytest.mark.anyio
    async def test_copy_items_duplicate_folder_ids_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_folder_depth.return_value = 1
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.get_subtree_depth.return_value = 1
        mock_folder_repo.copy_items.return_value = {
            "media_items_copied": 0,
            "source_assets_copied": 0,
            "folders_copied": 1,
            "total_copied": 1,
        }

        dto = CopyItemsDto(
            workspace_id=1,
            folder_ids=[2, 2],
            destination_folder_id=5,
        )

        result = await folder_service.copy_items(dto, sample_user)
        mock_folder_repo.get_folders_by_ids.assert_awaited_once_with(
            folder_ids=[2], workspace_id=1
        )
        mock_folder_repo.copy_items.assert_awaited_once_with(
            workspace_id=1,
            media_item_ids=[],
            source_asset_ids=[],
            folder_ids=[2],
            destination_folder_id=5,
            conflict_strategy=ConflictStrategyEnum.KEEP_BOTH,
            user_id=10,
            user_email="test@example.com",
        )
        assert result["folders_copied"] == 1

    @pytest.mark.anyio
    async def test_copy_items_folder_max_depth_exceeded(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.get_folder_depth.return_value = 19
        mock_folder_repo.get_subtree_depth.return_value = 2

        dto = CopyItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=5,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.copy_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST
        assert (
            "would exceed maximum folder tree depth of 20 levels"
            in exc_info.value.detail
        )

    @pytest.mark.anyio
    async def test_copy_items_to_root_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.get_existing_folders_map.return_value = {}
        mock_folder_repo.copy_items.return_value = {
            "media_items_copied": 0,
            "source_assets_copied": 0,
            "folders_copied": 1,
            "total_copied": 1,
        }

        dto = CopyItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=None,
        )

        result = await folder_service.copy_items(dto, sample_user)
        assert result["total_copied"] == 1
        mock_folder_repo.copy_items.assert_awaited_once_with(
            workspace_id=1,
            media_item_ids=[],
            source_asset_ids=[],
            folder_ids=[2],
            destination_folder_id=None,
            conflict_strategy=ConflictStrategyEnum.KEEP_BOTH,
            user_id=10,
            user_email="test@example.com",
        )

    @pytest.mark.anyio
    async def test_copy_items_conflict_detection_409(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        colliding_folder = Folder(
            id=2,
            workspace_id=1,
            user_email="a@b.com",
            name="ExistingSub",
            parent_id=1,
        )
        target_folder = Folder(
            id=50,
            workspace_id=1,
            user_email="a@b.com",
            name="ExistingSub",
            parent_id=5,
        )
        mock_folder_repo.get_folders_by_ids.return_value = [colliding_folder]
        mock_folder_repo.get_subtree_depth.return_value = 1
        mock_folder_repo.get_folder_depth.return_value = 1
        mock_folder_repo.get_existing_folders_map.return_value = {
            "existingsub": target_folder
        }

        dto = CopyItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=5,
            conflict_strategy=None,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.copy_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_409_CONFLICT
        assert exc_info.value.detail["code"] == "FOLDER_COLLISION"
        assert len(exc_info.value.detail["conflicts"]) == 1
        assert exc_info.value.detail["conflicts"][0]["folder_id"] == 2

    @pytest.mark.anyio
    async def test_copy_items_with_merge_strategy(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_folders_by_ids.return_value = [
            Folder(id=2, workspace_id=1, user_email="a@b.com", name="Folder 2")
        ]
        mock_folder_repo.get_subtree_depth.return_value = 1
        mock_folder_repo.get_folder_depth.return_value = 1
        mock_folder_repo.copy_items.return_value = {
            "media_items_copied": 0,
            "source_assets_copied": 0,
            "folders_copied": 1,
            "total_copied": 1,
        }

        dto = CopyItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=5,
            conflict_strategy=ConflictStrategyEnum.MERGE,
        )

        result = await folder_service.copy_items(dto, sample_user)
        assert result["total_copied"] == 1
        mock_folder_repo.copy_items.assert_awaited_once_with(
            workspace_id=1,
            media_item_ids=[],
            source_asset_ids=[],
            folder_ids=[2],
            destination_folder_id=5,
            conflict_strategy=ConflictStrategyEnum.MERGE,
            user_id=10,
            user_email="test@example.com",
        )


class TestIntegrityErrorClassification:
    """Only exact folder name indexes are 409s; unknown faults propagate."""

    @pytest.mark.anyio
    @pytest.mark.parametrize(
        "constraint_name", [PARENT_NAME_INDEX, ROOT_NAME_INDEX]
    )
    async def test_each_folder_name_index_maps_to_409(
        self, folder_service, mock_folder_repo, sample_user, constraint_name
    ):
        dto = FolderCreateDto(name="Drafts", workspace_id=1, parent_id=None)
        mock_folder_repo.db.commit.side_effect = name_clash(constraint_name)

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_409_CONFLICT

    @pytest.mark.anyio
    async def test_uq_in_the_message_of_another_violation_is_not_409(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """A folder named 'uq_drafts' is in the bound parameters of str(e).

        Substring matching on "uq_" would call this NOT NULL failure a name
        clash, and the client would rename and retry a write that can never
        succeed.
        """
        dto = FolderCreateDto(name="uq_drafts", workspace_id=1, parent_id=None)
        error = db_integrity_error(
            "23502",
            None,
            'null value in column "user_email" of relation "folders" violates '
            "not-null constraint",
            params=(1, 10, None, "uq_drafts", None, None),
        )
        assert "uq_drafts" in str(error)
        mock_folder_repo.db.commit.side_effect = error

        with pytest.raises(IntegrityError) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value is error
        mock_folder_repo.db.rollback.assert_called_once()

    @pytest.mark.anyio
    async def test_foreign_key_violation_maps_to_404(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """Wording comes from the constraint, not the INSERT's column list."""
        dto = FolderCreateDto(name="Drafts", workspace_id=1, parent_id=5)
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Parent"
        )
        mock_folder_repo.db.commit.side_effect = fk_violation(
            "folders_parent_id_fkey", "parent_id"
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        assert "parent folder does not exist" in exc_info.value.detail

    @pytest.mark.anyio
    async def test_unrecognised_error_is_reraised_from_update(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(id=1, workspace_id=1, user_email="a@b.com", name="Old")
        error = check_violation()
        mock_folder_repo.db.commit.side_effect = error

        with pytest.raises(IntegrityError) as exc_info:
            await folder_service.update_folder(
                1, FolderUpdateDto(name="New"), sample_user, folder=folder
            )
        assert exc_info.value is error
        mock_folder_repo.db.rollback.assert_called_once()

    @pytest.mark.anyio
    async def test_move_items_reraises_non_name_integrity_error(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """move_items used to turn every IntegrityError into a 409."""
        error = check_violation()
        mock_folder_repo.move_media_items.side_effect = error
        dto = MoveItemsDto(
            workspace_id=1, media_item_ids=[1], destination_folder_id=None
        )

        with pytest.raises(IntegrityError) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value is error
        mock_folder_repo.db.rollback.assert_called_once()
        mock_folder_repo.db.commit.assert_not_called()


def locked_calls_before_first_write(mock_folder_repo, write_name):
    """Returns the repo calls made between the lock and the first write."""
    names = [c[0] for c in mock_folder_repo.mock_calls]
    lock = names.index("get_folder_for_update")
    write = names.index(write_name)
    assert lock < write
    return names[lock:write]


class TestDestinationRowLock:
    """Destinations are validated from a row locked until the write commits.

    Each test hands the plain read a valid folder and the locked read a
    different answer, so it only passes if validation used the locked row.
    """

    @staticmethod
    def lock_returns(mock_folder_repo, folder):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Stale"
        )
        mock_folder_repo.get_folder_for_update.side_effect = None
        mock_folder_repo.get_folder_for_update.return_value = folder

    @pytest.mark.anyio
    @pytest.mark.parametrize(
        "locked",
        [
            None,  # soft-deleted after the plain read
            Folder(id=5, workspace_id=2, user_email="a@b.com", name="Moved"),
        ],
    )
    async def test_move_items_validates_the_locked_destination(
        self, folder_service, mock_folder_repo, sample_user, locked
    ):
        self.lock_returns(mock_folder_repo, locked)
        dto = MoveItemsDto(
            workspace_id=1, media_item_ids=[1], destination_folder_id=5
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        mock_folder_repo.get_folder_for_update.assert_awaited_once_with(5)
        mock_folder_repo.move_media_items.assert_not_called()

    @pytest.mark.anyio
    async def test_move_items_holds_the_lock_into_the_write_transaction(
        self, folder_service, mock_folder_repo, sample_user
    ):
        self.lock_returns(
            mock_folder_repo,
            Folder(id=5, workspace_id=1, user_email="a@b.com", name="D"),
        )
        mock_folder_repo.move_media_items.return_value = 1
        mock_folder_repo.move_source_assets.return_value = 0
        mock_folder_repo.move_folders.return_value = 0
        dto = MoveItemsDto(
            workspace_id=1, media_item_ids=[1], destination_folder_id=5
        )

        await folder_service.move_items(dto, sample_user)

        between = locked_calls_before_first_write(
            mock_folder_repo, "move_media_items"
        )
        # A commit or rollback here would release the lock before the write.
        assert "db.commit" not in between
        assert "db.rollback" not in between
        mock_folder_repo.get_folder_by_id.assert_not_called()
        mock_folder_repo.db.commit.assert_awaited_once()

    @pytest.mark.anyio
    @pytest.mark.parametrize(
        "locked",
        [
            None,
            Folder(id=5, workspace_id=2, user_email="a@b.com", name="Moved"),
        ],
    )
    async def test_copy_items_validates_the_locked_destination(
        self, folder_service, mock_folder_repo, sample_user, locked
    ):
        self.lock_returns(mock_folder_repo, locked)
        dto = CopyItemsDto(
            workspace_id=1, media_item_ids=[1], destination_folder_id=5
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.copy_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        mock_folder_repo.get_folder_for_update.assert_awaited_once_with(5)
        mock_folder_repo.copy_items.assert_not_called()

    @pytest.mark.anyio
    async def test_copy_items_holds_the_lock_into_the_write_transaction(
        self, folder_service, mock_folder_repo, sample_user
    ):
        self.lock_returns(
            mock_folder_repo,
            Folder(id=5, workspace_id=1, user_email="a@b.com", name="D"),
        )
        dto = CopyItemsDto(
            workspace_id=1, media_item_ids=[1], destination_folder_id=5
        )

        await folder_service.copy_items(dto, sample_user)

        between = locked_calls_before_first_write(
            mock_folder_repo, "copy_items"
        )
        assert "db.commit" not in between
        assert "db.rollback" not in between
        mock_folder_repo.get_folder_by_id.assert_not_called()

    @pytest.mark.anyio
    async def test_create_folder_validates_the_locked_parent(
        self, folder_service, mock_folder_repo, sample_user
    ):
        self.lock_returns(
            mock_folder_repo,
            Folder(id=5, workspace_id=2, user_email="a@b.com", name="Moved"),
        )
        dto = FolderCreateDto(name="Child", workspace_id=1, parent_id=5)

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.create_folder(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        mock_folder_repo.get_folder_for_update.assert_awaited_once_with(5)
        mock_folder_repo.db.commit.assert_not_called()

    @pytest.mark.anyio
    async def test_update_folder_validates_the_locked_new_parent(
        self, folder_service, mock_folder_repo, sample_user
    ):
        self.lock_returns(
            mock_folder_repo,
            Folder(id=5, workspace_id=2, user_email="a@b.com", name="Moved"),
        )
        folder = Folder(
            id=1, workspace_id=1, user_email="a@b.com", name="F", parent_id=None
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(
                1, FolderUpdateDto(parent_id=5), sample_user, folder=folder
            )
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        mock_folder_repo.get_folder_for_update.assert_awaited_once_with(5)
        mock_folder_repo.db.commit.assert_not_called()
