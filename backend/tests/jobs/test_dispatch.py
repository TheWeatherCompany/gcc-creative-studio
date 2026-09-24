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

"""Guards what the API sends to Cloud Tasks, and what happens when it can't."""

import json
import threading
from unittest.mock import MagicMock

import pytest
from google.cloud import tasks_v2

from src.audios.audio_service import _process_audio_in_background
from src.audios.dto.create_audio_dto import CreateAudioDto
from src.common.base_dto import GenerationModelEnum
from src.common.generation_executor import GenerationExecutor
from src.config.config_service import config_service
from src.images.imagen_service import _process_upload_upscale_in_background
from src.jobs.dispatch import (
    ENQUEUE_FAILED_MESSAGE,
    CloudTasksExecutor,
    build_executor,
)
from src.jobs.job_codec import STAGED_BYTES_KEY, decode_call
from src.users.user_model import UserModel, UserRoleEnum

QUEUE = "projects/p/locations/us-central1/queues/q"
WORKER = "https://worker.example"
INVOKER = "invoker@p.iam.gserviceaccount.com"
USER = UserModel(
    id=3, email="u@example.com", roles=[UserRoleEnum.USER], name="U"
)
AUDIO_DTO = CreateAudioDto(
    workspace_id=1,
    prompt="A cute cat running",
    model=GenerationModelEnum.LYRIA_002,
    sample_count=1,
)


class _RecordingTasksClient:
    def __init__(self, error=None):
        self.calls = []
        self.error = error

    def create_task(self, parent, task):
        if self.error:
            raise self.error
        self.calls.append((parent, task))


def _executor(client, fail_job, gcs=None):
    return CloudTasksExecutor(
        queue_path=QUEUE,
        target_url=WORKER,
        invoker_sa=INVOKER,
        dispatch_deadline_seconds=900,
        tasks_client=client,
        gcs_service=gcs or MagicMock(),
        fail_job=fail_job,
        max_workers=2,
    )


def test_enqueue_sends_an_oidc_task_the_worker_can_decode():
    client = _RecordingTasksClient()
    executor = _executor(client, fail_job=MagicMock())

    executor.submit_job(
        7, _process_audio_in_background, 7, AUDIO_DTO, "u@example.com", 3
    ).result(timeout=5)
    executor.shutdown()

    [(parent, task)] = client.calls
    request = task.http_request
    assert parent == QUEUE
    assert request.url == f"{WORKER}/internal/jobs/run"
    assert request.oidc_token.service_account_email == INVOKER
    assert request.oidc_token.audience == WORKER
    assert tasks_v2.Task.pb(task).dispatch_deadline.seconds == 900
    body = json.loads(request.body)
    assert (
        body["job"] == "src.audios.audio_service:_process_audio_in_background"
    )
    assert body["media_item_id"] == 7
    assert decode_call(
        _process_audio_in_background, body["kwargs"], load_bytes=None
    ) == {
        "media_item_id": 7,
        "request_dto": AUDIO_DTO,
        "user_email": "u@example.com",
        "user_id": 3,
    }


def test_upload_bytes_go_to_gcs_not_into_the_task():
    uploaded = {}

    def upload(content_bytes, destination_blob_name, mime_type):
        uploaded[destination_blob_name] = content_bytes
        return f"gs://bucket/{destination_blob_name}"

    gcs = MagicMock()
    gcs.upload_bytes_to_gcs.side_effect = upload
    client = _RecordingTasksClient()
    executor = _executor(client, fail_job=MagicMock(), gcs=gcs)

    executor.submit_job(
        9,
        _process_upload_upscale_in_background,
        media_item_id=9,
        workspace_id=1,
        user=USER,
        gcs_uri="",
        file_bytes=b"\x89PNG\r\n\x1a\n",
        filename="in.png",
        upscale_factor="x2",
        aspect_ratio=None,
    ).result(timeout=5)
    executor.shutdown()

    [blob_name] = uploaded
    assert blob_name.startswith("job_payloads/")
    assert uploaded[blob_name] == b"\x89PNG\r\n\x1a\n"
    body = json.loads(client.calls[0][1].http_request.body)
    assert body["kwargs"]["file_bytes"] == {
        STAGED_BYTES_KEY: f"gs://bucket/{blob_name}"
    }


def test_an_enqueue_in_progress_is_in_flight_for_shutdown():
    # main.py's shutdown hook fails whatever inflight_job_ids() lists, so a
    # SIGTERM mid-enqueue must still see the job, and a sent one must not.
    release = threading.Event()
    client = MagicMock()
    client.create_task.side_effect = lambda **_: release.wait(timeout=5)
    executor = _executor(client, fail_job=MagicMock())

    future = executor.submit_job(
        7, _process_audio_in_background, 7, AUDIO_DTO, "u@example.com", 3
    )
    assert executor.inflight_job_ids() == [7]
    release.set()
    future.result(timeout=5)
    executor.shutdown()

    assert executor.inflight_job_ids() == []


def _not_a_registered_job(media_item_id: int):
    """Stands in for a function someone forgot to add to ALLOWED_JOBS."""


@pytest.mark.parametrize(
    "client,fn,args",
    [
        (
            _RecordingTasksClient(error=RuntimeError("queue down")),
            _process_audio_in_background,
            (5, AUDIO_DTO, "u@example.com", 3),
        ),
        (_RecordingTasksClient(), _not_a_registered_job, (5,)),
    ],
    ids=["enqueue fails", "job not registered"],
)
def test_a_job_that_cannot_be_enqueued_is_failed_not_stranded(client, fn, args):
    fail_job = MagicMock()
    executor = _executor(client, fail_job=fail_job)

    executor.submit_job(5, fn, *args).result(timeout=5)
    executor.shutdown()

    assert client.calls == []
    fail_job.assert_called_once_with(5, ENQUEUE_FAILED_MESSAGE)


@pytest.mark.parametrize(
    "mode,expected",
    [("in_process", GenerationExecutor), ("cloud_tasks", CloudTasksExecutor)],
)
def test_build_executor_follows_the_dispatch_mode(monkeypatch, mode, expected):
    monkeypatch.setattr(config_service, "JOB_DISPATCH_MODE", mode)
    monkeypatch.setattr(config_service, "JOB_TASKS_QUEUE", QUEUE)
    monkeypatch.setattr(config_service, "JOB_WORKER_URL", WORKER)
    monkeypatch.setattr(config_service, "JOB_TASKS_INVOKER_SA", INVOKER)
    executor = build_executor()
    try:
        assert type(executor) is expected
    finally:
        executor.shutdown()
