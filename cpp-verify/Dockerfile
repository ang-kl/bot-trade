# Build context is THIS DIRECTORY (root directory /cpp-verify), which is what
# lets Railway read cpp-verify/railway.json instead of the repository root's —
# the root one belongs to the Node service and, on a fresh deploy, wins over
# every panel setting. The transport lives FLAT in src/ as a vendored copy kept
# byte-identical by a test — not in a subdirectory, because `#pragma once` is
# path-based and two paths to one header is a class redefinition.
FROM debian:stable-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ make libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Makefile ./
COPY src ./src
RUN make CXX=g++ all

FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home appuser
COPY --from=build /app/bin/cpp-verify /usr/local/bin/cpp-verify
# No volume, no spool, no entrypoint script: this service holds no state.
USER appuser
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cpp-verify"]
