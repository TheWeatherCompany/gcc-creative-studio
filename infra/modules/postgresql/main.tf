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

resource "random_id" "db_name_suffix" {
  byte_length = 4
}

resource "google_sql_database_instance" "default" {
  name             = "creative-studio-db-${random_id.db_name_suffix.hex}"
  database_version = "POSTGRES_18" # Latest stable version
  region           = var.region
  project          = var.project_id

  settings {
    tier    = "db-custom-2-7680"
    edition = "ENTERPRISE"

    # Enable IAM Authentication for better security (optional but recommended)
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    # Private IP over Private Service Access. Adding a private network to an
    # existing instance restarts it (several minutes offline). The public IP
    # is only kept for the cutover window; Google does not list removing it
    # among the changes that restart the instance.
    ip_configuration {
      ipv4_enabled    = var.public_ip_enabled
      private_network = var.private_network
      # Cloud Run reaches the instance through the Cloud SQL Python connector,
      # which always uses TLS, so plaintext connections can be refused.
      ssl_mode = "ENCRYPTED_ONLY"
    }

    # Enabling point-in-time recovery on an existing instance restarts it, so
    # it lands in the same apply as the private network to restart only once.
    backup_configuration {
      enabled                        = true
      start_time                     = var.backup_start_time
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7

      backup_retention_settings {
        retained_backups = 7
        retention_unit   = "COUNT"
      }
    }
  }

  deletion_protection = false # Set to true for production
}

resource "google_sql_database" "default" {
  name     = var.db_name
  instance = google_sql_database_instance.default.name
  project  = var.project_id
}

resource "google_sql_user" "default" {
  name     = var.db_user
  instance = google_sql_database_instance.default.name
  password = var.db_password
  project  = var.project_id
}
