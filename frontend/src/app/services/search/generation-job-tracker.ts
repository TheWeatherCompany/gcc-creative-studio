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

import {MatSnackBar} from '@angular/material/snack-bar';
import {
  BehaviorSubject,
  catchError,
  EMPTY,
  Observable,
  Subscription,
  switchMap,
  tap,
  timer,
} from 'rxjs';
import {JobStatus, MediaItem} from '../../common/models/media-item.model';
import {
  handleErrorSnackbar,
  handleSuccessSnackbar,
} from '../../utils/handleMessageSnackbar';

// How many consecutive failed polls to tolerate before giving up on a job.
// Generous on purpose: the request is retried on the normal poll tick, so this
// rides out roughly a minute of backend or network trouble.
const MAX_CONSECUTIVE_POLL_FAILURES = 4;

export interface GenerationJobTrackerOptions {
  /** Capitalised media noun used in user-facing copy, e.g. "Video". */
  mediaLabel: string;
  /** Message shown when a job completes. */
  successMessage: string;
  /** Delay before the first poll of a job, in ms. */
  initialPollDelayMs: number;
  /** Interval between subsequent polls of a job, in ms. */
  pollIntervalMs: number;
}

/**
 * Tracks a user's concurrent generation jobs of one media type and polls each
 * one independently.
 *
 * Per-job polling is what makes concurrency possible: a single shared
 * subscription means starting a second generation cancels the first one's
 * updates, so its card never leaves the processing state.
 */
export class GenerationJobTracker {
  private readonly jobs = new BehaviorSubject<MediaItem[]>([]);
  readonly jobs$: Observable<MediaItem[]> = this.jobs.asObservable();
  private readonly pollingSubscriptions = new Map<number, Subscription>();

  constructor(
    private readonly options: GenerationJobTrackerOptions,
    private readonly fetchJob: (mediaId: number) => Observable<MediaItem>,
    private readonly snackBar: MatSnackBar,
  ) {}

  /**
   * Inserts a job into the active list, or replaces the existing entry with the
   * same id (so a poll update swaps the item in place without reordering).
   */
  upsert(item: MediaItem): void {
    const jobs = this.jobs.value;
    const index = jobs.findIndex(job => job.id === item.id);
    if (index === -1) {
      this.jobs.next([...jobs, item]);
      return;
    }
    const next = jobs.slice();
    next[index] = item;
    this.jobs.next(next);
  }

  /** Adds a freshly submitted job and starts polling it. */
  start(item: MediaItem): void {
    this.upsert(item);
    this.startPolling(item.id);
  }

  /**
   * Starts tracking a generation that this browser session did not submit:
   * after a page reload, or in a second tab, the in-flight jobs still exist
   * server-side and still count against the per-user cap, so they need cards
   * and polling here too. A job already being tracked is left alone.
   */
  track(item: MediaItem): void {
    if (this.pollingSubscriptions.has(item.id)) {
      return;
    }
    this.upsert(item);
    if (item.status === JobStatus.PROCESSING) {
      this.startPolling(item.id);
    }
  }

  /** Removes a single job from the active list and stops its polling. */
  remove(mediaId: number): void {
    this.stopPolling(mediaId);
    this.jobs.next(this.jobs.value.filter(job => job.id !== mediaId));
  }

  /** Clears all tracked jobs and stops every poll. */
  clear(): void {
    this.pollingSubscriptions.forEach(sub => sub.unsubscribe());
    this.pollingSubscriptions.clear();
    this.jobs.next([]);
  }

  /**
   * Polls one job until it reaches a terminal state. Each job gets its own
   * subscription so concurrent generations cannot clobber each other.
   */
  private startPolling(mediaId: number): void {
    this.stopPolling(mediaId); // Replace any existing poll for this id.

    // A generation runs for minutes, so one failed poll (a 500, a token-refresh
    // blip, a dropped connection) must not end the tracking. Handle the error
    // inside the inner request so the outer timer keeps ticking, and only give
    // up after several consecutive failures.
    let consecutiveFailures = 0;

    const subscription = timer(
      this.options.initialPollDelayMs,
      this.options.pollIntervalMs,
    )
      .pipe(
        switchMap(() =>
          this.fetchJob(mediaId).pipe(
            catchError(err => {
              console.error('Polling failed', err);
              consecutiveFailures++;
              if (consecutiveFailures >= MAX_CONSECUTIVE_POLL_FAILURES) {
                this.abandon(mediaId);
              }
              return EMPTY;
            }),
          ),
        ),
        tap(latestItem => {
          consecutiveFailures = 0;
          // Swap the latest status into the active list.
          this.upsert(latestItem);

          if (
            latestItem.status === JobStatus.COMPLETED ||
            latestItem.status === JobStatus.FAILED
          ) {
            this.stopPolling(mediaId);
            this.announceTerminalState(latestItem);
          }
        }),
        // Safety net: an error thrown outside the request itself would
        // otherwise kill the poll and strand the card on PROCESSING.
        catchError(err => {
          console.error(
            `${this.options.mediaLabel} polling stream failed`,
            err,
          );
          this.abandon(mediaId);
          return EMPTY;
        }),
      )
      .subscribe();

    this.pollingSubscriptions.set(mediaId, subscription);
  }

  private announceTerminalState(item: MediaItem): void {
    if (item.status === JobStatus.COMPLETED) {
      handleSuccessSnackbar(this.snackBar, this.options.successMessage);
      return;
    }
    const message = item.errorMessage || item.error_message;
    handleErrorSnackbar(
      this.snackBar,
      {message},
      `${this.options.mediaLabel} generation failed: ${message}`,
    );
  }

  /**
   * Stops polling a job and marks it terminally. Called when polling can no
   * longer make progress: without this the card spins forever with no Dismiss
   * button and no explanation. The generation itself may well still finish,
   * hence the pointer to the gallery rather than a flat "it failed".
   */
  private abandon(mediaId: number): void {
    this.stopPolling(mediaId);
    const job = this.jobs.value.find(item => item.id === mediaId);
    if (!job) return;
    this.upsert({
      ...job,
      status: JobStatus.FAILED,
      errorMessage:
        'Lost track of this generation. It may still be running: ' +
        'check your gallery in a few minutes.',
    });
  }

  private stopPolling(mediaId: number): void {
    this.pollingSubscriptions.get(mediaId)?.unsubscribe();
    this.pollingSubscriptions.delete(mediaId);
  }
}
