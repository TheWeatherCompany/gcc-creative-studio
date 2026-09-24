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

import {TestBed, fakeAsync, tick} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {BehaviorSubject} from 'rxjs';

import {GalleryService} from './gallery.service';
import {GallerySearchDto} from '../common/models/search.model';
import {WorkspaceStateService} from '../services/workspace/workspace-state.service';
import {environment} from '../../environments/environment';

// Regression: on a fresh gallery load the empty grid leaves the scroll
// sentinel visible, so loadMore() fired before the debounced workspace/filters
// pipeline. Page 1 went out twice (once with no workspaceId, which for an admin
// returned every workspace's items), both responses advanced the page counter,
// and the gallery stopped at 40 of 50 items saying it had reached the end.
describe('GalleryService infinite scroll', () => {
  let service: GalleryService;
  let httpMock: HttpTestingController;
  let workspaceId$: BehaviorSubject<number | null>;
  let sentBodies: GallerySearchDto[];
  let shownWorkspaceIds: Set<number>;
  let allLoaded: boolean;
  let shownIds: number[];

  const searchUrl = `${environment.backendURL}/gallery/search`;
  const pageSize = 40;
  const filters: GallerySearchDto = {limit: pageSize, status: 'completed'};

  /**
   * Answers a search the way the backend does: workspace 1 holds ids 1 to
   * total, paged by offset. A search without a workspaceId gets 40 items from
   * other workspaces, as an admin would.
   */
  const answer = (req: TestRequest, total = 50, idBase = 0) => {
    const body = req.request.body as GallerySearchDto;
    sentBodies.push(body);
    if (!body.workspaceId) {
      const data = Array.from({length: pageSize}, (_, i) => ({
        id: 9000 + i,
        workspaceId: 2 + (i % 2),
      }));
      req.flush({data, count: 62, page: 1, pageSize, totalPages: 2});
      return;
    }
    const offset = body.offset ?? 0;
    const data = Array.from(
      {length: Math.max(0, Math.min(pageSize, total - offset))},
      (_, i) => ({id: idBase + offset + i + 1, workspaceId: body.workspaceId}),
    );
    req.flush({
      data,
      count: total,
      page: Math.floor(offset / pageSize) + 1,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  };

  const pending = () => httpMock.match(searchUrl);

  beforeEach(() => {
    workspaceId$ = new BehaviorSubject<number | null>(null);
    sentBodies = [];
    shownWorkspaceIds = new Set();
    TestBed.configureTestingModule({
      providers: [
        GalleryService,
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: WorkspaceStateService,
          useValue: {
            activeWorkspaceId$: workspaceId$.asObservable(),
            getActiveWorkspaceId: () => workspaceId$.value,
          },
        },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  /**
   * Creates the service. Call it inside fakeAsync: the constructor's
   * debounceTime starts a timer that later emissions reuse, so a service
   * built outside the fake zone would debounce on a real clock.
   */
  const start = () => {
    service = TestBed.inject(GalleryService);
    service.images$.subscribe(items => {
      shownIds = items.map(item => item.id);
      items.forEach(item => shownWorkspaceIds.add(item.workspaceId));
    });
    service.allImagesLoaded.subscribe(value => (allLoaded = value));
  };

  afterEach(() => {
    httpMock.verify();
  });

  it('loads every page of the workspace when the sentinel fires before the workspace is known', fakeAsync(() => {
    start();
    // The component sets filters in ngOnInit, then the visible sentinel
    // calls loadGallery() while the active workspace is still unknown.
    service.setFilters(filters);
    service.loadGallery();
    tick(50);
    pending().forEach(req => answer(req));

    // The workspace arrives; the sentinel is still visible and fires again
    // before the debounced pipeline has run.
    workspaceId$.next(1);
    service.loadGallery();
    tick(50);
    pending().forEach(req => answer(req));

    expect(shownIds.length).toBe(40);
    expect(allLoaded).toBeFalse();

    service.loadGallery();
    pending().forEach(req => answer(req));

    expect(
      sentBodies.map(body => [body.workspaceId, body.offset ?? 0]),
    ).toEqual([
      [1, 0],
      [1, 40],
    ]);
    expect(shownIds).toEqual(Array.from({length: 50}, (_, i) => i + 1));
    expect(allLoaded).toBeTrue();
    expect([...shownWorkspaceIds]).toEqual([1]);
  }));

  it('discards a page requested under filters that have since changed', fakeAsync(() => {
    start();
    workspaceId$.next(1);
    service.setFilters(filters);
    tick(50);
    pending().forEach(req => answer(req));

    // Page 2 of the old search is in flight when the user changes filters.
    service.loadGallery();
    const stalePage = pending();
    service.setFilters({...filters, query: 'sunset'});
    tick(50);
    const freshPage = pending();

    stalePage.forEach(req => answer(req));
    expect(shownIds).toEqual([]);
    expect(allLoaded).toBeFalse();

    freshPage.forEach(req => answer(req, 100, 1000));
    expect(shownIds.length).toBe(40);
    expect(shownIds[0]).toBe(1001);

    service.loadGallery();
    const next = httpMock.expectOne(searchUrl);
    expect(next.request.body.offset).toBe(40);
    expect(next.request.body.query).toBe('sunset');
    answer(next, 100, 1000);
    expect(shownIds.length).toBe(80);
    expect(allLoaded).toBeFalse();
  }));
});
