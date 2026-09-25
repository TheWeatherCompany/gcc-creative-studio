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
 * caller can tell the user; it never falls back to opening a new tab.
 */
export async function downloadMedia(
  url: string,
  baseName: string,
  fallbackMimeType?: string,
): Promise<void> {
  // no-store: an <img>/<video> may already have cached this URL from a
  // non-CORS request, and reusing that cached response would fail the CORS
  // check.
  const response = await fetch(url, {cache: 'no-store'});
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
