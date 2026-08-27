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
import {TestBed} from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  UrlTree,
} from '@angular/router';
import {RouterTestingModule} from '@angular/router/testing';
import {UserRolesEnum} from '../models/user.model';
import {AuthGuardService} from './auth.guard.service';
import {AuthService} from './auth.service';
import {UserService} from './user.service';

describe('AuthGuardService', () => {
  let guard: AuthGuardService;
  let router: Router;
  let loggedIn: boolean;
  let roles: UserRolesEnum[];

  const snapshot = (requiredRoles?: UserRolesEnum[]) =>
    ({
      data: requiredRoles ? {requiredRoles} : {},
    }) as unknown as ActivatedRouteSnapshot;

  const state = (url: string) => ({url}) as unknown as RouterStateSnapshot;

  beforeEach(() => {
    loggedIn = true;
    roles = [UserRolesEnum.USER];

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule, RouterTestingModule],
      providers: [
        AuthGuardService,
        {provide: AuthService, useValue: {isLoggedIn: () => loggedIn}},
        {
          provide: UserService,
          useValue: {getUserDetails: () => ({roles})},
        },
      ],
    });
    guard = TestBed.inject(AuthGuardService);
    router = TestBed.inject(Router);
  });

  it('should be created', () => {
    expect(guard).toBeTruthy();
  });

  it('allows an authenticated user through a route with no role requirement', () => {
    expect(guard.canActivate(snapshot(), state('/'))).toBeTrue();
  });

  it('redirects an anonymous user to login, carrying the attempted URL', () => {
    loggedIn = false;

    const result = guard.canActivate(snapshot(), state('/workflows/new'));

    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe(
      '/login?returnUrl=%2Fworkflows%2Fnew',
    );
  });

  it('allows a user holding one of the required roles', () => {
    roles = [UserRolesEnum.WORKFLOWS];

    const result = guard.canActivate(
      snapshot([UserRolesEnum.WORKFLOWS, UserRolesEnum.ADMIN]),
      state('/workflows'),
    );

    expect(result).toBeTrue();
  });

  it('sends a user lacking the required role home rather than to login', () => {
    spyOn(console, 'warn');
    roles = [UserRolesEnum.USER];

    const result = guard.canActivate(
      snapshot([UserRolesEnum.WORKFLOWS]),
      state('/workflows'),
    );

    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe('/');
  });
});
