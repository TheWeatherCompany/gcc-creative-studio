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
"""Guards that cloud_tasks mode refuses to start half-configured."""

import pytest
from pydantic import ValidationError

from src.config.config_service import ConfigService

_COMPLETE = {
    "PROJECT_ID": "dummy-project-id",
    "JOB_DISPATCH_MODE": "cloud_tasks",
    "JOB_TASKS_QUEUE": "projects/p/locations/us-central1/queues/q",
    "JOB_WORKER_URL": "https://worker.example",
    "JOB_TASKS_INVOKER_SA": "invoker@p.iam.gserviceaccount.com",
}


@pytest.mark.parametrize(
    "missing", ["JOB_TASKS_QUEUE", "JOB_WORKER_URL", "JOB_TASKS_INVOKER_SA"]
)
def test_cloud_tasks_mode_requires_every_queue_setting(missing):
    settings = {**_COMPLETE, missing: ""}
    with pytest.raises(ValidationError, match=missing):
        ConfigService(_env_file=None, **settings)


def test_in_process_mode_needs_no_queue_settings():
    config = ConfigService(
        _env_file=None,
        PROJECT_ID="dummy-project-id",
        JOB_DISPATCH_MODE="in_process",
    )
    assert config.JOB_DISPATCH_MODE == "in_process"


@pytest.mark.parametrize(
    "raw", ["https://worker.example", "https://worker.example/"]
)
def test_worker_url_is_stored_without_a_trailing_slash(raw):
    # The enqueue side and the OIDC verifier both use JOB_WORKER_URL as the
    # audience, so they only agree if it is normalized in one place.
    config = ConfigService(
        _env_file=None, **{**_COMPLETE, "JOB_WORKER_URL": raw}
    )
    assert config.JOB_WORKER_URL == "https://worker.example"
