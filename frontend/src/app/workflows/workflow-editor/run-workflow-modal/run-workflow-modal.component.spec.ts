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
import {CommonModule} from '@angular/common';
import {Injector, NO_ERRORS_SCHEMA} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {ReactiveFormsModule} from '@angular/forms';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogRef,
} from '@angular/material/dialog';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {Subject, throwError} from 'rxjs';

import {setAppInjector} from '../../../app-injector';
import {NotificationService} from '../../../common/services/notification.service';
import {SourceAssetService} from '../../../common/services/source-asset.service';
import {FileDropDirective} from '../../../common/upload/file-drop.directive';
import {RunWorkflowModalComponent} from './run-workflow-modal.component';

describe('RunWorkflowModalComponent', () => {
  let fixture: ComponentFixture<RunWorkflowModalComponent>;
  let component: RunWorkflowModalComponent;
  let uploadAsset: jasmine.Spy;
  let notifications: jasmine.SpyObj<NotificationService>;

  const png = () => new File(['x'], 'in.png', {type: 'image/png'});
  const uploaded = {id: 9, presignedUrl: 'https://example.test/in.png'};

  function dropOn(zone: number, file = png()): void {
    const dt = new DataTransfer();
    dt.items.add(file);
    fixture.nativeElement
      .querySelectorAll('.border-dashed')
      [zone].dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
  }

  beforeEach(() => {
    uploadAsset = jasmine.createSpy('uploadAsset');
    notifications = jasmine.createSpyObj('NotificationService', ['show']);

    TestBed.configureTestingModule({
      declarations: [RunWorkflowModalComponent],
      imports: [
        CommonModule,
        ReactiveFormsModule,
        MatSnackBarModule,
        FileDropDirective,
      ],
      providers: [
        {provide: NotificationService, useValue: notifications},
        {provide: SourceAssetService, useValue: {uploadAsset}},
        {provide: MatDialogRef, useValue: {close: () => {}}},
        {provide: MatDialog, useValue: {open: () => {}}},
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            userInputStep: {
              outputs: {
                first: {type: 'image'},
                second: {type: 'image'},
              },
            },
          },
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
    setAppInjector(TestBed.inject(Injector));

    fixture = TestBed.createComponent(RunWorkflowModalComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('fills the input the file was dropped on, and only that one', () => {
    const upload = new Subject<any>();
    uploadAsset.and.returnValue(upload);

    dropOn(1);
    upload.next(uploaded);
    fixture.detectChanges();

    expect(uploadAsset).toHaveBeenCalledTimes(1);
    expect(component.runForm.get('second')?.value).toEqual({
      sourceAssetId: 9,
      previewUrl: 'https://example.test/in.png',
    });
    expect(component.runForm.get('first')?.value).toBeNull();
  });

  it('does not replace an image the input already holds', () => {
    component.referenceImages['first'] = {sourceAssetId: 1, previewUrl: 'u'};

    component.onReferenceFileAdded(png(), 'first');

    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it('only offers the drop highlight on inputs that are still empty', () => {
    component.referenceImages['first'] = {sourceAssetId: 1, previewUrl: 'u'};
    fixture.detectChanges();
    const [filled, empty] = Array.from<HTMLElement>(
      fixture.nativeElement.querySelectorAll('.border-dashed'),
    );

    [filled, empty].forEach(zone => {
      const dt = new DataTransfer();
      dt.items.add(png());
      zone.dispatchEvent(
        new DragEvent('dragenter', {dataTransfer: dt, cancelable: true}),
      );
    });
    fixture.detectChanges();

    expect(filled.classList).not.toContain('file-drop-active');
    expect(empty.classList).toContain('file-drop-active');
  });

  it('toasts a failed upload and leaves the input empty', () => {
    uploadAsset.and.returnValue(
      throwError(() => ({message: 'File too large'})),
    );

    component.onReferenceFileAdded(png(), 'first');

    expect(notifications.show).toHaveBeenCalledWith(
      'File too large',
      'error',
      jasmine.anything(),
      undefined,
      jasmine.anything(),
    );
    expect(component.referenceImages['first']).toBeNull();
  });
});
