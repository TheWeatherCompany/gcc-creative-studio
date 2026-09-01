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
  // Video generation supports multiple concurrent jobs per user. We track the
  // list of in-flight/finished jobs and poll each one independently, keyed by
  // its media item id.
  private activeVideoJobs = new BehaviorSubject<MediaItem[]>([]);
  public activeVideoJobs$ = this.activeVideoJobs.asObservable();
  private videoPollingSubscriptions = new Map<number, Subscription>();

  private activeImageJob = new BehaviorSubject<MediaItem | null>(null);
  public activeImageJob$ = this.activeImageJob.asObservable();
  private imagePollingSubscription: Subscription | null = null;

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
  ) {}

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
    return this.http.post<MediaItem>(searchURL, searchRequest).pipe(
      tap(initialItem => {
        this.activeImageJob.next(initialItem);
        this.startImagenPolling(initialItem.id);
      }),
    );
  }

  clearActiveImageJob() {
    this.activeImageJob.next(null);
  }

  private startImagenPolling(mediaId: number): void {
    this.stopImagenPolling();
    this.imagePollingSubscription = timer(2000, 5000) // Start after 2s, then every 5s
      .pipe(
        switchMap(() => this.getImagenMediaItem(mediaId)),
        tap(latestItem => {
          this.activeImageJob.next(latestItem);
          if (
            latestItem.status === JobStatus.COMPLETED ||
            latestItem.status === JobStatus.FAILED
          ) {
            this.stopImagenPolling();
            if (latestItem.status === JobStatus.COMPLETED) {
              handleSuccessSnackbar(this._snackBar, 'Your images are ready!');
            } else {
              handleErrorSnackbar(
                this._snackBar,
                {message: latestItem.errorMessage || latestItem.error_message},
                `Image generation failed: ${latestItem.errorMessage || latestItem.error_message}`,
              );
            }
          }
        }),
        catchError(err => {
          console.error('Polling failed', err);
          this.stopImagenPolling();
          return EMPTY;
        }),
      )
      .subscribe();
  }

  private stopImagenPolling(): void {
    this.imagePollingSubscription?.unsubscribe();
    this.imagePollingSubscription = null;
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
      tap(initialItem => {
        // 1. Add the initial "processing" item to the list of active jobs.
        this.upsertVideoJob(initialItem);
        // 2. Start polling this job in the background.
        this.startVeoPolling(initialItem.id);
      }),
    );
  }

  concatenateVideos(payload: ConcatenateVideosDto): Observable<MediaItem> {
    const url = `${environment.backendURL}/videos/concatenate`;
    return this.http.post<MediaItem>(url, payload).pipe(
      tap(initialResponse => {
        this.upsertVideoJob(initialResponse);
        this.startVeoPolling(initialResponse.id);
      }),
    );
  }

  /**
   * Inserts a job into the active list, or replaces the existing entry with the
   * same id (so a poll update swaps the item in place without reordering).
   */
  private upsertVideoJob(item: MediaItem): void {
    const jobs = this.activeVideoJobs.value;
    const index = jobs.findIndex(job => job.id === item.id);
    if (index === -1) {
      this.activeVideoJobs.next([...jobs, item]);
      return;
    }
    const next = jobs.slice();
    next[index] = item;
    this.activeVideoJobs.next(next);
  }

  /** Removes a single job from the active list and stops its polling. */
  removeVideoJob(mediaId: number): void {
    this.stopVeoPolling(mediaId);
    this.activeVideoJobs.next(
      this.activeVideoJobs.value.filter(job => job.id !== mediaId),
    );
  }

  /** Clears all active video jobs and stops every poll. */
  clearActiveVideoJobs() {
    this.videoPollingSubscriptions.forEach(sub => sub.unsubscribe());
    this.videoPollingSubscriptions.clear();
    this.activeVideoJobs.next([]);
  }

  /**
   * Polls the status of a single media item until it reaches a terminal state.
   * Each job is polled by its own subscription so multiple generations can run
   * concurrently without clobbering each other.
   * @param mediaId The ID of the job to poll.
   */
  private startVeoPolling(mediaId: number): void {
    this.stopVeoPolling(mediaId); // Replace any existing poll for this id.

    const subscription = timer(5000, 15000) // Start after 5s, then every 15s
      .pipe(
        switchMap(() => this.getVeoMediaItem(mediaId)),
        tap(latestItem => {
          // Swap the latest status into the active list.
          this.upsertVideoJob(latestItem);

          // If this job is finished, stop polling it.
          if (
            latestItem.status === JobStatus.COMPLETED ||
            latestItem.status === JobStatus.FAILED
          ) {
            this.stopVeoPolling(mediaId);
            if (latestItem.status === JobStatus.COMPLETED) {
              handleSuccessSnackbar(this._snackBar, 'Your video is ready!');
            } else {
              handleErrorSnackbar(
                this._snackBar,
                {message: latestItem.errorMessage || latestItem.error_message},
                `Video generation failed: ${latestItem.errorMessage || latestItem.error_message}`,
              );
            }
          }
        }),
        catchError(err => {
          console.error('Polling failed', err);
          this.stopVeoPolling(mediaId);
          return EMPTY;
        }),
      )
      .subscribe();

    this.videoPollingSubscriptions.set(mediaId, subscription);
  }

  private stopVeoPolling(mediaId: number): void {
    this.videoPollingSubscriptions.get(mediaId)?.unsubscribe();
    this.videoPollingSubscriptions.delete(mediaId);
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
