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
import {FormsModule} from '@angular/forms';
import {
  MatDialogModule,
  MatDialogRef,
  MAT_DIALOG_DATA,
} from '@angular/material/dialog';
import {MatIconModule} from '@angular/material/icon';
import {
  CreateFolderDialogComponent,
  CreateFolderDialogData,
} from './create-folder-dialog.component';

describe('CreateFolderDialogComponent', () => {
  let component: CreateFolderDialogComponent;
  let fixture: ComponentFixture<CreateFolderDialogComponent>;
  let dialogRef: jasmine.SpyObj<MatDialogRef<CreateFolderDialogComponent>>;

  async function setUp(data: CreateFolderDialogData): Promise<void> {
    dialogRef = jasmine.createSpyObj('MatDialogRef', ['close']);
    await TestBed.configureTestingModule({
      declarations: [CreateFolderDialogComponent],
      imports: [MatDialogModule, MatIconModule, FormsModule],
      providers: [
        {provide: MatDialogRef, useValue: dialogRef},
        {provide: MAT_DIALOG_DATA, useValue: data},
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(CreateFolderDialogComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  describe('create mode', () => {
    beforeEach(() =>
      setUp({workspaceId: 1, existingFolderNames: ['Campaigns']}),
    );

    it('rejects a blank name', () => {
      component.folderName = '   ';
      expect(component.isValid).toBeFalse();
    });

    it('flags a sibling name regardless of case and whitespace', () => {
      component.folderName = '  campaigns ';
      expect(component.isDuplicateName).toBeTrue();
      expect(component.isValid).toBeFalse();
    });

    it('closes with the trimmed name and chosen color', () => {
      component.folderName = '  Summer  ';
      component.selectedColor = '#81C995';
      component.save();
      expect(dialogRef.close).toHaveBeenCalledWith({
        name: 'Summer',
        color: '#81C995',
      });
    });

    it('does not close when the name is invalid', () => {
      component.folderName = 'Campaigns';
      component.save();
      expect(dialogRef.close).not.toHaveBeenCalled();
    });
  });

  describe('rename mode', () => {
    beforeEach(() =>
      setUp({
        workspaceId: 1,
        existingFolderNames: ['Campaigns', 'Archive'],
        folder: {
          id: 5,
          workspaceId: 1,
          userEmail: 'user@example.com',
          name: 'Campaigns',
          color: '#C58AF9',
          itemCount: 0,
          subfolderCount: 0,
        },
      }),
    );

    it('prefills the folder and allows keeping its own name', () => {
      expect(component.isEditMode).toBeTrue();
      expect(component.folderName).toBe('Campaigns');
      expect(component.selectedColor).toBe('#C58AF9');
      expect(component.isValid).toBeTrue();
    });

    it('still flags another sibling name', () => {
      component.folderName = 'Archive';
      expect(component.isDuplicateName).toBeTrue();
    });
  });
});
