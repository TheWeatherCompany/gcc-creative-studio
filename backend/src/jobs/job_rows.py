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

"""The media_items reads and writes the job dispatch path needs.

Every write is conditional on status = 'processing', so nothing here can
overwrite a result a job already recorded.
"""

import datetime

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.common.job_policy import stale_job_cutoff
from src.common.schema.media_item_model import JobStatusEnum, MediaItem

# media_items.status is a plain String column, so compare against the value.
_PROCESSING = JobStatusEnum.PROCESSING.value


async def fail_processing_job(
    db: AsyncSession, media_item_id: int, message: str
) -> bool:
    """Marks one job FAILED if it is still PROCESSING.

    Returns whether the row was changed.
    """
    result = await db.execute(
        update(MediaItem)
        .where(MediaItem.id == media_item_id)
        .where(MediaItem.status == _PROCESSING)
        .values(status=JobStatusEnum.FAILED.value, error_message=message)
    )
    await db.commit()
    return result.rowcount == 1


async def is_processing(db: AsyncSession, media_item_id: int) -> bool:
    """Whether the job's row exists and is still PROCESSING."""
    status = await db.scalar(
        select(MediaItem.status).where(MediaItem.id == media_item_id)
    )
    return status == _PROCESSING


async def fail_stale_jobs(
    db: AsyncSession,
    message: str,
    cutoff: datetime.datetime | None = None,
) -> int:
    """Marks PROCESSING jobs created before the cutoff FAILED.

    The cutoff defaults to the shared staleness window in job_policy. FAILED
    rather than STOPPED (which the admin cleanup writes): the frontend stops
    polling on COMPLETED or FAILED only, so a STOPPED row keeps its spinner.
    """
    result = await db.execute(
        update(MediaItem)
        .where(MediaItem.status == _PROCESSING)
        .where(MediaItem.created_at < (cutoff or stale_job_cutoff()))
        .values(status=JobStatusEnum.FAILED.value, error_message=message)
    )
    await db.commit()
    return result.rowcount
