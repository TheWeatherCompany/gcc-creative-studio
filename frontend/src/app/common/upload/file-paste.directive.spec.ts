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

import {Component} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MatDialog, MatDialogRef} from '@angular/material/dialog';
import {FilePasteDirective} from './file-paste.directive';

@Component({
  template: `
    <div
      appFilePaste
      appFilePasteAccept="image/*"
      [appFilePasteMultiple]="multiple"
      [appFilePasteDisabled]="disabled"
      (filesPasted)="pasted = $event"
      (filesRejected)="rejected = $event"
    >
      <textarea class="prompt"></textarea>
    </div>
  `,
  imports: [FilePasteDirective],
})
class HostComponent {
  multiple = false;
  disabled = false;
  pasted: File[] | null = null;
  rejected: File[] | null = null;
}

function paste(target: EventTarget, dt: DataTransfer): ClipboardEvent {
  const event = new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

function screenshot(): DataTransfer {
  const dt = new DataTransfer();
  dt.items.add(new File(['x'], 'image.png', {type: 'image/png'}));
  return dt;
}

describe('FilePasteDirective', () => {
  const dialogRef = {} as MatDialogRef<unknown>;
  let openDialogs: MatDialogRef<unknown>[];

  function create(inDialog: boolean) {
    openDialogs = [];
    TestBed.configureTestingModule({
      providers: [
        {
          provide: MatDialog,
          useValue: {
            get openDialogs() {
              return openDialogs;
            },
          },
        },
        ...(inDialog ? [{provide: MatDialogRef, useValue: dialogRef}] : []),
      ],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('uploads a pasted screenshot under a readable name', () => {
    const fixture = create(false);
    const event = paste(document.body, screenshot());
    expect(event.defaultPrevented).toBeTrue();
    expect(fixture.componentInstance.pasted![0].name).toMatch(
      /^pasted-\d{4}-\d{2}-\d{2}-\d{6}\.png$/,
    );
  });

  it('lets a text field paste text when the clipboard has text too', () => {
    const fixture = create(false);
    const dt = screenshot();
    dt.setData('text/plain', 'A1\tB1');
    const textarea = fixture.nativeElement.querySelector('.prompt');
    const event = paste(textarea, dt);
    expect(event.defaultPrevented).toBeFalse();
    expect(fixture.componentInstance.pasted).toBeNull();
  });

  it('takes an image that arrives with text when no text field is focused', () => {
    const fixture = create(false);
    const dt = screenshot();
    dt.setData('text/plain', 'A1\tB1');
    paste(document.body, dt);
    expect(fixture.componentInstance.pasted?.length).toBe(1);
  });

  it('still takes an image-only paste while a text field is focused', () => {
    const fixture = create(false);
    const textarea = fixture.nativeElement.querySelector('.prompt');
    paste(textarea, screenshot());
    expect(fixture.componentInstance.pasted?.length).toBe(1);
  });

  it('leaves text-only pastes alone', () => {
    const fixture = create(false);
    const dt = new DataTransfer();
    dt.setData('text/plain', 'a prompt');
    expect(paste(document.body, dt).defaultPrevented).toBeFalse();
    expect(fixture.componentInstance.pasted).toBeNull();
  });

  it('on a page, yields to any open dialog', () => {
    const fixture = create(false);
    openDialogs.push({} as MatDialogRef<unknown>);
    paste(document.body, screenshot());
    expect(fixture.componentInstance.pasted).toBeNull();
  });

  it('in a dialog, only handles the paste while that dialog is on top', () => {
    const fixture = create(true);
    openDialogs.push(dialogRef, {} as MatDialogRef<unknown>);
    paste(document.body, screenshot());
    expect(fixture.componentInstance.pasted).toBeNull();

    openDialogs.pop();
    paste(document.body, screenshot());
    expect(fixture.componentInstance.pasted?.length).toBe(1);
  });

  it('does nothing while disabled', () => {
    const fixture = create(false);
    fixture.componentInstance.disabled = true;
    fixture.detectChanges();
    const event = paste(document.body, screenshot());
    expect(event.defaultPrevented).toBeFalse();
    expect(fixture.componentInstance.pasted).toBeNull();
  });

  it('skips a paste another handler already consumed', () => {
    const consume = (e: Event) => e.preventDefault();
    document.addEventListener('paste', consume);
    try {
      const fixture = create(false);
      paste(document.body, screenshot());
      expect(fixture.componentInstance.pasted).toBeNull();
    } finally {
      document.removeEventListener('paste', consume);
    }
  });

  it('reports a pasted file the accept filter refuses, and swallows the paste', () => {
    const fixture = create(false);
    const dt = new DataTransfer();
    dt.items.add(new File(['x'], 'clip.mp4', {type: 'video/mp4'}));
    const event = paste(document.body, dt);
    expect(event.defaultPrevented).toBeTrue();
    expect(fixture.componentInstance.pasted).toBeNull();
    expect(fixture.componentInstance.rejected?.map(f => f.name)).toEqual([
      'clip.mp4',
    ]);
  });

  it('emits only the first pasted file unless multiple', () => {
    const fixture = create(false);
    const dt = screenshot();
    dt.items.add(new File(['x'], 'b.png', {type: 'image/png'}));
    paste(document.body, dt);
    expect(fixture.componentInstance.pasted?.length).toBe(1);

    fixture.componentInstance.multiple = true;
    fixture.detectChanges();
    paste(document.body, dt);
    expect(fixture.componentInstance.pasted?.length).toBe(2);
  });
});
