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
  Component,
  ElementRef,
  EventEmitter,
  Output,
  inject,
} from '@angular/core';
import {MatDialog} from '@angular/material/dialog';
import {MatIconRegistry} from '@angular/material/icon';
import {MatSnackBar} from '@angular/material/snack-bar';
import {DomSanitizer} from '@angular/platform-browser';
import {finalize} from 'rxjs';
import {FlowPromptBoxComponent} from '../../../common/components/flow-prompt-box/flow-prompt-box.component';
import {
  ImageSelectorComponent,
  MediaItemSelection,
} from '../../../common/components/image-selector/image-selector.component';
import {
  ASPECT_RATIO_LABELS,
  GenerationModelConfig,
  clampOutputs,
  maxOutputsFor,
} from '../../../common/config/model-config';
import {MediaItem} from '../../../common/models/media-item.model';
import {ReferenceImage} from '../../../common/models/search.model';
import {SourceAssetResponseDto} from '../../../common/services/source-asset.service';
import {
  ImageState,
  ImageStateService,
} from '../../../services/image-state.service';
import {SearchService} from '../../../services/search/search.service';
import {
  VideoState,
  VideoStateService,
} from '../../../services/video-state.service';
import {WorkspaceStateService} from '../../../services/workspace/workspace-state.service';
import {
  handleErrorSnackbar,
  handleInfoSnackbar,
} from '../../../utils/handleMessageSnackbar';
import {
  COMPOSER_MODES,
  ComposerMode,
  buildImagenPayload,
  buildTextToVideoPayload,
  findModel,
  mediaTypeFor,
  modelsFor,
} from './composer-payload';

/** The settings the image and video state services both hold. */
type SharedSettings = Partial<
  Pick<
    ImageState & VideoState,
    'prompt' | 'aspectRatio' | 'model' | 'numberOfMedia' | 'resolution'
  >
>;

type AspectRatioOption = {
  value: string;
  viewValue: string;
  disabled: boolean;
  icon: string;
};

/**
 * Fork: the prompt bar at the bottom of the generations feed. It hosts the
 * same flow-prompt-box as the image and video pages and shares their saved
 * settings, so a model or ratio picked here is the one the page opens with.
 */
@Component({
  selector: 'app-feed-composer',
  standalone: true,
  imports: [FlowPromptBoxComponent],
  templateUrl: './feed-composer.component.html',
  styleUrl: './feed-composer.component.scss',
})
export class FeedComposerComponent {
  /** The job the backend just created, so the feed can show it at once. */
  @Output() submitted = new EventEmitter<MediaItem>();

  private readonly imageState = inject(ImageStateService);
  private readonly videoState = inject(VideoStateService);
  private readonly search = inject(SearchService);
  private readonly workspaces = inject(WorkspaceStateService);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly modes = COMPOSER_MODES;
  mode: ComposerMode = this.initialMode();
  // Held as fields, not rebuilt in getters: a new array on every change
  // detection pass would trip the bound inputs' change checks.
  models = modelsFor(this.mode);
  references: ReferenceImage[] = [];
  isSubmitting = false;
  isRewriting = false;
  private ratioOptions?: {
    model: GenerationModelConfig;
    list: AspectRatioOption[];
  };

  constructor() {
    // The Generate button's icon; each host registers it (see HomeComponent).
    inject(MatIconRegistry).addSvgIcon(
      'gemini-spark-icon',
      inject(DomSanitizer).bypassSecurityTrustResourceUrl(
        '../../assets/images/gemini-spark-icon.svg',
      ),
    );
  }

  /** Moves keyboard focus into the bar's prompt field. */
  focusPrompt(): void {
    this.host.nativeElement.querySelector('textarea')?.focus();
  }

  get isVideo(): boolean {
    return mediaTypeFor(this.mode) === 'VIDEO';
  }

  get isLoading(): boolean {
    return this.isSubmitting || this.isRewriting;
  }

  private get state(): ImageState | VideoState {
    return this.isVideo
      ? this.videoState.getState()
      : this.imageState.getState();
  }

  private update(partial: SharedSettings, video = this.isVideo): void {
    if (video) this.videoState.updateState(partial);
    else this.imageState.updateState(partial);
  }

  get model(): GenerationModelConfig | undefined {
    return findModel(this.state.model) ?? this.models[0];
  }

