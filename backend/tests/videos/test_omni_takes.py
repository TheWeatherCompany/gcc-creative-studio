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
"""Tests for Gemini Omni making several takes per prompt.

Omni returns one video per interaction, so N takes are N interactions whose
videos land on one media item, like the Gemini image fan-out.
"""

import base64
import itertools
import threading
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from google.genai.interactions import TextContent, VideoContent

from src.common.base_dto import GenerationModelEnum
from src.config.config_service import config_service
from src.common.schema.media_item_model import (
    JobStatusEnum,
    MediaItemModel,
    MimeTypeEnum,
)
from src.videos.dto.create_veo_dto import CreateVeoDto
from src.videos.veo_service import _process_video_in_background

MEDIA_ITEM_ID = 1234
VIDEO = VideoContent(
    data=base64.b64encode(b"fake-omni-video-bytes").decode(),
    mime_type="video/mp4",
)


def _interaction(contents):
    step = MagicMock(type="model_output", content=contents, signature="sig")
    return MagicMock(id="interaction-new", steps=[step])


def _video_uri(take):
    return f"gs://bucket/videos/{MEDIA_ITEM_ID}_{take}.mp4"


def _thumbnail_uri(take):
    return f"gs://bucket/thumbnails/{MEDIA_ITEM_ID}_{take}.png"


def _thumbnail(video_path):
    # Take 0 finishes last, so storing takes in completion order would show.
    if video_path.endswith("_0.mp4"):
        time.sleep(0.2)
    return video_path.replace(".mp4", ".png")


def _run(dto, contents, fail_take_1=False, parent=None, first_call=None):
    """Runs the worker and returns (the row update, the create mock).

    first_call, if given, is what the first interaction returns in place of
    contents. Takes run in parallel, so which take gets it is not fixed.
    """

    def upload(local_path, destination_blob_name, mime_type):
        del local_path, mime_type
        if fail_take_1 and destination_blob_name.endswith("_1.mp4"):
            raise RuntimeError("upload failed")
        return f"gs://bucket/{destination_blob_name}"

    def download(gcs_uri_path, destination_file_path):
        del gcs_uri_path
        with open(destination_file_path, "wb") as f:
            f.write(b"parent-video-bytes")

    with (
        patch("src.database.WorkerDatabase") as mock_worker_db_class,
        patch(
            "src.videos.veo_service.GenAIModelSetup.get_omni_client"
        ) as mock_omni_client_init,
        patch(
            "src.videos.veo_service.generate_thumbnail", side_effect=_thumbnail
        ),
        patch("src.videos.veo_service.MediaRepository") as mock_repo_class,
        patch("src.videos.veo_service.GcsService") as mock_gcs_class,
    ):
        mock_worker_db_class.return_value.__aenter__.return_value = MagicMock()
        create = mock_omni_client_init.return_value.interactions.create
        create.return_value = _interaction(contents)
        if first_call is not None:
            calls = itertools.count()
            lock = threading.Lock()

            def reply(**kwargs):
                del kwargs
                with lock:
                    first = next(calls) == 0
                return _interaction(first_call if first else contents)

            create.side_effect = reply
        mock_repo = AsyncMock()
        mock_repo.get_by_id.return_value = parent
        mock_repo_class.return_value = mock_repo
        gcs = mock_gcs_class.return_value
        gcs.upload_file_to_gcs.side_effect = upload
        gcs.download_from_gcs.side_effect = download

        _process_video_in_background(
            media_item_id=MEDIA_ITEM_ID, request_dto=dto, user_email="t@t.com"
        )

    return mock_repo.update.call_args[0][1], create


def _dto(number_of_media, **kwargs):
    return CreateVeoDto(
        workspace_id=1,
        prompt="A storm rolling in",
        generation_model=GenerationModelEnum.GEMINI_OMNI_1_1_FLASH_PREVIEW,
        number_of_media=number_of_media,
        **kwargs,
    )


@pytest.fixture(autouse=True)
def _scratch_cwd(tmp_path, monkeypatch):
    # The worker writes its temp files relative to the working directory.
    monkeypatch.chdir(tmp_path)


def test_each_take_is_an_interaction_stored_in_take_order():
    update, create = _run(_dto(4), [VIDEO])

    assert create.call_count == 4
    assert update["status"] == JobStatusEnum.COMPLETED
    assert update["gcs_uris"] == [_video_uri(take) for take in range(4)]
    assert update["thumbnail_uris"] == [
        _thumbnail_uri(take) for take in range(4)
    ]
    assert update["num_media"] == 4
    assert len(update["raw_data"]["interactions"]) == 4


# Partial failure follows the Gemini image fan-out: a take with no video is
# dropped, and the job fails only if every take is empty. Any other error
# fails the job.
@pytest.mark.parametrize(
    "number_of_media, run_kwargs, expected",
    [
        (
            3,
            {"first_call": [TextContent(text="I can't generate that.")]},
            {"status": JobStatusEnum.COMPLETED, "num_media": 2},
        ),
        (
            2,
            {"contents": [TextContent(text="I can't generate that scene.")]},
            {
                "status": JobStatusEnum.FAILED,
                "error_message": (
                    "The model returned no video: I can't generate that scene."
                ),
            },
        ),
        (
            3,
            {"fail_take_1": True},
            {"status": JobStatusEnum.FAILED, "error_message": "upload failed"},
        ),
    ],
    ids=["one_take_empty", "every_take_empty", "one_take_errors"],
)
def test_failed_takes(number_of_media, run_kwargs, expected):
    run_kwargs = {"contents": [VIDEO], **run_kwargs}
    update, _ = _run(_dto(number_of_media), **run_kwargs)

    assert {key: update.get(key) for key in expected} == expected
    if update["status"] == JobStatusEnum.COMPLETED:
        # The surviving takes keep their own video and thumbnail, in order.
        takes = [
            int(uri.rsplit("_", 1)[1].split(".")[0])
            for uri in update["gcs_uris"]
        ]
        assert takes == sorted(takes)
        assert update["gcs_uris"] == [_video_uri(take) for take in takes]
        assert update["thumbnail_uris"] == [
            _thumbnail_uri(take) for take in takes
        ]


def test_follow_up_turn_takes_each_continue_the_parent():
    parent = MediaItemModel(
        id=99,
        workspace_id=1,
        user_id=1,
        user_email="t@t.com",
        mime_type=MimeTypeEnum.VIDEO_MP4,
        model=GenerationModelEnum.GEMINI_OMNI_1_1_FLASH_PREVIEW,
        aspect_ratio="16:9",
        gcs_uris=[f"gs://{config_service.GENMEDIA_BUCKET}/videos/99_0.mp4"],
        thumbnail_uris=[],
        raw_data={"interaction_id": "interaction-parent", "signature": "sig"},
    )

    update, create = _run(
        _dto(2, parent_media_item_id=99), [VIDEO], parent=parent
    )

    assert [
        call.kwargs["previous_interaction_id"] for call in create.call_args_list
    ] == [
        "interaction-parent",
        "interaction-parent",
    ]
    assert update["gcs_uris"] == [_video_uri(0), _video_uri(1)]
