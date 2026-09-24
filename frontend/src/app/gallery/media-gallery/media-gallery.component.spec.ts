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

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {CUSTOM_ELEMENTS_SCHEMA} from '@angular/core';
import {DomSanitizer} from '@angular/platform-browser';
import {MatSnackBar} from '@angular/material/snack-bar';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {
  ActivatedRoute,
  convertToParamMap,
  ParamMap,
  provideRouter,
  Router,
} from '@angular/router';
import {BehaviorSubject, Observable, of, throwError} from 'rxjs';
import {MediaGalleryComponent} from './media-gallery.component';
import {GalleryService} from '../gallery.service';
import {UserService} from '../../common/services/user.service';
import {WorkspaceStateService} from '../../services/workspace/workspace-state.service';
import {TagsService} from '../../common/services/tags.service';
import {FolderService} from '../../common/services/folder.service';
import {BulkMoveResponse, Folder} from '../../common/models/folder.model';
import {GallerySearchDto} from '../../common/models/search.model';
import {GalleryItem} from '../../common/models/gallery-item.model';
import {FolderConflictDialogComponent} from '../../common/components/folder-conflict-dialog/folder-conflict-dialog.component';
import {ConfirmationDialogComponent} from '../../common/components/confirmation-dialog/confirmation-dialog.component';

/** Reaches the component's private members without `any`. */
type Internals = {
  executeMove: (...args: unknown[]) => void;
  executeMoveToWorkspace: (...args: unknown[]) => void;
  executeCopy: (...args: unknown[]) => void;
  performCopy: (...args: unknown[]) => void;
  executeCopyFolderToWorkspace: (...args: unknown[]) => void;
};

const item = (id: number, itemType = 'media_item'): GalleryItem =>
  ({id, itemType, workspaceId: 1, createdAt: '', metadata: {}}) as GalleryItem;

const folder = (id: number, name = `Folder ${id}`): Folder => ({
  id,
  workspaceId: 1,
  userEmail: 'test@google.com',
  name,
  parentId: null,
  itemCount: 0,
  subfolderCount: 0,
});

const collision = {
  status: 409,
  error: {
    detail: {
      code: 'FOLDER_COLLISION',
      conflicts: [{folder_id: 10, folder_name: 'Campaigns'}],
    },
  },
};
const tooDeep = {
  status: 409,
  error: {detail: 'This folder hierarchy is nested too deeply.'},
};

const moveResponse = (overrides: Partial<BulkMoveResponse> = {}) => ({
  moved_count: 1,
  moved: [],
  failed: [],
  ...overrides,
});

