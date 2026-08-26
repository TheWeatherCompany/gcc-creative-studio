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

import {Component, Inject} from '@angular/core';
import {FormBuilder, FormGroup, Validators} from '@angular/forms';
import {MAT_DIALOG_DATA, MatDialogRef} from '@angular/material/dialog';
import {UserModel, UserRolesEnum} from '../../common/models/user.model';

/**
 * Read-only view of a user.
 *
 * Roles used to be editable here, but they are now derived from the caller's
 * Okta groups on every request, so anything typed in this dialog would be
 * overwritten on the user's next API call. Showing the roles and naming the
 * groups that grant them is the honest version.
 */
@Component({
  selector: 'app-user-form',
  templateUrl: './user-form.component.html',
  styleUrls: ['./user-form.component.scss'],
})
export class UserFormComponent {
  userForm: FormGroup;
  roles: UserRolesEnum[];

  constructor(
    public dialogRef: MatDialogRef<UserFormComponent>,
    @Inject(MAT_DIALOG_DATA)
    public data: {user: UserModel},
    private fb: FormBuilder,
  ) {
    const user = data.user;
    this.roles = user?.roles ?? [];

    this.userForm = this.fb.group({
      id: [user?.id],
      email: [{value: user?.email || '', disabled: true}, Validators.required],
    });
  }

  onCancel(): void {
    this.dialogRef.close();
  }
}
