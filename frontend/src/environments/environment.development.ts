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
    // Analytics only. Firebase Auth is no longer used. Left blank locally so
    // dev traffic does not land in the production Analytics property.
    apiKey: '',
    authDomain: '',
    projectId: '',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
    measurementId: '',
  },
  production: false,
  isLocal: true,
  backendURL: 'http://localhost:8080/api',
  EMAIL_REGEX:
    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/,
  ADMIN: 'admin',
  // Shown wherever a user has no Okta profile picture. Okta does not serve
  // avatars, so in practice this is every user.
  defaultAvatarUrl: 'assets/images/default-profile-picture.svg',
  okta: {
    issuer: 'https://weather.okta.com',
    // The Creative Studio SPA client ID. Not a secret: it is public by
    // design in a PKCE flow. Fill this in from the Okta app once it exists.
    clientId: '',
    // Relative paths are resolved against window.location.origin at runtime,
    // so the same value works for localhost and every deployed host.
    redirectUri: '/login/callback',
    postLogoutRedirectUri: '/login',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    pkce: true,
    // Phase 1 sends the ID token, because Okta API Access Management is not
    // yet active in the tenant. Phase 2 flips this to 'access' once a custom
    // authorization server exists. That is the only frontend change required.
    tokenForApi: 'id' as 'id' | 'access',
  },
};
