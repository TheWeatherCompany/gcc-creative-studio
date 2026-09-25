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

import {MODEL_CONFIGS} from '../../common/config/model-config';
import {GalleryItem} from '../../common/models/gallery-item.model';
import {SourceMediaItemLink} from '../../common/models/search.model';

/** Where to go, and the `remixState` the generator there pre-fills from. */
export interface FeedNavigation {
  commands: string[];
  remixState: Record<string, unknown>;
}

/** A reference input as the detail endpoint returns it. */
interface EnrichedAssetLink {
  assetId: number;
  role: string;
  presignedUrl: string;
  presignedThumbnailUrl?: string | null;
}

interface EnrichedMediaItemLink extends SourceMediaItemLink {
  presignedUrl: string;
  presignedThumbnailUrl?: string | null;
}

const FRAME_ROLES = new Set(['start_frame', 'end_frame']);

/**
 * The prompt the user typed. Search results carry it in `metadata` as
 * `originalPrompt`; `prompt` is the rewritten one the model actually saw.
 * GalleryService.mapUnifiedItem falls back to the literal 'Asset' when both
 * are missing, so the raw metadata is read first.
 */
export function feedPrompt(item: GalleryItem): string {
  const metadata = (item.metadata ?? {}) as Record<string, unknown>;
  const fromMetadata = metadata['originalPrompt'] || metadata['prompt'];
  if (typeof fromMetadata === 'string' && fromMetadata) {
    return fromMetadata;
  }
  return item.itemType === 'media_item' && item.prompt !== 'Asset'
    ? (item.prompt ?? '')
    : '';
}

/** The generator page that made this item, or null if none can reuse it. */
export function generatorRoute(item: GalleryItem): '/' | '/video' | null {
  const type = MODEL_CONFIGS.find(m => m.value === item.model)?.type;
  if (type === 'IMAGE') return '/';
  if (type === 'VIDEO') return '/video';
  if (type) return null;
  if (item.mimeType?.startsWith('image/')) return '/';
  if (item.mimeType?.startsWith('video/')) return '/video';
  return null;
}

const preview = (link: {
  presignedUrl: string;
  presignedThumbnailUrl?: string | null;
}) => link.presignedThumbnailUrl || link.presignedUrl;

/**
 * Builds the navigation for the feed's Reuse action: the generator that made
 * `row`, pre-filled with its prompt, model, aspect ratio, style settings and
 * reference inputs. `detail` is the item from GET /gallery/item/:id; search
 * results do not carry reference inputs, colour and tone, or composition.
 */
export function reuseNavigation(
  row: GalleryItem,
  detail: GalleryItem,
): FeedNavigation | null {
  const route = generatorRoute(row);
  if (!route) return null;

  const assets = (detail.enrichedSourceAssets ?? []) as EnrichedAssetLink[];
  const mediaItems = (detail.enrichedSourceMediaItems ??
    []) as EnrichedMediaItemLink[];
  const prompt = feedPrompt(row);
  const aspectRatio = row.aspectRatio ?? detail.aspectRatio;
  const generationModel = row.model ?? detail.model;

  if (route === '/') {
    return {
      commands: ['/'],
      remixState: {
        prompt,
        aspectRatio,
        generationModel,
        style: detail.style,
        lighting: detail.lighting,
        colorAndTone: detail.colorAndTone,
        composition: detail.composition,
        negativePrompt: detail.negativePrompt,
        sourceAssetIds: assets.map(a => a.assetId),
        sourceMediaItems: mediaItems.map(linkOf),
        // The image page reads previewUrls by position within each list, so
        // it can only line up with one of them. Uploaded assets win.
        previewUrls: (assets.length ? assets : mediaItems).map(preview),
      },
    };
  }

  // The video page restores start and end frames only; it has no remix
  // field for ingredient reference images.
  const remixState: Record<string, unknown> = {
    prompt,
    aspectRatio,
    generationModel,
  };
  const frameLinks: SourceMediaItemLink[] = [];
  for (const asset of assets.filter(a => FRAME_ROLES.has(a.role))) {
    const slot = asset.role === 'start_frame' ? 'start' : 'end';
    remixState[`${slot}ImageAssetId`] = asset.assetId;
    remixState[`${slot}ImagePreviewUrl`] = preview(asset);
  }
  for (const item of mediaItems.filter(m => FRAME_ROLES.has(m.role))) {
    const slot = item.role === 'start_frame' ? 'start' : 'end';
    frameLinks.push(linkOf(item));
    remixState[`${slot}ImagePreviewUrl`] = preview(item);
  }
  if (frameLinks.length) {
    remixState['sourceMediaItems'] = frameLinks;
  }
  return {commands: ['/video'], remixState};
}

