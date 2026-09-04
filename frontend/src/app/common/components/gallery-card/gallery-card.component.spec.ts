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

import {ComponentFixture, TestBed} from '@angular/core/testing';

import {RouterTestingModule} from '@angular/router/testing';
import {MatDialogModule} from '@angular/material/dialog';
import {MatIconModule} from '@angular/material/icon';
import {MatChipsModule} from '@angular/material/chips';
import {GalleryCardComponent} from './gallery-card.component';
import {UserService} from '../../services/user.service';
import {GalleryItem} from '../../models/gallery-item.model';
import {GalleryService} from '../../../gallery/gallery.service';
import {CUSTOM_ELEMENTS_SCHEMA, NO_ERRORS_SCHEMA} from '@angular/core';
import {provideRouter, RouterModule} from '@angular/router';
import {CommonModule} from '@angular/common';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {of, throwError} from 'rxjs';

// Two suites, each with its own TestBed: the drag-and-drop specs need
// the real GalleryService shape, the favorite specs need spies.
describe('GalleryCardComponent', () => {
  let component: GalleryCardComponent;
  let fixture: ComponentFixture<GalleryCardComponent>;

  const mockItem: GalleryItem = {
    id: 42,
    workspaceId: 1,
    itemType: 'media_item',
    createdAt: '2026-01-01',
    metadata: {
      prompt: 'A futuristic city in the clouds',
    },
    presignedUrls: ['https://example.com/image.png'],
    presignedThumbnailUrls: ['https://example.com/thumb.png'],
    mimeType: 'image/png',
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [GalleryCardComponent],
      imports: [
        RouterTestingModule,
        MatDialogModule,
        MatIconModule,
        MatChipsModule,
      ],
      schemas: [NO_ERRORS_SCHEMA],
      providers: [
        {
          provide: UserService,
          useValue: {
            getUserDetails: () => ({email: 'user@example.com', roles: []}),
          },
        },
        {
          provide: GalleryService,
          useValue: {
            favorite: () => of({}),
            unfavorite: () => of({}),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(GalleryCardComponent);
    component = fixture.componentInstance;
    component.item = mockItem;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('should set drag data on onDragStart for single item', () => {
    let setDataCall: {type: string; data: string} | null = null;
    const mockEvent = {
      preventDefault: jasmine.createSpy('preventDefault'),
      stopPropagation: jasmine.createSpy('stopPropagation'),
      dataTransfer: {
        setData: (type: string, data: string) => {
          setDataCall = {type, data};
        },
        setDragImage: jasmine.createSpy('setDragImage'),
        effectAllowed: '',
      },
    } as unknown as DragEvent;

    component.onDragStart(mockEvent);

    expect(component.isDragging).toBeTrue();
    expect(setDataCall).not.toBeNull();
    expect(setDataCall!.type).toBe('application/json');
    const parsed = JSON.parse(setDataCall!.data);
    expect(parsed.mediaItemIds).toEqual([42]);
    expect(parsed.itemCount).toBe(1);
  });

  it('should set drag data for multi-selected items if item is selected', () => {
    component.isSelected = true;
    component.selectedItems = new Set([
      'media_item:42',
      'media_item:43',
      'source_asset:10',
    ]);

    let setDataCall: {type: string; data: string} | null = null;
    const mockEvent = {
      preventDefault: jasmine.createSpy('preventDefault'),
      stopPropagation: jasmine.createSpy('stopPropagation'),
      dataTransfer: {
        setData: (type: string, data: string) => {
          setDataCall = {type, data};
        },
        setDragImage: jasmine.createSpy('setDragImage'),
        effectAllowed: '',
      },
    } as unknown as DragEvent;

    component.onDragStart(mockEvent);

    expect(component.isDragging).toBeTrue();
    expect(setDataCall).not.toBeNull();
    const parsed = JSON.parse(setDataCall!.data);
    expect(parsed.mediaItemIds).toContain(42);
    expect(parsed.mediaItemIds).toContain(43);
    expect(parsed.sourceAssetIds).toContain(10);
    expect(parsed.itemCount).toBe(3);
  });

  it('should reset isDragging on onDragEnd', () => {
    component.isDragging = true;
    component.onDragEnd({} as DragEvent);
    expect(component.isDragging).toBeFalse();
  });
});

describe('GalleryCardComponent favorite toggle', () => {
  let component: GalleryCardComponent;
  let fixture: ComponentFixture<GalleryCardComponent>;
  let galleryService: jasmine.SpyObj<
    Pick<GalleryService, 'favorite' | 'unfavorite'>
  >;

  const stopped = () => new MouseEvent('click');

  beforeEach(async () => {
    galleryService = jasmine.createSpyObj('GalleryService', [
      'favorite',
      'unfavorite',
    ]);

    await TestBed.configureTestingModule({
      declarations: [GalleryCardComponent],
      imports: [
        CommonModule,
        RouterModule,
        MatDialogModule,
        MatSnackBarModule,
        NoopAnimationsModule,
      ],
      providers: [
        provideRouter([]),
        {provide: GalleryService, useValue: galleryService},
        {provide: UserService, useValue: {getUserDetails: () => null}},
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(GalleryCardComponent);
    component = fixture.componentInstance;
    component.item = {
      id: 42,
      itemType: 'media_item',
      isFavorite: false,
    } as GalleryItem;
  });

  // The shipped bug: the optimistic flip lit the heart, then the response
  // overwrote isFavorite with undefined and it went dark until a reload.
  it('leaves the heart lit after a successful favorite', () => {
    galleryService.favorite.and.returnValue(of(true));

    component.toggleFavorite(stopped());

    expect(galleryService.favorite).toHaveBeenCalledWith(42);
    expect(component.item.isFavorite).toBeTrue();
    expect(component.isFavoriteUpdating).toBeFalse();
  });

  it('leaves the heart unlit after a successful unfavorite', () => {
    component.item.isFavorite = true;
    galleryService.unfavorite.and.returnValue(of(false));

    component.toggleFavorite(stopped());

    expect(galleryService.unfavorite).toHaveBeenCalledWith(42);
    expect(component.item.isFavorite).toBeFalse();
  });

  it('reverts the optimistic flip when the request fails', () => {
    galleryService.favorite.and.returnValue(
      throwError(() => new Error('boom')),
    );

    component.toggleFavorite(stopped());

    expect(component.item.isFavorite).toBeFalse();
    expect(component.isFavoriteUpdating).toBeFalse();
  });

  it('ignores a second toggle while one is in flight', () => {
    component.isFavoriteUpdating = true;

    component.toggleFavorite(stopped());

    expect(galleryService.favorite).not.toHaveBeenCalled();
  });

  it('renders the filled heart icon once favorited', () => {
    galleryService.favorite.and.returnValue(of(true));

    component.toggleFavorite(stopped());
    fixture.detectChanges();

    const button: HTMLElement =
      fixture.nativeElement.querySelector('.favorite-btn');
    expect(button.classList).toContain('is-favorite');
    expect(button.textContent?.trim()).toBe('favorite');
  });
});
