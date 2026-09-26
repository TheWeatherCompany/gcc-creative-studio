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

import {CUSTOM_ELEMENTS_SCHEMA, Injector} from '@angular/core';
import {
  ComponentFixture,
  TestBed,
  fakeAsync,
  flush,
  tick,
} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  TestRequest,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {MatDialog} from '@angular/material/dialog';
import {MatMenuModule} from '@angular/material/menu';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Router, provideRouter} from '@angular/router';
import {of} from 'rxjs';
import {environment} from '../../../environments/environment';
import {AppInjector, setAppInjector} from '../../app-injector';
import {GallerySearchDto} from '../../common/models/search.model';
import {NotificationService} from '../../common/services/notification.service';
import {WorkspaceStateService} from '../../services/workspace/workspace-state.service';
import {
  ACTIVE_JOBS_POLL_MS,
  GenerationsFeedComponent,
} from './generations-feed.component';

/**
 * Stands in for IntersectionObserver so a test decides when the scroll
 * sentinel or a row comes into view.
 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  enter(target: Element) {
    this.callback(
      [{isIntersecting: true, target} as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const searchUrl = `${environment.backendURL}/gallery/search`;
const itemUrl = (id: number) => `${environment.backendURL}/gallery/item/${id}`;
const activeImagesUrl = `${environment.backendURL}/images/active`;
const activeVideosUrl = `${environment.backendURL}/videos/active`;

/** An in-flight job the way /images/active and /videos/active return it. */
function activeJob(id: number, mimeType = 'image/png') {
  return {
    id,
    status: 'processing',
    createdAt: '2026-09-25T10:00:00',
    mimeType,
    model: 'gemini-3.1-flash-image',
    originalPrompt: `still generating ${id}`,
    gcsUris: [],
    presignedUrls: [],
  };
}

interface RowSpec {
  id: number;
  outputs?: number;
  model?: string;
  aspectRatio?: string;
  mimeType?: string;
  createdAt?: string;
}

/** A search result row the way /gallery/search returns it. */
function searchRow({
  id,
  outputs = 4,
  model = 'gemini-3.1-flash-image',
  aspectRatio = '16:9',
  mimeType = 'image/png',
  createdAt = '2026-09-20T15:30:00',
}: RowSpec) {
  return {
    id,
    workspaceId: 1,
    itemType: 'media_item',
    createdAt,
    status: 'completed',
    presignedUrls: Array.from(
      {length: outputs},
      (_, i) => `https://storage.test/${id}/out-${i}.png`,
    ),
    presignedThumbnailUrls: Array.from(
      {length: outputs},
      (_, i) => `https://storage.test/${id}/thumb-${i}.png`,
    ),
    metadata: {
      model,
      aspectRatio,
      mimeType,
      originalPrompt: `what the user typed for ${id}`,
      prompt: `the rewritten prompt for ${id}`,
    },
  };
}

