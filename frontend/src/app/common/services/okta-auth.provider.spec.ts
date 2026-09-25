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
  let injector: jasmine.SpyObj<Injector>;

  beforeEach(() => {
    injector = jasmine.createSpyObj<Injector>('Injector', ['get']);
  });

  it('returns null on the server, where there is no localStorage', () => {
    expect(oktaAuthFactory('server', injector)).toBeNull();
  });

  // A custom authorization server defines no `groups` scope, and rejects a
  // request for any scope it does not define with invalid_scope. Asking for
  // it does not merely fail to produce the claim, it fails the token request
  // and nobody can log in at all. The claim comes from the authorization
  // server's own `groups` claim instead, emitted unconditionally into the
  // access token. This is pinned because the phase 1 org-server setup did
  // need the scope, so re-adding it looks like a fix.
  it('does not request a groups scope the custom auth server rejects', () => {
    const issuer = environment.okta.issuer;
    const clientId = environment.okta.clientId;
    environment.okta.issuer = 'https://your-org.okta.com/oauth2/example';
    environment.okta.clientId = '0oaTestClientId123';

    try {
      const auth = oktaAuthFactory('browser', injector);

      expect(auth!.options.scopes).not.toContain('groups');
      expect(auth!.options.scopes).toContain('openid');
      expect(auth!.options.scopes).toContain('offline_access');
    } finally {
      environment.okta.issuer = issuer;
      environment.okta.clientId = clientId;
    }
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
