# Build stage: full toolchain, not shipped in the runtime image.
FROM debian:stable-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
        g++ make libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Makefile ./
COPY src ./src
# Image builds use the system OpenSSL; CXX override because base has g++ only.
RUN make CXX=g++ all

# Runtime stage: only libssl + the binary, run as non-root.
FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        libssl3 ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home appuser
COPY --from=build /app/bin/cpp-exec /usr/local/bin/cpp-exec
USER appuser
EXPOSE 8091
CMD ["cpp-exec"]
