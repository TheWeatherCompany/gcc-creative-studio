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

Some upstream hints are looser than the calls (upload-upscale passes None for
a str gcs_uri and an int source_asset_id). In-process nothing checks them, so
for parity a value that would not validate against its own hint is sent
untyped, returned as-is on decode, and logged once per process as hint
drift.
"""

import inspect
import logging
import typing
from collections.abc import Callable
from typing import Any

from pydantic import TypeAdapter, ValidationError

logger = logging.getLogger(__name__)

STAGED_BYTES_KEY = "__staged_bytes_uri__"
RAW_VALUE_KEY = "__raw__"
_UNTYPED = TypeAdapter(Any)
# (function, parameter) pairs already logged, so a known drift warns once per
# process rather than on every job.
_logged_drift: set[tuple[str, str]] = set()


def _hints(fn: Callable) -> dict[str, Any]:
    return typing.get_type_hints(fn)


def _is_staged(raw: Any) -> bool:
    return isinstance(raw, dict) and set(raw) == {STAGED_BYTES_KEY}


def _is_untyped(raw: Any) -> bool:
    return isinstance(raw, dict) and set(raw) == {RAW_VALUE_KEY}


def _encode_value(fn: Callable, name: str, hint: Any, value: Any) -> Any:
    adapter = TypeAdapter(hint)
    # The validate check below covers mismatches, so skip per-call warnings.
    dumped = adapter.dump_python(
        value, mode="json", by_alias=True, warnings=False
    )
    try:
        adapter.validate_python(dumped)
    except ValidationError:
        if (fn.__qualname__, name) not in _logged_drift:
            _logged_drift.add((fn.__qualname__, name))
            logger.warning(
                "Job argument %s of %s does not match its type hint; "
                "sending it untyped.",
                name,
                fn.__qualname__,
            )
        return {RAW_VALUE_KEY: _UNTYPED.dump_python(value, mode="json")}
    return dumped


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
            encoded[name] = _encode_value(fn, name, hints.get(name, Any), value)
    return encoded


def decode_call(
    fn: Callable,
    encoded: dict[str, Any],
    load_bytes: Callable[[str], bytes],
) -> dict[str, Any]:
    """Rebuilds fn's keyword arguments, validating typed ones by hint."""
    hints = _hints(fn)
    kwargs = {}
    for name, raw in encoded.items():
        if _is_staged(raw):
            kwargs[name] = load_bytes(raw[STAGED_BYTES_KEY])
        elif _is_untyped(raw):
            kwargs[name] = raw[RAW_VALUE_KEY]
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
