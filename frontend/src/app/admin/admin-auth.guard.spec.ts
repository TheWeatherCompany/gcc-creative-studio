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

import {HttpClientTestingModule} from '@angular/common/http/testing';
import {Injector} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MatSnackBar} from '@angular/material/snack-bar';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import {RouterTestingModule} from '@angular/router/testing';
import {setAppInjector} from '../app-injector';
import {NotificationService} from '../common/services/notification.service';
import {AuthService} from '../common/services/auth.service';
import {AdminAuthGuard} from './admin-auth.guard';

describe('AdminAuthGuard', () => {
  let guard: AdminAuthGuard;
  let router: Router;
  let notificationService: jasmine.SpyObj<NotificationService>;
  let loggedIn: boolean;
  let isAdmin: boolean;

  const route = {} as ActivatedRouteSnapshot;
  const state = (url: string) => ({url}) as unknown as RouterStateSnapshot;

  beforeEach(() => {
    loggedIn = true;
    isAdmin = true;
    notificationService = jasmine.createSpyObj('NotificationService', ['show']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule],
      providers: [
        AdminAuthGuard,
        {
          provide: AuthService,
          useValue: {
            isLoggedIn: () => loggedIn,
            isUserAdmin: () => isAdmin,
            logout: jasmine.createSpy('logout'),
          },
        },
        {
          provide: MatSnackBar,
          useValue: jasmine.createSpyObj('MatSnackBar', ['open']),
        },
        {provide: NotificationService, useValue: notificationService},
      ],
    });
    setAppInjector(TestBed.inject(Injector));
    guard = TestBed.inject(AdminAuthGuard);
    router = TestBed.inject(Router);
  });

  it('should be created', () => {
    expect(guard).toBeTruthy();
  });

  it('admits an admin', () => {
    expect(guard.canActivate(route, state('/admin'))).toBeTrue();
  });

  it('redirects an anonymous user to login with the attempted URL', () => {
    loggedIn = false;

    const result = guard.canActivate(route, state('/admin/users'));

    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe(
      '/login?returnUrl=%2Fadmin%2Fusers',
    );
  });

  it('sends a signed-in non-admin home without signing them out', () => {
    spyOn(console, 'warn');
    isAdmin = false;
    const authService = TestBed.inject(AuthService);

    const result = guard.canActivate(route, state('/admin'));

    expect(router.serializeUrl(result as UrlTree)).toBe('/');
    expect(authService.logout).not.toHaveBeenCalled();
  });

  it('names the Okta group that grants admin access', () => {
    spyOn(console, 'warn');
    isAdmin = false;

    // canActivate's return type includes Promise, hence the void.
    void guard.canActivate(route, state('/admin'));

    expect(notificationService.show).toHaveBeenCalled();
    const message = notificationService.show.calls.mostRecent().args[0];
    expect(message).toContain('Creative Studio PortalAdmins');
  });
});
