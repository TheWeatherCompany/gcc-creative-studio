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
import {Component, Inject, PLATFORM_ID} from '@angular/core';
import {MatSnackBar} from '@angular/material/snack-bar';
import {ActivatedRoute} from '@angular/router';
import {AuthService} from './../common/services/auth.service';
import {handleErrorSnackbar} from '../utils/handleMessageSnackbar';

const HOME_ROUTE = '/';

/**
 * Constrains ?returnUrl to a path inside this app.
 *
 * The value survives the Okta round trip and is handed to
 * `router.navigateByUrl`, so an absolute or protocol-relative value should
 * never get that far. Angular's router would not actually leave the origin,
 * but "the router happens to contain it" is a weaker guarantee than not
 * accepting the input, and a crafted /login?returnUrl=... link should not
 * decide where a user lands after authenticating.
 */
export function safeReturnUrl(candidate: string | null): string {
  if (!candidate) return HOME_ROUTE;
  // Rejects "//evil.com" (protocol-relative), "https://evil.com" and
  // "\\evil.com", while allowing "/galleries?page=2".
  if (!candidate.startsWith('/')) return HOME_ROUTE;
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) {
    return HOME_ROUTE;
  }
  return candidate;
}

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss'],
})
export class LoginComponent {
  loader = false;
  isBrowser: boolean;

  constructor(
    private authService: AuthService,
    private route: ActivatedRoute,
    private snackBar: MatSnackBar,
    @Inject(PLATFORM_ID) platformId: Object,
  ) {
    this.isBrowser = isPlatformBrowser(platformId);
  }

  /**
   * Hands off to Okta. There is no local-only variant any more: localhost is
   * a registered redirect URI, so developers take the same path as everyone
   * else and need the same Okta app assignment.
   */
  login(): void {
    this.loader = true;

    const returnUrl = safeReturnUrl(
      this.route.snapshot.queryParamMap.get('returnUrl'),
    );

    // Resolves only after the browser has left the page, so the spinner
    // stays up; a rejection means we never got that far.
    this.authService.login(returnUrl).catch(error => {
      this.loader = false;
      handleErrorSnackbar(this.snackBar, error, 'Login Error');
    });
  }
}
