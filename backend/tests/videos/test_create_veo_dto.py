# Copyright 2025 Google LLC
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
"""Tests for Create Veo Dto."""


import pytest
from pydantic import ValidationError

from src.common.base_dto import (
    GenerationModelEnum,
    ReferenceImageTypeEnum,
)
from src.common.schema.media_item_model import SourceMediaItemLink
from src.videos.dto.create_veo_dto import CreateVeoDto, ReferenceImageDto


def test_create_veo_dto_valid():
    dto = CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=GenerationModelEnum.VEO_3_QUALITY,
        aspect_ratio="16:9",
    )
    assert dto.prompt == "Test"


def test_validate_video_aspect_ratio_error():
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test", workspace_id=1, aspect_ratio="1:1"
        )  # Invalid
    assert "Invalid aspect ratio for video" in str(exc_info.value)


def test_validate_source_media_items_invalid_role():
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test",
            workspace_id=1,
            source_media_items=[
                SourceMediaItemLink(
                    media_item_id=1,
                    media_index=0,
                    role="invalid_role",
                ),
            ],
        )
    # Pydantic validation error or enum validation error
    assert "invalid_role" in str(exc_info.value)


def test_validate_source_media_items_model_conflict():
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test",
            workspace_id=1,
            generation_model=GenerationModelEnum.VEO_3_QUALITY,
            reference_images=[
                ReferenceImageDto(
                    asset_id=1,
                    reference_type=ReferenceImageTypeEnum.ASSET,
                ),
            ],
            source_media_items=[],  # Force validator to run
        )
    assert "Reference images/media are only supported by" in str(exc_info.value)


def test_validate_source_media_items_conflicting_inputs():
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test",
            workspace_id=1,
            generation_model=GenerationModelEnum.VEO_3_1_PREVIEW,
            start_image_asset_id={"id": 1, "type": "source_asset"},
            reference_images=[
                ReferenceImageDto(
                    asset_id=2,
                    reference_type=ReferenceImageTypeEnum.ASSET,
                ),
            ],
            source_media_items=[],  # Force validator to run
        )
    assert "Reference media cannot be used at the same time" in str(
        exc_info.value
    )


def test_validate_video_generation_model_error():
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test", workspace_id=1, generation_model="invalid_model"
        )
    assert (
        "Invalid generation model for video" in str(exc_info.value)
        or "enum" in str(exc_info.value).lower()
    )


def test_create_veo_dto_with_omni_references():
    dto = CreateVeoDto(
        prompt="Test Omni",
        workspace_id=1,
        generation_model=GenerationModelEnum.GEMINI_OMNI,
        reference_video={"id": 10, "type": "media_item"},
        reference_audio={"id": 20, "type": "media_item"},
        parent_media_item_id=15,
    )
    assert dto.generation_model == GenerationModelEnum.GEMINI_OMNI
    assert dto.reference_video.id == 10
    assert dto.reference_video.type == "media_item"
    assert dto.reference_audio.id == 20
    assert dto.reference_audio.type == "media_item"
    assert dto.parent_media_item_id == 15


def test_validate_resolution_by_model():
    # Gemini Omni - 1K is OK
    CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=GenerationModelEnum.GEMINI_OMNI,
        resolution="1K",
    )

    # Gemini Omni - 2K is error
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test",
            workspace_id=1,
            generation_model=GenerationModelEnum.GEMINI_OMNI,
            resolution="2K",
        )
    assert "does not support resolution '2K'" in str(exc_info.value)

    # Veo 3.1 Lite - 2K is OK
    CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=GenerationModelEnum.VEO_3_1_LITE_GENERATE_001,
        resolution="2K",
    )

    # Veo 3.1 Lite - 4K is error
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test",
            workspace_id=1,
            generation_model=GenerationModelEnum.VEO_3_1_LITE_GENERATE_001,
            resolution="4K",
        )
    assert "does not support resolution '4K'" in str(exc_info.value)

    # Veo 3.1 Generate 001 - 4K is OK
    CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=GenerationModelEnum.VEO_3_1_GENERATE_001,
        resolution="4K",
    )


