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
"""Startup check that Application Default Credentials are actually usable.

Extracted from the Firebase auth client, which is gone now that Okta
verifies tokens. The check itself is worth keeping: expired local ADC
otherwise shows up much later as a confusing failure from whichever Vertex
or Storage call happens to run first.
"""

import logging

import google.auth
from google.auth.exceptions import RefreshError
from google.cloud import resourcemanager_v3

logger = logging.getLogger(__name__)


def check_adc_authentication() -> bool:
    """Verifies ADC by making one lightweight authenticated API call.

    Returns:
        True when the credentials work.

    Raises:
        RefreshError: Credentials have expired and need re-authentication.
        Exception: Any other failure reaching Resource Manager.

    """
    try:
        creds, project_id = google.auth.default()

        # Without a project there is nothing cheap to call, so having loaded
        # credentials at all is the most we can assert.
        if not project_id:
            logger.warning(
                "Could not determine project ID from ADC. "
                "Unable to perform a live authentication check.",
            )
            return creds is not None

        logger.info(
            "ADC found for project: %s. Attempting a test API call...",
            project_id,
        )

        client = resourcemanager_v3.ProjectsClient(
            credentials=creds
        )  # type: ignore
        # Requires 'resourcemanager.projects.get'.
        client.get_project(name=f"projects/{project_id}")

        logger.info("✅ ADC Authentication successful.")
        return True

    except RefreshError as e:
        logger.critical(
            "❌ ADC REAUTHENTICATION NEEDED. Please run "
            "`gcloud auth application-default login`. Details: %s",
            e,
        )
        raise
    except Exception as e:
        logger.error("An unexpected error occurred during ADC check: %s", e)
        raise
