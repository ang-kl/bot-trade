# Build context is the REPOSITORY ROOT (railway.json / dockerfilePath), because
# this service compiles cpp-exec's WebSocket transport and HTTP server from
# their own directory rather than keeping a copy.
FROM debian:stable-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ make libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY cpp-exec/src ./cpp-exec/src
COPY cpp-verify ./cpp-verify
WORKDIR /app/cpp-verify
RUN make CXX=g++ all

FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home appuser
COPY --from=build /app/cpp-verify/bin/cpp-verify /usr/local/bin/cpp-verify
# No volume, no spool, no entrypoint script: this service holds no state.
USER appuser
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cpp-verify"]
