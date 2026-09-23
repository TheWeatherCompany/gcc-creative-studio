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
"""Helpers for reading structured detail out of database errors.

Recovering the violated constraint name is driver-specific, and getting it
wrong fails silently: the extraction just yields ``None``, every
``IntegrityError`` looks alike, and a conflict that should surface as a 409
turns into a 500. This module keeps that knowledge in one tested place.
"""

import re

from sqlalchemy.exc import IntegrityError

# asyncpg reports the constraint only in the message text on some error
# classes, so this is the last-resort parse. Postgres always quotes the name.
_CONSTRAINT_IN_MESSAGE = re.compile(r'constraint "([^"]+)"')


def constraint_name_of(exc: IntegrityError) -> str | None:
    """Returns the name of the constraint an IntegrityError violated.

    Tries each driver shape in turn, because the answer lives somewhere
    different in each:

    * asyncpg (this project's driver) wraps the real error, so
      ``exc.orig`` is a SQLAlchemy adapter exposing only ``sqlstate`` and
      ``pgcode``. The ``asyncpg.exceptions.UniqueViolationError`` carrying
      ``constraint_name`` is reachable through ``exc.orig.__cause__``.
    * psycopg2/psycopg3 instead expose ``exc.orig.diag.constraint_name``.
    * Failing both, the name is parsed out of the message text.

    Returns None when no name can be recovered, so callers must treat None as
    "not a constraint I recognise" rather than as a match.
    """
    cause = getattr(exc.orig, "__cause__", None)
    name = getattr(cause, "constraint_name", None)
    if name:
        return name

    name = getattr(getattr(exc.orig, "diag", None), "constraint_name", None)
    if name:
        return name

    match = _CONSTRAINT_IN_MESSAGE.search(str(exc.orig))
    return match.group(1) if match else None
