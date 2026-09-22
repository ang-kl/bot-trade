# Build context is THIS DIRECTORY (root directory /cpp-verify), which is what
# lets Railway read cpp-verify/railway.json instead of the repository root's —
# the root one belongs to the Node service and, on a fresh deploy, wins over
# every panel setting. The transport lives FLAT in src/ as a vendored copy kept
# byte-identical by a test — not in a subdirectory, because `#pragma once` is
# path-based and two paths to one header is a class redefinition.
FROM debian:stable-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ make libssl-dev libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Makefile ./
COPY src ./src
RUN make CXX=g++ all

FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        libssl3 libcurl4 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home appuser
COPY --from=build /app/bin/cpp-verify /usr/local/bin/cpp-verify
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# THIS SERVICE NOW HOLDS STATE — the verdict journal — and the comment that
# used to sit here ("no volume, no spool, no entrypoint script: this service
# holds no state") is corrected rather than left to mislead the next reader.
#
# The entrypoint runs as ROOT only long enough to mkdir and chown the journal
# directory on the mounted volume, which Railway mounts root-owned, then drops
# to uid 10001 via setpriv before exec. Measured 18-09-2026: without it
# /health reported `"lastError": "mkdir: Permission denied"` and every verdict
# would have gone unrecorded while the service looked healthy.
#
# So there is deliberately NO `USER appuser` line: the process still ends up as
# appuser, but the drop happens in the entrypoint, after the chown.
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
