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

import {provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {Injector} from '@angular/core';
import {
  ComponentFixture,
  TestBed,
  fakeAsync,
  flush,
} from '@angular/core/testing';
import {MatDialog} from '@angular/material/dialog';
import {MatIconTestingModule} from '@angular/material/icon/testing';
import {By} from '@angular/platform-browser';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {of} from 'rxjs';
import {environment} from '../../../../environments/environment';
import {AppInjector, setAppInjector} from '../../../app-injector';
import {FlowPromptBoxComponent} from '../../../common/components/flow-prompt-box/flow-prompt-box.component';
import {MediaItemSelection} from '../../../common/components/image-selector/image-selector.component';
import {MediaItem} from '../../../common/models/media-item.model';
import {NotificationService} from '../../../common/services/notification.service';
import {SourceAssetResponseDto} from '../../../common/services/source-asset.service';
import {ImageStateService} from '../../../services/image-state.service';
import {VideoStateService} from '../../../services/video-state.service';
import {WorkspaceStateService} from '../../../services/workspace/workspace-state.service';
import {findModel} from './composer-payload';
import {FeedComposerComponent} from './feed-composer.component';

const imagesUrl = `${environment.backendURL}/images/generate-images`;
const videosUrl = `${environment.backendURL}/videos/generate-videos`;
const rewriteUrl = `${environment.backendURL}/gemini/rewrite-prompt`;

/** What the selector closes with for an uploaded or picked source asset. */
function upload(id: number, presignedUrl = `https://s.test/${id}.png`) {
  const asset: SourceAssetResponseDto = {
    id,
    userId: 'u',
    gcsUri: `gs://bucket/${id}.png`,
    originalFilename: `${id}.png`,
    mimeType: 'image/png',
    aspectRatio: '1:1',
    fileHash: '',
    createdAt: '',
    updatedAt: '',
    presignedUrl,
    presignedOriginalUrl: '',
  };
  return asset;
}

/** What the selector closes with for a generated image picked from the gallery. */
function gallery(
  id: number,
  selectedIndex = 0,
  presignedUrls = ['https://g.test/0.png', 'https://g.test/1.png'],
) {
  const selection: MediaItemSelection = {
    mediaItem: {id, presignedUrls} as unknown as MediaItem,
    selectedIndex,
  };
  return selection;
}

describe('FeedComposerComponent', () => {
  let fixture: ComponentFixture<FeedComposerComponent>;
  let component: FeedComposerComponent;
  let http: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let previousInjector: Injector;
  let dialogOpen: jasmine.Spy;
  let dialogResult: unknown;
  let submitted: jasmine.Spy;

  /** The presentational box the composer drives; its outputs are the bar's buttons. */
  const box = () =>
    fixture.debugElement.query(By.directive(FlowPromptBoxComponent))
      .componentInstance as FlowPromptBoxComponent;
  const imageState = () => TestBed.inject(ImageStateService);
  const videoState = () => TestBed.inject(VideoStateService);
  const notice = () => notifications.show.calls.mostRecent().args.slice(0, 2);

  function create() {
    fixture = TestBed.createComponent(FeedComposerComponent);
    component = fixture.componentInstance;
    submitted = jasmine.createSpy('submitted');
    component.submitted.subscribe(submitted);
    fixture.detectChanges();
  }
  function type(prompt: string) {
    box().promptChanged.emit(prompt);
    fixture.detectChanges();
  }
  function switchMode(mode: string) {
    box().modeChanged.emit(mode);
    fixture.detectChanges();
  }
  function selectModel(value: string) {
    box().modelSelected.emit(findModel(value));
    fixture.detectChanges();
  }
  function generate() {
    box().generateClicked.emit();
    fixture.detectChanges();
  }
  /** Opens the picker; the fake selector closes at once with `result`. */
  function pick(result: unknown) {
    dialogResult = result;
    box().openImageSelectorForReference.emit();
    fixture.detectChanges();
  }

  beforeEach(() => {
    localStorage.removeItem('image_state');
    localStorage.removeItem('video_state');
    notifications = jasmine.createSpyObj('NotificationService', ['show']);
    previousInjector = AppInjector;
    setAppInjector({get: () => notifications} as unknown as Injector);
    dialogResult = undefined;
    dialogOpen = jasmine
      .createSpy('open')
      .and.callFake(() => ({afterClosed: () => of(dialogResult)}));

    TestBed.configureTestingModule({
      imports: [
        FeedComposerComponent,
        NoopAnimationsModule,
        MatIconTestingModule,
      ],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {provide: MatDialog, useValue: {open: dialogOpen}},
      ],
    });
    http = TestBed.inject(HttpTestingController);
    TestBed.inject(WorkspaceStateService).setActiveWorkspaceId(5);
  });

  afterEach(() => {
    http.verify();
    setAppInjector(previousInjector);
    localStorage.removeItem('image_state');
    localStorage.removeItem('video_state');
  });

  describe('generate', () => {
    const cases = [
      {mode: 'Text to Image', url: imagesUrl, other: videosUrl},
      {mode: 'Text to Video', url: videosUrl, other: imagesUrl},
    ];
    for (const c of cases) {
      it(`posts one ${c.mode} request in the active workspace, shows loading, and reports it`, () => {
        create();
        switchMode(c.mode);
        type('a supercell');
        generate();

        const req = http.expectOne(c.url);
        http.expectNone(c.other);
        expect(req.request.body.prompt).toBe('a supercell');
        expect(req.request.body.workspaceId).toBe(5);
        expect(box().isLoading).toBeTrue();
        expect(submitted).not.toHaveBeenCalled();

        req.flush({id: 101});
        fixture.detectChanges();
        expect(box().isLoading).toBeFalse();
        expect(submitted).toHaveBeenCalledOnceWith(
          jasmine.objectContaining({id: 101}),
        );
      });
    }

    const refusals: {
      name: string;
      prompt: string;
      workspace: number | null;
      message: string;
      type: string;
    }[] = [
      {
        name: 'a whitespace-only prompt',
        prompt: '   ',
        workspace: 5,
        message: 'Please enter a prompt to generate an image.',
        type: 'info',
      },
      {
        name: 'no active workspace',
        prompt: 'a supercell',
        workspace: null,
        message: 'Please select a workspace first.',
        type: 'error',
      },
    ];
    for (const c of refusals) {
      it(`sends nothing and says why for ${c.name}`, () => {
        TestBed.inject(WorkspaceStateService).setActiveWorkspaceId(c.workspace);
        create();
        type(c.prompt);
        generate();

        // http.verify() in afterEach fails if a request went out.
        expect(notice()).toEqual([c.message, c.type]);
        expect(submitted).not.toHaveBeenCalled();
        expect(box().isLoading).toBeFalse();
      });
    }

    it('shows the server reason and reports no submit when the POST fails', () => {
      create();
      type('a supercell');
      generate();
      http
        .expectOne(imagesUrl)
        .flush(
          {detail: 'Something broke upstream'},
          {status: 500, statusText: 'Server Error'},
        );
      fixture.detectChanges();

      expect(notice()).toEqual(['Something broke upstream', 'error']);
      expect(submitted).not.toHaveBeenCalled();
      expect(box().isLoading).toBeFalse();
    });
  });

  describe('settings shared with the pages', () => {
    const states: {
      mode: string;
      state: () => object;
      extra: () => void;
      expected: Record<string, number>;
    }[] = [
      {
        mode: 'Text to Image',
        state: () => imageState().getState(),
        extra: () => box().temperatureChanged.emit(0.7),
        expected: {temperature: 0.7},
      },
      {
        mode: 'Text to Video',
        state: () => videoState().getState(),
        extra: () => box().durationChanged.emit(4),
        expected: {durationSeconds: 4},
      },
    ];
    for (const c of states) {
      it(`writes the ${c.mode} settings to the ${c.mode} state`, () => {
        create();
        switchMode(c.mode);
        type('shared prompt');
        box().aspectRatioChanged.emit('9:16');
        box().outputsChanged.emit(3);
        box().resolutionChanged.emit('2K');
        c.extra();

        expect(c.state()).toEqual(
          jasmine.objectContaining({
            prompt: 'shared prompt',
            aspectRatio: '9:16',
            numberOfMedia: 3,
            resolution: '2K',
            ...c.expected,
          }),
        );
      });
    }

    it('opens on the model, ratio and prompt the image page saved', () => {
      imageState().updateState({
        model: 'gemini-3-pro-image',
        aspectRatio: '21:9',
        prompt: 'left on the image page',
        mode: 'Ingredients to Image',
      });
      create();

      expect(box().mode).toBe('Ingredients to Image');
      expect(box().selectedGenerationModel).toBe('Nano Banana Pro');
      expect(box().aspectRatio).toBe('21:9');
      expect(box().prompt).toBe('left on the image page');
    });

    it('offers the models that fit the mode and none of the other media type', () => {
      create();
      const image = box().generationModels.map(m => m.value);
      expect(image).toContain('gemini-3.1-flash-image');
      expect(image).not.toContain('veo-3.1-generate-001');

      switchMode('Text to Video');
      const video = box().generationModels.map(m => m.value);
      expect(video).toContain('veo-3.1-generate-001');
      expect(video).not.toContain('gemini-3.1-flash-image');
    });

    it('keeps a ratio the picked model supports and swaps one it does not', () => {
      // Nano Banana Pro has no 1:4; Nano Banana 2 does.
      imageState().updateState({
        model: 'gemini-3.1-flash-image',
        aspectRatio: '1:4',
      });
      create();
      selectModel('gemini-3.1-flash-lite-image');
      expect(imageState().getState().aspectRatio).toBe('1:4');

      selectModel('gemini-3-pro-image');
      expect(imageState().getState().aspectRatio).toBe('1:1');
    });

    it('turns Google Search off when the picked image model lacks it', () => {
      imageState().updateState({googleSearch: true});
      create();
      selectModel('gemini-3-pro-image');
      expect(imageState().getState().googleSearch).toBeTrue();

      selectModel('gemini-2.5-flash-image');
      expect(imageState().getState().googleSearch).toBeFalse();
    });

    it('turns audio back on when a video model is picked, as the video page does', () => {
      videoState().updateState({generateAudio: false});
      create();
      switchMode('Text to Video');
      expect(videoState().getState().generateAudio).toBeFalse();

      selectModel('veo-3.1-generate-001');
      expect(videoState().getState().generateAudio).toBeTrue();
    });

    it('keeps the typed text when the media type changes and saves it for the other page', () => {
      create();
      type('a supercell');
      switchMode('Text to Video');
      expect(box().prompt).toBe('a supercell');
      expect(videoState().getState().prompt).toBe('a supercell');

      type('thick fog');
      switchMode('Ingredients to Image');
      expect(box().prompt).toBe('thick fog');
      expect(imageState().getState().prompt).toBe('thick fog');
    });

    it("leaves the other page's saved prompt alone when the box is blank", () => {
      videoState().updateState({prompt: 'fog over the harbour'});
      create();
      switchMode('Text to Video');

      expect(videoState().getState().prompt).toBe('fog over the harbour');
      expect(box().prompt).toBe('fog over the harbour');
    });

    it('writes settings only to the media type in use and never saves the mode', () => {
      create();
      const image = {...imageState().getState()};
      const video = {...videoState().getState()};
      const withoutPrompt = (state: object) => ({...state, prompt: ''});

      box().aspectRatioChanged.emit('9:16');
      box().outputsChanged.emit(3);
      expect(withoutPrompt(videoState().getState())).toEqual(
        withoutPrompt(video),
      );

      // The prompt is carried across by design, so it is left out here.
      switchMode('Text to Video');
      box().aspectRatioChanged.emit('9:16');
      box().outputsChanged.emit(2);
      expect(withoutPrompt(imageState().getState())).toEqual(
        withoutPrompt({...image, aspectRatio: '9:16', numberOfMedia: 3}),
      );
      expect(imageState().getState().mode).toBe(image.mode);
      expect(videoState().getState().mode).toBe(video.mode);

      switchMode('Ingredients to Image');
      expect(imageState().getState().mode).toBe(image.mode);
    });

    // The box corrects a resolution its model can't render. Fed the video
    // model while still holding the image resolution, it used to overwrite
    // the saved video resolution.
    it('keeps the saved video resolution when switching in from an image mode', fakeAsync(() => {
      imageState().updateState({
        model: 'gemini-3.1-flash-image',
        resolution: '4K',
      });
      videoState().updateState({
        model: 'veo-3.1-lite-generate-001',
        resolution: '2K',
      });
      create();
      switchMode('Text to Video');
      flush();
      expect(videoState().getState().resolution).toBe('2K');

      type('fog');
      generate();
      expect(http.expectOne(videosUrl).request.body.resolution).toBe('2K');
    }));
  });

  describe('focusPrompt', () => {
    it('puts keyboard focus in the prompt field, whichever media type is showing', () => {
      create();
      component.focusPrompt();
      expect(document.activeElement).toBe(
        fixture.nativeElement.querySelector('textarea'),
      );

      (document.activeElement as HTMLElement).blur();
      switchMode('Text to Video');
      component.focusPrompt();
      expect(document.activeElement).toBe(
        fixture.nativeElement.querySelector('textarea'),
      );
    });
  });

  describe('reference images', () => {
    it('sends a gallery pick and an upload the way the image page does', () => {
      create();
      switchMode('Ingredients to Image');
      type('blend these');
      pick([gallery(7, 1), upload(11)]);
      generate();

      const body = http.expectOne(imagesUrl).request.body;
      expect(body.sourceMediaItems).toEqual([
        {mediaItemId: 7, mediaIndex: 1, role: 'input'},
      ]);
      expect(body.sourceAssetIds).toEqual([11]);
    });

    it('drops the same image picked twice and says so', () => {
      create();
      switchMode('Ingredients to Image');
      type('blend these');
      pick([upload(11), gallery(7, 1)]);
      pick([upload(11), gallery(7, 1), gallery(7, 0), gallery(7, 0)]);

      expect(notice()).toEqual(['This image is already selected.', 'info']);
      generate();
      const body = http.expectOne(imagesUrl).request.body;
      expect(body.sourceAssetIds).toEqual([11]);
      expect(body.sourceMediaItems).toEqual([
        {mediaItemId: 7, mediaIndex: 1, role: 'input'},
        {mediaItemId: 7, mediaIndex: 0, role: 'input'},
      ]);
    });

    it('skips a result with no preview image', () => {
      create();
      switchMode('Ingredients to Image');
      pick([upload(11, ''), gallery(7, 5), upload(12)]);

      expect(box().referenceImages.map(r => r.sourceAssetId)).toEqual([12]);
    });

    // A throw inside the subscriber is reported on a timer, so flush it.
    it('keeps what it has when the picker is cancelled', fakeAsync(() => {
      create();
      switchMode('Ingredients to Image');
      pick(upload(11));
      pick(undefined);
      flush();

      expect(box().referenceImages.length).toBe(1);
    }));

    it('offers the free slots and stops at the model limit, on pick and on a smaller model', () => {
      // Nano Banana takes 2 references; Nano Banana 2 takes 14.
      create();
      switchMode('Ingredients to Image');
      selectModel('gemini-2.5-flash-image');
      pick([upload(1), upload(2), upload(3)]);
      expect(dialogOpen.calls.argsFor(0)[1].data.maxSelection).toBe(2);
      expect(box().referenceImages.length).toBe(2);

      pick(upload(4));
      expect(dialogOpen).toHaveBeenCalledTimes(1);
      expect(notice()).toEqual([
        'You can only add up to 2 reference images for this model.',
        'info',
      ]);

      selectModel('gemini-3.1-flash-image');
      pick([upload(3), upload(4), upload(5)]);
      expect(dialogOpen.calls.argsFor(1)[1].data.maxSelection).toBe(12);
      expect(box().referenceImages.length).toBe(5);
      selectModel('gemini-2.5-flash-image');
      expect(box().referenceImages.map(r => r.sourceAssetId)).toEqual([1, 2]);
    });

    it('removes the one whose close button was clicked', () => {
      create();
      switchMode('Ingredients to Image');
      type('blend these');
      pick([upload(1), upload(2), upload(3)]);
      box().clearReferenceImage.emit({index: 1, event: new Event('click')});
      generate();

      expect(http.expectOne(imagesUrl).request.body.sourceAssetIds).toEqual([
        1, 3,
      ]);
    });

    it('sends none once the mode is Text to Image', () => {
      create();
      switchMode('Ingredients to Image');
      type('blend these');
      pick(upload(11));
      switchMode('Text to Image');
      generate();

      const body = http.expectOne(imagesUrl).request.body;
      expect(body.sourceAssetIds).toBeUndefined();
      expect(body.sourceMediaItems).toBeUndefined();
    });
  });

  describe('rewrite', () => {
    const targets = [
      {mode: 'Text to Image', targetType: 'image'},
      {mode: 'Text to Video', targetType: 'video'},
    ];
    for (const c of targets) {
      it(`replaces the ${c.mode} prompt with the rewritten one`, () => {
        create();
        switchMode(c.mode);
        type('storm');
        box().rewriteClicked.emit();
        fixture.detectChanges();

        const req = http.expectOne(rewriteUrl);
        expect(req.request.body).toEqual({
          targetType: c.targetType,
          userPrompt: 'storm',
        });
        expect(box().isLoading).toBeTrue();
        req.flush({prompt: 'a towering storm cell at dusk'});
        fixture.detectChanges();

        expect(box().prompt).toBe('a towering storm cell at dusk');
        expect(box().isLoading).toBeFalse();
      });
    }

    // The box is one text box, so the result goes to whichever media type is
    // showing when it arrives, and only if the text is still what was sent.
    const arrivals = [
      {
        name: 'the media type changed but the text did not',
        act: () => switchMode('Text to Image'),
        expected: 'thick fog at dawn',
      },
      {
        name: 'the text was edited in place',
        act: () => type('fog over the harbour'),
        expected: 'fog over the harbour',
      },
      {
        name: 'the media type changed and the text was edited',
        act: () => {
          switchMode('Text to Image');
          type('a supercell');
        },
        expected: 'a supercell',
      },
    ];
    for (const c of arrivals) {
      it(`lands the rewrite as the box shows it when ${c.name}`, () => {
        create();
        switchMode('Text to Video');
        type('fog');
        box().rewriteClicked.emit();
        c.act();
        http.expectOne(rewriteUrl).flush({prompt: 'thick fog at dawn'});
        fixture.detectChanges();

        expect(box().prompt).toBe(c.expected);
        const shown =
          box().mode === 'Text to Video' ? videoState() : imageState();
        expect(shown.getState().prompt).toBe(c.expected);
      });
    }

    const keeps = [
      {
        name: 'the rewrite fails',
        flush: () =>
          http
            .expectOne(rewriteUrl)
            .flush({detail: 'Model busy'}, {status: 503, statusText: 'Busy'}),
      },
      {
        name: 'the rewrite comes back empty',
        flush: () => http.expectOne(rewriteUrl).flush({prompt: '  '}),
      },
    ];
    for (const c of keeps) {
      it(`keeps the prompt when ${c.name}`, () => {
        create();
        type('storm');
        box().rewriteClicked.emit();
        c.flush();
        fixture.detectChanges();

        expect(box().prompt).toBe('storm');
        expect(box().isLoading).toBeFalse();
      });
    }

    it('shows the server reason when the rewrite fails', () => {
      create();
      type('storm');
      box().rewriteClicked.emit();
      http
        .expectOne(rewriteUrl)
        .flush({detail: 'Model busy'}, {status: 503, statusText: 'Busy'});

      expect(notice()).toEqual(['Model busy', 'error']);
    });

    it('sends nothing for a blank prompt', () => {
      create();
      type('  ');
      box().rewriteClicked.emit();

      // http.verify() in afterEach fails if a request went out.
      expect(notifications.show).not.toHaveBeenCalled();
    });
  });
});
