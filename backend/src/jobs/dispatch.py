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

"""Chooses where generation jobs run, and hands them to Cloud Tasks.

CloudTasksExecutor is a GenerationExecutor, so the services keep calling
executor.submit_job(media_item_id, fn, ...) exactly as before. Only the
enqueue runs on this process's pool, so a shutdown mid-enqueue is still
caught by fail_inflight_jobs; the job itself runs on the worker. Plain
.submit (brand guidelines) still runs in-process.
"""

import asyncio
import json
import logging
import uuid
from collections.abc import Callable
from concurrent.futures import Future

from google.cloud import tasks_v2
from google.protobuf import duration_pb2

from src.common.generation_executor import GenerationExecutor
from src.common.storage_service import GcsService
from src.config.config_service import config_service
from src.database import WorkerDatabase
from src.jobs.job_codec import encode_call
from src.jobs.job_registry import job_name
from src.jobs.job_rows import fail_processing_job

logger = logging.getLogger(__name__)

RUN_JOB_PATH = "/internal/jobs/run"
STAGED_PAYLOAD_FOLDER = "job_payloads"
# Shown in the UI as "<Media> generation failed: <message>".
ENQUEUE_FAILED_MESSAGE = "Could not start the job. Please try again."


def fail_job_from_thread(media_item_id: int, message: str) -> None:
    """Marks a job FAILED from a pool thread. Never raises.

    Pool threads have no event loop, and the app's engine is bound to the
    main loop, so this opens a short-lived one like the job workers do.
    """

    async def _write() -> None:
        async with WorkerDatabase() as db_factory:
            async with db_factory() as db:
                await fail_processing_job(db, media_item_id, message)

    try:
        asyncio.run(_write())
    except Exception:
        logger.exception("Could not mark job %s failed", media_item_id)


class CloudTasksExecutor(GenerationExecutor):
    """Enqueues each generation job as an HTTP task for the worker."""

    def __init__(
        self,
        *,
        queue_path: str,
        target_url: str,
        invoker_sa: str,
        dispatch_deadline_seconds: int,
        tasks_client=None,
        gcs_service: GcsService | None = None,
        fail_job: Callable[[int, str], None] = fail_job_from_thread,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._queue_path = queue_path
        self._target_url = target_url.rstrip("/")
        self._invoker_sa = invoker_sa
        self._dispatch_deadline_seconds = dispatch_deadline_seconds
        self._tasks_client = tasks_client
        self._gcs_service = gcs_service
        self._fail_job = fail_job

    def submit_job(
        self, media_item_id: int, fn: Callable, /, *args, **kwargs
    ) -> Future:
        """Enqueues the job; the returned future covers the enqueue only."""
        return super().submit_job(
            media_item_id, self._enqueue, media_item_id, fn, args, kwargs
        )

    def _client(self):
        # Created lazily so importing and testing need no credentials.
        if self._tasks_client is None:
            self._tasks_client = tasks_v2.CloudTasksClient()
        return self._tasks_client

    def _gcs(self) -> GcsService:
        if self._gcs_service is None:
            self._gcs_service = GcsService()
        return self._gcs_service

    def _stage_bytes(self, data: bytes) -> str:
        uri = self._gcs().upload_bytes_to_gcs(
            content_bytes=data,
            destination_blob_name=f"{STAGED_PAYLOAD_FOLDER}/{uuid.uuid4()}",
            mime_type="application/octet-stream",
        )
        if not uri:
            raise RuntimeError("Could not stage job payload bytes in GCS.")
        return uri

    def _enqueue(
        self, media_item_id: int, fn: Callable, args: tuple, kwargs: dict
    ) -> None:
        try:
            body = {
                "job": job_name(fn),
                "media_item_id": media_item_id,
                "kwargs": encode_call(
                    fn, args, kwargs, stage_bytes=self._stage_bytes
                ),
            }
            task = tasks_v2.Task(
                http_request=tasks_v2.HttpRequest(
                    http_method=tasks_v2.HttpMethod.POST,
                    url=f"{self._target_url}{RUN_JOB_PATH}",
                    headers={"Content-Type": "application/json"},
                    body=json.dumps(body).encode(),
                    oidc_token=tasks_v2.OidcToken(
                        service_account_email=self._invoker_sa,
                        audience=self._target_url,
                    ),
                ),
                dispatch_deadline=duration_pb2.Duration(
                    seconds=self._dispatch_deadline_seconds
                ),
            )
            self._client().create_task(parent=self._queue_path, task=task)
            logger.info(
                "Enqueued generation job.",
                extra={"json_fields": {"media_id": media_item_id}},
            )
        except Exception:
            logger.exception(
                "Could not enqueue generation job.",
                extra={"json_fields": {"media_id": media_item_id}},
            )
            self._fail_job(media_item_id, ENQUEUE_FAILED_MESSAGE)


def build_executor() -> GenerationExecutor:
    """Returns the executor JOB_DISPATCH_MODE asks for."""
    cfg = config_service
    if cfg.JOB_DISPATCH_MODE == "cloud_tasks":
        return CloudTasksExecutor(
            queue_path=cfg.JOB_TASKS_QUEUE,
            target_url=cfg.JOB_WORKER_URL,
            invoker_sa=cfg.JOB_TASKS_INVOKER_SA,
            dispatch_deadline_seconds=cfg.JOB_DISPATCH_DEADLINE_SECONDS,
            max_workers=cfg.GENERATION_MAX_WORKERS,
        )
    return GenerationExecutor(max_workers=cfg.GENERATION_MAX_WORKERS)
