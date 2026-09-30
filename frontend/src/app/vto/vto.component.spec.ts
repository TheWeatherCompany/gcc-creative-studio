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
import {MatStepperModule} from '@angular/material/stepper';
import {MatRadioModule} from '@angular/material/radio';
import {MatButtonModule} from '@angular/material/button';
import {MatIconModule} from '@angular/material/icon';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatDialogModule} from '@angular/material/dialog';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {provideRouter} from '@angular/router';
import {CUSTOM_ELEMENTS_SCHEMA} from '@angular/core';
import {of} from 'rxjs';

import {VtoComponent} from './vto.component';
import {SearchService} from '../services/search/search.service';
import {VtoStateService} from '../services/vto-state.service';
import {WorkspaceStateService} from '../services/workspace/workspace-state.service';
import {GalleryService} from '../gallery/gallery.service';
import {SourceAssetService} from '../common/services/source-asset.service';
import {FileDropDirective} from '../common/upload/file-drop.directive';
import {FilePasteDirective} from '../common/upload/file-paste.directive';

describe('VtoComponent', () => {
  let component: VtoComponent;
  let fixture: ComponentFixture<VtoComponent>;
  let uploadAsset: jasmine.Spy;

  beforeEach(async () => {
    uploadAsset = jasmine.createSpy('uploadAsset');
    await TestBed.configureTestingModule({
      declarations: [VtoComponent],
      imports: [
        ReactiveFormsModule,
        FormsModule,
        MatStepperModule,
        MatRadioModule,
        MatButtonModule,
        MatIconModule,
        MatProgressSpinnerModule,
        MatDialogModule,
        MatSnackBarModule,
        NoopAnimationsModule,
        FileDropDirective,
        FilePasteDirective,
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        {
          provide: SearchService,
          useValue: {
            activeVtoJob$: of(null),
            startVtoGeneration: jasmine
              .createSpy('startVtoGeneration')
              .and.returnValue(of({})),
            clearActiveVtoJob: jasmine.createSpy('clearActiveVtoJob'),
          },
        },
        {
          provide: VtoStateService,
          useValue: {
            getState: () => ({}),
            updateState: jasmine.createSpy('updateState'),
            resetState: jasmine.createSpy('resetState'),
          },
        },
        {
          provide: WorkspaceStateService,
          useValue: {
            getActiveWorkspaceId: () => 1,
          },
        },
        {provide: SourceAssetService, useValue: {uploadAsset}},
        {
          provide: GalleryService,
          useValue: {
            bulkDelete: jasmine.createSpy('bulkDelete').and.returnValue(of({})),
          },
        },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(VtoComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
    // Settle the initial asset load; `isLoading` also gates pasting.
    TestBed.inject(HttpTestingController)
      .expectOne(req => req.url.endsWith('/source_assets/vto-assets'))
      .flush({
        female_models: [],
        male_models: [],
        tops: [],
        bottoms: [],
        dresses: [],
        shoes: [],
      });
    fixture.detectChanges();
  });

  it('uses a dropped or pasted photo as the uploaded model', () => {
    uploadAsset.and.returnValue(
      of({id: 7, originalFilename: 'me.png', presignedUrl: 'u'}),
    );
    component.onModelFileAdded(new File(['x'], 'me.png', {type: 'image/png'}));
    expect(component.firstFormGroup.get('model')?.value).toEqual(
      jasmine.objectContaining({id: 'uploaded', inputLink: {sourceAssetId: 7}}),
    );
    expect(component.isLoading).toBeFalse();
  });

  describe('pasting a photo', () => {
    function paste(): void {
      const dt = new DataTransfer();
      dt.items.add(new File(['x'], 'image.png', {type: 'image/png'}));
      document.dispatchEvent(
        new ClipboardEvent('paste', {clipboardData: dt, cancelable: true}),
      );
    }

    beforeEach(() => {
      uploadAsset.and.returnValue(
        of({id: 7, originalFilename: 'me.png', presignedUrl: 'u'}),
      );
    });

    it('uploads it while the stepper is on the model step', () => {
      paste();
      expect(uploadAsset).toHaveBeenCalledTimes(1);
    });

    it('ignores it while another upload is in flight', () => {
      component.isLoading = true;
      fixture.detectChanges();
      paste();
      expect(uploadAsset).not.toHaveBeenCalled();
    });

    it('ignores it once the stepper has moved past the model step', () => {
      component.firstFormGroup.get('model')?.setValue({id: 'f1'});
      component.stepper.next();
      fixture.detectChanges();
      expect(component.stepper.selectedIndex).toBe(1);
      paste();
      expect(uploadAsset).not.toHaveBeenCalled();
    });
  });
});
