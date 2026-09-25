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

import {
  AfterViewInit,
  Component,
  ElementRef,
  HostListener,
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
import {Observable, Subscription, firstValueFrom, of} from 'rxjs';
import {catchError, shareReplay} from 'rxjs/operators';
import {ConfirmationDialogComponent} from '../../common/components/confirmation-dialog/confirmation-dialog.component';
import {MODEL_CONFIGS} from '../../common/config/model-config';
import {GalleryItem} from '../../common/models/gallery-item.model';
import {JobStatus} from '../../common/models/media-item.model';
import {GallerySearchDto} from '../../common/models/search.model';
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

  /** Detail responses by item id, for reference inputs and Reuse. */
  private details = new Map<number, GalleryItem>();
  private detailRequests = new Map<number, Observable<GalleryItem | null>>();
  // Deleted rows stay hidden: the service re-emits every page it has fetched
  // whenever it appends the next one.
  private deletedIds = new Set<number>();

  private subscriptions = new Subscription();
  private scrollObserver?: IntersectionObserver;
  private rowObserver?: IntersectionObserver;

  @ViewChild('scrollSentinel') scrollSentinel?: ElementRef<HTMLElement>;
  @ViewChildren('feedRow') rowElements?: QueryList<ElementRef<HTMLElement>>;

  constructor(
    private galleryService: GalleryService,
    private workspaceStateService: WorkspaceStateService,
    private router: Router,
    private dialog: MatDialog,
    private snackBar: MatSnackBar,
    private ngZone: NgZone,
  ) {}

  ngOnInit(): void {
    this.subscriptions.add(
      this.galleryService.images$.subscribe(items => {
        this.rows = items.filter(item => !this.deletedIds.has(item.id));
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
        this.deletedIds.clear();
      }),
    );
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
    const config = MODEL_CONFIGS.find(m => m.value === row.model);
    return config ? config.viewValue.replace('\n', ' ') : row.model;
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
        this.galleryService
          .bulkDelete([{id: row.id, type: row.itemType}], workspaceId)
          .subscribe({
            next: () => {
              this.deleting.delete(row.id);
              this.deletedIds.add(row.id);
              this.rows = this.rows.filter(r => r.id !== row.id);
              if (this.lightboxItem?.id === row.id) this.closeLightbox();
              handleSuccessSnackbar(
                this.snackBar,
                'Media deleted successfully',
              );
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
