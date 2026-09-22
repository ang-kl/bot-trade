# P5c identified gateway-to-tick-scanner mirror

The optional gateway mirror sends the **same classified quote records** consumed
by the existing recorder/workers to cpp-scan-tick. It does not add a broker
connection, subscribe a new universe or transfer candidate/order ownership.
Broker source time (nullable) and gateway receipt time are separate. Account,
broker host, instrument ID, feed epoch, configuration and profile hash travel
with each batch. Demo/live identifies the connection, not an eligibility rule.

The quote callback makes one fixed-size non-blocking SPSC push. Serialization,
per-symbol state and HTTP live on a separate worker. The ring holds 16,383 events,
a drain is at most 256 records, and at most 512 symbol streams are retained.
Queue loss or failed delivery marks the next affected stream as gapped so the
scanner re-warms. Transport sequence and original source sequence are distinct.
The feed epoch changes on gateway feed restart. Exhausted sequence/capacity is
refused and counted, not wrapped. An unexpected worker exception is caught and
reported as workerFailed; it cannot terminate the gateway.

HTTP has a two-second total deadline, a one-second connect deadline, bounded
response handling, TLS verification and no redirects. Async DNS is required.
Only HTTP 202 counts as **transport delivery**, never scan completion. Shutdown
can discard queued observations; restart re-warm is required. The existing
protection callback, recorder universe/classification and legacy raw-tap API
are preserved. Quotes-only symbols are excluded by the existing recorder gate.

Configuration is off when absent. A comparison rollout explicitly supplies:

- TICK_SCANNER_MIRROR_URL: the scanner's /feed endpoint.
- TICK_SCANNER_MIRROR_SECRET: its scanner-only credential.
- TICK_SCANNER_CONFIG_VERSION and TICK_SCANNER_CANDIDATE_TTL_MS.

GET /scanner-mirror uses the gateway's existing read authentication and exposes
identity, counters, delivery/input times and worker failure. No gateway secret
is sent to the scanner. Invalid mirror configuration leaves the existing path
running and reports the failure without logging credentials.

## Evidence and acceptance boundary

Local Node 22 full gate: **5,244 passed**, including the actual C++/JavaScript
backtest parity check. ESLint zero warnings; Vitest **911 passed**; production
build, no-green and syntax checks passed. Full gateway C++ build/test and all
**15 ThreadSanitizer threading tests** passed, including the new mirror. Tests
cover a blocked sender without blocking quote ingestion, overflow and failed
delivery gaps, source timestamps, feed identity and single recorder delivery.

The local filesystem dropped execution permission on rebuilt binaries. Initial
Node/C++ execution failed with EACCES; restoring permissions and rerunning the
unchanged complete suites passed. No gate or assertion was disabled.

Implemented/tested only. No scanner endpoint, credential, service, mode or
production gateway was configured/restarted. CI must pass on the PR. Controlled
gateway rollout, protection latency under actual peak load, scanner calendars,
actual legacy/new candidate comparison, ownership handoff and runtime acceptance
remain separate. The timeframe bar supplier is not implemented by this package.
