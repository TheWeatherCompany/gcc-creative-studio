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

import {ApplicationRef, CUSTOM_ELEMENTS_SCHEMA} from '@angular/core';
import {
  ComponentFixture,
  TestBed,
  fakeAsync,
  flush,
} from '@angular/core/testing';
import {CommonModule} from '@angular/common';
import {ReactiveFormsModule} from '@angular/forms';
import {OverlayContainer} from '@angular/cdk/overlay';
import {MatDialog, MatDialogModule} from '@angular/material/dialog';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatIconModule} from '@angular/material/icon';
import {MatInputModule} from '@angular/material/input';
import {MatSelectModule} from '@angular/material/select';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {MatTooltipModule} from '@angular/material/tooltip';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {provideRouter} from '@angular/router';
import {BehaviorSubject, of} from 'rxjs';

import {WorkspaceSwitcherComponent} from '../workspace-switcher/workspace-switcher.component';
import {CreateWorkspaceModalComponent} from '../create-workspace-modal/create-workspace-modal.component';
import {InviteUserModalComponent} from '../invite-user-modal/invite-user-modal.component';
import {BrandGuidelineDialogComponent} from '../brand-guideline-dialog/brand-guideline-dialog.component';
import {BrandGuidelineModel} from '../../models/brand-guideline.model';
import {JobStatus} from '../../models/media-item.model';
import {AuthService} from '../../services/auth.service';
import {UserService} from '../../services/user.service';
import {BrandGuidelineService} from '../../services/brand-guideline/brand-guideline.service';
import {WorkspaceStateService} from '../../../services/workspace/workspace-state.service';
import {WorkspaceService} from '../../../services/workspace/workspace.service';
import {Workspace, WorkspaceScope} from '../../models/workspace.model';

/**
 * Drives the picker the way a user does: through the header switcher, a real
 * MatDialog and the real WorkspaceStateService, so a broken hand-off between
 * the picker and the switcher fails here rather than in production.
 */
