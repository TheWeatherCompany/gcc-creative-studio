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

import {DOCUMENT} from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
  Inject,
  NgZone,
  OnDestroy,
  OnInit,
  QueryList,
  ViewChild,
  ViewChildren,
} from '@angular/core';
import {MatDialog} from '@angular/material/dialog';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Router} from '@angular/router';
import {
  EMPTY,
  Observable,
  Subscription,
  firstValueFrom,
  forkJoin,
  fromEvent,
  of,
  timer,
} from 'rxjs';
import {
  catchError,
  distinctUntilChanged,
  exhaustMap,
  map,
  shareReplay,
  startWith,
  switchMap,
} from 'rxjs/operators';
import {ConfirmationDialogComponent} from '../../common/components/confirmation-dialog/confirmation-dialog.component';
import {MODEL_CONFIGS} from '../../common/config/model-config';
import {GalleryItem} from '../../common/models/gallery-item.model';
import {JobStatus, MediaItem} from '../../common/models/media-item.model';
import {GallerySearchDto} from '../../common/models/search.model';
import {SearchService} from '../../services/search/search.service';
import {WorkspaceStateService} from '../../services/workspace/workspace-state.service';
import {downloadMedia} from '../../utils/download-media';
import {
  handleErrorSnackbar,
  handleSuccessSnackbar,
} from '../../utils/handleMessageSnackbar';
import {GalleryService} from '../gallery.service';
import {
  FeedNavigation,
  concatenateVideoNavigation,
  editImageNavigation,
  editWithOmniNavigation,
  extendVideoNavigation,
  feedPrompt,
  generatorRoute,
  imageToVideoNavigation,
  reuseNavigation,
  vtoNavigation,
} from './feed-navigation';

const PAGE_SIZE = 40;
// Roughly three lines of the prompt column; shorter prompts need no toggle.
const PROMPT_TOGGLE_THRESHOLD = 160;
// How often the header re-reads the user's in-flight jobs while the feed is
// open and the tab is visible. Images finish in seconds, videos in minutes.
export const ACTIVE_JOBS_POLL_MS = 10_000;

/** One of the user's queued or running generations, for the header. */
export interface InFlightJob {
  id: number;
  prompt: string;
  model?: string;
  isVideo: boolean;
}

/** A reference input thumbnail shown under a row's prompt. */
export interface FeedReference {
  key: string;
  thumbnailUrl: string;
  isAudio: boolean;
  link: (string | number)[];
  queryParams?: Record<string, number>;
}

/**
 * The generations feed: one row per submission, newest first, with all of
 * its outputs side by side and the prompt and settings next to them. It is
 * an opt-in view of the same workspace-scoped search the media gallery runs.
 *
 * GalleryService is provided here rather than taken from the root injector,
 * so the feed pages its own copy of the gallery search (with the same
 * workspace handling and stale-page guards) without clobbering the gallery's
 * list or saved filters.
 */
