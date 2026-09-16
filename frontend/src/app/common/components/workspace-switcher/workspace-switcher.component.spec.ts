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

import {CUSTOM_ELEMENTS_SCHEMA} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {CommonModule} from '@angular/common';
import {MatDialogModule} from '@angular/material/dialog';
import {MatDividerModule} from '@angular/material/divider';
import {MatIconModule} from '@angular/material/icon';
import {MatMenuModule} from '@angular/material/menu';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatSnackBarModule} from '@angular/material/snack-bar';
import {MatTooltipModule} from '@angular/material/tooltip';
import {NoopAnimationsModule} from '@angular/platform-browser/animations';
import {provideRouter} from '@angular/router';
import {BehaviorSubject, Subject, of} from 'rxjs';

import {WorkspaceSwitcherComponent} from './workspace-switcher.component';
import {AuthService} from '../../services/auth.service';
import {UserService} from '../../services/user.service';
import {BrandGuidelineService} from '../../services/brand-guideline/brand-guideline.service';
import {WorkspaceStateService} from '../../../services/workspace/workspace-state.service';
import {WorkspaceService} from '../../../services/workspace/workspace.service';
import {Workspace, WorkspaceScope} from '../../models/workspace.model';

/**
 * The switcher lives in the app shell, so Angular constructs it while the Okta
 * callback is still exchanging the code for a session. Fetching workspaces from
 * `ngOnInit` directly sent the request before any token existed, drew a 401, and
 * left the switcher empty behind a red "Could not load workspaces" toast. The
 * fix gates the fetch on `authService.sessionReady$`.
 *
 * These tests assert the *ordering*, which is the whole point: `sessionReady$`
 * is a Subject that has deliberately NOT emitted when `ngOnInit` runs. Stubbing
 * it as a synchronous `of(true)` would let these tests pass even with the gate
 * deleted, which is exactly how an equivalent admin-paginator regression got
 * through. If the gate is removed, the "before the session is ready" assertion
 * below fails.
 */
describe('WorkspaceSwitcherComponent session readiness gate', () => {
  let component: WorkspaceSwitcherComponent;
  let fixture: ComponentFixture<WorkspaceSwitcherComponent>;

  /** Not a BehaviorSubject and not `of(...)`: nothing is ready at ngOnInit. */
  let sessionReady$: Subject<boolean>;
  let getWorkspaces: jasmine.Spy;

  const publicWorkspace: Workspace = {
    id: 1,
    name: 'Google',
    ownerId: '1',
    scope: WorkspaceScope.PUBLIC,
    members: [],
    memberIds: [],
  };

  beforeEach(async () => {
    sessionReady$ = new Subject<boolean>();
    getWorkspaces = jasmine
      .createSpy('getWorkspaces')
      .and.returnValue(of([publicWorkspace]));

    await TestBed.configureTestingModule({
      declarations: [WorkspaceSwitcherComponent],
      imports: [
        CommonModule,
        NoopAnimationsModule,
        MatDialogModule,
        MatDividerModule,
        MatIconModule,
        MatMenuModule,
        MatProgressSpinnerModule,
        MatSnackBarModule,
        MatTooltipModule,
      ],
      providers: [
        provideRouter([]),
        {
          provide: AuthService,
          useValue: {sessionReady$: sessionReady$.asObservable()},
        },
        {
          provide: WorkspaceService,
          useValue: {
            getWorkspaces,
            createWorkspace: jasmine.createSpy('createWorkspace'),
            inviteUser: jasmine.createSpy('inviteUser'),
          },
        },
        {
          provide: WorkspaceStateService,
          useValue: {
            activeWorkspaceId$: new BehaviorSubject<number | null>(null),
            setActiveWorkspaceId: jasmine.createSpy('setActiveWorkspaceId'),
            getActiveWorkspaceId: () => null,
          },
        },
        {
          provide: BrandGuidelineService,
          useValue: {
            activeBrandGuidelineJob$: of(null),
            clearActiveJob: jasmine.createSpy('clearActiveJob'),
            clearCache: jasmine.createSpy('clearCache'),
            getBrandGuidelineForWorkspace: jasmine
              .createSpy('getBrandGuidelineForWorkspace')
              .and.returnValue(of(null)),
          },
        },
        {
          provide: UserService,
          useValue: {
            getUserDetails: () => ({
              id: '1',
              name: 'Test User',
              email: 'test@example.com',
              roles: [],
            }),
          },
        },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkspaceSwitcherComponent);
    component = fixture.componentInstance;
    // Clear any workspace preference a sibling spec left behind, so
    // initializeActiveWorkspace takes a deterministic path.
    localStorage.removeItem('activeWorkspaceId');
  });

  // A successful load writes the chosen workspace back to localStorage, and
  // Karma shares one browser context across every spec file. Clean up after
  // the fact too, so nothing downstream inherits this spec's preference.
  afterEach(() => {
    localStorage.removeItem('activeWorkspaceId');
  });

  it('does not fetch workspaces before the session is ready', () => {
    fixture.detectChanges(); // runs ngOnInit

    expect(getWorkspaces).not.toHaveBeenCalled();
  });

  it('does not fetch workspaces while the session reports not ready', () => {
    fixture.detectChanges();

    sessionReady$.next(false);

    expect(getWorkspaces).not.toHaveBeenCalled();
  });

  it('fetches workspaces exactly once when the session becomes ready', () => {
    fixture.detectChanges();
    expect(getWorkspaces).not.toHaveBeenCalled();

    sessionReady$.next(true);

    expect(getWorkspaces).toHaveBeenCalledTimes(1);
    expect(component.workspaces).toEqual([publicWorkspace]);
  });

  // `take(1)` matters: sessionReady$ flips back to false on logout and to true
  // again on the next login, and a re-fetch per emission would hammer the API
  // from a component that is only ever built once.
  it('does not re-fetch on later session-ready emissions', () => {
    fixture.detectChanges();

    sessionReady$.next(true);
    sessionReady$.next(true);
    sessionReady$.next(false);
    sessionReady$.next(true);

    expect(getWorkspaces).toHaveBeenCalledTimes(1);
  });
});
