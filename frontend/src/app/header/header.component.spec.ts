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
  ComponentFixture,
  TestBed,
  fakeAsync,
  tick,
} from '@angular/core/testing';
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
    // Read by the constructor, and Karma shares one browser context.
    localStorage.removeItem('menuFixed');
  });

  afterEach(() => {
    localStorage.removeItem('menuFixed');
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
    it('is false when constructed away from the gallery', async () => {
      await router.navigateByUrl('/video');
      create();
      expect(component.isGalleryActive).toBeFalse();
    });

    it('is true when constructed on the gallery', async () => {
      await router.navigateByUrl('/gallery');
      create();
      expect(component.isGalleryActive).toBeTrue();
    });

    it('follows navigation into a folder and back out', async () => {
      await router.navigateByUrl('/video');
      create();

      await router.navigateByUrl('/folders/123');
      expect(component.isGalleryActive).toBeTrue();

      await router.navigateByUrl('/video');
      expect(component.isGalleryActive).toBeFalse();
    });

    // isActive('/gallery', false) is a subset match, so the detail page
    // keeps the gallery highlighted.
    it('stays true on a media detail page', async () => {
      await router.navigateByUrl('/video');
      create();

      await router.navigateByUrl('/gallery/42');
      expect(component.isGalleryActive).toBeTrue();
    });

    it('stops following navigation once destroyed', async () => {
      await router.navigateByUrl('/video');
      create();

      component.ngOnDestroy();
      await router.navigateByUrl('/gallery');

      expect(component.isGalleryActive).toBeFalse();
    });
  });

  it('should unsubscribe on destroy', () => {
    create();
    const nextSpy = spyOn(component['destroy$'], 'next');
    const completeSpy = spyOn(component['destroy$'], 'complete');
    component.ngOnDestroy();
    expect(nextSpy).toHaveBeenCalled();
    expect(completeSpy).toHaveBeenCalled();
  });

  it('should call authService.logout on logout', () => {
    create();
    component.logout();
    expect(TestBed.inject(AuthService).logout).toHaveBeenCalled();
  });

  it('should navigate to root on navigate', () => {
    create();
    const navigateByUrl = spyOn(router, 'navigateByUrl').and.resolveTo(true);
    component.navigate();
    expect(navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('should toggle menuFixed and update localStorage', () => {
    create();
    spyOn(localStorage, 'setItem');
    expect(component.menuFixed).toBeFalse();
    component.toggleMenu();
    expect(component.menuFixed).toBeTrue();
    expect(localStorage.setItem).toHaveBeenCalledWith('menuFixed', 'true');
    component.toggleMenu();
    expect(component.menuFixed).toBeFalse();
    expect(localStorage.setItem).toHaveBeenCalledWith('menuFixed', 'false');
  });

  describe('getTooltipText', () => {
    beforeEach(() => create());

    it('should return fixed tooltip when menuFixed is false', () => {
      component.menuFixed = false;
      expect(component.getTooltipText()).toBe('Click to make the menu fixed');
    });

    it('should return personalized tooltip when menuFixed is true', () => {
      component.menuFixed = true;
      expect(component.getTooltipText()).toBe(
        'Hey there Test! Click to make the menu dynamic',
      );
    });

    it('should handle missing user name gracefully', () => {
      component.currentUser = null;
      component.menuFixed = true;
      expect(component.getTooltipText()).toBe(
        'Hey there ! Click to make the menu dynamic',
      );
    });
  });

  describe('menu hover actions', () => {
    beforeEach(() => create());

    it('should handle tools menu enter and leave', fakeAsync(() => {
      component.onToolsEnter();
      expect(component.toolsMenuHovered).toBeTrue();

      component.onToolsLeave();
      expect(component.toolsMenuHovered).toBeTrue();
      tick(200);
      expect(component.toolsMenuHovered).toBeFalse();
    }));

    it('should clear tools menu timeout on enter', fakeAsync(() => {
      component.onToolsLeave();
      component.onToolsEnter();
      tick(200);
      expect(component.toolsMenuHovered).toBeTrue();
    }));
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
