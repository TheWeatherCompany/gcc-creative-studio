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
import {HttpTestingController} from '@angular/common/http/testing';
import {TestBed, fakeAsync, tick} from '@angular/core/testing';
import {Router} from '@angular/router';
import {environment} from '../../../environments/environment';
import {UserRolesEnum} from '../models/user.model';
import {AuthService} from './auth.service';
import {OKTA_AUTH} from './okta-auth.provider';
import {UserService} from './user.service';

/**
 * A stand-in for OktaAuth covering only the surface AuthService touches.
 *
 * Exported so the guard, interceptor and callback specs share one shape;
 * three drifting copies of this would be worse than the coupling.
 */
export class FakeOktaAuth {
  options = {postLogoutRedirectUri: 'http://localhost:4200/login'};

  idToken: {idToken: string; expiresAt: number} | undefined = {
    idToken: 'id-token-abc',
    expiresAt: 9999999999,
  };
  accessToken: {accessToken: string} | undefined = {
    accessToken: 'access-token-xyz',
  };
  refreshToken: {refreshToken: string} | undefined = undefined;
  expired = false;
  originalUri: string | undefined = undefined;

  tokenManager = {
    getTokens: () => Promise.resolve(this.tokens()),
    getTokensSync: () => this.tokens(),
    hasExpired: () => this.expired,
    renew: jasmine
      .createSpy('renew')
      .and.callFake(() =>
        Promise.resolve({idToken: 'renewed-id-token', expiresAt: 9999999999}),
      ),
    clear: jasmine.createSpy('clear'),
  };

  signInWithRedirect = jasmine
    .createSpy('signInWithRedirect')
    .and.returnValue(Promise.resolve());
  storeTokensFromRedirect = jasmine
    .createSpy('storeTokensFromRedirect')
    .and.returnValue(Promise.resolve());
  signOut = jasmine.createSpy('signOut').and.returnValue(Promise.resolve(true));
  start = jasmine.createSpy('start').and.returnValue(Promise.resolve());
  getOrRenewAccessToken = jasmine
    .createSpy('getOrRenewAccessToken')
    .and.callFake(() => Promise.resolve('renewed-access-token'));

  setOriginalUri = jasmine
    .createSpy('setOriginalUri')
    .and.callFake((uri: string) => {
      this.originalUri = uri;
    });
  getOriginalUri = () => this.originalUri;
  removeOriginalUri = jasmine.createSpy('removeOriginalUri');

  getIdToken = () => this.idToken?.idToken;
  getAccessToken = () => this.accessToken?.accessToken;

  private tokens() {
    return {
      idToken: this.idToken,
      accessToken: this.accessToken,
      refreshToken: this.refreshToken,
    };
  }
}

