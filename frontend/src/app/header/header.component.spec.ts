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
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {provideRouter, Router} from '@angular/router';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {MatMenuModule} from '@angular/material/menu';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';
import {MatTooltipModule} from '@angular/material/tooltip';
import {Component, CUSTOM_ELEMENTS_SCHEMA} from '@angular/core';

import {HeaderComponent} from './header.component';
import {UserService} from '../common/services/user.service';
import {AuthService} from '../common/services/auth.service';
import {environment} from '../../environments/environment';

@Component({template: '', standalone: false})
class DummyComponent {}

describe('HeaderComponent', () => {
  let component: HeaderComponent;
  let fixture: ComponentFixture<HeaderComponent>;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      declarations: [HeaderComponent, DummyComponent],
      imports: [
        NoopAnimationsModule,
        MatMenuModule,
        MatButtonModule,
        MatIconModule,
        MatTooltipModule,
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          {path: 'gallery', component: DummyComponent},
          {path: 'gallery/:id', component: DummyComponent},
          {path: 'folders/:folderId', component: DummyComponent},
          {path: 'video', component: DummyComponent},
        ]),
        {
          provide: UserService,
          useValue: {
            getUserDetails: () => ({
              id: '1',
              name: 'Test User',
              email: 'test@example.com',
            }),
          },
        },
        {
          provide: AuthService,
          useValue: {
            logout: jasmine.createSpy('logout'),
            isUserAdmin: jasmine
              .createSpy('isUserAdmin')
              .and.returnValue(false),
          },
        },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    router = TestBed.inject(Router);
  });

  const create = () => {
    fixture = TestBed.createComponent(HeaderComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  };

  it('should create', () => {
    create();
    expect(component).toBeTruthy();
  });

  // Each nav icon sits in a 24px overflow-hidden slot. Material's FAB
  // stylesheet (56px) loads after Tailwind's, so plain w-6/h-6
  // lose and the icon is clipped to a sliver. This runs in real Chrome, so
  // the computed layout is what the user sees.
  it('sizes every nav FAB to its 24px icon slot', () => {
    create();
    component.menuFixed = true;
    fixture.detectChanges();

    const buttons: HTMLElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.menu-items button[matFab]'),
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      const {width, height} = button.getBoundingClientRect();
      expect({width, height})
        .withContext(button.ariaLabel ?? '')
        .toEqual({width: 24, height: 24});
    }
  });

  describe('isGalleryActive', () => {
    // isActive('/gallery', false) is a subset match, so a media detail page
    // keeps the gallery highlighted too. The non-gallery route comes last so
    // the table also proves the flag drops again on the way out.
    const routes: Array<[string, boolean]> = [
      ['/gallery', true],
      ['/folders/123', true],
      ['/gallery/42', true],
      ['/video', false],
    ];

    it('highlights the gallery on its routes, on load and on navigation', async () => {
      await router.navigateByUrl('/video');
      create();
      expect(component.isGalleryActive).toBeFalse();

      for (const [url, active] of routes) {
        await router.navigateByUrl(url);
        expect(component.isGalleryActive)
          .withContext(`navigated to ${url}`)
          .toBe(active);
        const loadedHere = TestBed.createComponent(HeaderComponent);
        expect(loadedHere.componentInstance.isGalleryActive)
          .withContext(`constructed on ${url}`)
          .toBe(active);
      }
    });

    it('stops following navigation once destroyed', async () => {
      await router.navigateByUrl('/video');
      create();

      component.ngOnDestroy();
      await router.navigateByUrl('/gallery');

      expect(component.isGalleryActive).toBeFalse();
    });
  });

  // Upstream deletes the environment import from this component; ours needs
  // it for the avatar fallback, so taking that hunk breaks the build.
  it('falls back to the default avatar when the user has no picture', () => {
    create();
    expect(component.defaultAvatarUrl).toBe(environment.defaultAvatarUrl);
    const avatar: HTMLImageElement = fixture.nativeElement.querySelector(
      'img[alt="User profile"]',
    );
    expect(avatar.getAttribute('src')).toBe(environment.defaultAvatarUrl);
  });
});
