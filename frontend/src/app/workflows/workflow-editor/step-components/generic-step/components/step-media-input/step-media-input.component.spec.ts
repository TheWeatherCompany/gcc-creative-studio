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
import {FormControl} from '@angular/forms';
import {MatDialog} from '@angular/material/dialog';
import {MatMenuModule} from '@angular/material/menu';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {of, Subject, throwError} from 'rxjs';

import {setAppInjector} from '../../../../../../app-injector';
import {NotificationService} from '../../../../../../common/services/notification.service';
import {SourceAssetService} from '../../../../../../common/services/source-asset.service';
import {FileDropDirective} from '../../../../../../common/upload/file-drop.directive';
import {StepMediaInputComponent} from './step-media-input.component';

describe('StepMediaInputComponent', () => {
  let fixture: ComponentFixture<StepMediaInputComponent>;
  let component: StepMediaInputComponent;
  let uploadAsset: jasmine.Spy;
  let notifications: jasmine.SpyObj<NotificationService>;

  const png = (name = 'in.png') => new File(['x'], name, {type: 'image/png'});
  const assetFor = (id: number) => ({
    id,
    presignedUrl: `https://example.test/${id}.png`,
  });
  const ids = () =>
    (component.control.value ?? []).map((i: any) => i.sourceAssetId);

  function dropFiles(files: File[]): void {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    fixture.nativeElement.querySelector('.input-container-mixed').dispatchEvent(
      new DragEvent('drop', {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  function setup(
    inputs: {maxItems?: number; type?: 'image' | 'video'; value?: any} = {},
  ): void {
    component.control = new FormControl(inputs.value ?? null);
    component.maxItems = inputs.maxItems ?? 1;
    component.type = inputs.type ?? 'image';
    fixture.detectChanges();
  }

  beforeEach(() => {
    uploadAsset = jasmine.createSpy('uploadAsset');
    notifications = jasmine.createSpyObj('NotificationService', ['show']);

    TestBed.configureTestingModule({
      declarations: [StepMediaInputComponent],
      imports: [
        CommonModule,
        MatMenuModule,
        MatSnackBarModule,
        FileDropDirective,
      ],
      providers: [
        {provide: NotificationService, useValue: notifications},
        {provide: SourceAssetService, useValue: {uploadAsset}},
        {provide: MatDialog, useValue: {open: () => {}}},
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
    setAppInjector(TestBed.inject(Injector));

    fixture = TestBed.createComponent(StepMediaInputComponent);
    component = fixture.componentInstance;
  });

  it('uploads only as many dropped files as there are free slots', () => {
    uploadAsset.and.callFake(() => of(assetFor(uploadAsset.calls.count())));
    setup({maxItems: 3, value: [{sourceAssetId: 100, previewUrl: 'u'}]});

    dropFiles([png('a.png'), png('b.png'), png('c.png')]);

    expect(uploadAsset).toHaveBeenCalledTimes(2);
    expect(ids()).toEqual([100, 1, 2]);
  });

  it('drops an upload that lands after the slots filled up', () => {
    const first = new Subject<any>();
    const second = new Subject<any>();
    uploadAsset.and.returnValues(first, second);
    setup({maxItems: 2});

    component.onFilesAdded([png('a.png'), png('b.png')]);
    component.addLinkedOutput({value: {step: 's', output: 'o'}});
    first.next(assetFor(1));
    second.next(assetFor(2));

    expect(component.items.length).toBe(2);
    expect(ids()).toEqual([undefined, 1]);
  });

  it('toasts a failed upload and adds nothing', () => {
    uploadAsset.and.returnValue(
      throwError(() => ({message: 'File too large'})),
    );
    setup({maxItems: 2});

    component.onFilesAdded([png()]);

    expect(notifications.show).toHaveBeenCalledWith(
      'File too large',
      'error',
      jasmine.anything(),
      undefined,
      jasmine.anything(),
    );
    expect(component.items).toEqual([]);
  });

  it('takes dropped images', () => {
    uploadAsset.and.returnValue(of(assetFor(1)));
    setup({maxItems: 2});

    dropFiles([png()]);

    expect(ids()).toEqual([1]);
  });

  it('ignores a drop onto a video input', () => {
    setup({maxItems: 2, type: 'video'});

    dropFiles([png()]);

    expect(uploadAsset).not.toHaveBeenCalled();
  });

  it('only offers the drop highlight while there is a free slot', () => {
    setup({maxItems: 1, value: [{sourceAssetId: 100, previewUrl: 'u'}]});
    const zone = fixture.nativeElement.querySelector('.input-container-mixed');
    const dt = new DataTransfer();
    dt.items.add(png());
    const enter = () => {
      zone.dispatchEvent(
        new DragEvent('dragenter', {dataTransfer: dt, cancelable: true}),
      );
      fixture.detectChanges();
    };

    enter();
    expect(zone.classList).not.toContain('file-drop-active');

    component.clearReferenceImage(0);
    fixture.detectChanges();
    enter();
    expect(zone.classList).toContain('file-drop-active');
  });
});