describe('AuthService', () => {
  let service: AuthService;
  let okta: FakeOktaAuth;
  let http: HttpTestingController;
  let router: jasmine.SpyObj<Router>;
  let userDetails: {roles: UserRolesEnum[]} | null;

  const originalTokenForApi = environment.okta.tokenForApi;

  beforeEach(() => {
    okta = new FakeOktaAuth();
    userDetails = null;
    router = jasmine.createSpyObj('Router', ['navigateByUrl']);
    router.navigateByUrl.and.returnValue(Promise.resolve(true));

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        AuthService,
        {provide: Router, useValue: router},
        {provide: UserService, useValue: {getUserDetails: () => userDetails}},
        {provide: OKTA_AUTH, useValue: okta},
      ],
    });
    service = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
    localStorage.clear();
  });

  afterEach(() => {
    environment.okta.tokenForApi = originalTokenForApi;
    localStorage.clear();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  describe('login', () => {
    it('stashes the return URL and redirects to Okta', async () => {
      await service.login('/workflows/new');

      expect(okta.setOriginalUri).toHaveBeenCalledWith('/workflows/new');
      expect(okta.signInWithRedirect).toHaveBeenCalled();
    });

    it('defaults the return URL to the home page', async () => {
      await service.login();

      expect(okta.setOriginalUri).toHaveBeenCalledWith('/');
    });
  });

  describe('handleCallback', () => {
    // storeTokensFromRedirect() and the token lookup are both promise-based,
    // so the /users/me request only goes out after the microtask queue drains.
    it('stores tokens, syncs the profile and emits the original URL', fakeAsync(() => {
      okta.originalUri = '/gallery';
      const emitted: string[] = [];

      service.handleCallback().subscribe(url => emitted.push(url));
      tick();

      const req = http.expectOne(`${environment.backendURL}/users/me`);
      expect(req.request.headers.get('Authorization')).toBe(
        'Bearer id-token-abc',
      );
      req.flush({email: 'a@b.com', roles: ['user']});
      tick();

      expect(okta.storeTokensFromRedirect).toHaveBeenCalled();
      expect(emitted).toEqual(['/gallery']);
      expect(okta.removeOriginalUri).toHaveBeenCalled();
      expect(localStorage.getItem('USER_DETAILS')).toContain('a@b.com');
    }));

    it('falls back to the home page when no original URL was stored', fakeAsync(() => {
      const emitted: string[] = [];

      service.handleCallback().subscribe(url => emitted.push(url));
      tick();
      http
        .expectOne(`${environment.backendURL}/users/me`)
        .flush({email: 'a@b.com'});
      tick();

      expect(emitted).toEqual(['/']);
    }));

    it('errors when Okta produced no usable token', fakeAsync(() => {
      okta.idToken = undefined;
      const errors: Error[] = [];

      service.handleCallback().subscribe({error: e => errors.push(e)});
      tick();

      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('no usable token');
      http.expectNone(`${environment.backendURL}/users/me`);
    }));

    it('propagates a backend rejection so the user is not left signed in', fakeAsync(() => {
      spyOn(console, 'error');
      const errors: Error[] = [];

      service.handleCallback().subscribe({error: e => errors.push(e)});
      tick();
      http
        .expectOne(`${environment.backendURL}/users/me`)
        .flush(
          {detail: 'No Creative Studio group assigned.'},
          {status: 403, statusText: 'Forbidden'},
        );
      tick();

      expect(errors.length).toBe(1);
      expect(errors[0].message).toBe('No Creative Studio group assigned.');
    }));
  });

  describe('getApiToken$', () => {
    /** Collects emissions; a plain `let` gets narrowed by its initializer. */
    const collect = () => {
      const emitted: Array<string | null> = [];
      service.getApiToken$().subscribe(t => emitted.push(t));
      return emitted;
    };

    it('returns the stored ID token when it is still valid', fakeAsync(() => {
      const emitted = collect();
      tick();

      expect(emitted).toEqual(['id-token-abc']);
      expect(okta.tokenManager.renew).not.toHaveBeenCalled();
    }));

    it('renews an expired ID token rather than sending it', fakeAsync(() => {
      okta.expired = true;

      const emitted = collect();
      tick();

      expect(okta.tokenManager.renew).toHaveBeenCalledWith('idToken');
      expect(emitted).toEqual(['renewed-id-token']);
    }));

    it('emits null when there is no session', fakeAsync(() => {
      okta.idToken = undefined;

      const emitted = collect();
      tick();

      expect(emitted).toEqual([null]);
    }));

    it('emits null instead of throwing when renewal fails', fakeAsync(() => {
      okta.expired = true;
      okta.tokenManager.renew.and.returnValue(
        Promise.reject(new Error('login_required')),
      );
      const emitted: Array<string | null> = [];
      let errored = false;

      service.getApiToken$().subscribe({
        next: t => emitted.push(t),
        error: () => (errored = true),
      });
      tick();

      expect(errored).toBeFalse();
      expect(emitted).toEqual([null]);
    }));

    it('uses the access token once tokenForApi is flipped to access', fakeAsync(() => {
      environment.okta.tokenForApi = 'access';

      const emitted = collect();
      tick();

      expect(okta.getOrRenewAccessToken).toHaveBeenCalled();
      expect(emitted).toEqual(['renewed-access-token']);
    }));

    it('starts the auto-renew service only once', fakeAsync(() => {
      service.getApiToken$().subscribe();
      service.getApiToken$().subscribe();
      tick();

      expect(okta.start).toHaveBeenCalledTimes(1);
    }));
  });

  describe('isLoggedIn', () => {
    it('is true for an unexpired token', () => {
      expect(service.isLoggedIn()).toBeTrue();
    });

    it('is false with no token at all', () => {
      okta.idToken = undefined;

      expect(service.isLoggedIn()).toBeFalse();
    });

    it('is true for an expired token when a refresh token remains', () => {
      okta.expired = true;
      okta.refreshToken = {refreshToken: 'refresh-abc'};

      expect(service.isLoggedIn()).toBeTrue();
    });

    it('is false for an expired token with nothing to renew it', () => {
      okta.expired = true;

      expect(service.isLoggedIn()).toBeFalse();
    });

    it('never navigates: asking the question must not move the user', () => {
      okta.idToken = undefined;

      service.isLoggedIn();

      expect(router.navigateByUrl).not.toHaveBeenCalled();
    });
  });

  describe('logout', () => {
    it('clears the cached profile and ends the Okta session', async () => {
      localStorage.setItem('USER_DETAILS', '{"email":"a@b.com"}');
      localStorage.setItem('showTooltip', 'true');

      await service.logout();

      expect(localStorage.getItem('USER_DETAILS')).toBeNull();
      expect(localStorage.getItem('showTooltip')).toBeNull();
      expect(okta.signOut).toHaveBeenCalled();
    });

    it('still clears tokens locally when the Okta round trip fails', async () => {
      okta.signOut.and.returnValue(Promise.reject(new Error('network down')));
      spyOn(console, 'error');

      await service.logout();

      expect(okta.tokenManager.clear).toHaveBeenCalled();
      expect(router.navigateByUrl).toHaveBeenCalledWith('/login');
    });
  });

  describe('role helpers', () => {
    it('reads admin from the cached profile', () => {
      userDetails = {roles: [UserRolesEnum.ADMIN]};

      expect(service.isUserAdmin()).toBeTrue();
      expect(service.isUserWorkflows()).toBeFalse();
    });

    it('reads workflows from the cached profile', () => {
      userDetails = {roles: [UserRolesEnum.WORKFLOWS]};

      expect(service.isUserWorkflows()).toBeTrue();
      expect(service.isUserAdmin()).toBeFalse();
    });

    it('is false when there is no cached profile', () => {
      expect(service.isUserAdmin()).toBeFalse();
      expect(service.isUserWorkflows()).toBeFalse();
    });
  });
});
