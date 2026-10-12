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

FROM node:24-alpine AS builder

WORKDIR /app
COPY . /app/

RUN npm ci
RUN npm run build-dev

# The unprivileged nginx image runs as the nginx user (UID 101) with its pid
# and temp paths under /tmp. nginx.conf already listens on 8080, so the port
# is unchanged.
FROM nginxinc/nginx-unprivileged:alpine

# The base image lags behind Alpine security fixes; apk needs root.
USER root
RUN apk upgrade --no-cache

# The site files stay root-owned: nginx only needs to read them.
COPY --from=builder /app/dist/creative-studio/browser /usr/share/nginx/html
# It's best practice to replace the default config file.
COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf

USER 101

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD ["wget", "-q", "--spider", "http://127.0.0.1:8080/"]
