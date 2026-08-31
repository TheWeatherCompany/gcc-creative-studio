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

import datetime

from pydantic import Field
from sqlalchemy import (
    DateTime,
    ForeignKey,
    Index,
    Integer,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from src.common.base_repository import BaseDocument
from src.database import Base


class MediaItemFavorite(Base):
    """SQLAlchemy model for the 'media_item_favorites' join table.

    A per-user star on a media item. It is a proper join table rather than a
    flag on the item so two users can independently favorite the same item.
    """

    __tablename__ = "media_item_favorites"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    media_item_id: Mapped[int] = mapped_column(
        ForeignKey("media_items.id", ondelete="CASCADE"),
        nullable=False,
    )
    created_at: Mapped[datetime.datetime] = mapped_column(
        DateTime(timezone=True),
        insert_default=func.now(),
        server_default=func.now(),
    )

    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "media_item_id",
            name="uq_media_item_favorite_user_item",
        ),
        Index("ix_media_item_favorites_user_id", "user_id"),
    )


class MediaItemFavoriteModel(BaseDocument):
    """Represents a per-user favorite on a media item (DTO)."""

    id: int | None = None
    user_id: int = Field(
        description="The ID of the user who favorited the media item."
    )
    media_item_id: int = Field(
        description="The ID of the favorited media item."
    )
