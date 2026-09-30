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

import {Injector, NO_ERRORS_SCHEMA} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {
  MAT_DIALOG_DATA,
  MatDialog,
  MatDialogRef,
} from '@angular/material/dialog';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Observable, Subject, of, throwError} from 'rxjs';
import {AssetTypeEnum} from '../../../admin/source-assets-management/source-asset.model';
import {AppInjector, setAppInjector} from '../../../app-injector';
import {FileDropDirective} from '../../upload/file-drop.directive';
import {FilePasteDirective} from '../../upload/file-paste.directive';
import {
  SourceAssetResponseDto,
  SourceAssetService,
} from '../../services/source-asset.service';
import {UserService} from '../../services/user.service';
import {ImageSelectorComponent} from './image-selector.component';

describe('ImageSelectorComponent file intake', () => {
  let fixture: ComponentFixture<ImageSelectorComponent>;
  let component: ImageSelectorComponent;
  let dialogRef: jasmine.SpyObj<MatDialogRef<ImageSelectorComponent>>;
  let assets: jasmine.SpyObj<SourceAssetService>;
  let notifications: jasmine.SpyObj<{show: (...args: unknown[]) => void}>;
  let previousInjector: Injector;

  /**
   * `realTemplate` renders the actual template so the directive bindings are
   * exercised; otherwise the template is blanked and only the class runs.
   */
  function setup(
    data: Partial<ImageSelectorComponent['data']> = {},
    realTemplate = false,
  ) {
    dialogRef = jasmine.createSpyObj('MatDialogRef', [
      'close',
      'addPanelClass',
    ]);
    assets = jasmine.createSpyObj('SourceAssetService', ['uploadAsset']);
    assets.uploadAsset.and.callFake((f: File) =>
      of({
        id: f.size,
        originalFilename: f.name,
      } as unknown as SourceAssetResponseDto),
    );
    TestBed.configureTestingModule({
      declarations: [ImageSelectorComponent],
      imports: [FileDropDirective, FilePasteDirective],
      providers: [
        {provide: MatDialogRef, useValue: dialogRef},
        {provide: SourceAssetService, useValue: assets},
        {
          provide: MatDialog,
          useValue: {
            get openDialogs() {
              return [dialogRef];
            },
          },
        },
        {provide: MatSnackBar, useValue: {}},
        {provide: UserService, useValue: {getUserDetails: () => null}},
        {
          provide: MAT_DIALOG_DATA,
          useValue: {
            mimeType: 'image/*',
            assetType: AssetTypeEnum.GENERIC_IMAGE,
            ...data,
          },
        },
      ],
      schemas: [NO_ERRORS_SCHEMA],
    });
    if (!realTemplate) {
      TestBed.overrideTemplate(ImageSelectorComponent, '');
    }
    fixture = TestBed.createComponent(ImageSelectorComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(() => {
    notifications = jasmine.createSpyObj('NotificationService', ['show']);
    previousInjector = AppInjector;
    setAppInjector({get: () => notifications} as unknown as Injector);
  });

  afterEach(() => setAppInjector(previousInjector));

  const img = (name: string, size: number) =>
    new File(['x'.repeat(size)], name, {type: 'image/png'});
  const waitFor = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  const toastText = () => notifications.show.calls.allArgs().map(a => a[0]);

  describe('class behaviour', () => {
    it('uploads several files and closes with all of them, capped at maxSelection', () => {
      setup({multiSelect: true, maxSelection: 2});
      component.onFilesAdded([
        img('a.png', 1),
        img('b.png', 2),
        img('c.png', 3),
      ]);
      expect(assets.uploadAsset).toHaveBeenCalledTimes(2);
      expect(dialogRef.close).toHaveBeenCalledOnceWith([
        jasmine.objectContaining({originalFilename: 'a.png'}),
        jasmine.objectContaining({originalFilename: 'b.png'}),
      ]);
      expect(toastText()).toEqual([
        jasmine.stringMatching('Only the first 2 of 3'),
      ]);
    });

    it('closes with a single asset, not an array, for one file', () => {
      setup({maxSelection: 1});
      component.onFilesAdded([img('a.png', 1)]);
      expect(dialogRef.close).toHaveBeenCalledOnceWith(
        jasmine.objectContaining({originalFilename: 'a.png'}),
      );
    });

    it('ignores new files while an upload is running', () => {
      setup({multiSelect: true});
      const pending = new Subject<SourceAssetResponseDto>();
      assets.uploadAsset.and.returnValue(pending);
      component.onFilesAdded([img('a.png', 1), img('b.png', 2)]);
      expect(component.isUploading).toBeTrue();

      component.onFilesAdded([img('c.png', 3), img('d.png', 4)]);
      expect(assets.uploadAsset).toHaveBeenCalledTimes(2);
    });

    it('sends the asset type for images only, not for video or audio', () => {
      setup({multiSelect: true, mimeType: null});
      component.onFilesAdded([
        img('a.png', 1),
        new File(['x'], 'b.mp4', {type: 'video/mp4'}),
      ]);
      expect(assets.uploadAsset.calls.argsFor(0)[1]).toEqual({
        assetType: AssetTypeEnum.GENERIC_IMAGE,
      });
      expect(assets.uploadAsset.calls.argsFor(1)[1]).toEqual({});
    });

    it('uploads a batch as-is and says so when Edit before upload is on', () => {
      setup({multiSelect: true});
      component.shouldCrop = true;
      component.onFilesAdded([img('a.png', 1), img('b.png', 2)]);
      expect(dialogRef.close).toHaveBeenCalledWith([
        jasmine.objectContaining({originalFilename: 'a.png'}),
        jasmine.objectContaining({originalFilename: 'b.png'}),
      ]);
      expect(toastText()).toEqual([
        jasmine.stringMatching('Edit before upload works on one file'),
      ]);
    });

    const failures: {
      name: string;
      files: File[];
      fail: (f: File) => boolean;
    }[] = [
      {name: 'one image', files: [img('a.png', 1)], fail: () => true},
      {
        name: 'one video',
        files: [new File(['x'], 'a.mp4', {type: 'video/mp4'})],
        fail: () => true,
      },
      {
        name: 'one file of a batch',
        files: [img('a.png', 1), img('b.png', 2)],
        fail: f => f.name === 'b.png',
      },
    ];
    failures.forEach(({name, files, fail}) => {
      it(`keeps the dialog open, resets uploading and shows an error when ${name} fails`, () => {
        setup({multiSelect: true});
        spyOn(console, 'error');
        assets.uploadAsset.and.callFake(
          (f: File): Observable<SourceAssetResponseDto> =>
            fail(f)
              ? throwError(() => new Error('boom'))
              : of({id: 1} as unknown as SourceAssetResponseDto),
        );
        component.onFilesAdded(files);
        expect(dialogRef.close).not.toHaveBeenCalled();
        expect(component.isUploading).toBeFalse();
        expect(notifications.show).toHaveBeenCalledTimes(1);
        expect(notifications.show.calls.mostRecent().args[1]).toBe('error');
      });
    });

    it('names files of an unsupported type and uploads nothing', () => {
      setup({});
      component.onFilesAdded([
        new File(['x'], 'notes.txt', {type: 'text/plain'}),
      ]);
      expect(assets.uploadAsset).not.toHaveBeenCalled();
      expect(dialogRef.close).not.toHaveBeenCalled();
      expect(toastText()).toEqual([jasmine.stringMatching('notes.txt')]);
    });

    it('clears the file input so the same file can be picked twice', () => {
      setup({});
      const input = document.createElement('input');
      input.type = 'file';
      const dt = new DataTransfer();
      dt.items.add(img('a.png', 1));
      input.files = dt.files;
      expect(input.value).not.toBe('');

      component.onFileInputChange({currentTarget: input} as unknown as Event);
      expect(assets.uploadAsset).toHaveBeenCalledTimes(1);
      expect(input.value).toBe('');
    });

    describe('a URL dropped from another site', () => {
      const fetchResults: {name: string; result: () => Promise<Response>}[] = [
        {
          name: 'the request is blocked',
          result: () => Promise.reject(new TypeError('Failed to fetch')),
        },
        {
          name: 'the server answers with an error',
          result: () => Promise.resolve(new Response('no', {status: 403})),
        },
      ];
      fetchResults.forEach(({name, result}) => {
        it(`shows a toast and frees the dialog when ${name}`, async () => {
          setup({});
          spyOn(window, 'fetch').and.callFake(result);
          spyOn(console, 'error');
          component.onUriDropped('https://example.com/cat.png');
          expect(component.isUploading).toBeTrue();
          await waitFor(() => !component.isUploading);

          expect(component.isUploading).toBeFalse();
          expect(assets.uploadAsset).not.toHaveBeenCalled();
          expect(toastText()).toEqual([
            jasmine.stringMatching('allow its images to be downloaded'),
          ]);
        });
      });

      it('does not fetch another URL while an upload is running', () => {
        setup({});
        component.isUploading = true;
        const fetchSpy = spyOn(window, 'fetch');
        component.onUriDropped('https://example.com/cat.png');
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      it('uploads the fetched image like any other file', async () => {
        setup({});
        spyOn(window, 'fetch').and.resolveTo(
          new Response(new Blob(['x'], {type: 'image/png'})),
        );
        component.onUriDropped('https://example.com/cat.png');
        await waitFor(() => dialogRef.close.calls.count() > 0);

        expect(assets.uploadAsset.calls.argsFor(0)[0].name).toBe(
          'downloaded_image',
        );
        expect(dialogRef.close).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('template wiring', () => {
    function dropOn(el: Element, ...files: File[]) {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      el.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    function pasteFiles(...files: File[]) {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      const event = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event;
    }

    const zone = () => fixture.nativeElement.querySelector('.gallery-wrapper');

    it('accepts several dropped files when multiSelect is on', () => {
      setup({multiSelect: true}, true);
      dropOn(zone(), img('a.png', 1), img('b.png', 2));
      expect(dialogRef.close).toHaveBeenCalledOnceWith([
        jasmine.objectContaining({originalFilename: 'a.png'}),
        jasmine.objectContaining({originalFilename: 'b.png'}),
      ]);
    });

    it('takes only the first dropped file when multiSelect is off', () => {
      setup({maxSelection: 1}, true);
      dropOn(zone(), img('a.png', 1), img('b.png', 2));
      expect(assets.uploadAsset).toHaveBeenCalledTimes(1);
      expect(dialogRef.close).toHaveBeenCalledOnceWith(
        jasmine.objectContaining({originalFilename: 'a.png'}),
      );
    });

    it('uploads a pasted screenshot', () => {
      setup({maxSelection: 1}, true);
      pasteFiles(img('image.png', 1));
      expect(assets.uploadAsset).toHaveBeenCalledTimes(1);
      expect(dialogRef.close).toHaveBeenCalledTimes(1);
    });

    const wrongType = new File(['x'], 'clip.mp4', {type: 'video/mp4'});
    [
      {name: 'dropped', intake: () => dropOn(zone(), wrongType)},
      {name: 'pasted', intake: () => pasteFiles(wrongType)},
    ].forEach(({name, intake}) => {
      it(`refuses a ${name} file the dialog does not accept, and says so`, () => {
        setup({}, true);
        intake();
        expect(assets.uploadAsset).not.toHaveBeenCalled();
        expect(toastText()).toEqual([jasmine.stringMatching('clip.mp4')]);
      });
    });

    it('does not light up the drop zone while an upload is running', () => {
      setup({}, true);
      component.isUploading = true;
      fixture.detectChanges();
      const dt = new DataTransfer();
      dt.items.add(img('a.png', 1));
      zone().dispatchEvent(
        new DragEvent('dragenter', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
      fixture.detectChanges();
      expect(zone().classList).not.toContain('file-drop-active');
    });

    it('leaves a paste alone while an upload is running', () => {
      setup({}, true);
      component.isUploading = true;
      fixture.detectChanges();
      const event = pasteFiles(img('a.png', 1));
      expect(event.defaultPrevented).toBeFalse();
      expect(assets.uploadAsset).not.toHaveBeenCalled();
    });

    it('accepts several pasted files when multiSelect is on', () => {
      setup({multiSelect: true}, true);
      pasteFiles(img('a.png', 1), img('b.png', 2));
      expect(dialogRef.close).toHaveBeenCalledOnceWith([
        jasmine.objectContaining({originalFilename: 'a.png'}),
        jasmine.objectContaining({originalFilename: 'b.png'}),
      ]);
    });

    [true, false].forEach(multiSelect => {
      it(`${multiSelect ? 'lets' : 'does not let'} the file picker choose several files when multiSelect is ${multiSelect}`, () => {
        setup({multiSelect}, true);
        expect(
          fixture.nativeElement.querySelector('input[type=file]').multiple,
        ).toBe(multiSelect);
      });
    });

    [
      {multiSelect: true, text: 'Drop files to upload'},
      {multiSelect: false, text: 'Drop a file to upload'},
    ].forEach(({multiSelect, text}) => {
      it(`says "${text}" when multiSelect is ${multiSelect}`, () => {
        setup({multiSelect}, true);
        expect(
          fixture.nativeElement.querySelector('.drop-message p').textContent,
        ).toContain(text);
      });
    });
  });
});
