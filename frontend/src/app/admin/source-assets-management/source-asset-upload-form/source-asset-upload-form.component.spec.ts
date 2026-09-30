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

import {ApplicationRef} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {ReactiveFormsModule, FormsModule} from '@angular/forms';
import {
  MatDialog,
  MatDialogRef,
  MatDialogModule,
} from '@angular/material/dialog';
import {MatSnackBar, MatSnackBarModule} from '@angular/material/snack-bar';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatSelectModule} from '@angular/material/select';
import {MatInputModule} from '@angular/material/input';
import {MatIconModule} from '@angular/material/icon';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {SourceAssetUploadFormComponent} from './source-asset-upload-form.component';
import {SourceAssetsService} from '../source-assets.service';
import {FileDropDirective} from '../../../common/upload/file-drop.directive';
import {FilePasteDirective} from '../../../common/upload/file-paste.directive';

describe('SourceAssetUploadFormComponent', () => {
  let component: SourceAssetUploadFormComponent;
  let fixture: ComponentFixture<SourceAssetUploadFormComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [SourceAssetUploadFormComponent],
      imports: [
        ReactiveFormsModule,
        FormsModule,
        MatDialogModule,
        MatSnackBarModule,
        MatFormFieldModule,
        MatSelectModule,
        MatInputModule,
        MatIconModule,
        MatProgressSpinnerModule,
        NoopAnimationsModule,
        FileDropDirective,
        FilePasteDirective,
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: MatDialogRef,
          useValue: {close: jasmine.createSpy('close')},
        },
        {
          provide: MatSnackBar,
          useValue: {open: jasmine.createSpy('open')},
        },
        {
          provide: SourceAssetsService,
          useValue: {uploadSourceAsset: jasmine.createSpy('uploadSourceAsset')},
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(SourceAssetUploadFormComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  const file = (name: string, type: string) => new File(['x'], name, {type});

  function dropOnFileRow(files: File[]): void {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    fixture.nativeElement.querySelector('.border-dashed').dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  it('setFile makes the form ready to upload', () => {
    expect(component.form.get('file')?.valid).toBeFalse();

    component.setFile(file('hero.png', 'image/png'));

    expect(component.form.valid).toBeTrue();
    expect(component.fileName).toBe('hero.png');
    expect(component.form.get('file')?.touched).toBeTrue();
  });

  it('takes the file chosen in the file dialog', () => {
    const input: HTMLInputElement =
      fixture.nativeElement.querySelector('input[type=file]');
    const dt = new DataTransfer();
    dt.items.add(file('picked.png', 'image/png'));
    input.files = dt.files;

    input.dispatchEvent(new Event('change'));

    expect(component.fileName).toBe('picked.png');
  });

  for (const [name, type] of [
    ['clip.mp4', 'video/mp4'],
    ['hero.png', 'image/png'],
  ]) {
    it(`takes a dropped ${type}`, () => {
      dropOnFileRow([file(name, type)]);
      expect(component.fileName).toBe(name);
    });
  }

  it('ignores a dropped file that is neither image nor video', () => {
    dropOnFileRow([file('notes.pdf', 'application/pdf')]);
    expect(component.fileName).toBeNull();
  });

  it('ignores a drop while an upload is in progress', () => {
    component.isUploading = true;
    fixture.detectChanges();

    dropOnFileRow([file('hero.png', 'image/png')]);

    expect(component.fileName).toBeNull();
  });

  describe('opened as a dialog', () => {
    let opened: SourceAssetUploadFormComponent;

    function paste(f: File): void {
      const dt = new DataTransfer();
      dt.items.add(f);
      document.dispatchEvent(
        new ClipboardEvent('paste', {clipboardData: dt, cancelable: true}),
      );
    }

    beforeEach(() => {
      // Pasting is scoped to the topmost dialog, so it needs a real one.
      const ref = TestBed.inject(MatDialog).open(
        SourceAssetUploadFormComponent,
      );
      opened = ref.componentInstance;
    });

    it('takes a pasted screenshot under a readable name', () => {
      paste(file('image.png', 'image/png'));
      expect(opened.fileName).toMatch(/^pasted-.*\.png$/);
    });

    it('ignores a pasted video', () => {
      paste(file('clip.mp4', 'video/mp4'));
      expect(opened.fileName).toBeNull();
    });

    it('ignores a paste while an upload is in progress', () => {
      opened.isUploading = true;
      TestBed.inject(ApplicationRef).tick();

      paste(file('image.png', 'image/png'));

      expect(opened.fileName).toBeNull();
    });
  });
});
