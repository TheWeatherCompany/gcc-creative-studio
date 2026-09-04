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

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
import pytest
from fastapi import HTTPException, status
from sqlalchemy.exc import IntegrityError

from src.folders.dto.folder_dto import (
    FolderBreadcrumbDto,
    FolderCreateDto,
    FolderResponseDto,
    FolderTreeNodeDto,
    FolderUpdateDto,
    MoveItemsDto,
)
from src.folders.folder_service import FolderService
from src.folders.repository.folder_repository import FolderRepository
from src.folders.schema.folder_model import Folder
from src.users.user_model import UserModel, UserRoleEnum


@pytest.fixture(name="mock_folder_repo")
def fixture_mock_folder_repo():
    """Provides a mocked FolderRepository."""
    mock = AsyncMock()
    mock.db = AsyncMock()
    mock.is_folder_name_taken.return_value = False
    # The move_items ownership gate iterates these, so they must default to
    # empty lists rather than a bare AsyncMock's non-iterable return value.
    mock.get_media_items_by_ids.return_value = []
    mock.get_source_assets_by_ids.return_value = []
    mock.get_folders_by_ids.return_value = []
    return mock


@pytest.fixture(name="folder_service")
def fixture_folder_service(mock_folder_repo):
    """Provides a FolderService instance."""
    return FolderService(folder_repo=mock_folder_repo)


@pytest.fixture(name="mock_db")
def fixture_mock_db():
    """Provides a mocked AsyncSession."""
    return AsyncMock()


@pytest.fixture(name="db_folder_service")
def fixture_db_folder_service(mock_db):
    """FolderService over a real repository, so the SQL result shapes and the
    commit boundary are exercised instead of mocked away."""
    return FolderService(folder_repo=FolderRepository(db=mock_db))


def scalars_result(rows: list) -> MagicMock:
    """Result shaped the way the by-ids ownership reads consume it."""
    result = MagicMock()
    result.scalars.return_value.all.return_value = rows
    return result


def db_result_for_folder(folder: Folder | None) -> MagicMock:
    """Result shaped the way FolderRepository.get_folder_by_id reads it."""
    result = MagicMock()
    result.scalars.return_value.first.return_value = folder
    return result


def db_result_for_counts(
    folder: Folder,
    media_count: int = 0,
    asset_count: int = 0,
    subfolder_count: int = 0,
) -> MagicMock:
    """Result shaped the way FolderRepository.list_by_parent reads it."""
    result = MagicMock()
    result.all.return_value = [
        (folder, media_count, asset_count, subfolder_count)
    ]
    return result


def db_result_for_ids(folder_ids: list[int]) -> MagicMock:
    """Result shaped the way the recursive descendant CTE returns rows."""
    result = MagicMock()
    result.fetchall.return_value = [
        SimpleNamespace(id=folder_id) for folder_id in folder_ids
    ]
    return result


def integrity_error(constraint_name: str) -> IntegrityError:
    """Builds an IntegrityError shaped the way asyncpg really raises one.

    This project runs on asyncpg, where ``exc.orig`` is a SQLAlchemy adapter
    exposing only ``sqlstate``/``pgcode`` and the constraint name lives on the
    wrapped ``asyncpg`` error reachable via ``__cause__``. An earlier version
    of this helper invented an ``exc.orig.diag`` attribute, which asyncpg never
    produces, so the tests passed while the production extraction always
    yielded None.
    """
    cause = SimpleNamespace(constraint_name=constraint_name, sqlstate="23505")
    orig = SimpleNamespace(sqlstate="23505")
    orig.__cause__ = cause
    return IntegrityError("UPDATE folders ...", {}, orig)


