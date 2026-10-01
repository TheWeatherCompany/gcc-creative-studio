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

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {FormsModule} from '@angular/forms';
import {MatButtonModule} from '@angular/material/button';
import {MatButtonToggleModule} from '@angular/material/button-toggle';
import {MatDialogModule} from '@angular/material/dialog';
import {MatDividerModule} from '@angular/material/divider';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatIconModule} from '@angular/material/icon';
import {MatInputModule} from '@angular/material/input';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatSelectModule} from '@angular/material/select';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {Injector} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {BehaviorSubject, Subject, of} from 'rxjs';

import {AudioComponent} from './audio.component';
import {JobStatus, MediaItem} from '../common/models/media-item.model';
import {GalleryService} from '../gallery/gallery.service';
import {AudioStateService} from '../services/audio-state.service';
import {SearchService} from '../services/search/search.service';
import {WorkspaceStateService} from '../services/workspace/workspace-state.service';
import {setAppInjector} from '../app-injector';
import {NotificationService} from '../common/services/notification.service';
import {PROMPT_SUBMIT_HINT} from '../utils/prompt-submit';

describe('AudioComponent prompt submit', () => {
  let component: AudioComponent;
  let fixture: ComponentFixture<AudioComponent>;
  let startAudioGeneration: jasmine.Spy;
  let activeAudioJob: BehaviorSubject<MediaItem | null>;

  beforeEach(async () => {
    localStorage.removeItem('audio_generation_state');
    activeAudioJob = new BehaviorSubject<MediaItem | null>(null);
    startAudioGeneration = jasmine
      .createSpy('startAudioGeneration')
      .and.returnValue(of({}));
    await TestBed.configureTestingModule({
      declarations: [AudioComponent],
      imports: [
        FormsModule,
        MatButtonModule,
        MatButtonToggleModule,
        MatDialogModule,
        MatDividerModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatProgressSpinnerModule,
        MatSelectModule,
        MatSnackBarModule,
        NoopAnimationsModule,
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: SearchService,
          useValue: {
            activeAudioJob$: activeAudioJob.asObservable(),
            startAudioGeneration,
            clearActiveAudioJob: jasmine.createSpy('clearActiveAudioJob'),
          },
        },
        {
          provide: WorkspaceStateService,
          useValue: {getActiveWorkspaceId: () => 1},
        },
        {
          provide: AudioStateService,
          useValue: {
            // The real defaults, so the tests see what a new user gets.
            getState: () => new AudioStateService().getState(),
            updateState: jasmine.createSpy('updateState'),
          },
        },
        {provide: GalleryService, useValue: {}},
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(AudioComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  const promptFields = [
    {name: 'Lyria music prompt', model: 'lyria'},
    {name: 'text to speech prompt', model: 'chirp'},
  ] as const;

  async function showField(model: 'lyria' | 'chirp') {
    component.selectedModel = model;
    component.prompt = 'a calm piano melody';
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.nativeElement.querySelector(
      'textarea',
    ) as HTMLTextAreaElement;
  }

  function pressKey(
    textarea: HTMLTextAreaElement,
    init: KeyboardEventInit,
    keyCode?: number,
  ): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      ...init,
    });
    // KeyboardEvent init ignores keyCode, so override it the way Safari reports it.
    if (keyCode !== undefined) {
      Object.defineProperty(event, 'keyCode', {get: () => keyCode});
    }
    textarea.dispatchEvent(event);
    return event;
  }

  const keys: {
    name: string;
    init: KeyboardEventInit;
    keyCode?: number;
    submits: boolean;
  }[] = [
    {name: 'Enter', init: {}, submits: true},
    {name: 'Ctrl+Enter', init: {ctrlKey: true}, submits: true},
    {name: 'Shift+Enter', init: {shiftKey: true}, submits: false},
    {
      name: 'IME Enter (isComposing)',
      init: {isComposing: true},
      submits: false,
    },
    {name: 'IME Enter (keyCode 229)', init: {}, keyCode: 229, submits: false},
  ];

  for (const field of promptFields) {
    for (const key of keys) {
      it(`${key.name} in the ${field.name} ${
        key.submits
          ? 'submits and is prevented'
          : 'does not submit or get prevented'
      }`, async () => {
        const textarea = await showField(field.model);

        const event = pressKey(textarea, key.init, key.keyCode);

        expect(event.defaultPrevented).toBe(key.submits);
        if (key.submits) {
          expect(startAudioGeneration).toHaveBeenCalledOnceWith(
            jasmine.objectContaining({prompt: 'a calm piano melody'}),
          );
        } else {
          expect(startAudioGeneration).not.toHaveBeenCalled();
        }
      });
    }

    it(`Enter and Ctrl+Enter in the ${field.name} are swallowed while a job is processing`, async () => {
      const textarea = await showField(field.model);
      activeAudioJob.next({status: JobStatus.PROCESSING} as MediaItem);
      fixture.detectChanges();

      const enter = pressKey(textarea, {});
      const ctrlEnter = pressKey(textarea, {ctrlKey: true});

      expect(enter.defaultPrevented).toBe(true);
      expect(ctrlEnter.defaultPrevented).toBe(true);
      expect(startAudioGeneration).not.toHaveBeenCalled();
      const createButton = fixture.nativeElement.querySelector(
        'button.create-btn',
      ) as HTMLButtonElement;
      expect(createButton.disabled).toBe(true);
    });

    it(`a held Enter in the ${field.name} is swallowed without submitting`, async () => {
      const textarea = await showField(field.model);

      const event = pressKey(textarea, {repeat: true});

      expect(event.defaultPrevented).toBe(true);
      expect(startAudioGeneration).not.toHaveBeenCalled();
    });

    it(`a second Enter in the ${field.name} while the request is in flight starts nothing`, async () => {
      const inFlight = new Subject<MediaItem>();
      startAudioGeneration.and.returnValue(inFlight);
      const textarea = await showField(field.model);

      pressKey(textarea, {});
      const second = pressKey(textarea, {});
      pressKey(textarea, {ctrlKey: true});

      expect(startAudioGeneration).toHaveBeenCalledTimes(1);
      expect(second.defaultPrevented).toBe(true);
      fixture.detectChanges();
      const createButton = fixture.nativeElement.querySelector(
        'button.create-btn',
      ) as HTMLButtonElement;
      expect(createButton.disabled).toBe(true);
    });

    it(`Enter in the ${field.name} works again after the request fails`, async () => {
      setAppInjector(TestBed.inject(Injector));
      spyOn(TestBed.inject(NotificationService), 'show');
      spyOn(console, 'error');
      const inFlight = new Subject<MediaItem>();
      startAudioGeneration.and.returnValue(inFlight);
      const textarea = await showField(field.model);
      pressKey(textarea, {});

      inFlight.error(new Error('boom'));
      pressKey(textarea, {});

      expect(startAudioGeneration).toHaveBeenCalledTimes(2);
    });

    it(`shows the submit hint under the ${field.name}`, async () => {
      await showField(field.model);

      const hint = fixture.nativeElement.querySelector('mat-hint');
      expect(hint.textContent.trim()).toBe(PROMPT_SUBMIT_HINT);
    });
  }
});
