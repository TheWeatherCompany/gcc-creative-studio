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

"""Guards that every job's arguments survive the trip through Cloud Tasks.

The DTOs carry validators, aliases and enums, and upstream syncs change them.
If a job's arguments stop round-tripping, it fails on the worker in prod, so
this runs each registered job's real signature with representative values.
"""

import json

import pytest

from src.audios.audio_service import _process_audio_in_background
from src.audios.dto.create_audio_dto import CreateAudioDto
from src.common.base_dto import AspectRatioEnum, GenerationModelEnum
from src.images.dto.create_imagen_dto import CreateImagenDto
from src.images.dto.vto_dto import VtoDto
from src.images.imagen_service import (
    _process_image_in_background,
    _process_upload_upscale_in_background,
    _process_vto_in_background,
)
from src.jobs.job_codec import (
    STAGED_BYTES_KEY,
    decode_call,
    encode_call,
    staged_uris,
)
from src.jobs.job_registry import ALLOWED_JOBS, job_name
from src.source_assets.schema.source_asset_model import (
    AssetScopeEnum,
    AssetTypeEnum,
)
from src.users.user_model import UserModel, UserRoleEnum
from src.videos.dto.concatenate_videos_dto import (
    ConcatenateVideosDto,
    ConcatenationInput,
)
from src.videos.dto.create_veo_dto import CreateVeoDto
from src.videos.veo_service import (
    _process_video_concatenation_in_background,
    _process_video_in_background,
)

USER = UserModel(
    id=3, email="u@example.com", roles=[UserRoleEnum.USER], name="U"
)

CASES = [
    (
        _process_image_in_background,
        {
            "media_item_id": 1,
            "request_dto": CreateImagenDto(
                workspace_id=1,
                prompt="A sunset on a beach",
                generation_model=(
                    GenerationModelEnum.GEMINI_3_1_FLASH_IMAGE_PREVIEW
                ),
                aspect_ratio="1:1",
            ),
            "current_user": USER,
        },
    ),
    (
        _process_vto_in_background,
        {
            "media_item_id": 2,
            "request_dto": VtoDto(
                workspace_id=1,
                person_image={"source_asset_id": 101},
                top_image={"source_asset_id": 102},
            ),
            "current_user": USER,
        },
    ),
    (
        _process_upload_upscale_in_background,
        {
            "media_item_id": 3,
            "workspace_id": 1,
            "user": USER,
            "gcs_uri": "gs://bucket/in.png",
            "file_bytes": b"\x89PNG\r\n\x1a\n",
            "filename": "in.png",
            "upscale_factor": "x2",
            "aspect_ratio": AspectRatioEnum.RATIO_1_1,
            "asset_type": next(iter(AssetTypeEnum)),
            "scope": next(iter(AssetScopeEnum)),
            "enhance_input_image": True,
            "image_preservation_factor": 0.5,
        },
    ),
    (
        _process_video_in_background,
        {
            "media_item_id": 4,
            "request_dto": CreateVeoDto(
                prompt="Test",
                workspace_id=1,
                generation_model=GenerationModelEnum.VEO_3_QUALITY,
                aspect_ratio="16:9",
            ),
            "user_email": "u@example.com",
        },
    ),
    (
        _process_video_concatenation_in_background,
        {
            "media_item_id": 5,
            "request_dto": ConcatenateVideosDto(
                workspace_id=1,
                name="Concat Video",
                inputs=[
                    ConcatenationInput(type="media_item", id=1),
                    ConcatenationInput(type="media_item", id=2),
                ],
            ),
        },
    ),
    (
        _process_audio_in_background,
        {
            "media_item_id": 6,
            "request_dto": CreateAudioDto(
                workspace_id=1,
                prompt="A cute cat running",
                model=GenerationModelEnum.LYRIA_002,
                sample_count=1,
            ),
            "user_email": "u@example.com",
            "user_id": 3,
        },
    ),
]


class _FakeBlobStore:
    def __init__(self):
        self.blobs = {}

    def stage(self, data: bytes) -> str:
        uri = f"gs://bucket/job_payloads/{len(self.blobs)}"
        self.blobs[uri] = data
        return uri

    def load(self, uri: str) -> bytes:
        return self.blobs[uri]


def test_every_allowed_job_has_a_round_trip_case():
    assert {job_name(fn) for fn, _ in CASES} == ALLOWED_JOBS


@pytest.mark.parametrize(
    "fn,kwargs", CASES, ids=[fn.__name__ for fn, _ in CASES]
)
def test_job_arguments_survive_a_json_round_trip(fn, kwargs):
    store = _FakeBlobStore()
    wire = json.loads(
        json.dumps(encode_call(fn, (), kwargs, stage_bytes=store.stage))
    )
    assert decode_call(fn, wire, load_bytes=store.load) == kwargs


def test_bytes_are_staged_instead_of_inlined():
    store = _FakeBlobStore()
    fn, kwargs = CASES[2]
    wire = encode_call(fn, (), kwargs, stage_bytes=store.stage)
    assert wire["file_bytes"] == {
        STAGED_BYTES_KEY: "gs://bucket/job_payloads/0"
    }
    assert staged_uris(wire) == ["gs://bucket/job_payloads/0"]
    assert store.blobs == {"gs://bucket/job_payloads/0": kwargs["file_bytes"]}


def test_positional_arguments_are_bound_to_their_names():
    # audio_service submits its job positionally.
    fn, kwargs = CASES[5]
    wire = encode_call(
        fn, tuple(kwargs.values()), {}, stage_bytes=_FakeBlobStore().stage
    )
    assert set(wire) == set(kwargs)
