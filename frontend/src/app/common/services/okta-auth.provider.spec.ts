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

import {Injector} from '@angular/core';
import {oktaAuthFactory, resolveRedirectUri} from './okta-auth.provider';
import {environment} from '../../../environments/environment';

describe('oktaAuthFactory', () => {
  const browserPlatformId = 'browser';
  let injector: jasmine.SpyObj<Injector>;

  beforeEach(() => {
    injector = jasmine.createSpyObj<Injector>('Injector', ['get']);
    environment.okta.issuer = 'https://your-org.okta.com';
    environment.okta.clientId = '0oaTestClientId123';
  });

  it('returns null on the server, where there is no localStorage', () => {
    expect(oktaAuthFactory('server', injector)).toBeNull();
  });

  // Regression guard. Okta's org authorization server returns a thin ID token
  // when an access token is issued in the same flow, and a thin ID token has
  // no `groups` claim. Nothing about that surfaces at login: the user signs in
  // successfully and is then refused by the backend with a 403, so only a test
  // at this level catches a reintroduction.
  describe('token request shape', () => {
    it('requests only an ID token while the ID token authorises the API', () => {
      environment.okta.tokenForApi = 'id';

      const auth = oktaAuthFactory(browserPlatformId, injector);

      expect(auth!.options.responseType).toEqual(['id_token']);
    });

    it('does not request an access token it would never read', () => {
      environment.okta.tokenForApi = 'id';

      const auth = oktaAuthFactory(browserPlatformId, injector);

      expect(auth!.options.responseType).not.toContain('token');
    });

    it('requests the access token once phase 2 authorises with it', () => {
      environment.okta.tokenForApi = 'access';

      const auth = oktaAuthFactory(browserPlatformId, injector);

      expect(auth!.options.responseType).toContain('token');
    });
  });

  afterEach(() => {
    environment.okta.tokenForApi = 'id';
  });
});

describe('resolveRedirectUri', () => {
  it('resolves a path against the current origin', () => {
    expect(resolveRedirectUri('/login/callback')).toBe(
      `${window.location.origin}/login/callback`,
    );
  });

  it('adds the leading slash a caller forgot', () => {
    expect(resolveRedirectUri('login/callback')).toBe(
      `${window.location.origin}/login/callback`,
    );
  });

  it('leaves an absolute URL alone', () => {
    expect(
      resolveRedirectUri('https://gcs.corp.weather.com/login/callback'),
    ).toBe('https://gcs.corp.weather.com/login/callback');
  });
});