describe('Workspace picker', () => {
  let fixture: ComponentFixture<WorkspaceSwitcherComponent>;
  let overlay: HTMLElement;
  let workspaces: Workspace[];
  let guidelineJob$: BehaviorSubject<BrandGuidelineModel | null>;

  const workspace = (
    id: number,
    name: string,
    createdAt: string,
    scope = WorkspaceScope.PRIVATE,
  ): Workspace => ({
    id,
    name,
    ownerId: '1',
    scope,
    members: [],
    memberIds: [],
    createdAt,
  });

  // Deliberately not in display order: the API does not sort.
  const fewWorkspaces = () => [
    workspace(2, 'Old Campaign', '2025-06-01T10:00:00Z'),
    workspace(
      1,
      'Shared Gallery',
      '2025-01-01T10:00:00Z',
      WorkspaceScope.PUBLIC,
    ),
    workspace(4, 'Winter Spot', '2026-03-15T10:00:00Z'),
    workspace(3, 'Hurricane Promo', '2026-09-01T10:00:00Z'),
  ];

  beforeEach(async () => {
    workspaces = fewWorkspaces();
    guidelineJob$ = new BehaviorSubject<BrandGuidelineModel | null>(null);
    localStorage.removeItem('activeWorkspaceId');

    await TestBed.configureTestingModule({
      declarations: [
        WorkspaceSwitcherComponent,
        CreateWorkspaceModalComponent,
        InviteUserModalComponent,
        BrandGuidelineDialogComponent,
      ],
      imports: [
        CommonModule,
        NoopAnimationsModule,
        ReactiveFormsModule,
        MatDialogModule,
        MatFormFieldModule,
        MatIconModule,
        MatInputModule,
        MatSelectModule,
        MatSnackBarModule,
        MatTooltipModule,
      ],
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {sessionReady$: new BehaviorSubject(true)},
        },
        {
          provide: WorkspaceService,
          useValue: {getWorkspaces: () => of(workspaces)},
        },
        {
          provide: BrandGuidelineService,
          useValue: {
            activeBrandGuidelineJob$: guidelineJob$,
            clearActiveJob: () => {},
            clearCache: () => {},
            getBrandGuidelineForWorkspace: () => of(null),
          },
        },
        {
          provide: UserService,
          useValue: {getUserDetails: () => ({id: '1', roles: []})},
        },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    overlay = TestBed.inject(OverlayContainer).getContainerElement();
  });

  afterEach(() => {
    TestBed.inject(MatDialog).closeAll();
    localStorage.removeItem('activeWorkspaceId');
  });

  /**
   * Dialogs render outside the fixture, so fixture.detectChanges() alone does
   * not refresh them; settle timers and tick the whole application.
   */
  const settle = () => {
    fixture.detectChanges();
    flush();
    TestBed.inject(ApplicationRef).tick();
    fixture.detectChanges();
  };

  /** Loads the switcher, then clicks the current-workspace pill. */
  const openPicker = () => {
    fixture = TestBed.createComponent(WorkspaceSwitcherComponent);
    fixture.detectChanges();
    const pill = fixture.nativeElement.querySelector(
      '.workspace-container[role="button"]',
    ) as HTMLElement;
    pill.click();
    settle();
  };

  const cardNames = () =>
    Array.from(
      overlay.querySelectorAll('.workspace-card[data-workspace-id]'),
    ).map(card => card.querySelector('.card-name')!.textContent!.trim());

  const clickCard = (id: number) => {
    (
      overlay.querySelector(
        `.workspace-card[data-workspace-id="${id}"]`,
      ) as HTMLElement
    ).click();
    settle();
  };

  it('lists workspaces newest first, with the public workspace pinned on top', fakeAsync(() => {
    openPicker();

    expect(cardNames()).toEqual([
      'Shared Gallery',
      'Hurricane Promo',
      'Winter Spot',
      'Old Campaign',
    ]);
  }));

  it('marks only the active workspace as current', fakeAsync(() => {
    localStorage.setItem('activeWorkspaceId', '4');

    openPicker();

    const current = overlay.querySelectorAll(
      '.workspace-card[aria-current="true"]',
    );
    expect(current.length).toBe(1);
    expect(current[0].getAttribute('data-workspace-id')).toBe('4');
    expect(current[0].textContent).toContain('Current');
    expect(overlay.querySelectorAll('.current-badge').length).toBe(1);
  }));

  it('switches the active workspace when a card is clicked', fakeAsync(() => {
    openPicker();

    clickCard(3);

    expect(TestBed.inject(WorkspaceStateService).getActiveWorkspaceId()).toBe(
      3,
    );
    expect(
      fixture.nativeElement.querySelector('.workspace-name').textContent.trim(),
    ).toBe('Hurricane Promo');
    expect(overlay.querySelector('app-workspace-picker-dialog')).toBeNull();
  }));

  it('opens the create-workspace modal from the picker', fakeAsync(() => {
    openPicker();

    (overlay.querySelector('.create-card') as HTMLElement).click();
    settle();

    expect(overlay.querySelector('app-workspace-picker-dialog')).toBeNull();
    expect(overlay.querySelector('app-create-workspace-modal')).not.toBeNull();
  }));

  it('filters the cards by name once there are many workspaces', fakeAsync(() => {
    workspaces = [
      ...fewWorkspaces(),
      workspace(5, 'Spring Promo', '2026-04-01T10:00:00Z'),
      workspace(6, 'Radar Loops', '2026-05-01T10:00:00Z'),
      workspace(7, 'Election Night', '2026-06-01T10:00:00Z'),
      workspace(8, 'Storm Chasers', '2026-07-01T10:00:00Z'),
    ];
    openPicker();

    const filter = overlay.querySelector('.filter-input') as HTMLInputElement;
    filter.value = 'PROMO';
    filter.dispatchEvent(new Event('input'));
    settle();

    expect(cardNames()).toEqual(['Hurricane Promo', 'Spring Promo']);
    // Creating a workspace stays one click away while filtering.
    expect(overlay.querySelector('.create-card')).not.toBeNull();
  }));

  const clickIn = (selector: string) => {
    (overlay.querySelector(selector) as HTMLElement).click();
    settle();
  };

  // Invite and Brand guidelines used to sit in the dropdown; the picker's
  // current-workspace bar is now the only way to reach them.
  it('opens the invite modal for the current workspace from the picker', fakeAsync(() => {
    localStorage.setItem('activeWorkspaceId', '4');
    openPicker();

    clickIn('.invite-action');

    expect(overlay.querySelector('app-workspace-picker-dialog')).toBeNull();
    const invite = overlay.querySelector('app-invite-user-modal');
    expect(invite).not.toBeNull();
    expect(invite!.textContent).toContain('Invite to Winter Spot');
  }));

  it('does not offer invites on the public workspace', fakeAsync(() => {
    localStorage.setItem('activeWorkspaceId', '1');
    openPicker();

    const invite = overlay.querySelector('.invite-action') as HTMLButtonElement;
    expect(invite.disabled).toBeTrue();
  }));

  it('opens brand guidelines for the current workspace from the picker', fakeAsync(() => {
    localStorage.setItem('activeWorkspaceId', '4');
    openPicker();

    clickIn('.guidelines-action');

    expect(overlay.querySelector('app-workspace-picker-dialog')).toBeNull();
    expect(overlay.querySelector('app-brand-guideline-dialog')).not.toBeNull();
  }));

  it('shows a processing guideline upload and blocks a second one', fakeAsync(() => {
    localStorage.setItem('activeWorkspaceId', '4');
    guidelineJob$.next({status: JobStatus.PROCESSING} as BrandGuidelineModel);
    openPicker();

    // Visible on the pill even with the picker closed, as the menu spinner was.
    expect(
      fixture.nativeElement.querySelector(
        '.workspace-container mat-progress-spinner',
      ),
    ).not.toBeNull();
    const button = overlay.querySelector(
      '.guidelines-action',
    ) as HTMLButtonElement;
    expect(button.disabled).toBeTrue();
    expect(button.querySelector('mat-progress-spinner')).not.toBeNull();
  }));
});
