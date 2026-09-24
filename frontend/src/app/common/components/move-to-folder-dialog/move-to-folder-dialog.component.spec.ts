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
import {provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  MatDialogModule,
  MatDialogRef,
  MAT_DIALOG_DATA,
} from '@angular/material/dialog';
import {MatIconModule} from '@angular/material/icon';
import {MatTabsModule} from '@angular/material/tabs';
import {FormsModule} from '@angular/forms';
import {of} from 'rxjs';
import {
  MoveToFolderDialogComponent,
  MoveToFolderDialogData,
} from './move-to-folder-dialog.component';
import {WorkspaceService} from '../../../services/workspace/workspace.service';
import {FolderTreeNode} from '../../models/folder.model';
import {Workspace, WorkspaceScope} from '../../models/workspace.model';
import {environment} from '../../../../environments/environment';

/** A single-branch tree whose node at depth d has id d, down to `levels`. */
function chain(levels: number): FolderTreeNode {
  let node: FolderTreeNode = {
    id: levels,
    name: `Level ${levels}`,
    children: [],
  };
  for (let d = levels - 1; d >= 1; d--) {
    node = {id: d, name: `Level ${d}`, children: [node]};
  }
  return node;
}

/**
 * These tests run the real FolderService over HttpTestingController, so the
 * depth checks use the maxDepth that must match the backend's
 * MAX_FOLDER_DEPTH rather than a value the test sets.
 */
describe('MoveToFolderDialogComponent', () => {
  let component: MoveToFolderDialogComponent;
  let fixture: ComponentFixture<MoveToFolderDialogComponent>;
  let httpMock: HttpTestingController;
  let dialogRef: jasmine.SpyObj<MatDialogRef<MoveToFolderDialogComponent>>;

  const workspaces: Workspace[] = [
    {
      id: 1,
      name: 'Current',
      ownerId: 'user-1',
      scope: WorkspaceScope.PUBLIC,
      members: [],
      memberIds: [],
    },
    {
      id: 2,
      name: 'Other',
      ownerId: 'user-1',
      scope: WorkspaceScope.PRIVATE,
      members: [],
      memberIds: [],
    },
  ];

  // Folder 100 (height 2, with child 101) is being moved; 200 holds the
  // items today; the chain reaches depth 19.
  const tree: FolderTreeNode[] = [
    chain(19),
    {
      id: 100,
      name: 'Moving',
      children: [{id: 101, name: 'Moving child', children: []}],
    },
    {id: 200, name: 'Current folder', children: []},
  ];

  async function setUp(data: MoveToFolderDialogData): Promise<void> {
    dialogRef = jasmine.createSpyObj('MatDialogRef', ['close']);
    const workspaceService = jasmine.createSpyObj('WorkspaceService', [
      'getWorkspaces',
    ]);
    workspaceService.getWorkspaces.and.returnValue(of(workspaces));

    await TestBed.configureTestingModule({
      declarations: [MoveToFolderDialogComponent],
      imports: [MatDialogModule, MatIconModule, MatTabsModule, FormsModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {provide: MatDialogRef, useValue: dialogRef},
        {provide: MAT_DIALOG_DATA, useValue: data},
        {provide: WorkspaceService, useValue: workspaceService},
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    httpMock = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MoveToFolderDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  const treeRequest = () =>
    httpMock.expectOne(`${environment.backendURL}/folders/tree?workspace_id=1`);

  const option = (id: number | null) =>
    component.folderOptions.find(o => o.id === id)!;

  afterEach(() => {
    httpMock.verify();
  });

  describe('when moving a folder', () => {
    beforeEach(async () => {
      await setUp({
        workspaceId: 1,
        itemCount: 1,
        movingFolderIds: [100],
        currentFolderId: 200,
      });
      treeRequest().flush(tree);
    });

    it('lists root plus every folder, and disables the current workspace', () => {
      expect(component.isLoading).toBeFalse();
      expect(component.loadError).toBeNull();
      expect(component.folderOptions.length).toBe(1 + 19 + 2 + 1);
      expect(component.workspaceOptions.map(w => w.disabled)).toEqual([
        true,
        false,
      ]);
    });

    it('disables the current location', () => {
      expect(option(200).disabled).toBeTrue();
      expect(option(200).disabledReason).toBe('Current location');
    });

    it('disables the moving folder and its subfolders', () => {
      expect(option(100).disabledReason).toBe(
        'Cannot move into self/subfolder',
      );
      expect(option(101).disabled).toBeTrue();
      expect(option(101).disabledReason).toBe(
        'Cannot move into self/subfolder',
      );
    });

    it('allows the deepest destination the backend accepts, and no deeper', () => {
      // Backend rule: dest_depth + subtree_depth > MAX_FOLDER_DEPTH (20).
      // The moving subtree is 2 deep, so depth 18 fits and depth 19 does not.
      expect(option(18).disabled).toBeFalse();
      expect(option(19).disabled).toBeTrue();
      expect(option(19).disabledReason).toBe('Max depth (20) reached');
    });

    it('keeps root selectable because it is not the current location', () => {
      expect(option(null).disabled).toBeFalse();
    });

    it('closes with the folder destination', () => {
      component.selectOption(option(18));
      component.confirm();
      expect(dialogRef.close).toHaveBeenCalledWith({
        destinationWorkspaceId: undefined,
        destinationFolderId: 18,
        destinationName: 'Level 18',
      });
    });

    it('ignores a disabled folder', () => {
      component.selectOption(option(101));
      expect(component.selectedDestinationId).toBeUndefined();
    });

    it('closes with the workspace destination from the workspace tab', () => {
      component.onSelectedTabChange({index: 1, tab: {} as never});
      component.selectWorkspace(component.workspaceOptions[1]);
      component.confirm();
      expect(dialogRef.close).toHaveBeenCalledWith({
        destinationWorkspaceId: 2,
        destinationFolderId: undefined,
        destinationName: 'Other',
      });
    });
  });

  describe('when moving only items', () => {
    beforeEach(async () => {
      await setUp({workspaceId: 1, itemCount: 3, currentFolderId: null});
      treeRequest().flush(tree);
    });

    it('applies no depth limit and disables root as the current location', () => {
      expect(option(19).disabled).toBeFalse();
      expect(option(null).disabled).toBeTrue();
      expect(option(null).disabledReason).toBe('Current location');
    });
  });

  describe('when the folder tree fails to load', () => {
    beforeEach(async () => {
      spyOn(console, 'error');
      await setUp({workspaceId: 1, itemCount: 1, currentFolderId: null});
    });

    it('shows the backend detail with the moved-or-deleted hint', () => {
      treeRequest().flush(
        {detail: "Workspace with ID '1' not found."},
        {status: 404, statusText: 'Not Found'},
      );
      fixture.detectChanges();

      expect(component.isLoading).toBeFalse();
      expect(component.loadError).toBe(
        "Workspace with ID '1' not found. It may have been moved or deleted. Refresh and try again.",
      );
      const alert: HTMLElement | null =
        fixture.nativeElement.querySelector('[role="alert"]');
      expect(alert?.textContent).toContain(
        'It may have been moved or deleted.',
      );
    });

    it('shows a generic message when the error has no detail', () => {
      treeRequest().flush(null, {status: 0, statusText: 'Unknown Error'});

      expect(component.loadError).toBe(
        'Could not load destinations. Close this dialog and try again.',
      );
    });
  });
});
