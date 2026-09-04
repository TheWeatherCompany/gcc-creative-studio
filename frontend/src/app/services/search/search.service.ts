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

import {HttpClient} from '@angular/common/http';
import {Injectable} from '@angular/core';
import {MatSnackBar} from '@angular/material/snack-bar';
import {
  BehaviorSubject,
  catchError,
  EMPTY,
  map,
  Observable,
  Subscription,
  switchMap,
  tap,
  timer,
} from 'rxjs';
import {environment} from '../../../environments/environment';
import {JobStatus, MediaItem} from '../../common/models/media-item.model';
import {ImagenRequest, VeoRequest} from '../../common/models/search.model';
import {
  handleErrorSnackbar,
  handleSuccessSnackbar,
} from '../../utils/handleMessageSnackbar';
import {GenerationJobTracker} from './generation-job-tracker';

export interface RewritePromptRequest {
  targetType: 'image' | 'video';
  userPrompt: string;
}
export interface ConcatenationInput {
  id: number;
  type: 'media_item' | 'source_asset';
}
export interface ConcatenateVideosDto {
  workspaceId: number;
  name: string;
  inputs: ConcatenationInput[];
  aspectRatio: string;
}

@Injectable({
  providedIn: 'root',
})
export class SearchService {
  // Video and image generation both support multiple concurrent jobs per user:
  // each tracker holds the list of in-flight/finished jobs for its media type
  // and polls each one independently, keyed by media item id.
  private readonly videoJobs: GenerationJobTracker;
  public readonly activeVideoJobs$: Observable<MediaItem[]>;

  private readonly imageJobs: GenerationJobTracker;
  public readonly activeImageJobs$: Observable<MediaItem[]>;

  private activeAudioJob = new BehaviorSubject<MediaItem | null>(null);
  public activeAudioJob$ = this.activeAudioJob.asObservable();
  private audioPollingSubscription: Subscription | null = null;

  // Persisted prompts
  imagePrompt = '';
  videoPrompt = '';

  private activeVtoJob = new BehaviorSubject<MediaItem | null>(null);
  public activeVtoJob$ = this.activeVtoJob.asObservable();
  private vtoPollingSubscription: Subscription | null = null;

  constructor(
    private http: HttpClient,
    private _snackBar: MatSnackBar,
  ) {
    // Built here rather than in a field initializer: with ES2022 class fields
    // those run before the constructor assigns the injected parameters.
    this.videoJobs = new GenerationJobTracker(
      {
        mediaLabel: 'Video',
        successMessage: 'Your video is ready!',
        initialPollDelayMs: 5000,
        pollIntervalMs: 15000,
      },
      mediaId => this.getVeoMediaItem(mediaId),
      this._snackBar,
    );
    this.activeVideoJobs$ = this.videoJobs.jobs$;

    this.imageJobs = new GenerationJobTracker(
      {
        mediaLabel: 'Image',
        successMessage: 'Your images are ready!',
        initialPollDelayMs: 2000,
        pollIntervalMs: 5000,
      },
      mediaId => this.getImagenMediaItem(mediaId),
      this._snackBar,
    );
    this.activeImageJobs$ = this.imageJobs.jobs$;
  }

  searchImagen(searchRequest: ImagenRequest) {
    const searchURL = `${environment.backendURL}/images/generate-images`;
    return this.http
      .post(searchURL, searchRequest)
      .pipe(map(response => response as MediaItem));
  }

  /**
   * Starts the image generation job by POSTing to the backend.
   */
  startImagenGeneration(searchRequest: ImagenRequest): Observable<MediaItem> {
    const searchURL = `${environment.backendURL}/images/generate-images`;
    return this.http
      .post<MediaItem>(searchURL, searchRequest)
      .pipe(tap(initialItem => this.imageJobs.start(initialItem)));
  }

  /**
   * Re-attaches tracking to the image generations that are still running
   * server-side. See restoreActiveVideoJobs for why this needs a dedicated
   * endpoint rather than a gallery search.
   */
  restoreActiveImageJobs(): void {
    const url = `${environment.backendURL}/images/active`;
    this.http.get<MediaItem[]>(url).subscribe({
      next: items => {
        for (const item of items ?? []) {
          this.imageJobs.track(item);
        }
      },
      error: err => {
        // Non-fatal: the user just does not get their in-flight cards back.
        console.error('Could not restore in-flight image generations', err);
      },
    });
  }

