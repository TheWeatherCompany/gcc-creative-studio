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
  let workspaceState: WorkspaceStateService;
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
    sentBodies = [];
    shownWorkspaceIds = new Set();
    TestBed.configureTestingModule({
      providers: [
        GalleryService,
        provideHttpClient(),
        provideHttpClientTesting(),
        // The real service, never a synchronous of(): the workspace starts
        // unknown (null, not settled) as it does in the app.
        WorkspaceStateService,
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    workspaceState = TestBed.inject(WorkspaceStateService);
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
    workspaceState.setActiveWorkspaceId(1);
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
    workspaceState.setActiveWorkspaceId(1);
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

  it('does not fetch the new filters at the old offset before the reset', fakeAsync(() => {
    start();
    workspaceState.setActiveWorkspaceId(1);
    service.setFilters(filters);
    tick(50);
    pending().forEach(req => answer(req));

    // A new search empties the grid, so the sentinel fires inside the
    // debounce window, before the pipeline has reset the paging.
    service.setFilters({...filters, query: 'sunset'});
    service.loadGallery();
    tick(50);
    pending().forEach(req => answer(req, 100, 1000));

    expect(sentBodies.map(body => [body.query, body.offset ?? 0])).toEqual([
      [undefined, 0],
      ['sunset', 0],
    ]);
    expect(shownIds).toEqual(Array.from({length: 40}, (_, i) => 1001 + i));
  }));

  // No workspace means no search. The gallery must still end somewhere
  // visible, but only once the workspace list has settled, so that "No media
  // items found" never flashes during a normal load.
  it('shows the empty state once the workspace list settles on none', fakeAsync(() => {
    start();
    service.setFilters(filters);
    tick(50);
    expect(allLoaded).toBeFalse();

    // The workspace list failed to load, or came back empty.
    workspaceState.setActiveWorkspaceId(null);
    tick(50);
    expect(allLoaded).toBeTrue();
    expect(service.isLoading$.value).toBeFalse();
    expect(shownIds).toEqual([]);
  }));

  // Without the guard, the old page's error marks the new search as fully
  // loaded, and it stops at 40 items with "You've reached the end".
  it('ignores a page that fails after the filters have changed', fakeAsync(() => {
    start();
    workspaceState.setActiveWorkspaceId(1);
    service.setFilters(filters);
    tick(50);
    pending().forEach(req => answer(req));

    service.loadGallery();
    const stalePage = httpMock.expectOne(searchUrl);
    service.setFilters({...filters, query: 'sunset'});
    tick(50);
    const freshPage = httpMock.expectOne(searchUrl);

    stalePage.flush(null, {status: 500, statusText: 'Server Error'});
    answer(freshPage, 100, 1000);

    expect(shownIds.length).toBe(40);
    expect(allLoaded).toBeFalse();
    expect(service.isLoading$.value).toBeFalse();
  }));
});
