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

"""Puts every generation option the user picked in front of the model.

Fork-owned. Upstream only sends style, lighting, colour and tone,
composition and brand guidelines to the model through the Enhance Prompt
rewriter, so they are dropped when Enhance is off, and always dropped for a
Gemini image edit, whose prompt bypasses the rewriter. The negative prompt
has no field on the Gemini image or Gemini Omni APIs, so it never reached
those models at all.

`apply_prompt_options` runs after any rewrite and adds what the model would
otherwise not get, once:

- the option chips and brand guidelines, unless the rewriter already
  folded them in;
- the negative prompt, unless the API takes it natively (Veo, Imagen). A
  JSON rewrite gets it in `constraints.negative_prompts`, where the rewriter
  puts it, so the stored prompt stays parseable and nothing is repeated.
"""

import json
from enum import Enum

from src.brand_guidelines.dto.brand_guideline_search_dto import (
    BrandGuidelineSearchDto,
)
from src.brand_guidelines.repository.brand_guideline_repository import (
    BrandGuidelineRepository,
)
from src.images.dto.create_imagen_dto import CreateImagenDto
from src.videos.dto.create_veo_dto import CreateVeoDto

_OPTION_LABELS = (
    ("style", "Style"),
    ("lighting", "Lighting"),
    ("color_and_tone", "Colour and tone"),
    ("composition", "Composition"),
)


def _sentence(label: str, text: str) -> str:
    text = text.strip()
    return (
        f"{label}: {text}"
        if text.endswith((".", "!", "?"))
        else f"{label}: {text}."
    )


def _is_gemini_edit(dto: CreateImagenDto | CreateVeoDto) -> bool:
    """Mirrors GeminiService.enhance_prompt_from_dto, which wraps an edit in a
    fixed instruction block instead of rewriting it."""
    return (
        isinstance(dto, CreateImagenDto)
        and dto.generation_model.is_gemini_image_model
        and bool(dto.source_asset_ids or dto.source_media_items)
    )


def _negative_prompt_is_native(dto: CreateImagenDto | CreateVeoDto) -> bool:
    """Veo's GenerateVideosConfig and Imagen's GenerateImagesConfig take a
    negative_prompt; Gemini's GenerateContentConfig and Omni's Interactions
    API have no such field."""
    if isinstance(dto, CreateVeoDto):
        return not dto.generation_model.is_omni
    return not dto.generation_model.is_gemini_image_model


def _option_line(dto: CreateImagenDto | CreateVeoDto) -> str | None:
    parts = []
    for field, label in _OPTION_LABELS:
        value = getattr(dto, field)
        if value:
            value = value.value if isinstance(value, Enum) else str(value)
            parts.append(_sentence(label, value))
    return " ".join(parts) or None


async def _brand_guideline_lines(
    repo: BrandGuidelineRepository, workspace_id: int
) -> list[str]:
    """The same guideline, and the same two summaries, the rewriter gets."""
    response = await repo.query(
        BrandGuidelineSearchDto(workspace_id=workspace_id, limit=1),
        workspace_id=workspace_id,
    )
    if not response or not response.data:
        return []
    guideline = response.data[0]
    summaries = (
        ("Brand visual style", guideline.visual_style_summary),
        ("Brand tone of voice", guideline.tone_of_voice_summary),
    )
    return [
        _sentence(label, text)
        for label, text in summaries
        if text and text.strip()
    ]


def _merge_negative_into_rewrite(prompt: str, negative: str) -> str | None:
    """Adds the user's negative phrases to a JSON rewrite's
    constraints.negative_prompts, skipping ones the rewriter already kept.
    Returns None when the rewrite is not in that shape."""
    try:
        data = json.loads(prompt)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    constraints = data.setdefault("constraints", {})
    if not isinstance(constraints, dict):
        return None
    existing = constraints.setdefault("negative_prompts", [])
    if not isinstance(existing, list):
        return None
    seen = {str(item).strip().casefold() for item in existing}
    missing = [
        phrase
        for phrase in (p.strip() for p in negative.split(","))
        if phrase and phrase.casefold() not in seen
    ]
    if not missing:
        return prompt
    existing.extend(missing)
    return json.dumps(data, ensure_ascii=False)


async def apply_prompt_options(
    dto: CreateImagenDto | CreateVeoDto,
    prompt: str,
    brand_guideline_repo: BrandGuidelineRepository,
) -> str:
    """Returns the text to send to the model: `prompt` (the user's text, or
    the rewriter's output when Enhance is on) plus whichever of the user's
    options would not otherwise reach the model."""
    lines: list[str] = []
    rewriter_folded_options = dto.enhance_prompt and not _is_gemini_edit(dto)
    if not rewriter_folded_options:
        if option_line := _option_line(dto):
            lines.append(option_line)
        if dto.use_brand_guidelines:
            lines.extend(
                await _brand_guideline_lines(
                    brand_guideline_repo, dto.workspace_id
                )
            )

    negative = dto.negative_prompt.strip()
    if negative and not _negative_prompt_is_native(dto):
        merged = (
            _merge_negative_into_rewrite(prompt, negative)
            if dto.enhance_prompt
            else None
        )
        if merged is not None:
            prompt = merged
        else:
            lines.append(_sentence("Avoid", negative))

    if not lines:
        return prompt
    return prompt + "\n\n" + "\n".join(lines)


def recorded_prompts(
    dto: CreateImagenDto | CreateVeoDto, prompt_before_options: str
) -> dict[str, str | None]:
    """The media item's prompt columns, once `dto.prompt` holds the text sent.

    `prompt` keeps today's meaning, which the feed and detail page display:
    the user's text, or the rewrite when Enhance is on. Anything this module
    added to the user's own text goes in `rewritten_prompt` instead, so the
    text sent is always `rewritten_prompt or prompt`.
    """
    if dto.enhance_prompt:
        return {"prompt": dto.prompt}
    return {
        "prompt": prompt_before_options,
        "rewritten_prompt": (
            dto.prompt if dto.prompt != prompt_before_options else None
        ),
    }
