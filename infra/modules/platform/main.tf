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

# --- Shared Platform Resources ---

resource "google_storage_bucket" "genmedia" {
  name                        = "${var.gcp_project_id}-cs-${var.environment}-bucket"
  location                    = var.gcp_region
  uniform_bucket_level_access = true

  cors {
    origin          = ["*"]
    method          = ["GET", "PUT", "POST", "DELETE", "HEAD", "OPTIONS"]
    response_header = ["Content-Type", "Access-Control-Allow-Origin", "x-goog-resumable", "Authorization", "Origin"]
    max_age_seconds = 3600
  }

  # Raw upload bytes staged for Cloud Tasks jobs (src/jobs/dispatch.py). The
  # worker deletes them after a successful run; this catches the rest.
  lifecycle_rule {
    condition {
      age            = 2
      matches_prefix = ["job_payloads/"]
    }
    action {
      type = "Delete"
    }
  }
}

resource "google_service_account" "bucket_reader_sa" {
  account_id   = "cs-${var.environment}-read"
  display_name = "SA for reading GenMedia (${var.environment}) bucket"
}

resource "google_storage_bucket_iam_member" "bucket_viewer_binding" {
  bucket = google_storage_bucket.genmedia.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.bucket_reader_sa.email}"
}

resource "google_storage_bucket_iam_member" "bucket_creator_binding" {
  bucket = google_storage_bucket.genmedia.name
  role   = "roles/storage.objectCreator"
  member = "serviceAccount:${google_service_account.bucket_reader_sa.email}"
}

data "google_project" "project" {
  project_id = var.gcp_project_id
}

# --- Predictable URLs & Environment Variables ---
locals {
  region_code  = join("", [for s in split("-", var.gcp_region) : substr(s, 0, 1)])
  backend_url = "https://${var.backend_service_name}-${data.google_project.project.number}.${var.gcp_region}.run.app"

  site_id = var.firebase_site_id != "" ? var.firebase_site_id : var.gcp_project_id

  # Every Firebase Hosting site keeps this address, and it cannot be switched
  # off, so it stays a valid way to reach the app even with a vanity domain.
  frontend_default_url = "https://${local.site_id}.web.app"

  # The origin users load the app from. The SPA itself no longer needs this
  # (it calls the relative /api and follows whatever host served it), but the
  # backend's CORS allowlist and FRONTEND_URL are derived from it, so it has
  # to match the hostname in the address bar.
  frontend_url = var.frontend_custom_domain != "" ? "https://${var.frontend_custom_domain}" : local.frontend_default_url

  frontend_origins = distinct([local.frontend_url, local.frontend_default_url])

  # Same predictable URL form as backend_url.
  worker_url     = "https://${var.worker_service_name}-${data.google_project.project.number}.${var.gcp_region}.run.app"
  job_target_url = var.job_worker_target == "worker" ? local.worker_url : local.backend_url

  job_env_vars = {
    "JOB_DISPATCH_MODE"    = var.job_dispatch_mode
    "JOB_TASKS_QUEUE"      = google_cloud_tasks_queue.generation.id
    "JOB_WORKER_URL"       = local.job_target_url
    "JOB_TASKS_INVOKER_SA" = google_service_account.job_invoker.email
  }

  backend_env_vars = merge(
    lookup(var.be_env_vars, "common", {}),
    lookup(var.be_env_vars, var.environment, {}),
    {
      # main.py reads FRONTEND_URL for the production CORS allowlist, and
      # email_service builds links from it. Left unset it falls back to
      # http://localhost:4200.
      "FRONTEND_URL"           = local.frontend_url
      "CORS_ORIGINS"           = jsonencode(local.frontend_origins)
      "GENMEDIA_BUCKET"        = google_storage_bucket.genmedia.name
      "SIGNING_SA_EMAIL"       = google_service_account.bucket_reader_sa.email
      "BACKEND_URL"            = local.backend_url
      "WORKFLOWS_EXECUTOR_URL" = "${local.backend_url}/api/workflows-executor"
    },
    local.job_env_vars,
  )
}


# --- Cloud Build Repository Connection ---
resource "google_cloudbuildv2_repository" "source_repo" {
  provider          = google-beta
  name              = var.github_repo_name
  location          = var.gcp_region
  parent_connection = "projects/${var.gcp_project_id}/locations/${var.gcp_region}/connections/${var.github_conn_name}"
  remote_uri        = "https://github.com/${var.github_repo_owner}/${var.github_repo_name}.git"
}

