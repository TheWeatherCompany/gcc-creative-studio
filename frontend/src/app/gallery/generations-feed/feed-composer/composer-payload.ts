/**
 * Copyright 2026 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  GenerationModelConfig,
  MODEL_CONFIGS,
  clampOutputs,
} from '../../../common/config/model-config';
import {
  ImagenRequest,
  ReferenceImage,
  SourceMediaItemLink,
  VeoRequest,
} from '../../../common/models/search.model';
import {ImageState} from '../../../services/image-state.service';
import {VideoState} from '../../../services/video-state.service';

// Fork: the feed's prompt bar covers the modes whose requests need no page
// state beyond the saved settings. Frames, Extend, Concatenate and
// Ingredients to Video stay on /video, where their input rules live.
export type ComposerMode =
  | 'Text to Image'
  | 'Ingredients to Image'
  | 'Text to Video';

export const COMPOSER_MODES: {
  value: ComposerMode;
  icon: string;
  label: string;
}[] = [
  {value: 'Text to Image', icon: 'description', label: 'Text to Image'},
  {
    value: 'Ingredients to Image',
    icon: 'layers',
    label: 'Ingredients to Image',
  },
  {value: 'Text to Video', icon: 'movie', label: 'Text to Video'},
];

export function mediaTypeFor(mode: ComposerMode): 'IMAGE' | 'VIDEO' {
  return mode === 'Text to Video' ? 'VIDEO' : 'IMAGE';
}

export function modelsFor(mode: ComposerMode): GenerationModelConfig[] {
  return MODEL_CONFIGS.filter(m =>
    m.capabilities.supportedModes.includes(mode),
  );
}

export function findModel(value: string): GenerationModelConfig | undefined {
  return MODEL_CONFIGS.find(m => m.value === value);
}

/** Mirrors HomeComponent.searchTerm (home.component.ts:816-883). */
export function buildImagenPayload(
  state: ImageState,
  mode: ComposerMode,
  references: ReferenceImage[],
  workspaceId: number,
): ImagenRequest {
  const sourceMediaItems: SourceMediaItemLink[] = [];
  const sourceAssetIds: number[] = [];
  if (mode === 'Ingredients to Image') {
    for (const ref of references) {
      if (ref.sourceMediaItem) sourceMediaItems.push(ref.sourceMediaItem);
      else if (ref.sourceAssetId) sourceAssetIds.push(ref.sourceAssetId);
    }
  }
  return {
    prompt: state.prompt,
    generationModel: state.model,
    aspectRatio: state.aspectRatio,
    numberOfMedia: clampOutputs(state.numberOfMedia, findModel(state.model)),
    // The backend takes a named value or null, and ImageStateService starts
    // lighting at '', so blanks go as null (as HomeComponent.saveState does).
    // 'none' is not a lighting either.
    style: state.style || null,
    lighting: state.lighting === 'none' ? null : state.lighting || null,
    colorAndTone: state.colorAndTone || null,
    composition: state.composition || null,
    negativePrompt: state.negativePrompt,
    addWatermark: state.watermark,
    useBrandGuidelines: state.useBrandGuidelines,
    enhancePrompt: state.enhancePrompt,
    googleSearch: state.googleSearch,
    temperature: state.temperature ?? undefined,
    resolution: state.resolution as ImagenRequest['resolution'],
    sourceMediaItems: sourceMediaItems.length ? sourceMediaItems : undefined,
    sourceAssetIds: sourceAssetIds.length ? sourceAssetIds : undefined,
    workspaceId,
  };
}

/**
 * Mirrors VideoComponent.searchTerm (video.component.ts:698-920) for Text to
 * Video only, so none of the frame, reference or extend inputs are sent.
 */
export function buildTextToVideoPayload(
  state: VideoState,
  workspaceId: number,
): VeoRequest {
  const model = findModel(state.model);
  // Mirrors VideoComponent.applyResolutionLimit: Omni renders at 1K only, so a
  // 2K or 4K carried over from Veo would be rejected by the backend.
  const supported = model?.capabilities.supportedResolutions;
  const resolution =
    !supported || (state.resolution && supported.includes(state.resolution))
      ? state.resolution
      : (supported[0] ?? '1K');
  return {
    prompt: state.prompt,
    generationModel: state.model,
    aspectRatio: state.aspectRatio,
    numberOfMedia: clampOutputs(state.numberOfMedia, model),
    durationSeconds: state.durationSeconds,
    generateAudio: state.generateAudio,
    resolution,
    negativePrompt: state.negativePrompt,
    // Same rule as the image builder: a blank is no choice, not a value.
    style: state.style || null,
    lighting: state.lighting || null,
    colorAndTone: state.colorAndTone || null,
    composition: state.composition || null,
    enhancePrompt: state.enhancePrompt,
    useBrandGuidelines: state.useBrandGuidelines,
    workspaceId,
  };
}
