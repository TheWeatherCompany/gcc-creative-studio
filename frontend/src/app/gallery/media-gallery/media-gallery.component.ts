import {trigger, state, style, transition, animate} from '@angular/animations';
/**
 * Copyright 2025 Google LLC
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
  EventEmitter,
  Input,
  NgZone,
  OnDestroy,
  OnInit,
  Output,
  ViewChild,
  Inject,
  PLATFORM_ID,
  HostListener,
} from '@angular/core';
import {isPlatformBrowser} from '@angular/common';
import {MatCheckboxChange} from '@angular/material/checkbox';
import {MatDialog} from '@angular/material/dialog';
import {MatSnackBar} from '@angular/material/snack-bar';
import {MatIconRegistry} from '@angular/material/icon';
import {DomSanitizer, SafeResourceUrl} from '@angular/platform-browser';
import {ActivatedRoute, Router} from '@angular/router';
import {Subscription, fromEvent, forkJoin, of} from 'rxjs';
import {debounceTime, map, switchMap} from 'rxjs/operators';
import {MediaItemSelection} from '../../common/components/image-selector/image-selector.component';
import {
  CopyToFolderDialogComponent,
  CopyToFolderDialogResult,
} from '../../common/components/copy-to-folder-dialog/copy-to-folder-dialog.component';
import {DropdownOption} from '../../common/components/studio-dropdown/studio-dropdown.component';
import {MODEL_CONFIGS} from '../../common/config/model-config';
import {JobStatus, MediaItem} from '../../common/models/media-item.model';
import {GalleryItem} from '../../common/models/gallery-item.model';
import {
  GalleryFiltersState,
  GallerySearchDto,
} from '../../common/models/search.model';
import {UserService} from '../../common/services/user.service';
import {BULK_MOVE_FAILURE_TEXT, GalleryService} from '../gallery.service';
import {WorkspaceStateService} from '../../services/workspace/workspace-state.service';
import {TagsService, TagModel} from '../../common/services/tags.service';
import {AssignTagsDialogComponent} from '../../common/components/assign-tags-dialog/assign-tags-dialog.component';
import {UserRolesEnum} from '../../common/models/user.model';
import {TagsManagementDialogComponent} from '../../common/components/tags-management-dialog/tags-management-dialog.component';
import {ConfirmationDialogComponent} from '../../common/components/confirmation-dialog/confirmation-dialog.component';
import {
  BulkMoveFailureReason,
  BulkMoveResponse,
  ConflictStrategy,
  Folder,
  FolderBreadcrumb,
  FolderConflict,
  GalleryDragPayload,
} from '../../common/models/folder.model';
import {
  FolderService,
  folderErrorMessage,
  getFolderCollisions,
} from '../../common/services/folder.service';
import {CreateFolderDialogComponent} from '../../common/components/create-folder-dialog/create-folder-dialog.component';
import {
  MoveToFolderDialogComponent,
  MoveToFolderDialogResult,
} from '../../common/components/move-to-folder-dialog/move-to-folder-dialog.component';
import {
  FolderConflictChoice,
  FolderConflictDialogComponent,
} from '../../common/components/folder-conflict-dialog/folder-conflict-dialog.component';

type ItemRef = {id: number; type: string};

@Component({
  selector: 'app-media-gallery',
  templateUrl: './media-gallery.component.html',
  styleUrl: './media-gallery.component.scss',
  animations: [
    trigger('fadeSlideInOut', [
      transition(':enter', [
        style({opacity: 0, transform: 'translateY(-10px)'}),
        animate(
          '300ms ease-out',
          style({opacity: 1, transform: 'translateY(0)'}),
        ),
      ]),
      transition(':leave', [
        animate(
          '300ms ease-in',
          style({opacity: 0, transform: 'translateY(-10px)'}),
        ),
      ]),
    ]),
  ],
  standalone: false,
})
export class MediaGalleryComponent implements OnInit, OnDestroy, AfterViewInit {
  @Output() mediaItemSelected = new EventEmitter<MediaItemSelection>();
  @Input() filterByType:
    | 'image/png'
    | 'video/mp4'
    | 'audio/mpeg'
    | 'audio/wav'
    | 'image/*'
    | 'video/*'
    | 'audio/*'
    | null = null;
  @Input() statusFilter: string | null = JobStatus.COMPLETED;

  @Input() isSelectionMode = false;
  @Input() isSelectorMode = false;
  @Input() maxSelection: number | null = null;
  @Input() filterByUserEmail: string | null = null;
  @Input() showFiltersInSelector = false;
  private isInitialized = false;

  @Input() set itemType(value: string) {
    this.assetTypeFilter = value;
    if (this.isInitialized) {
      this.searchTerm();
    }
  }
  @Output() mediaSelected = new EventEmitter<MediaItemSelection>();

  images: GalleryItem[] = [];
  filteredImages: GalleryItem[] = [];
  groups: {title: string; items: GalleryItem[]}[] = [];

  folders: Folder[] = [];
  currentFolderId: number | null = null;
  breadcrumbs: FolderBreadcrumb[] = [];
  isLoadingFolders = false;
  dragOverBreadcrumbId: number | string | null = null;
  private isProgrammaticWorkspaceSwitch = false;

  selectedItems: Set<string> = new Set();
  lastSelectedIndex: number | null = null;

  public allImagesLoaded = false;

  public isLoading = true;
  public isDeleting = false;
  public isDownloading = false;
  public isCopying = false;
  public isMoving = false;
  public showAdvancedFilters = false;

  toggleAdvancedFilters() {
    this.showAdvancedFilters = !this.showAdvancedFilters;
  }
  private routeSub: Subscription | undefined;
  private workspaceSub: Subscription | undefined;
  private imagesSubscription: Subscription | undefined;
  private allImagesLoadedSubscription: Subscription | undefined;
  private loadingSubscription: Subscription | undefined;
  private resizeSubscription: Subscription | undefined;
  private foldersSub?: Subscription;
  private _hostVisibilityObserver!: IntersectionObserver;
  private _scrollObserver!: IntersectionObserver;
  public userEmailFilter = '';
  public mediaTypeFilter = '';
  public generationModelFilter = '';
  public queryFilter = '';
  public startDateFilter: Date | null = null;
  public endDateFilter: Date | null = null;
  public assetTypeFilter = '';
  public isAdmin = false;
  public tagsFilter: string[] = [];
  public assetTypeOptions: DropdownOption[] = [
    {value: '', label: 'All Assets'},
    {value: 'media_item', label: 'Generated Media'},
    {value: 'source_asset', label: 'Uploaded Assets'},
  ];
  public availableTags: TagModel[] = [];
  tagsPageSize = 10;
  tagsCurrentPage = 1;
  onlyMyTags = true;
  onlyMyMedia = false;
  favoritesOnly = false;
  userId: number | undefined;

  // Whole-string match for a bare, full email address. Used to decide whether a
  // search term should be scoped to a user's email rather than a text search.
  private static readonly EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  @ViewChild('scrollSentinel') scrollSentinel?: ElementRef<HTMLElement>;

  get displayedTagOptions(): DropdownOption[] {
    const options = [
      {value: '', label: 'All Tags', deletable: false},
      ...this.availableTags.map(t => ({
        value: t.name,
        label: t.name,
        color: t.color,
      })),
    ];
    return options.slice(0, 1 + this.tagsCurrentPage * this.tagsPageSize);
  }

  loadMoreTags(): void {
    this.tagsCurrentPage++;
  }

  hasMoreTags(): boolean {
    return this.availableTags.length > this.tagsCurrentPage * this.tagsPageSize;
  }
  public generationModels = MODEL_CONFIGS.map(config => ({
    value: config.value,
    viewValue: config.viewValue.replace('\n', ''), // Remove newlines for dropdown
  }));

  public mediaTypeOptions: DropdownOption[] = [
    {value: '', label: 'All Types'},
    {value: 'image/*', label: 'Image'},
    {value: 'video/*', label: 'Video'},
    {value: 'audio/*', label: 'Audio'},
  ];

  public get modelOptions(): DropdownOption[] {
    let filteredModels = MODEL_CONFIGS;

    if (this.mediaTypeFilter === 'image/*') {
      filteredModels = MODEL_CONFIGS.filter(m => m.type === 'IMAGE');
    } else if (this.mediaTypeFilter === 'video/*') {
      filteredModels = MODEL_CONFIGS.filter(m => m.type === 'VIDEO');
    } else if (this.mediaTypeFilter === 'audio/*') {
      filteredModels = MODEL_CONFIGS.filter(m => m.type === 'AUDIO');
    }

    return [
      {value: '', label: 'All Models'},
      ...filteredModels.map(m => ({
        value: m.value,
        label: m.viewValue.replace('\n', ''),
      })),
    ];
  }

  onMediaTypeChange(value: string): void {
    this.mediaTypeFilter = value;

    // Reset model filter if not valid for new media type
    const validModels = this.modelOptions.map(o => o.value);
    if (!validModels.includes(this.generationModelFilter)) {
      this.generationModelFilter = ''; // Reset to All Models
    }

    this.searchTerm(); // Trigger search
  }

  private autoSlideIntervals: {[id: string]: any} = {};

  get folderMaxDepth(): number {
    return this.folderService.maxDepth;
  }

  /**
   * "Favorites only", "Only my media" and the image selector's "my uploads"
   * email filter match items in every folder at the gallery root, the way
   * Drive's Starred view does, rather than only the root-level ones. Inside
   * a folder they stay scoped to that folder.
   */
  get isCrossFolderFilterActive(): boolean {
    return (
      this.currentFolderId === null &&
      (this.favoritesOnly || this.onlyMyMedia || !!this.filterByUserEmail)
    );
  }

  /**
   * Folders cannot be favorited or owned, so the grid is hidden while a
   * cross-folder filter is on. It is deliberately not tied to isLoading:
   * every infinite-scroll page sets it, and hiding the grid then would make
   * it flicker and move the scroll sentinel.
   */
  get showFolderGrid(): boolean {
    return this.folders.length > 0 && !this.isCrossFolderFilterActive;
  }

  isBrowser: boolean;

  constructor(
    private galleryService: GalleryService,
    private sanitizer: DomSanitizer,
    public matIconRegistry: MatIconRegistry,
    private userService: UserService,
    private elementRef: ElementRef,
    private ngZone: NgZone,
    private workspaceStateService: WorkspaceStateService,
    private snackBar: MatSnackBar,
    public dialog: MatDialog,
    private tagsService: TagsService,
    private folderService: FolderService,
    private route: ActivatedRoute,
    private router: Router,
    @Inject(PLATFORM_ID) platformId: Object,
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
    this.matIconRegistry
      .addSvgIcon(
        'mobile-white-gemini-spark-icon',
        this.setPath(`${this.path}/mobile-white-gemini-spark-icon.svg`),
      )
      .addSvgIcon(
        'gemini-spark-icon',
        this.setPath(`${this.path}/gemini-spark-icon.svg`),
      );
    const user = this.userService.getUserDetails();
    this.userId = user?.id as number;
  }

  private path = '../../assets/images';

  private setPath(url: string): SafeResourceUrl {
    return this.sanitizer.bypassSecurityTrustResourceUrl(url);
  }

  ngOnInit(): void {
    this.isInitialized = true;
    const userDetails = this.userService.getUserDetails();
    this.isAdmin = userDetails?.roles?.includes(UserRolesEnum.ADMIN) || false;

    this.mediaTypeFilter = this.filterByType || '';

    if (!this.isSelectionMode && !this.isSelectorMode) {
      const savedState = this.galleryService.filtersState;
      if (savedState) {
        this.queryFilter = savedState.query;
        this.startDateFilter = savedState.startDate;
        this.endDateFilter = savedState.endDate;
        this.mediaTypeFilter = savedState.mimeType;
        this.generationModelFilter = savedState.model;
        this.assetTypeFilter = savedState.itemType;
        this.tagsFilter = savedState.tags;
        this.onlyMyMedia = savedState.onlyMyMedia;
        this.favoritesOnly = savedState.favoritesOnly ?? false;
      }
    }

    this.searchTerm(); // Initial search with stored filters
    this.loadingSubscription = this.galleryService.isLoading$.subscribe(
      loading => {
        this.isLoading = loading;
        if (!loading && this.isBrowser) {
          // Re-check loading finishes
          setTimeout(() => {
            // Logic to handle post-loading if needed
          }, 100);
        }
      },
    );

    this.imagesSubscription = this.galleryService.images$.subscribe(images => {
      if (images) {
        // Find only the new images that have been added
        const newImages = images.slice(this.images.length);
        newImages.forEach(image => {
          // Intervals now handled by child component
        });
        this.images = images as GalleryItem[]; // Cast to GalleryItem[]
        this.filterImages();
      }
    });

    this.allImagesLoadedSubscription =
      this.galleryService.allImagesLoaded.subscribe(loaded => {
        this.allImagesLoaded = loaded;
      });

    // Guard against SSR - do not load folders and breadcrumbs on server
    if (!this.isBrowser) {
      return;
    }

    this.showFeaturesHint();

    let lastWorkspaceId = this.workspaceStateService.getActiveWorkspaceId();

    if (this.isSelectionMode || this.isSelectorMode) {
      this.reload();
    } else {
      this.routeSub = this.route.paramMap.subscribe(params => {
        const folderIdParam = params.get('folderId');
        if (folderIdParam !== null) {
          const parsedFolderId = Number(folderIdParam);
          if (
            !Number.isNaN(parsedFolderId) &&
            Number.isInteger(parsedFolderId) &&
            parsedFolderId > 0
          ) {
            this.currentFolderId = parsedFolderId;
          } else {
            this.currentFolderId = null;
            void this.router.navigate(['/gallery']);
            return;
          }
        } else {
          this.currentFolderId = null;
        }

        if (!this.isInitialized) {
          return;
        }

        this.reload();
      });
    }

    this.workspaceSub = this.workspaceStateService.activeWorkspaceId$.subscribe(
      workspaceId => {
        if (!workspaceId) {
          return;
        }

        if (lastWorkspaceId !== workspaceId) {
          if (lastWorkspaceId !== null && this.currentFolderId !== null) {
            if (this.isProgrammaticWorkspaceSwitch) {
              this.isProgrammaticWorkspaceSwitch = false;
              lastWorkspaceId = workspaceId;
              this.reload();
            } else if (this.isSelectionMode || this.isSelectorMode) {
              lastWorkspaceId = workspaceId;
              this.currentFolderId = null;
              this.reload();
            } else {
              lastWorkspaceId = workspaceId;
              void this.router.navigate(['/gallery']);
            }
          } else {
            lastWorkspaceId = workspaceId;
            this.reload();
          }
        }
      },
    );
  }

  private reload() {
    this.tagsCurrentPage = 1;
    this.loadTags();
    this.loadFolders();
    this.loadBreadcrumbs();
    this.searchTerm();
  }

  private loadTags(search?: string): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (workspaceId) {
      const filterUserId = this.onlyMyTags ? this.userId : undefined;
      this.tagsService
        .getTags(
          workspaceId,
          search,
          this.tagsCurrentPage,
          this.tagsPageSize,
          filterUserId,
        )
        .subscribe(response => {
          if (this.tagsCurrentPage === 1) {
            this.availableTags = response.data;
          } else {
            this.availableTags = [...this.availableTags, ...response.data];
          }
        });
    }
  }

  toggleOnlyMyTags(checked: boolean): void {
    this.onlyMyTags = checked;
    this.tagsCurrentPage = 1; // Reset pagination
    this.loadTags();
  }

  toggleOnlyMyMedia(checked: boolean): void {
    this.onlyMyMedia = checked;
    this.searchTerm();
  }

  toggleFavoritesOnly(checked: boolean): void {
    this.favoritesOnly = checked;
    this.searchTerm();
  }

  onTagSearch(search: string): void {
    this.tagsCurrentPage = 1;
    this.loadTags(search);
  }

  onTagDelete(option: DropdownOption): void {
    const dialogRef = this.dialog.open(ConfirmationDialogComponent, {
      data: {
        title: 'Delete Tag',
        message: `Are you sure you want to delete tag "${option.label}"? This action cannot be undone.`,
      },
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
        const tag = this.availableTags.find(t => t.name === option.value);
        if (workspaceId && tag) {
          this.tagsService.deleteTag(workspaceId, tag.id).subscribe(() => {
            this.snackBar.open(`Tag "${option.label}" deleted.`, 'Close', {
              duration: 3000,
            });
            this.loadTags(); // Reload
          });
        }
      }
    });
  }

  openTagsManagement(): void {
    const dialogRef = this.dialog.open(TagsManagementDialogComponent, {
      width: '600px',
    });

    dialogRef.afterClosed().subscribe(() => {
      this.tagsCurrentPage = 1; // Reset pagination
      this.loadTags(); // Reload tags after management!
    });
  }

  ngAfterViewInit(): void {
    if (!this.isBrowser) return;
    this.setupInfiniteScroll();
  }

  /**
   * Wires an IntersectionObserver to a sentinel element at the end of the grid.
   * When the sentinel scrolls into view we trigger loadMore(). loadMore() itself
   * guards against firing while a load is in flight or once all pages are loaded
   * (currentPage >= totalPages), so no extra debounce is needed here.
   */
  private setupInfiniteScroll(): void {
    if (
      !this.scrollSentinel ||
      typeof IntersectionObserver === 'undefined' ||
      this._scrollObserver
    ) {
      return;
    }

    this._scrollObserver = new IntersectionObserver(
      entries => {
        const entry = entries[0];
        if (entry?.isIntersecting && !this.isLoading && !this.allImagesLoaded) {
          // IntersectionObserver callbacks can fire outside Angular's zone;
          // run inside so change detection picks up the loaded items.
          this.ngZone.run(() => this.loadMore());
        }
      },
      {root: null, rootMargin: '200px', threshold: 0},
    );

    this._scrollObserver.observe(this.scrollSentinel.nativeElement);
  }

  ngOnDestroy(): void {
    if (this.isBrowser) {
      // Force pause any lingering audio elements to prevent them from playing after component destruction
      const audios = this.elementRef.nativeElement.querySelectorAll('audio');
      audios.forEach((a: HTMLAudioElement) => {
        a.pause();
        a.src = '';
      });
    }

    this.routeSub?.unsubscribe();
    this.workspaceSub?.unsubscribe();
    this.imagesSubscription?.unsubscribe();
    this.loadingSubscription?.unsubscribe();
    this.allImagesLoadedSubscription?.unsubscribe();
    this.resizeSubscription?.unsubscribe();
    this.foldersSub?.unsubscribe();
    this._hostVisibilityObserver?.disconnect();
    this._scrollObserver?.disconnect();
  }

  public trackByImage(index: number, image: GalleryItem): number | string {
    return `${image.itemType}:${image.id}`;
  }

  public trackByGroup(index: number, group: {title: string}): string {
    return group.title;
  }

  public loadMore(): void {
    if (!this.isLoading && !this.allImagesLoaded) {
      this.galleryService.loadGallery();
    }
  }

  @HostListener('window:keydown.escape', ['$event'])
  onEscapePressed(event: Event): void {
    this.deselectAll();
  }

  toggleSelection(
    item: GalleryItem,
    event?: MouseEvent,
    selectedIndex = 0,
  ): void {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    const currentIndex = this.images.findIndex(
      img => img.id === item.id && img.itemType === item.itemType,
    );

    if (event?.shiftKey && this.lastSelectedIndex !== null) {
      const start = Math.min(this.lastSelectedIndex, currentIndex);
      const end = Math.max(this.lastSelectedIndex, currentIndex);

      for (let i = start; i <= end; i++) {
        const rangeItem = this.images[i];
        const id = `${rangeItem.itemType}:${rangeItem.id}`;
        if (!this.selectedItems.has(id)) {
          this.selectedItems.add(id);
          this.mediaSelected.emit({
            mediaItem: rangeItem as unknown as MediaItem,
            selectedIndex: 0,
          });
        }
      }
    } else {
      const id = `${item.itemType}:${item.id}`;
      if (this.selectedItems.has(id)) {
        this.selectedItems.delete(id);
        this.mediaSelected.emit({
          mediaItem: item as unknown as MediaItem,
          selectedIndex,
        });
      } else {
        // If maxSelection is 1, clear previous and select new
        if (this.maxSelection === 1) {
          this.selectedItems.clear();
        } else if (
          this.maxSelection &&
          this.selectedItems.size >= this.maxSelection
        ) {
          return;
        }
        this.selectedItems.add(id);
        this.mediaSelected.emit({
          mediaItem: item as unknown as MediaItem,
          selectedIndex,
        });
      }
    }
    this.lastSelectedIndex = currentIndex;
  }

  selectAll(): void {
    this.images.forEach(item => {
      const id = `${item.itemType}:${item.id}`;
      this.selectedItems.add(id);
    });
  }

  deselectAll(): void {
    this.selectedItems.clear();
    this.lastSelectedIndex = null;
  }

  toggleSelectAll(): void {
    if (this.isAllSelected) {
      this.deselectAll();
    } else {
      this.selectAll();
    }
  }

  get isAllSelected(): boolean {
    return (
      this.images.length > 0 && this.selectedItems.size === this.images.length
    );
  }

  isItemSelected(item: GalleryItem): boolean {
    return this.selectedItems.has(`${item.itemType}:${item.id}`);
  }

  deleteSelected(): void {
    if (this.selectedItems.size === 0 || this.isDeleting) return;
    const itemsToDelete = Array.from(this.selectedItems).map(id => {
      const [type, itemId] = id.split(':');
      return {id: parseInt(itemId), type};
    });

    if (
      confirm(
        `Are you sure you want to delete ${itemsToDelete.length} ${itemsToDelete.length === 1 ? 'item' : 'items'}?`,
      )
    ) {
      this.isDeleting = true;
      const workspaceId =
        this.workspaceStateService.getActiveWorkspaceId() || 0;
      this.galleryService.bulkDelete(itemsToDelete, workspaceId).subscribe({
        next: () => {
          // Remove deleted items from local state
          this.images = this.images.filter(
            img => !this.selectedItems.has(`${img.itemType}:${img.id}`),
          );
          this.selectedItems.clear();
          this.updateGroups();
          this.isDeleting = false;
        },
        error: err => {
          console.error('Error deleting items:', err);
          this.isDeleting = false;
        },
      });
    }
  }

  copySelected(): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (!workspaceId || this.selectedItems.size === 0) return;

    // Captured once, so a retry after the conflict dialog copies what was
    // selected when the user asked, not whatever is selected by then.
    const itemsToCopy = this.selectedItemRefs();
    const mediaItemIds = itemsToCopy
      .filter(item => item.type === 'media_item')
      .map(item => item.id);
    const sourceAssetIds = itemsToCopy
      .filter(item => item.type === 'source_asset')
      .map(item => item.id);

    const dialogRef = this.dialog.open(CopyToFolderDialogComponent, {
      width: '480px',
      data: {
        workspaceId,
        itemCount: this.selectedItems.size,
        currentFolderId: this.currentFolderId,
        title: 'Copy Items',
        subtitle: `Select a destination for ${this.selectedItems.size} selected item${this.selectedItems.size === 1 ? '' : 's'}`,
      },
    });

    dialogRef
      .afterClosed()
      .subscribe((result: CopyToFolderDialogResult | null | undefined) => {
        if (!result) return;

        if (result.destinationFolderId !== undefined) {
          const destName =
            result.destinationFolderId === null
              ? 'All Media'
              : result.destinationName || 'Folder';
          this.executeCopy(
            mediaItemIds,
            sourceAssetIds,
            [],
            result.destinationFolderId,
            destName,
          );
        } else if (result.destinationWorkspaceId !== undefined) {
          const destName = result.destinationName || 'target workspace';
          this.performCopy(
            itemsToCopy,
            result.destinationWorkspaceId,
            null,
            destName,
          );
        }
      });
  }

  private performCopy(
    itemsToCopy: ItemRef[],
    targetWorkspaceId: number,
    conflictStrategy?: ConflictStrategy | null,
    destinationName = 'target workspace',
  ): void {
    this.isCopying = true;
    this.galleryService
      .bulkCopy(itemsToCopy, targetWorkspaceId, conflictStrategy)
      .subscribe({
        next: result => {
          this.snackBar.open(
            this.copyOutcomeMessage(
              result.copied_count,
              itemsToCopy.length,
              false,
              destinationName,
            ),
            'Close',
            {duration: 4000},
          );
          this.selectedItems.clear();
          this.isCopying = false;
        },
        error: err => {
          console.error('Error copying items:', err);
          this.isCopying = false;
          if (
            this.openConflictDialog(err, destinationName, false, choice =>
              this.performCopy(
                itemsToCopy,
                targetWorkspaceId,
                choice,
                destinationName,
              ),
            )
          ) {
            return;
          }
          this.reportFolderError(err, 'Failed to copy items');
        },
      });
  }

  private executeCopy(
    mediaItemIds: number[],
    sourceAssetIds: number[],
    folderIds: number[],
    destinationFolderId: number | null,
    destinationName: string,
    conflictStrategy?: ConflictStrategy | null,
  ): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (!workspaceId) return;

    const totalCount =
      mediaItemIds.length + sourceAssetIds.length + folderIds.length;
    if (totalCount === 0) return;

    this.isCopying = true;

    this.folderService
      .copyItems({
        workspaceId,
        mediaItemIds,
        sourceAssetIds,
        folderIds,
        destinationFolderId,
        conflictStrategy,
      })
      .subscribe({
        next: res => {
          this.snackBar.open(
            this.copyOutcomeMessage(
              res.media_items_copied + res.source_assets_copied,
              mediaItemIds.length + sourceAssetIds.length,
              folderIds.length > 0,
              destinationName,
            ),
            'Close',
            {duration: 4000},
          );
          this.isCopying = false;
          this.selectedItems.clear();
          this.loadFolders();
          this.searchTerm();
        },
        error: err => {
          console.error('Error copying items:', err);
          this.isCopying = false;
          if (
            this.openConflictDialog(err, destinationName, false, choice =>
              this.executeCopy(
                mediaItemIds,
                sourceAssetIds,
                folderIds,
                destinationFolderId,
                destinationName,
                choice,
              ),
            )
          ) {
            return;
          }
          this.reportFolderError(err, 'Failed to copy items');
        },
      });
  }

  /**
   * Copy counts are database rows: a copied folder counts everything inside
   * it, so no number is shown when folders were part of the copy. The backend
   * skips items that no longer exist without an error, so a short count for
   * plain items is reported rather than read as success.
   */
  private copyOutcomeMessage(
    copied: number,
    requested: number,
    includesFolders: boolean,
    destinationName: string,
  ): string {
    if (includesFolders) {
      return `Copied to "${destinationName}"`;
    }
    if (copied < requested) {
      return `${copied} of ${requested} ${requested === 1 ? 'item' : 'items'} copied to "${destinationName}"; some items no longer exist`;
    }
    return `${copied} item${copied === 1 ? '' : 's'} copied to "${destinationName}"`;
  }

  downloadSelected(): void {
    if (this.selectedItems.size === 0 || this.isDownloading) return;
    this.isDownloading = true;
    const itemsToDownload = Array.from(this.selectedItems).map(id => {
      const [type, itemId] = id.split(':');
      return {id: parseInt(itemId), type};
    });

    const workspaceId = this.workspaceStateService.getActiveWorkspaceId() || 0;
    this.galleryService.bulkDownload(itemsToDownload, workspaceId).subscribe({
      next: blob => {
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `gallery_export_${new Date().getTime()}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
        this.isDownloading = false;
      },
      error: err => {
        console.error('Error downloading items:', err);
        this.isDownloading = false;
      },
    });
  }

  getCombinedTags(): string[] {
    const tags = new Set<string>();
    this.selectedItems.forEach(selectedId => {
      const [type, id] = selectedId.split(':');
      const item = this.images.find(
        img => img.id === parseInt(id) && img.itemType === type,
      );
      if (item && item.tags) {
        item.tags.forEach(t => tags.add(t.name));
      }
    });
    return Array.from(tags);
  }

  openBulkAssignTagsDialog(): void {
    if (this.selectedItems.size === 0) return;

    const dialogRef = this.dialog.open(AssignTagsDialogComponent, {
      width: '400px',
      data: {
        assetId: 0,
        assetType: '',
        existingTags: this.getCombinedTags(),
      },
    });

    dialogRef.afterClosed().subscribe((selectedTags: string[]) => {
      if (selectedTags) {
        this.performBulkTag(selectedTags);
      }
    });
  }

  private performBulkTag(selectedTags: string[]): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (!workspaceId) return;

    const selected = Array.from(this.selectedItems);
    const mediaItemIds = selected
      .filter(id => id.startsWith('media_item:'))
      .map(id => parseInt(id.split(':')[1]));
    const sourceAssetIds = selected
      .filter(id => id.startsWith('source_asset:'))
      .map(id => parseInt(id.split(':')[1]));

    const observables = [];
    if (mediaItemIds.length > 0) {
      observables.push(
        this.tagsService.bulkAssign(
          workspaceId,
          mediaItemIds,
          'media_item',
          selectedTags,
        ),
      );
    }
    if (sourceAssetIds.length > 0) {
      observables.push(
        this.tagsService.bulkAssign(
          workspaceId,
          sourceAssetIds,
          'source_asset',
          selectedTags,
        ),
      );
    }

    if (observables.length > 0) {
      forkJoin(observables).subscribe({
        next: () => {
          this.snackBar.open('Tags assigned successfully', 'Close', {
            duration: 3000,
          });
          this.selectedItems.clear();
          this.lastSelectedIndex = null;
          this.searchTerm();
          this.tagsCurrentPage = 1; // Reset tags pagination
          this.loadTags(); // Reload tags to show new ones
        },
        error: err => console.error('Error assigning tags:', err),
      });
    }
  }

  private updateGroups(): void {
    // 1. Group images
    const groupsMap = new Map<string, GalleryItem[]>();
    // We want to preserve order of groups based on time
    const groupOrder: string[] = [];

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Helper to get start of week (Sunday)
    const getStartOfWeek = (d: Date) => {
      const date = new Date(d);
      const day = date.getDay();
      const diff = date.getDate() - day;
      return new Date(date.setDate(diff));
    };

    this.images.forEach(image => {
      if (!image.createdAt) return;
      const date = new Date(image.createdAt);
      // Reset time for comparison
      const dateOnly = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
      );

      let groupName = '';

      const diffTime = today.getTime() - dateOnly.getTime();
      const diffDays = diffTime / (1000 * 3600 * 24);

      if (dateOnly.getTime() === today.getTime()) {
        groupName = 'Today';
      } else if (dateOnly.getTime() === yesterday.getTime()) {
        groupName = 'Yesterday';
      } else if (diffDays <= 60) {
        // Weekly for last 2 months
        const startOfWeek = getStartOfWeek(dateOnly);
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(endOfWeek.getDate() + 6);

        const startOption: Intl.DateTimeFormatOptions = {
          month: 'short',
          day: 'numeric',
        };
        const endOption: Intl.DateTimeFormatOptions = {day: 'numeric'};

        // If end of week is in different month, show both months
        if (startOfWeek.getMonth() !== endOfWeek.getMonth()) {
          groupName = `${startOfWeek.toLocaleDateString('en-US', startOption)} - ${endOfWeek.toLocaleDateString('en-US', startOption)}`;
        } else {
          groupName = `${startOfWeek.toLocaleDateString('en-US', startOption)} - ${endOfWeek.toLocaleDateString('en-US', endOption)}`;
        }
      } else {
        // Monthly for older
        const options: Intl.DateTimeFormatOptions = {
          month: 'long',
          year: 'numeric',
        };
        groupName = dateOnly.toLocaleDateString('en-US', options);
      }

      if (!groupsMap.has(groupName)) {
        groupsMap.set(groupName, []);
        groupOrder.push(groupName);
      }
      groupsMap.get(groupName)?.push(image);
    });

    // 2. Assign items to each group
    this.groups = groupOrder.map(title => {
      const items = groupsMap.get(title) || [];
      return {title, items};
    });
  }

  isWide(media: GalleryItem): boolean {
    const rawRatio = media.aspectRatio;
    if (!rawRatio) {
      return media.mimeType?.startsWith('audio/') || false;
    }
    const parts = rawRatio.split(':').map(Number);
    if (
      parts.length !== 2 ||
      isNaN(parts[0]) ||
      isNaN(parts[1]) ||
      parts[1] === 0
    ) {
      return false;
    }
    const ratio = parts[0] / parts[1];
    return ratio >= 2;
  }

  isTall(media: GalleryItem): boolean {
    const rawRatio = media.aspectRatio;
    if (!rawRatio) return false;
    const parts = rawRatio.split(':').map(Number);
    if (
      parts.length !== 2 ||
      isNaN(parts[0]) ||
      isNaN(parts[1]) ||
      parts[1] === 0
    ) {
      return false;
    }
    const ratio = parts[0] / parts[1];
    return ratio <= 0.5;
  }

  private filterImages() {
    this.updateGroups();
  }

  private showFeaturesHint(): void {
    if (!this.isBrowser) return;

    const hintSeen = localStorage.getItem('gallery_features_hint_seen');
    if (!hintSeen) {
      this.snackBar.open(
        'New: Use Shift + Click for range selection and Esc to deselect all!',
        'Got it',
        {
          duration: 10000,
          panelClass: ['gallery-hint-snackbar'],
        },
      );
      localStorage.setItem('gallery_features_hint_seen', 'true');
    }
  }

  public searchTerm(): void {
    // Reset local component state for a new search to show the main loader
    this.images = [];
    this.selectedItems.clear();
    this.tagsCurrentPage = 1; // Reset tags pagination on search

    const filters: GallerySearchDto = {limit: 40};
    if (this.queryFilter.trim()) {
      const term = this.queryFilter.trim();
      // Only treat the query as an email lookup when it is a bare, full email
      // address (whole-string match). Previously any query merely *containing*
      // an "@" was routed to the email filter, which silently hijacked normal
      // prompt searches like "cat @ the beach". A whole-string email match is
      // the least-surprising signal that the user actually wants email scoping.
      if (MediaGalleryComponent.EMAIL_REGEX.test(term)) {
        filters['userEmail'] = term;
      } else {
        filters['query'] = term;
      }
    }
    if (this.startDateFilter) {
      filters['startDate'] = this.startDateFilter.toISOString();
    }
    if (this.filterByUserEmail) {
      filters['userEmail'] = this.filterByUserEmail;
    }
    if (this.onlyMyMedia) {
      const user = this.userService.getUserDetails();
      if (user?.email) {
        filters['userEmail'] = user.email;
      }
    }
    if (this.endDateFilter) {
      filters['endDate'] = this.endDateFilter.toISOString();
    }

    // userEmailFilter is no longer used directly from its own input field
    const mimeType = this.filterByType
      ? this.filterByType
      : this.isSelectionMode
        ? null
        : this.mediaTypeFilter;
    if (mimeType) {
      filters['mimeType'] = mimeType;
    }
    if (this.generationModelFilter) {
      filters['model'] = this.generationModelFilter;
    }
    if (this.statusFilter) {
      filters['status'] = this.statusFilter;
    }
    if (this.assetTypeFilter) {
      filters['itemType'] = this.assetTypeFilter;
    }
    if (this.tagsFilter.length > 0) {
      filters['tags'] = this.tagsFilter;
    }
    if (this.favoritesOnly) {
      filters['favoritesOnly'] = true;
    }

    // Folder scoping. A free-text search spans every folder, as upstream's
    // does. Without one, a folder shows its own items and the root shows
    // root-level items, unless a cross-folder filter is on.
    if (!this.queryFilter.trim()) {
      if (this.currentFolderId !== null) {
        filters['folderId'] = this.currentFolderId;
      } else if (!this.isCrossFolderFilterActive) {
        filters['isRoot'] = true;
      }
    }

    if (!this.isSelectionMode && !this.isSelectorMode) {
      const state: GalleryFiltersState = {
        query: this.queryFilter,
        startDate: this.startDateFilter,
        endDate: this.endDateFilter,
        mimeType: this.mediaTypeFilter,
        model: this.generationModelFilter,
        itemType: this.assetTypeFilter,
        tags: this.tagsFilter,
        onlyMyMedia: this.onlyMyMedia,
        favoritesOnly: this.favoritesOnly,
      };
      this.galleryService.setFiltersState(state);
    }
    this.galleryService.setFilters(filters);
  }

  public onTagChange(tags: string[]): void {
    this.tagsFilter = tags;
    this.searchTerm();
  }

  loadFolders(): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (!workspaceId) {
      this.folders = [];
      return;
    }
    this.isLoadingFolders = true;
    this.foldersSub?.unsubscribe();
    this.foldersSub = this.folderService
      .getFolders(workspaceId, this.currentFolderId)
      .subscribe({
        next: folders => {
          this.folders = folders;
          this.isLoadingFolders = false;
        },
        error: err => {
          console.error('Error loading folders:', err);
          this.isLoadingFolders = false;
        },
      });
  }

  loadBreadcrumbs(): void {
    if (this.currentFolderId === null) {
      this.breadcrumbs = [];
      return;
    }

    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    this.folderService
      .getBreadcrumbs(this.currentFolderId, workspaceId ?? undefined)
      .subscribe({
        next: crumbs => {
          this.breadcrumbs = crumbs;
        },
        error: err => {
          console.error('Error loading breadcrumbs:', err);
          if (!this.isSelectionMode && !this.isSelectorMode) {
            this.handleFolderLoadError(err);
          }
        },
      });
  }

  private static stringDetail(err: unknown): string | undefined {
    const detail = (err as {error?: {detail?: unknown}})?.error?.detail;
    return typeof detail === 'string' && detail.trim() ? detail : undefined;
  }

  private static statusOf(err: unknown): number | undefined {
    return (err as {status?: number})?.status;
  }

  private handleFolderLoadError(err: unknown): void {
    if (this.isSelectionMode || this.isSelectorMode) {
      return;
    }

    const status = MediaGalleryComponent.statusOf(err);
    if (status === 404 && this.currentFolderId !== null) {
      const requestedFolderId = this.currentFolderId;
      this.folderService.getFolderById(requestedFolderId).subscribe({
        next: folder => {
          if (this.currentFolderId !== requestedFolderId) {
            return;
          }
          const currentWorkspaceId =
            this.workspaceStateService.getActiveWorkspaceId();
          if (folder.workspaceId && folder.workspaceId !== currentWorkspaceId) {
            this.isProgrammaticWorkspaceSwitch = true;
            if (typeof window !== 'undefined' && window.localStorage) {
              localStorage.setItem(
                'activeWorkspaceId',
                folder.workspaceId.toString(),
              );
            }
            this.snackBar.open("Switched to folder's workspace.", 'Close', {
              duration: 3000,
            });
            this.workspaceStateService.setActiveWorkspaceId(folder.workspaceId);
            return;
          }
          this.snackBar.open('Folder not found in this workspace.', 'Close', {
            duration: 3000,
          });
          void this.router.navigate(['/gallery']);
        },
        error: folderErr => {
          const fallback =
            MediaGalleryComponent.statusOf(folderErr) === 403
              ? 'You do not have permission to access this folder.'
              : 'Folder not found.';
          const message =
            MediaGalleryComponent.stringDetail(folderErr) || fallback;
          this.snackBar.open(message, 'Close', {duration: 3000});
          void this.router.navigate(['/gallery']);
        },
      });
      return;
    }

    const fallback =
      status === 403
        ? 'You do not have permission to access this folder.'
        : 'Folder not found in this workspace.';
    const message = MediaGalleryComponent.stringDetail(err) || fallback;
    this.snackBar.open(message, 'Close', {duration: 3000});
    void this.router.navigate(['/gallery']);
  }

  navigateToFolder(folder: Folder): void {
    if (!this.isSelectionMode && !this.isSelectorMode) {
      void this.router.navigate(['/folders', folder.id]);
    } else {
      this.currentFolderId = folder.id;
      this.loadFolders();
      this.loadBreadcrumbs();
      this.searchTerm();
    }
  }

  navigateToBreadcrumb(breadcrumb: FolderBreadcrumb | null): void {
    if (!this.isSelectionMode && !this.isSelectorMode) {
      if (breadcrumb) {
        void this.router.navigate(['/folders', breadcrumb.id]);
      } else {
        void this.router.navigate(['/gallery']);
      }
    } else {
      this.currentFolderId = breadcrumb ? breadcrumb.id : null;
      this.loadFolders();
      this.loadBreadcrumbs();
      this.searchTerm();
    }
  }

  /**
   * Re-reads folders, breadcrumbs and items. loadBreadcrumbs leaves the
   * folder, through handleFolderLoadError, if the one on screen is gone.
   */
  private refreshView(): void {
    this.loadFolders();
    this.loadBreadcrumbs();
    this.searchTerm();
  }

  /**
   * Shows why a folder request failed. Folder structure changes are
   * serialized per workspace, so a request that waited behind another can
   * find its folder moved or trashed (404) or its move now invalid (400);
   * the view is then stale, so it is refreshed. Any other 409 (a nested too
   * deeply walk, a name clash) leaves the folder list suspect.
   */
  private reportFolderError(err: unknown, fallback: string): void {
    this.snackBar.open(folderErrorMessage(err, fallback), 'Close', {
      duration: 5000,
    });
    const status = MediaGalleryComponent.statusOf(err);
    if (status === 404 || status === 400) {
      this.refreshView();
    } else if (status === 409) {
      this.loadFolders();
    }
  }

  /**
   * Opens the conflict dialog when, and only when, `err` is the
   * FOLDER_COLLISION 409, and calls `retry` with the user's choice. Returns
   * false for every other error so the caller can report it.
   */
  private openConflictDialog(
    err: unknown,
    destinationName: string,
    isMove: boolean,
    retry: (choice: ConflictStrategy) => void,
  ): boolean {
    const conflicts: FolderConflict[] | null = getFolderCollisions(err);
    if (!conflicts) {
      return false;
    }
    const folderNames = conflicts.map(c => c.folder_name || 'Folder');
    const dialogRef = this.dialog.open(FolderConflictDialogComponent, {
      data: {folderNames, destinationName, isMove},
    });
    dialogRef
      .afterClosed()
      .subscribe((choice: FolderConflictChoice | null | undefined) => {
        if (choice === 'keep_both' || choice === 'merge') {
          retry(choice);
        }
      });
    return true;
  }

  openCreateFolderDialog(): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (!workspaceId) return;

    if (this.breadcrumbs.length >= this.folderService.maxDepth) {
      this.snackBar.open(
        `Maximum folder tree depth of ${this.folderService.maxDepth} levels reached.`,
        'Close',
        {duration: 3000},
      );
      return;
    }

    const dialogRef = this.dialog.open(CreateFolderDialogComponent, {
      data: {
        workspaceId,
        parentId: this.currentFolderId,
        existingFolderNames: this.folders.map(f => f.name),
      },
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        this.folderService
          .createFolder({
            workspaceId,
            parentId: this.currentFolderId,
            name: result.name,
            color: result.color,
          })
          .subscribe({
            next: created => {
              this.snackBar.open(`Folder "${created.name}" created`, 'Close', {
                duration: 3000,
              });
              this.loadFolders();
            },
            error: err => {
              console.error('Error creating folder:', err);
              this.reportFolderError(err, 'Failed to create folder');
            },
          });
      }
    });
  }

  openEditFolderDialog(folder: Folder): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (!workspaceId) return;

    const dialogRef = this.dialog.open(CreateFolderDialogComponent, {
      data: {
        workspaceId,
        parentId: folder.parentId,
        folder,
        existingFolderNames: this.folders.map(f => f.name),
      },
    });

    dialogRef.afterClosed().subscribe(result => {
      if (result) {
        // No parentId key: the backend reads a parentId in a PATCH as a move.
        this.folderService
          .updateFolder(folder.id, {
            name: result.name,
            color: result.color,
          })
          .subscribe({
            next: updated => {
              this.snackBar.open(
                `Folder renamed to "${updated.name}"`,
                'Close',
                {duration: 3000},
              );
              this.loadFolders();
              this.loadBreadcrumbs();
            },
            error: err => {
              console.error('Error updating folder:', err);
              this.reportFolderError(err, 'Failed to rename folder');
            },
          });
      }
    });
  }

  openDeleteFolderDialog(folder: Folder): void {
    // The backend trashes everything in the folder's subtree along with it,
    // and only an admin can restore trashed items, so the prompt says both.
    const dialogRef = this.dialog.open(ConfirmationDialogComponent, {
      data: {
        title: 'Delete Folder',
        message: `Delete folder "${folder.name}"? Its subfolders and all the media in them will be moved to trash too. Only an admin can restore trashed items.`,
      },
    });

    dialogRef.afterClosed().subscribe(confirmed => {
      if (confirmed) {
        this.folderService.deleteFolder(folder.id).subscribe({
          next: res => {
            if (!res.success) {
              this.snackBar.open(
                `Folder "${folder.name}" was already deleted`,
                'Close',
                {duration: 3000},
              );
              this.loadFolders();
              return;
            }
            this.snackBar.open(`Folder "${folder.name}" deleted`, 'Close', {
              duration: 3000,
            });
            this.loadFolders();
            this.searchTerm();
          },
          error: err => {
            console.error('Error deleting folder:', err);
            this.reportFolderError(err, 'Failed to delete folder');
          },
        });
      }
    });
  }

  openCopyFolderDialog(folder: Folder): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (!workspaceId) return;

    const dialogRef = this.dialog.open(CopyToFolderDialogComponent, {
      width: '480px',
      data: {
        workspaceId,
        itemCount: 1,
        copyingFolderIds: [folder.id],
        currentFolderId: folder.parentId ?? null,
        title: 'Copy Folder',
        subtitle: `Select a destination for "${folder.name}" and its contents`,
      },
    });

    dialogRef
      .afterClosed()
      .subscribe((result: CopyToFolderDialogResult | null | undefined) => {
        if (!result) return;

        if (result.destinationFolderId !== undefined) {
          const destName =
            result.destinationFolderId === null
              ? 'All Media'
              : result.destinationName || 'Folder';
          this.executeCopy(
            [],
            [],
            [folder.id],
            result.destinationFolderId,
            destName,
          );
        } else if (result.destinationWorkspaceId !== undefined) {
          const destName = result.destinationName || 'target workspace';
          this.executeCopyFolderToWorkspace(
            folder,
            result.destinationWorkspaceId,
            null,
            destName,
          );
        }
      });
  }

  private executeCopyFolderToWorkspace(
    folder: Folder,
    targetWorkspaceId: number,
    conflictStrategy?: ConflictStrategy | null,
    destinationName = 'target workspace',
  ): void {
    this.isCopying = true;
    const itemsToCopy = [{id: folder.id, type: 'folder'}];
    this.galleryService
      .bulkCopy(itemsToCopy, targetWorkspaceId, conflictStrategy)
      .subscribe({
        next: () => {
          this.snackBar.open(
            `Folder "${folder.name}" copied to "${destinationName}"`,
            'Close',
            {duration: 3000},
          );
          this.isCopying = false;
        },
        error: err => {
          console.error('Error copying folder to workspace:', err);
          this.isCopying = false;
          if (
            this.openConflictDialog(err, destinationName, false, choice =>
              this.executeCopyFolderToWorkspace(
                folder,
                targetWorkspaceId,
                choice,
                destinationName,
              ),
            )
          ) {
            return;
          }
          this.reportFolderError(err, 'Failed to copy folder');
        },
      });
  }

  openMoveFolderDialog(folder: Folder): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (!workspaceId) return;

    const dialogRef = this.dialog.open(MoveToFolderDialogComponent, {
      data: {
        workspaceId,
        itemCount: 1,
        movingFolderIds: [folder.id],
        currentFolderId: folder.parentId ?? null,
      },
    });

    dialogRef
      .afterClosed()
      .subscribe((result: MoveToFolderDialogResult | null) => {
        if (!result) {
          return;
        }

        if (result.destinationFolderId !== undefined) {
          const destName =
            result.destinationFolderId === null
              ? 'All Media'
              : result.destinationName || 'Folder';
          this.executeMove(
            [],
            [],
            [folder.id],
            result.destinationFolderId,
            destName,
          );
        } else if (result.destinationWorkspaceId !== undefined) {
          const destName = result.destinationName || 'Workspace';
          this.executeMoveToWorkspace(
            [],
            [],
            [folder.id],
            result.destinationWorkspaceId,
            destName,
          );
        }
      });
  }

  openBatchMoveDialog(): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (!workspaceId || this.selectedItems.size === 0) return;

    const selected = this.selectedItemRefs();
    const mediaItemIds = selected
      .filter(item => item.type === 'media_item')
      .map(item => item.id);
    const sourceAssetIds = selected
      .filter(item => item.type === 'source_asset')
      .map(item => item.id);

    const dialogRef = this.dialog.open(MoveToFolderDialogComponent, {
      data: {
        workspaceId,
        itemCount: this.selectedItems.size,
        currentFolderId: this.currentFolderId,
      },
    });

    dialogRef
      .afterClosed()
      .subscribe((result: MoveToFolderDialogResult | null) => {
        if (!result) {
          return;
        }
        if (result.destinationFolderId !== undefined) {
          const destName =
            result.destinationFolderId === null
              ? 'All Media'
              : result.destinationName || 'Folder';
          this.executeMove(
            mediaItemIds,
            sourceAssetIds,
            [],
            result.destinationFolderId,
            destName,
          );
        } else if (result.destinationWorkspaceId !== undefined) {
          const destName = result.destinationName || 'Workspace';
          this.executeMoveToWorkspace(
            mediaItemIds,
            sourceAssetIds,
            [],
            result.destinationWorkspaceId,
            destName,
          );
        }
      });
  }

  onBreadcrumbDragOver(event: DragEvent, folderId: number | null): void {
    if (this.isSelectorMode || this.currentFolderId === folderId) {
      return;
    }
    if (event.dataTransfer?.types.includes('application/json')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      this.dragOverBreadcrumbId = folderId === null ? 'root' : folderId;
    }
  }

  onBreadcrumbDragLeave(event: DragEvent, folderId: number | null): void {
    const currentTarget = event.currentTarget as HTMLElement;
    const relatedTarget = event.relatedTarget as Node | null;
    if (!currentTarget || !currentTarget.contains(relatedTarget)) {
      if (
        (folderId === null && this.dragOverBreadcrumbId === 'root') ||
        this.dragOverBreadcrumbId === folderId
      ) {
        this.dragOverBreadcrumbId = null;
      }
    }
  }

  onBreadcrumbDrop(event: DragEvent, targetFolderId: number | null): void {
    event.preventDefault();
    this.dragOverBreadcrumbId = null;
    if (this.isSelectorMode || this.currentFolderId === targetFolderId) {
      return;
    }
    const data = event.dataTransfer?.getData('application/json');
    if (data) {
      try {
        const payload: GalleryDragPayload = JSON.parse(data);
        const targetName =
          targetFolderId === null
            ? 'All Media'
            : this.breadcrumbs.find(b => b.id === targetFolderId)?.name ||
              'Folder';
        this.executeMove(
          payload.mediaItemIds || [],
          payload.sourceAssetIds || [],
          payload.folderIds || [],
          targetFolderId,
          targetName,
        );
      } catch (e) {
        console.error('Failed to parse drag payload on breadcrumb drop:', e);
      }
    }
  }

  onItemDroppedOnFolder(
    targetFolder: Folder,
    payload: GalleryDragPayload,
  ): void {
    if (this.isSelectorMode || this.currentFolderId === targetFolder.id) {
      return;
    }
    this.executeMove(
      payload.mediaItemIds || [],
      payload.sourceAssetIds || [],
      payload.folderIds || [],
      targetFolder.id,
      targetFolder.name,
    );
  }

  private selectedItemRefs(): ItemRef[] {
    return Array.from(this.selectedItems).map(key => {
      const [type, itemId] = key.split(':');
      return {id: parseInt(itemId), type};
    });
  }

  /**
   * Takes the moving items off the view before the request returns, and
   * hands back the state to restore if it fails.
   */
  private removeOptimistically(
    mediaItemIds: number[],
    sourceAssetIds: number[],
    folderIds: number[],
  ): {images: GalleryItem[]; folders: Folder[]; selectedItems: Set<string>} {
    const movedKeys = new Set([
      ...mediaItemIds.map(id => `media_item:${id}`),
      ...sourceAssetIds.map(id => `source_asset:${id}`),
    ]);
    const movedFolderSet = new Set(folderIds);

    const snapshot = {
      images: [...this.images],
      folders: [...this.folders],
      selectedItems: new Set(this.selectedItems),
    };

    this.images = this.images.filter(
      img => !movedKeys.has(`${img.itemType}:${img.id}`),
    );
    this.folders = this.folders.filter(f => !movedFolderSet.has(f.id));
    this.updateGroups();

    for (const key of movedKeys) {
      this.selectedItems.delete(key);
    }
    if (this.selectedItems.size === 0) {
      this.lastSelectedIndex = null;
    }
    return snapshot;
  }

  private restoreSnapshot(snapshot: {
    images: GalleryItem[];
    folders: Folder[];
    selectedItems: Set<string>;
  }): void {
    this.images = snapshot.images;
    this.folders = snapshot.folders;
    this.selectedItems = snapshot.selectedItems;
    this.updateGroups();
  }

  private executeMove(
    mediaItemIds: number[],
    sourceAssetIds: number[],
    folderIds: number[],
    destinationFolderId: number | null,
    destinationName: string,
    conflictStrategy?: ConflictStrategy | null,
  ): void {
    const workspaceId = this.workspaceStateService.getActiveWorkspaceId();
    if (!workspaceId) return;

    const totalCount =
      mediaItemIds.length + sourceAssetIds.length + folderIds.length;
    if (totalCount === 0) return;

    const snapshot = this.removeOptimistically(
      mediaItemIds,
      sourceAssetIds,
      folderIds,
    );
    this.isMoving = true;

    this.folderService
      .moveItems({
        workspaceId,
        mediaItemIds,
        sourceAssetIds,
        folderIds,
        destinationFolderId,
        conflictStrategy,
      })
      .subscribe({
        next: res => {
          this.isMoving = false;
          if (res.total_moved < totalCount) {
            // The backend skips, without an error, anything another change
            // already moved out of this workspace or deleted.
            this.snackBar.open(
              `${res.total_moved} of ${totalCount} items moved to "${destinationName}"; the rest were moved or deleted elsewhere`,
              'Close',
              {duration: 6000},
            );
            this.loadFolders();
            this.searchTerm();
            return;
          }
          this.snackBar.open(
            `${res.total_moved} item${res.total_moved === 1 ? '' : 's'} moved to "${destinationName}"`,
            'Close',
            {duration: 3000},
          );
          this.loadFolders();
        },
        error: err => {
          console.error('Error moving items:', err);
          this.restoreSnapshot(snapshot);
          this.isMoving = false;
          if (
            this.openConflictDialog(err, destinationName, true, choice =>
              this.executeMove(
                mediaItemIds,
                sourceAssetIds,
                folderIds,
                destinationFolderId,
                destinationName,
                choice,
              ),
            )
          ) {
            return;
          }
          this.reportFolderError(err, 'Failed to move items');
        },
      });
  }

  private executeMoveToWorkspace(
    mediaItemIds: number[],
    sourceAssetIds: number[],
    folderIds: number[] = [],
    destinationWorkspaceId: number,
    destinationName: string,
    conflictStrategy?: ConflictStrategy | null,
  ): void {
    const totalCount =
      mediaItemIds.length + sourceAssetIds.length + folderIds.length;
    if (totalCount === 0) return;

    const snapshot = this.removeOptimistically(
      mediaItemIds,
      sourceAssetIds,
      folderIds,
    );

    const itemsToMove = [
      ...mediaItemIds.map(id => ({id, type: 'media_item'})),
      ...sourceAssetIds.map(id => ({id, type: 'source_asset'})),
      ...folderIds.map(id => ({id, type: 'folder'})),
    ];

    this.isMoving = true;

    this.galleryService
      .bulkMove(itemsToMove, destinationWorkspaceId, conflictStrategy)
      .subscribe({
        next: res => {
          this.isMoving = false;
          if (res.failed.length > 0) {
            this.reportPartialWorkspaceMove(
              res,
              snapshot,
              itemsToMove.length,
              destinationName,
            );
            return;
          }
          // moved_count counts rows (a folder counts what it carried), so
          // the toast counts the requested items that moved instead.
          const moved = res.moved.length;
          this.snackBar.open(
            `${moved} item${moved === 1 ? '' : 's'} moved to "${destinationName}"`,
            'Close',
            {duration: 3000},
          );
          this.searchTerm();
          this.loadFolders();
        },
        error: err => {
          console.error('Error moving items to workspace:', err);
          this.restoreSnapshot(snapshot);
          this.isMoving = false;
          if (
            this.openConflictDialog(err, destinationName, true, choice =>
              this.executeMoveToWorkspace(
                mediaItemIds,
                sourceAssetIds,
                folderIds,
                destinationWorkspaceId,
                destinationName,
                choice,
              ),
            )
          ) {
            return;
          }
          this.reportFolderError(err, 'Failed to move items');
        },
      });
  }

  /**
   * A bulk move answers 200 even when some items stayed behind; failed[]
   * says which and why. Items that failed for any reason but NOT_FOUND are
   * put back on screen and left selected so the user can retry them.
   * searchTerm() is not called, because it would clear that selection.
   */
  private reportPartialWorkspaceMove(
    res: BulkMoveResponse,
    snapshot: {images: GalleryItem[]; folders: Folder[]},
    requested: number,
    destinationName: string,
  ): void {
    const gone = new Set([
      ...res.moved.map(item => `${item.type}:${item.id}`),
      ...res.failed
        .filter(item => item.reason === 'NOT_FOUND')
        .map(item => `${item.type}:${item.id}`),
    ]);
    this.images = snapshot.images.filter(
      img => !gone.has(`${img.itemType}:${img.id}`),
    );
    this.folders = snapshot.folders.filter(f => !gone.has(`folder:${f.id}`));
    this.selectedItems = new Set(
      res.failed
        .filter(item => item.type !== 'folder' && item.reason !== 'NOT_FOUND')
        .map(item => `${item.type}:${item.id}`),
    );
    this.lastSelectedIndex = null;
    this.updateGroups();
    this.loadFolders();

    const counts = new Map<BulkMoveFailureReason, number>();
    for (const item of res.failed) {
      counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
    }
    const reasons = Array.from(counts.entries())
      .map(
        ([reason, count]) =>
          `${count} ${BULK_MOVE_FAILURE_TEXT[reason] ?? reason}`,
      )
      .join(', ');
    this.snackBar.open(
      `${res.moved.length} of ${requested} moved to "${destinationName}"; ${res.failed.length} not moved (${reasons})`,
      'Close',
      {duration: 6000},
    );
  }
}
