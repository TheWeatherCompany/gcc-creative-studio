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

import {Injector} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Subject, of, throwError} from 'rxjs';
import {setAppInjector} from '../../../app-injector';
import {NotificationService} from '../../services/notification.service';
import {SourceAssetResponseDto} from '../../services/source-asset.service';
import {
  PendingUploads,
  ReferenceUploadTarget,
  uploadReferenceFiles,
} from './prompt-box-uploads';

describe('uploadReferenceFiles', () => {
  const png = (n: number) => new File(['x'], `${n}.png`, {type: 'image/png'});
  const asset = (f: File) =>
    ({
      id: parseInt(f.name),
      gcsUri: `gs://b/${f.name}`,
    }) as SourceAssetResponseDto;
  const snackBar = {} as MatSnackBar;
  let notices: jasmine.Spy;
  const toasts = () =>
    notices.calls.allArgs().map(a => [a[1], a[0]] as [string, string]);

  /** A page with `max` slots whose uploads land only when told to. */
  function page(max: number, existing = 0) {
    const added: number[] = [];
    const pending: [File, Subject<SourceAssetResponseDto>][] = [];
    const state = {max, mode: true};
    const target: ReferenceUploadTarget = {
      maxReferences: () => state.max,
      referenceCount: () => existing + added.length,
      takesReferences: () => state.mode,
      upload: f => {
        const upload = new Subject<SourceAssetResponseDto>();
        pending.push([f, upload]);
        return upload;
      },
      add: a => added.push(a.id),
    };
    const land = () => {
      for (const [f, upload] of pending.splice(0)) upload.next(asset(f));
    };
    return {target, added, pending, state, land};
  }

  beforeEach(() => {
    setAppInjector(TestBed.inject(Injector));
    notices = spyOn(TestBed.inject(NotificationService), 'show');
  });

  it('uploads only as many as the model has room for', () => {
    const p = page(3, 1);
    uploadReferenceFiles([png(1), png(2), png(3)], p.target, snackBar);
    expect(p.pending.map(([f]) => f.name)).toEqual(['1.png', '2.png']);
    p.land();
    expect(p.added).toEqual([1, 2]);
    expect(toasts()).toEqual([
      ['info', 'Only the first 2 of 3 images were added.'],
    ]);
  });

  it('uploads nothing and says why when the model is full', () => {
    const p = page(2, 2);
    uploadReferenceFiles([png(1)], p.target, snackBar);
    expect(p.pending).toEqual([]);
    expect(toasts()).toEqual([
      ['info', 'You can only add up to 2 reference images for this model.'],
    ]);
  });

  // Two quick pastes each see the same free slots before either lands.
  it('stops at the limit when uploads from two pastes land together', () => {
    const p = page(2);
    uploadReferenceFiles([png(1)], p.target, snackBar);
    uploadReferenceFiles([png(2), png(3)], p.target, snackBar);
    p.land();
    expect(p.added).toEqual([1, 2]);
    expect(toasts()).toEqual([
      [
        'info',
        "3.png wasn't added: this model takes up to 2 reference images.",
      ],
    ]);
  });

  // Adding the first reference can move the page to a model with a lower cap.
  it('checks the cap the model has when each upload lands', () => {
    const p = page(3);
    uploadReferenceFiles([png(1), png(2)], p.target, snackBar);
    p.state.max = 1;
    p.land();
    expect(p.added).toEqual([1]);
  });

  it('drops an upload that lands after the user left the mode', () => {
    const p = page(3);
    uploadReferenceFiles([png(1)], p.target, snackBar);
    p.state.mode = false;
    p.land();
    expect(p.added).toEqual([]);
    expect(toasts()).toEqual([
      ['info', "1.png wasn't added: this mode doesn't take reference images."],
    ]);
  });

  it('says the upload failed', () => {
    const p = page(3);
    p.target.upload = () =>
      throwError(() => ({error: {detail: 'File too large'}}));
    uploadReferenceFiles([png(1)], p.target, snackBar);
    expect(p.added).toEqual([]);
    expect(toasts()).toEqual([['error', 'File too large']]);
  });
});

describe('PendingUploads', () => {
  it('counts an upload until it lands or fails', () => {
    const uploads = new PendingUploads();
    const ok = new Subject<number>();
    const bad = new Subject<number>();
    uploads.track(ok).subscribe();
    uploads.track(bad).subscribe({error: () => {}});
    expect(uploads.any).withContext('both pending').toBeTrue();

    ok.next(1);
    ok.complete();
    expect(uploads.any).withContext('one still pending').toBeTrue();

    bad.error('boom');
    expect(uploads.any).withContext('none pending').toBeFalse();
  });

  it('counts nothing for an upload no one started', () => {
    const uploads = new PendingUploads();
    uploads.track(of(1));
    expect(uploads.any).toBeFalse();
  });
});