# Postgres Database related
# 1. Read the Secret (Created by Bootstrap script)
data "google_secret_manager_secret_version" "db_password" {
  secret  = "creative-studio-db-password"
  project = var.gcp_project_id
  version = "latest"
}

# 2. Call PostgreSQL Module
module "postgresql" {
  source      = "../postgresql"
  project_id  = var.gcp_project_id
  region      = var.gcp_region
  
  # Pass the ACTUAL value to create the user
  db_password = data.google_secret_manager_secret_version.db_password.secret_data
}

# --- Service Module Calls ---
module "backend_service" {
  source = "../cloud-run-service"

  gcp_project_id        = var.gcp_project_id
  gcp_region            = var.gcp_region
  environment           = var.environment
  service_name          = var.backend_service_name
  resource_prefix       = "cs-be"
  github_conn_name      = var.github_conn_name
  github_repo_owner     = var.github_repo_owner
  github_repo_name      = var.github_repo_name
  github_branch_name    = var.github_branch_name
  cloudbuild_yaml_path  = "backend/cloudbuild.yaml"
  included_files_glob   = ["backend/**"]
  container_env_vars    = local.backend_env_vars
  runtime_secrets = var.backend_runtime_secrets
  scaling_min_instances = 1
  source_repository_id = google_cloudbuildv2_repository.source_repo.id
  cpu = var.be_cpu
  memory = var.be_memory

  # Matches JOB_DISPATCH_DEADLINE_SECONDS so a job running inside a request
  # (stage 1 of the worker rollout) is neither cut off nor cut short by a
  # deploy's drain. Also applies to user-facing requests, which is harmless.
  request_timeout = "900s"

  build_substitutions   = merge(var.be_build_substitutions,
    {
      _REGION = var.gcp_region
      _SERVICE_NAME = var.backend_service_name
    }
  )

  # database
  cloud_sql_connection_name = module.postgresql.connection_name
  db_name                   = module.postgresql.db_name
  db_user                   = module.postgresql.db_user
  
  # Pass the Secret ID reference (NOT the value) for Cloud Run
  db_secret_id              = "creative-studio-db-password"
}

resource "google_firebase_project" "default" {
  provider = google-beta
  project = var.gcp_project_id
}

module "frontend_service" {
  source = "../firebase-hosting-service"

  source_repository_id = google_cloudbuildv2_repository.source_repo.id
  gcp_project_id       = var.gcp_project_id
  gcp_region            = var.gcp_region
  firebase_project_id  = google_firebase_project.default.project
  service_name         = var.gcp_project_id
  environment          = var.environment
  resource_prefix      = "cs-fe"
  github_branch_name   = var.github_branch_name
  cloudbuild_yaml_path = "frontend/cloudbuild-deploy.yaml"
  included_files_glob  = ["frontend/**"]
  firebase_site_id     = local.site_id
  custom_domain        = var.frontend_custom_domain

  build_substitutions = merge(
    var.fe_build_substitutions,
    {
      # This block should ONLY contain non-secret, underscore-prefixed values
      # Informational only since the SPA moved to a relative /api path. The
      # trigger has to keep supplying it: Cloud Build rejects a substitution
      # the template never mentions, and cloudbuild-deploy.yaml logs it.
      _BACKEND_URL         = local.frontend_url
      _FE_SERVICE_NAME     = var.frontend_service_name
      _BACKEND_SERVICE_ID  = var.backend_service_name
      _FIREBASE_PROJECT_ID = var.gcp_project_id
      _FIREBASE_SITE_ID    = local.site_id
    }
  )
}

module "frontend_secrets" {
  source = "../secret-manager"

  gcp_project_id    = var.gcp_project_id
  secret_names      = var.frontend_secrets
  accessor_sa_email = module.frontend_service.trigger_sa_email
}

module "backend_secrets" {
  source = "../secret-manager"

  gcp_project_id    = var.gcp_project_id
  secret_names      = var.backend_secrets
  accessor_sa_email = module.backend_service.trigger_sa_email
}

# --- Cross-Module Permissions ---

# Grant the Frontend's deploy trigger (which runs `firebase deploy`)
# permission to "get" the Backend's Cloud Run service to validate the rewrite rule.
resource "google_cloud_run_v2_service_iam_member" "fe_trigger_can_view_backend" {
  provider = google-beta
  project  = var.gcp_project_id
  name     = module.backend_service.service_name
  location = module.backend_service.location
  role     = "roles/run.viewer"
  member   = "serviceAccount:${module.frontend_service.trigger_sa_email}"
}

