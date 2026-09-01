# Copyright 2026 Google LLC
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
"""Tests for generation-concurrency settings on ConfigService."""

import pytest

from src.config.config_service import ConfigService


@pytest.mark.parametrize(
    ("workers", "requested", "expected"),
    [
        # Production shape: the pool is large, so the requested cap stands.
        (12, 5, 5),
        # Local/default shape: the requested cap would meet or exceed the pool,
        # making it a no-op. It is clamped to leave a worker for someone else.
        (4, 5, 3),
        (4, 4, 3),
        # A single-worker pool cannot leave anything spare; never clamp to 0.
        (1, 5, 1),
        # A cap tighter than the pool is respected as-is.
        (12, 2, 2),
    ],
)
def test_effective_per_user_cap_stays_below_pool(workers, requested, expected):
    config = ConfigService(
        PROJECT_ID="dummy-project-id",
        GENERATION_MAX_WORKERS=workers,
        GENERATION_MAX_PER_USER=requested,
    )
    assert config.GENERATION_EFFECTIVE_MAX_PER_USER == expected


def test_default_effective_cap_leaves_a_worker_for_other_users():
    """The documented invariant must hold for the shipped defaults, not just
    for the production overrides.
    """
    config = ConfigService(PROJECT_ID="dummy-project-id")
    assert (
        config.GENERATION_EFFECTIVE_MAX_PER_USER < config.GENERATION_MAX_WORKERS
    )