function linkOf(item: SourceMediaItemLink): SourceMediaItemLink {
  return {
    mediaItemId: item.mediaItemId,
    mediaIndex: item.mediaIndex,
    role: item.role,
  };
}

/*
 * The lightbox's own action buttons (edit, generate video, try-on, and the
 * video tools) emit events for the host to act on. These mirror the media
 * detail page's handlers, so an output opened from the feed behaves the same
 * as one opened from its detail page.
 */

export function editImageNavigation(
  item: GalleryItem,
  index: number,
): FeedNavigation {
  return {
    commands: ['/'],
    remixState: {
      sourceMediaItems: [
        {mediaItemId: item.id, mediaIndex: index, role: 'input'},
      ],
      prompt: feedPrompt(item),
      previewUrl: item.presignedUrls?.[index],
    },
  };
}

export function imageToVideoNavigation(
  item: GalleryItem,
  role: 'start' | 'end',
  index: number,
): FeedNavigation {
  const url = item.presignedUrls?.[index];
  return {
    commands: ['/video'],
    remixState: {
      prompt: feedPrompt(item),
      sourceMediaItems: [
        {
          mediaItemId: item.id,
          mediaIndex: index,
          role: role === 'start' ? 'start_frame' : 'end_frame',
        },
      ],
      startImagePreviewUrl: role === 'start' ? url : undefined,
      endImagePreviewUrl: role === 'end' ? url : undefined,
    },
  };
}

export function vtoNavigation(
  item: GalleryItem,
  index: number,
): FeedNavigation {
  return {
    commands: ['/vto'],
    remixState: {
      modelImageAssetId: item.id,
      modelImagePreviewUrl: item.presignedUrls?.[index],
      modelImageMediaIndex: index,
      modelImageGcsUri: item.gcsUris?.[index],
    },
  };
}

export function editWithOmniNavigation(
  item: GalleryItem,
  index: number,
): FeedNavigation {
  const isAudio = (item.mimeType ?? '').startsWith('audio/');
  const name = feedPrompt(item);
  const remixState: Record<string, unknown> = {
    parentMediaItemId: item.id,
    parentMediaIndex: index,
    generationModel: 'gemini-omni',
    isOmniMode: true,
  };
  if (isAudio) {
    remixState['referenceAudio'] = {
      id: item.id,
      type: item.itemType,
      index,
      name: name || `Audio Input ${item.id}`,
    };
  } else {
    remixState['referenceVideo'] = {
      id: item.id,
      type: item.itemType,
      index,
      name: name || `Video Input ${item.id}`,
      previewUrl:
        item.presignedThumbnailUrls?.[index] ||
        item.presignedUrls?.[index] ||
        '',
    };
  }
  return {commands: ['/video'], remixState};
}

export function extendVideoNavigation(
  item: GalleryItem,
  index: number,
): FeedNavigation {
  return {
    commands: ['/video'],
    remixState: {
      prompt: feedPrompt(item),
      sourceMediaItems: [
        {
          mediaItemId: item.id,
          mediaIndex: index,
          role: 'video_extension_source',
        },
      ],
      startImagePreviewUrl: item.presignedThumbnailUrls?.[index],
      generationModel: 'veo-3.1-generate-001',
    },
  };
}

export function concatenateVideoNavigation(
  item: GalleryItem,
  index: number,
): FeedNavigation {
  return {
    commands: ['/video'],
    remixState: {
      sourceMediaItems: [
        {mediaItemId: item.id, mediaIndex: index, role: 'concatenation_source'},
      ],
      startImagePreviewUrl: item.presignedThumbnailUrls?.[index],
      startConcatenation: true,
    },
  };
}
