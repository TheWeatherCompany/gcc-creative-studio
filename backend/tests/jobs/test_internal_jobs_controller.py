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
"""Guards how the worker endpoint treats each delivery."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from main import app
from src.database import get_db
from src.jobs import internal_jobs_controller as controller
from src.jobs.internal_jobs_controller import JOB_REJECTED_MESSAGE
from src.jobs.job_codec import STAGED_BYTES_KEY
from src.jobs.job_registry import UnknownJobError
from src.jobs.task_auth import verify_task_token

calls = []


def fake_job(media_item_id: int, payload: bytes):
    calls.append((media_item_id, payload))


def failing_job(media_item_id: int, payload: bytes):
    raise RuntimeError("crashed")


BODY = {
    "job": "src.images.imagen_service:_process_image_in_background",
    "media_item_id": 5,
    "kwargs": {
        "media_item_id": 5,
        "payload": {STAGED_BYTES_KEY: "gs://bucket/job_payloads/x"},
    },
}


@pytest.fixture(name="client")
def fixture_client():
    async def override_get_db():
        # AsyncMock: the handler awaits db.rollback() before running the job.
        yield AsyncMock()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[verify_task_token] = lambda: None
    calls.clear()
    gcs = MagicMock()
    gcs.download_bytes_from_gcs.return_value = b"staged"
    with (
        patch.object(controller, "GcsService", return_value=gcs),
        patch.object(
            controller, "is_processing", AsyncMock(return_value=True)
        ) as is_processing,
        patch.object(controller, "fail_processing_job", AsyncMock()) as fail,
        patch.object(
            controller, "resolve_job", return_value=fake_job
        ) as resolve,
        TestClient(app, raise_server_exceptions=False) as client,
    ):
        yield client, gcs, is_processing, fail, resolve
    app.dependency_overrides.clear()


def test_runs_the_job_with_decoded_arguments_then_deletes_staged_bytes(client):
    http, gcs, _, fail, _ = client
    response = http.post("/internal/jobs/run", json=BODY)
    assert response.status_code == 200
    assert calls == [(5, b"staged")]
    gcs.delete_blob_from_uri.assert_called_once_with(
        "gs://bucket/job_payloads/x"
    )
    fail.assert_not_called()


def test_a_row_that_is_no_longer_processing_is_skipped(client):
    http, _, is_processing, _, _ = client
    is_processing.return_value = False
    response = http.post("/internal/jobs/run", json=BODY)
    assert response.json() == {"status": "skipped"}
    assert not calls


@pytest.mark.parametrize(
    "setup",
    ["unknown job", "undecodable arguments", "signature drift"],
)
def test_an_unreadable_delivery_fails_the_row_without_retrying(client, setup):
    http, gcs, _, fail, resolve = client
    body = BODY
    if setup == "unknown job":
        resolve.side_effect = UnknownJobError("x")
    elif setup == "undecodable arguments":
        gcs.download_bytes_from_gcs.return_value = None
    else:
        # The API and worker deploy separately, so after an upstream sync
        # changes a job's parameters one may send what the other can't take.
        body = {**BODY, "kwargs": {**BODY["kwargs"], "added_upstream": 1}}
    response = http.post("/internal/jobs/run", json=body)
    assert response.status_code == 200
    assert response.json() == {"status": "rejected"}
    fail.assert_awaited_once()
    assert fail.await_args.args[1:] == (5, JOB_REJECTED_MESSAGE)
    assert not calls


def test_a_crashing_job_keeps_its_staged_bytes_for_the_retry(client):
    http, gcs, _, _, resolve = client
    resolve.return_value = failing_job
    response = http.post("/internal/jobs/run", json=BODY)
    assert response.status_code == 500
    gcs.delete_blob_from_uri.assert_not_called()


def test_a_running_job_is_left_for_the_retry_not_failed_on_shutdown(client):
    # PR #43 fails every job the executor tracks when the process gets SIGTERM.
    # If a job running here were tracked, a deploy or OOM would mark it FAILED
    # and the Cloud Tasks retry would skip it: the job would be lost.
    http, _, is_processing, _, resolve = client
    tracked_during_run = []
    handler_loop = []

    async def processing(*_):
        handler_loop.append(asyncio.get_running_loop())
        return True

    def job(**_):
        # submit_job tracks the id only after the job has started, so first
        # wait for one turn of the handler's loop: any tracking is done by then.
        asyncio.run_coroutine_threadsafe(
            asyncio.sleep(0), handler_loop[0]
        ).result(timeout=5)
        tracked_during_run.append(app.state.executor.inflight_job_ids())

    is_processing.side_effect = processing

    resolve.return_value = job
    assert http.post("/internal/jobs/run", json=BODY).status_code == 200
    assert tracked_during_run == [[]]


@pytest.mark.parametrize("path", ["/internal/jobs/run", "/internal/jobs/sweep"])
def test_internal_endpoints_require_a_task_token(path):
    async def override_get_db():
        yield AsyncMock()

    # Only the DB is stubbed: the real verify_task_token must run and refuse.
    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as http:
            response = http.post(path, json=BODY)
    finally:
        app.dependency_overrides.clear()
    assert response.status_code in (401, 403)
