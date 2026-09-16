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
import {GalleryItem} from '../common/models/gallery-item.model';
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
    const warn = spyOn(console, 'warn');

    let favorited: boolean | undefined;
    service.favorite(7).subscribe(value => (favorited = value));
    httpMock.expectOne(url(7)).flush({});
    expect(favorited).toBeTrue();

    let unfavorited: boolean | undefined;
    service.unfavorite(7).subscribe(value => (unfavorited = value));
    httpMock.expectOne(url(7)).flush({});
    expect(unfavorited).toBeFalse();

    // The fallback keeps the UI honest, but it must not be silent: an
    // unreadable 2xx means the response contract drifted again.
    expect(warn).toHaveBeenCalledTimes(2);
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

/**
 * The favorite state has two independent read paths: the toggle endpoint
 * response (covered above) and the gallery list mapping, which is what paints
 * the hearts on first render. `mapUnifiedItem` is the only place the list path
 * reads it, and the field arrives snake_case from the unified view, so a
 * mapping that only looks at `isFavorite` renders every heart unlit with no
 * error, no console warning and no failing request. These tests drive the real
 * list fetch so the assertion sits on a flushed payload rather than on the
 * mapper called in isolation.
 */
describe('GalleryService list mapping favorite state', () => {
  let service: GalleryService;
  let httpMock: HttpTestingController;

  const searchUrl = `${environment.backendURL}/gallery/search`;

  /**
   * Minimal list row: only the fields the mapper needs to produce an item.
   * `metadata` is deliberately omitted, so every metadata-derived field maps
   * to undefined here. That is fine for the favorite assertions below; anyone
   * extending this block to cover other mapped fields needs to add it.
   */
  const listRow = (overrides: Record<string, unknown>) => ({
    id: 11,
    workspaceId: 1,
    itemType: 'media_item',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  });

  /** Runs the list fetch and returns the mapped items the gallery renders. */
  const fetchList = (rows: Array<Record<string, unknown>>): GalleryItem[] => {
    let items: GalleryItem[] = [];
    service.images$.subscribe(value => (items = value));

    service.loadGallery();
    const req = httpMock.expectOne(searchUrl);
    expect(req.request.method).toBe('POST');
    req.flush({data: rows, count: rows.length, page: 1, totalPages: 1});

    return items;
  };

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

  // Regression: the unified gallery view answers snake_case `is_favorite`. A
  // mapping without that fallback leaves `isFavorite` undefined on every
  // favorited row, so the gallery opens with every heart unlit and nothing
  // anywhere reports a problem.
  it('maps a snake_case is_favorite row to isFavorite', () => {
    const items = fetchList([listRow({is_favorite: true})]);

    expect(items.length).toBe(1);
    expect(items[0].isFavorite).toBeTrue();
  });

  it('maps a camelCase isFavorite row to isFavorite', () => {
    const items = fetchList([listRow({isFavorite: true})]);

    expect(items.length).toBe(1);
    expect(items[0].isFavorite).toBeTrue();
  });

  // An unfavorited row carries no field at all and the card binds the heart
  // directly, so the default has to be a real `false`, not undefined.
  it('defaults a row carrying no favorite field to false', () => {
    const items = fetchList([listRow({})]);

    expect(items.length).toBe(1);
    expect(items[0].isFavorite).toBeFalse();
  });

  it('reads each row independently across a mixed page', () => {
    const items = fetchList([
      listRow({id: 1, is_favorite: true}),
      listRow({id: 2, is_favorite: false}),
      listRow({id: 3, isFavorite: true}),
      listRow({id: 4}),
    ]);

    expect(items.map(item => item.isFavorite)).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });
});
