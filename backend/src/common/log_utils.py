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
"""Helpers for writing untrusted values to logs safely."""

import unicodedata

# Unicode line/paragraph separators are not control characters (Cc) but
# many log viewers still treat them as line breaks.
_LINE_SEPARATORS = {"\u2028", "\u2029"}


def _escape(char: str) -> str:
    if char == "\n":
        return "\\n"
    if char == "\r":
        return "\\r"
    if char == "\t":
        return "\\t"
    code = ord(char)
    return f"\\x{code:02x}" if code < 0x100 else f"\\u{code:04x}"


def sanitize_for_log(value: object) -> str:
    """Returns str(value) with CR/LF and other control characters escaped.

    Use on user- or upstream-supplied values before logging them so they
    cannot forge extra log lines. This does not redact anything: never pass
    secrets (tokens, auth headers) through it, drop them instead.
    """
    text = str(value)
    return "".join(
        (
            _escape(char)
            if char in _LINE_SEPARATORS or unicodedata.category(char) == "Cc"
            else char
        )
        for char in text
    )
