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
    // `groups` is load-bearing, not decorative. The Okta app emits the
    // `groups` claim only when this scope is requested, and the backend maps
    // that claim to application roles. Without it the ID token still verifies
    // and still identifies the user, so login appears to succeed and then
    // every request is refused with a 403 naming groups the user is already
    // in. Removing it breaks authorization for the whole tenant at once.
    scopes: ['openid', 'profile', 'email', 'offline_access', 'groups'],
    pkce: true,
    // Phase 1 sends the ID token, because Okta API Access Management is not
    // yet active in the tenant. Phase 2 flips this to 'access' once a custom
    // authorization server exists. That is the only frontend change required.
    tokenForApi: 'id' as 'id' | 'access',
  },
};
