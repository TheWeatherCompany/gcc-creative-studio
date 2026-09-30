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

import {MatSnackBar} from '@angular/material/snack-bar';
import {defer, finalize, Observable} from 'rxjs';
import {SourceAssetResponseDto} from '../../services/source-asset.service';
import {
  handleErrorSnackbar,
  handleInfoSnackbar,
} from '../../../utils/handleMessageSnackbar';

/**
 * Uploads a drop or paste started that have not landed yet. Pages block
 * Generate while any are pending, or the generation would go out without
 * the file the user just added.
 */
export class PendingUploads {
  private count = 0;

  get any(): boolean {
    return this.count > 0;
  }

  track<T>(upload: Observable<T>): Observable<T> {
    return defer(() => {
      this.count++;
      return upload.pipe(finalize(() => this.count--));
    });
  }
}

/** How a page takes reference images dropped or pasted onto its prompt box. */
export interface ReferenceUploadTarget {
  /** The current model's limit. Read again as each upload lands. */
  maxReferences(): number;
  referenceCount(): number;
  /** Whether the page's mode still takes reference images. */
  takesReferences(): boolean;
  upload(file: File): Observable<SourceAssetResponseDto>;
  add(asset: SourceAssetResponseDto): void;
}

/**
 * Uploads as many of `files` as the model has room for and adds each as it
 * lands, unless the page has moved on in the meantime.
 */
export function uploadReferenceFiles(
  files: File[],
  target: ReferenceUploadTarget,
  snackBar: MatSnackBar,
): void {
  const remaining = target.maxReferences() - target.referenceCount();
  if (remaining <= 0) {
    handleInfoSnackbar(
      snackBar,
      `You can only add up to ${target.maxReferences()} reference images for this model.`,
    );
    return;
  }
  if (files.length > remaining) {
    handleInfoSnackbar(
      snackBar,
      `Only the first ${remaining} of ${files.length} images were added.`,
    );
  }
  for (const file of files.slice(0, remaining)) {
    target.upload(file).subscribe({
      next: asset => {
        if (!asset?.id) return;
        // While this one uploaded, the user may have left the mode, or a
        // second drop or paste may have filled the free slots.
        if (!target.takesReferences()) {
          handleInfoSnackbar(
            snackBar,
            `${file.name} wasn't added: this mode doesn't take reference images.`,
          );
        } else if (target.referenceCount() >= target.maxReferences()) {
          handleInfoSnackbar(
            snackBar,
            `${file.name} wasn't added: this model takes up to ${target.maxReferences()} reference images.`,
          );
        } else {
          target.add(asset);
        }
      },
      error: err => handleErrorSnackbar(snackBar, err, 'Image upload'),
    });
  }
}
