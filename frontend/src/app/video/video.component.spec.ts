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
import {MatDialogModule} from '@angular/material/dialog';
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

import {VideoComponent} from './video.component';
import {SearchService} from '../services/search/search.service';
import {WorkspaceStateService} from '../services/workspace/workspace-state.service';
import {VideoStateService} from '../services/video-state.service';
import {GalleryService} from '../gallery/gallery.service';
import {GalleryItem} from '../common/models/gallery-item.model';
import {reuseNavigation} from '../gallery/generations-feed/feed-navigation';

describe('VideoComponent', () => {
  let component: VideoComponent;
  let fixture: ComponentFixture<VideoComponent>;
  let startVeoGeneration: jasmine.Spy;

  beforeEach(async () => {
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
            getState: () => ({}),
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

  // The feed's Reuse passes uploaded start and end frames as asset ids. The
  // request only carries those in Frames to Video, so without the mode switch
  // the reused generation ran as text to video with no frames.
  it('sends the start and end frames of a reused generation that were uploaded assets', () => {
    const asset = (assetId: number, role: string) => ({
      assetId,
      role,
      presignedUrl: `https://storage.test/asset-${assetId}.png`,
    });
    const row = {
      id: 7,
      model: 'veo-3.1-generate-001',
      mimeType: 'video/mp4',
      aspectRatio: '16:9',
      metadata: {originalPrompt: 'a fox in the snow'},
    } as unknown as GalleryItem;
    const detail = {
      ...row,
      enrichedSourceAssets: [asset(11, 'start_frame'), asset(12, 'end_frame')],
    } as unknown as GalleryItem;

    (
      component as unknown as {applyRemixState(state: unknown): void}
    ).applyRemixState(reuseNavigation(row, detail)!.remixState);
    component.searchTerm();

    expect(startVeoGeneration).toHaveBeenCalledOnceWith(
      jasmine.objectContaining({
        prompt: 'a fox in the snow',
        startImageAssetId: {id: 11, type: 'source_asset'},
        endImageAssetId: {id: 12, type: 'source_asset'},
      }),
    );
  });
});
