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

import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {of} from 'rxjs';

import {GalleryService} from './gallery.service';
import {WorkspaceStateService} from '../services/workspace/workspace-state.service';
import {environment} from '../../environments/environment';

describe('GalleryService favorite state', () => {
  let service: GalleryService;
  let httpMock: HttpTestingController;

  const url = (id: number) =>
    `${environment.backendURL}/gallery/item/${id}/favorite`;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        GalleryService,
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: WorkspaceStateService,
          useValue: {
            activeWorkspaceId$: of(1),
            getActiveWorkspaceId: () => 1,
          },
        },
      ],
    });
    service = TestBed.inject(GalleryService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('reads the camelCase isFavorite the backend DTO emits', () => {
    let state: boolean | undefined;
    service.favorite(7).subscribe(value => (state = value));

    const req = httpMock.expectOne(url(7));
    expect(req.request.method).toBe('POST');
    req.flush({isFavorite: true});

    expect(state).toBeTrue();
  });

  // Regression: the endpoint originally answered {"is_favorite": true}, which
  // read as undefined and dropped the heart back to its unlit state right
  // after the optimistic flip lit it.
  it('still reads a snake_case is_favorite body', () => {
    let state: boolean | undefined;
    service.favorite(7).subscribe(value => (state = value));

    httpMock.expectOne(url(7)).flush({is_favorite: true});

    expect(state).toBeTrue();
  });

  it('falls back to the requested state when the body carries no field', () => {
    let favorited: boolean | undefined;
    service.favorite(7).subscribe(value => (favorited = value));
    httpMock.expectOne(url(7)).flush({});
    expect(favorited).toBeTrue();

    let unfavorited: boolean | undefined;
    service.unfavorite(7).subscribe(value => (unfavorited = value));
    httpMock.expectOne(url(7)).flush({});
    expect(unfavorited).toBeFalse();
  });

  it('honours an explicit false over the requested state', () => {
    let state: boolean | undefined;
    service.favorite(7).subscribe(value => (state = value));

    httpMock.expectOne(url(7)).flush({isFavorite: false});

    expect(state).toBeFalse();
  });

  it('unfavorite issues a DELETE and reads its state', () => {
    let state: boolean | undefined;
    service.unfavorite(9).subscribe(value => (state = value));

    const req = httpMock.expectOne(url(9));
    expect(req.request.method).toBe('DELETE');
    req.flush({isFavorite: false});

    expect(state).toBeFalse();
  });
});
