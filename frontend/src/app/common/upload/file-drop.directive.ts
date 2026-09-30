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
  HostBinding,
  HostListener,
  Input,
  Output,
} from '@angular/core';
import {extractFiles, extractUri, partitionByAccept} from './upload-files';

/**
 * Turns the host into a drop target for files from outside the app.
 * Drags that carry no files (gallery cards, folder cards) pass straight
 * through, so the host's own drop handlers for those still fire.
 */
@Directive({
  selector: '[appFileDrop]',
  exportAs: 'appFileDrop',
  standalone: true,
})
export class FileDropDirective {
  /** Same syntax as the `accept` attribute on a file input. */
  @Input() appFileDropAccept: string | null = null;
  @Input() appFileDropMultiple = false;
  @Input() appFileDropDisabled = false;

  @Output() filesDropped = new EventEmitter<File[]>();
  @Output() filesRejected = new EventEmitter<File[]>();
  /** Only fires, and only claims URL drags, when something subscribes. */
  @Output() uriDropped = new EventEmitter<string>();

  @HostBinding('class.file-drop-active') active = false;

  // dragenter/dragleave fire for every child the pointer crosses, so a
  // plain boolean flickers off mid-drag.
  private depth = 0;

  @HostListener('dragenter', ['$event'])
  onDragEnter(event: DragEvent): void {
    if (!this.isExternalDrag(event)) return;
    event.preventDefault();
    this.depth++;
    this.active = !this.appFileDropDisabled;
  }

  @HostListener('dragover', ['$event'])
  onDragOver(event: DragEvent): void {
    if (!this.isExternalDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = this.appFileDropDisabled
        ? 'none'
        : 'copy';
    }
  }

  @HostListener('dragleave', ['$event'])
  onDragLeave(event: DragEvent): void {
    if (!this.isExternalDrag(event)) return;
    this.depth = Math.max(0, this.depth - 1);
    if (this.depth === 0) this.active = false;
  }

  @HostListener('drop', ['$event'])
  onDrop(event: DragEvent): void {
    if (!this.isExternalDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    this.depth = 0;
    this.active = false;
    if (this.appFileDropDisabled) return;

    const files = extractFiles(event.dataTransfer);
    if (files.length === 0) {
      const uri = extractUri(event.dataTransfer);
      if (uri) this.uriDropped.emit(uri);
      return;
    }
    const {accepted, rejected} = partitionByAccept(
      files,
      this.appFileDropAccept,
    );
    if (rejected.length) this.filesRejected.emit(rejected);
    if (accepted.length) {
      this.filesDropped.emit(
        this.appFileDropMultiple ? accepted : accepted.slice(0, 1),
      );
    }
  }

  private isExternalDrag(event: DragEvent): boolean {
    const types = Array.from(event.dataTransfer?.types ?? []);
    return (
      types.includes('Files') ||
      (this.uriDropped.observed && types.includes('text/uri-list'))
    );
  }
}
