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

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
};

const KNOWN_EXTENSIONS = new Set(Object.values(EXTENSION_BY_MIME));

// FileSaver.js waits 40s before revoking: revoking straight after click()
// can cancel the save in some browsers before it has read the blob.
const REVOKE_DELAY_MS = 40_000;

function extensionFromMime(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  return EXTENSION_BY_MIME[mime.split(';')[0].trim().toLowerCase()];
}

function extensionFromUrl(url: string): string | undefined {
  let path: string;
  try {
    path = new window.URL(url, window.location.href).pathname;
  } catch {
    return undefined;
  }
  const lastSegment = decodeURIComponent(path.split('/').pop() ?? '');
  const dot = lastSegment.lastIndexOf('.');
  if (dot < 0) return undefined;
  const ext = lastSegment.substring(dot + 1).toLowerCase();
  if (ext === 'jpeg') return 'jpg';
  return KNOWN_EXTENSIONS.has(ext) ? ext : undefined;
}

/**
 * Thrown when the signed URL can no longer be used. Retrying cannot help:
 * the page holds the same URL until it reloads and asks the backend for a
 * fresh one.
 */
export class DownloadLinkExpiredError extends Error {
  constructor() {
    super('The download link has expired');
    this.name = 'DownloadLinkExpiredError';
  }
}

/**
 * True when a V4 signed URL (X-Goog-Date plus X-Goog-Expires) is past its
 * expiry. URLs without those parameters are never treated as expired.
 */
export function isSignedUrlExpired(url: string, now = Date.now()): boolean {
  let search: string;
  try {
    search = new window.URL(url, window.location.href).search;
  } catch {
    return false;
  }
  const params = new window.URLSearchParams(search);
  const date = params.get('X-Goog-Date');
  const expires = Number(params.get('X-Goog-Expires'));
  const match = date?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!match || !Number.isFinite(expires) || expires <= 0) return false;
  const [, y, mo, d, h, mi, sec] = match.map(Number);
  const signedAt = Date.UTC(y, mo - 1, d, h, mi, sec);
  return now >= signedAt + expires * 1000;
}

/**
 * Builds the name the file is saved under. Object names in the bucket are
 * mostly bare UUIDs (some with no extension at all), so the base name comes
 * from the caller and only the extension is derived: the served
 * Content-Type first, then the object path, then the item's own MIME type.
 */
export function buildDownloadFilename(
  baseName: string,
  url: string,
  servedMimeType?: string,
  fallbackMimeType?: string,
): string {
  const ext =
    extensionFromMime(servedMimeType) ??
    extensionFromUrl(url) ??
    extensionFromMime(fallbackMimeType);
  return ext ? `${baseName}.${ext}` : baseName;
}

/**
 * Saves the file at `url` to disk instead of navigating to it.
 *
 * Media URLs are cross-origin GCS signed URLs, and browsers ignore the
 * `download` attribute on cross-origin links, so the file is fetched (the
 * bucket's CORS policy allows GET from any origin) and saved from a
 * same-origin object URL. Rejects on any network or HTTP failure so the
 * caller can tell the user; it never falls back to opening a new tab. An
 * expired or rejected signature rejects with DownloadLinkExpiredError.
 */
export async function downloadMedia(
  url: string,
  baseName: string,
  fallbackMimeType?: string,
): Promise<void> {
  // no-store: an <img>/<video> may already have cached this URL from a
  // non-CORS request, and reusing that cached response would fail the CORS
  // check.
  // Checked up front as well as from the status, so an expired link is
  // recognised without a round trip and whatever status GCS picks for it.
  if (isSignedUrlExpired(url)) {
    throw new DownloadLinkExpiredError();
  }
  const response = await fetch(url, {cache: 'no-store'});
  // GCS answers an expired signature with 400 ExpiredToken and a bad one
  // with 403 SignatureDoesNotMatch.
  if (response.status === 400 || response.status === 403) {
    throw new DownloadLinkExpiredError();
  }
  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status})`);
  }
  const blob = await response.blob();
  const objectUrl = window.URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = buildDownloadFilename(
    baseName,
    url,
    blob.type || response.headers.get('Content-Type') || undefined,
    fallbackMimeType,
  );
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(() => window.URL.revokeObjectURL(objectUrl), REVOKE_DELAY_MS);
}
