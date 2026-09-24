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

import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse, provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  FolderService,
  folderErrorMessage,
  getFolderCollisions,
} from './folder.service';
import {environment} from '../../../environments/environment';
import {Folder} from '../models/folder.model';

describe('FolderService', () => {
  let service: FolderService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        FolderService,
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    service = TestBed.inject(FolderService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should fetch folders by workspace and parent', () => {
    const mockFolders: Folder[] = [
      {
        id: 1,
        workspaceId: 1,
        userEmail: 'user@example.com',
        name: 'Folder 1',
        itemCount: 2,
        subfolderCount: 0,
      },
    ];

    service.getFolders(1, 5).subscribe(folders => {
      expect(folders.length).toBe(1);
      expect(folders[0].name).toBe('Folder 1');
    });

    const req = httpMock.expectOne(
      `${environment.backendURL}/folders?workspace_id=1&parent_id=5`,
    );
    expect(req.request.method).toBe('GET');
    req.flush(mockFolders);
  });

  it('should create a folder', () => {
    const dto = {name: 'New Folder', workspaceId: 1};
    const createdFolder: Folder = {
      id: 10,
      workspaceId: 1,
      userEmail: 'user@example.com',
      name: 'New Folder',
      itemCount: 0,
      subfolderCount: 0,
    };

    service.createFolder(dto).subscribe(res => {
      expect(res.id).toBe(10);
      expect(res.name).toBe('New Folder');
    });

    const req = httpMock.expectOne(`${environment.backendURL}/folders`);
    expect(req.request.method).toBe('POST');
    req.flush(createdFolder);
  });

  it('should batch move items', () => {
    const dto = {
      workspaceId: 1,
      mediaItemIds: [1, 2],
      destinationFolderId: 5,
    };

    service.moveItems(dto).subscribe(res => {
      expect(res.total_moved).toBe(2);
    });

    const req = httpMock.expectOne(
      `${environment.backendURL}/folders/move-items`,
    );
    expect(req.request.method).toBe('POST');
    req.flush({
      media_items_moved: 2,
      source_assets_moved: 0,
      folders_moved: 0,
      total_moved: 2,
    });
  });

  it('should get breadcrumbs without workspace_id when not provided', () => {
    service.getBreadcrumbs(5).subscribe(crumbs => {
      expect(crumbs.length).toBe(1);
      expect(crumbs[0].name).toBe('Folder 5');
    });

    const req = httpMock.expectOne(
      `${environment.backendURL}/folders/5/breadcrumbs`,
    );
    expect(req.request.method).toBe('GET');
    req.flush([{id: 5, name: 'Folder 5', parentId: null}]);
  });

  it('should get breadcrumbs with workspace_id when provided', () => {
    service.getBreadcrumbs(5, 1).subscribe(crumbs => {
      expect(crumbs.length).toBe(1);
      expect(crumbs[0].name).toBe('Folder 5');
    });

    const req = httpMock.expectOne(
      `${environment.backendURL}/folders/5/breadcrumbs?workspace_id=1`,
    );
    expect(req.request.method).toBe('GET');
    req.flush([{id: 5, name: 'Folder 5', parentId: null}]);
  });

  it('should get folder by id with workspace_id when provided', () => {
    service.getFolderById(5, 1).subscribe(folder => {
      expect(folder.id).toBe(5);
    });

    const req = httpMock.expectOne(
      `${environment.backendURL}/folders/5?workspace_id=1`,
    );
    expect(req.request.method).toBe('GET');
    req.flush({
      id: 5,
      workspaceId: 1,
      name: 'Folder 5',
      userEmail: 'user@test.com',
      itemCount: 0,
      subfolderCount: 0,
    });
  });

  it('should cap nesting at the backend MAX_FOLDER_DEPTH of 20', () => {
    expect(service.maxDepth).toBe(20);
  });

  it('should hand a failed move to the caller as the HTTP error', () => {
    let received: HttpErrorResponse | undefined;
    service
      .moveItems({workspaceId: 1, folderIds: [3], destinationFolderId: 5})
      .subscribe({error: err => (received = err)});

    httpMock
      .expectOne(`${environment.backendURL}/folders/move-items`)
      .flush(
        {detail: 'Cannot move folder into one of its own subfolders.'},
        {status: 400, statusText: 'Bad Request'},
      );

    expect(received?.status).toBe(400);
    expect(folderErrorMessage(received, 'Failed to move items')).toBe(
      'Cannot move folder into one of its own subfolders.',
    );
  });
});

