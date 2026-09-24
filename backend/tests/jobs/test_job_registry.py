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
"""Guards the allowlist between the API and the worker.

An upstream sync that renames or moves a job function breaks dispatch; the
first test catches that. The rest keep the worker from importing arbitrary
names out of a request body.
"""

import json

import pytest

from src.jobs.job_registry import (
    ALLOWED_JOBS,
    UnknownJobError,
    job_name,
    resolve_job,
)


@pytest.mark.parametrize("name", sorted(ALLOWED_JOBS))
def test_every_allowed_job_resolves_to_itself(name):
    assert job_name(resolve_job(name)) == name


@pytest.mark.parametrize(
    "name",
    [
        "os:system",
        "src.images.imagen_service:ImagenService",
        "not-a-job-name",
    ],
)
def test_unlisted_names_are_never_resolved(name):
    with pytest.raises(UnknownJobError):
        resolve_job(name)


def test_unlisted_functions_cannot_be_dispatched():
    with pytest.raises(UnknownJobError):
        job_name(json.dumps)
