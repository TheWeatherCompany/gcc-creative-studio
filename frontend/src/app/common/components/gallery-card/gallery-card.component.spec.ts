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
import {CUSTOM_ELEMENTS_SCHEMA} from '@angular/core';
import {provideRouter, RouterModule} from '@angular/router';
import {CommonModule} from '@angular/common';
import {MatDialogModule} from '@angular/material/dialog';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {of, throwError} from 'rxjs';

import {GalleryCardComponent} from './gallery-card.component';
import {GalleryItem} from '../../models/gallery-item.model';
import {GalleryService} from '../../../gallery/gallery.service';
import {UserService} from '../../services/user.service';

const makeItem = (overrides: Partial<GalleryItem> = {}): GalleryItem =>
  ({
    id: 1,
    itemType: 'media_item',
    mimeType: 'video/mp4',
    presignedUrls: ['https://example.com/a.mp4'],
    presignedThumbnailUrls: [],
    ...overrides,
  }) as unknown as GalleryItem;

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

/**
 * Logic-level tests: drive the component class directly with mocked
 * dependencies to exercise thumbnail detection, active-clip selection, and
 * hover-intent timing without compiling the full shared-module template.
 */
describe('GalleryCardComponent (hover preview logic)', () => {
  let component: GalleryCardComponent;

  const construct = (platformId: 'browser' | 'server' = 'browser') =>
    new GalleryCardComponent(
      {} as any, // Router
      {getUserDetails: () => ({roles: []})} as any, // UserService
      {} as any, // MatDialog
      {} as any, // GalleryService
      {} as any, // MatSnackBar
      platformId,
    );

  beforeEach(() => {
    component = construct('browser');
  });

  describe('hasThumbnail', () => {
    it('is true when the item has at least one thumbnail url', () => {
      component.item = makeItem({presignedThumbnailUrls: ['t.png']});
      expect(component.hasThumbnail).toBeTrue();
    });

    it('is false when the thumbnail array is empty', () => {
      component.item = makeItem({presignedThumbnailUrls: []});
      expect(component.hasThumbnail).toBeFalse();
    });

    it('is false when the field is undefined', () => {
      component.item = makeItem({presignedThumbnailUrls: undefined});
      expect(component.hasThumbnail).toBeFalse();
    });
  });

  describe('activeVideoUrl', () => {
    it('returns the url at the current carousel index', () => {
      component.item = makeItem({presignedUrls: ['a.mp4', 'b.mp4']});
      component.currentImageIndex = 1;
      expect(component.activeVideoUrl).toBe('b.mp4');
    });

    it('clamps to the last clip when the index exceeds the clip count', () => {
      component.item = makeItem({presignedUrls: ['a.mp4', 'b.mp4']});
      component.currentImageIndex = 5;
      expect(component.activeVideoUrl).toBe('b.mp4');
    });

    it('clamps to the first clip for a negative index', () => {
      component.item = makeItem({presignedUrls: ['a.mp4', 'b.mp4']});
      component.currentImageIndex = -3;
      expect(component.activeVideoUrl).toBe('a.mp4');
    });

    it('returns null when there are no urls', () => {
      component.item = makeItem({presignedUrls: []});
      expect(component.activeVideoUrl).toBeNull();
    });
  });

  describe('hover intent', () => {
    beforeEach(() => jasmine.clock().install());
    afterEach(() => jasmine.clock().uninstall());

    it('sets hoveredVideoId only after the intent delay for videos', () => {
      component.item = makeItem({id: 42, mimeType: 'video/mp4'});
      component.onMouseEnter();
      expect(component.hoveredVideoId).toBeNull();
      jasmine.clock().tick(150);
      expect(component.hoveredVideoId).toBe(42);
    });

    it('cancels the pending timer when the pointer leaves early', () => {
      component.item = makeItem({id: 42, mimeType: 'video/mp4'});
      component.onMouseEnter();
      jasmine.clock().tick(100);
      component.onMouseLeave();
      jasmine.clock().tick(100);
      expect(component.hoveredVideoId).toBeNull();
    });

    it('does not schedule playback for a video with no clips', () => {
      component.item = makeItem({
        id: 5,
        mimeType: 'video/mp4',
        presignedUrls: [],
      });
      component.onMouseEnter();
      jasmine.clock().tick(150);
      expect(component.hoveredVideoId).toBeNull();
    });

    it('does not schedule playback during SSR (non-browser platform)', () => {
      const serverComponent = construct('server');
      serverComponent.item = makeItem({id: 99, mimeType: 'video/mp4'});
      serverComponent.onMouseEnter();
      jasmine.clock().tick(150);
      expect(serverComponent.hoveredVideoId).toBeNull();
    });

    it('activates audio immediately without waiting for the delay', () => {
      component.item = makeItem({id: 7, mimeType: 'audio/mpeg'});
      component.onMouseEnter();
      expect(component.hoveredAudioId).toBe(7);
      expect(component.hoveredVideoId).toBeNull();
    });

    it('clears a pending timer on destroy', () => {
      component.item = makeItem({id: 42, mimeType: 'video/mp4'});
      component.onMouseEnter();
      component.ngOnDestroy();
      jasmine.clock().tick(150);
      expect(component.hoveredVideoId).toBeNull();
    });
  });
});

/**
 * Template-level smoke tests: render the component through TestBed so the
 * restructured video branches (thumbnail vs. poster fallback vs. hover clip)
 * are actually compiled and exercised. CommonModule provides the structural
 * directives; CUSTOM_ELEMENTS_SCHEMA stubs the child components
 * (app-gallery-item-overlay, mat-icon, mat-chip).
 */
describe('GalleryCardComponent (template)', () => {
  let fixture: ComponentFixture<GalleryCardComponent>;
  let component: GalleryCardComponent;

  beforeEach(async () => {
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
        {provide: GalleryService, useValue: {}},
        {provide: UserService, useValue: {getUserDetails: () => null}},
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(GalleryCardComponent);
    component = fixture.componentInstance;
  });

  it('renders a thumbnail img (not a video) by default when a thumbnail exists', () => {
    component.item = makeItem({
      presignedThumbnailUrls: ['https://example.com/t.png'],
      presignedUrls: ['https://example.com/a.mp4'],
    });
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector('img.media-element'),
    ).toBeTruthy();
    expect(fixture.nativeElement.querySelector('video')).toBeNull();
  });

  it('renders a single poster-frame video when no thumbnail exists', () => {
    component.item = makeItem({
      presignedThumbnailUrls: [],
      presignedUrls: ['https://example.com/a.mp4', 'https://example.com/b.mp4'],
    });
    fixture.detectChanges();
    const videos = fixture.nativeElement.querySelectorAll('video');
    expect(videos.length).toBe(1);
    expect(videos[0].getAttribute('src')).toContain('#t=0.1');
  });

  it('plays only the active clip on hover', () => {
    component.item = makeItem({
      presignedUrls: ['https://example.com/a.mp4', 'https://example.com/b.mp4'],
    });
    component.hoveredVideoId = component.item.id;
    component.currentImageIndex = 1;
    fixture.detectChanges();
    const videos = fixture.nativeElement.querySelectorAll('video');
    expect(videos.length).toBe(1);
    expect(videos[0].getAttribute('src')).toBe('https://example.com/b.mp4');
  });
});
