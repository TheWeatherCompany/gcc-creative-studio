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
"""Tests for log sanitizing helpers."""

import pytest

from src.common.log_utils import sanitize_for_log


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("plain text", "plain text"),
        ("a\nFAKE ERROR forged line", "a\\nFAKE ERROR forged line"),
        ("a\r\nb", "a\\r\\nb"),
        ("tab\there", "tab\\there"),
        ("nul\x00esc\x1b[31m", "nul\\x00esc\\x1b[31m"),
        ("del\x7fnel\x85", "del\\x7fnel\\x85"),
        ("ls\u2028ps\u2029", "ls\\u2028ps\\u2029"),
        ("héllo ✓ 日本", "héllo ✓ 日本"),
        (42, "42"),
        (ValueError("bad\nthing"), "bad\\nthing"),
    ],
)
def test_sanitize_for_log(value, expected):
    assert sanitize_for_log(value) == expected