describe('GenerationsFeedComponent', () => {
  let fixture: ComponentFixture<GenerationsFeedComponent>;
  let httpMock: HttpTestingController;
  let workspaceState: WorkspaceStateService;
  let router: Router;
  let notifications: jasmine.SpyObj<NotificationService>;
  let previousInjector: Injector;
  let originalIntersectionObserver: typeof IntersectionObserver;
  let visibility: DocumentVisibilityState;

  beforeEach(() => {
    visibility = 'visible';
    spyOnProperty(document, 'visibilityState').and.callFake(() => visibility);

    FakeIntersectionObserver.instances = [];
    originalIntersectionObserver = window.IntersectionObserver;
    window.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    notifications = jasmine.createSpyObj('NotificationService', ['show']);
    previousInjector = AppInjector;
    setAppInjector({get: () => notifications} as unknown as Injector);

    TestBed.configureTestingModule({
      imports: [MatMenuModule],
      declarations: [GenerationsFeedComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        // The real service: the workspace starts unknown, as in the app.
        WorkspaceStateService,
        {
          provide: MatDialog,
          useValue: {open: () => ({afterClosed: () => of(true)})},
        },
        {provide: MatSnackBar, useValue: {open: () => {}}},
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    });
    httpMock = TestBed.inject(HttpTestingController);
    workspaceState = TestBed.inject(WorkspaceStateService);
    router = TestBed.inject(Router);
  });

  afterEach(() => {
    window.IntersectionObserver = originalIntersectionObserver;
    setAppInjector(previousInjector);
    httpMock.verify();
  });

  const el = (): HTMLElement => fixture.nativeElement;
  const rowEls = () =>
    Array.from(el().querySelectorAll<HTMLElement>('[data-testid="feed-row"]'));
  const rowIds = () => rowEls().map(row => Number(row.dataset['id']));
  const button = (row: HTMLElement, name: string) =>
    row.querySelector<HTMLButtonElement>(`[data-testid="feed-${name}"]`)!;
  const sentinel = () =>
    fixture.componentInstance.scrollSentinel!.nativeElement;
  const sentinelObserver = () =>
    FakeIntersectionObserver.instances.find(o => o.targets.has(sentinel()))!;

  /**
   * Answers a search the way the backend does: `total` rows, newest (the
   * highest id) first, paged by offset.
   */
  function answerSearch(req: TestRequest, total: number, specs?: RowSpec[]) {
    const body = req.request.body as GallerySearchDto;
    const offset = body.offset ?? 0;
    const pageSize = body.limit;
    const data = specs
      ? specs.map(searchRow)
      : Array.from(
          {length: Math.max(0, Math.min(pageSize, total - offset))},
          (_, i) => searchRow({id: total - offset - i}),
        );
    req.flush({
      data,
      count: total,
      page: Math.floor(offset / pageSize) + 1,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    });
  }

  /**
   * Answers a search from what the server holds right now: `ids` (or rows),
   * newest first. Unlike answerSearch, a deleted row is gone from both the
   * results and the count, and a new one pushes the rest down.
   */
  function answerFrom(req: TestRequest, ids: (number | RowSpec)[]) {
    const {offset = 0, limit} = req.request.body as GallerySearchDto;
    req.flush({
      data: ids
        .slice(offset, offset + limit)
        .map(row => searchRow(typeof row === 'number' ? {id: row} : row)),
      count: ids.length,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      totalPages: Math.max(1, Math.ceil(ids.length / limit)),
    });
  }
  const newestFirst = (total: number) =>
    Array.from({length: total}, (_, i) => total - i);
  const deleteUrl = `${environment.backendURL}/gallery/bulk-delete`;

  /**
   * Ends a test: closes the feed, so its active-jobs poll does not outlive
   * the fakeAsync zone, and drops any poll the test left unanswered.
   */
  function closeFeed() {
    fixture.destroy();
    httpMock.match(activeImagesUrl);
    httpMock.match(activeVideosUrl);
  }

  function answerActive(images: object[], videos: object[]) {
    httpMock.expectOne(activeImagesUrl).flush(images);
    httpMock.expectOne(activeVideosUrl).flush(videos);
  }

  const pollRequests = () =>
    httpMock.match(
      req => req.url === activeImagesUrl || req.url === activeVideosUrl,
    ).length;

  function setVisibility(state: DocumentVisibilityState) {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange'));
  }

  const inFlight = () =>
    el()
      .querySelector('[data-testid="feed-inflight"]')
      ?.textContent?.replace(/\s+/g, ' ')
      .trim() ?? null;

  /** Creates the feed in workspace 1 and returns the first search request. */
  function start(): TestRequest {
    fixture = TestBed.createComponent(GenerationsFeedComponent);
    fixture.detectChanges();
    workspaceState.setActiveWorkspaceId(1);
    tick(50);
    return httpMock.expectOne(searchUrl);
  }

  it('shows each submission as one row: every output in a grid, the prompt, and its settings', fakeAsync(() => {
    const first = start();
    answerSearch(first, 3, [
      {id: 3, outputs: 4, aspectRatio: '16:9'},
      {id: 2, outputs: 2, aspectRatio: '1:1'},
      {id: 1, outputs: 1, aspectRatio: '9:16'},
    ]);
    fixture.detectChanges();

    // Every generation in the workspace, across folders: no folder scoping.
    const body = first.request.body as GallerySearchDto;
    expect(body).toEqual(
      jasmine.objectContaining({
        workspaceId: 1,
        itemType: 'media_item',
        status: 'completed',
      }),
    );
    expect(body.isRoot).toBeUndefined();
    expect(body.folderId).toBeUndefined();

    const shape = rowEls().map(row => {
      const grid = row.querySelector<HTMLElement>('.feed-media .grid')!;
      const tiles = Array.from(
        row.querySelectorAll<HTMLElement>('[data-testid="feed-output"]'),
      );
      return {
        outputs: tiles.map(t => t.querySelector('img')!.getAttribute('src')),
        columns: grid.style.gridTemplateColumns,
        ratio: tiles[0].style.aspectRatio,
        prompt: row
          .querySelector('[data-testid="feed-prompt"]')!
          .textContent!.trim(),
        meta: row
          .querySelector('[data-testid="feed-meta"]')!
          .textContent!.replace(/\s+/g, ' ')
          .trim(),
      };
    });
    const thumbs = (id: number, n: number) =>
      Array.from(
        {length: n},
        (_, i) => `https://storage.test/${id}/thumb-${i}.png`,
      );

    expect(shape).toEqual([
      {
        outputs: thumbs(3, 4),
        columns: 'repeat(2, minmax(0px, 1fr))',
        ratio: '16 / 9',
        prompt: 'what the user typed for 3',
        meta: 'Created Sep 20, 2026, 3:30 PM Nano Banana 2 · 16:9',
      },
      {
        outputs: thumbs(2, 2),
        columns: 'repeat(2, minmax(0px, 1fr))',
        ratio: '1 / 1',
        prompt: 'what the user typed for 2',
        meta: 'Created Sep 20, 2026, 3:30 PM Nano Banana 2 · 1:1',
      },
      {
        outputs: thumbs(1, 1),
        columns: 'repeat(1, minmax(0px, 1fr))',
        ratio: '9 / 16',
        prompt: 'what the user typed for 1',
        meta: 'Created Sep 20, 2026, 3:30 PM Nano Banana 2 · 9:16',
      },
    ]);
    closeFeed();
  }));

  it('opens the lightbox at the output that was clicked', fakeAsync(() => {
    answerSearch(start(), 1, [{id: 7, outputs: 4}]);
    fixture.detectChanges();

    rowEls()[0]
      .querySelectorAll<HTMLElement>('[data-testid="feed-output"]')[2]
      .click();
    fixture.detectChanges();

    const lightbox = el().querySelector('app-media-lightbox') as unknown as {
      mediaItem: {id: number};
      initialIndex: number;
    };
    expect(lightbox.mediaItem.id).toBe(7);
    expect(lightbox.initialIndex).toBe(2);
    closeFeed();
  }));

  describe('Reuse', () => {
    const detail = {
      id: 7,
      workspaceId: 1,
      createdAt: '2026-09-20T15:30:00',
      style: 'Photorealistic',
      lighting: 'Golden hour',
      colorAndTone: 'Warm',
      composition: 'Close-up',
      negativePrompt: 'blurry, text',
      enrichedSourceAssets: [
        {
          assetId: 11,
          role: 'start_frame',
          presignedUrl: 'https://storage.test/asset-11.png',
          presignedThumbnailUrl: 'https://storage.test/asset-11-thumb.png',
        },
      ],
      enrichedSourceMediaItems: [
        {
          mediaItemId: 5,
          mediaIndex: 2,
          role: 'end_frame',
          presignedUrl: 'https://storage.test/5-2.png',
          presignedThumbnailUrl: null,
        },
      ],
    };

    const cases = [
      {
        kind: 'an image',
        row: {id: 7, model: 'gemini-3.1-flash-image', aspectRatio: '1:1'},
        commands: ['/'],
        remixState: {
          prompt: 'what the user typed for 7',
          aspectRatio: '1:1',
          generationModel: 'gemini-3.1-flash-image',
          style: 'Photorealistic',
          lighting: 'Golden hour',
          colorAndTone: 'Warm',
          composition: 'Close-up',
          negativePrompt: 'blurry, text',
          sourceAssetIds: [11],
          sourceMediaItems: [
            {mediaItemId: 5, mediaIndex: 2, role: 'end_frame'},
          ],
          previewUrls: ['https://storage.test/asset-11-thumb.png'],
        },
      },
      {
        kind: 'a video',
        row: {
          id: 7,
          model: 'veo-3.1-generate-001',
          aspectRatio: '9:16',
          mimeType: 'video/mp4',
        },
        commands: ['/video'],
        remixState: {
          prompt: 'what the user typed for 7',
          aspectRatio: '9:16',
          generationModel: 'veo-3.1-generate-001',
          startImageAssetId: 11,
          startImagePreviewUrl: 'https://storage.test/asset-11-thumb.png',
          endImagePreviewUrl: 'https://storage.test/5-2.png',
          sourceMediaItems: [
            {mediaItemId: 5, mediaIndex: 2, role: 'end_frame'},
          ],
        },
      },
    ];

    for (const {kind, row, commands, remixState} of cases) {
      it(`opens the generator for ${kind}, pre-filled with the prompt, settings and reference inputs`, fakeAsync(() => {
        const navigate = spyOn(router, 'navigate').and.resolveTo(true);
        answerSearch(start(), 1, [row]);
        fixture.detectChanges();

        button(rowEls()[0], 'reuse').click();
        httpMock.expectOne(itemUrl(7)).flush(detail);
        tick();

        expect(navigate).toHaveBeenCalledOnceWith(commands, {
          state: {remixState},
        });
        closeFeed();
      }));
    }

    it('is offered for a retired image model but not for try-on or upscale results', fakeAsync(() => {
      answerSearch(start(), 3, [
        {id: 3, model: 'virtual-try-on-001'},
        {id: 2, model: 'imagen-4.0-upscale-preview'},
        {id: 1, model: 'imagen-4.0-generate-001'},
      ]);
      fixture.detectChanges();

      expect(rowEls().map(row => !!button(row, 'reuse'))).toEqual([
        false,
        false,
        true,
      ]);
      closeFeed();
    }));
  });

  describe('Download', () => {
    let clickedLinks: HTMLAnchorElement[];

    beforeEach(() => {
      clickedLinks = [];
      spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (
        this: HTMLAnchorElement,
      ) {
        clickedLinks.push(this);
      });
    });

    it('saves every output of the submission, and carries on past one that fails', fakeAsync(() => {
      spyOn(console, 'error');
      const fetchSpy = spyOn(window, 'fetch').and.callFake(input => {
        const ok = !String(input).includes('out-1');
        return Promise.resolve({
          ok,
          status: ok ? 200 : 403,
          headers: new Headers(),
          blob: () => Promise.resolve(new Blob(['x'], {type: 'image/png'})),
        } as Response);
      });
      answerSearch(start(), 1, [{id: 7, outputs: 4}]);
      fixture.detectChanges();

      button(rowEls()[0], 'download').click();
      flush();

      expect(fetchSpy.calls.allArgs().map(args => args[0])).toEqual(
        [0, 1, 2, 3].map(i => `https://storage.test/7/out-${i}.png`),
      );
      expect(clickedLinks.map(link => link.download)).toEqual([
        'creative-studio-7-1.png',
        'creative-studio-7-3.png',
        'creative-studio-7-4.png',
      ]);
      expect(notifications.show).toHaveBeenCalledOnceWith(
        'Could not download 1 of 4 files. Please try again.',
        'error',
        jasmine.anything(),
        undefined,
        jasmine.anything(),
      );
      closeFeed();
    }));
  });

  it('loads the next page when the end of the feed scrolls into view, and stops at the last', fakeAsync(() => {
    answerSearch(start(), 50);
    fixture.detectChanges();
    expect(rowIds().length).toBe(40);

    sentinelObserver().enter(sentinel());
    const next = httpMock.expectOne(searchUrl);
    expect((next.request.body as GallerySearchDto).offset).toBe(40);
    answerSearch(next, 50);
    fixture.detectChanges();

    // Newest first, all 50, each once.
    expect(rowIds()).toEqual(Array.from({length: 50}, (_, i) => 50 - i));

    sentinelObserver().enter(sentinel());
    httpMock.expectNone(searchUrl);
    expect(el().textContent).toContain("You've reached your first generation");
    closeFeed();
  }));

  it('starts a search from the first page, replacing the rows already shown', fakeAsync(() => {
    answerSearch(start(), 50);
    fixture.detectChanges();
    sentinelObserver().enter(sentinel());
    answerSearch(httpMock.expectOne(searchUrl), 50);
    fixture.detectChanges();

    const component = fixture.componentInstance;
    component.query = '  sunset ';
    component.search();
    tick(50);
    const searched = httpMock.expectOne(searchUrl);
    const body = searched.request.body as GallerySearchDto;
    expect(body.query).toBe('sunset');
    expect(body.offset ?? 0).toBe(0);
    answerSearch(searched, 2, [{id: 42}, {id: 41}]);
    fixture.detectChanges();

    expect(rowIds()).toEqual([42, 41]);
    closeFeed();
  }));

  describe('Delete', () => {
    it('keeps every other generation when the next pages load after a delete', fakeAsync(() => {
      let server = newestFirst(81);
      answerFrom(start(), server);
      fixture.detectChanges();

      const target = rowEls().find(row => row.dataset['id'] === '80')!;
      button(target, 'delete').click();
      const del = httpMock.expectOne(deleteUrl);
      expect(del.request.body).toEqual({
        items: [{id: 80, type: 'media_item'}],
        workspace_id: 1,
      });
      server = server.filter(id => id !== 80);
      del.flush({deleted_count: 1});
      fixture.detectChanges();
      expect(rowIds()).not.toContain(80);

      // The server list moved up by one, so a page boundary that stayed put
      // would skip a row, and one counted by totalPages would stop a row
      // early.
      sentinelObserver().enter(sentinel());
      answerFrom(httpMock.expectOne(searchUrl), server);
      fixture.detectChanges();
      sentinelObserver().enter(sentinel());
      answerFrom(httpMock.expectOne(searchUrl), server);
      fixture.detectChanges();

      expect(rowIds()).toEqual(server);
      sentinelObserver().enter(sentinel());
      httpMock.expectNone(searchUrl);
      expect(el().textContent).toContain(
        "You've reached your first generation",
      );
      closeFeed();
    }));

    it('keeps the row and says so when the backend deleted nothing', fakeAsync(() => {
      spyOn(console, 'error');
      answerFrom(start(), [3, 2, 1]);
      fixture.detectChanges();

      button(rowEls()[1], 'delete').click();
      // Not the caller's to delete: the backend skips it and still answers 200.
      httpMock.expectOne(deleteUrl).flush({deleted_count: 0});
      fixture.detectChanges();

      expect(rowIds()).toEqual([3, 2, 1]);
      expect(notifications.show).toHaveBeenCalledOnceWith(
        jasmine.stringContaining('was not deleted'),
        'error',
        jasmine.anything(),
        undefined,
        jasmine.anything(),
      );
      closeFeed();
    }));
  });

  it('shows a row once when a new generation pushes it onto the next page', fakeAsync(() => {
    let server = newestFirst(50);
    answerFrom(start(), server);
    fixture.detectChanges();

    server = [51, ...server];
    sentinelObserver().enter(sentinel());
    answerFrom(httpMock.expectOne(searchUrl), server);
    fixture.detectChanges();

    expect(rowIds()).toEqual(newestFirst(50));
    closeFeed();
  }));

  describe('in-flight generations', () => {
    it('counts the image and video jobs together, and hides the count once none are left', fakeAsync(() => {
      answerSearch(start(), 3);
      answerActive(
        [activeJob(101), activeJob(102)],
        [activeJob(103, 'video/mp4')],
      );
      fixture.detectChanges();
      expect(inFlight()).toBe('3 generating');

      tick(ACTIVE_JOBS_POLL_MS);
      answerActive([], []);
      // Jobs finishing refreshes the top of the feed; see below.
      answerSearch(httpMock.expectOne(searchUrl), 3);
      fixture.detectChanges();
      expect(inFlight()).toBeNull();
      closeFeed();
    }));

    it('polls only while the tab is visible, and stops when the feed closes', fakeAsync(() => {
      answerSearch(start(), 1);
      answerActive([], []);

      setVisibility('hidden');
      tick(ACTIVE_JOBS_POLL_MS * 3);
      expect(pollRequests()).toBe(0);

      // Straight away on coming back, not a full interval later.
      setVisibility('visible');
      tick();
      answerActive([], []);
      answerSearch(httpMock.expectOne(searchUrl), 1);

      fixture.destroy();
      tick(ACTIVE_JOBS_POLL_MS * 3);
      expect(pollRequests()).toBe(0);
    }));

    it('puts a finished job at the top without dropping the pages already loaded', fakeAsync(() => {
      answerSearch(start(), 90);
      answerActive([activeJob(91)], []);
      sentinelObserver().enter(sentinel());
      answerSearch(httpMock.expectOne(searchUrl), 90);
      fixture.detectChanges();
      const loaded = Array.from({length: 80}, (_, i) => 90 - i);
      expect(rowIds()).toEqual(loaded);

      tick(ACTIVE_JOBS_POLL_MS);
      answerActive([], []);
      const refresh = httpMock.expectOne(searchUrl);
      expect(refresh.request.body).toEqual(
        jasmine.objectContaining({
          workspaceId: 1,
          status: 'completed',
          offset: 0,
          limit: 40,
        }),
      );
      answerSearch(refresh, 91);
      fixture.detectChanges();
      expect(rowIds()).toEqual([91, ...loaded]);

      // The new row pushed every other one down a place, so the next page
      // re-sends the last row already shown. It still shows once.
      sentinelObserver().enter(sentinel());
      const next = httpMock.expectOne(searchUrl);
      expect((next.request.body as GallerySearchDto).offset).toBe(80);
      answerSearch(next, 91);
      fixture.detectChanges();
      expect(rowIds()).toEqual(Array.from({length: 91}, (_, i) => 91 - i));
      closeFeed();
    }));

    it('drops a refresh that was still loading when a new search started', fakeAsync(() => {
      answerSearch(start(), 90);
      answerActive([activeJob(91)], []);
      tick(ACTIVE_JOBS_POLL_MS);
      answerActive([], []);
      const refresh = httpMock.expectOne(searchUrl);

      const component = fixture.componentInstance;
      component.query = 'sunset';
      component.search();
      tick(50);
      const searched = httpMock.expectOne(
        req => req.url === searchUrl && req.body.query === 'sunset',
      );
      answerSearch(searched, 2, [{id: 42}, {id: 41}]);
      // Unfiltered rows from before the search must not land on top of it.
      if (!refresh.cancelled) answerSearch(refresh, 91);
      fixture.detectChanges();

      expect(rowIds()).toEqual([42, 41]);
      closeFeed();
    }));

    // The feed's own tab is hidden while the user generates in another one,
    // so the job can start and finish between two polls here.
    it('brings in a row that finished while the tab was hidden', fakeAsync(() => {
      answerSearch(start(), 5);
      answerActive([], []);

      setVisibility('hidden');
      tick(ACTIVE_JOBS_POLL_MS * 6);
      setVisibility('visible');
      tick();
      answerActive([], []);
      answerSearch(httpMock.expectOne(searchUrl), 6);
      fixture.detectChanges();

      expect(rowIds()).toEqual([6, 5, 4, 3, 2, 1]);
      closeFeed();
    }));

    // A middle-clicked link, or a reload in a background tab: the feed loads
    // while hidden, so no poll saw the jobs that finish before it is shown.
    it('catches up when a feed opened in a hidden tab is first shown', fakeAsync(() => {
      visibility = 'hidden';
      answerSearch(start(), 5);
      tick(ACTIVE_JOBS_POLL_MS * 6);
      expect(pollRequests()).toBe(0);

      setVisibility('visible');
      tick();
      answerActive([], []);
      answerSearch(httpMock.expectOne(searchUrl), 6);
      fixture.detectChanges();

      expect(rowIds()).toEqual([6, 5, 4, 3, 2, 1]);
      closeFeed();
    }));

    // Waking a laptop is when the first poll tends to fail.
    it('still catches up when the first poll after the tab returns fails', fakeAsync(() => {
      spyOn(console, 'error');
      answerSearch(start(), 5);
      answerActive([], []);

      setVisibility('hidden');
      tick(ACTIVE_JOBS_POLL_MS * 6);
      setVisibility('visible');
      tick();
      httpMock
        .expectOne(activeImagesUrl)
        .flush(null, {status: 503, statusText: 'Service Unavailable'});
      httpMock.match(activeVideosUrl);
      httpMock.expectNone(searchUrl);

      tick(ACTIVE_JOBS_POLL_MS);
      answerActive([], []);
      answerSearch(httpMock.expectOne(searchUrl), 6);
      fixture.detectChanges();

      expect(rowIds()).toEqual([6, 5, 4, 3, 2, 1]);
      closeFeed();
    }));

    it('keeps the feed in order when a row loaded earlier has since gone', fakeAsync(() => {
      answerSearch(start(), 90);
      answerActive([activeJob(91)], []);
      sentinelObserver().enter(sentinel());
      answerSearch(httpMock.expectOne(searchUrl), 90);

      // A teammate deleted row 88 in the meantime, so the refreshed first
      // page runs one row further down than it would have.
      tick(ACTIVE_JOBS_POLL_MS);
      answerActive([], []);
      const newest = Array.from({length: 41}, (_, i) => 91 - i).filter(
        id => id !== 88,
      );
      answerSearch(
        httpMock.expectOne(searchUrl),
        90,
        newest.map(id => ({id})),
      );
      fixture.detectChanges();

      const older = Array.from({length: 40}, (_, i) => 50 - i);
      expect(rowIds()).toEqual([...newest, ...older]);
      closeFeed();
    }));

    it('drops a row that has gone even when the refreshed page runs past the pages loaded', fakeAsync(() => {
      answerSearch(start(), 90);
      answerActive([], []);

      // Row 88 was deleted elsewhere and nothing new arrived, so the
      // refreshed first page ends on row 50, which no loaded page holds.
      setVisibility('hidden');
      setVisibility('visible');
      tick();
      answerActive([], []);
      const newest = newestFirst(90)
        .slice(0, 41)
        .filter(id => id !== 88);
      answerFrom(httpMock.expectOne(searchUrl), newest);
      fixture.detectChanges();

      expect(rowIds()).toEqual(newest);
      closeFeed();
    }));

    describe('a long job that finishes below the first page', () => {
      // Rows are made a second apart; the search sorts by start time.
      const startedAt = (second: number) =>
        new Date(Date.UTC(2026, 8, 20, 12, 0, 0) + second * 1000).toISOString();
      const rowsMadeAt = (ids: number[]) =>
        ids.map(id => ({id, createdAt: startedAt(id)}));
      const longJob = (second: number) => ({
        ...activeJob(91, 'video/mp4'),
        createdAt: startedAt(second),
      });

      /** Loads rows 90 to 11 (two pages) while job 91 runs. */
      function loadTwoPages(job: object) {
        answerFrom(start(), rowsMadeAt(newestFirst(90)));
        answerActive([], [job]);
        sentinelObserver().enter(sentinel());
        answerFrom(httpMock.expectOne(searchUrl), rowsMadeAt(newestFirst(90)));
      }

      it('reads on past the first page to where the job started', fakeAsync(() => {
        const job = longJob(45.5);
        loadTwoPages(job);

        tick(ACTIVE_JOBS_POLL_MS);
        answerActive([], []);
        // It started between rows 46 and 45, so 45 rows sort above it.
        const server = rowsMadeAt(newestFirst(90));
        server.splice(45, 0, {id: 91, createdAt: job.createdAt});
        const first = httpMock.expectOne(searchUrl);
        expect((first.request.body as GallerySearchDto).offset).toBe(0);
        answerFrom(first, server);
        const second = httpMock.expectOne(searchUrl);
        expect((second.request.body as GallerySearchDto).offset).toBe(40);
        answerFrom(second, server);
        httpMock.expectNone(searchUrl);
        fixture.detectChanges();

        expect(rowIds()).toEqual(server.slice(0, 81).map(row => row.id));
        closeFeed();
      }));

      it('reads no further than the pages loaded', fakeAsync(() => {
        // Older than every loaded row: the next page will bring it in.
        loadTwoPages(longJob(5.5));

        tick(ACTIVE_JOBS_POLL_MS);
        answerActive([], []);
        const server = rowsMadeAt(newestFirst(90));
        answerFrom(httpMock.expectOne(searchUrl), server);
        answerFrom(httpMock.expectOne(searchUrl), server);
        httpMock.expectNone(searchUrl);
        closeFeed();
      }));
    });
  });
});
