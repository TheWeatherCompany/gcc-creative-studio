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

import {buildDownloadFilename} from './download-media';

describe('buildDownloadFilename', () => {
  const signed = (path: string) =>
    `https://storage.googleapis.com/bucket/${path}?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=abc.def`;

  // Some image objects are stored as a bare UUID with no extension, so the
  // saved file would not open without one taken from the Content-Type.
  it('takes the extension from the served type when the object has none', () => {
    expect(
      buildDownloadFilename(
        'creative-studio-7',
        signed('images/1b2c3d4e'),
        'image/jpeg',
      ),
    ).toBe('creative-studio-7.jpg');
  });

  it('falls back to the object extension when GCS serves a generic type', () => {
    expect(
      buildDownloadFilename(
        'creative-studio-7',
        signed('videos/abc/sample_0.mp4'),
        'application/octet-stream',
      ),
    ).toBe('creative-studio-7.mp4');
  });

  // The signature's query string contains dots; they must not be read as
  // the file extension.
  it('ignores dots in the signed query string', () => {
    expect(
      buildDownloadFilename('creative-studio-7', signed('images/1b2c3d4e'), ''),
    ).toBe('creative-studio-7');
  });
});
