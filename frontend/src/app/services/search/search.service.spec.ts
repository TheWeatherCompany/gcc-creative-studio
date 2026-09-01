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

import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import {environment} from '../../../environments/environment';
import {JobStatus, MediaItem} from '../../common/models/media-item.model';
import {SearchService} from './search.service';

function processingItem(id: number): MediaItem {
  return {id, gcsUris: [], status: JobStatus.PROCESSING} as MediaItem;
}

describe('SearchService', () => {
  let service: SearchService;
  let httpMock: HttpTestingController;

  const generateUrl = `${environment.backendURL}/videos/generate-videos`;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(SearchService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    // Stop any per-job polling timers before the next test.
    service.clearActiveVideoJobs();
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('tracks a started video generation as an active job', () => {
    let jobs: MediaItem[] = [];
    service.activeVideoJobs$.subscribe(next => (jobs = next));

    service.startVeoGeneration({} as never).subscribe();
    httpMock.expectOne(generateUrl).flush(processingItem(1));

    expect(jobs.map(job => job.id)).toEqual([1]);
  });

  it('tracks multiple concurrent video generations independently', () => {
    let jobs: MediaItem[] = [];
    service.activeVideoJobs$.subscribe(next => (jobs = next));

    service.startVeoGeneration({} as never).subscribe();
    httpMock.expectOne(generateUrl).flush(processingItem(1));
    service.startVeoGeneration({} as never).subscribe();
    httpMock.expectOne(generateUrl).flush(processingItem(2));

    expect(jobs.map(job => job.id)).toEqual([1, 2]);

    service.removeVideoJob(1);
    expect(jobs.map(job => job.id)).toEqual([2]);
  });
});
