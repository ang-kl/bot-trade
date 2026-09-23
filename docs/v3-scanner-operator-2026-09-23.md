# V3 scanner profile registration and continuous comparison

This Node-only change provides GET/POST `/actions/scanner-profiles`, under the
existing full-tier write authentication. GET returns `profiles` and `revision`.
POST accepts `{expectedRevision,profiles}`. Registration validates each exact
account/host/symbol against the account's own map, native option/profile hash,
closed timeframe, version, TTL and bounded tick parameters. The whole update
and permanent AUDIT receipt commit atomically. Stale revisions, duplicate feed
identities and unsupported semantics fail without partial registration.

The operator first reads the registry, supplies reviewed profiles with that
revision, posts them, then compares the GET readback. Profile registration is
refused while SCANNER_BRIDGE_ENABLED=1 to prevent changing a running comparison
population. This endpoint cannot enable that flag, subscribe a feed, change a
strategy configuration or issue an entry permit. No production profiles have
been registered. The account-map correction in the watchdog PR is a deployment
prerequisite; otherwise existing candidate/comparison readers reject real maps.

The isolated collector now services both mirror sources and up to eight tick
comparison pages per round with a one-second inter-page budget, yielding between
pages. It schedules the next round after completion: 10ms with backlog, 100ms
idle, 1s on error. Requests remain bounded to two seconds. It retains actual
cursor, pages/records, backlog and duration, detects no-progress pages, resets
on process identity changes and preserves explicit gap evidence. Retention
runs once per minute. This replaces a fixed 15-second wait that could let the
4096-record native comparison ring overwrite before the next read.

This does not promise lossless comparison at every ingress rate. Collector
throughput, oracle CPU and shared SQLite contention must be included in the
supported-capacity evidence. Actual feed peaks, exact production registrations,
and protection latency still need the separate approved observation trial.

Local gate: 28 isolated HTTP-latency tests plus 5,341 remaining backend cases (one native parity case was initially
skipped because its binary was not copied; it passed separately after restoring
the built binary),
936 frontend tests, lint, build and no-green passed. Seven added tests exercise
operator HTTP registration, stale writes, invalid routing/profiles, continuous
bounded drain, retries, restart/gap recovery and real worker wiring.

Rollback restores the previous Node image and keeps SCANNER_BRIDGE_ENABLED
unset/OFF. Registered profiles and comparison receipts are additive. The old
collector's 15-second drain limitation returns. New scanner feeds stay OFF.

The continuous worker trial exposed a second comparison defect: expiry labels
were accepted before checking oracle differences, while correct expired signals
were compared against unsuppressed reference candidates. The reader now derives
expiry independently from the registered TTL and native completion timestamp,
advances oracle state, and compares the dispatch-eligible reference. Incorrect
expiry labels remain mismatches. A regression test exercises both directions.
The integrated full gate covers this correction and the real account-map fix.
