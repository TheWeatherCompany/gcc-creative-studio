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

import {isPlatformBrowser} from '@angular/common';
import {HttpClient, HttpErrorResponse, HttpHeaders} from '@angular/common/http';
import {Injectable, PLATFORM_ID, inject} from '@angular/core';
import {Router} from '@angular/router';
import {Observable, from, of, throwError} from 'rxjs';
import {catchError, map, switchMap, tap} from 'rxjs/operators';
import {environment} from '../../../environments/environment';
import {UserModel, UserRolesEnum} from '../models/user.model';
import {OKTA_AUTH} from './okta-auth.provider';
import {UserService} from './user.service';

const USER_DETAILS = 'USER_DETAILS';
const LOGIN_ROUTE = '/login';
const HOME_ROUTE = '/';

@Injectable({
  providedIn: 'root',
})
export class AuthService {
  /** Null during server-side rendering. See OKTA_AUTH. */
  private readonly oktaAuth = inject(OKTA_AUTH, {optional: true});
  private readonly platformId = inject(PLATFORM_ID);

  private started = false;

  constructor(
    private router: Router,
    private httpClient: HttpClient,
    private userService: UserService,
  ) {}

  /**
   * Sends the browser to Okta to authenticate.
   *
   * `returnUrl` is stashed by okta-auth-js and handed back to
   * `handleCallback()` so a deep link survives the round trip.
   */
  async login(returnUrl: string = HOME_ROUTE): Promise<void> {
    if (!this.oktaAuth) return;

    this.oktaAuth.setOriginalUri(returnUrl);
    await this.oktaAuth.signInWithRedirect();
  }

  /**
   * Completes the redirect: exchanges the authorization code for tokens,
   * stores them, then syncs the profile with the backend.
   *
   * Emits the URL the user was originally headed for. The caller navigates;
   * doing it here would make this method impossible to test without a router.
   */
  handleCallback(): Observable<string> {
    if (!this.oktaAuth) {
      return throwError(
        () => new Error('Okta is not available outside the browser.'),
      );
    }
    const oktaAuth = this.oktaAuth;

    return from(oktaAuth.storeTokensFromRedirect()).pipe(
      switchMap(() => this.getApiToken$()),
      switchMap(token => {
        if (!token) {
          return throwError(
            () =>
              new Error(
                'Okta returned no usable token. Please try signing in again.',
              ),
          );
        }
        return this.syncUserWithBackend$(token);
      }),
      map(() => oktaAuth.getOriginalUri() || HOME_ROUTE),
      tap(() => oktaAuth.removeOriginalUri()),
    );
  }

  /**
   * The token to put in the Authorization header, renewing it if needed.
   *
   * Which token that is comes from `environment.okta.tokenForApi`. Phase 1
   * sends the ID token because the tenant has no custom authorization server
   * yet; phase 2 sends the access token. Emits null when there is no session.
   */
  getApiToken$(): Observable<string | null> {
    if (!this.oktaAuth || !isPlatformBrowser(this.platformId)) {
      return of(null);
    }
    const oktaAuth = this.oktaAuth;

    this.ensureStarted();

    if (environment.okta.tokenForApi === 'access') {
      return from(oktaAuth.getOrRenewAccessToken()).pipe(
        catchError(error => this.noSession('access token renewal', error)),
      );
    }

    // There is no getOrRenewIdToken(), so renew explicitly when the stored
    // ID token has expired.
    return from(oktaAuth.tokenManager.getTokens()).pipe(
      switchMap(tokens => {
        const idToken = tokens.idToken;
        if (!idToken) return of(null);
        if (!oktaAuth.tokenManager.hasExpired(idToken)) {
          return of(idToken.idToken);
        }
        return from(oktaAuth.tokenManager.renew('idToken')).pipe(
          map(renewed => (renewed as {idToken?: string})?.idToken ?? null),
        );
      }),
      catchError(error => this.noSession('ID token renewal', error)),
    );
  }

