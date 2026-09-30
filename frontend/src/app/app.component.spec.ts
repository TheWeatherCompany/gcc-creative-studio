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

import {TestBed} from '@angular/core/testing';
import {RouterTestingModule} from '@angular/router/testing';
import {AppComponent} from './app.component';
import {LoadingService} from './common/services/loading.service';
import {of} from 'rxjs';
import {NO_ERRORS_SCHEMA} from '@angular/core';

describe('AppComponent', () => {
  let loadingServiceMock: any;

  beforeEach(async () => {
    loadingServiceMock = {
      isLoading$: of(false),
    };

    await TestBed.configureTestingModule({
      imports: [RouterTestingModule],
      declarations: [AppComponent],
      providers: [{provide: LoadingService, useValue: loadingServiceMock}],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it("should have as title 'creative-studio'", () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app.title).toEqual('creative-studio');
  });

  describe('stray file drops', () => {
    function dispatchOnWindow(type: string, dt: DataTransfer): DragEvent {
      const event = new DragEvent(type, {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      });
      window.dispatchEvent(event);
      return event;
    }

    function fileTransfer(): DataTransfer {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'a.png', {type: 'image/png'}));
      return dt;
    }

    it('stops the browser opening a file dropped outside every zone', () => {
      TestBed.createComponent(AppComponent);
      expect(
        dispatchOnWindow('dragover', fileTransfer()).defaultPrevented,
      ).toBeTrue();
      expect(
        dispatchOnWindow('drop', fileTransfer()).defaultPrevented,
      ).toBeTrue();
    });

    it('leaves drags without files alone', () => {
      TestBed.createComponent(AppComponent);
      const dt = new DataTransfer();
      dt.setData('application/json', '{"mediaItemIds":[1]}');
      expect(dispatchOnWindow('dragover', dt).defaultPrevented).toBeFalse();
      expect(dispatchOnWindow('drop', dt).defaultPrevented).toBeFalse();
    });
  });
});