@Component({
  selector: 'app-generations-feed',
  templateUrl: './generations-feed.component.html',
  styleUrl: './generations-feed.component.scss',
  providers: [GalleryService],
  standalone: false,
})
export class GenerationsFeedComponent
  implements OnInit, AfterViewInit, OnDestroy
{
  rows: GalleryItem[] = [];
  isLoading = true;
  allLoaded = false;
  query = '';

  expandedPrompts = new Set<number>();
  downloading = new Set<number>();
  reusing = new Set<number>();
  deleting = new Set<number>();

  lightboxItem: GalleryItem | null = null;
  lightboxIndex = 0;

  /** The user's in-flight generations, in every workspace. */
  inFlight: InFlightJob[] = [];

  /** Detail responses by item id, for reference inputs and Reuse. */
  private details = new Map<number, GalleryItem>();
  private detailRequests = new Map<number, Observable<GalleryItem | null>>();

  // The service's pages, as last emitted.
  private pagedRows: GalleryItem[] = [];
  // The first page as re-read after a job finished, shown above the service's
  // pages. Those pages stay as they are, so a user who has scrolled down keeps
  // everything they loaded; see render() for how the two meet.
  private topRows: GalleryItem[] = [];
  private filters: GallerySearchDto | null = null;
  // The first-page refresh in flight, if any. A new search, a workspace
  // switch or a newer refresh cancels it.
  private topRowsRefresh?: Subscription;
  // Ids from the last active-jobs poll; null until the first one answers.
  private activeJobIds: Set<number> | null = null;

  private subscriptions = new Subscription();
  private scrollObserver?: IntersectionObserver;
  private rowObserver?: IntersectionObserver;

  @ViewChild('scrollSentinel') scrollSentinel?: ElementRef<HTMLElement>;
  @ViewChildren('feedRow') rowElements?: QueryList<ElementRef<HTMLElement>>;

  constructor(
    private galleryService: GalleryService,
    private searchService: SearchService,
    private workspaceStateService: WorkspaceStateService,
    private router: Router,
    private dialog: MatDialog,
    private snackBar: MatSnackBar,
    private ngZone: NgZone,
    @Inject(DOCUMENT) private document: Document,
  ) {}

  ngOnInit(): void {
    this.subscriptions.add(
      this.galleryService.images$.subscribe(items => {
        this.pagedRows = items;
        this.render();
      }),
    );
    this.subscriptions.add(
      this.galleryService.isLoading$.subscribe(
        loading => (this.isLoading = loading),
      ),
    );
    this.subscriptions.add(
      this.galleryService.allImagesLoaded.subscribe(
        loaded => (this.allLoaded = loaded),
      ),
    );
    // A workspace switch resets the service's paging; drop what belonged to
    // the old workspace too.
    this.subscriptions.add(
      this.workspaceStateService.activeWorkspaceId$.subscribe(() => {
        this.details.clear();
        this.detailRequests.clear();
        this.clearTopRows();
      }),
    );
    this.subscriptions.add(this.pollActiveJobs());
    this.search();
  }

  ngAfterViewInit(): void {
    if (typeof IntersectionObserver === 'undefined') return;

    // Same pattern as the media gallery: a sentinel after the last row asks
    // for the next page, and the service turns away any call it should not
    // serve (a load in flight, the first page still pending, the end).
    if (this.scrollSentinel) {
      this.scrollObserver = new IntersectionObserver(
        entries => {
          if (entries[0]?.isIntersecting) {
            this.ngZone.run(() => this.loadMore());
          }
        },
        {root: null, rootMargin: '400px', threshold: 0},
      );
      this.scrollObserver.observe(this.scrollSentinel.nativeElement);
    }

    // Search results carry no reference inputs, so each row fetches its
    // detail once, when it comes near the viewport.
    this.rowObserver = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = Number((entry.target as HTMLElement).dataset['id']);
          this.rowObserver?.unobserve(entry.target);
          this.ngZone.run(() => this.loadDetail(id).subscribe());
        }
      },
      {root: null, rootMargin: '600px', threshold: 0},
    );
    const observeRows = () =>
      this.rowElements?.forEach(el =>
        this.rowObserver?.observe(el.nativeElement),
      );
    observeRows();
    if (this.rowElements) {
      this.subscriptions.add(this.rowElements.changes.subscribe(observeRows));
    }
  }

  ngOnDestroy(): void {
    this.subscriptions.unsubscribe();
    this.topRowsRefresh?.unsubscribe();
    this.scrollObserver?.disconnect();
    this.rowObserver?.disconnect();
  }

  search(): void {
    const filters: GallerySearchDto = {
      limit: PAGE_SIZE,
      itemType: 'media_item',
      status: JobStatus.COMPLETED,
    };
    const term = this.query.trim();
    if (term) {
      filters.query = term;
    }
    this.expandedPrompts.clear();
    this.filters = filters;
    this.clearTopRows();
    this.galleryService.setFilters(filters);
  }

  loadMore(): void {
    if (!this.isLoading && !this.allLoaded) {
      this.galleryService.loadGallery();
    }
  }

  trackRow(_index: number, row: GalleryItem): number {
    return row.id;
  }

  prompt(row: GalleryItem): string {
    return feedPrompt(row);
  }

  isPromptLong(row: GalleryItem): boolean {
    return this.prompt(row).length > PROMPT_TOGGLE_THRESHOLD;
  }

  togglePrompt(row: GalleryItem): void {
    if (this.expandedPrompts.has(row.id)) {
      this.expandedPrompts.delete(row.id);
    } else {
      this.expandedPrompts.add(row.id);
    }
  }

  outputs(row: GalleryItem): number[] {
    const count = Math.max(
      row.presignedUrls?.length ?? 0,
      row.presignedThumbnailUrls?.length ?? 0,
    );
    return Array.from({length: count}, (_, i) => i);
  }

  /** 1 output: one tile. 2: side by side. 3 or 4: two by two. */
  gridColumns(row: GalleryItem): number {
    return Math.min(this.outputs(row).length, 2) || 1;
  }

  thumbnailUrl(row: GalleryItem, index: number): string | undefined {
    return row.presignedThumbnailUrls?.[index] || undefined;
  }

  isVideo(row: GalleryItem): boolean {
    return row.mimeType?.startsWith('video/') ?? false;
  }

  isAudio(row: GalleryItem): boolean {
    return row.mimeType?.startsWith('audio/') ?? false;
  }

  /** CSS aspect-ratio for the output tiles, e.g. '16 / 9'. */
  tileAspectRatio(row: GalleryItem): string {
    const [w, h] = (row.aspectRatio ?? '').split(':').map(Number);
    if (!w || !h) return this.isAudio(row) ? '2 / 1' : '1 / 1';
    return `${w} / ${h}`;
  }

  /** Portrait rows get a narrower media column so a 2x2 stays on screen. */
  mediaMaxWidth(row: GalleryItem): string {
    const [w, h] = (row.aspectRatio ?? '').split(':').map(Number);
    if (w && h && w < h) return '420px';
    if (w && h && w > h) return '720px';
    return '560px';
  }

  modelName(row: GalleryItem): string | undefined {
    return modelLabel(row.model);
  }

  canReuse(row: GalleryItem): boolean {
    return generatorRoute(row) !== null;
  }

  references(row: GalleryItem): FeedReference[] {
    const detail = this.details.get(row.id);
    if (!detail) return [];
    const assets = (detail.enrichedSourceAssets ?? []).map(asset => ({
      key: `asset:${asset.assetId}:${asset.role}`,
      thumbnailUrl: asset.presignedThumbnailUrl || asset.presignedUrl,
      isAudio: !!asset.mimeType?.startsWith('audio/'),
      link: ['/asset-detail', asset.assetId],
    }));
    const media = (detail.enrichedSourceMediaItems ?? []).map(source => ({
      key: `media:${source.mediaItemId}:${source.mediaIndex}:${source.role}`,
      thumbnailUrl: source.presignedThumbnailUrl || source.presignedUrl,
      isAudio: !!source.mimeType?.startsWith('audio/'),
      link: ['/gallery', source.mediaItemId],
      queryParams: {img_index: source.mediaIndex},
    }));
    return [...assets, ...media];
  }

  openLightbox(row: GalleryItem, index: number): void {
    this.lightboxItem = row;
    this.lightboxIndex = index;
  }

  @HostListener('window:keydown.escape')
  closeLightbox(): void {
    this.lightboxItem = null;
  }

  /** Saves every output of the submission, one file at a time. */
  async download(row: GalleryItem): Promise<void> {
    const urls = row.presignedUrls ?? [];
    if (!urls.length || this.downloading.has(row.id)) return;

    this.downloading.add(row.id);
    let failed = 0;
    try {
      for (const [i, url] of urls.entries()) {
        const baseName = [
          'creative-studio',
          row.id,
          urls.length > 1 ? i + 1 : null,
        ]
          .filter(part => part !== null)
          .join('-');
        try {
          await downloadMedia(url, baseName, row.mimeType);
        } catch (err) {
          failed++;
          console.error('Feed download failed', err);
        }
      }
    } finally {
      this.downloading.delete(row.id);
    }

    if (failed) {
      const message =
        urls.length === 1
          ? 'Could not download the file. Please try again.'
          : `Could not download ${failed} of ${urls.length} files. Please try again.`;
      handleErrorSnackbar(this.snackBar, {message}, 'Download');
    }
  }

  /** Opens the generator that made the row, pre-filled from it. */
  async reuse(row: GalleryItem): Promise<void> {
    if (this.reusing.has(row.id)) return;
    this.reusing.add(row.id);
    try {
      const detail = await firstValueFrom(this.loadDetail(row.id));
      const navigation = detail ? reuseNavigation(row, detail) : null;
      if (!navigation) {
        handleErrorSnackbar(
          this.snackBar,
          {message: 'Could not load this generation to reuse it.'},
          'Reuse',
        );
        return;
      }
      this.navigate(navigation);
    } finally {
      this.reusing.delete(row.id);
    }
  }

  delete(row: GalleryItem): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (workspaceId === null || this.deleting.has(row.id)) return;

    const count = this.outputs(row).length;
    this.dialog
      .open(ConfirmationDialogComponent, {
        data: {
          title: 'Delete Media',
          message:
            count > 1
              ? `Are you sure you want to delete this generation and all ${count} of its outputs?`
              : 'Are you sure you want to delete this media item?',
        },
      })
      .afterClosed()
      .subscribe(confirmed => {
        if (!confirmed) return;
        this.deleting.add(row.id);
        const items = [{id: row.id, type: row.itemType}];
        this.galleryService.bulkDelete(items, workspaceId).subscribe({
          next: ({deleted_count}) => {
            this.deleting.delete(row.id);
            // The backend answers 200 but skips an item the caller neither
            // made nor administers.
            if (!deleted_count) {
              handleErrorSnackbar(
                this.snackBar,
                {
                  message:
                    'This generation was not deleted. Only the person who made it, or an admin, can delete it.',
                },
                'Delete media',
              );
              return;
            }
            // The service drops the row from its pages; the refreshed first
            // page is the feed's own. A refresh sent before the delete may
            // still carry the row, so it is sent again.
            this.topRows = this.topRows.filter(r => r.id !== row.id);
            this.galleryService.removeLoadedItems(items);
            if (this.topRowsRefresh && !this.topRowsRefresh.closed) {
              this.refreshTopRows();
            }
            if (this.lightboxItem?.id === row.id) this.closeLightbox();
            handleSuccessSnackbar(this.snackBar, 'Media deleted successfully');
          },
          error: err => {
            this.deleting.delete(row.id);
            handleErrorSnackbar(this.snackBar, err, 'Delete media');
          },
        });
      });
  }

  // Lightbox actions, handled as the media detail page handles them.
  onLightboxEdit(index: number): void {
    if (this.lightboxItem) {
      this.navigate(editImageNavigation(this.lightboxItem, index));
    }
  }

  onLightboxGenerateVideo(event: {role: 'start' | 'end'; index: number}): void {
    if (this.lightboxItem) {
      this.navigate(
        imageToVideoNavigation(this.lightboxItem, event.role, event.index),
      );
    }
  }

  onLightboxVto(index: number): void {
    if (this.lightboxItem) {
      this.navigate(vtoNavigation(this.lightboxItem, index));
    }
  }

  onLightboxOmni(event: {selectedIndex: number}): void {
    if (this.lightboxItem) {
      this.navigate(
        editWithOmniNavigation(this.lightboxItem, event.selectedIndex),
      );
    }
  }

  onLightboxExtend(event: {selectedIndex: number}): void {
    if (this.lightboxItem) {
      this.navigate(
        extendVideoNavigation(this.lightboxItem, event.selectedIndex),
      );
    }
  }

  onLightboxConcatenate(event: {selectedIndex: number}): void {
    if (this.lightboxItem) {
      this.navigate(
        concatenateVideoNavigation(this.lightboxItem, event.selectedIndex),
      );
    }
  }

  /**
   * The refreshed first page, then the service's pages from just after the
   * first page's last row. Both are newest first, so skipping everything up
   * to that row keeps the order even when a row newer than it has gone since
   * the pages were fetched. Any row left in both (newer rows pushed it down,
   * so a later page re-sent it, or offset paging repeated it) shows once, in
   * its first place.
   */
  private render(): void {
    const lastTop = this.topRows[this.topRows.length - 1];
    const cut = lastTop
      ? this.pagedRows.findIndex(item => item.id === lastTop.id)
      : -1;
    const older = cut === -1 ? this.pagedRows : this.pagedRows.slice(cut + 1);
    const seen = new Set<number>();
    this.rows = [...this.topRows, ...older].filter(item => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  private clearTopRows(): void {
    this.topRowsRefresh?.unsubscribe();
    this.topRows = [];
    this.render();
  }

  /**
   * Re-reads the user's in-flight jobs while the tab is visible, and once
   * straight away when it becomes visible again. Uses the endpoints the
   * generator pages restore their job cards from, not a gallery search, which
   * forces status=COMPLETED for non-admins. A failed poll keeps the last count.
   */
  private pollActiveJobs(): Subscription {
    return fromEvent(this.document, 'visibilitychange')
      .pipe(
        startWith(null),
        map(() => this.document.visibilityState === 'visible'),
        distinctUntilChanged(),
        switchMap((visible, change) =>
          visible
            ? timer(0, ACTIVE_JOBS_POLL_MS).pipe(
                // A slow answer skips ticks rather than stacking requests.
                exhaustMap(tick =>
                  forkJoin([
                    this.searchService.listActiveImageJobs(),
                    this.searchService.listActiveVideoJobs(),
                  ]).pipe(
                    // The first poll after the tab was hidden. A job started
                    // and finished while it was (in the generator's own tab,
                    // say) never showed in a poll, so nothing else would
                    // bring its row in.
                    map(([images, videos]) => ({
                      jobs: [...(images ?? []), ...(videos ?? [])],
                      resumed: change > 0 && tick === 0,
                    })),
                    catchError(err => {
                      console.error(
                        'Could not read in-flight generations',
                        err,
                      );
                      return EMPTY;
                    }),
                  ),
                ),
              )
            : EMPTY,
        ),
      )
      .subscribe(({jobs, resumed}) => this.onActiveJobs(jobs, resumed));
  }

  private onActiveJobs(jobs: MediaItem[], resumed: boolean): void {
    const ids = new Set(jobs.map(job => job.id));
    const previous = this.activeJobIds;
    this.activeJobIds = ids;
    this.inFlight = jobs
      .slice()
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .map(job => ({
        id: job.id,
        prompt: job.originalPrompt || job.prompt || '',
        model: modelLabel(job.model),
        isVideo: !!job.mimeType?.startsWith('video/'),
      }));
    // A job that left the list has finished. Most finish completed, and then
    // their row belongs at the top of the feed. After the tab was hidden,
    // one may have come and gone without showing in any poll.
    if (previous && (resumed || [...previous].some(id => !ids.has(id)))) {
      this.refreshTopRows();
    }
  }

  /** Re-reads the first page of the current search, keeping later pages. */
  private refreshTopRows(): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (workspaceId === null || !this.filters) return;
    this.topRowsRefresh?.unsubscribe();
    this.topRowsRefresh = this.galleryService
      .searchOnce({...this.filters, workspaceId, offset: 0, limit: PAGE_SIZE})
      .subscribe({
        next: items => {
          this.topRows = items;
          this.render();
        },
        error: err =>
          console.error('Could not refresh the newest generations', err),
      });
  }

  private navigate(navigation: FeedNavigation): void {
    void this.router.navigate(navigation.commands, {
      state: {remixState: navigation.remixState},
    });
  }

  /**
   * Fetches a row's detail once and caches it. Concurrent callers (the row
   * scrolling into view, then Reuse) share one request. Resolves to null on
   * failure, and a later call retries.
   */
  private loadDetail(id: number): Observable<GalleryItem | null> {
    const cached = this.details.get(id);
    if (cached) return of(cached);
    let request = this.detailRequests.get(id);
    if (!request) {
      request = this.galleryService.getMedia(id).pipe(
        catchError(err => {
          console.error('Failed to load generation details', err);
          this.detailRequests.delete(id);
          return of(null);
        }),
        shareReplay(1),
      );
      this.detailRequests.set(id, request);
      request.subscribe(detail => {
        if (detail) this.details.set(id, detail);
      });
    }
    return request;
  }
}

function modelLabel(model?: string): string | undefined {
  const config = MODEL_CONFIGS.find(m => m.value === model);
  return config ? config.viewValue.replace('\n', ' ') : model;
}
