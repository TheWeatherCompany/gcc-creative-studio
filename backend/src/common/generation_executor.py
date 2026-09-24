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

"""Thread pool for generation jobs that knows which of its jobs are in flight.

A generation job writes a PROCESSING media_items row, returns the HTTP response
and finishes on this pool. If the process shuts down first (deploy, scale-down,
memory-limit replacement), nothing is left to finish the row, and until
STUCK_JOB_STALE_AFTER it shows as an endless spinner and holds one of the
user's concurrency slots. Tracking the ids lets shutdown fail them instead.

A hard SIGKILL (e.g. the kernel OOM killer) runs no hook at all, so the
staleness window remains the fallback for that case.
"""

import asyncio
import logging
import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor

from sqlalchemy import update

from src.common.schema.media_item_model import JobStatusEnum, MediaItem
from src.database import async_session_local

logger = logging.getLogger(__name__)

# Shown in the UI as "<Media> generation failed: <message>".
INTERRUPTED_ERROR_MESSAGE = (
    "Interrupted because the server restarted. Please try again."
)

# Cloud Run allows roughly 10s between SIGTERM and SIGKILL. Give up on the
# write well inside that rather than risk being killed mid-shutdown.
SHUTDOWN_WRITE_TIMEOUT_SECONDS = 5.0


class GenerationExecutor(ThreadPoolExecutor):
    """ThreadPoolExecutor that tracks the media item of each submitted job."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._inflight_lock = threading.Lock()
        self._inflight_ids: set[int] = set()

    def submit_job(
        self, media_item_id: int, fn: Callable, /, *args, **kwargs
    ) -> Future:
        """Submits a job, tracking its media item until the job is done."""
        future = self.submit(fn, *args, **kwargs)
        with self._inflight_lock:
            self._inflight_ids.add(media_item_id)
        # Runs straight away if the job already finished, so nothing leaks.
        future.add_done_callback(lambda _: self._untrack(media_item_id))
        return future

    def _untrack(self, media_item_id: int) -> None:
        with self._inflight_lock:
            self._inflight_ids.discard(media_item_id)

    def inflight_job_ids(self) -> list[int]:
        with self._inflight_lock:
            return list(self._inflight_ids)


async def fail_inflight_jobs(media_item_ids: list[int]) -> None:
    """Marks this process's still-PROCESSING jobs FAILED. Never raises.

    Only rows still PROCESSING are touched, so a job that completed or failed
    on its own keeps its result. A worker that finishes after this and writes
    COMPLETED simply wins.
    """
    if not media_item_ids:
        return
    try:
        async with asyncio.timeout(SHUTDOWN_WRITE_TIMEOUT_SECONDS):
            async with async_session_local() as db:
                result = await db.execute(
                    update(MediaItem)
                    .where(MediaItem.id.in_(media_item_ids))
                    .where(MediaItem.status == JobStatusEnum.PROCESSING.value)
                    .values(
                        status=JobStatusEnum.FAILED.value,
                        error_message=INTERRUPTED_ERROR_MESSAGE,
                    )
                )
                await db.commit()
        logger.warning(
            "Marked %d in-flight generation job(s) failed on shutdown.",
            result.rowcount,
            extra={"json_fields": {"media_ids": media_item_ids}},
        )
    except Exception as e:
        logger.error(
            "Could not mark in-flight generation jobs failed on shutdown: %r",
            e,
            extra={"json_fields": {"media_ids": media_item_ids}},
        )
