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
  HttpErrorResponse,
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
} from '@angular/common/http';
import {Injectable} from '@angular/core';
import {Observable, throwError} from 'rxjs';
import {catchError, switchMap} from 'rxjs/operators';
import {environment} from '../environments/environment';
import {AuthService} from './common/services/auth.service';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private authService: AuthService) {}

  intercept(
    request: HttpRequest<unknown>,
    next: HttpHandler,
  ): Observable<HttpEvent<unknown>> {
    // Only our own API gets the bearer token. The previous version attached
    // it to every outbound HttpClient call, which leaked the user's token to
    // any third-party URL the app happened to fetch.
    if (!this.isBackendRequest(request.url)) {
      return next.handle(request);
    }

    return this.authService.getApiToken$().pipe(
      switchMap(token => {
        const authorized = token
          ? request.clone({
              setHeaders: {Authorization: `Bearer ${token}`},
            })
          : request;
        return next.handle(authorized);
      }),
      catchError(error => {
        // A 401 from our own API means the token is gone or no longer
        // accepted. Re-authenticate rather than silently signing out, so the
        // user lands back where they were instead of on an empty login page.
        if (error instanceof HttpErrorResponse && error.status === 401) {
          void this.authService.login(this.currentUrl());
        }
        return throwError(() => error);
      }),
    );
  }

  private isBackendRequest(url: string): boolean {
    // backendURL is absolute locally ("http://localhost:8080/api") and
    // relative when deployed, where Firebase Hosting rewrites /api/** to
    // Cloud Run. Request URLs come through in the same shape either way.
    const backendUrl = environment.backendURL;
    return !!backendUrl && url.startsWith(backendUrl);
  }

  private currentUrl(): string {
    return typeof window === 'undefined'
      ? '/'
      : `${window.location.pathname}${window.location.search}`;
  }
}
