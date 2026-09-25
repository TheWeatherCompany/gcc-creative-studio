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

export const environment = {
  firebase: {
    // Analytics only. Firebase Auth is no longer used.
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
    measurementId: '',
  },
  production: true,
  isLocal: false,
  backendURL: 'http://localhost:8080/api',
  EMAIL_REGEX:
    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
  ADMIN: 'admin',
  // Shown wherever a user has no Okta profile picture. Okta does not serve
  // avatars, so in practice this is every user.
  defaultAvatarUrl: 'assets/images/default-profile-picture.svg',
  okta: {
    // Your Okta org, e.g. 'https://your-org.okta.com'. Left blank so a fork
    // does not inherit someone else's tenant. Deployed builds get this from
    // the _OKTA_ISSUER build substitution; for local development, fill both
    // values in here and leave the change uncommitted. See DEVELOPMENT.md.
    issuer: '',
    clientId: '',
    // Relative paths are resolved against window.location.origin at runtime,
    // so the same value works for localhost and every deployed host.
    redirectUri: '/login/callback',
    postLogoutRedirectUri: '/login',
    // No `groups` scope, on purpose, and do not add one back. Phase 1 needed
    // it because the org authorization server released the app's OIDC group
    // filter only to a request that asked for it. A custom authorization
    // server defines no `groups` scope, and asking one for a scope it does
    // not define is rejected as invalid_scope: the whole token request fails
    // and nobody can log in, which is louder but worse than a missing claim.
    // The claim now comes from the authorization server's own `groups` claim,
    // emitted into the access token unconditionally (condition "Any scope").
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    pkce: true,
    // The access token from the custom authorization server. It carries
    // `aud: api://creative-studio` and the `groups` claim the backend maps to
    // roles; the phase 1 org-server ID token carried the SPA client ID as its
    // audience and no longer validates. This moves with `issuer`, never
    // independently: either alone is a tenant-wide outage.
    tokenForApi: 'access' as 'id' | 'access',
  },
};
