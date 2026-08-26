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

import {inject, Injectable, PLATFORM_ID} from '@angular/core';
import {
  CanActivate,
  ActivatedRouteSnapshot,
  RouterStateSnapshot,
  UrlTree,
  Router,
} from '@angular/router';
import {isPlatformBrowser} from '@angular/common';
import {Observable} from 'rxjs';
import {MatSnackBar} from '@angular/material/snack-bar';
import {AuthService} from '../common/services/auth.service';
import {handleErrorSnackbar} from '../utils/handleMessageSnackbar';

const LOGIN_ROUTE = '/login';

@Injectable({
  providedIn: 'root',
})
export class AdminAuthGuard implements CanActivate {
  private platformId = inject(PLATFORM_ID);

  constructor(
    private authService: AuthService,
    private router: Router,
    private _snackBar: MatSnackBar,
  ) {}

  canActivate(
    route: ActivatedRouteSnapshot,
    state: RouterStateSnapshot,
  ):
    | Observable<boolean | UrlTree>
    | Promise<boolean | UrlTree>
    | boolean
    | UrlTree {
    if (!isPlatformBrowser(this.platformId)) {
      // --- SERVER SIDE ---
      // Allow navigation to render the basic app shell.
      // The client will verify localStorage and redirect if necessary.
      console.log(
        'AuthGuard (SSR): Allowing shell render. Client will verify auth.',
      );
      return true;
    }

    // --- BROWSER SIDE ---
    if (!this.authService.isLoggedIn()) {
      return this.router.createUrlTree([LOGIN_ROUTE], {
        queryParams: {returnUrl: state.url},
      });
    }

    if (this.authService.isUserAdmin()) {
      return true;
    }

    // Authenticated but not an admin. Roles come from Okta group membership,
    // so this is a group assignment question, not a broken session: signing
    // the user out here would be both hostile and useless.
    console.warn('Access denied to admin area.');
    handleErrorSnackbar(
      this._snackBar,
      {
        message:
          'Access Denied: administrator access is granted through the ' +
          '"Creative Studio Admins" Okta group.',
      },
      'Access Denied',
    );
    return this.router.createUrlTree(['/']);
  }
}
