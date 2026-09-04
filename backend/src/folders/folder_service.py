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

"""Service for folder business logic and validations."""

import logging
from fastapi import Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from src.folders.dto.folder_dto import (
    FolderBreadcrumbDto,
    FolderCreateDto,
    FolderResponseDto,
    FolderTreeNodeDto,
    FolderUpdateDto,
    MoveItemsDto,
)
from src.folders.repository.folder_repository import FolderRepository
from src.common.db_errors import constraint_name_of
from src.folders.schema.folder_model import Folder
from src.users.user_model import UserModel, UserRoleEnum

logger = logging.getLogger(__name__)

# The partial unique indexes that guard folder names. Only these two map to a
# 409; any other IntegrityError is a genuine fault and has to propagate.
FOLDER_NAME_CONSTRAINTS = frozenset(
    {
        "uq_folders_workspace_parent_name_active",
        "uq_folders_workspace_root_name_active",
    }
)


def _is_folder_name_conflict(exc: IntegrityError) -> bool:
    """Reports whether an IntegrityError is a folder name uniqueness clash."""
    return constraint_name_of(exc) in FOLDER_NAME_CONSTRAINTS


class FolderService:
    """Service layer handling validation, hierarchy integrity, and business logic for folders."""

    def __init__(self, folder_repo: FolderRepository = Depends()):
        self.folder_repo = folder_repo

    async def create_folder(
        self, dto: FolderCreateDto, user: UserModel
    ) -> FolderResponseDto:
        """Creates a new folder after validating parent folder and name uniqueness."""
        name = dto.name.strip()
        if not name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Folder name cannot be empty.",
            )

        if dto.parent_id is not None:
            parent = await self.folder_repo.get_folder_by_id(dto.parent_id)
            if not parent or parent.workspace_id != dto.workspace_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Parent folder not found in this workspace.",
                )

        if await self.folder_repo.is_folder_name_taken(
            workspace_id=dto.workspace_id,
            parent_id=dto.parent_id,
            name=name,
        ):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A folder named '{name}' already exists in this location.",
            )

        folder = Folder(
            workspace_id=dto.workspace_id,
            user_id=user.id,
            user_email=user.email,
            name=name,
            parent_id=dto.parent_id,
            color=dto.color,
        )
        try:
            self.folder_repo.db.add(folder)
            await self.folder_repo.db.commit()
            await self.folder_repo.db.refresh(folder)
        except IntegrityError as e:
            await self.folder_repo.db.rollback()
            # Only the two folder-name indexes mean "duplicate name". Anything
            # else (a bad parent_id or workspace_id foreign key, a NOT NULL
            # violation) is a real fault, and reporting it as a name conflict
            # would tell the client to rename and retry forever.
            if not _is_folder_name_conflict(e):
                raise
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A folder named '{name}' already exists in this location.",
            ) from e

        return FolderResponseDto(
            id=folder.id,
            workspace_id=folder.workspace_id,
            user_id=folder.user_id,
            user_email=folder.user_email,
            name=folder.name,
            parent_id=folder.parent_id,
            color=folder.color,
            item_count=0,
            subfolder_count=0,
            created_at=folder.created_at,
            updated_at=folder.updated_at,
        )

    async def get_folders(
        self, workspace_id: int, parent_id: int | None = None
    ) -> list[FolderResponseDto]:
        """Lists folders within a workspace under the specified parent or root."""
        return await self.folder_repo.list_by_parent(
            workspace_id=workspace_id, parent_id=parent_id
        )

    async def get_folder_by_id(
        self, folder_id: int, workspace_id: int | None = None
    ) -> FolderResponseDto:
        """Fetch folder by ID with item and subfolder counts."""
        folder = await self.folder_repo.get_folder_by_id(folder_id)
        if not folder or (
            workspace_id is not None and folder.workspace_id != workspace_id
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Folder with ID {folder_id} not found in this workspace.",
            )

        # Get counts
        folders = await self.folder_repo.list_by_parent(
            workspace_id=folder.workspace_id, parent_id=folder.parent_id
        )
        matched = next((f for f in folders if f.id == folder_id), None)
        if matched:
            return matched

        return FolderResponseDto(
            id=folder.id,
            workspace_id=folder.workspace_id,
            user_id=folder.user_id,
            user_email=folder.user_email,
            name=folder.name,
            parent_id=folder.parent_id,
            color=folder.color,
            item_count=0,
            subfolder_count=0,
            created_at=folder.created_at,
            updated_at=folder.updated_at,
        )

    async def get_breadcrumbs(
        self, folder_id: int, workspace_id: int | None = None
    ) -> list[FolderBreadcrumbDto]:
        """Fetch ancestor breadcrumb trail from root to the given folder."""
        folder = await self.folder_repo.get_folder_by_id(folder_id)
        if not folder or (
            workspace_id is not None and folder.workspace_id != workspace_id
        ):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Folder with ID {folder_id} not found in this workspace.",
            )
        return await self.folder_repo.get_breadcrumbs(folder_id)

    async def get_folder_tree(
        self, workspace_id: int
    ) -> list[FolderTreeNodeDto]:
        """Returns the full hierarchical tree of folders in a workspace."""
        return await self.folder_repo.get_tree(workspace_id)

    async def update_folder(
        self, folder_id: int, dto: FolderUpdateDto, user: UserModel
    ) -> FolderResponseDto:
        """Updates a folder name, color, or parent hierarchy with collision checks and auto-disambiguation."""
        folder = await self.folder_repo.get_folder_by_id(folder_id)
        if not folder:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Folder with ID {folder_id} not found.",
            )

        # The controller only proves workspace membership. This route can
        # rename and reparent, reaching the same sink move_items guards, so
        # without an owner check a member could reorganise another member's
        # hierarchy through the endpoint that move_items does not cover.
        if UserRoleEnum.ADMIN not in user.roles and folder.user_id != user.id:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="You are not authorized to modify this folder.",
            )

        is_moving = False
        new_parent_id = folder.parent_id

        # Handle moving folder to a new parent
        if dto.parent_id is not None or "parent_id" in dto.model_fields_set:
            new_parent_id = dto.parent_id
            if new_parent_id == folder.id:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail="A folder cannot be its own parent.",
                )

            if new_parent_id is not None:
                # Serialise the cycle check with the write it guards: lock the
                # moving folder and the target parent before reading the
                # descendant set and hold both locks through the parent_id
                # write and the commit below. Two moves that would jointly
                # form a cycle contend for the same two rows, so the second
                # one re-reads the descendants only after the first committed.
                locked = await self._lock_folders_for_move(
                    folder_id=folder.id, parent_id=new_parent_id
                )
                if folder.id not in locked:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail=f"Folder with ID {folder_id} not found.",
                    )

                parent = locked.get(new_parent_id)
                if not parent or parent.workspace_id != folder.workspace_id:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Target parent folder not found in this workspace.",
                    )

                # Prevent cycles: cannot move folder into its own subtree
                descendant_ids = await self.folder_repo.get_descendant_ids(
                    folder.id
                )
                if new_parent_id in descendant_ids:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="Cannot move a folder into one of its own subfolders.",
                    )

            if new_parent_id != folder.parent_id:
                is_moving = True
                folder.parent_id = new_parent_id

        target_name = dto.name.strip() if dto.name is not None else folder.name
        if not target_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Folder name cannot be empty.",
            )

        if is_moving:
            # Auto-disambiguate on move if colliding in target location
            unique_name = await self.folder_repo.get_unique_folder_name(
                workspace_id=folder.workspace_id,
                parent_id=new_parent_id,
                base_name=target_name,
                exclude_folder_id=folder.id,
            )
            folder.name = unique_name
        else:
            # Standard Rename (within same parent)
            if dto.name is not None and target_name != folder.name:
                if await self.folder_repo.is_folder_name_taken(
                    workspace_id=folder.workspace_id,
                    parent_id=folder.parent_id,
                    name=target_name,
                    exclude_folder_id=folder.id,
                ):
                    raise HTTPException(
                        status_code=status.HTTP_409_CONFLICT,
                        detail=f"A folder named '{target_name}' already exists in this location.",
                    )
                folder.name = target_name

        if dto.color is not None:
            folder.color = dto.color

        # Read the name for the error message BEFORE committing: a rollback
        # expires every attribute on the instance, so touching folder.name in
        # the handler would trigger a lazy refresh on a rolled-back async
        # session and raise MissingGreenlet, turning this 409 into a 500.
        attempted_name = folder.name
        try:
            await self.folder_repo.db.commit()
            await self.folder_repo.db.refresh(folder)
        except IntegrityError as e:
            await self.folder_repo.db.rollback()
            # See create_folder: misclassifying any other integrity failure as
            # a name conflict hides the real fault behind a retryable 409.
            if not _is_folder_name_conflict(e):
                raise
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A folder named '{attempted_name}' already exists in this location.",
            ) from e

        return await self.get_folder_by_id(folder.id)

    async def _lock_folders_for_move(
        self, folder_id: int, parent_id: int
    ) -> dict[int, Folder]:
        """Row-locks a folder and its target parent in ascending ID order."""
        # Ascending ID order gives every concurrent mover the same lock order,
        # so two moves over the same pair of folders queue instead of
        # deadlocking. Missing entries mean the row is gone or soft-deleted.
        locked: dict[int, Folder] = {}
        for lock_id in sorted({folder_id, parent_id}):
            row = await self.folder_repo.get_folder_for_update(lock_id)
            if row is not None:
                locked[lock_id] = row
        return locked

    async def delete_folder(
        self, folder_id: int, user: UserModel
    ) -> dict[str, bool]:
        """Soft deletes an empty folder, refusing a non-empty one."""
        # Lock the row before reading anything. A plain SELECT, which is all
        # the count queries run, is never blocked by another transaction's
        # row lock under PostgreSQL's default READ COMMITTED, so without this
        # the emptiness check and the soft delete could straddle a concurrent
        # move's commit and delete a folder that just gained content. This is
        # the same lock _lock_folders_for_move and move_items take on a
        # destination folder, so the two now queue on one row.
        await self.folder_repo.get_folder_for_update(folder_id)

        # Raises 404 when the folder is missing or already soft-deleted. This
        # read, the emptiness check and the soft delete all run inside one
        # transaction with no commit between them; soft_delete keeps its
        # single trailing commit.
        folder = await self.get_folder_by_id(folder_id=folder_id)

        # Direct counts are enough to prove "fully empty": a subtree holding
        # anything at all still shows a non-zero subfolder_count here. A soft
        # delete would only stamp deleted_at on the folder rows and would
        # strand the contained media items and source assets, so refuse.
        if folder.item_count > 0 or folder.subfolder_count > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "Folder is not empty. Move or delete its contents first."
                ),
            )

        # The counts above only see live rows, so a folder holding nothing
        # but already-trashed items still passes. soft_delete stamps only the
        # folder rows, so detach those contents first; otherwise restoring
        # one later leaves folder_id pointing at a folder that no longer
        # resolves in either the folder view or the root view.
        await self.folder_repo.release_trashed_contents(
            folder_id=folder_id, commit=False
        )

        success = await self.folder_repo.soft_delete(
            folder_id=folder_id, user_id=user.id, commit=True
        )
        return {"success": success}

    async def _authorize_move_items(
        self, dto: MoveItemsDto, user: UserModel
    ) -> None:
        """Rejects the whole batch unless the caller owns every item.

        Mirrors the admin-or-owner gate gallery_service._authorize_item_move
        applies to cross-workspace moves. Ids that resolve to no row in this
        workspace are ignored: the move_* calls already skip ids outside the
        workspace, and a missing row is a not-found concern rather than an
        authorization one. A NULL owner is treated as not-yours, matching the
        subtree gate, so system-owned rows need an admin.
        """
        if UserRoleEnum.ADMIN in user.roles:
            return

        rows = []
        rows += await self.folder_repo.get_media_items_by_ids(
            media_item_ids=dto.media_item_ids,
            workspace_id=dto.workspace_id,
        )
        rows += await self.folder_repo.get_source_assets_by_ids(
            source_asset_ids=dto.source_asset_ids,
            workspace_id=dto.workspace_id,
        )
        rows += await self.folder_repo.get_folders_by_ids(
            folder_ids=dto.folder_ids,
            workspace_id=dto.workspace_id,
        )

        if any(row.user_id != user.id for row in rows):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    "You are not authorized to move one or more of the"
                    " requested items."
                ),
            )

    async def move_items(
        self, dto: MoveItemsDto, user: UserModel
    ) -> dict[str, int]:
        """Batch moves media items, source assets, and folders to a destination folder."""
        dest_folder_id = dto.destination_folder_id
        if dest_folder_id is not None:
            dest_folder = await self.folder_repo.get_folder_by_id(
                dest_folder_id
            )
            if not dest_folder or dest_folder.workspace_id != dto.workspace_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Destination folder not found in this workspace.",
                )

        # Reject the whole batch unless the caller owns every requested row.
        # Ownership is immutable once a row exists, so unlike workspace_id it
        # has no TOCTOU with the writes below and needs no lock. Running it
        # before the cycle-check locks means a request that is going to be
        # rejected never locks a row. This endpoint is already all-or-nothing
        # (the cycle check 400s the whole batch), so a 403 fits the contract
        # and both frontend callers already treat any error as total failure.
        await self._authorize_move_items(dto, user)

        # Serialize the cycle check the same way the PATCH path does. Reading
        # the descendants and then writing the new parent is a check-then-act:
        # without a lock, two concurrent moves can each see a subtree that the
        # other is about to reparent, both pass, and leave a parent cycle that
        # every recursive query then walks until MAX_FOLDER_DEPTH. Every folder
        # this batch touches is locked up front in ascending ID order, matching
        # _lock_folders_for_move, so batches contend in one direction only and
        # queue instead of deadlocking. The locks are held to the commit below.
        if dest_folder_id is not None and dto.folder_ids:
            for lock_id in sorted({dest_folder_id, *dto.folder_ids}):
                await self.folder_repo.get_folder_for_update(lock_id)

        # Validate folder moves against cycle creation
        valid_folder_ids: list[int] = []
        if dto.folder_ids:
            for f_id in dto.folder_ids:
                if dest_folder_id == f_id:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail=f"Folder {f_id} cannot be moved into itself.",
                    )
                if dest_folder_id is not None:
                    descendant_ids = await self.folder_repo.get_descendant_ids(
                        f_id
                    )
                    if dest_folder_id in descendant_ids:
                        raise HTTPException(
                            status_code=status.HTTP_400_BAD_REQUEST,
                            detail=f"Cannot move folder {f_id} into its own subfolder.",
                        )
                valid_folder_ids.append(f_id)

        # One logical move is one transaction: the repository writes are told
        # not to commit and the whole sequence is committed here, so a failure
        # part way through cannot leave items in the destination while the
        # frontend rolls its optimistic update back. The writes themselves are
        # inside the try as well, because a partial index violation surfaces at
        # flush or execute time, before the commit is reached.
        try:
            media_moved = await self.folder_repo.move_media_items(
                media_item_ids=dto.media_item_ids,
                workspace_id=dto.workspace_id,
                destination_folder_id=dest_folder_id,
                commit=False,
            )
            assets_moved = await self.folder_repo.move_source_assets(
                source_asset_ids=dto.source_asset_ids,
                workspace_id=dto.workspace_id,
                destination_folder_id=dest_folder_id,
                commit=False,
            )
            folders_moved = await self.folder_repo.move_folders(
                folder_ids=valid_folder_ids,
                workspace_id=dto.workspace_id,
                destination_folder_id=dest_folder_id,
                commit=False,
            )
            await self.folder_repo.db.commit()
        except IntegrityError as e:
            await self.folder_repo.db.rollback()
            if _is_folder_name_conflict(e):
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=(
                        "A folder with this name already exists at the"
                        " destination."
                    ),
                ) from e
            raise
        except Exception:
            await self.folder_repo.db.rollback()
            raise

        return {
            "media_items_moved": media_moved,
            "source_assets_moved": assets_moved,
            "folders_moved": folders_moved,
            "total_moved": media_moved + assets_moved + folders_moved,
        }
