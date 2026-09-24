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

"""Endpoints Cloud Tasks and Cloud Scheduler call to run and sweep jobs.

/run executes one job inside the request, so Cloud Run sees the work and can
scale on it. Response codes drive Cloud Tasks retries: a job function records
its own failures and returns, so a normal return is 200 (no retry). Only a
crash or a timeout produces a retry, which is exactly the OOM case.
"""

import asyncio
import inspect
import logging
from functools import partial
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from src.common.storage_service import GcsService
from src.database import get_db
from src.jobs.job_codec import decode_call, staged_uris
from src.jobs.job_registry import resolve_job
from src.jobs.job_rows import (
    fail_processing_job,
    fail_stale_jobs,
    is_processing,
)
from src.jobs.task_auth import verify_task_token

logger = logging.getLogger(__name__)

# Shown in the UI as "<Media> generation failed: <message>".
JOB_REJECTED_MESSAGE = (
    "The job could not be started on the worker. Please try again."
)
SWEPT_MESSAGE = "The job stopped responding. Please try again."

router = APIRouter(
    prefix="/internal/jobs",
    tags=["Internal Jobs"],
    dependencies=[Depends(verify_task_token)],
)


class RunJobRequest(BaseModel):
    job: str
    media_item_id: int
    kwargs: dict[str, Any]


def _load_staged(gcs: GcsService, uri: str) -> bytes:
    data = gcs.download_bytes_from_gcs(uri)
    if not data:
        raise RuntimeError(f"Staged job payload is missing: {uri}")
    return data


@router.post("/run")
async def run_job(
    body: RunJobRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    log_fields = {
        "json_fields": {"media_id": body.media_item_id, "job": body.job}
    }
    if not await is_processing(db, body.media_item_id):
        # Finished, failed, swept, or a duplicate delivery.
        return {"status": "skipped"}
    # End the read transaction now: the job below can run for minutes.
    await db.rollback()

    gcs = GcsService()
    try:
        fn = resolve_job(body.job)
        kwargs = await asyncio.to_thread(
            decode_call, fn, body.kwargs, partial(_load_staged, gcs)
        )
        # The API and worker deploy separately. If their job signatures differ,
        # calling fn would raise TypeError: a 500, a retry that fails the same
        # way, and a row left PROCESSING until the sweep.
        inspect.signature(fn).bind(**kwargs)
    except Exception:  # UnknownJobError, bad arguments, a missing blob
        logger.exception("Rejected a job delivery.", extra=log_fields)
        await fail_processing_job(db, body.media_item_id, JOB_REJECTED_MESSAGE)
        return {"status": "rejected"}

    # Plain .submit, deliberately NOT .submit_job: PR #43's shutdown handler
    # fails every job the executor tracks. A job running here must stay
    # PROCESSING when its instance dies, so the Cloud Tasks retry (which skips
    # non-PROCESSING rows) can run it again. The app's pool, not to_thread,
    # keeps long jobs bounded by GENERATION_MAX_WORKERS and out of the default
    # pool that token checks and GCS calls share.
    await asyncio.wrap_future(request.app.state.executor.submit(fn, **kwargs))

    # Only after success: a crash leaves the bytes for the retry, and the
    # bucket's lifecycle rule removes anything left behind.
    for uri in staged_uris(body.kwargs):
        await asyncio.to_thread(gcs.delete_blob_from_uri, uri)
    return {"status": "done"}


@router.post("/sweep")
async def sweep_stuck_jobs(db: AsyncSession = Depends(get_db)):
    count = await fail_stale_jobs(db, SWEPT_MESSAGE)
    if count:
        logger.warning("Failed %d stuck generation job(s).", count)
    return {"failed": count}
