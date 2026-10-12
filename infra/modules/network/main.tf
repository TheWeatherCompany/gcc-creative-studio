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

# Mirrors upstream's infrastructure/modules/network: same resource addresses,
# names and outputs. Resource names can't change once created, so keep them in
# step with upstream. A dedicated custom-mode VPC rather than the project's
# default network, which is auto-mode, carries the 0.0.0.0/0 SSH and RDP rules
# and is not managed here.

# --- Custom VPC Network ---
resource "google_compute_network" "vpc" {
  name                    = "${var.resource_prefix}-${var.environment}-vpc"
  project                 = var.project_id
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

# --- Subnet for Cloud Run Direct VPC Egress ---
resource "google_compute_subnetwork" "cloud_run_subnet" {
  name          = "${var.resource_prefix}-${var.environment}-run-subnet"
  project       = var.project_id
  network       = google_compute_network.vpc.id
  region        = var.region
  ip_cidr_range = var.cloud_run_cidr

  # Lets instances without public IPs reach Google APIs.
  private_ip_google_access = true
}

# --- Private Services Access (Cloud SQL Peering) ---
# Google picks a free /24 in the VPC for Google-managed services.
resource "google_compute_global_address" "private_service_access" {
  name          = "${var.resource_prefix}-${var.environment}-psa-range"
  project       = var.project_id
  network       = google_compute_network.vpc.id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 24
}

resource "google_service_networking_connection" "private_vpc_connection" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_service_access.name]

  # Differs from upstream: deleting the peering fails while Cloud SQL still
  # uses it, so abandon it instead and let a destroy get past it.
  deletion_policy = "ABANDON"
}

# --- Baseline Firewall Rules ---
# Permit traffic from the Cloud Run subnet inside the VPC, with connection
# logging. Custom VPCs deny all ingress by default.
resource "google_compute_firewall" "allow_internal_egress" {
  name    = "${var.resource_prefix}-${var.environment}-allow-internal"
  project = var.project_id
  network = google_compute_network.vpc.id

  allow {
    protocol = "tcp"
  }

  allow {
    protocol = "udp"
  }

  source_ranges = [var.cloud_run_cidr]
  description   = "Allow Cloud Run internal subnet traffic to traverse the VPC"

  log_config {
    metadata = "INCLUDE_ALL_METADATA"
  }
}
