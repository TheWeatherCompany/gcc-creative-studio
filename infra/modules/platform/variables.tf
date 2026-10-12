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

variable "gcp_project_id" { type = string }
variable "gcp_region" { type = string }
variable "environment" { type = string }


variable "firebase_site_id" {
  type        = string
  description = "The site ID for the Firebase Hosting site. Must be unique across all Firebase projects."
  default     = ""
}

# Backend specific variables
variable "backend_service_name" { type = string }
variable "be_env_vars" { type = map(map(string)) }

variable "be_build_substitutions" {
  type        = map(string)
  description = "A map of substitution variables for the backend Cloud Build trigger."
  default     = {}
}

# Frontend specific variables
variable "frontend_service_name" { type = string }

variable "frontend_custom_domain" {
  description = <<-EOT
    Optional vanity hostname for the frontend, e.g. "gcs.corp.weather.com".
    Setting this also moves the SPA's API base URL and the backend's CORS
    allowlist onto that hostname, so it must match what users type. Empty
    leaves everything on the default *.web.app address.
  EOT
  type        = string
  default     = ""
}

variable "fe_build_substitutions" {
  type        = map(string)
  description = "A map of substitution variables for the frontend Cloud Build trigger."
  default     = {}
}

# Common GitHub variables
variable "github_conn_name" { type = string }
variable "github_repo_owner" { type = string }
variable "github_repo_name" { type = string }
variable "github_branch_name" { type = string }

variable "be_cpu" {
  type = string
  default = "2000m"
}

variable "be_memory" {
  type = string
  default = "2048Mi"
}

variable "fe_cpu" {
  type = string
  default = "2000m"
}

variable "fe_memory" {
  type = string
  default = "2048Mi"
}

variable "frontend_secrets" {
  type        = list(string)
  description = "A list of secret names required by the frontend build."
  default     = []
}

variable "backend_secrets" {
  type        = list(string)
  description = "A list of secret names required by the backend build."
  default     = []
}

variable "backend_runtime_secrets" {
  type        = map(string)
  description = "Secrets to mount in the backend container at runtime."
  default     = {}
}

variable "worker_service_name" {
  type    = string
  default = "cstudio-worker"
}

variable "job_dispatch_mode" {
  type        = string
  default     = "in_process"
  description = "in_process runs jobs on the API's thread pool; cloud_tasks enqueues them."
  validation {
    condition     = contains(["in_process", "cloud_tasks"], var.job_dispatch_mode)
    error_message = "job_dispatch_mode must be in_process or cloud_tasks."
  }
}

variable "job_worker_target" {
  type        = string
  default     = "backend"
  description = "Which service Cloud Tasks and the sweep schedule call: backend (self-targeting stage) or worker."
  validation {
    condition     = contains(["backend", "worker"], var.job_worker_target)
    error_message = "job_worker_target must be backend or worker."
  }
}

variable "job_queue_max_concurrent_dispatches" {
  type        = number
  default     = 12
  description = "Global cap on jobs running at once. This is the Vertex quota guard GENERATION_MAX_WORKERS used to approximate."
}

variable "worker_cpu" {
  type    = string
  default = "2000m"
}

variable "worker_memory" {
  type    = string
  default = "8Gi"
}

variable "worker_max_request_concurrency" {
  type        = number
  default     = 4
  description = "Jobs per worker instance. 4 x the largest job (4 images at 4K) fits 8Gi with headroom; revisit from memory metrics."
}

variable "worker_min_instances" {
  type    = number
  default = 1
}
