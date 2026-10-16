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
    # existing instance restarts it (several minutes offline). Differs from
    # upstream, which hardcodes ipv4_enabled = false: the public IP is kept for
    # the in-place cutover window, and Google does not list removing it among
    # the changes that restart the instance.
    ip_configuration {
      ipv4_enabled                                  = var.public_ip_enabled
      private_network                               = var.private_network
      enable_private_path_for_google_cloud_services = true
      # Differs from upstream: refuse plaintext connections (KICS "SQL DB
      # Instance With SSL Disabled"). Cloud Run reaches the instance through
      # the Cloud SQL Python connector, which always uses TLS.
      ssl_mode = "ENCRYPTED_ONLY"
    }

    # Enabling point-in-time recovery on an existing instance restarts it, so
    # it lands in the same apply as the private network to restart only once.
    # Backup window, retained backups (7) and log retention (7 days) are left
    # at the Cloud SQL defaults, as upstream does.
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true
      location                       = var.region
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