/** Builds the error HttpClient hands a subscriber for a FastAPI response. */
function httpError(status: number, detail: unknown): HttpErrorResponse {
  return new HttpErrorResponse({status, error: {detail}});
}

describe('getFolderCollisions', () => {
  const conflicts = [
    {folder_id: 3, folder_name: 'Campaigns', target_folder_id: 9},
  ];

  it('returns the conflicts of a FOLDER_COLLISION 409', () => {
    expect(
      getFolderCollisions(
        httpError(409, {code: 'FOLDER_COLLISION', conflicts}),
      ),
    ).toEqual(conflicts);
  });

  it('does not treat a too-deep folder walk 409 as a collision', () => {
    const tooDeep = httpError(
      409,
      'This folder hierarchy is nested too deeply, or contains a cycle, and cannot be processed.',
    );
    expect(getFolderCollisions(tooDeep)).toBeNull();
  });

  it('does not treat a name-taken 409 on create or rename as a collision', () => {
    const nameTaken = httpError(
      409,
      "A folder named 'Campaigns' already exists in this location.",
    );
    expect(getFolderCollisions(nameTaken)).toBeNull();
  });

  it('requires both the status and the code', () => {
    expect(
      getFolderCollisions(
        httpError(400, {code: 'FOLDER_COLLISION', conflicts}),
      ),
    ).toBeNull();
    expect(
      getFolderCollisions(httpError(409, {code: 'OTHER', conflicts})),
    ).toBeNull();
    expect(
      getFolderCollisions(httpError(409, {code: 'FOLDER_COLLISION'})),
    ).toBeNull();
    expect(getFolderCollisions(new Error('network'))).toBeNull();
  });
});

describe('folderErrorMessage', () => {
  const fallback = 'Failed to move items';

  it('passes the too-deep 409 detail through instead of a collision message', () => {
    const detail =
      'This folder hierarchy is nested too deeply, or contains a cycle, and cannot be processed.';
    expect(folderErrorMessage(httpError(409, detail), fallback)).toBe(detail);
  });

  it('explains a 404 from a folder moved or trashed while the request waited', () => {
    const message = folderErrorMessage(
      httpError(404, 'Destination folder not found in this workspace.'),
      fallback,
    );
    expect(message).toContain(
      'Destination folder not found in this workspace.',
    );
    expect(message).toContain('It may have been moved or deleted.');
  });

  it('passes a 400 cycle detail through', () => {
    expect(
      folderErrorMessage(
        httpError(400, 'Cannot move folder into one of its own subfolders.'),
        fallback,
      ),
    ).toBe('Cannot move folder into one of its own subfolders.');
  });

  it('names the colliding folders of an unhandled FOLDER_COLLISION', () => {
    const message = folderErrorMessage(
      httpError(409, {
        code: 'FOLDER_COLLISION',
        conflicts: [{folder_id: 3, folder_name: 'Campaigns'}],
      }),
      fallback,
    );
    expect(message).toBe(
      'A folder named "Campaigns" already exists at the destination.',
    );
  });

  it('falls back when there is no string detail', () => {
    expect(folderErrorMessage(httpError(0, undefined), fallback)).toBe(
      fallback,
    );
    expect(
      folderErrorMessage(httpError(422, [{msg: 'field required'}]), fallback),
    ).toBe(fallback);
    expect(folderErrorMessage(new Error('boom'), fallback)).toBe(fallback);
  });
});
