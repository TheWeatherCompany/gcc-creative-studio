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
"""Tests that the video workers keep scratch files out of the working directory.

The backend image runs as a non-root user with a root-owned /app, so a
scratch file written relative to the working directory fails in Cloud Run
with Errno 13, as every video job did from 2026-10-12 to 2026-10-16. These
run the workers from a read-only directory with a GCS fake that writes real
files.
"""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.common.base_dto import GenerationModelEnum
from src.common.schema.media_item_model import (
    JobStatusEnum,
    MediaItemModel,
    MimeTypeEnum,
)
from src.config.config_service import config_service as cfg
from src.videos.dto.concatenate_videos_dto import (
    ConcatenateVideosDto,
    ConcatenationInput,
)
from src.videos.dto.create_veo_dto import CreateVeoDto
from src.videos.veo_service import (
    _process_video_concatenation_in_background,
    _process_video_in_background,
)

# Veo writes each sample under its operation id; this is a real one.
OPERATION_BLOB = "5829313908495902662/sample_0.mp4"


class FakeGcs:
    """Stands in for GcsService, writing downloads to disk like the real one."""

    def __init__(self):
        self.written = []
        self.uploads = []

    def download_from_gcs(self, gcs_uri_path, destination_file_path):
        del gcs_uri_path
        os.makedirs(os.path.dirname(destination_file_path), exist_ok=True)
        with open(destination_file_path, "wb") as f:
            f.write(b"video-bytes")
        self.written.append(destination_file_path)
        return destination_file_path

    def upload_file_to_gcs(self, local_path, destination_blob_name, mime_type):
        del local_path, mime_type
        self.uploads.append(destination_blob_name)
        return f"gs://{cfg.GENMEDIA_BUCKET}/{destination_blob_name}"


def _fake_thumbnail(video_path):
    """Writes a thumbnail where media_utils.generate_thumbnail would."""
    stem = os.path.splitext(os.path.basename(video_path))[0]
    path = os.path.join(os.path.dirname(video_path), f"thumbnail_{stem}.png")
    with open(path, "wb") as f:
        f.write(b"png")
    return path


def _run_veo(gcs, thumbnail=_fake_thumbnail):
    """Runs the standard Veo worker and returns the row update."""
    dto = CreateVeoDto(
        workspace_id=1,
        prompt="A storm rolling in",
        generation_model=GenerationModelEnum.VEO_3_QUALITY,
        aspect_ratio="16:9",
        duration_seconds=5,
        enhance_prompt=False,
    )
    operation = MagicMock(done=True, error=None)
    generated = MagicMock()
    generated.video.uri = f"gs://{cfg.GENMEDIA_BUCKET}/{OPERATION_BLOB}"
    operation.response.generated_videos = [generated]

    with (
        patch("src.database.WorkerDatabase") as mock_worker_db_class,
        patch("src.videos.veo_service.GenAIModelSetup.init") as mock_genai_init,
        patch(
            "src.videos.veo_service.generate_thumbnail", side_effect=thumbnail
        ),
        patch("src.videos.veo_service.MediaRepository") as mock_repo_class,
        patch("src.videos.veo_service.SourceAssetRepository"),
        patch("src.videos.veo_service.GeminiService"),
        patch("src.videos.veo_service.GcsService", return_value=gcs),
    ):
        mock_worker_db_class.return_value.__aenter__.return_value = MagicMock()
        mock_genai_init.return_value.models.generate_videos.return_value = (
            operation
        )
        mock_repo = AsyncMock()
        mock_repo_class.return_value = mock_repo

        _process_video_in_background(
            media_item_id=123, request_dto=dto, user_email="t@t.com"
        )

    return mock_repo.update.call_args[0][1]


@pytest.mark.usefixtures("readonly_cwd")
def test_veo_worker_completes_from_a_read_only_working_directory():
    gcs = FakeGcs()

    update = _run_veo(gcs)

    assert update["status"] == JobStatusEnum.COMPLETED
    assert gcs.written
    assert not any(os.path.exists(path) for path in gcs.written)


@pytest.mark.usefixtures("readonly_cwd")
def test_veo_thumbnail_keeps_its_blob_name():
    gcs = FakeGcs()

    update = _run_veo(gcs)

    # The object name the worker has always produced, next to the video.
    blob = "5829313908495902662/thumbnail_sample_0.png"
    assert gcs.uploads == [blob]
    assert update["thumbnail_uris"] == [f"gs://{cfg.GENMEDIA_BUCKET}/{blob}"]


@pytest.mark.usefixtures("readonly_cwd")
def test_veo_scratch_video_is_removed_when_the_thumbnail_fails():
    gcs = FakeGcs()

    _run_veo(gcs, thumbnail=lambda video_path: None)

    assert gcs.written
    assert not any(os.path.exists(path) for path in gcs.written)
