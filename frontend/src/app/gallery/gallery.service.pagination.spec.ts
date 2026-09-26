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

  // The end of the list is judged from `count`. At an exact multiple of the
  // page size an off-by-one there either asks for an empty extra page or
  // stops one page early.
  for (const total of [0, 39, 40, 80]) {
    it(`stops after the last page of ${total} items`, fakeAsync(() => {
      start();
      workspaceState.setActiveWorkspaceId(1);
      service.setFilters(filters);
      tick(50);
      pending().forEach(req => answer(req, total));
      // Scroll to the end, with a cap in case the end is never reached.
      for (let scrolls = 0; scrolls < 5 && !allLoaded; scrolls++) {
        service.loadGallery();
        pending().forEach(req => answer(req, total));
      }

      const pages = Math.max(1, Math.ceil(total / pageSize));
      expect(sentBodies.map(body => body.offset ?? 0)).toEqual(
        Array.from({length: pages}, (_, i) => i * pageSize),
      );
      expect(allLoaded).toBeTrue();
      expect(shownIds).toEqual(Array.from({length: total}, (_, i) => i + 1));
    }));
  }

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

  // Opening a folder reaches the service as a filter change: the gallery
  // sends the folder in the search body. A folder switch must therefore reset
  // the paging just as a new query does, or the grid shows the old folder's
  // page, or fetches the new folder at the old offset.
  const filterChanges: Array<{
    change: string;
    before: GallerySearchDto;
    after: GallerySearchDto;
  }> = [
    {
      change: 'the search query',
      before: filters,
      after: {...filters, query: 'sunset'},
    },
    {
      change: 'the open folder',
      before: {...filters, folderId: 7},
      after: {...filters, folderId: 8},
    },
  ];

  for (const {change, before, after} of filterChanges) {
    describe(`when ${change} changes`, () => {
      it('discards a page requested under the old filters', fakeAsync(() => {
        start();
        workspaceState.setActiveWorkspaceId(1);
        service.setFilters(before);
        tick(50);
        pending().forEach(req => answer(req));

        // Page 2 of the old search is in flight when the filters change.
        service.loadGallery();
        const stalePage = pending();
        service.setFilters(after);
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
        expect(next.request.body).toEqual(jasmine.objectContaining(after));
        answer(next, 100, 1000);
        expect(shownIds.length).toBe(80);
        expect(allLoaded).toBeFalse();
      }));

      it('does not fetch the new filters at the old offset before the reset', fakeAsync(() => {
        start();
        workspaceState.setActiveWorkspaceId(1);
        service.setFilters(before);
        tick(50);
        pending().forEach(req => answer(req));

        // A new search empties the grid, so the sentinel fires inside the
        // debounce window, before the pipeline has reset the paging.
        service.setFilters(after);
        service.loadGallery();
        tick(50);
        pending().forEach(req => answer(req, 100, 1000));

        expect(sentBodies.map(body => body.offset ?? 0)).toEqual([0, 0]);
        expect(sentBodies[0]).not.toEqual(jasmine.objectContaining(after));
        expect(sentBodies[1]).toEqual(jasmine.objectContaining(after));
        expect(shownIds).toEqual(Array.from({length: 40}, (_, i) => 1001 + i));
      }));

      // Without the guard, the old page's error marks the new search as
      // fully loaded, and it stops at 40 items with "You've reached the end".
      it('ignores a page that fails after the filters have changed', fakeAsync(() => {
        start();
        workspaceState.setActiveWorkspaceId(1);
        service.setFilters(before);
        tick(50);
        pending().forEach(req => answer(req));

        service.loadGallery();
        const stalePage = httpMock.expectOne(searchUrl);
        service.setFilters(after);
        tick(50);
        const freshPage = httpMock.expectOne(searchUrl);

        stalePage.flush(null, {status: 500, statusText: 'Server Error'});
        answer(freshPage, 100, 1000);

        expect(shownIds.length).toBe(40);
        expect(allLoaded).toBeFalse();
        expect(service.isLoading$.value).toBeFalse();
      }));
    });
  }
});
