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

import {MAX_OUTPUTS} from '../../../common/config/model-config';
import {ImageState} from '../../../services/image-state.service';
import {VideoState} from '../../../services/video-state.service';
import {buildImagenPayload, buildTextToVideoPayload} from './composer-payload';

const IMAGE_STATE: ImageState = {
  prompt: 'a supercell over Kansas',
  negativePrompt: 'text',
  aspectRatio: '16:9',
  model: 'gemini-3.1-flash-image',
  lighting: 'Golden Hour',
  watermark: true,
  googleSearch: true,
  resolution: '2K',
  style: 'Photorealistic',
  colorAndTone: 'Warm',
  numberOfMedia: 3,
  composition: 'Wide',
  useBrandGuidelines: true,
  enhancePrompt: true,
  temperature: 0.4,
  mode: 'Text to Image',
};

const VIDEO_STATE: VideoState = {
  prompt: 'fog rolling over a harbour',
  aspectRatio: '9:16',
  resolution: '1K',
  model: 'veo-3.1-generate-001',
  style: 'Cinematic',
  colorAndTone: 'Cool',
  lighting: 'Natural',
  numberOfMedia: 2,
  durationSeconds: 6,
  composition: 'Wide',
  generateAudio: false,
  negativePrompt: 'blur',
  useBrandGuidelines: true,
  enhancePrompt: true,
  mode: 'Text to Video',
  referenceImages: [{previewUrl: 'x', sourceAssetId: 1}],
  referenceImagesType: 'STYLE',
  referenceVideo: {id: 3, type: 'source_asset', previewUrl: 'v'},
  referenceAudio: {id: 4, type: 'source_asset', name: 'a'},
};

describe('composer payloads', () => {
  it('carries every field the image page sends, with the workspace', () => {
    const p = buildImagenPayload(IMAGE_STATE, 'Text to Image', [], 5);
    expect(p).toEqual({
      prompt: 'a supercell over Kansas',
      generationModel: 'gemini-3.1-flash-image',
      aspectRatio: '16:9',
      numberOfMedia: 3,
      style: 'Photorealistic',
      lighting: 'Golden Hour',
      colorAndTone: 'Warm',
      composition: 'Wide',
      negativePrompt: 'text',
      addWatermark: true,
      useBrandGuidelines: true,
      enhancePrompt: true,
      googleSearch: true,
      temperature: 0.4,
      resolution: '2K',
      sourceMediaItems: undefined,
      sourceAssetIds: undefined,
      workspaceId: 5,
    });

    // No chosen temperature means the model's own default.
    const auto = buildImagenPayload(
      {...IMAGE_STATE, temperature: null},
      'Text to Image',
      [],
      5,
    );
    expect(auto.temperature).toBeUndefined();
  });

  it('carries every field the video page sends and no inputs', () => {
    const p = buildTextToVideoPayload(VIDEO_STATE, 5);
    expect(p).toEqual({
      prompt: 'fog rolling over a harbour',
      generationModel: 'veo-3.1-generate-001',
      aspectRatio: '9:16',
      numberOfMedia: 2,
      durationSeconds: 6,
      generateAudio: false,
      resolution: '1K',
      negativePrompt: 'blur',
      style: 'Cinematic',
      lighting: 'Natural',
      colorAndTone: 'Cool',
      composition: 'Wide',
      enhancePrompt: true,
      useBrandGuidelines: true,
      workspaceId: 5,
    });
  });

  it('clamps takes to what the backend accepts, for both builders', () => {
    const image = buildImagenPayload(
      {...IMAGE_STATE, numberOfMedia: 9},
      'Text to Image',
      [],
      5,
    );
    const video = buildTextToVideoPayload(
      {...VIDEO_STATE, numberOfMedia: 9},
      5,
    );
    expect([image.numberOfMedia, video.numberOfMedia]).toEqual([
      MAX_OUTPUTS,
      MAX_OUTPUTS,
    ]);
  });

  // Mirrors VideoComponent.applyResolutionLimit, which runs before submit.
  const resolutions: {
    model: string;
    saved: '1K' | '2K' | '4K';
    sent: '1K' | '2K' | '4K';
  }[] = [
    {model: 'gemini-omni-1.1-flash-preview', saved: '2K', sent: '1K'},
    {model: 'veo-3.1-generate-001', saved: '4K', sent: '4K'},
  ];
  for (const c of resolutions) {
    it(`sends a resolution the model renders (${c.model} saved at ${c.saved})`, () => {
      const p = buildTextToVideoPayload(
        {...VIDEO_STATE, model: c.model, resolution: c.saved},
        5,
      );
      expect(p.resolution).toBe(c.sent);
    });
  }
});
