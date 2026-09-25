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

import {Component, Inject} from '@angular/core';
import {AsyncPipe, DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import {MatIconModule} from '@angular/material/icon';
import {MatProgressSpinnerModule} from '@angular/material/progress-spinner';
import {MatTooltipModule} from '@angular/material/tooltip';
import {Observable, map, of} from 'rxjs';
import {BrandGuidelineModel} from '../../models/brand-guideline.model';
import {JobStatus} from '../../models/media-item.model';
import {Workspace, WorkspaceScope} from '../../models/workspace.model';

export interface WorkspacePickerDialogData {
  workspaces: Workspace[];
  activeWorkspaceId: number | null;
  /** Whether the current user may invite people to the active workspace. */
  canInvite: boolean;
  /** Whether the current user may open the active workspace's guidelines. */
  canAccessBrandGuidelines: boolean;
  /** The brand guideline upload in flight, if any, to show its spinner. */
  brandGuidelineJob$?: Observable<BrandGuidelineModel | null>;
}

export type WorkspacePickerResult =
  | {action: 'select'; workspaceId: number}
  | {action: 'create'}
  | {action: 'invite'}
  | {action: 'brandGuidelines'};

/** Above this many workspaces the picker offers a filter-by-name box. */
export const WORKSPACE_FILTER_THRESHOLD = 6;

/**
 * Public workspaces first, then newest first by creation date.
 *
 * The public workspace is everyone's default and the oldest, so pure
 * newest-first would sink it to the bottom of a long list; pinning keeps the
 * one workspace every user shares in a fixed place. A workspace without a
 * date sorts last rather than breaking the order of the rest.
 */
export function orderWorkspaces(workspaces: Workspace[]): Workspace[] {
  const time = (w: Workspace) => {
    const t = w.createdAt ? Date.parse(w.createdAt) : NaN;
    return isNaN(t) ? -Infinity : t;
  };
  const pinned = (w: Workspace) => (w.scope === WorkspaceScope.PUBLIC ? 0 : 1);
  return [...workspaces].sort(
    (a, b) => pinned(a) - pinned(b) || time(b) - time(a) || b.id - a.id,
  );
}

@Component({
  selector: 'app-workspace-picker-dialog',
  templateUrl: './workspace-picker-dialog.component.html',
  styleUrls: ['./workspace-picker-dialog.component.scss'],
  standalone: true,
  imports: [
    AsyncPipe,
    DatePipe,
    FormsModule,
    MatDialogModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
})
export class WorkspacePickerDialogComponent {
  readonly WorkspaceScope = WorkspaceScope;
  readonly ordered: Workspace[];
  readonly showFilter: boolean;
  readonly activeWorkspace: Workspace | null;
  /** True while a brand guideline upload is being processed. */
  readonly guidelineProcessing$: Observable<boolean>;
  filterText = '';

  constructor(
    public dialogRef: MatDialogRef<
      WorkspacePickerDialogComponent,
      WorkspacePickerResult
    >,
    @Inject(MAT_DIALOG_DATA) public data: WorkspacePickerDialogData,
  ) {
    this.ordered = orderWorkspaces(data.workspaces);
    this.showFilter = this.ordered.length > WORKSPACE_FILTER_THRESHOLD;
    this.activeWorkspace =
      data.workspaces.find(w => w.id === data.activeWorkspaceId) ?? null;
    this.guidelineProcessing$ = (data.brandGuidelineJob$ ?? of(null)).pipe(
      map(job => job?.status === JobStatus.PROCESSING),
    );
  }

  get visible(): Workspace[] {
    const query = this.filterText.trim().toLowerCase();
    if (!query) return this.ordered;
    return this.ordered.filter(w => w.name.toLowerCase().includes(query));
  }

  isActive(workspace: Workspace): boolean {
    return workspace.id === this.data.activeWorkspaceId;
  }

  select(workspace: Workspace): void {
    // Re-selecting the current workspace would reload the gallery for nothing.
    if (this.isActive(workspace)) {
      this.dialogRef.close();
      return;
    }
    this.dialogRef.close({action: 'select', workspaceId: workspace.id});
  }

  create(): void {
    this.dialogRef.close({action: 'create'});
  }

  invite(): void {
    this.dialogRef.close({action: 'invite'});
  }

  openBrandGuidelines(): void {
    this.dialogRef.close({action: 'brandGuidelines'});
  }

  initials(workspace: Workspace): string {
    const words = workspace.name.trim().split(/\s+/).filter(Boolean);
    const letters =
      words.length > 1
        ? words[0][0] + words[1][0]
        : (words[0]?.slice(0, 2) ?? '');
    return letters.toUpperCase() || '?';
  }

  /** A stable colour per workspace, so a tile stays recognisable over time. */
  tileBackground(workspace: Workspace): string {
    const hue = Math.round((workspace.id * 137.508) % 360);
    return `linear-gradient(135deg, hsl(${hue} 55% 42%), hsl(${(hue + 40) % 360} 60% 24%))`;
  }
}