  /** Removes a single image job from the active list and stops its polling. */
  removeImageJob(mediaId: number): void {
    this.imageJobs.remove(mediaId);
  }

  /** Clears all active image jobs and stops every poll. */
  clearActiveImageJobs(): void {
    this.imageJobs.clear();
  }

  getImagenMediaItem(mediaId: number): Observable<MediaItem> {
    // Note: We need to add this endpoint to the backend or use a generic one.
    // For now, assuming we'll add /images/{mediaId} or use a common gallery endpoint.
    // Given the current backend structure, we might need to add this.
    // Let's assume we'll add it.
    const getURL = `${environment.backendURL}/gallery/item/${mediaId}`;
    return this.http.get<MediaItem>(getURL);
  }

  /**
   * Starts the video generation job by POSTing to the backend.
   * It returns an Observable of the initial MediaItem.
   */
  startVeoGeneration(searchRequest: VeoRequest): Observable<MediaItem> {
    const searchURL = `${environment.backendURL}/videos/generate-videos`;

    return this.http.post<MediaItem>(searchURL, searchRequest).pipe(
      // The 'tap' operator lets us perform a side-effect (like starting polling)
      // without affecting the value passed to the component's subscription.
      tap(initialItem => this.videoJobs.start(initialItem)),
    );
  }

  concatenateVideos(payload: ConcatenateVideosDto): Observable<MediaItem> {
    const url = `${environment.backendURL}/videos/concatenate`;
    return this.http
      .post<MediaItem>(url, payload)
      .pipe(tap(initialResponse => this.videoJobs.start(initialResponse)));
  }

  /**
   * Re-attaches tracking to the user's generations that are still running
   * server-side. Job state lives in memory here, so without this a reload (or a
   * second tab) shows an empty grid while the backend still counts those jobs
   * against the per-user cap: the next submit would 429 with nothing on screen
   * to wait for.
   *
   * Uses the dedicated /videos/active endpoint rather than a gallery search:
   * the gallery forces status=COMPLETED for non-admins, so a search for
   * PROCESSING rows comes back empty for ordinary users. /videos/active also
   * derives the user from the token and returns exactly the rows the per-user
   * cap counts, so the restored cards and the cap cannot disagree.
   */
  restoreActiveVideoJobs(): void {
    const url = `${environment.backendURL}/videos/active`;
    this.http.get<MediaItem[]>(url).subscribe({
      next: items => {
        for (const item of items ?? []) {
          this.trackVideoJob(item);
        }
      },
      error: err => {
        // Non-fatal: the user just does not get their in-flight cards back.
        console.error('Could not restore in-flight video generations', err);
      },
    });
  }

  /**
   * Starts tracking a generation that this browser session did not submit:
   * after a page reload, or in a second tab, the in-flight jobs still exist
   * server-side and still count against the per-user cap, so they need cards
   * and polling here too. A job already being tracked is left alone.
   */
  trackVideoJob(item: MediaItem): void {
    this.videoJobs.track(item);
  }

  /** Removes a single job from the active list and stops its polling. */
  removeVideoJob(mediaId: number): void {
    this.videoJobs.remove(mediaId);
  }

  /** Clears all active video jobs and stops every poll. */
  clearActiveVideoJobs() {
    this.videoJobs.clear();
  }

  /**
   * Fetches the current state of a media item by its ID.
   * @param mediaId The unique ID of the media item to check.
   * @returns An Observable of the MediaItem.
   */
  getVeoMediaItem(mediaId: number): Observable<MediaItem> {
    const getURL = `${environment.backendURL}/gallery/item/${mediaId}`;
    return this.http.get<MediaItem>(getURL);
  }

  rewritePrompt(payload: {
    targetType: 'image' | 'video';
    userPrompt: string;
  }): Observable<{prompt: string}> {
    return this.http.post<{prompt: string}>(
      `${environment.backendURL}/gemini/rewrite-prompt`,
      payload,
    );
  }

  getRandomPrompt(payload: {
    target_type: 'image' | 'video';
  }): Observable<{prompt: string}> {
    return this.http.post<{prompt: string}>(
      `${environment.backendURL}/gemini/random-prompt`,
      payload,
    );
  }

