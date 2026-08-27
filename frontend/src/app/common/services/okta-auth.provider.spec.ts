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

describe('oktaAuthFactory', () => {
  let injector: jasmine.SpyObj<Injector>;

  beforeEach(() => {
    injector = jasmine.createSpyObj<Injector>('Injector', ['get']);
  });

  it('returns null on the server, where there is no localStorage', () => {
    expect(oktaAuthFactory('server', injector)).toBeNull();
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
