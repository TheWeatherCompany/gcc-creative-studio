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
import {CUSTOM_ELEMENTS_SCHEMA} from '@angular/core';

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

    // The dialog marks the root as the current location only for null.
    it('passes null as the current folder for an item at the root', () => {
      component.openBatchMoveDialog();

      expect(dialogOpen).toHaveBeenCalledWith(MoveToFolderDialogComponent, {
        data: {workspaceId: 1, itemCount: 1, currentFolderId: null},
      });
    });

    it('passes the item folder as the current folder', () => {
      component.mediaItem!.folderId = 7;

      component.openBatchMoveDialog();

      expect(dialogOpen.calls.mostRecent().args[1].data.currentFolderId).toBe(
        7,
      );
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

    // A 409 is not always a name collision: the subtree-too-deep error is a
    // 409 with a string detail, and must be shown as such.
    it('shows a string 409 as is rather than as a collision', () => {
      const tooDeep =
        'This folder hierarchy is nested too deeply, or contains a cycle, and cannot be processed.';
      folderService.moveItems.and.returnValue(
        throwError(() => ({status: 409, error: {detail: tooDeep}})),
      );
      closeWith({destinationFolderId: 5, destinationName: 'Holiday'});

      component.openBatchMoveDialog();

      expect(lastToast()).toBe(tooDeep);
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
});
