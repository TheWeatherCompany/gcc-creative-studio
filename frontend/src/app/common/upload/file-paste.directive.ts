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
  Directive,
  EventEmitter,
  HostListener,
  Input,
  Output,
  inject,
} from '@angular/core';
import {MatDialog, MatDialogRef} from '@angular/material/dialog';
import {
  extractFiles,
  nameClipboardFile,
  partitionByAccept,
} from './upload-files';

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLInputElement ||
    target.isContentEditable
  );
}

/**
 * Listens for pastes anywhere in the document and emits clipboard files.
 * Only one instance should react to a given paste: one inside a dialog
 * handles it while that dialog is topmost, one on a page handles it while
 * no dialog is open.
 *
 * A paste whose files are all refused by `accept` is only claimed when the
 * host listens to `filesRejected`; otherwise it is left to the browser, so a
 * host that gives no feedback does not swallow the paste. (A drop, unlike a
 * paste, is always claimed, because the browser would open the file.)
 */
@Directive({
  selector: '[appFilePaste]',
  standalone: true,
})
export class FilePasteDirective {
  @Input() appFilePasteAccept: string | null = null;
  @Input() appFilePasteMultiple = false;
  @Input() appFilePasteDisabled = false;

  @Output() filesPasted = new EventEmitter<File[]>();
  @Output() filesRejected = new EventEmitter<File[]>();

  private dialog = inject(MatDialog);
  private dialogRef = inject(MatDialogRef, {optional: true});

  @HostListener('document:paste', ['$event'])
  onPaste(event: ClipboardEvent): void {
    if (this.appFilePasteDisabled || event.defaultPrevented) return;
    if (!this.isActiveScope()) return;

    const dt = event.clipboardData;
    const files = extractFiles(dt);
    if (files.length === 0) return;
    // Spreadsheet and doc copies carry an image rendering alongside the
    // text; in a text field the text is what the user meant.
    if (isTextField(event.target) && dt?.types.includes('text/plain')) return;

    const {accepted, rejected} = partitionByAccept(
      files.map(f => nameClipboardFile(f)),
      this.appFilePasteAccept,
    );
    if (accepted.length === 0 && !this.filesRejected.observed) return;
    event.preventDefault();
    if (rejected.length) this.filesRejected.emit(rejected);
    if (accepted.length) {
      this.filesPasted.emit(
        this.appFilePasteMultiple ? accepted : accepted.slice(0, 1),
      );
    }
  }

  private isActiveScope(): boolean {
    const open = this.dialog.openDialogs;
    if (this.dialogRef) return open[open.length - 1] === this.dialogRef;
    return open.length === 0;
  }
}
