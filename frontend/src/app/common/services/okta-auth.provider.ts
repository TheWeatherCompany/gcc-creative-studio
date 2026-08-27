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
import {
  FactoryProvider,
  Injector,
  InjectionToken,
  PLATFORM_ID,
} from '@angular/core';
import {Router} from '@angular/router';
import {OktaAuth} from '@okta/okta-auth-js';
import {environment} from '../../../environments/environment';

/**
 * The OktaAuth client, or null when rendering on the server.
 *
 * Null on the server is not a degraded mode to work around: OktaAuth's token
 * manager reads and writes localStorage in its constructor path, so there is
 * nothing sensible for it to do without a browser. Every call site already
 * has to guard on isPlatformBrowser anyway.
 */
export const OKTA_AUTH = new InjectionToken<OktaAuth | null>('okta.auth');

/**
 * Resolves a configured URI against the current origin.
 *
 * Redirect URIs are stored as paths so that one build works on localhost and
 * on every deployed host without a per-environment placeholder.
 */
export function resolveRedirectUri(pathOrUrl: string): string {
  if (/^https?:\/\//.test(pathOrUrl)) {
    return pathOrUrl;
  }
  const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
  return `${window.location.origin}${path}`;
}

export function oktaAuthFactory(
  platformId: Object,
  injector: Injector,
): OktaAuth | null {
  if (!isPlatformBrowser(platformId)) {
    return null;
  }

  const config = environment.okta;

  return new OktaAuth({
    issuer: config.issuer,
    clientId: config.clientId,
    redirectUri: resolveRedirectUri(config.redirectUri),
    postLogoutRedirectUri: resolveRedirectUri(config.postLogoutRedirectUri),
    scopes: [...config.scopes],
    pkce: config.pkce,
    // Keeps tokens fresh in the background so a long-lived tab does not
    // start 401ing an hour in.
    services: {autoRenew: true, autoRemove: true},
    // Without this, okta-auth-js finishes the login by calling
    // window.location.replace, which throws away the SPA and reloads it.
    // Routing through Angular keeps the callback a normal navigation.
    restoreOriginalUri: async (_oktaAuth, originalUri) => {
      const router = injector.get(Router);
      await router.navigateByUrl(originalUri || '/');
    },
  });
}

export const OKTA_AUTH_PROVIDER: FactoryProvider = {
  provide: OKTA_AUTH,
  useFactory: oktaAuthFactory,
  deps: [PLATFORM_ID, Injector],
};
