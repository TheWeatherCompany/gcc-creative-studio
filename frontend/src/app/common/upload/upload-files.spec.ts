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

import {
  extractFiles,
  extractUri,
  matchesAccept,
  nameClipboardFile,
  partitionByAccept,
  withInferredType,
} from './upload-files';

function file(name: string, type: string): File {
  return new File(['x'], name, {type});
}

describe('upload-files', () => {
  describe('extractFiles', () => {
    it('returns every file in the transfer, not just the first', () => {
      const dt = new DataTransfer();
      dt.items.add(file('a.png', 'image/png'));
      dt.items.add(file('b.png', 'image/png'));
      expect(extractFiles(dt).map(f => f.name)).toEqual(['a.png', 'b.png']);
    });

    it('returns nothing for a text-only transfer', () => {
      const dt = new DataTransfer();
      dt.setData('text/plain', 'hello');
      expect(extractFiles(dt)).toEqual([]);
    });

    it('falls back to items when files is empty', () => {
      const dropped = file('a.png', 'image/png');
      const dt = {
        files: [],
        items: [{kind: 'file', getAsFile: () => dropped}],
      } as unknown as DataTransfer;
      expect(extractFiles(dt)).toEqual([dropped]);
    });

    it('fills in a missing MIME type from the extension', () => {
      const dt = new DataTransfer();
      dt.items.add(file('clip.mov', ''));
      expect(extractFiles(dt)[0].type).toBe('video/quicktime');
    });
  });

  describe('extractUri', () => {
    it('skips comment lines in text/uri-list', () => {
      const dt = new DataTransfer();
      dt.setData(
        'text/uri-list',
        '# dragged from a page\r\nhttps://example.com/cat.png\r\n',
      );
      expect(extractUri(dt)).toBe('https://example.com/cat.png');
    });

    it('returns null when there is no URL', () => {
      expect(extractUri(new DataTransfer())).toBeNull();
    });
  });

  describe('matchesAccept', () => {
    it('matches wildcards, exact types and extensions', () => {
      expect(matchesAccept(file('a.png', 'image/png'), 'image/*')).toBeTrue();
      expect(matchesAccept(file('a.mp4', 'video/mp4'), 'image/*')).toBeFalse();
      expect(matchesAccept(file('a.mp4', 'video/mp4'), 'video/mp4')).toBeTrue();
      expect(
        matchesAccept(file('a.FLAC', 'audio/x-flac'), 'audio/mpeg,.flac'),
      ).toBeTrue();
    });

    it('ignores case in accept tokens, as the input attribute does', () => {
      expect(matchesAccept(file('a.png', 'image/png'), 'IMAGE/*')).toBeTrue();
      expect(matchesAccept(file('a.png', 'image/png'), '.PNG')).toBeTrue();
    });

    it('accepts anything when accept is empty', () => {
      expect(matchesAccept(file('a.pdf', 'application/pdf'), '')).toBeTrue();
      expect(matchesAccept(file('a.pdf', 'application/pdf'), null)).toBeTrue();
    });
  });

  it('partitionByAccept keeps order within each side', () => {
    const png = file('a.png', 'image/png');
    const mp4 = file('b.mp4', 'video/mp4');
    const jpg = file('c.jpg', 'image/jpeg');
    expect(partitionByAccept([png, mp4, jpg], 'image/*')).toEqual({
      accepted: [png, jpg],
      rejected: [mp4],
    });
  });

  describe('withInferredType', () => {
    it('leaves a typed file alone', () => {
      const f = file('a.png', 'image/png');
      expect(withInferredType(f)).toBe(f);
    });

    it('leaves unknown or missing extensions untouched', () => {
      for (const name of ['a.xyz', 'png']) {
        const f = file(name, '');
        expect(withInferredType(f)).toBe(f);
      }
    });
  });

  describe('nameClipboardFile', () => {
    const now = new Date(2026, 8, 30, 11, 45, 1);

    it('renames the generic browser clipboard name', () => {
      expect(nameClipboardFile(file('image.png', 'image/png'), now).name).toBe(
        'pasted-2026-09-30-114501.png',
      );
    });

    it('keeps a real filename', () => {
      for (const name of ['storyboard.jpg', 'my-image.png', 'image.png.bak']) {
        const f = file(name, 'image/png');
        expect(nameClipboardFile(f, now)).toBe(f);
      }
    });
  });
});
