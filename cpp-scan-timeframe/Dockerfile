FROM debian:stable-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ make libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Makefile ./
COPY src ./src
RUN make all
FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends libssl3 ca-certificates && rm -rf /var/lib/apt/lists/* && useradd --system --uid 10001 appuser
COPY --from=build /app/bin/cpp-scan-timeframe /usr/local/bin/cpp-scan-timeframe
USER appuser
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/cpp-scan-timeframe"]
