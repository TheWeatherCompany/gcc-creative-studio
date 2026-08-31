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

from fastapi import Depends
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from src.common.base_repository import BaseRepository
from src.database import get_db
from src.favorites.schema.favorite_model import (
    MediaItemFavorite,
    MediaItemFavoriteModel,
)


class FavoritesRepository(
    BaseRepository[MediaItemFavorite, MediaItemFavoriteModel],
):
    """Handles database operations for per-user media item favorites."""

    def __init__(self, db: AsyncSession = Depends(get_db)):
        super().__init__(
            model=MediaItemFavorite,
            schema=MediaItemFavoriteModel,
            db=db,
        )

    async def add_favorite(self, user_id: int, media_item_id: int) -> None:
        """Favorites a media item for a user. Idempotent: a repeated call on an
        already-favorited item is a no-op thanks to the unique constraint.
        """
        await self.db.execute(
            pg_insert(self.model)
            .values(user_id=user_id, media_item_id=media_item_id)
            .on_conflict_do_nothing(
                index_elements=["user_id", "media_item_id"],
            )
        )
        await self.db.commit()

    async def remove_favorite(self, user_id: int, media_item_id: int) -> bool:
        """Unfavorites a media item for a user. Returns True if a row was
        removed, False if it was not favorited to begin with.
        """
        result = await self.db.execute(
            delete(self.model)
            .where(self.model.user_id == user_id)
            .where(self.model.media_item_id == media_item_id)
        )
        await self.db.commit()
        return result.rowcount > 0  # type: ignore

    async def is_favorite(self, user_id: int, media_item_id: int) -> bool:
        """Returns whether the given media item is favorited by the user."""
        result = await self.db.execute(
            select(self.model.id)
            .where(self.model.user_id == user_id)
            .where(self.model.media_item_id == media_item_id)
            .limit(1)
        )
        return result.scalar_one_or_none() is not None

    async def favorite_media_item_ids(
        self,
        user_id: int,
        media_item_ids: list[int],
    ) -> set[int]:
        """Returns the subset of media_item_ids that the user has favorited."""
        if not media_item_ids:
            return set()
        result = await self.db.execute(
            select(self.model.media_item_id)
            .where(self.model.user_id == user_id)
            .where(self.model.media_item_id.in_(media_item_ids))
        )
        return set(result.scalars().all())