def test_validate_duration_seconds():
    # 10s is valid for Gemini Omni Flash Preview
    dto_flash = CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=GenerationModelEnum.GEMINI_OMNI_FLASH_PREVIEW,
        duration_seconds=10,
    )
    assert dto_flash.duration_seconds == 10

    # 10s is valid for Gemini Omni 1.1 Flash Preview
    dto_flash_1_1 = CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=GenerationModelEnum.GEMINI_OMNI_1_1_FLASH_PREVIEW,
        duration_seconds=10,
    )
    assert dto_flash_1_1.duration_seconds == 10

    # 10s is valid for Gemini Omni
    dto_omni = CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=GenerationModelEnum.GEMINI_OMNI,
        duration_seconds=10,
    )
    assert dto_omni.duration_seconds == 10

    # 8s is valid for Veo models
    dto_veo = CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=GenerationModelEnum.VEO_3_1_GENERATE_001,
        duration_seconds=8,
    )
    assert dto_veo.duration_seconds == 8

    # 10s is invalid for Veo models (max 8s)
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test",
            workspace_id=1,
            generation_model=GenerationModelEnum.VEO_3_1_GENERATE_001,
            duration_seconds=10,
        )
    assert "does not support duration '10s'" in str(exc_info.value)
    assert "Maximum supported duration: 8s" in str(exc_info.value)

    # 11s exceeds max limit
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test",
            workspace_id=1,
            generation_model=GenerationModelEnum.GEMINI_OMNI_FLASH_PREVIEW,
            duration_seconds=11,
        )
    assert "Maximum supported duration: 10s" in str(exc_info.value)


OMNI_1_2 = GenerationModelEnum.GEMINI_OMNI_1_2_FLASH
ASSET = {"id": 1, "type": "source_asset"}

# Inputs that cap Omni 1.2 at 10s. A start frame is deliberately absent.
CAPPING_INPUTS = {
    "reference image": {"reference_images": [ReferenceImageDto(asset_id=1)]},
    "reference video": {"reference_video": ASSET},
    "source video": {"source_video_asset_id": ASSET},
    "end frame": {"end_image_asset_id": ASSET},
    "end frame role": {
        "source_media_items": [
            SourceMediaItemLink(
                media_item_id=1, media_index=0, role="end_frame"
            )
        ]
    },
    "source video role": {
        "source_media_items": [
            SourceMediaItemLink(
                media_item_id=1, media_index=0, role="video_extension_source"
            )
        ]
    },
    "reference image role": {
        "source_media_items": [
            SourceMediaItemLink(
                media_item_id=1, media_index=0, role="image_reference_asset"
            )
        ]
    },
}


@pytest.mark.parametrize("duration", [3, 10, 15])
def test_omni_1_2_allows_up_to_15s_without_capping_inputs(duration):
    dto = CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=OMNI_1_2,
        duration_seconds=duration,
    )
    assert dto.duration_seconds == duration


def test_omni_1_2_start_frame_alone_does_not_cap_duration():
    dto = CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=OMNI_1_2,
        start_image_asset_id=ASSET,
        duration_seconds=15,
    )
    assert dto.duration_seconds == 15


@pytest.mark.parametrize("inputs", CAPPING_INPUTS.values(), ids=CAPPING_INPUTS)
def test_omni_1_2_caps_duration_at_10s_for_capping_inputs(inputs):
    dto = CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=OMNI_1_2,
        duration_seconds=10,
        **inputs,
    )
    assert dto.duration_seconds == 10

    for duration in (11, 15):
        with pytest.raises(ValidationError) as exc_info:
            CreateVeoDto(
                prompt="Test",
                workspace_id=1,
                generation_model=OMNI_1_2,
                duration_seconds=duration,
                **inputs,
            )
        assert "Maximum supported duration: 10s" in str(exc_info.value)


@pytest.mark.parametrize(
    "model",
    [
        GenerationModelEnum.GEMINI_OMNI,
        GenerationModelEnum.GEMINI_OMNI_FLASH_PREVIEW,
        GenerationModelEnum.GEMINI_OMNI_1_1_FLASH_PREVIEW,
    ],
)
def test_older_omni_models_stay_capped_at_10s(model):
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test",
            workspace_id=1,
            generation_model=model,
            duration_seconds=12,
        )
    assert "Maximum supported duration: 10s" in str(exc_info.value)


def test_veo_stays_capped_at_8s_above_the_field_bound():
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test",
            workspace_id=1,
            generation_model=GenerationModelEnum.VEO_3_1_GENERATE_001,
            duration_seconds=15,
        )
    assert "Maximum supported duration: 8s" in str(exc_info.value)


def test_omni_1_2_rejects_reference_audio_naming_the_model():
    with pytest.raises(ValidationError) as exc_info:
        CreateVeoDto(
            prompt="Test",
            workspace_id=1,
            generation_model=OMNI_1_2,
            reference_audio=ASSET,
            duration_seconds=5,
        )
    assert (
        "Audio references are not supported by 'gemini-omni-1.2-flash'"
        in str(exc_info.value)
    )


def test_omni_1_1_still_accepts_reference_audio():
    dto = CreateVeoDto(
        prompt="Test",
        workspace_id=1,
        generation_model=GenerationModelEnum.GEMINI_OMNI_1_1_FLASH_PREVIEW,
        reference_audio=ASSET,
        duration_seconds=5,
    )
    assert dto.reference_audio.id == 1
