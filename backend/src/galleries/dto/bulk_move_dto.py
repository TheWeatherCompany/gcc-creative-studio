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


from enum import Enum

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel

from src.folders.dto.folder_dto import ConflictStrategyEnum


class BulkMoveItemDto(BaseModel):
    id: int
    type: str

    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=to_camel,
    )


class BulkMoveDto(BaseModel):
    items: list[BulkMoveItemDto]
    target_workspace_id: int
    conflict_strategy: ConflictStrategyEnum | None = None

    model_config = ConfigDict(
        populate_by_name=True,
        alias_generator=to_camel,
    )


class BulkMoveFailureReason(str, Enum):
    """Stable, client-safe codes for why one bulk-move item did not move.

    The detailed cause stays in the server log; raw exception text never
    reaches the client.
    """

    # No item of that type and id exists.
    NOT_FOUND = "NOT_FOUND"
    # The folder already lives in the target workspace, so nothing moved.
    ALREADY_IN_TARGET = "ALREADY_IN_TARGET"
    # The item type is not one bulk move handles.
    UNSUPPORTED_TYPE = "UNSUPPORTED_TYPE"
    # Anything unexpected; the item's savepoint was rolled back.
    MOVE_FAILED = "MOVE_FAILED"


class BulkMoveResultDto(BaseModel):
    """One requested item that moved, identified by its (type, id) pair."""

    id: int
    type: str


class BulkMoveFailureDto(BulkMoveResultDto):
    """One requested item that did not move, with a fixed reason code."""

    reason: BulkMoveFailureReason


class BulkMoveResponseDto(BaseModel):
    """Bulk-move outcome: upstream's moved_count plus per-item results.

    moved_count is computed exactly as upstream does (a folder counts every
    folder, media item and asset it carried), so it is a row count, not a
    count of requested items. moved and failed list requested items only:
    every requested item lands in exactly one of them. Keys stay snake_case
    (no alias generator) because upstream's frontend reads moved_count.
    """

    moved_count: int
    moved: list[BulkMoveResultDto]
    failed: list[BulkMoveFailureDto]
