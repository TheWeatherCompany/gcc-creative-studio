/**
 * Copyright 2025 Google LLC
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

import {Component, Inject, OnInit, ViewChild} from '@angular/core';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogRef,
} from '@angular/material/dialog';
import {catchError, finalize, forkJoin, map, Observable, of} from 'rxjs';
import {partitionByAccept, withInferredType} from '../../upload/upload-files';
import {MatSnackBar} from '@angular/material/snack-bar';
import {UserService} from '../../services/user.service';
import {
  SourceAssetResponseDto,
  SourceAssetService,
} from '../../services/source-asset.service';
import {AssetTypeEnum} from '../../../admin/source-assets-management/source-asset.model';
import {MediaItem} from '../../models/media-item.model';
import {MediaGalleryComponent} from '../../../gallery/media-gallery/media-gallery.component';
import {ImageCropperDialogComponent} from '../image-cropper-dialog/image-cropper-dialog.component';
import {
  handleErrorSnackbar,
  handleInfoSnackbar,
  handleRejectedFilesSnackbar,
} from '../../../utils/handleMessageSnackbar';

// Mirrors how handleErrorSnackbar picks the message for a failed request.
function errorReason(error: unknown): string {
  const e = error as {
    error?: {detail?: string | {msg?: string}[]};
    message?: string;
  };
  const detail = e?.error?.detail;
  const msg = Array.isArray(detail) ? detail[0]?.msg : detail;
  return msg || e?.message || 'Something went wrong';
}

export interface MediaItemSelection {
  mediaItem: MediaItem;
  selectedIndex: number;
}

@Component({
  selector: 'app-image-selector',
  templateUrl: './image-selector.component.html',
  styleUrls: ['./image-selector.component.scss'],
  standalone: false,
})
export class ImageSelectorComponent implements OnInit {
  isUploading = false;
  selectedMediaItems = new Map<string, any>();
  shouldCrop = false;
  currentUserEmail: string | null = null;

  @ViewChild(MediaGalleryComponent) mediaGallery!: MediaGalleryComponent;

  constructor(
    public dialogRef: MatDialogRef<ImageSelectorComponent>,
    private sourceAssetService: SourceAssetService,
    private dialog: MatDialog,
    private userService: UserService,
    private snackBar: MatSnackBar,
    @Inject(MAT_DIALOG_DATA)
    public data: {
      mimeType:
        | 'image/*'
        | 'image/png'
        | 'video/mp4'
        | 'video/*'
        | 'audio/*'
        | 'audio/mpeg'
        | null;
      assetType: AssetTypeEnum;
      enableUpscale?: boolean;
      multiSelect?: boolean;
      showFooter?: boolean;
      maxSelection?: number;
    },
  ) {
    this.dialogRef.addPanelClass('image-selector-dialog');
  }

  ngOnInit(): void {
    const userDetails = this.userService.getUserDetails();
    this.currentUserEmail = userDetails?.email || null;
  }

  // This method is called by the file input or drop event inside this component
  handleFileSelect(file: File): void {
    const isImage =
      file.type.startsWith('image/') ||
      /\.(jpg|jpeg|png|gif|webp|avif)$/i.test(file.name);
    const isVideoOrAudio =
      file.type.startsWith('video/') ||
      file.type.startsWith('audio/') ||
      /\.(mp4|webm|mov|avi|mkv|mp3|wav|ogg|m4a|aac|flac|wma)$/i.test(file.name);

    if (isImage) {
      if (this.shouldCrop) {
        // If shouldCrop is true, open the cropper dialog
        const cropperDialogRef = ImageCropperDialogComponent.open(this.dialog, {
          imageFile: file,
          assetType: this.data.assetType,
          enableUpscale: this.data.enableUpscale,
        });

        cropperDialogRef.subscribe(
          (asset: SourceAssetResponseDto | undefined) => {
            if (asset) {
              this.dialogRef.close(asset);
            }
          },
        );
      } else {
        // If shouldCrop is false, upload directly
        this.isUploading = true;
        this.sourceAssetService
          .uploadAsset(file, {assetType: this.data.assetType})
          .pipe(finalize(() => (this.isUploading = false)))
          .subscribe({
            next: asset => {
              if (asset) {
                this.dialogRef.close(asset);
              }
            },
            error: err => handleErrorSnackbar(this.snackBar, err, 'Upload'),
          });
      }
    } else if (isVideoOrAudio) {
      // If it's a video or audio, upload it directly from here
      this.isUploading = true;
      this.uploadMediaDirectly(file)
        .pipe(finalize(() => (this.isUploading = false)))
        .subscribe({
          next: asset => this.dialogRef.close(asset),
          error: err => handleErrorSnackbar(this.snackBar, err, 'Upload'),
        });
    } else {
      this.onFilesRejected([file]);
    }
  }

  private uploadMediaDirectly(file: File): Observable<SourceAssetResponseDto> {
    // No options needed; backend handles video/audio aspect ratio
    return this.sourceAssetService.uploadAsset(file);
  }

  /** Entry point for dropped, pasted and picked files. */
  onFilesAdded(files: File[]): void {
    if (this.isUploading || files.length === 0) return;

    const limit = this.data.maxSelection ?? files.length;
    const batch = files.slice(0, limit);
    if (files.length > limit) {
      handleInfoSnackbar(
        this.snackBar,
        `Only the first ${limit} of ${files.length} files were added.`,
      );
    }
    // A single file, including one left after the cap, keeps the existing
    // path so Edit before upload still applies.
    if (batch.length === 1) {
      this.handleFileSelect(batch[0]);
      return;
    }
    if (this.shouldCrop) {
      handleInfoSnackbar(
        this.snackBar,
        'Edit before upload works on one file at a time, so these were uploaded as they are.',
      );
    }

    this.isUploading = true;
    // Each upload catches its own error so one failure cannot cancel the
    // others; the dialog closes with whatever made it.
    forkJoin(
      batch.map(file =>
        this.uploadFile(file).pipe(
          map(asset => ({file, asset})),
          catchError(error => of({file, error})),
        ),
      ),
    )
      .pipe(finalize(() => (this.isUploading = false)))
      .subscribe(results => {
        const uploaded: SourceAssetResponseDto[] = [];
        const failed: {file: File; error: unknown}[] = [];
        for (const result of results) {
          if ('asset' in result) {
            uploaded.push(result.asset);
          } else {
            console.error('Upload failed for', result.file.name, result.error);
            failed.push({file: result.file, error: result.error});
          }
        }
        if (failed.length) {
          // Same reason the single-file path shows, kept per file.
          const reasons = failed
            .map(({file, error}) => `${file.name}: ${errorReason(error)}`)
            .join('; ');
          handleErrorSnackbar(
            this.snackBar,
            new Error(`Couldn't upload ${reasons}`),
            'Upload',
          );
        }
        if (uploaded.length) this.dialogRef.close(uploaded);
      });
  }

  onFilesRejected(files: File[]): void {
    handleRejectedFilesSnackbar(this.snackBar, files);
  }

  /** Images dragged straight from another web page arrive as a URL. */
  onUriDropped(url: string): void {
    if (this.isUploading) return;
    this.isUploading = true;
    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.blob();
      })
      .then(blob => {
        this.isUploading = false;
        this.onFilesAdded([
          new File([blob], 'downloaded_image', {type: blob.type}),
        ]);
      })
      .catch(err => {
        this.isUploading = false;
        console.error('Failed to fetch dropped URL', url, err);
        handleInfoSnackbar(
          this.snackBar,
          "That site doesn't allow its images to be downloaded directly. Save the image to your computer first, then drag or paste it here.",
        );
      });
  }

  onFileInputChange(event: Event): void {
    const input = event.currentTarget as HTMLInputElement;
    // The input's accept attribute is only a hint (some pickers offer "All
    // files"), so filter the same way drop and paste do.
    const {accepted, rejected} = partitionByAccept(
      Array.from(input.files ?? []).map(withInferredType),
      this.getAcceptTypes(),
    );
    if (rejected.length) this.onFilesRejected(rejected);
    this.onFilesAdded(accepted);
    // Lets the user pick the same file twice in a row.
    input.value = '';
  }

  private uploadFile(file: File): Observable<SourceAssetResponseDto> {
    const isImage = file.type.startsWith('image/');
    return this.sourceAssetService.uploadAsset(
      file,
      isImage ? {assetType: this.data.assetType} : {},
    );
  }

  onMediaSelected(selection: MediaItemSelection): void {
    const item = selection.mediaItem as any;
    const id = `${item.itemType || 'media_item'}:${item.id}`;
    if (this.selectedMediaItems.has(id)) {
      this.selectedMediaItems.delete(id);
    } else {
      if (this.data.maxSelection === 1) {
        this.selectedMediaItems.clear();
      } else if (
        this.data.maxSelection &&
        this.selectedMediaItems.size >= this.data.maxSelection
      ) {
        return;
      }
      this.selectedMediaItems.set(id, selection);
    }
    // Recreate Map to trigger change detection
    this.selectedMediaItems = new Map(this.selectedMediaItems);
  }

  onMediaItemSelected(selection: MediaItemSelection): void {
    if (this.data.multiSelect || this.data.showFooter) {
      // In multi-select mode or when footer is shown, we don't close on single item selection
      // Instead, we just let MediaGalleryComponent handle the toggle and wait for Select btn
      return;
    }
    const item = selection.mediaItem as any;
    if (item.itemType === 'source_asset') {
      // Map back to SourceAssetResponseDto for backwards compatibility
      const asset: SourceAssetResponseDto = {
        id: item.id,
        userId: String(item.userId || ''),
        gcsUri: item.gcsUris?.[0] || '',
        originalFilename: item.prompt || '',
        mimeType: item.mimeType || '',
        aspectRatio: item.aspectRatio || '',
        fileHash: '',
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        presignedUrl: item.presignedUrls?.[0] || '',
        presignedThumbnailUrl: item.presignedThumbnailUrls?.[0],
        presignedOriginalUrl: item.originalPresignedUrls?.[0] || '',
      };
      this.dialogRef.close(asset);
    } else {
      this.dialogRef.close(selection);
    }
  }

  closeWithSelection(): void {
    const totalSelected = this.selectedMediaItems.size;
    if (totalSelected === 0) return;

    const results = Array.from(this.selectedMediaItems.values()).map(
      selection => {
        const item = (selection as any).mediaItem as any;
        if (item.itemType === 'source_asset') {
          return {
            id: item.id,
            userId: String(item.userId || ''),
            gcsUri: item.gcsUris?.[0] || '',
            originalFilename: item.prompt || '',
            mimeType: item.mimeType || '',
            aspectRatio: item.aspectRatio || '',
            fileHash: '',
            createdAt: item.createdAt,
            updatedAt: item.createdAt,
            presignedUrl: item.presignedUrls?.[0] || '',
            presignedThumbnailUrl: item.presignedThumbnailUrls?.[0],
            presignedOriginalUrl: item.originalPresignedUrls?.[0] || '',
          } as SourceAssetResponseDto;
        }
        return selection as unknown as MediaItemSelection;
      },
    );

    // If multiSelect is false but we somehow got here, return just the first item
    if (!this.data.multiSelect && results.length > 0) {
      this.dialogRef.close(results[0]);
    } else {
      this.dialogRef.close(results);
    }
  }

  onAssetSelected(asset: SourceAssetResponseDto): void {
    this.dialogRef.close(asset);
  }

  /**
   * Returns the accept types for the file input.
   * Uses explicit file extensions for better browser/OS compatibility.
   */
  getAcceptTypes(): string {
    if (!this.data.mimeType) {
      return 'image/*,video/*,audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.wma';
    }

    if (
      this.data.mimeType === 'audio/*' ||
      this.data.mimeType === 'audio/mpeg'
    ) {
      // Include explicit audio extensions for better compatibility
      return 'audio/*,.mp3,.wav,.ogg,.m4a,.aac,.flac,.wma,.webm';
    }

    if (
      this.data.mimeType === 'video/*' ||
      this.data.mimeType === 'video/mp4'
    ) {
      return 'video/*,.mp4,.webm,.mov,.avi,.mkv';
    }

    return this.data.mimeType;
  }
}
