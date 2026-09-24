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

"""Turns a job call into a JSON body for Cloud Tasks, and back again.

Each argument is serialized with the job function's own type hint, so the
upstream-owned job signatures stay the single source of truth. Raw bytes are
too big for a task body (1 MB cap), so they are staged in GCS and the body
carries a reference instead.
"""

import inspect
import typing
from collections.abc import Callable
from typing import Any

from pydantic import TypeAdapter

STAGED_BYTES_KEY = "__staged_bytes_uri__"


def _hints(fn: Callable) -> dict[str, Any]:
    return typing.get_type_hints(fn)


def _is_staged(raw: Any) -> bool:
    return isinstance(raw, dict) and set(raw) == {STAGED_BYTES_KEY}


def encode_call(
    fn: Callable,
    args: tuple,
    kwargs: dict[str, Any],
    stage_bytes: Callable[[bytes], str],
) -> dict[str, Any]:
    """Returns the JSON-safe keyword arguments for calling fn later."""
    bound = inspect.signature(fn).bind(*args, **kwargs)
    hints = _hints(fn)
    encoded = {}
    for name, value in bound.arguments.items():
        if isinstance(value, (bytes, bytearray)):
            encoded[name] = {STAGED_BYTES_KEY: stage_bytes(bytes(value))}
        else:
            encoded[name] = TypeAdapter(hints.get(name, Any)).dump_python(
                value, mode="json", by_alias=True
            )
    return encoded


def decode_call(
    fn: Callable,
    encoded: dict[str, Any],
    load_bytes: Callable[[str], bytes],
) -> dict[str, Any]:
    """Rebuilds fn's keyword arguments, validating each against its hint."""
    hints = _hints(fn)
    kwargs = {}
    for name, raw in encoded.items():
        if _is_staged(raw):
            kwargs[name] = load_bytes(raw[STAGED_BYTES_KEY])
        else:
            kwargs[name] = TypeAdapter(hints.get(name, Any)).validate_python(
                raw
            )
    return kwargs


def staged_uris(encoded: dict[str, Any]) -> list[str]:
    """Returns the GCS URIs of any staged byte arguments."""
    return [
        raw[STAGED_BYTES_KEY] for raw in encoded.values() if _is_staged(raw)
    ]
