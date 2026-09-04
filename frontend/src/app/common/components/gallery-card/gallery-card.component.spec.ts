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
