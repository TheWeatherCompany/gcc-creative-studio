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

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {ReactiveFormsModule, FormsModule} from '@angular/forms';
import {MatDialogModule, MatDialogRef} from '@angular/material/dialog';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {MatMenuModule} from '@angular/material/menu';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';
import {MatTooltipModule} from '@angular/material/tooltip';
import {MatSelectModule} from '@angular/material/select';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatInputModule} from '@angular/material/input';
import {MatChipsModule} from '@angular/material/chips';
import {MatButtonToggleModule} from '@angular/material/button-toggle';
import {MatSlideToggleModule} from '@angular/material/slide-toggle';
import {MatSliderModule} from '@angular/material/slider';
import {MatRadioModule} from '@angular/material/radio';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideRouter} from '@angular/router';
import {CUSTOM_ELEMENTS_SCHEMA} from '@angular/core';
import {of} from 'rxjs';
import {MODEL_CONFIGS} from '../common/config/model-config';

import {VideoComponent} from './video.component';
import {SearchService} from '../services/search/search.service';
import {WorkspaceStateService} from '../services/workspace/workspace-state.service';
import {VideoStateService} from '../services/video-state.service';
import {GalleryService} from '../gallery/gallery.service';

describe('VideoComponent', () => {
  let component: VideoComponent;
  let fixture: ComponentFixture<VideoComponent>;
  let startVeoGeneration: jasmine.Spy;

  beforeEach(async () => {
    localStorage.removeItem('video_state');
    startVeoGeneration = jasmine
      .createSpy('startVeoGeneration')
      .and.returnValue(of({}));
    await TestBed.configureTestingModule({
      declarations: [VideoComponent],
      imports: [
        ReactiveFormsModule,
        FormsModule,
        MatDialogModule,
        MatSnackBarModule,
        MatMenuModule,
        MatButtonModule,
        MatIconModule,
        MatTooltipModule,
        MatSelectModule,
        MatFormFieldModule,
        MatInputModule,
        MatChipsModule,
        MatButtonToggleModule,
        MatSlideToggleModule,
        MatSliderModule,
        MatRadioModule,
        MatProgressSpinnerModule,
        NoopAnimationsModule,
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: SearchService,
          useValue: {
            activeVideoJobs$: of([]),
            videoPrompt: '',
            trackVideoJob: jasmine.createSpy('trackVideoJob'),
            restoreActiveVideoJobs: jasmine.createSpy('restoreActiveVideoJobs'),
            startVeoGeneration,
          },
        },
        {
          provide: WorkspaceStateService,
          useValue: {
            getActiveWorkspaceId: () => 1,
          },
        },
        {
          provide: VideoStateService,
          useValue: {
            // The real defaults, so the tests see what a new user gets.
            getState: () => new VideoStateService().getState(),
            updateState: jasmine.createSpy('updateState'),
          },
        },
        {
          provide: GalleryService,
          useValue: {
            mapUnifiedItem: (item: any) => item,
          },
        },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(VideoComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('takes per prompt', () => {
    const model = (value: string) =>
      MODEL_CONFIGS.find(m => m.value === value)!;
    const omni = model('gemini-omni-1.1-flash-preview');
    const veo = model('veo-3.1-generate-001');

    /** The count sent, after checking it is the one the x-chip showed. */
    function submittedCount(): number | undefined {
      const shown = component.searchRequest.numberOfMedia;
      component.searchRequest.prompt = 'a test prompt';
      component.searchTerm();
      const sent = startVeoGeneration.calls.mostRecent().args[0].numberOfMedia;
      expect(sent).withContext('shown count').toBe(shown);
      return sent;
    }

    it('should send one take until the user picks more', () => {
      component.selectModel(veo);
      expect(submittedCount()).toBe(1);
    });

    // Omni used to be held to one take, and picking it reset the count to 1.
    // The backend now makes one Omni interaction per take.
    it('should offer and send up to 4 takes on Omni', () => {
      component.selectModel(veo);
      component.selectNumberOfVideos(4);
      component.selectModel(omni);
      expect(component.maxOutputs).withContext('picker limit').toBe(4);
      expect(submittedCount()).toBe(4);
    });
  });

  describe('model choice for reference inputs', () => {
    const model = (value: string) =>
      MODEL_CONFIGS.find(m => m.value === value)!;
    const omni = model('gemini-omni-1.1-flash-preview');
    const veo = model('veo-3.1-generate-001');

    /** Attaches a reference through the same selector dialog the UI opens. */
    function attach(kind: 'image' | 'video'): void {
      const picked = {id: 7, gcsUri: 'gs://bucket/ref', presignedUrl: 'url'};
      const open = component.dialog.open as jasmine.Spy;
      (jasmine.isSpy(open)
        ? open
        : spyOn(component.dialog, 'open')
      ).and.returnValue({
        afterClosed: () => of(picked),
      } as unknown as MatDialogRef<unknown>);
      if (kind === 'image') {
        component.openImageSelectorForReference();
      } else {
        component.openVideoSelectorForReference();
      }
    }

    function submit(): void {
      component.searchRequest.prompt = 'a test prompt';
      component.searchTerm();
    }

    beforeEach(() => {
      component.selectModel(veo);
      component.currentMode = 'Ingredients to Video';
    });

    // Veo 3.1 takes reference images. Adding one used to switch to Omni,
    // which is 720p only, with nothing but a snackbar to say so.
    it('should keep Veo when a reference image is added', () => {
      attach('image');

      expect(component.searchRequest.generationModel).toBe(veo.value);
      expect(component.modelNotice).toBeNull();
      submit();
      const sent = startVeoGeneration.calls.mostRecent().args[0];
      expect(sent.generationModel).toBe(veo.value);
      expect(sent.referenceImages?.length).toBe(1);
    });

    it('should switch to Omni with a notice by the model picker for a reference video', () => {
      attach('video');

      expect(component.searchRequest.generationModel).toBe(omni.value);
      expect(component.modelNotice?.blocking).toBeFalse();
      expect(component.modelNotice?.text).toContain(veo.viewValue);
      expect(component.modelNotice?.text).toContain(omni.viewValue);
    });

    // Vertex rejects reference images on Veo 3.1 Lite, but the backend queues
    // the job, so it only failed later in the worker.
    it('should move off Veo 3.1 Lite when a reference image is added', () => {
      const lite = model('veo-3.1-lite-generate-001');
      component.selectModel(lite);
      attach('image');

      expect(component.searchRequest.generationModel).not.toBe(lite.value);
      expect(component.modelNotice?.blocking).toBeFalse();
      expect(component.modelNotice?.text).toContain(lite.viewValue);
      submit();
      const sent = startVeoGeneration.calls.mostRecent().args[0];
      expect(sent.generationModel).not.toBe(lite.value);
      expect(sent.referenceImages?.length).toBe(1);
    });

    // Omni has no resolution picker, so a 4K pick carried over from Veo was
    // sent as is and the backend rejected it, despite the 720p notice.
    it('should send 1K after a switch to Omni from a 4K Veo pick', () => {
      component.onResolutionChanged('4K');
      attach('video');
      submit();

      const sent = startVeoGeneration.calls.mostRecent().args[0];
      expect(sent.generationModel).toBe(omni.value);
      expect(sent.resolution).toBe('1K');
    });

    // Veo's backend path accepts a reference video but never sends it, so the
    // user would get a generation that silently ignored their reference.
    it('should block, not switch, when the picked model cannot take the reference', () => {
      component.selectModel(omni);
      attach('video');
      component.selectModel(veo);

      submit();

      expect(startVeoGeneration).not.toHaveBeenCalled();
      expect(component.searchRequest.generationModel).toBe(veo.value);
      expect(component.modelNotice?.blocking).toBeTrue();
    });
  });
});