  get prompt(): string {
    return this.state.prompt;
  }

  get aspectRatio(): string {
    return this.state.aspectRatio;
  }

  /** The takes shown: the saved pick within the model's limit, as on the pages. */
  get outputs(): number {
    return clampOutputs(this.state.numberOfMedia, this.model);
  }

  get maxOutputs(): number {
    return maxOutputsFor(this.model);
  }

  get resolution(): '1K' | '2K' | '4K' {
    return this.state.resolution as '1K' | '2K' | '4K';
  }

  get duration(): number | undefined {
    return this.isVideo
      ? this.videoState.getState().durationSeconds
      : undefined;
  }

  get temperature(): number | null {
    return this.isVideo ? null : this.imageState.getState().temperature;
  }

  get aspectRatioOptions(): AspectRatioOption[] {
    const model = this.model;
    if (!model) return [];
    if (this.ratioOptions?.model !== model) {
      this.ratioOptions = {
        model,
        list: model.capabilities.supportedAspectRatios.map(value => ({
          value,
          viewValue: ASPECT_RATIO_LABELS[value] ?? value,
          disabled: false,
          icon: iconFor(value),
        })),
      };
    }
    return this.ratioOptions.list;
  }

  /**
   * The bar is one text box: any non-blank text showing in it stays when the
   * media type changes, and is written to the other media type's saved state
   * so that page opens with it. A blank box leaves the other page's saved
   * prompt alone. The mode itself is not saved; it is the page's own setting.
   */
  onModeChanged(mode: string): void {
    const wasVideo = this.isVideo;
    const prompt = this.prompt;
    this.mode = mode as ComposerMode;
    this.models = modelsFor(this.mode);
    if (wasVideo !== this.isVideo && prompt.trim()) this.update({prompt});
  }

  onPromptChanged(prompt: string): void {
    this.update({prompt});
  }

  onModelSelected(model: GenerationModelConfig): void {
    this.applyModel(model);
  }

  onAspectRatioChanged(aspectRatio: string): void {
    this.update({aspectRatio});
  }

  /** Stores the pick as chosen; the model's limit is applied when it is read. */
  onOutputsChanged(numberOfMedia: number): void {
    this.update({numberOfMedia});
  }

  onResolutionChanged(resolution: '1K' | '2K' | '4K'): void {
    this.update({resolution});
  }

  onDurationChanged(durationSeconds: number): void {
    this.videoState.updateState({durationSeconds});
  }

  onTemperatureChanged(temperature: number | null): void {
    this.imageState.updateState({temperature});
  }

  /** Mirrors HomeComponent.selectModel and VideoComponent.selectModel. */
  private applyModel(model: GenerationModelConfig): void {
    const capabilities = model.capabilities;
    const partial: SharedSettings = {model: model.value};
    if (!capabilities.supportedAspectRatios.includes(this.aspectRatio)) {
      partial.aspectRatio = capabilities.supportedAspectRatios[0];
    }
    this.update(partial);
    if (this.isVideo) {
      // Every video model supports audio, so a pick turns it back on.
      this.videoState.updateState({generateAudio: true});
      return;
    }
    if (!capabilities.supportsGoogleSearch) {
      this.imageState.updateState({googleSearch: false});
    }
    this.references = this.references.slice(0, capabilities.maxReferenceImages);
  }

  /** Mirrors HomeComponent.openImageSelector and processInput. */
  openReferencePicker(): void {
    const max = this.model?.capabilities.maxReferenceImages ?? 0;
    const remaining = max - this.references.length;
    if (remaining <= 0) {
      handleInfoSnackbar(
        this.snackBar,
        `You can only add up to ${max} reference images for this model.`,
      );
      return;
    }
    this.dialog
      .open(ImageSelectorComponent, {
        width: '90vw',
        height: '80vh',
        maxWidth: '90vw',
        data: {mimeType: 'image/*', multiSelect: true, maxSelection: remaining},
        panelClass: 'image-selector-dialog',
      })
      .afterClosed()
      .subscribe((result?: PickerResult | PickerResult[]) => {
        if (!result) return;
        const added: ReferenceImage[] = [];
        let skippedDuplicate = false;
        for (const picked of Array.isArray(result) ? result : [result]) {
          const ref = toReferenceImage(picked);
          if (!ref) continue;
          if ([...this.references, ...added].some(r => isSameImage(r, ref))) {
            skippedDuplicate = true;
          } else {
            added.push(ref);
          }
        }
        if (skippedDuplicate) {
          handleInfoSnackbar(this.snackBar, 'This image is already selected.');
        }
        this.references = [...this.references, ...added].slice(0, max);
      });
  }