  /**
   * Starts the VTO generation job by POSTing to the backend.
   * Returns an Observable of the initial MediaItem.
   */
  startVtoGeneration(vtoRequest: any): Observable<MediaItem> {
    const url = `${environment.backendURL}/images/generate-images-for-vto`;

    return this.http.post<MediaItem>(url, vtoRequest).pipe(
      tap(initialItem => {
        this.activeVtoJob.next(initialItem);
        this.startVtoPolling(initialItem.id);
      }),
    );
  }

  /**
   * Private method to poll the status of a VTO job.
   * @param mediaId The ID of the job to poll.
   */
  private startVtoPolling(mediaId: number): void {
    this.stopVtoPolling();

    this.vtoPollingSubscription = timer(5000, 15000) // Start after 5s, then every 15s
      .pipe(
        switchMap(() => this.getVtoMediaItem(mediaId)),
        tap(latestItem => {
          this.activeVtoJob.next(latestItem);

          if (
            latestItem.status === JobStatus.COMPLETED ||
            latestItem.status === JobStatus.FAILED
          ) {
            this.stopVtoPolling();
            if (latestItem.status === JobStatus.COMPLETED) {
              handleSuccessSnackbar(
                this._snackBar,
                'Your VTO result is ready!',
              );
            } else {
              handleErrorSnackbar(
                this._snackBar,
                {message: latestItem.errorMessage || latestItem.error_message},
                `VTO generation failed: ${latestItem.errorMessage || latestItem.error_message}`,
              );
            }
          }
        }),
        catchError(err => {
          console.error('VTO polling failed', err);
          this.stopVtoPolling();
          return EMPTY;
        }),
      )
      .subscribe();
  }

  private stopVtoPolling(): void {
    this.vtoPollingSubscription?.unsubscribe();
    this.vtoPollingSubscription = null;
  }

  /**
   * Fetches the current state of a VTO media item by its ID.
   * @param mediaId The unique ID of the media item to check.
   * @returns An Observable of the MediaItem.
   */
  getVtoMediaItem(mediaId: number): Observable<MediaItem> {
    const url = `${environment.backendURL}/gallery/item/${mediaId}`;
    return this.http.get<MediaItem>(url);
  }

  clearActiveVtoJob() {
    this.activeVtoJob.next(null);
    this.stopVtoPolling();
  }

  /**
   * Starts the Audio generation job by POSTing to the backend.
   * Returns an Observable of the initial MediaItem.
   */
  startAudioGeneration(audioRequest: any): Observable<MediaItem> {
    const searchURL = `${environment.backendURL}/audios/generate`;

    return this.http.post<MediaItem>(searchURL, audioRequest).pipe(
      tap(initialItem => {
        this.activeAudioJob.next(initialItem);
        this.startAudioPolling(initialItem.id);
      }),
    );
  }

  clearActiveAudioJob() {
    this.activeAudioJob.next(null);
  }

  /**
   * Private method to poll the status of an audio item.
   * @param mediaId The ID of the job to poll.
   */
  private startAudioPolling(mediaId: number): void {
    this.stopAudioPolling();

    this.audioPollingSubscription = timer(5000, 15000)
      .pipe(
        switchMap(() => this.getAudioMediaItem(mediaId)),
        tap(latestItem => {
          this.activeAudioJob.next(latestItem);

          if (
            latestItem.status === JobStatus.COMPLETED ||
            latestItem.status === JobStatus.FAILED
          ) {
            this.stopAudioPolling();
            if (latestItem.status === JobStatus.COMPLETED) {
              handleSuccessSnackbar(this._snackBar, 'Your audio is ready!');
            } else {
              handleErrorSnackbar(
                this._snackBar,
                {message: latestItem.errorMessage || latestItem.error_message},
                `Audio generation failed: ${latestItem.errorMessage || latestItem.error_message}`,
              );
            }
          }
        }),
        catchError(err => {
          console.error('Polling failed', err);
          this.stopAudioPolling();
          return EMPTY;
        }),
      )
      .subscribe();
  }

  private stopAudioPolling(): void {
    this.audioPollingSubscription?.unsubscribe();
    this.audioPollingSubscription = null;
  }

  /**
   * Fetches the current state of a media item by its ID.
   * @param mediaId The unique ID of the media item to check.
   * @returns An Observable of the MediaItem.
   */
  getAudioMediaItem(mediaId: number): Observable<MediaItem> {
    const getURL = `${environment.backendURL}/gallery/item/${mediaId}`;
    return this.http.get<MediaItem>(getURL);
  }
}
