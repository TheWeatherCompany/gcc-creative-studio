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

import {fakeAsync, TestBed, tick} from '@angular/core/testing';
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
    service.clearActiveImageJobs();
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

  it('does not double-track a job it is already polling', () => {
    let jobs: MediaItem[] = [];
    service.activeVideoJobs$.subscribe(next => (jobs = next));

    service.startVeoGeneration({} as never).subscribe();
    httpMock.expectOne(generateUrl).flush(processingItem(1));

    // A reload-restore pass sees the same in-flight job the tab already
    // submitted; it must not add a second card or a second poll.
    service.trackVideoJob(processingItem(1));

    expect(jobs.map(job => job.id)).toEqual([1]);
  });

  it('restores the in-flight jobs the backend still has for this user', () => {
    let jobs: MediaItem[] = [];
    service.activeVideoJobs$.subscribe(next => (jobs = next));

    service.restoreActiveVideoJobs();

    // Must be /videos/active, not a gallery search: the gallery forces
    // status=COMPLETED for non-admins, which would return nothing.
    const request = httpMock.expectOne(
      `${environment.backendURL}/videos/active`,
    );
    expect(request.request.method).toBe('GET');
    request.flush([processingItem(3), processingItem(4)]);

    expect(jobs.map(job => job.id)).toEqual([3, 4]);
  });

  it('restores an in-flight job submitted elsewhere and polls it', fakeAsync(() => {
    let jobs: MediaItem[] = [];
    service.activeVideoJobs$.subscribe(next => (jobs = next));

    service.trackVideoJob(processingItem(7));
    expect(jobs.map(job => job.id)).toEqual([7]);

    tick(5000);
    httpMock
      .expectOne(`${environment.backendURL}/gallery/item/7`)
      .flush({id: 7, gcsUris: [], status: JobStatus.COMPLETED});

    expect(jobs[0].status).toBe(JobStatus.COMPLETED);
    service.clearActiveVideoJobs();
  }));

  it('marks a job failed when polling gives up instead of leaving it spinning', fakeAsync(() => {
    let jobs: MediaItem[] = [];
    service.activeVideoJobs$.subscribe(next => (jobs = next));

    service.startVeoGeneration({} as never).subscribe();
    httpMock.expectOne(generateUrl).flush(processingItem(1));

    const failPoll = () =>
      httpMock
        .expectOne(`${environment.backendURL}/gallery/item/1`)
        .flush('boom', {status: 500, statusText: 'Server Error'});

    // Four consecutive failed polls: the first tick, then three more.
    tick(5000);
    failPoll();
    for (let attempt = 0; attempt < 3; attempt++) {
      tick(15000);
      failPoll();
    }

    // Terminal, with an explanation, rather than a card that spins forever.
    expect(jobs.length).toBe(1);
    expect(jobs[0].status).toBe(JobStatus.FAILED);
    expect(jobs[0].errorMessage).toContain('Lost track of this generation');

    service.clearActiveVideoJobs();
    httpMock.verify();
  }));

  it('recovers from a transient poll failure without failing the job', fakeAsync(() => {
    let jobs: MediaItem[] = [];
    service.activeVideoJobs$.subscribe(next => (jobs = next));

    service.startVeoGeneration({} as never).subscribe();
    httpMock.expectOne(generateUrl).flush(processingItem(1));

    // Three failures in a row stay under the give-up threshold.
    for (let attempt = 0; attempt < 3; attempt++) {
      tick(attempt === 0 ? 5000 : 15000);
      httpMock
        .expectOne(`${environment.backendURL}/gallery/item/1`)
        .flush('blip', {status: 500, statusText: 'Server Error'});
      expect(jobs[0].status).toBe(JobStatus.PROCESSING);
    }

    // A success resets the counter, so the job survives another bad run.
    tick(15000);
    httpMock
      .expectOne(`${environment.backendURL}/gallery/item/1`)
      .flush({id: 1, gcsUris: [], status: JobStatus.PROCESSING});
    expect(jobs[0].status).toBe(JobStatus.PROCESSING);

    tick(15000);
    httpMock
      .expectOne(`${environment.backendURL}/gallery/item/1`)
      .flush('blip', {status: 500, statusText: 'Server Error'});
    expect(jobs[0].status).toBe(JobStatus.PROCESSING);

    service.clearActiveVideoJobs();
  }));

  describe('image generations', () => {
    const imageGenerateUrl = `${environment.backendURL}/images/generate-images`;

    it('tracks multiple concurrent image generations independently', () => {
      let jobs: MediaItem[] = [];
      service.activeImageJobs$.subscribe(next => (jobs = next));

      service.startImagenGeneration({} as never).subscribe();
      httpMock.expectOne(imageGenerateUrl).flush(processingItem(1));
      service.startImagenGeneration({} as never).subscribe();
      httpMock.expectOne(imageGenerateUrl).flush(processingItem(2));

      // The bug this fixes: the second submit used to replace the first job,
      // so the first card never left the processing state.
      expect(jobs.map(job => job.id)).toEqual([1, 2]);

      service.removeImageJob(1);
      expect(jobs.map(job => job.id)).toEqual([2]);
    });

    it('polls each image job on its own subscription', fakeAsync(() => {
      let jobs: MediaItem[] = [];
      service.activeImageJobs$.subscribe(next => (jobs = next));

      service.startImagenGeneration({} as never).subscribe();
      httpMock.expectOne(imageGenerateUrl).flush(processingItem(1));
      service.startImagenGeneration({} as never).subscribe();
      httpMock.expectOne(imageGenerateUrl).flush(processingItem(2));

      tick(2000);
      httpMock
        .expectOne(`${environment.backendURL}/gallery/item/1`)
        .flush({id: 1, gcsUris: [], status: JobStatus.COMPLETED});
      httpMock
        .expectOne(`${environment.backendURL}/gallery/item/2`)
        .flush({id: 2, gcsUris: [], status: JobStatus.PROCESSING});

      expect(jobs.map(job => job.status)).toEqual([
        JobStatus.COMPLETED,
        JobStatus.PROCESSING,
      ]);

      service.clearActiveImageJobs();
    }));

    it('restores the in-flight image jobs the backend still has', () => {
      let jobs: MediaItem[] = [];
      service.activeImageJobs$.subscribe(next => (jobs = next));

      service.restoreActiveImageJobs();

      // Must be /images/active, not a gallery search: the gallery forces
      // status=COMPLETED for non-admins, which would return nothing.
      const request = httpMock.expectOne(
        `${environment.backendURL}/images/active`,
      );
      expect(request.request.method).toBe('GET');
      request.flush([processingItem(3), processingItem(4)]);

      expect(jobs.map(job => job.id)).toEqual([3, 4]);
    });

    it('stops polling when image jobs are cleared', fakeAsync(() => {
      service.startImagenGeneration({} as never).subscribe();
      httpMock.expectOne(imageGenerateUrl).flush(processingItem(1));

      service.clearActiveImageJobs();

      // No further poll requests, so a signed-out user's timers cannot leak
      // into the next session.
      tick(30000);
      httpMock.verify();
    }));
  });
});
