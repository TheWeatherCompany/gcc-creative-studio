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

import {HttpClient, HttpParams} from '@angular/common/http';
import {Injectable} from '@angular/core';
import {Observable} from 'rxjs';
import {environment} from '../../../environments/environment';
import {
  CreateFolderDto,
  Folder,
  FolderBreadcrumb,
  FolderConflict,
  FolderTreeNode,
  MoveItemsDto,
  MoveItemsResponse,
  CopyItemsDto,
  CopyItemsResponse,
  UpdateFolderDto,
} from '../models/folder.model';

/**
 * Returns the colliding folders when `err` is the FOLDER_COLLISION 409 that a
 * move or copy raises, and null for anything else. A 409 is not always a
 * collision: a folder walk that hits the backend's safety ceiling, a name
 * already taken on create or rename, and a database conflict mid-move all
 * return 409 with a string detail, and none of those can be resolved by
 * merging or keeping both.
 */
export function getFolderCollisions(err: unknown): FolderConflict[] | null {
  const httpErr = err as {status?: number; error?: {detail?: unknown}};
  if (httpErr?.status !== 409) {
    return null;
  }
  const detail = httpErr.error?.detail as
    | {code?: unknown; conflicts?: unknown}
    | undefined;
  if (
    !detail ||
    typeof detail !== 'object' ||
    detail.code !== 'FOLDER_COLLISION' ||
    !Array.isArray(detail.conflicts)
  ) {
    return null;
  }
  return detail.conflicts as FolderConflict[];
}

/**
 * A user-facing message for a failed folder request. The backend's string
 * details are already written for users, so they pass through. Folder
 * structure changes are serialized per workspace, so a request that waited
 * can find its folder moved or trashed (404) or its move now a cycle (400);
 * the 404 detail alone does not say why, so a hint is added.
 */
export function folderErrorMessage(err: unknown, fallback: string): string {
  const httpErr = err as {status?: number; error?: {detail?: unknown}};
  const collisions = getFolderCollisions(err);
  if (collisions) {
    const names = collisions.map(c => `"${c.folder_name}"`).join(', ');
    return `A folder named ${names} already exists at the destination.`;
  }
  const detail = httpErr?.error?.detail;
  if (typeof detail !== 'string' || !detail.trim()) {
    return fallback;
  }
  if (httpErr.status === 404) {
    return `${detail} It may have been moved or deleted. Refresh and try again.`;
  }
  return detail;
}

@Injectable({
  providedIn: 'root',
})
export class FolderService {
  private readonly apiUrl = `${environment.backendURL}/folders`;
  // Must match MAX_FOLDER_DEPTH in backend/src/folders/folder_service.py.
  readonly maxDepth = 20;

  constructor(private readonly http: HttpClient) {}

  getFolders(
    workspaceId: number,
    parentId?: number | null,
  ): Observable<Folder[]> {
    let params = new HttpParams().set('workspace_id', workspaceId.toString());
    if (parentId !== undefined && parentId !== null) {
      params = params.set('parent_id', parentId.toString());
    }
    return this.http.get<Folder[]>(this.apiUrl, {params});
  }

  getFolderTree(workspaceId: number): Observable<FolderTreeNode[]> {
    const params = new HttpParams().set('workspace_id', workspaceId.toString());
    return this.http.get<FolderTreeNode[]>(`${this.apiUrl}/tree`, {params});
  }

  getBreadcrumbs(
    folderId: number,
    workspaceId?: number,
  ): Observable<FolderBreadcrumb[]> {
    let params = new HttpParams();
    if (workspaceId !== undefined && workspaceId !== null) {
      params = params.set('workspace_id', workspaceId.toString());
    }
    return this.http.get<FolderBreadcrumb[]>(
      `${this.apiUrl}/${folderId}/breadcrumbs`,
      {params},
    );
  }

  getFolderById(folderId: number, workspaceId?: number): Observable<Folder> {
    let params = new HttpParams();
    if (workspaceId !== undefined && workspaceId !== null) {
      params = params.set('workspace_id', workspaceId.toString());
    }
    return this.http.get<Folder>(`${this.apiUrl}/${folderId}`, {params});
  }

  createFolder(dto: CreateFolderDto): Observable<Folder> {
    return this.http.post<Folder>(this.apiUrl, dto);
  }

  updateFolder(folderId: number, dto: UpdateFolderDto): Observable<Folder> {
    return this.http.patch<Folder>(`${this.apiUrl}/${folderId}`, dto);
  }

  deleteFolder(folderId: number): Observable<{success: boolean}> {
    return this.http.delete<{success: boolean}>(`${this.apiUrl}/${folderId}`);
  }

  moveItems(dto: MoveItemsDto): Observable<MoveItemsResponse> {
    return this.http.post<MoveItemsResponse>(`${this.apiUrl}/move-items`, dto);
  }

  copyItems(dto: CopyItemsDto): Observable<CopyItemsResponse> {
    return this.http.post<CopyItemsResponse>(`${this.apiUrl}/copy-items`, dto);
  }
}
