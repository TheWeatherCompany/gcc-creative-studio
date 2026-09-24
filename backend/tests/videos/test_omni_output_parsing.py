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
"""Tests for parsing Gemini Omni model output into a video.

Inputs are real SDK content types: the original bug was reading `.data` off a
TextContent, which ad-hoc mocks with arbitrary attributes would have hidden.
"""

import base64
import logging
import re
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from google.genai.interactions import TextContent, VideoContent

from src.common.base_dto import GenerationModelEnum
from src.common.schema.media_item_model import JobStatusEnum
from src.videos.dto.create_veo_dto import CreateVeoDto
from src.videos.veo_service import (
    EmptyGenerationError,
    _pick_omni_video_part,
    _process_video_in_background,
    _read_omni_video_bytes,
)

VIDEO_BYTES = b"fake-omni-video-bytes"
VIDEO = VideoContent(
    data=base64.b64encode(VIDEO_BYTES).decode(), mime_type="video/mp4"
)


@pytest.mark.parametrize(
    "contents, expected_status, expected_error",
    [
        # Media items 734 and 1285: text ahead of the video crashed the job.
        (
            [TextContent(text="Here is your video."), VIDEO],
            JobStatusEnum.COMPLETED,
            None,
        ),
        (
            [TextContent(text="I can't generate that scene.")],
            JobStatusEnum.FAILED,
            "The model returned no video: I can't generate that scene.",
        ),
    ],
    ids=["text_before_video", "text_only"],
)
@patch("src.database.WorkerDatabase")
@patch("src.videos.veo_service.GenAIModelSetup.get_omni_client")
@patch(
    "src.videos.veo_service.generate_thumbnail",
    new=MagicMock(return_value=None),
)
def test_omni_worker_outcome(
    mock_omni_client_init,
    mock_worker_db_class,
    contents,
    expected_status,
    expected_error,
):
    mock_worker_db_class.return_value.__aenter__.return_value = MagicMock()
    step = MagicMock(type="model_output", content=contents, signature=None)
    mock_omni_client_init.return_value.interactions.create.return_value = (
        MagicMock(id="interaction-1", steps=[step])
    )
    dto = CreateVeoDto(
        workspace_id=1,
        prompt="A storm rolling in",
        generation_model=GenerationModelEnum.GEMINI_OMNI_FLASH_PREVIEW,
        aspect_ratio="16:9",
        duration_seconds=4,
    )

    with (
        patch("src.videos.veo_service.MediaRepository") as mock_repo_class,
        patch("src.videos.veo_service.GcsService") as mock_gcs_class,
    ):
        mock_repo = AsyncMock()
        mock_repo_class.return_value = mock_repo
        mock_gcs_class.return_value.upload_file_to_gcs.return_value = (
            "gs://bucket/omni.mp4"
        )

        _process_video_in_background(
            media_item_id=1234, request_dto=dto, user_email="t@t.com"
        )

    update = mock_repo.update.call_args[0][1]
    assert update["status"] == expected_status
    assert update.get("error_message") == expected_error


@pytest.mark.parametrize(
    "contents, expected_error",
    [
        ([], "The model returned no video."),
        # A video part with neither data nor uri is not a video.
        (
            [TextContent(text="Done."), VideoContent(mime_type="video/mp4")],
            "The model returned no video: Done.",
        ),
        (
            [TextContent(text="x" * 1000)],
            "The model returned no video: " + "x" * 300 + "...",
        ),
    ],
    ids=["nothing", "empty_video_part", "long_text_trimmed"],
)
def test_pick_omni_video_part_errors(contents, expected_error):
    with pytest.raises(EmptyGenerationError) as exc:
        _pick_omni_video_part(contents, logging.getLogger("test"))
    assert str(exc.value) == expected_error


def test_pick_omni_video_part_logs_text_alongside_video(caplog):
    # The log is the only record of what the model said when it succeeds.
    contents = [TextContent(text="Here is your video."), VIDEO]
    with caplog.at_level(logging.INFO):
        part = _pick_omni_video_part(contents, logging.getLogger("test"))
    assert part is VIDEO
    assert "Here is your video." in caplog.text


@pytest.mark.parametrize(
    "part, downloaded, expected",
    [
        (VIDEO, None, VIDEO_BYTES),
        (VideoContent(uri="gs://other/omni.mp4"), VIDEO_BYTES, VIDEO_BYTES),
        (
            VideoContent(uri="gs://other/omni.mp4"),
            None,
            "Could not download the generated video from gs://other/omni.mp4.",
        ),
        (
            VideoContent(uri="https://example.com/files/abc"),
            None,
            "unsupported URI: https://example.com/files/abc",
        ),
    ],
    ids=["inline_data", "gcs_uri", "gcs_uri_missing", "non_gcs_uri"],
)
def test_read_omni_video_bytes(part, downloaded, expected):
    gcs_service = MagicMock()
    gcs_service.download_bytes_from_gcs.return_value = downloaded

    if isinstance(expected, bytes):
        assert _read_omni_video_bytes(part, gcs_service) == expected
    else:
        with pytest.raises(RuntimeError, match=re.escape(expected)):
            _read_omni_video_bytes(part, gcs_service)
