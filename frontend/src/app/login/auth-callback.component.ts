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

import {isPlatformBrowser} from '@angular/common';
import {Component, Inject, OnInit, PLATFORM_ID} from '@angular/core';
import {MatSnackBar} from '@angular/material/snack-bar';
import {Router} from '@angular/router';
import {AuthService} from '../common/services/auth.service';
import {handleErrorSnackbar} from '../utils/handleMessageSnackbar';

const LOGIN_ROUTE = '/login';

/**
 * Lands the Okta redirect at /login/callback.
 *
 * Exchanges the authorization code for tokens, syncs the profile with the
 * backend, then continues to wherever the user was originally headed.
 */
@Component({
  selector: 'app-auth-callback',
  template: `
    <div class="flex flex-col items-center justify-center min-h-screen gap-4">
      <mat-spinner [diameter]="50"></mat-spinner>
      <p class="text-white">{{ statusMessage }}</p>
    </div>
  `,
  standalone: false,
})
export class AuthCallbackComponent implements OnInit {
  statusMessage = 'Signing you in...';

  constructor(
    private authService: AuthService,
    private router: Router,
    private snackBar: MatSnackBar,
    @Inject(PLATFORM_ID) private platformId: Object,
  ) {}

  ngOnInit(): void {
    // The code exchange needs the query string and localStorage, so there is
    // nothing to do while pre-rendering. The browser will run this on hydration.
    if (!isPlatformBrowser(this.platformId)) return;

    this.authService.handleCallback().subscribe({
      next: (returnUrl: string) => {
        void this.router.navigateByUrl(returnUrl);
      },
      error: (error: Error) => {
        this.statusMessage = 'Sign-in failed.';
        console.error('Okta callback failed:', error);
        handleErrorSnackbar(this.snackBar, error, 'Login Error');
        void this.router.navigate([LOGIN_ROUTE]);
      },
    });
  }
}
