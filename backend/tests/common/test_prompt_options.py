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

"""The options a user picks reach the model on every generation path.

Each test runs the real background worker and reads the request handed to the
model SDK, so it fails if a path stops calling the helper, not just if the
helper's formatting changes.
"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from google.genai.interactions import VideoContent

from src.common.base_dto import (
    ColorAndToneEnum,
    CompositionEnum,
    GenerationModelEnum,
    LightingEnum,
    StyleEnum,
)
from src.common.schema.media_item_model import JobStatusEnum
from src.images.dto.create_imagen_dto import CreateImagenDto
from src.images.imagen_service import _process_image_in_background
from src.users.user_model import UserModel
from src.videos.dto.create_veo_dto import CreateVeoDto
from src.videos.veo_service import _process_video_in_background

PROMPT = "A red barn"
ALL_OPTIONS = {
    "style": StyleEnum.VINTAGE,
    "lighting": LightingEnum.GOLDEN_HOUR,
    "color_and_tone": ColorAndToneEnum.WARM,
    "composition": CompositionEnum.CLOSEUP,
    "negative_prompt": "blurry, text",
    "use_brand_guidelines": True,
}
CHIPS = (
    "Style: Vintage. Lighting: Golden Hour. Colour and tone: Warm. "
    "Composition: Closeup."
)
BRAND = "Brand visual style: Clean and bright.\nBrand tone of voice: Friendly."
AVOID = "Avoid: blurry, text."

PATHS = ["gemini_image", "gemini_edit", "veo", "omni"]


def _dto(path: str, **options):
    if path in ("gemini_image", "gemini_edit"):
        return CreateImagenDto(
            workspace_id=1,
            prompt=PROMPT,
            generation_model=GenerationModelEnum.GEMINI_3_1_FLASH_IMAGE,
            source_asset_ids=[7] if path == "gemini_edit" else None,
            **options,
        )
    return CreateVeoDto(
        workspace_id=1,
        prompt=PROMPT,
        generation_model=(
            GenerationModelEnum.GEMINI_OMNI_FLASH_PREVIEW
            if path == "omni"
            else GenerationModelEnum.VEO_3_1_GENERATE_001
        ),
        aspect_ratio="9:16",
        duration_seconds=4 if path == "omni" else 8,
        **options,
    )


def _brand_repo_class():
    guideline = SimpleNamespace(
        visual_style_summary="Clean and bright",
        tone_of_voice_summary="Friendly.",
    )
    repo_class = MagicMock()
    repo_class.return_value.query = AsyncMock(
        return_value=SimpleNamespace(data=[guideline])
    )
    return repo_class


def _run_image_worker(dto, rewrite):
    """Returns (prompt sent to Gemini, native negative prompt, DB update)."""
    result = MagicMock()
    result.image.gcs_uri = "gs://bucket/out.png"
    with (
        patch("src.images.imagen_service.WorkerDatabase") as db,
        patch("src.images.imagen_service.GenAIModelSetup.init"),
        patch("src.images.imagen_service.MediaRepository") as media_repo,
        patch("src.images.imagen_service.SourceAssetRepository") as assets,
        patch("src.images.imagen_service.GeminiService") as gemini,
        patch("src.images.imagen_service.GcsService"),
        patch("src.images.imagen_service.IamSignerCredentials"),
        patch("src.images.imagen_service.generate_image_thumbnail_from_gcs"),
        patch(
            "src.brand_guidelines.repository.brand_guideline_repository."
            "BrandGuidelineRepository",
            _brand_repo_class(),
        ),
        patch(
            "src.images.imagen_service.gemini_generate_image",
            return_value=(result, None),
        ) as generate,
    ):
        db.return_value.__aenter__.return_value = MagicMock()
        media_repo.return_value = AsyncMock()
        assets.return_value.get_by_id = AsyncMock(
            return_value=SimpleNamespace(
                gcs_uri="gs://bucket/source.png", mime_type="image/png"
            )
        )
        gemini.return_value.enhance_prompt_from_dto = AsyncMock(
            return_value=rewrite
        )
        _process_image_in_background(
            media_item_id=1,
            request_dto=dto,
            current_user=UserModel(
                id=1, email="u@example.com", name="U", roles=["user"]
            ),
        )
    update = media_repo.return_value.update.call_args[0][1]
    assert update["status"] == JobStatusEnum.COMPLETED, update
    return generate.call_args.kwargs["prompt"], None, update


def _run_video_worker(dto, rewrite):
    """Returns (prompt sent to Veo or Omni, native negative prompt, update)."""
    with (
        patch("src.database.WorkerDatabase") as db,
        patch("src.videos.veo_service.GenAIModelSetup.init") as veo_client,
        patch(
            "src.videos.veo_service.GenAIModelSetup.get_omni_client"
        ) as omni_client,
        patch("src.videos.veo_service.MediaRepository") as media_repo,
        patch("src.videos.veo_service.SourceAssetRepository"),
        patch("src.videos.veo_service.GeminiService") as gemini,
        patch("src.videos.veo_service.GcsService") as gcs,
        patch("src.videos.veo_service.generate_thumbnail", return_value=None),
        patch(
            "src.brand_guidelines.repository.brand_guideline_repository."
            "BrandGuidelineRepository",
            _brand_repo_class(),
        ),
    ):
        db.return_value.__aenter__.return_value = MagicMock()
        media_repo.return_value = AsyncMock()
        gcs.return_value.upload_file_to_gcs.return_value = "gs://bucket/v.mp4"
        gemini.return_value.enhance_prompt_from_dto = AsyncMock(
            return_value=rewrite
        )
        operation = veo_client.return_value.models.generate_videos.return_value
        operation.done = True
        operation.error = None
        operation.response.generated_videos[0].video.uri = "gs://bucket/v.mp4"
        omni_client.return_value.interactions.create.return_value = MagicMock(
            id="interaction-1",
            steps=[
                MagicMock(
                    type="model_output",
                    signature=None,
                    content=[VideoContent(data="AAAA", mime_type="video/mp4")],
                )
            ],
        )
        _process_video_in_background(
            media_item_id=1, request_dto=dto, user_email="u@example.com"
        )
    update = media_repo.return_value.update.call_args[0][1]
    assert update["status"] == JobStatusEnum.COMPLETED, update
    if dto.generation_model.is_omni:
        call = omni_client.return_value.interactions.create.call_args
        return call.kwargs["input"][0]["text"], None, update
    call = veo_client.return_value.models.generate_videos.call_args
    return call.kwargs["prompt"], call.kwargs["config"].negative_prompt, update


def _run(path, dto, rewrite=None):
    runner = _run_video_worker if path in ("veo", "omni") else _run_image_worker
    return runner(dto, rewrite)


def _omni_aspect_suffix(path):
    # Omni appends its own aspect ratio directive after everything else.
    return (
        "\nAspect ratio: 9:16 vertical portrait format. Resolution: 720p."
        if path == "omni"
        else ""
    )


@pytest.mark.parametrize("path", PATHS)
@pytest.mark.parametrize(
    "options, additions",
    [
        (ALL_OPTIONS, None),  # None: the full set expected for the path
        ({}, ""),
    ],
    ids=["all_options", "no_options"],
)
def test_enhance_off_sends_every_option_to_the_model(path, options, additions):
    sent, native_negative, update = _run(path, _dto(path, **options))

    if additions is None:
        # Veo takes the negative prompt natively; the others need it in text.
        avoid = "" if path == "veo" else f"\n{AVOID}"
        additions = f"\n\n{CHIPS}\n{BRAND}{avoid}"
    assert sent == PROMPT + additions + _omni_aspect_suffix(path)
    if path == "veo":
        assert native_negative == options.get("negative_prompt", "")
    # The feed and detail page show `prompt`, so it stays what the user typed.
    assert update["prompt"] == PROMPT
    assert update["rewritten_prompt"] == (
        PROMPT + additions if additions else None
    )


def _json_rewrite(negative_prompts):
    return json.dumps(
        {
            "metadata": {"prompt_name": "Barn"},
            "constraints": {"negative_prompts": negative_prompts},
        }
    )


@pytest.mark.parametrize(
    "path, rewrite, expected",
    [
        # The rewriter folds in the chips and brand guidelines; only the
        # negative phrases it dropped are added, inside its own JSON.
        (
            "gemini_image",
            _json_rewrite(["Blurry", "cartoon"]),
            _json_rewrite(["Blurry", "cartoon", "text"]),
        ),
        (
            "omni",
            _json_rewrite(["blurry", "text"]),
            _json_rewrite(["blurry", "text"]),
        ),
        # Veo takes the negative prompt natively, so the rewrite goes as is.
        ("veo", "Rewritten barn", "Rewritten barn"),
        # An edit bypasses the rewriter (it is wrapped in a fixed instruction
        # block), so nothing was folded in and everything is added once.
        (
            "gemini_edit",
            "EDIT BLOCK",
            f"EDIT BLOCK\n\n{CHIPS}\n{BRAND}\n{AVOID}",
        ),
    ],
    ids=["gemini_image", "omni", "veo", "gemini_edit"],
)
def test_enhance_on_adds_nothing_the_rewriter_already_applied(
    path, rewrite, expected
):
    dto = _dto(path, enhance_prompt=True, **ALL_OPTIONS)

    sent, native_negative, update = _run(path, dto, rewrite)

    assert sent == expected + _omni_aspect_suffix(path)
    if path == "veo":
        assert native_negative == "blurry, text"
    assert update["prompt"] == expected
    assert "rewritten_prompt" not in update