describe('MediaGalleryComponent', () => {
  let component: MediaGalleryComponent;
  let fixture: ComponentFixture<MediaGalleryComponent>;
  let folderService: jasmine.SpyObj<FolderService>;
  let galleryService: GalleryService;
  let snackBar: {open: jasmine.Spy};
  let routerNavigate: jasmine.Spy;
  let paramMapSubject: BehaviorSubject<ParamMap>;
  let activeWorkspaceIdSubject: BehaviorSubject<number | null>;

  function lastFilters(): GallerySearchDto {
    const spy = galleryService.setFilters as jasmine.Spy;
    return spy.calls.mostRecent().args[0];
  }

  function stubDialog(result: unknown): jasmine.Spy {
    return spyOn(component.dialog, 'open').and.returnValue({
      afterClosed: () => of(result),
    } as ReturnType<typeof component.dialog.open>);
  }

  function internals(): Internals {
    return component as unknown as Internals;
  }

  beforeEach(async () => {
    paramMapSubject = new BehaviorSubject<ParamMap>(convertToParamMap({}));
    activeWorkspaceIdSubject = new BehaviorSubject<number | null>(1);
    folderService = jasmine.createSpyObj('FolderService', [
      'getFolders',
      'getBreadcrumbs',
      'getFolderById',
      'moveItems',
      'copyItems',
      'createFolder',
      'updateFolder',
      'deleteFolder',
    ]);
    Object.defineProperty(folderService, 'maxDepth', {value: 20});
    folderService.getFolders.and.returnValue(of([]));
    folderService.getBreadcrumbs.and.returnValue(of([]));
    folderService.getFolderById.and.returnValue(of({} as Folder));
    folderService.moveItems.and.returnValue(
      of({
        total_moved: 1,
        media_items_moved: 1,
        source_assets_moved: 0,
        folders_moved: 0,
      }),
    );
    folderService.copyItems.and.returnValue(
      of({
        total_copied: 1,
        media_items_copied: 1,
        source_assets_copied: 0,
        folders_copied: 0,
      }),
    );
    snackBar = {open: jasmine.createSpy('open')};

    await TestBed.configureTestingModule({
      declarations: [MediaGalleryComponent],
      imports: [NoopAnimationsModule],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {provide: FolderService, useValue: folderService},
        {provide: MatSnackBar, useValue: snackBar},
        {
          provide: GalleryService,
          useValue: {
            isLoading$: of(false),
            images$: of([]),
            allImagesLoaded: of(true),
            filtersState: null,
            setFiltersState: () => {},
            setFilters: jasmine.createSpy('setFilters'),
            loadGallery: jasmine.createSpy('loadGallery'),
            bulkDelete: () => of({deleted_count: 1}),
            bulkDownload: () => of(new Blob()),
            bulkCopy: () => of({copied_count: 1}),
            bulkMove: () => of(moveResponse()),
          },
        },
        {
          provide: DomSanitizer,
          useValue: {
            bypassSecurityTrustResourceUrl: (url: string) => url,
            bypassSecurityTrustUrl: (url: string) => url,
            sanitize: (context: unknown, value: unknown) => value,
          },
        },
        {
          provide: UserService,
          useValue: {
            getUserDetails: () => ({
              email: 'test@google.com',
              roles: ['ADMIN'],
            }),
          },
        },
        {
          provide: WorkspaceStateService,
          useValue: {
            activeWorkspaceId$: activeWorkspaceIdSubject.asObservable(),
            getActiveWorkspaceId: () => activeWorkspaceIdSubject.value,
            setActiveWorkspaceId: (id: number | null) =>
              activeWorkspaceIdSubject.next(id),
          },
        },
        {
          provide: ActivatedRoute,
          useValue: {paramMap: paramMapSubject.asObservable()},
        },
        {
          provide: TagsService,
          useValue: {
            getTags: () => of({data: []}),
            deleteTag: () => of(null),
            bulkAssign: () => of(null),
          },
        },
      ],
    }).compileComponents();

    routerNavigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(
      true,
    );
    galleryService = TestBed.inject(GalleryService);
    localStorage.setItem('gallery_features_hint_seen', 'true');
    fixture = TestBed.createComponent(MediaGalleryComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  describe('ngOnInit filters restoration', () => {
    it('restores every stored filter, favoritesOnly included', () => {
      (galleryService as unknown as {filtersState: unknown}).filtersState = {
        query: 'test query',
        mimeType: 'image/*',
        model: 'test-model',
        itemType: 'media_item',
        tags: ['tag1', 'tag2'],
        onlyMyMedia: true,
        favoritesOnly: true,
        startDate: new Date('2026-01-01T00:00:00.000Z'),
        endDate: new Date('2026-01-02T00:00:00.000Z'),
      };

      component.ngOnInit();

      expect(component.queryFilter).toBe('test query');
      expect(component.mediaTypeFilter).toBe('image/*');
      expect(component.generationModelFilter).toBe('test-model');
      expect(component.assetTypeFilter).toBe('media_item');
      expect(component.tagsFilter).toEqual(['tag1', 'tag2']);
      expect(component.onlyMyMedia).toBeTrue();
      expect(component.favoritesOnly).toBeTrue();
      expect(component.startDateFilter).toEqual(
        new Date('2026-01-01T00:00:00.000Z'),
      );
      expect(component.endDateFilter).toEqual(
        new Date('2026-01-02T00:00:00.000Z'),
      );
    });

    it('defaults favoritesOnly to false for state saved before the flag existed', () => {
      component.favoritesOnly = true;
      (galleryService as unknown as {filtersState: unknown}).filtersState = {
        query: '',
        mimeType: '',
        model: '',
        itemType: '',
        tags: [],
        onlyMyMedia: false,
        startDate: null,
        endDate: null,
      };

      component.ngOnInit();

      expect(component.favoritesOnly).toBeFalse();
    });
  });

  describe('search filters', () => {
    it('treats only a bare, whole email address as an email lookup', () => {
      const cases: Array<[string, Partial<GallerySearchDto>]> = [
        ['cat @ the beach', {query: 'cat @ the beach'}],
        ['a@b.co', {userEmail: 'a@b.co'}],
      ];
      for (const [term, expected] of cases) {
        component.queryFilter = term;
        component.searchTerm();
        const filters = lastFilters();
        expect(filters.query).withContext(term).toBe(expected.query);
        expect(filters.userEmail).withContext(term).toBe(expected.userEmail);
      }
    });

    it('sends the fork-only "Only my media" and "Favorites only" filters', () => {
      component.toggleOnlyMyMedia(true);
      expect(lastFilters().userEmail).toBe('test@google.com');

      component.toggleOnlyMyMedia(false);
      component.toggleFavoritesOnly(true);
      expect(lastFilters().favoritesOnly).toBeTrue();
      expect(lastFilters().userEmail).toBeUndefined();
    });

    // Owner decisions 1 and 2, and upstream's search rule.
    it('scopes items to the folder, the root, or every folder', () => {
      const cases: Array<{
        name: string;
        folderId: number | null;
        query?: string;
        favoritesOnly?: boolean;
        onlyMyMedia?: boolean;
        filterByUserEmail?: string;
        expected: {folderId?: number; isRoot?: boolean};
      }> = [
        {name: 'root', folderId: null, expected: {isRoot: true}},
        {name: 'folder', folderId: 42, expected: {folderId: 42}},
        {
          name: 'root, favorites',
          folderId: null,
          favoritesOnly: true,
          expected: {},
        },
        {
          name: 'root, only my media',
          folderId: null,
          onlyMyMedia: true,
          expected: {},
        },
        {
          name: 'folder, favorites',
          folderId: 42,
          favoritesOnly: true,
          expected: {folderId: 42},
        },
        {
          name: 'root, my uploads',
          folderId: null,
          filterByUserEmail: 'test@google.com',
          expected: {},
        },
        {
          name: 'folder, my uploads',
          folderId: 42,
          filterByUserEmail: 'test@google.com',
          expected: {folderId: 42},
        },
        {name: 'root, search', folderId: null, query: 'cat', expected: {}},
        {name: 'folder, search', folderId: 42, query: 'cat', expected: {}},
      ];
      for (const c of cases) {
        component.currentFolderId = c.folderId;
        component.queryFilter = c.query ?? '';
        component.favoritesOnly = c.favoritesOnly ?? false;
        component.onlyMyMedia = c.onlyMyMedia ?? false;
        component.filterByUserEmail = c.filterByUserEmail ?? null;
        component.searchTerm();
        const filters = lastFilters();
        expect(filters.folderId).withContext(c.name).toBe(c.expected.folderId);
        expect(filters.isRoot).withContext(c.name).toBe(c.expected.isRoot);
      }
    });
  });

  describe('folder grid', () => {
    const folderCards = () =>
      fixture.nativeElement.querySelectorAll('app-folder-card').length;

    // Owner decision 5: upstream hid the grid on every scroll page load.
    it('stays rendered while a page of items is loading', () => {
      component.folders = [folder(1), folder(2)];
      component.isLoading = true;
      fixture.detectChanges();
      expect(folderCards()).toBe(2);
    });

    // Owner decision 1: folders cannot be favorited or owned.
    it('is hidden at the root, but not in a folder, while a cross-folder filter is on', () => {
      component.folders = [folder(1)];
      const cases: Array<
        [number | null, 'favoritesOnly' | 'onlyMyMedia', number]
      > = [
        [null, 'favoritesOnly', 0],
        [null, 'onlyMyMedia', 0],
        [42, 'favoritesOnly', 1],
      ];
      for (const [folderId, flag, expected] of cases) {
        component.currentFolderId = folderId;
        component.favoritesOnly = flag === 'favoritesOnly';
        component.onlyMyMedia = flag === 'onlyMyMedia';
        fixture.detectChanges();
        expect(folderCards()).withContext(`${folderId} ${flag}`).toBe(expected);
      }
    });
  });

  describe('infinite scroll', () => {
    let observerCallback: IntersectionObserverCallback;
    let observed: Element[];
    let disconnect: jasmine.Spy;
    let original: typeof IntersectionObserver;

    beforeEach(() => {
      observed = [];
      disconnect = jasmine.createSpy('disconnect');
      original = window.IntersectionObserver;
      window.IntersectionObserver = class {
        constructor(cb: IntersectionObserverCallback) {
          observerCallback = cb;
        }
        observe(el: Element) {
          observed.push(el);
        }
        disconnect() {
          disconnect();
        }
      } as unknown as typeof IntersectionObserver;
    });

    afterEach(() => {
      window.IntersectionObserver = original;
    });

    it('loads the next page when the sentinel scrolls into view, and disconnects on destroy', () => {
      const scrollFixture = TestBed.createComponent(MediaGalleryComponent);
      scrollFixture.componentInstance.allImagesLoaded = false;
      scrollFixture.detectChanges();
      const comp = scrollFixture.componentInstance;
      comp.allImagesLoaded = false;
      comp.isLoading = false;

      expect(observed).toEqual([comp.scrollSentinel!.nativeElement]);
      const loadGallery = galleryService.loadGallery as jasmine.Spy;
      loadGallery.calls.reset();

      observerCallback(
        [{isIntersecting: true} as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
      expect(loadGallery).toHaveBeenCalledTimes(1);

      scrollFixture.destroy();
      expect(disconnect).toHaveBeenCalled();
    });
  });

  // Owner decision 3: folders are browsable in the image selector, but not
  // managed there.
  describe('selector mode', () => {
    let selFixture: ComponentFixture<MediaGalleryComponent>;
    let sel: MediaGalleryComponent;

    function render(isSelectorMode: boolean) {
      selFixture = TestBed.createComponent(MediaGalleryComponent);
      sel = selFixture.componentInstance;
      sel.isSelectorMode = isSelectorMode;
      sel.isSelectionMode = isSelectorMode;
      sel.showFiltersInSelector = true;
      selFixture.detectChanges();
      sel.selectedItems.add('media_item:1');
      selFixture.detectChanges();
    }

    const buttonTitles = () =>
      Array.from(
        selFixture.nativeElement.querySelectorAll('studio-button') as NodeList,
      ).map(el => (el as HTMLElement).getAttribute('title'));

    it('hides New Folder and Move, which normal mode shows', () => {
      render(false);
      expect(buttonTitles()).toContain('Create a new folder');
      expect(buttonTitles()).toContain('Move selected');

      render(true);
      expect(buttonTitles()).not.toContain('Create a new folder');
      expect(buttonTitles()).not.toContain('Move selected');
    });

    it('loads folders and browses into them in place, without the router', () => {
      folderService.getFolders.calls.reset();
      render(true);
      expect(folderService.getFolders).toHaveBeenCalledWith(1, null);

      routerNavigate.calls.reset();
      sel.navigateToFolder(folder(15));
      expect(routerNavigate).not.toHaveBeenCalled();
      expect(sel.currentFolderId).toBe(15);
      expect(folderService.getFolders).toHaveBeenCalledWith(1, 15);
    });

    it('ignores drops on folders and breadcrumbs', () => {
      render(true);
      const payload = {mediaItemIds: [1], sourceAssetIds: [], itemCount: 1};
      sel.onItemDroppedOnFolder(folder(5), payload);
      sel.currentFolderId = 5;
      sel.onBreadcrumbDrop(
        {
          preventDefault: () => {},
          dataTransfer: {getData: () => JSON.stringify(payload)},
        } as unknown as DragEvent,
        null,
      );
      expect(folderService.moveItems).not.toHaveBeenCalled();
    });
  });

  describe('drag and drop', () => {
    it('moves dropped items into a folder card and takes them off the view', () => {
      folderService.moveItems.and.returnValue(
        of({
          total_moved: 3,
          media_items_moved: 2,
          source_assets_moved: 1,
          folders_moved: 0,
        }),
      );
      component.images = [item(101), item(102), item(999)];
      component.onItemDroppedOnFolder(folder(5, 'Target'), {
        mediaItemIds: [101, 102],
        sourceAssetIds: [201],
        itemCount: 3,
      });

      expect(folderService.moveItems).toHaveBeenCalledWith(
        jasmine.objectContaining({
          workspaceId: 1,
          mediaItemIds: [101, 102],
          sourceAssetIds: [201],
          folderIds: [],
          destinationFolderId: 5,
        }),
      );
      expect(component.images.map(i => i.id)).toEqual([999]);
    });

    it('moves items dropped on the root breadcrumb to the root', () => {
      component.currentFolderId = 5;
      const payload = {mediaItemIds: [101], sourceAssetIds: [], itemCount: 1};
      component.onBreadcrumbDrop(
        {
          preventDefault: () => {},
          dataTransfer: {
            getData: (type: string) =>
              type === 'application/json' ? JSON.stringify(payload) : '',
          },
        } as unknown as DragEvent,
        null,
      );

      expect(folderService.moveItems).toHaveBeenCalledWith(
        jasmine.objectContaining({
          mediaItemIds: [101],
          destinationFolderId: null,
        }),
      );
    });
  });

  describe('dialog results', () => {
    // Replaces the retired copy-to-workspace dialog: each dialog's folder or
    // workspace result must reach the matching backend call.
    it('routes each move and copy dialog result to the right request', () => {
      const bulkMove = spyOn(galleryService, 'bulkMove').and.returnValue(
        of(moveResponse({moved: [{id: 10, type: 'folder'}]})),
      );
      const bulkCopy = spyOn(galleryService, 'bulkCopy').and.returnValue(
        of({copied_count: 1}),
      );
      const toWorkspace = {destinationWorkspaceId: 88, destinationName: 'WS'};
      const toFolder = {destinationFolderId: 25, destinationName: 'Sub'};
      const cases: Array<{
        name: string;
        open: () => void;
        result: object;
        expect: () => void;
      }> = [
        {
          name: 'move folder to workspace',
          open: () => component.openMoveFolderDialog(folder(10)),
          result: toWorkspace,
          expect: () =>
            expect(bulkMove).toHaveBeenCalledWith(
              [{id: 10, type: 'folder'}],
              88,
              undefined,
            ),
        },
        {
          name: 'move selection to folder',
          open: () => component.openBatchMoveDialog(),
          result: toFolder,
          expect: () =>
            expect(folderService.moveItems).toHaveBeenCalledWith(
              jasmine.objectContaining({
                mediaItemIds: [101],
                sourceAssetIds: [202],
                destinationFolderId: 25,
              }),
            ),
        },
        {
          name: 'copy folder to workspace',
          open: () => component.openCopyFolderDialog(folder(10)),
          result: toWorkspace,
          expect: () =>
            expect(bulkCopy).toHaveBeenCalledWith(
              [{id: 10, type: 'folder'}],
              88,
              null,
            ),
        },
        {
          name: 'copy folder to folder',
          open: () => component.openCopyFolderDialog(folder(10)),
          result: toFolder,
          expect: () =>
            expect(folderService.copyItems).toHaveBeenCalledWith(
              jasmine.objectContaining({
                folderIds: [10],
                destinationFolderId: 25,
              }),
            ),
        },
        {
          name: 'copy selection to folder',
          open: () => component.copySelected(),
          result: toFolder,
          expect: () =>
            expect(folderService.copyItems).toHaveBeenCalledWith(
              jasmine.objectContaining({
                mediaItemIds: [101],
                sourceAssetIds: [202],
                folderIds: [],
                destinationFolderId: 25,
              }),
            ),
        },
        {
          name: 'copy selection to workspace',
          open: () => component.copySelected(),
          result: toWorkspace,
          expect: () =>
            expect(bulkCopy).toHaveBeenCalledWith(
              [
                {id: 101, type: 'media_item'},
                {id: 202, type: 'source_asset'},
              ],
              88,
              null,
            ),
        },
      ];
      const open = stubDialog(null);
      for (const c of cases) {
        component.selectedItems = new Set([
          'media_item:101',
          'source_asset:202',
        ]);
        open.and.returnValue({
          afterClosed: () => of(c.result),
        } as ReturnType<typeof component.dialog.open>);
        c.open();
        c.expect();
      }
    });

    // Owner decision 4.
    it('warns that deleting a folder trashes its media and only an admin can restore it', () => {
      const open = stubDialog(false);
      component.openDeleteFolderDialog(folder(3, 'Campaigns'));

      expect(open).toHaveBeenCalledWith(
        ConfirmationDialogComponent,
        jasmine.anything(),
      );
      const message: string = open.calls.mostRecent().args[1].data.message;
      expect(message).toContain('"Campaigns"');
      expect(message).toContain('all the media in them will be moved to trash');
      expect(message).toContain('Only an admin can restore');
      expect(folderService.deleteFolder).not.toHaveBeenCalled();
    });

    it('says a folder was already deleted when the backend reports no change', () => {
      stubDialog(true);
      folderService.deleteFolder.and.returnValue(of({success: false}));
      component.openDeleteFolderDialog(folder(3, 'Campaigns'));

      expect(snackBar.open).toHaveBeenCalledWith(
        'Folder "Campaigns" was already deleted',
        'Close',
        jasmine.anything(),
      );
    });
  });

  describe('move outcomes', () => {
    it('reports a partial workspace move from failed[] and keeps the failures on screen', () => {
      spyOn(component, 'searchTerm');
      spyOn(galleryService, 'bulkMove').and.returnValue(
        of(
          moveResponse({
            moved_count: 1,
            moved: [{id: 1, type: 'media_item'}],
            failed: [
              {id: 2, type: 'media_item', reason: 'NOT_FOUND'},
              {id: 3, type: 'source_asset', reason: 'ALREADY_IN_TARGET'},
            ],
          }),
        ),
      );
      component.images = [item(1), item(2), item(3, 'source_asset'), item(4)];

      internals().executeMoveToWorkspace([1, 2], [3], [], 88, 'Other');

      expect(component.images.map(i => `${i.itemType}:${i.id}`)).toEqual([
        'source_asset:3',
        'media_item:4',
      ]);
      expect(Array.from(component.selectedItems)).toEqual(['source_asset:3']);
      expect(component.searchTerm).not.toHaveBeenCalled();
      expect(snackBar.open).toHaveBeenCalledWith(
        '1 of 3 moved to "Other"; 2 not moved (1 no longer exists, 1 already in that workspace)',
        'Close',
        jasmine.anything(),
      );
    });

    it('counts requested items, not moved rows, after a full workspace move', () => {
      spyOn(galleryService, 'bulkMove').and.returnValue(
        of(moveResponse({moved_count: 7, moved: [{id: 10, type: 'folder'}]})),
      );
      component.folders = [folder(10), folder(20)];

      internals().executeMoveToWorkspace([], [], [10], 88, 'Other');

      expect(snackBar.open).toHaveBeenCalledWith(
        '1 item moved to "Other"',
        'Close',
        jasmine.anything(),
      );
    });

    it('says when the backend skipped some items of a folder move', () => {
      spyOn(component, 'searchTerm');
      folderService.moveItems.and.returnValue(
        of({
          total_moved: 1,
          media_items_moved: 1,
          source_assets_moved: 0,
          folders_moved: 0,
        }),
      );

      internals().executeMove([1, 2], [], [], 5, 'Dest');

      expect(snackBar.open).toHaveBeenCalledWith(
        '1 of 2 items moved to "Dest"; the rest were moved or deleted elsewhere',
        'Close',
        jasmine.anything(),
      );
      expect(component.searchTerm).toHaveBeenCalled();
    });

    it('does not quote a row count when a copy included folders, and reports a short one otherwise', () => {
      folderService.copyItems.and.returnValue(
        of({
          total_copied: 12,
          media_items_copied: 11,
          source_assets_copied: 0,
          folders_copied: 1,
        }),
      );
      internals().executeCopy([], [], [10], 5, 'Dest');
      expect(snackBar.open).toHaveBeenCalledWith(
        'Copied to "Dest"',
        'Close',
        jasmine.anything(),
      );

      spyOn(galleryService, 'bulkCopy').and.returnValue(of({copied_count: 1}));
      internals().performCopy(
        [
          {id: 1, type: 'media_item'},
          {id: 2, type: 'media_item'},
        ],
        88,
        null,
        'Other',
      );
      expect(snackBar.open).toHaveBeenCalledWith(
        '1 of 2 items copied to "Other"; some items no longer exist',
        'Close',
        jasmine.anything(),
      );
    });
  });

  describe('conflicts and errors', () => {
    let bulkMove: jasmine.Spy;
    let bulkCopy: jasmine.Spy;

    beforeEach(() => {
      bulkMove = spyOn(galleryService, 'bulkMove');
      bulkCopy = spyOn(galleryService, 'bulkCopy');
    });

    type Site = {
      name: string;
      isMove: boolean;
      spy: () => jasmine.Spy;
      ok: unknown;
      run: () => void;
      strategyOf: (args: unknown[]) => unknown;
    };

    const dtoStrategy = (args: unknown[]) =>
      (args[0] as {conflictStrategy?: unknown}).conflictStrategy;
    const thirdArg = (args: unknown[]) => args[2];

    const sites = (): Site[] => [
      {
        name: 'executeMove',
        isMove: true,
        spy: () => folderService.moveItems,
        ok: {
          total_moved: 1,
          media_items_moved: 0,
          source_assets_moved: 0,
          folders_moved: 1,
        },
        run: () => internals().executeMove([], [], [10], 5, 'Dest'),
        strategyOf: dtoStrategy,
      },
      {
        name: 'executeCopy',
        isMove: false,
        spy: () => folderService.copyItems,
        ok: {
          total_copied: 1,
          media_items_copied: 0,
          source_assets_copied: 0,
          folders_copied: 1,
        },
        run: () => internals().executeCopy([], [], [10], 5, 'Dest'),
        strategyOf: dtoStrategy,
      },
      {
        name: 'executeMoveToWorkspace',
        isMove: true,
        spy: () => bulkMove,
        ok: moveResponse({moved: [{id: 10, type: 'folder'}]}),
        run: () => internals().executeMoveToWorkspace([], [], [10], 88, 'Dest'),
        strategyOf: thirdArg,
      },
      {
        name: 'performCopy',
        isMove: false,
        spy: () => bulkCopy,
        ok: {copied_count: 1},
        run: () =>
          internals().performCopy(
            [{id: 1, type: 'media_item'}],
            88,
            null,
            'Dest',
          ),
        strategyOf: thirdArg,
      },
      {
        name: 'executeCopyFolderToWorkspace',
        isMove: false,
        spy: () => bulkCopy,
        ok: {copied_count: 1},
        run: () =>
          internals().executeCopyFolderToWorkspace(
            folder(10),
            88,
            null,
            'Dest',
          ),
        strategyOf: thirdArg,
      },
    ];

    it('opens the conflict dialog for a FOLDER_COLLISION 409 and retries with the choice', () => {
      const open = stubDialog('merge');
      for (const site of sites()) {
        const spy = site.spy();
        spy.calls.reset();
        spy.and.returnValues(
          throwError(() => collision),
          of(site.ok),
        );
        open.calls.reset();

        site.run();

        expect(open)
          .withContext(site.name)
          .toHaveBeenCalledWith(
            FolderConflictDialogComponent,
            jasmine.objectContaining({
              data: {
                folderNames: ['Campaigns'],
                destinationName: 'Dest',
                isMove: site.isMove,
              },
            }),
          );
        expect(spy).withContext(site.name).toHaveBeenCalledTimes(2);
        expect(site.strategyOf(spy.calls.argsFor(1)))
          .withContext(site.name)
          .toBe('merge');
      }
    });

    it('shows a string-detail 409 without the conflict dialog or a retry', () => {
      const open = stubDialog('merge');
      for (const site of sites()) {
        const spy = site.spy();
        spy.calls.reset();
        spy.and.returnValue(throwError(() => tooDeep));
        open.calls.reset();
        snackBar.open.calls.reset();

        site.run();

        expect(open).withContext(site.name).not.toHaveBeenCalled();
        expect(spy).withContext(site.name).toHaveBeenCalledTimes(1);
        expect(snackBar.open)
          .withContext(site.name)
          .toHaveBeenCalledWith(
            'This folder hierarchy is nested too deeply.',
            'Close',
            jasmine.anything(),
          );
      }
    });

    it('does not retry when the conflict dialog is stopped, and keeps the rollback', () => {
      stubDialog('stop');
      folderService.moveItems.and.returnValue(throwError(() => collision));
      component.folders = [folder(10)];

      internals().executeMove([], [], [10], 5, 'Dest');

      expect(folderService.moveItems).toHaveBeenCalledTimes(1);
      expect(component.folders.map(f => f.id)).toEqual([10]);
    });

    it('rolls back and refreshes the view after a 404 or 400 from a request that waited', () => {
      const cases: Array<[number, string, string]> = [
        [
          404,
          'Destination folder not found.',
          'Destination folder not found. It may have been moved or deleted. Refresh and try again.',
        ],
        [
          400,
          'That move would create a cycle.',
          'That move would create a cycle.',
        ],
      ];
      for (const [status, detail, shown] of cases) {
        folderService.moveItems.and.returnValue(
          throwError(() => ({status, error: {detail}})),
        );
        component.currentFolderId = 7;
        component.images = [item(1), item(2)];
        component.selectedItems = new Set(['media_item:1']);
        folderService.getFolders.calls.reset();
        folderService.getBreadcrumbs.calls.reset();
        (galleryService.setFilters as jasmine.Spy).calls.reset();

        internals().executeMove([1], [], [], 5, 'Dest');

        expect(snackBar.open)
          .withContext(`${status}`)
          .toHaveBeenCalledWith(shown, 'Close', jasmine.anything());
        expect(folderService.getFolders)
          .withContext(`${status}`)
          .toHaveBeenCalled();
        expect(folderService.getBreadcrumbs)
          .withContext(`${status}`)
          .toHaveBeenCalledWith(7, 1);
        expect(galleryService.setFilters)
          .withContext(`${status}`)
          .toHaveBeenCalled();
      }
    });

    it('rolls back items, folders and selection when a move fails', () => {
      folderService.moveItems.and.returnValue(
        throwError(() => new Error('Move failed')),
      );
      component.images = [item(1), item(2, 'source_asset')];
      component.folders = [folder(10)];
      component.selectedItems = new Set(['media_item:1', 'source_asset:2']);

      internals().executeMove([1], [2], [10], 5, 'Dest');

      expect(component.images.length).toBe(2);
      expect(component.folders.length).toBe(1);
      expect(Array.from(component.selectedItems)).toEqual([
        'media_item:1',
        'source_asset:2',
      ]);
      expect(component.isMoving).toBeFalse();
      expect(snackBar.open).toHaveBeenCalledWith(
        'Failed to move items',
        'Close',
        jasmine.anything(),
      );
    });

    it('retries a copy with the selection captured when the user asked', () => {
      bulkCopy.and.returnValues(
        throwError(() => collision),
        of({copied_count: 1}),
      );
      component.selectedItems = new Set(['media_item:101']);
      spyOn(component.dialog, 'open').and.callFake(((dialog: unknown) => {
        if (dialog === FolderConflictDialogComponent) {
          component.selectedItems = new Set(['media_item:999']);
          return {afterClosed: () => of('merge')};
        }
        return {
          afterClosed: () =>
            of({destinationWorkspaceId: 88, destinationName: 'Other'}),
        };
      }) as unknown as typeof component.dialog.open);

      component.copySelected();

      expect(bulkCopy.calls.argsFor(1)).toEqual([
        [{id: 101, type: 'media_item'}],
        88,
        'merge',
      ]);
    });
  });

  describe('route-driven folder navigation', () => {
    it('loads the folder named in the route without leaving it', () => {
      folderService.getFolders.calls.reset();
      routerNavigate.calls.reset();

      paramMapSubject.next(convertToParamMap({folderId: '42'}));

      expect(component.currentFolderId).toBe(42);
      expect(folderService.getFolders).toHaveBeenCalledWith(1, 42);
      expect(folderService.getBreadcrumbs).toHaveBeenCalledWith(42, 1);
      expect(lastFilters().folderId).toBe(42);
      expect(routerNavigate).not.toHaveBeenCalled();
    });

    it('redirects a folder id that is not a positive integer to /gallery', () => {
      for (const bad of ['abc', '-5', '0', '1.5']) {
        routerNavigate.calls.reset();
        folderService.getFolders.calls.reset();
        paramMapSubject.next(convertToParamMap({folderId: bad}));
        expect(component.currentFolderId).withContext(bad).toBeNull();
        expect(routerNavigate)
          .withContext(bad)
          .toHaveBeenCalledWith(['/gallery']);
        expect(folderService.getFolders)
          .withContext(bad)
          .not.toHaveBeenCalled();
      }
    });

    it('navigates folder cards and breadcrumbs through the router', () => {
      component.navigateToFolder(folder(15));
      expect(routerNavigate).toHaveBeenCalledWith(['/folders', 15]);
      component.navigateToBreadcrumb({id: 7, name: 'Crumb'});
      expect(routerNavigate).toHaveBeenCalledWith(['/folders', 7]);
      component.navigateToBreadcrumb(null);
      expect(routerNavigate).toHaveBeenCalledWith(['/gallery']);
    });

    it("switches to the folder's workspace when a deep link points at another one", () => {
      component.currentFolderId = 5;
      folderService.getBreadcrumbs.and.callFake((id: number, wsId?: number) =>
        wsId === 2
          ? of([{id: 5, name: 'Folder 5', parentId: null}])
          : throwError(() => ({status: 404})),
      );
      folderService.getFolderById.and.returnValue(
        of({...folder(5), workspaceId: 2}),
      );
      routerNavigate.calls.reset();

      component.loadBreadcrumbs();

      expect(folderService.getFolderById).toHaveBeenCalledWith(5);
      expect(activeWorkspaceIdSubject.value).toBe(2);
      expect(routerNavigate).not.toHaveBeenCalled();
    });

    it('leaves a folder it cannot load, saying why', () => {
      const cases: Array<{
        name: string;
        breadcrumbErr: object;
        folderById?: Observable<Folder>;
        message: string;
      }> = [
        {
          name: 'breadcrumb detail',
          breadcrumbErr: {status: 500, error: {detail: 'Broken.'}},
          message: 'Broken.',
        },
        {
          name: 'no detail',
          breadcrumbErr: new Error('Network'),
          message: 'Folder not found in this workspace.',
        },
        {
          name: 'no access',
          breadcrumbErr: {status: 404},
          folderById: throwError(() => ({status: 403})),
          message: 'You do not have permission to access this folder.',
        },
        {
          name: 'missing',
          breadcrumbErr: {status: 404},
          folderById: throwError(() => ({
            status: 404,
            error: {detail: 'Folder with ID 5 not found.'},
          })),
          message: 'Folder with ID 5 not found.',
        },
        {
          name: 'same workspace',
          breadcrumbErr: {status: 404},
          folderById: of(folder(5)),
          message: 'Folder not found in this workspace.',
        },
      ];
      for (const c of cases) {
        component.currentFolderId = 5;
        folderService.getBreadcrumbs.and.returnValue(
          throwError(() => c.breadcrumbErr),
        );
        if (c.folderById) {
          folderService.getFolderById.and.returnValue(c.folderById);
        }
        routerNavigate.calls.reset();

        component.loadBreadcrumbs();

        expect(snackBar.open)
          .withContext(c.name)
          .toHaveBeenCalledWith(c.message, 'Close', {duration: 3000});
        expect(routerNavigate)
          .withContext(c.name)
          .toHaveBeenCalledWith(['/gallery']);
      }
    });

    it('returns to /gallery when the workspace changes inside a folder', () => {
      component.currentFolderId = 5;
      activeWorkspaceIdSubject.next(2);
      expect(routerNavigate).toHaveBeenCalledWith(['/gallery']);
    });
  });
});
