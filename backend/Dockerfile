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

# Use a Python image with uv pre-installed
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

# Pull in the latest bookworm point-release and security updates (the base
# image lags behind them), then install ffmpeg. This runs before the source
# COPY so code changes don't reinstall it. Skipping recommends drops GPU/VA
# drivers, dbus and a second system Python that Cloud Run never uses.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Run as an unprivileged user. UID 1000 matches the usual first user on a
# Linux host, so the docker-compose bind mount of ./backend stays usable.
# Only /app/.venv is owned by it; the source under /app stays root-owned.
#
# docker-compose mounts the host's gcloud ADC at /root/.config/gcloud, so
# let the app user traverse /root (not list it) and point google-auth there.
# On Cloud Run that path doesn't exist and auth uses the metadata server as
# before.
RUN groupadd --gid 1000 app \
    && useradd --uid 1000 --gid app --create-home --home-dir /home/app app \
    && install -d /app \
    && install -d -o app -g app /app/.venv \
    && chmod 711 /root
ENV CLOUDSDK_CONFIG=/root/.config/gcloud

# Install the project into `/app`
WORKDIR /app

# Enable bytecode compilation
ENV UV_COMPILE_BYTECODE=1

# Copy from the cache instead of linking since it's a mounted volume
ENV UV_LINK_MODE=copy

# Build the venv as the app user so it owns /app/.venv: docker-compose's
# backend_venv volume is seeded from it and `uv sync` runs there at startup.
# Numeric so runtimes can verify it is non-root without reading /etc/passwd.
USER 1000:1000

# Install the project's dependencies using the lockfile and settings
RUN --mount=type=cache,target=/home/app/.cache/uv,uid=1000,gid=1000 \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --locked --no-install-project --no-dev

# Then, add the rest of the project source code and install it
# Installing separately from its dependencies allows optimal layer caching.
# The source stays root-owned, so the app user can't modify it.
COPY . /app
RUN --mount=type=cache,target=/home/app/.cache/uv,uid=1000,gid=1000 \
    uv sync --locked --no-dev

# Place executables in the environment at the front of the path
ENV PATH="/app/.venv/bin:$PATH"

# Reset the entrypoint, don't invoke `uv`
ENTRYPOINT []

# Set default environment variables
ENV ENVIRONMENT="development"
ENV FRONTEND_URL="http://localhost:4200"

EXPOSE 8080

CMD ["gunicorn", "main:app", "--workers=4", "--worker-class=uvicorn.workers.UvicornWorker", "--timeout=36000", "--bind=0.0.0.0:8080"]
