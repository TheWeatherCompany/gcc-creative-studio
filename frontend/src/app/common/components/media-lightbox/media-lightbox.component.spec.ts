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
import {provideRouter} from '@angular/router';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {MatDialogModule} from '@angular/material/dialog';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {CUSTOM_ELEMENTS_SCHEMA} from '@angular/core';

import {of, throwError} from 'rxjs';
import {MatDialog} from '@angular/material/dialog';

import {MediaLightboxComponent} from './media-lightbox.component';
import {TagsService} from '../../services/tags.service';
import {WorkspaceStateService} from '../../../services/workspace/workspace-state.service';
import {GalleryService} from '../../../gallery/gallery.service';
import {FolderService} from '../../services/folder.service';
import {MediaItem} from '../../models/media-item.model';

describe('MediaLightboxComponent', () => {
  let component: MediaLightboxComponent;
  let fixture: ComponentFixture<MediaLightboxComponent>;
  let dialogResult: unknown;
  let moveItems: jasmine.Spy;
  let galleryService: jasmine.SpyObj<
    Pick<GalleryService, 'favorite' | 'unfavorite' | 'bulkMove'>
  >;

  beforeEach(async () => {
    dialogResult = undefined;
    moveItems = jasmine
      .createSpy('moveItems')
      .and.returnValue(of({total_moved: 1}));
    galleryService = jasmine.createSpyObj('GalleryService', [
      'favorite',
      'unfavorite',
      'bulkMove',
    ]);
    galleryService.bulkMove.and.returnValue(
      of({moved: [{id: 7, type: 'media_item'}], failed: []}),
    );

    await TestBed.configureTestingModule({
      declarations: [MediaLightboxComponent],
      imports: [MatDialogModule, MatSnackBarModule, NoopAnimationsModule],
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
        {
          provide: MatDialog,
          useValue: {
            open: () => ({afterClosed: () => of(dialogResult)}),
          },
        },
        {provide: GalleryService, useValue: galleryService},
        {
          provide: FolderService,
          useValue: {moveItems},
        },
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

  describe('openBatchMoveDialog', () => {
    beforeEach(() => {
      component.mediaItem = {id: 7, folderId: null} as never;
    });

    it('moves the item when the dialog returns a workspace', () => {
      // This selection used to be dropped on the floor: the callback only
      // handled destinationFolderId, so picking a workspace did nothing.
      dialogResult = {destinationWorkspaceId: 42, destinationName: 'Team B'};

      component.openBatchMoveDialog();

      expect(galleryService.bulkMove).toHaveBeenCalledWith(
        [{id: 7, type: 'media_item'}],
        42,
      );
    });

    it('reports a rejected workspace move instead of claiming success', () => {
      dialogResult = {destinationWorkspaceId: 42, destinationName: 'Team B'};
      galleryService.bulkMove.and.returnValue(
        of({
          moved: [],
          failed: [{id: 7, type: 'media_item', reason: 'Not authorized'}],
        }),
      );
      const snackBar = spyOn(component['snackBar'], 'open');

      component.openBatchMoveDialog();

      expect(snackBar.calls.mostRecent().args[0]).toContain('Not authorized');
    });

    it('uses destinationName for a folder move', () => {
      // folderName was never part of the dialog's result contract, so the
      // name always fell through to the literal 'Folder'.
      dialogResult = {destinationFolderId: 3, destinationName: 'Campaigns'};
      const snackBar = spyOn(component['snackBar'], 'open');

      component.openBatchMoveDialog();

      expect(moveItems).toHaveBeenCalled();
      expect(snackBar.calls.mostRecent().args[0]).toContain('Campaigns');
    });

    it('does nothing when the dialog is dismissed', () => {
      dialogResult = undefined;

      component.openBatchMoveDialog();

      expect(galleryService.bulkMove).not.toHaveBeenCalled();
      expect(moveItems).not.toHaveBeenCalled();
    });
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
});
