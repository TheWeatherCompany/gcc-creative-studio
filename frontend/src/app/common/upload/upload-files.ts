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

// Browsers leave File.type empty for some drags (notably from Windows
// Explorer and for newer formats). The backend picks its processing path
// from the MIME type, so an untyped video would be handled as an image.
const EXTENSION_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
};

// Chrome and Firefox name every clipboard image "image.<ext>".
const GENERIC_CLIPBOARD_NAME = /^image\.(\w+)$/i;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

export function withInferredType(file: File): File {
  if (file.type) return file;
  const type = EXTENSION_TYPES[extensionOf(file.name)];
  if (!type) return file;
  return new File([file], file.name, {type, lastModified: file.lastModified});
}

export function extractFiles(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const files =
    dt.files && dt.files.length > 0
      ? Array.from(dt.files)
      : Array.from(dt.items ?? [])
          .filter(item => item.kind === 'file')
          .map(item => item.getAsFile())
          .filter((f): f is File => f !== null);
  return files.map(withInferredType);
}

export function extractUri(dt: DataTransfer | null | undefined): string | null {
  const list = dt?.getData('text/uri-list') ?? '';
  return (
    list
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line && !line.startsWith('#')) ?? null
  );
}

/** Same semantics as the `accept` attribute on <input type="file">. */
export function matchesAccept(
  file: File,
  accept: string | null | undefined,
): boolean {
  const tokens = (accept ?? '')
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const type = file.type.toLowerCase();
  const name = file.name.toLowerCase();
  return tokens.some(token => {
    if (token.startsWith('.')) return name.endsWith(token);
    if (token.endsWith('/*')) return type.startsWith(token.slice(0, -1));
    return type === token;
  });
}

export function partitionByAccept(
  files: File[],
  accept: string | null | undefined,
): {accepted: File[]; rejected: File[]} {
  const accepted: File[] = [];
  const rejected: File[] = [];
  for (const f of files) {
    (matchesAccept(f, accept) ? accepted : rejected).push(f);
  }
  return {accepted, rejected};
}

export function nameClipboardFile(file: File, now = new Date()): File {
  const match = GENERIC_CLIPBOARD_NAME.exec(file.name);
  if (!match) return file;
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return new File([file], `pasted-${stamp}.${match[1].toLowerCase()}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}
