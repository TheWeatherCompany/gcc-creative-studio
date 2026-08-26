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

import {HTTP_INTERCEPTORS, HttpClient} from '@angular/common/http';
import {
  HttpClientTestingModule,
  HttpTestingController,
} from '@angular/common/http/testing';
import {TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {environment} from '../environments/environment';
import {AuthInterceptor} from './auth.interceptor';
import {AuthService} from './common/services/auth.service';

describe('AuthInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let authService: jasmine.SpyObj<AuthService>;

  beforeEach(() => {
    authService = jasmine.createSpyObj('AuthService', [
      'getApiToken$',
      'login',
    ]);
    authService.getApiToken$.and.returnValue(of('a-token'));
    authService.login.and.returnValue(Promise.resolve());

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        {provide: AuthService, useValue: authService},
        {provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true},
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('attaches the bearer token to backend requests', () => {
    http.get(`${environment.backendURL}/users/me`).subscribe();

    const req = httpMock.expectOne(`${environment.backendURL}/users/me`);
    expect(req.request.headers.get('Authorization')).toBe('Bearer a-token');
    req.flush({});
  });

  it('leaves non-backend requests alone', () => {
    http.get('https://storage.googleapis.com/some-asset.png').subscribe();

    const req = httpMock.expectOne(
      'https://storage.googleapis.com/some-asset.png',
    );
    expect(req.request.headers.has('Authorization')).toBeFalse();
    expect(authService.getApiToken$).not.toHaveBeenCalled();
    req.flush({});
  });

  it('sends the request unauthenticated rather than blocking it when there is no token', () => {
    authService.getApiToken$.and.returnValue(of(null));

    http.get(`${environment.backendURL}/gallery`).subscribe({error: () => {}});

    const req = httpMock.expectOne(`${environment.backendURL}/gallery`);
    expect(req.request.headers.has('Authorization')).toBeFalse();
    req.flush({});
  });

  it('triggers re-authentication on a 401 from the backend', () => {
    http.get(`${environment.backendURL}/users/me`).subscribe({error: () => {}});

    httpMock
      .expectOne(`${environment.backendURL}/users/me`)
      .flush({}, {status: 401, statusText: 'Unauthorized'});

    expect(authService.login).toHaveBeenCalled();
  });

  it('does not re-authenticate on other backend errors', () => {
    http.get(`${environment.backendURL}/users/me`).subscribe({error: () => {}});

    httpMock
      .expectOne(`${environment.backendURL}/users/me`)
      .flush({}, {status: 500, statusText: 'Server Error'});

    expect(authService.login).not.toHaveBeenCalled();
  });
});
