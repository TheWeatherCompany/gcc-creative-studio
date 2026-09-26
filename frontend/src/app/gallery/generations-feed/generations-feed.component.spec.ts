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
import {MatSnackBar} from '@angular/material/snack-bar';
import {Router, provideRouter} from '@angular/router';
import {of} from 'rxjs';
import {environment} from '../../../environments/environment';
import {AppInjector, setAppInjector} from '../../app-injector';
import {GallerySearchDto} from '../../common/models/search.model';
import {NotificationService} from '../../common/services/notification.service';
import {WorkspaceStateService} from '../../services/workspace/workspace-state.service';
import {GenerationsFeedComponent} from './generations-feed.component';

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

interface RowSpec {
  id: number;
  outputs?: number;
  model?: string;
  aspectRatio?: string;
  mimeType?: string;
}

/** A search result row the way /gallery/search returns it. */
function searchRow({
  id,
  outputs = 4,
  model = 'gemini-3.1-flash-image',
  aspectRatio = '16:9',
  mimeType = 'image/png',
}: RowSpec) {
  return {
    id,
    workspaceId: 1,
    itemType: 'media_item',
    createdAt: '2026-09-20T15:30:00',
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

  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    originalIntersectionObserver = window.IntersectionObserver;
    window.IntersectionObserver =
      FakeIntersectionObserver as unknown as typeof IntersectionObserver;

    notifications = jasmine.createSpyObj('NotificationService', ['show']);
    previousInjector = AppInjector;
    setAppInjector({get: () => notifications} as unknown as Injector);

    TestBed.configureTestingModule({
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
   * Answers a search from what the server holds right now: `ids`, newest
   * first. Unlike answerSearch, a deleted row is gone from both the results
   * and the count, and a new one pushes the rest down.
   */
  function answerFrom(req: TestRequest, ids: number[]) {
    const {offset = 0, limit} = req.request.body as GallerySearchDto;
    req.flush({
      data: ids.slice(offset, offset + limit).map(id => searchRow({id})),
      count: ids.length,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      totalPages: Math.max(1, Math.ceil(ids.length / limit)),
    });
  }
  const newestFirst = (total: number) =>
    Array.from({length: total}, (_, i) => total - i);
  const deleteUrl = `${environment.backendURL}/gallery/bulk-delete`;

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
  }));
});