# --- Generation Jobs ---
# The API enqueues each generation job here; Cloud Tasks POSTs it, signed as
# job_invoker, to /internal/jobs/run on local.job_target_url.

resource "google_service_account" "job_invoker" {
  account_id   = "cs-${var.environment}-jobs"
  display_name = "Signs Cloud Tasks and Cloud Scheduler calls to the job endpoints"
}

resource "google_cloud_tasks_queue" "generation" {
  name     = "cs-${var.environment}-generation"
  location = var.gcp_region

  rate_limits {
    max_concurrent_dispatches = var.job_queue_max_concurrent_dispatches
    max_dispatches_per_second = 5
  }

  # One retry, for crashes and timeouts only: job functions record their own
  # failures and return 200. Keep attempts x JOB_DISPATCH_DEADLINE_SECONDS
  # inside STUCK_JOB_STALE_AFTER (backend/src/common/job_policy.py).
  retry_config {
    max_attempts  = 2
    min_backoff   = "10s"
    max_backoff   = "60s"
    max_doublings = 1
  }
}

resource "google_cloud_tasks_queue_iam_member" "backend_can_enqueue" {
  name     = google_cloud_tasks_queue.generation.name
  location = google_cloud_tasks_queue.generation.location
  role     = "roles/cloudtasks.enqueuer"
  member   = "serviceAccount:${module.backend_service.run_sa_email}"
}

# create_task with an OIDC token requires actAs on the token's identity.
resource "google_service_account_iam_member" "backend_can_act_as_job_invoker" {
  service_account_id = google_service_account.job_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${module.backend_service.run_sa_email}"
}

module "worker_service" {
  source = "../cloud-run-service"

  gcp_project_id       = var.gcp_project_id
  gcp_region           = var.gcp_region
  environment          = var.environment
  service_name         = var.worker_service_name
  resource_prefix      = "cs-wk"
  github_conn_name     = var.github_conn_name
  github_repo_owner    = var.github_repo_owner
  github_repo_name     = var.github_repo_name
  github_branch_name   = var.github_branch_name
  cloudbuild_yaml_path = "backend/cloudbuild.yaml"
  included_files_glob  = ["backend/**"]
  container_env_vars   = local.backend_env_vars
  runtime_secrets      = var.backend_runtime_secrets
  source_repository_id = google_cloudbuildv2_repository.source_repo.id
  cpu                  = var.worker_cpu
  memory               = var.worker_memory

  scaling_min_instances = var.worker_min_instances
  scaling_max_instances = 20

  # Same image as the backend, built by the worker's own trigger.
  # backend/cloudbuild.yaml deploys to _SERVICE_NAME, so this trigger only
  # ever touches the worker.
  build_substitutions = merge(var.be_build_substitutions,
    {
      _REGION       = var.gcp_region
      _SERVICE_NAME = var.worker_service_name
    }
  )

  cloud_sql_connection_name = module.postgresql.connection_name
  db_name                   = module.postgresql.db_name
  db_user                   = module.postgresql.db_user
  db_secret_id              = "creative-studio-db-password"

  # Private: reachable only from Cloud Tasks and Cloud Scheduler, as job_invoker.
  allow_unauthenticated            = false
  ingress                          = "INGRESS_TRAFFIC_INTERNAL_ONLY"
  max_instance_request_concurrency = var.worker_max_request_concurrency
  request_timeout                  = "900s"
  # Jobs run inside requests, so CPU is only needed while one is open.
  cpu_idle = true
}

resource "google_cloud_run_v2_service_iam_member" "job_invoker_can_invoke_worker" {
  name     = module.worker_service.service_name
  location = module.worker_service.location
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.job_invoker.email}"
}

# Fails jobs whose worker died on its last attempt. Runs in every mode: it
# also replaces the manual /api/admin/cleanup-stuck-jobs for in_process.
resource "google_cloud_scheduler_job" "sweep_stuck_jobs" {
  name             = "cs-${var.environment}-sweep-stuck-jobs"
  region           = var.gcp_region
  schedule         = "*/10 * * * *"
  attempt_deadline = "60s"

  http_target {
    http_method = "POST"
    uri         = "${local.job_target_url}/internal/jobs/sweep"

    oidc_token {
      service_account_email = google_service_account.job_invoker.email
      audience              = local.job_target_url
    }
  }
}