  /**
   * Reports a token failure as "no session", but noisily.
   *
   * Returning null is right: the interceptor sends the request unauthorized,
   * the API answers 401, and the user is sent back through Okta. Swallowing
   * the cause silently is not. An expired refresh token, an Okta outage and a
   * missing CORS Trusted Origin all land here and are otherwise
   * indistinguishable from simply being signed out, which makes the
   * silent-renewal failures the hardest thing here to diagnose in production.
   */
  private noSession(operation: string, error: unknown): Observable<null> {
    console.error(
      `Okta ${operation} failed; continuing without a token. If this repeats ` +
        `for signed-in users, check that this origin is a Trusted Origin ` +
        `with CORS enabled in Okta.`,
      error,
    );
    return of(null);
  }

  /**
   * The current API token without attempting a renewal.
   *
   * Convenience for callers that cannot await; prefer `getApiToken$()`.
   */
  getAccessToken(): string | null {
    if (!this.oktaAuth || !isPlatformBrowser(this.platformId)) return null;

    return environment.okta.tokenForApi === 'access'
      ? (this.oktaAuth.getAccessToken() ?? null)
      : (this.oktaAuth.getIdToken() ?? null);
  }

  /**
   * Whether there is a live, unexpired session.
   *
   * A pure predicate on purpose. The previous version navigated to /login as
   * a side effect, which meant merely asking the question could move the
   * user; the guards now own that decision.
   */
  isLoggedIn(): boolean {
    if (!this.oktaAuth || !isPlatformBrowser(this.platformId)) return false;

    const tokens = this.oktaAuth.tokenManager.getTokensSync();
    const token =
      environment.okta.tokenForApi === 'access'
        ? tokens.accessToken
        : tokens.idToken;

    if (!token) return false;

    // An expired token is still a session if a refresh token can renew it.
    if (this.oktaAuth.tokenManager.hasExpired(token)) {
      return !!tokens.refreshToken;
    }
    return true;
  }

  /** Alias retained for existing call sites. */
  isUserLoggedIn(): boolean {
    return this.isLoggedIn();
  }

  /**
   * Clears local tokens and the cached profile, then redirects through Okta's
   * logout so the Okta session ends too, not just this app's copy of it.
   */
  async logout(route: string = LOGIN_ROUTE): Promise<void> {
    this.clearLocalSession();

    if (!this.oktaAuth) {
      await this.router.navigateByUrl(route);
      return;
    }

    try {
      await this.oktaAuth.signOut({
        postLogoutRedirectUri: this.oktaAuth.options.postLogoutRedirectUri,
      });
    } catch (error) {
      console.error('Okta sign-out failed; clearing local session.', error);
      this.oktaAuth.tokenManager.clear();
      await this.router.navigateByUrl(route);
    }
  }

  isUserAdmin(): boolean {
    if (!isPlatformBrowser(this.platformId)) return false;

    return (
      this.userService.getUserDetails()?.roles?.includes(UserRolesEnum.ADMIN) ||
      false
    );
  }

  isUserWorkflows(): boolean {
    if (!isPlatformBrowser(this.platformId)) return false;

    return (
      this.userService
        .getUserDetails()
        ?.roles?.includes(UserRolesEnum.WORKFLOWS) || false
    );
  }

  /**
   * Fetches the profile the backend derives from the token and caches it.
   *
   * The backend is the source of truth for roles, so this runs on every
   * login rather than trusting whatever is already in localStorage.
   */
  syncUserWithBackend$(token: string): Observable<UserModel> {
    const headers = new HttpHeaders().set('Authorization', `Bearer ${token}`);
    return this.httpClient
      .get<UserModel>(`${environment.backendURL}/users/me`, {headers})
      .pipe(
        tap((userDetails: UserModel) => {
          if (isPlatformBrowser(this.platformId)) {
            localStorage.setItem(USER_DETAILS, JSON.stringify(userDetails));
          }
        }),
        catchError((error: HttpErrorResponse) => {
          console.error('Failed to sync user with backend', error);
          return throwError(
            () =>
              new Error(
                error?.error?.detail ||
                  'Could not synchronize your user profile with the server.',
              ),
          );
        }),
      );
  }

  private clearLocalSession(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    localStorage.removeItem(USER_DETAILS);
    localStorage.removeItem('showTooltip');
  }

  /**
   * Starts the token auto-renew service exactly once.
   *
   * Deferred rather than done in the constructor because AuthService is
   * constructed during SSR hydration too, and start() schedules timers.
   */
  private ensureStarted(): void {
    if (this.started || !this.oktaAuth) return;
    this.started = true;
    void this.oktaAuth.start();
  }
}
