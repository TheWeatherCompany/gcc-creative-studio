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


from pydantic import BaseModel, Field


class BulkMoveItemDto(BaseModel):
    id: int
    type: str


class BulkMoveDto(BaseModel):
    items: list[BulkMoveItemDto]
    target_workspace_id: int


class BulkMoveResultDto(BaseModel):
    """One row a bulk move relocated, identified by the (type, id) pair."""

    id: int
    type: str


class BulkMoveFailureDto(BulkMoveResultDto):
    """One row a bulk move refused, with a fixed, client-safe reason."""

    reason: str


class BulkMoveResponseDto(BaseModel):
    """Partial-success contract: every requested row lands in exactly one list.

    Identity is the (type, id) pair, because ids are per-type: media_item 5
    and folder 5 are different rows.
    """

    moved: list[BulkMoveResultDto] = Field(default_factory=list)
    failed: list[BulkMoveFailureDto] = Field(default_factory=list)
