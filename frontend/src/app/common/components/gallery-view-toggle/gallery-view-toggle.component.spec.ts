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
import {MatIconModule} from '@angular/material/icon';
import {provideRouter, RouterModule} from '@angular/router';

import {GalleryViewToggleComponent} from './gallery-view-toggle.component';

describe('GalleryViewToggleComponent', () => {
  let fixture: ComponentFixture<GalleryViewToggleComponent>;

  const segment = (view: 'grid' | 'feed'): HTMLAnchorElement =>
    fixture.nativeElement.querySelector(`[data-testid="view-toggle-${view}"]`);

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [GalleryViewToggleComponent],
      imports: [MatIconModule, RouterModule],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(GalleryViewToggleComponent);
  });

  // The active segment must not link: the gallery also renders at
  // /folders/:folderId, and a Grid link there would leave the folder.
  it('links only the other view: Grid to /gallery, Feed to /gallery/feed', () => {
    fixture.componentRef.setInput('active', 'grid');
    fixture.detectChanges();
    expect(segment('grid').hasAttribute('href')).toBeFalse();
    expect(segment('feed').getAttribute('href')).toBe('/gallery/feed');

    fixture.componentRef.setInput('active', 'feed');
    fixture.detectChanges();
    expect(segment('grid').getAttribute('href')).toBe('/gallery');
    expect(segment('feed').hasAttribute('href')).toBeFalse();
  });

  it('marks only the active segment as the current page', () => {
    fixture.componentRef.setInput('active', 'grid');
    fixture.detectChanges();
    expect(segment('grid').getAttribute('aria-current')).toBe('page');
    expect(segment('feed').hasAttribute('aria-current')).toBeFalse();

    fixture.componentRef.setInput('active', 'feed');
    fixture.detectChanges();
    expect(segment('feed').getAttribute('aria-current')).toBe('page');
    expect(segment('grid').hasAttribute('aria-current')).toBeFalse();
  });

  it('shows the NEW badge on the Feed segment until switched off', () => {
    fixture.componentRef.setInput('active', 'grid');
    fixture.detectChanges();
    const badge = fixture.nativeElement.querySelector(
      '[data-testid="view-toggle-new-badge"]',
    );
    expect(badge).not.toBeNull();
    expect(segment('feed').contains(badge)).toBeTrue();

    fixture.componentRef.setInput('showNewBadge', false);
    fixture.detectChanges();
    expect(
      fixture.nativeElement.querySelector(
        '[data-testid="view-toggle-new-badge"]',
      ),
    ).toBeNull();
  });
});
