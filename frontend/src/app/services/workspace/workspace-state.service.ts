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

import {Injectable} from '@angular/core';
import {BehaviorSubject, Observable} from 'rxjs';

@Injectable({
  providedIn: 'root',
})
export class WorkspaceStateService {
  private readonly activeWorkspaceIdSubject = new BehaviorSubject<
    number | null
  >(null);
  public readonly activeWorkspaceId$: Observable<number | null> =
    this.activeWorkspaceIdSubject.asObservable();
  // The id is null both while the workspace list is loading and after it
  // failed or came back empty. This tells the two apart: it turns true on the
  // first explicit choice, including a choice of none.
  private settled = false;

  setActiveWorkspaceId(workspaceId: number | null) {
    this.settled = true;
    this.activeWorkspaceIdSubject.next(workspaceId);
  }

  hasSettled(): boolean {
    return this.settled;
  }

  getActiveWorkspaceId(): number | null {
    return this.activeWorkspaceIdSubject.getValue();
  }
}
