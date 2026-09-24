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

"""The generation jobs the worker is allowed to run.

Jobs are named "module:function" so the API can put the name in a Cloud Tasks
body and the worker can find the same function. Names are strings on purpose:
importing the service modules here would create an import cycle, and the
worker must never import something a request body names unless it is listed.
"""

import importlib
from collections.abc import Callable

ALLOWED_JOBS = frozenset(
    {
        "src.images.imagen_service:_process_image_in_background",
        "src.images.imagen_service:_process_vto_in_background",
        "src.images.imagen_service:_process_upload_upscale_in_background",
        "src.videos.veo_service:_process_video_in_background",
        "src.videos.veo_service:_process_video_concatenation_in_background",
        "src.audios.audio_service:_process_audio_in_background",
    }
)


class UnknownJobError(ValueError):
    """A job name or function that is not in ALLOWED_JOBS."""


def job_name(fn: Callable) -> str:
    """Returns the registered name of a job function."""
    name = f"{fn.__module__}:{fn.__qualname__}"
    if name not in ALLOWED_JOBS:
        raise UnknownJobError(name)
    return name


def resolve_job(name: str) -> Callable:
    """Returns the job function a registered name refers to."""
    if name not in ALLOWED_JOBS:
        raise UnknownJobError(name)
    module_name, attr = name.split(":")
    return getattr(importlib.import_module(module_name), attr)