async def expect_delete_conflict(
    service: FolderService,
    mock_db: AsyncMock,
    folder: Folder,
    user: UserModel,
    media_count: int = 0,
    asset_count: int = 0,
    subfolder_count: int = 0,
) -> None:
    """Asserts delete_folder refuses with a 409 and writes nothing."""
    mock_db.execute.side_effect = [
        db_result_for_folder(folder),  # FOR UPDATE lock on the folder
        db_result_for_folder(folder),
        db_result_for_counts(folder, media_count, asset_count, subfolder_count),
    ]

    with pytest.raises(HTTPException) as exc_info:
        await service.delete_folder(folder.id, user)

    assert exc_info.value.status_code == status.HTTP_409_CONFLICT
    assert exc_info.value.detail == (
        "Folder is not empty. Move or delete its contents first."
    )
    # Nothing was soft deleted and nothing was detached: the lock read and the
    # two count reads are all that ran, and no transaction committed.
    assert mock_db.execute.await_count == 3
    mock_db.commit.assert_not_called()


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
    async def test_create_folder_reraises_a_foreign_key_violation(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """Only the folder-name indexes mean "duplicate name"."""
        dto = FolderCreateDto(name="New", workspace_id=999, parent_id=None)
        mock_folder_repo.db.commit.side_effect = integrity_error(
            "folders_workspace_id_fkey"
        )

        # Reported as-is, not disguised as a retryable 409: renaming would
        # never fix a bad workspace_id.
        with pytest.raises(IntegrityError):
            await folder_service.create_folder(dto, sample_user)
        mock_folder_repo.db.rollback.assert_awaited_once()

    @pytest.mark.anyio
    async def test_create_folder_still_409s_on_a_name_index(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """The race that the pre-check missed is still a 409."""
        dto = FolderCreateDto(name="Existing", workspace_id=1, parent_id=None)
        mock_folder_repo.db.commit.side_effect = integrity_error(
            "uq_folders_workspace_root_name_active"
        )

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
        mock_folder_repo.list_by_parent.return_value = [
            FolderResponseDto(
                id=1,
                workspace_id=1,
                user_email="a@b.com",
                name="F1",
                parent_id=None,
                item_count=10,
            )
        ]

        result = await folder_service.get_folder_by_id(folder_id=1)
        assert result.id == 1
        assert result.item_count == 10

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
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=2, workspace_id=1, user_email="a@b.com", name="Sub"
        )
        mock_folder_repo.get_breadcrumbs.return_value = [
            FolderBreadcrumbDto(id=1, name="Root", parent_id=None),
            FolderBreadcrumbDto(id=2, name="Sub", parent_id=1),
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
        mock_folder_repo.get_folder_by_id.return_value = None

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.get_breadcrumbs(folder_id=999)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND

    @pytest.mark.anyio
    async def test_get_breadcrumbs_workspace_mismatch(
        self, folder_service, mock_folder_repo
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=2, workspace_id=2, user_email="a@b.com", name="Sub"
        )

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
            user_id=10,
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Old Name",
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
    async def test_update_name_conflict_error(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            user_id=10,
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Old Name",
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
            user_id=10,
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Old Name",
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
            user_id=10,
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Colliding",
            parent_id=None,
        )
        target_parent = Folder(
            user_id=10,
            id=5,
            workspace_id=1,
            user_email="a@b.com",
            name="TargetParent",
            parent_id=None,
        )
        mock_folder_repo.get_folder_by_id.side_effect = lambda fid: (
            folder if fid == 1 else target_parent
        )
        mock_folder_repo.get_folder_for_update.side_effect = lambda fid: (
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
            user_id=10,
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Parent",
        )
        child = Folder(
            user_id=10, id=3, workspace_id=1, user_email="a@b.com", name="Child"
        )
        mock_folder_repo.get_folder_by_id.side_effect = lambda fid: (
            folder if fid == 1 else child
        )
        mock_folder_repo.get_folder_for_update.side_effect = lambda fid: (
            folder if fid == 1 else child
        )
        # Child 3 is a descendant of 1
        mock_folder_repo.get_descendant_ids.return_value = [1, 2, 3]

        dto = FolderUpdateDto(parent_id=3)
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.anyio
    async def test_update_folder_move_locks_before_descendant_read(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """The cycle check reads descendants only after both rows are locked."""
        folder = Folder(
            user_id=10, id=9, workspace_id=1, user_email="a@b.com", name="Mover"
        )
        target_parent = Folder(
            user_id=10,
            id=4,
            workspace_id=1,
            user_email="a@b.com",
            name="Target",
        )
        calls: list[str] = []

        async def fake_lock(folder_id):
            calls.append(f"lock:{folder_id}")
            return folder if folder_id == 9 else target_parent

        async def fake_descendants(folder_id):
            calls.append(f"descendants:{folder_id}")
            return []

        mock_folder_repo.get_folder_by_id.return_value = folder
        mock_folder_repo.get_folder_for_update.side_effect = fake_lock
        mock_folder_repo.get_descendant_ids.side_effect = fake_descendants
        mock_folder_repo.get_unique_folder_name.return_value = "Mover"
        mock_folder_repo.list_by_parent.return_value = []

        dto = FolderUpdateDto(parent_id=4)
        await folder_service.update_folder(9, dto, sample_user)

        # Locks first, in ascending id order so concurrent movers queue rather
        # than deadlock, and only then the descendant read they protect.
        assert calls == ["lock:4", "lock:9", "descendants:9"]
        assert folder.parent_id == 4

    @pytest.mark.anyio
    async def test_update_folder_move_missing_folder_lock_404s(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """A folder soft deleted between the read and the lock is a 404."""
        folder = Folder(
            user_id=10, id=1, workspace_id=1, user_email="a@b.com", name="Mover"
        )
        target_parent = Folder(
            user_id=10,
            id=5,
            workspace_id=1,
            user_email="a@b.com",
            name="Target",
        )
        mock_folder_repo.get_folder_by_id.return_value = folder
        mock_folder_repo.get_folder_for_update.side_effect = lambda fid: (
            None if fid == 1 else target_parent
        )

        dto = FolderUpdateDto(parent_id=5)
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        mock_folder_repo.get_descendant_ids.assert_not_called()

    @pytest.mark.anyio
    async def test_update_parent_itself_error(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(
            user_id=10,
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Parent",
        )
        mock_folder_repo.get_folder_by_id.return_value = folder

        dto = FolderUpdateDto(parent_id=1)
        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(1, dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_400_BAD_REQUEST

    @pytest.mark.anyio
    async def test_update_folder_refuses_another_users_folder(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """PATCH reaches the same reparent sink move_items now guards.

        The controller proves workspace membership only, so without this a
        member could rename or reparent another member's folder through the
        one endpoint the move_items gate does not cover.
        """
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=1,
            workspace_id=1,
            user_id=sample_user.id + 1,
            user_email="other@b.com",
            name="Theirs",
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.update_folder(
                1, FolderUpdateDto(name="Mine now"), sample_user
            )
        assert exc_info.value.status_code == status.HTTP_403_FORBIDDEN
        mock_folder_repo.db.commit.assert_not_called()

    @pytest.mark.anyio
    async def test_update_folder_allows_an_admin(
        self, folder_service, mock_folder_repo
    ):
        """Admins keep the override here too."""
        admin = UserModel(
            id=99,
            email="admin@example.com",
            roles=[UserRoleEnum.ADMIN],
            name="Admin",
        )
        folder = Folder(
            id=1,
            workspace_id=1,
            user_id=1,
            user_email="other@b.com",
            name="Theirs",
        )
        mock_folder_repo.get_folder_by_id.return_value = folder
        mock_folder_repo.list_by_parent.return_value = [
            FolderResponseDto(
                id=1,
                workspace_id=1,
                user_email="other@b.com",
                name="Renamed",
                parent_id=None,
                item_count=0,
                subfolder_count=0,
            )
        ]

        result = await folder_service.update_folder(
            1, FolderUpdateDto(name="Renamed"), admin
        )
        assert result.name == "Renamed"


class TestDeleteFolder:
    """Tests for FolderService.delete_folder."""

    @pytest.mark.anyio
    async def test_delete_empty_folder_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        folder = Folder(id=1, workspace_id=1, user_email="a@b.com", name="F")
        mock_folder_repo.get_folder_by_id.return_value = folder
        mock_folder_repo.list_by_parent.return_value = [
            FolderResponseDto(
                id=1,
                workspace_id=1,
                user_email="a@b.com",
                name="F",
                parent_id=None,
                item_count=0,
                subfolder_count=0,
            )
        ]
        mock_folder_repo.soft_delete.return_value = True

        result = await folder_service.delete_folder(1, sample_user)
        assert result["success"] is True
        mock_folder_repo.soft_delete.assert_called_once_with(
            folder_id=1, user_id=sample_user.id, commit=True
        )
        # The row is locked before anything is read, and trashed contents are
        # detached inside the same transaction as the soft delete.
        mock_folder_repo.get_folder_for_update.assert_awaited_once_with(1)
        mock_folder_repo.release_trashed_contents.assert_awaited_once_with(
            folder_id=1, commit=False
        )

    @pytest.mark.anyio
    async def test_delete_folder_not_found(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """A missing folder is a 404, not a 409."""
        mock_folder_repo.get_folder_by_id.return_value = None

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.delete_folder(999, sample_user)
        assert exc_info.value.status_code == status.HTTP_404_NOT_FOUND
        mock_folder_repo.soft_delete.assert_not_called()

    @pytest.mark.anyio
    async def test_delete_folder_shares_one_transaction(
        self, db_folder_service, mock_db, sample_user
    ):
        """The emptiness check and the soft delete commit exactly once."""
        folder = Folder(
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Empty",
            parent_id=None,
        )
        mock_db.execute.side_effect = [
            db_result_for_folder(folder),  # FOR UPDATE lock on the folder
            db_result_for_folder(folder),  # folder lookup
            db_result_for_counts(folder),  # item and subfolder counts
            MagicMock(),  # release trashed media items
            MagicMock(),  # release trashed source assets
            db_result_for_ids([1]),  # descendant ids for the soft delete
            MagicMock(),  # the soft delete UPDATE itself
        ]

        result = await db_folder_service.delete_folder(1, sample_user)

        assert result["success"] is True
        assert mock_db.commit.await_count == 1

    @pytest.mark.anyio
    async def test_delete_folder_conflict_with_media_item(
        self, db_folder_service, mock_db, sample_user
    ):
        folder = Folder(
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Has media",
            parent_id=None,
        )
        await expect_delete_conflict(
            db_folder_service, mock_db, folder, sample_user, media_count=1
        )

    @pytest.mark.anyio
    async def test_delete_folder_conflict_with_source_asset(
        self, db_folder_service, mock_db, sample_user
    ):
        folder = Folder(
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Has asset",
            parent_id=None,
        )
        await expect_delete_conflict(
            db_folder_service, mock_db, folder, sample_user, asset_count=1
        )

    @pytest.mark.anyio
    async def test_delete_folder_conflict_with_direct_subfolder(
        self, db_folder_service, mock_db, sample_user
    ):
        folder = Folder(
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Has subfolder",
            parent_id=None,
        )
        await expect_delete_conflict(
            db_folder_service, mock_db, folder, sample_user, subfolder_count=1
        )

    @pytest.mark.anyio
    async def test_delete_folder_conflict_with_deeper_descendants(
        self, db_folder_service, mock_db, sample_user
    ):
        """A subtree that only holds content further down is still refused."""
        folder = Folder(
            id=1,
            workspace_id=1,
            user_email="a@b.com",
            name="Grandparent",
            parent_id=None,
        )
        # Folder 1 holds no items itself; its single child holds the grandchild
        # that owns the media. The direct subfolder count is what catches it,
        # so no recursive count is needed to keep the subtree from stranding.
        await expect_delete_conflict(
            db_folder_service, mock_db, folder, sample_user, subfolder_count=1
        )


class TestMoveItems:
    """Tests for FolderService.move_items."""

    @pytest.mark.anyio
    async def test_move_items_success(
        self, folder_service, mock_folder_repo, sample_user
    ):
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_descendant_ids.return_value = [2]
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
        # The repository writes must not commit on their own any more.
        for repo_call in (
            mock_folder_repo.move_media_items,
            mock_folder_repo.move_source_assets,
            mock_folder_repo.move_folders,
        ):
            assert repo_call.await_args.kwargs["commit"] is False
        mock_folder_repo.db.commit.assert_awaited_once()

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
    async def test_move_items_rejects_another_users_media_item(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """Workspace membership alone must not let you move someone's item."""
        mock_folder_repo.get_media_items_by_ids.return_value = [
            SimpleNamespace(id=10, user_id=sample_user.id + 1)
        ]
        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[10],
            source_asset_ids=[],
            folder_ids=[],
            destination_folder_id=None,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_403_FORBIDDEN
        mock_folder_repo.db.commit.assert_not_called()
        # Rejected before any lock is taken.
        mock_folder_repo.get_folder_for_update.assert_not_called()

    @pytest.mark.anyio
    async def test_move_items_rejects_another_users_folder_at_root(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """The gate cannot depend on the cycle-check lock.

        A move to root takes no lock at all, so an authorization check placed
        inside that branch would never run for this request.
        """
        mock_folder_repo.get_folders_by_ids.return_value = [
            SimpleNamespace(id=7, user_id=sample_user.id + 1)
        ]
        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[],
            source_asset_ids=[],
            folder_ids=[7],
            destination_folder_id=None,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_403_FORBIDDEN
        mock_folder_repo.move_folders.assert_not_called()

    @pytest.mark.anyio
    async def test_move_items_treats_an_unowned_row_as_not_yours(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """A NULL owner needs an admin, matching the subtree gate."""
        mock_folder_repo.get_media_items_by_ids.return_value = [
            SimpleNamespace(id=10, user_id=None)
        ]
        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[10],
            source_asset_ids=[],
            folder_ids=[],
            destination_folder_id=None,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_403_FORBIDDEN

    @pytest.mark.anyio
    async def test_move_items_admin_skips_the_ownership_reads(
        self, folder_service, mock_folder_repo
    ):
        """Admins keep their override and pay nothing for the check."""
        admin = UserModel(
            id=1,
            email="admin@example.com",
            roles=[UserRoleEnum.ADMIN],
            name="Admin",
        )
        mock_folder_repo.move_media_items.return_value = 1
        mock_folder_repo.move_source_assets.return_value = 0
        mock_folder_repo.move_folders.return_value = 0
        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[10],
            source_asset_ids=[],
            folder_ids=[],
            destination_folder_id=None,
        )

        result = await folder_service.move_items(dto, admin)

        assert result["total_moved"] == 1
        mock_folder_repo.get_media_items_by_ids.assert_not_called()
        mock_folder_repo.get_folders_by_ids.assert_not_called()

    @pytest.mark.anyio
    async def test_move_items_commits_exactly_once(
        self, db_folder_service, mock_db, sample_user
    ):
        """All three repository writes land in a single transaction."""
        destination = Folder(
            id=5,
            workspace_id=1,
            user_email="a@b.com",
            name="Target",
            parent_id=None,
        )
        moving = Folder(
            id=2,
            workspace_id=1,
            user_email="a@b.com",
            name="Moving",
            parent_id=None,
        )
        folders_to_move = MagicMock()
        folders_to_move.scalars.return_value.all.return_value = [moving]
        sibling_names = MagicMock()
        sibling_names.fetchall.return_value = []

        # The ownership gate reads all three id lists before any lock is
        # taken; every row belongs to sample_user, so the batch is allowed.
        owned = scalars_result([SimpleNamespace(user_id=sample_user.id)])

        mock_db.execute.side_effect = [
            db_result_for_folder(destination),  # destination lookup
            owned,  # ownership: media items
            owned,  # ownership: source assets
            owned,  # ownership: folders
            db_result_for_folder(moving),  # lock folder 2 (ascending order)
            db_result_for_folder(destination),  # lock folder 5
            db_result_for_ids([2]),  # cycle check on folder 2
            MagicMock(rowcount=2),  # media item UPDATE
            MagicMock(rowcount=1),  # source asset UPDATE
            folders_to_move,  # folders selected for the move
            sibling_names,  # destination sibling names
        ]

        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[10, 11],
            source_asset_ids=[20],
            folder_ids=[2],
            destination_folder_id=5,
        )
        result = await db_folder_service.move_items(dto, sample_user)

        assert result == {
            "media_items_moved": 2,
            "source_assets_moved": 1,
            "folders_moved": 1,
            "total_moved": 4,
        }
        assert moving.parent_id == 5
        # One commit for three writes, and none of them rolled back.
        assert mock_db.commit.await_count == 1
        mock_db.rollback.assert_not_called()

    @pytest.mark.anyio
    async def test_move_items_name_conflict_rolls_back(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """A name clash at the destination is a 409 and nothing sticks."""
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.get_descendant_ids.return_value = [2]
        mock_folder_repo.db.commit.side_effect = integrity_error(
            "uq_folders_workspace_parent_name_active"
        )

        dto = MoveItemsDto(
            workspace_id=1,
            folder_ids=[2],
            destination_folder_id=5,
        )

        with pytest.raises(HTTPException) as exc_info:
            await folder_service.move_items(dto, sample_user)
        assert exc_info.value.status_code == status.HTTP_409_CONFLICT
        assert exc_info.value.detail == (
            "A folder with this name already exists at the destination."
        )
        mock_folder_repo.db.rollback.assert_awaited_once()

    @pytest.mark.anyio
    async def test_move_items_other_integrity_error_propagates(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """Only the two folder name indexes map to a 409."""
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.db.commit.side_effect = integrity_error(
            "media_items_folder_id_fkey"
        )

        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[10],
            destination_folder_id=5,
        )

        with pytest.raises(IntegrityError):
            await folder_service.move_items(dto, sample_user)
        mock_folder_repo.db.rollback.assert_awaited_once()

    @pytest.mark.anyio
    async def test_move_items_unexpected_error_rolls_back(
        self, folder_service, mock_folder_repo, sample_user
    ):
        """Any failure rolls the whole move back instead of half applying."""
        mock_folder_repo.get_folder_by_id.return_value = Folder(
            id=5, workspace_id=1, user_email="a@b.com", name="Target"
        )
        mock_folder_repo.move_source_assets.side_effect = RuntimeError("boom")

        dto = MoveItemsDto(
            workspace_id=1,
            media_item_ids=[10],
            source_asset_ids=[20],
            destination_folder_id=5,
        )

        with pytest.raises(RuntimeError):
            await folder_service.move_items(dto, sample_user)
        mock_folder_repo.db.commit.assert_not_called()
        mock_folder_repo.db.rollback.assert_awaited_once()
