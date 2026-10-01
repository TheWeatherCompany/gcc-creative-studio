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

import {isSubmitEnter} from './prompt-submit';

describe('isSubmitEnter', () => {
  const cases: {
    name: string;
    init: KeyboardEventInit;
    keyCode?: number;
    submits: boolean;
  }[] = [
    {name: 'plain Enter', init: {key: 'Enter'}, submits: true},
    {name: 'Shift+Enter', init: {key: 'Enter', shiftKey: true}, submits: false},
    {
      name: 'an IME-confirming Enter',
      init: {key: 'Enter', isComposing: true},
      submits: false,
    },
    {
      name: 'Safari IME Enter (keyCode 229)',
      init: {key: 'Enter'},
      keyCode: 229,
      submits: false,
    },
    {name: 'another key', init: {key: 'a'}, submits: false},
    // Ctrl, Meta and Alt are left to the caller's template binding.
    {name: 'Ctrl+Enter', init: {key: 'Enter', ctrlKey: true}, submits: true},
    {name: 'Meta+Enter', init: {key: 'Enter', metaKey: true}, submits: true},
    {name: 'Alt+Enter', init: {key: 'Enter', altKey: true}, submits: true},
  ];
  for (const c of cases) {
    it(`${c.name} ${c.submits ? 'submits' : 'does not submit'}`, () => {
      const event = new KeyboardEvent('keydown', c.init);
      if (c.keyCode !== undefined) {
        Object.defineProperty(event, 'keyCode', {get: () => c.keyCode});
      }
      expect(isSubmitEnter(event)).toBe(c.submits);
    });
  }
});
