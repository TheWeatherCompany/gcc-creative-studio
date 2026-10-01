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
import {FlowPromptBoxComponent} from './flow-prompt-box.component';
import {MatSnackBar} from '@angular/material/snack-bar';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {MatIconTestingModule} from '@angular/material/icon/testing';
import {MODEL_CONFIGS} from '../../config/model-config';
import {Injector} from '@angular/core';
import {setAppInjector} from '../../../app-injector';
import {NotificationService} from '../../services/notification.service';
import {PROMPT_SUBMIT_HINT} from '../../../utils/prompt-submit';

describe('FlowPromptBoxComponent', () => {
  let component: FlowPromptBoxComponent;
  let fixture: ComponentFixture<FlowPromptBoxComponent>;
  let snackBarSpy: jasmine.SpyObj<MatSnackBar>;

  beforeEach(async () => {
    snackBarSpy = jasmine.createSpyObj('MatSnackBar', ['open']);

    await TestBed.configureTestingModule({
      imports: [
        FlowPromptBoxComponent,
        NoopAnimationsModule,
        MatIconTestingModule,
      ],
      providers: [{provide: MatSnackBar, useValue: snackBarSpy}],
    }).compileComponents();

    fixture = TestBed.createComponent(FlowPromptBoxComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  describe('Resolution Support', () => {
    const nanoBanana2 = MODEL_CONFIGS.find(
      m => m.value === 'gemini-3.1-flash-image',
    )!;
    const nanoBanana2Lite = MODEL_CONFIGS.find(
      m => m.value === 'gemini-3.1-flash-lite-image',
    )!;
    const veo31 = MODEL_CONFIGS.find(m => m.value === 'veo-3.1-generate-001')!;

    beforeEach(() => {
      component.generationModels = MODEL_CONFIGS;
    });

    it('should support 1K, 2K, and 4K resolutions for Nano Banana 2 in Ingredients to Image mode', () => {
      component.selectedGenerationModel = nanoBanana2.viewValue;
      component.mode = 'Ingredients to Image';

      const resolutions = component.getSelectedModelResolutions();
      expect(resolutions).toEqual(['1K', '2K', '4K']);
      expect(component.supportedResolutions()).toEqual(['1K', '2K', '4K']);
      expect(component.hasResolutionOptions()).toBeTrue();
    });

    it('should support only 1K for Nano Banana 2 Lite in Ingredients to Image mode', () => {
      component.selectedGenerationModel = nanoBanana2Lite.viewValue;
      component.mode = 'Ingredients to Image';

      const resolutions = component.getSelectedModelResolutions();
      expect(resolutions).toEqual(['1K']);
      expect(component.supportedResolutions()).toEqual(['1K']);
    });

    it('should restrict resolution to 1K for Extend Video mode', () => {
      component.selectedGenerationModel = veo31.viewValue;
      component.mode = 'Extend Video';

      const resolutions = component.getSelectedModelResolutions();
      expect(resolutions).toEqual(['1K']);
      expect(component.supportedResolutions()).toEqual(['1K']);
    });

    it('should update selectedResolution and emit resolutionChanged on selectResolution', () => {
      component.selectedGenerationModel = nanoBanana2.viewValue;
      component.mode = 'Ingredients to Image';
      spyOn(component.resolutionChanged, 'emit');

      component.selectResolution('2K');
      expect(component.selectedResolution()).toBe('2K');
      expect(component.resolutionChanged.emit).toHaveBeenCalledWith('2K');

      component.selectResolution('4K');
      expect(component.selectedResolution()).toBe('4K');
      expect(component.resolutionChanged.emit).toHaveBeenCalledWith('4K');
    });

    it('should not select an unsupported resolution', () => {
      component.selectedGenerationModel = nanoBanana2Lite.viewValue;
      component.mode = 'Ingredients to Image';
      component.selectedResolution.set('1K');
      spyOn(component.resolutionChanged, 'emit');

      component.selectResolution('4K');
      expect(component.selectedResolution()).toBe('1K');
      expect(component.resolutionChanged.emit).not.toHaveBeenCalled();
    });
  });

  it('should show a model notice by the picker, dismissable unless it blocks', () => {
    for (const blocking of [false, true]) {
      fixture.componentRef.setInput('modelNotice', {
        text: 'Switched to Gemini Omni',
        blocking,
      });
      fixture.detectChanges();
      const notice = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="model-notice"]',
      );
      expect(notice?.textContent).toContain('Switched to Gemini Omni');
      expect(notice?.querySelector('button[aria-label="Dismiss"]') !== null)
        .withContext(`blocking ${blocking}`)
        .toBe(!blocking);
    }
  });

  describe('Outputs per prompt', () => {
    it('should offer x1 up to the model limit in the picker', () => {
      for (const [max, expected] of [
        [4, ['x1', 'x2', 'x3', 'x4']],
        [2, ['x1', 'x2']],
        [1, ['x1']],
      ] as [number, string[]][]) {
        fixture.componentRef.setInput('maxOutputs', max);
        component.isSettingsMenuOpen.set(true);
        component.isSettingsDropdownOpen.set('outputs');
        fixture.detectChanges();
        const labels = Array.from(
          (fixture.nativeElement as HTMLElement).querySelectorAll(
            'button.block.w-full',
          ),
        )
          .map(b => b.textContent?.trim() ?? '')
          .filter(t => /^x\d$/.test(t));
        expect(labels).withContext(`max ${max}`).toEqual(expected);
      }
    });

    it('should default outputs to 1', () => {
      expect(component.outputs).toBe(1);
    });

    it('should emit outputsChanged and close dropdown on selectOutputs', () => {
      spyOn(component.outputsChanged, 'emit');
      component.isSettingsDropdownOpen.set('outputs');

      component.selectOutputs(2);

      expect(component.outputsChanged.emit).toHaveBeenCalledWith(2);
      expect(component.isSettingsDropdownOpen()).toBeNull();
    });
  });

  describe('Duration Support', () => {
    const geminiOmni = MODEL_CONFIGS.find(
      m => m.value === 'gemini-omni-1.1-flash-preview',
    )!;

    beforeEach(() => {
      component.generationModels = MODEL_CONFIGS;
    });

    it('should support [4, 6, 8, 10] durations for Gemini Omni 1.1 Flash in Text to Video mode', () => {
      component.selectedGenerationModel = geminiOmni.viewValue;
      component.mode = 'Text to Video';

      const durations = component.getSelectedModelDurations();
      expect(durations).toEqual([4, 6, 8, 10]);
      expect(component.hasDurationOptions()).toBeTrue();
    });

    it('should return the full [4, 6, 8, 10] durations for Gemini Omni 1.1 Flash in Ingredients to Video mode at 1K', () => {
      component.selectedGenerationModel = geminiOmni.viewValue;
      component.mode = 'Ingredients to Video';
      component.selectedResolution.set('1K');

      const durations = component.getSelectedModelDurations();
      expect(durations).toEqual([4, 6, 8, 10]);
    });

    it('should return the full [4, 6, 8, 10] durations for Gemini Omni Flash in Frames to Video mode at 1K', () => {
      component.selectedGenerationModel = geminiOmni.viewValue;
      component.mode = 'Frames to Video';
      component.selectedResolution.set('1K');

      const durations = component.getSelectedModelDurations();
      expect(durations).toEqual([4, 6, 8, 10]);
    });

    it('should collapse to only the longest duration (10s) for resolutions above 1K', () => {
      component.selectedGenerationModel = geminiOmni.viewValue;
      component.mode = 'Ingredients to Video';
      component.selectedResolution.set('2K');

      const durations = component.getSelectedModelDurations();
      expect(durations).toEqual([10]);
    });

    it('should not wipe a valid 4s selection when switching modes at 1K', () => {
      component.selectedGenerationModel = geminiOmni.viewValue;
      component.mode = 'Text to Video';
      component.selectedResolution.set('1K');
      component.selectDuration(4);

      component.selectMode('Ingredients to Video');

      expect(component.selectedDuration()).toBe(4);
    });

    it('should identify omni models correctly with isOmniModel', () => {
      // The legacy 'gemini-omni-flash-preview' model was retired from
      // MODEL_CONFIGS (superseded by the 1.1 model below), but isOmniModel
      // must still recognize it for any media generated before the switch.
      // Pass model objects directly rather than relying on a MODEL_CONFIGS
      // viewValue lookup for a value that no longer exists in the list.
      expect(
        component.isOmniModel({value: 'gemini-omni-flash-preview'}),
      ).toBeTrue();

      expect(
        component.isOmniModel({value: 'gemini-omni-1.1-flash-preview'}),
      ).toBeTrue();

      component.selectedGenerationModel = geminiOmni.viewValue;
      expect(component.isOmniModel()).toBeTrue();

      const veo31 = MODEL_CONFIGS.find(
        m => m.value === 'veo-3.1-generate-001',
      )!;
      component.selectedGenerationModel = veo31.viewValue;
      expect(component.isOmniModel()).toBeFalse();
    });

    it('should update selectedDuration and emit durationChanged on selectDuration', () => {
      component.selectedGenerationModel = geminiOmni.viewValue;
      component.mode = 'Text to Video';
      spyOn(component.durationChanged, 'emit');

      component.selectDuration(10);
      expect(component.selectedDuration()).toBe(10);
      expect(component.durationChanged.emit).toHaveBeenCalledWith(10);
    });
  });

  describe('Video to Image / Video Reference Support', () => {
    const nanoBanana2 = MODEL_CONFIGS.find(
      m => m.value === 'gemini-3.1-flash-image',
    )!;
    const unsupportedModel = {
      value: 'unsupported-image-model',
      viewValue: 'Unsupported Image Model',
      type: 'IMAGE' as const,
      capabilities: {
        supportedModes: ['Text to Image' as const],
        maxReferenceImages: 0,
        supportedAspectRatios: ['1:1'],
        supportedResolutions: ['1K' as const],
        supportedDurations: [],
        supportsVideoReference: false,
      },
    };

    beforeEach(() => {
      component.generationModels = [...MODEL_CONFIGS, unsupportedModel];
    });

    it('should allow selecting models with supportsVideoReference in Video to Image mode', () => {
      component.mode = 'Video to Image';
      spyOn(component.modelSelected, 'emit');

      component.selectInternalModel(nanoBanana2);
      expect(component.modelSelected.emit).toHaveBeenCalledWith(nanoBanana2);
    });

    it('should prevent selecting models without supportsVideoReference in Video to Image mode', () => {
      component.mode = 'Video to Image';
      spyOn(component.modelSelected, 'emit');

      component.selectInternalModel(unsupportedModel);
      expect(component.modelSelected.emit).not.toHaveBeenCalled();
    });

    it('should allow selecting models without supportsVideoReference when not in Video to Image mode', () => {
      component.mode = 'Text to Image';
      spyOn(component.modelSelected, 'emit');

      component.selectInternalModel(unsupportedModel);
      expect(component.modelSelected.emit).toHaveBeenCalledWith(
        unsupportedModel,
      );
    });
  });

  describe('files from paste and drop', () => {
    const png = (name = 'a.png') => new File(['x'], name, {type: 'image/png'});
    const mp4 = new File(['x'], 'clip.mp4', {type: 'video/mp4'});
    const allModes = [
      'Text to Image',
      'Ingredients to Image',
      'Text to Video',
      'Frames to Video',
      'Ingredients to Video',
      'Extend Video',
      'Concatenate Video',
      'Video to Image',
    ].map(value => ({value, icon: '', label: value}));

    let refs: File[][];
    let slots: {num: number; file: File}[];
    let modes: string[];
    let notices: jasmine.Spy;

    beforeEach(() => {
      setAppInjector(TestBed.inject(Injector));
      notices = spyOn(TestBed.inject(NotificationService), 'show');
    });

    /** The toast messages shown so far. */
    const shown = () => notices.calls.allArgs().map(a => a[0] as string);

    /** Subscribes the way a host template binding does. */
    function bindFileOutputs(which: 'both' | 'slot' = 'both'): void {
      refs = [];
      slots = [];
      modes = [];
      if (which === 'both') {
        component.referenceFilesAdded.subscribe(f => refs.push(f));
      }
      component.slotFileAdded.subscribe(s => slots.push(s));
      component.modeChanged.subscribe(m => modes.push(m));
    }

    function paste(...files: File[]): ClipboardEvent {
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      const event = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event;
    }

    function drop(testId: string, ...files: File[]): void {
      const el = (fixture.nativeElement as HTMLElement).querySelector(
        `[data-testid="${testId}"]`,
      );
      expect(el).withContext(testId).not.toBeNull();
      const dt = new DataTransfer();
      files.forEach(f => dt.items.add(f));
      el!.dispatchEvent(
        new DragEvent('drop', {
          dataTransfer: dt,
          bubbles: true,
          cancelable: true,
        }),
      );
    }

    function show(mode: string, opts: {start?: boolean} = {}): void {
      component.modes = allModes;
      component.mode = mode;
      component.image1Preview = opts.start ? 'https://x.test/start.png' : null;
      fixture.detectChanges();
    }

    describe('pasted', () => {
      const cases: {
        name: string;
        mode: string;
        start?: boolean;
        offered?: string[];
        files: File[];
        refs?: number;
        slot?: number;
        switchTo?: string;
        rejected?: boolean;
        slotAccept?: string;
      }[] = [
        {
          name: 'Ingredients to Image adds every image as a reference',
          mode: 'Ingredients to Image',
          files: [png('1.png'), png('2.png')],
          refs: 2,
        },
        {
          name: 'Ingredients to Video adds every image as a reference',
          mode: 'Ingredients to Video',
          files: [png('1.png'), png('2.png')],
          refs: 2,
        },
        {
          name: 'Ingredients to Video takes no video',
          mode: 'Ingredients to Video',
          files: [mp4],
          rejected: true,
        },
        {
          name: 'Frames to Video fills an empty start frame',
          mode: 'Frames to Video',
          files: [png('1.png'), png('2.png')],
          slot: 1,
        },
        {
          name: 'Frames to Video fills the end frame once there is a start',
          mode: 'Frames to Video',
          start: true,
          files: [png()],
          slot: 2,
        },
        {
          name: 'Concatenate Video fills the second slot once there is a first',
          mode: 'Concatenate Video',
          start: true,
          files: [mp4],
          slot: 2,
        },
        {
          name: 'Extend Video always replaces its one slot',
          mode: 'Extend Video',
          start: true,
          files: [mp4],
          slot: 1,
        },
        {
          name: 'Text to Image switches to Ingredients to Image',
          mode: 'Text to Image',
          files: [png()],
          switchTo: 'Ingredients to Image',
          refs: 1,
        },
        {
          name: 'Text to Image takes no video',
          mode: 'Text to Image',
          files: [mp4],
          rejected: true,
        },
        {
          name: 'Text to Video switches to Frames to Video with a start frame',
          mode: 'Text to Video',
          files: [png()],
          switchTo: 'Frames to Video',
          slot: 1,
        },
        {
          // A video would move the page on to Extend Video and clear the
          // prompt the user typed.
          name: 'Text to Video takes no video',
          mode: 'Text to Video',
          files: [mp4],
          rejected: true,
        },
        {
          name: 'Text to Video takes an image even when leftover inputs narrow the slots',
          mode: 'Text to Video',
          slotAccept: 'video/mp4',
          files: [png()],
          switchTo: 'Frames to Video',
          slot: 1,
        },
        {
          name: 'Text to Image stays put when Ingredients is not offered',
          mode: 'Text to Image',
          offered: ['Text to Image'],
          files: [png()],
        },
        {
          name: 'Text to Video stays put when Frames is not offered',
          mode: 'Text to Video',
          offered: ['Text to Video', 'Ingredients to Video'],
          files: [png()],
        },
        {
          name: 'Video to Image is not a text-only mode, so it does not switch',
          mode: 'Video to Image',
          files: [png()],
        },
      ];

      for (const c of cases) {
        it(c.name, () => {
          bindFileOutputs();
          if (c.slotAccept) component.slotAccept = c.slotAccept;
          show(c.mode, {start: c.start});
          if (c.offered) {
            component.modes = allModes.filter(m =>
              c.offered!.includes(m.value),
            );
          }

          paste(...c.files);

          expect(modes)
            .withContext('mode switch')
            .toEqual(c.switchTo ? [c.switchTo] : []);
          expect(component.mode).toBe(c.switchTo ?? c.mode);
          expect(refs.map(r => r.length))
            .withContext('references')
            .toEqual(c.refs ? [c.refs] : []);
          expect(slots.map(s => [s.num, s.file.name]))
            .withContext('slot')
            .toEqual(c.slot ? [[c.slot, c.files[0].name]] : []);
          expect(shown())
            .withContext('rejection toast')
            .toEqual(c.rejected ? ["Can't use clip.mp4 here."] : []);
        });
      }
    });

    // The feed composer renders the prompt box without the file outputs. A
    // paste there must reach the browser rather than vanish.
    describe('paste is left to the browser', () => {
      it('when the host takes no files', () => {
        show('Ingredients to Image');
        expect(paste(png()).defaultPrevented).toBeFalse();
      });

      it('while a generation is being submitted', () => {
        bindFileOutputs();
        show('Ingredients to Image');
        component.isLoading = true;
        fixture.detectChanges();
        expect(paste(png()).defaultPrevented).toBeFalse();
        expect(refs).toEqual([]);
      });

      for (const which of ['both', 'slot'] as const) {
        it(`but not once the host binds ${which === 'both' ? 'the file outputs' : 'only the slot output'}`, () => {
          bindFileOutputs(which);
          show('Frames to Video');
          expect(paste(png()).defaultPrevented).toBeTrue();
        });
      }
    });

    // As with paste, a host that takes no files (the feed composer) leaves
    // the drag alone: no highlight, and nothing claims the drop.
    describe('drop zones', () => {
      const flashImage = MODEL_CONFIGS.find(
        m => m.value === 'gemini-2.5-flash-image',
      )!;
      const zones: {zone: string; mode: string; own: 'slot' | 'refs'}[] = [
        {zone: 'frame-slot-1', mode: 'Frames to Video', own: 'slot'},
        {zone: 'frame-slot-2', mode: 'Frames to Video', own: 'slot'},
        {
          zone: 'reference-drop-zone',
          mode: 'Ingredients to Image',
          own: 'refs',
        },
      ];
      const binds = ['nothing', 'only the other output', 'its output'] as const;

      for (const {zone, mode, own} of zones) {
        for (const bound of binds) {
          const takes = bound === 'its output';
          it(`${zone} ${takes ? 'takes' : 'leaves'} a file drag when the host binds ${bound}`, () => {
            component.generationModels = MODEL_CONFIGS;
            component.selectedGenerationModel = flashImage.viewValue;
            const other = own === 'slot' ? 'refs' : 'slot';
            const output = {
              slot: component.slotFileAdded,
              refs: component.referenceFilesAdded,
            } as const;
            if (bound === 'its output') output[own].subscribe();
            if (bound === 'only the other output') output[other].subscribe();
            show(mode);
            const el = (fixture.nativeElement as HTMLElement).querySelector(
              `[data-testid="${zone}"]`,
            )!;
            const dt = new DataTransfer();
            dt.items.add(png());
            const drag = (type: string) => {
              const e = new DragEvent(type, {
                dataTransfer: dt,
                bubbles: true,
                cancelable: true,
              });
              el.dispatchEvent(e);
              return e;
            };

            drag('dragenter');
            fixture.detectChanges();
            expect(el.classList.contains('file-drop-active'))
              .withContext('highlight')
              .toBe(takes);
            expect(drag('drop').defaultPrevented)
              .withContext('drop claimed')
              .toBe(takes);
          });
        }
      }
    });

    it('shows the second slot everywhere but Extend Video', () => {
      bindFileOutputs();
      for (const [mode, slots] of [
        ['Frames to Video', ['frame-slot-1', 'frame-slot-2']],
        ['Concatenate Video', ['frame-slot-1', 'frame-slot-2']],
        ['Extend Video', ['frame-slot-1']],
      ] as const) {
        show(mode);
        const shown = Array.from(
          (fixture.nativeElement as HTMLElement).querySelectorAll(
            '[data-testid^="frame-slot-"]',
          ),
        ).map(el => el.getAttribute('data-testid'));
        expect(shown)
          .withContext(mode)
          .toEqual([...slots]);
      }
    });

    describe('dropped', () => {
      it('onto a frame slot fill that slot', () => {
        bindFileOutputs();
        show('Frames to Video');
        drop('frame-slot-1', png('start.png'));
        drop('frame-slot-2', png('end.png'));
        expect(slots.map(s => [s.num, s.file.name])).toEqual([
          [1, 'start.png'],
          [2, 'end.png'],
        ]);
      });

      it('onto a frame slot must match what the host says it takes', () => {
        bindFileOutputs();
        show('Extend Video');
        component.slotAccept = 'video/mp4';
        fixture.detectChanges();
        drop('frame-slot-1', png());
        expect(slots).toEqual([]);
        expect(shown()).toEqual(["Can't use a.png here."]);
      });

      describe('onto the reference zone', () => {
        const flashImage = MODEL_CONFIGS.find(
          m => m.value === 'gemini-2.5-flash-image',
        )!;

        beforeEach(() => {
          component.generationModels = MODEL_CONFIGS;
          component.selectedGenerationModel = flashImage.viewValue;
          bindFileOutputs();
        });

        it('add every image', () => {
          show('Ingredients to Image');
          drop('reference-drop-zone', png('1.png'), png('2.png'));
          expect(refs.map(r => r.map(f => f.name))).toEqual([
            ['1.png', '2.png'],
          ]);
        });

        it('add nothing once the model is full', () => {
          component.referenceImages = Array.from(
            {length: flashImage.capabilities.maxReferenceImages},
            (_, i) => ({previewUrl: `ref-${i}`}),
          );
          show('Ingredients to Image');
          drop('reference-drop-zone', png());
          expect(refs).toEqual([]);
        });
      });
    });
  });

  describe('Enter to submit', () => {
    const textarea = () =>
      (fixture.nativeElement as HTMLElement).querySelector('textarea')!;
    const generateButton = () =>
      Array.from(
        (fixture.nativeElement as HTMLElement).querySelectorAll('button'),
      ).find(b => b.textContent?.includes('Generate'))!;

    /** Presses a key on the real textarea, the way the browser delivers it. */
    function press(init: KeyboardEventInit, keyCode?: number) {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
        ...init,
      });
      if (keyCode !== undefined) {
        Object.defineProperty(event, 'keyCode', {get: () => keyCode});
      }
      textarea().dispatchEvent(event);
      return event;
    }

    let generated: jasmine.Spy;
    beforeEach(() => {
      generated = jasmine.createSpy('generateClicked');
      component.generateClicked.subscribe(generated);
    });

    const keys: {
      name: string;
      init: KeyboardEventInit;
      keyCode?: number;
      submits: boolean;
    }[] = [
      {name: 'Enter', init: {}, submits: true},
      // Ctrl+Enter is left to the window listeners on home and video.
      {name: 'Ctrl+Enter', init: {ctrlKey: true}, submits: false},
      {name: 'Shift+Enter', init: {shiftKey: true}, submits: false},
      {name: 'IME Enter', init: {isComposing: true}, submits: false},
      {name: 'Safari IME Enter', init: {}, keyCode: 229, submits: false},
    ];
    for (const k of keys) {
      it(`${k.name} ${k.submits ? 'submits once and adds no newline' : 'neither submits nor is taken from the textarea'}`, () => {
        const event = press(k.init, k.keyCode);
        expect(generated).toHaveBeenCalledTimes(k.submits ? 1 : 0);
        expect(event.defaultPrevented).toBe(k.submits);
      });
    }

    it('is swallowed while Generate is disabled', () => {
      fixture.componentRef.setInput('isLoading', true);
      fixture.detectChanges();
      expect(generateButton().disabled).toBeTrue();

      const event = press({});
      expect(generated).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBeTrue();
    });

    it('shows the shared hint, except in Concatenate Video where there is no prompt', () => {
      const hint = () =>
        (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="submit-hint"]',
        );
      expect(hint()?.textContent?.trim()).toBe(PROMPT_SUBMIT_HINT);

      fixture.componentRef.setInput('mode', 'Concatenate Video');
      fixture.detectChanges();
      expect(hint()).toBeNull();
    });
  });
});
