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
import {provideRouter, Router} from '@angular/router';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {MatDialogModule} from '@angular/material/dialog';
import {MatSnackBar, MatSnackBarModule} from '@angular/material/snack-bar';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {MatMenuModule} from '@angular/material/menu';
import {MatTooltipModule} from '@angular/material/tooltip';
import {CUSTOM_ELEMENTS_SCHEMA, Injector} from '@angular/core';
import {NgOptimizedImage} from '@angular/common';

import {of, throwError} from 'rxjs';

import {MediaLightboxComponent} from './media-lightbox.component';
import {TagsService} from '../../services/tags.service';
import {WorkspaceStateService} from '../../../services/workspace/workspace-state.service';
import {GalleryService} from '../../../gallery/gallery.service';
import {MediaItem} from '../../models/media-item.model';
import {FolderService} from '../../services/folder.service';
import {BulkMoveResponse, MoveItemsResponse} from '../../models/folder.model';
import {
  MoveToFolderDialogComponent,
  MoveToFolderDialogResult,
} from '../move-to-folder-dialog/move-to-folder-dialog.component';
import {NotificationService} from '../../services/notification.service';
import {AppInjector, setAppInjector} from '../../../app-injector';

describe('MediaLightboxComponent', () => {
  let component: MediaLightboxComponent;
  let fixture: ComponentFixture<MediaLightboxComponent>;
  let galleryService: jasmine.SpyObj<
    Pick<GalleryService, 'favorite' | 'unfavorite' | 'bulkMove'>
  >;
  let folderService: jasmine.SpyObj<Pick<FolderService, 'moveItems'>>;

  beforeEach(async () => {
    galleryService = jasmine.createSpyObj('GalleryService', [
      'favorite',
      'unfavorite',
      'bulkMove',
    ]);
    folderService = jasmine.createSpyObj('FolderService', ['moveItems']);

    await TestBed.configureTestingModule({
      declarations: [MediaLightboxComponent],
      imports: [
        MatDialogModule,
        MatSnackBarModule,
        NoopAnimationsModule,
        // The action toolbar uses a mat-menu and tooltips.
        MatMenuModule,
        MatTooltipModule,
        // The image viewer renders through ngSrc once an item is set.
        NgOptimizedImage,
      ],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: TagsService,
          useValue: {},
        },
        {
          provide: WorkspaceStateService,
          useValue: {
            getActiveWorkspaceId: () => 1,
          },
        },
        {provide: GalleryService, useValue: galleryService},
        {provide: FolderService, useValue: folderService},
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(MediaLightboxComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('favorite toggle', () => {
    beforeEach(() => {
      component.mediaItem = {id: 42, isFavorite: false} as MediaItem;
    });

    // Same shipped bug as the gallery card: the response used to overwrite
    // the optimistic flip with undefined and the heart went dark.
    it('leaves the heart lit after a successful favorite', () => {
      galleryService.favorite.and.returnValue(of(true));

      component.toggleFavorite();

      expect(galleryService.favorite).toHaveBeenCalledWith(42);
      expect(component.isFavorite).toBeTrue();
      expect(component.isFavoriteUpdating).toBeFalse();
    });

    it('leaves the heart unlit after a successful unfavorite', () => {
      component.mediaItem!.isFavorite = true;
      galleryService.unfavorite.and.returnValue(of(false));

      component.toggleFavorite();

      expect(galleryService.unfavorite).toHaveBeenCalledWith(42);
      expect(component.isFavorite).toBeFalse();
    });

    it('reverts the optimistic flip when the request fails', () => {
      galleryService.favorite.and.returnValue(
        throwError(() => new Error('boom')),
      );

      component.toggleFavorite();

      expect(component.isFavorite).toBeFalse();
      expect(component.isFavoriteUpdating).toBeFalse();
    });
  });

  describe('move to folder', () => {
    let dialogOpen: jasmine.Spy;
    let toast: jasmine.Spy;
    let navigate: jasmine.Spy;

    const moved = (total: number): MoveItemsResponse => ({
      media_items_moved: total,
      source_assets_moved: 0,
      folders_moved: 0,
      total_moved: total,
    });

    const closeWith = (result: MoveToFolderDialogResult | undefined) =>
      dialogOpen.and.returnValue({afterClosed: () => of(result)});

    const lastToast = () => toast.calls.mostRecent().args[0] as string;

    beforeEach(() => {
      component.mediaItem = {id: 42, isFavorite: false} as MediaItem;
      dialogOpen = spyOn(component.dialog, 'open');
      closeWith(undefined);
      toast = spyOn(TestBed.inject(MatSnackBar), 'open');
      navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    });

    const renderedMoveButton = (): Element | undefined =>
      Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('mat-icon'),
      ).find(icon => icon.textContent?.trim() === 'drive_file_move');

    it('hides the move button unless asked for', () => {
      // The action toolbar only renders for an item with at least one url.
      component.mediaItem!.presignedUrls = [
        'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      ];
      fixture.detectChanges();
      expect(renderedMoveButton()).toBeUndefined();

      fixture.componentRef.setInput('showMoveButton', true);
      fixture.detectChanges();
      expect(renderedMoveButton()).toBeDefined();
    });

    // The dialog marks the root as the current location only for null, and
    // an item at the root carries no folderId at all.
    it('passes the item folder, or null at the root, as the current folder', () => {
      for (const [folderId, currentFolderId] of [
        [undefined, null],
        [7, 7],
      ] as const) {
        component.mediaItem!.folderId = folderId;

        component.openBatchMoveDialog();

        expect(dialogOpen.calls.mostRecent().args).toEqual([
          MoveToFolderDialogComponent,
          {data: {workspaceId: 1, itemCount: 1, currentFolderId}},
        ]);
      }
    });

    it('moves into the chosen folder and names it in the toast', () => {
      folderService.moveItems.and.returnValue(of(moved(1)));
      closeWith({destinationFolderId: 5, destinationName: 'Holiday'});

      component.openBatchMoveDialog();

      expect(folderService.moveItems).toHaveBeenCalledWith({
        workspaceId: 1,
        mediaItemIds: [42],
        sourceAssetIds: [],
        folderIds: [],
        destinationFolderId: 5,
      });
      expect(lastToast()).toBe('Moved to "Holiday"');
      expect(component.mediaItem!.folderId).toBe(5);
      expect(galleryService.bulkMove).not.toHaveBeenCalled();
    });

    it('moves a source asset by its own id list', () => {
      (component.mediaItem as unknown as {itemType: string}).itemType =
        'source_asset';
      folderService.moveItems.and.returnValue(of(moved(1)));
      closeWith({destinationFolderId: 5, destinationName: 'Holiday'});

      component.openBatchMoveDialog();

      const dto = folderService.moveItems.calls.mostRecent().args[0];
      expect(dto.mediaItemIds).toEqual([]);
      expect(dto.sourceAssetIds).toEqual([42]);
    });

    it('does nothing when the chosen folder is the current one', () => {
      closeWith({destinationFolderId: null, destinationName: 'Root'});

      component.openBatchMoveDialog();

      expect(folderService.moveItems).not.toHaveBeenCalled();
    });

    it('says the item was not moved when the backend moved nothing', () => {
      folderService.moveItems.and.returnValue(of(moved(0)));
      closeWith({destinationFolderId: 5, destinationName: 'Holiday'});

      component.openBatchMoveDialog();

      expect(lastToast()).toBe(
        'Item was not moved; it may have been moved or deleted',
      );
      expect(component.mediaItem!.folderId).toBeUndefined();
    });

    it('shows the backend detail when the folder vanished meanwhile', () => {
      folderService.moveItems.and.returnValue(
        throwError(() => ({
          status: 404,
          error: {detail: 'Destination folder not found.'},
        })),
      );
      closeWith({destinationFolderId: 5, destinationName: 'Holiday'});

      component.openBatchMoveDialog();

      expect(lastToast()).toContain('Destination folder not found.');
      expect(component.mediaItem!.folderId).toBeUndefined();
    });

    it('moves to another workspace through bulkMove and leaves the page', () => {
      const res: BulkMoveResponse = {
        moved_count: 1,
        moved: [{id: 42, type: 'media_item'}],
        failed: [],
      };
      galleryService.bulkMove.and.returnValue(of(res));
      closeWith({destinationWorkspaceId: 9, destinationName: 'Team B'});

      component.openBatchMoveDialog();

      expect(galleryService.bulkMove).toHaveBeenCalledWith(
        [{id: 42, type: 'media_item'}],
        9,
      );
      expect(folderService.moveItems).not.toHaveBeenCalled();
      expect(lastToast()).toBe('Moved to "Team B"');
      expect(navigate).toHaveBeenCalledWith(['/gallery']);
    });

    it('reports a workspace move that came back failed, and stays put', () => {
      const res: BulkMoveResponse = {
        moved_count: 0,
        moved: [],
        failed: [{id: 42, type: 'media_item', reason: 'NOT_FOUND'}],
      };
      galleryService.bulkMove.and.returnValue(of(res));
      closeWith({destinationWorkspaceId: 9, destinationName: 'Team B'});

      component.openBatchMoveDialog();

      expect(lastToast()).toBe('Could not move to "Team B": no longer exists');
      expect(navigate).not.toHaveBeenCalled();
    });

    it('shows the backend detail when a workspace move is refused', () => {
      galleryService.bulkMove.and.returnValue(
        throwError(() => ({
          status: 403,
          error: {detail: 'Not a member of this workspace.'},
        })),
      );
      closeWith({destinationWorkspaceId: 9, destinationName: 'Team B'});

      component.openBatchMoveDialog();

      expect(lastToast()).toBe('Not a member of this workspace.');
      expect(navigate).not.toHaveBeenCalled();
    });
  });

  describe('download', () => {
    const signedUrl =
      'https://storage.googleapis.com/bucket/images/1b2c3d4e?X-Goog-Signature=abc';
    let notificationService: jasmine.SpyObj<NotificationService>;
    let clickedLinks: HTMLAnchorElement[];
    let windowOpen: jasmine.Spy;
    let previousInjector: Injector;

    afterEach(() => setAppInjector(previousInjector));

    beforeEach(() => {
      notificationService = jasmine.createSpyObj('NotificationService', [
        'show',
      ]);
      previousInjector = AppInjector;
      setAppInjector({
        get: () => notificationService,
      } as unknown as Injector);

      clickedLinks = [];
      spyOn(HTMLAnchorElement.prototype, 'click').and.callFake(function (
        this: HTMLAnchorElement,
      ) {
        clickedLinks.push(this);
      });
      windowOpen = spyOn(window, 'open');

      component.mediaItem = {
        id: 42,
        mimeType: 'image/png',
        presignedUrls: ['https://example.test/first', signedUrl],
      } as MediaItem;
      component.selectedIndex = 1;
      component.selectedUrl = signedUrl;
      fixture.detectChanges();
    });

    function clickDownloadButton(): void {
      const button = Array.from(
        fixture.nativeElement.querySelectorAll('studio-button'),
      ).find(el => (el as HTMLElement).textContent?.trim() === 'download') as
        | HTMLElement
        | undefined;
      expect(button).withContext('download button').toBeDefined();
      button!.click();
    }

    // The click handler is async (fetch, then blob), so wait for it to settle.
    async function settle(): Promise<void> {
      for (let i = 0; i < 20 && component.isDownloading; i++) {
        await new Promise(resolve => setTimeout(resolve));
      }
    }

    // Reported Sept 2 and Sept 4: the button opened the signed URL in a new
    // tab, where the browser ignores `download` because it is cross-origin.
    it('saves the file from a same-origin blob link instead of opening a tab', async () => {
      spyOn(window, 'fetch').and.resolveTo(
        new Response(new Blob(['png'], {type: 'image/png'})),
      );

      clickDownloadButton();
      await settle();

      expect(window.fetch).toHaveBeenCalledWith(signedUrl, jasmine.anything());
      expect(clickedLinks.length).toBe(1);
      const link = clickedLinks[0];
      expect(link.href).toMatch(/^blob:/);
      expect(link.target).not.toBe('_blank');
      expect(link.download).toBe('creative-studio-42-2.png');
      expect(windowOpen).not.toHaveBeenCalled();
      expect(component.isDownloading).toBeFalse();
    });

    // A rejected signature comes back 403. The user must hear about it,
    // and must not be bounced to a tab showing a GCS XML error. Retrying
    // resends the same URL, so the message must send them to a reload.
    it('tells the user to reload when the signed URL is rejected, and opens nothing', async () => {
      spyOn(window, 'fetch').and.resolveTo(
        new Response('<Error>SignatureDoesNotMatch</Error>', {status: 403}),
      );

      clickDownloadButton();
      await settle();

      expect(notificationService.show).toHaveBeenCalledWith(
        'This download link has expired. Reload the page to download the file.',
        'error',
        jasmine.anything(),
        undefined,
        jasmine.anything(),
      );
      expect(clickedLinks.length).toBe(0);
      expect(windowOpen).not.toHaveBeenCalled();
      expect(component.isDownloading).toBeFalse();
    });

    // A dropped connection is transient, so a retry is the right advice.
    it('tells the user to retry when the fetch fails for another reason', async () => {
      spyOn(window, 'fetch').and.rejectWith(new TypeError('Failed to fetch'));

      clickDownloadButton();
      await settle();

      expect(notificationService.show).toHaveBeenCalledWith(
        'Could not download the file. Please try again.',
        'error',
        jasmine.anything(),
        undefined,
        jasmine.anything(),
      );
      expect(clickedLinks.length).toBe(0);
      expect(windowOpen).not.toHaveBeenCalled();
      expect(component.isDownloading).toBeFalse();
    });
  });
});
