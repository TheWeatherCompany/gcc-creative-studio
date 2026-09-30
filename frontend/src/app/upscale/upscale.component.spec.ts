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
import {MatDialogModule} from '@angular/material/dialog';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {provideRouter} from '@angular/router';
import {of, Subject, throwError} from 'rxjs';

import {setAppInjector} from '../app-injector';
import {NotificationService} from '../common/services/notification.service';
import {SourceAssetService} from '../common/services/source-asset.service';
import {FileDropDirective} from '../common/upload/file-drop.directive';
import {FilePasteDirective} from '../common/upload/file-paste.directive';
import {GalleryService} from '../gallery/gallery.service';
import {UpscaleComponent} from './upscale.component';

describe('UpscaleComponent', () => {
  let fixture: ComponentFixture<UpscaleComponent>;
  let component: UpscaleComponent;
  let uploadAsset: jasmine.Spy;
  let notifications: jasmine.SpyObj<NotificationService>;

  const png = () => new File(['x'], 'shot.png', {type: 'image/png'});
  const asset = {
    id: 5,
    originalFilename: 'shot.png',
    presignedUrl: 'https://example.test/shot.png',
    gcsUri: 'gs://b/shot.png',
    aspectRatio: '16:9',
  };

  beforeEach(() => {
    uploadAsset = jasmine.createSpy('uploadAsset').and.returnValue(of(asset));
    notifications = jasmine.createSpyObj('NotificationService', ['show']);

    TestBed.configureTestingModule({
      declarations: [UpscaleComponent],
      imports: [
        CommonModule,
        MatDialogModule,
        MatSnackBarModule,
        FileDropDirective,
        FilePasteDirective,
      ],
      providers: [
        provideRouter([]),
        {provide: NotificationService, useValue: notifications},
        {
          provide: SourceAssetService,
          useValue: {uploadAsset, activeUpscaleJob$: of(null)},
        },
        {provide: GalleryService, useValue: {}},
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
    setAppInjector(TestBed.inject(Injector));

    fixture = TestBed.createComponent(UpscaleComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('makes an uploaded image the original to upscale', () => {
    component.onFileAdded(png());

    expect(uploadAsset.calls.mostRecent().args[1]).toEqual(
      jasmine.objectContaining({assetType: component.assetType}),
    );
    expect(component.selectedAsset).toBe(asset as any);
    expect(component.assetPair.original).toEqual({
      name: 'shot.png',
      url: 'https://example.test/shot.png',
    });
    expect(component.assetPair.aspectRatio).toBe('16:9');
    expect(component.isUploadingSource).toBeFalse();
  });

  it('toasts a failed upload and lets the user try again', () => {
    uploadAsset.and.returnValue(
      throwError(() => ({message: 'File too large'})),
    );

    component.onFileAdded(png());

    expect(notifications.show).toHaveBeenCalledWith(
      'File too large',
      'error',
      jasmine.anything(),
      undefined,
      jasmine.anything(),
    );
    expect(component.isUploadingSource).toBeFalse();
    expect(component.selectedAsset).toBeNull();
  });

  describe('dropping or pasting onto the zone', () => {
    function drop(): void {
      const dt = new DataTransfer();
      dt.items.add(png());
      fixture.nativeElement.querySelector('.drop-zone-upscaler').dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    function paste(): void {
      const dt = new DataTransfer();
      dt.items.add(png());
      document.dispatchEvent(
        new ClipboardEvent('paste', {clipboardData: dt, cancelable: true}),
      );
    }

    for (const [name, act] of [
      ['drop', drop],
      ['paste', paste],
    ] as const) {
      it(`uploads a ${name}ped image`, () => {
        act();
        expect(uploadAsset).toHaveBeenCalledTimes(1);
      });

      it(`ignores a ${name} while an upscale is processing`, () => {
        component.isLoadingUpscale = true;
        fixture.detectChanges();
        act();
        expect(uploadAsset).not.toHaveBeenCalled();
      });

      it(`ignores a ${name} while the source is uploading`, () => {
        uploadAsset.and.returnValue(new Subject());
        component.onFileAdded(png());
        uploadAsset.calls.reset();
        fixture.detectChanges();
        act();
        expect(uploadAsset).not.toHaveBeenCalled();
      });
    }
  });
});