  clearReference(index: number): void {
    this.references = this.references.filter((_, i) => i !== index);
  }

  /**
   * Mirrors HomeComponent.rewritePrompt and VideoComponent.rewritePrompt,
   * except that the prompt is not blanked while waiting, so a failed or empty
   * rewrite leaves the text as it was. The result goes to the box as it is
   * when it arrives, in whichever media type is showing then, and only if
   * the box still holds the prompt that was sent; a prompt edited meanwhile
   * is not overwritten.
   */
  rewritePrompt(): void {
    const video = this.isVideo;
    const userPrompt = this.prompt;
    if (!userPrompt?.trim()) return;
    this.isRewriting = true;
    this.search
      .rewritePrompt({targetType: video ? 'video' : 'image', userPrompt})
      .pipe(finalize(() => (this.isRewriting = false)))
      .subscribe({
        next: ({prompt}) => {
          if (prompt?.trim() && this.prompt === userPrompt) {
            this.update({prompt});
          }
        },
        error: err => handleErrorSnackbar(this.snackBar, err, 'Rewrite prompt'),
      });
  }

  /** Mirrors HomeComponent.searchTerm and VideoComponent.searchTerm. */
  generate(): void {
    const video = this.isVideo;
    if (!this.state.prompt?.trim()) {
      handleInfoSnackbar(
        this.snackBar,
        `Please enter a prompt to generate ${video ? 'a video' : 'an image'}.`,
      );
      return;
    }
    const workspaceId = this.workspaces.getActiveWorkspaceId();
    if (!workspaceId) {
      handleErrorSnackbar(
        this.snackBar,
        {message: 'Please select a workspace first.'},
        'Workspace',
      );
      return;
    }
    const request$ = video
      ? this.search.startVeoGeneration(
          buildTextToVideoPayload(this.videoState.getState(), workspaceId),
        )
      : this.search.startImagenGeneration(
          buildImagenPayload(
            this.imageState.getState(),
            this.mode,
            this.references,
            workspaceId,
          ),
        );
    this.isSubmitting = true;
    request$.pipe(finalize(() => (this.isSubmitting = false))).subscribe({
      next: item => this.submitted.emit(item),
      error: err => handleErrorSnackbar(this.snackBar, err, 'Search'),
    });
  }

  private initialMode(): ComposerMode {
    const saved = this.imageState.getState().mode;
    return saved === 'Ingredients to Image' ? saved : 'Text to Image';
  }
}

/** What ImageSelectorComponent closes with: a gallery pick or an upload. */
type PickerResult = MediaItemSelection | SourceAssetResponseDto;

/** Mirrors HomeComponent.processInput (home.component.ts:1155-1216). */
function toReferenceImage(result: PickerResult): ReferenceImage | null {
  if ('gcsUri' in result) {
    return result.presignedUrl
      ? {previewUrl: result.presignedUrl, sourceAssetId: result.id}
      : null;
  }
  const index = result.selectedIndex || 0;
  const previewUrl = result.mediaItem.presignedUrls?.[index];
  return previewUrl
    ? {
        previewUrl,
        sourceMediaItem: {
          mediaItemId: result.mediaItem.id,
          mediaIndex: index,
          role: 'input',
        },
      }
    : null;
}

function isSameImage(a: ReferenceImage, b: ReferenceImage): boolean {
  if (a.sourceAssetId && a.sourceAssetId === b.sourceAssetId) return true;
  return (
    !!a.sourceMediaItem &&
    !!b.sourceMediaItem &&
    a.sourceMediaItem.mediaItemId === b.sourceMediaItem.mediaItemId &&
    a.sourceMediaItem.mediaIndex === b.sourceMediaItem.mediaIndex
  );
}

function iconFor(ratio: string): string {
  const [w, h] = ratio.split(':').map(Number);
  if (w === h) return 'crop_square';
  return w > h ? 'crop_16_9' : 'crop_portrait';
}
