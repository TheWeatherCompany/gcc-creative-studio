# Copyright 2025 Google LLC
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


from pydantic import BaseModel, EmailStr, Field


class UserCreateDto(BaseModel):
    """Data Transfer Object for creating a new user."""

    email: EmailStr
    name: str = Field(..., min_length=2)
    picture: str | None = None
    # Roles are derived from the caller's Okta groups and passed in
    # separately; there is nothing for an admin to edit here.
