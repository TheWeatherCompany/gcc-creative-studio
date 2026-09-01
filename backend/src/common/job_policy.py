# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Shared policy for how long a generation job may sit in PROCESSING.

A worker runs in a background thread after the HTTP response has already been
returned, so an instance replacement (deploy, scale-down) can kill it with the
row still PROCESSING. Anything that reasons about "in-flight" work therefore
needs the same age bound, or those orphaned rows count forever.
"""

from datetime import datetime, timedelta, timezone

# A PROCESSING job older than this is treated as orphaned rather than in-flight.
# Used by the admin stuck-job cleanup and by the per-user concurrency cap, which
# must agree: otherwise the cap counts rows the cleanup already considers dead.
STUCK_JOB_STALE_AFTER = timedelta(hours=1)


def stale_job_cutoff() -> datetime:
    """Returns the `created_at` boundary between in-flight and orphaned jobs."""
    return datetime.now(timezone.utc) - STUCK_JOB_STALE_AFTER
