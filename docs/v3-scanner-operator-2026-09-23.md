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

## 2026-09-25 update (PR-3: bridge and collector)

Superseding the lines above where they differ; still Node only, still inert
until SCANNER_BRIDGE_ENABLED=1 and registered profiles exist, still no order
authority (`scannerMirrorAdmission` refuses everything; PR-7 owns admission).

- **Start and recovery.** `startScannerBridge` runs from `startLoop` at boot
  and ensures the bridge every 60 s on its own timer, so collection no longer
  waits for runLoop to reach the bar scan. A worker `error`/`exit` or a
  construction throw is terminated and rebuilt (at most once per 30 s);
  `bridge.restarts` and `bridge.failure` show it. A failed `send()` of one job
  is counted (`sendFailures`, `lastSendError`) and does not rebuild.
- **Registration bounds.** 1024 profiles and 512 KiB (the 796-profile draft is
  276,080 bytes). The global JSON parser skips `/actions/scanner-profiles`;
  its 512 KiB parser is mounted after `authMiddleware`, so an unauthenticated
  body is never parsed. Every other path keeps the 100 KB default.
- **Comparison load.** One memo per tick comparison page (the registry and
  each account map are read once, not per row). Oracle streams are keyed
  without the feed epoch; a new epoch replaces its stream and rewarms.
- **Native tables (V3 CV-1).** Both C++ scanners now key without the feed
  epoch too, so a Node or gateway restart no longer consumes capacity:
  cpp-scan-timeframe holds 1024 cells (`/watchdog` → `cells`), cpp-scan-tick
  512 streams (`streams`), each evicting a stale entry (unfed for an hour)
  only to admit a new one. cpp-scan-timeframe's `/watchdog` work lists only
  cells with a job queued or running; the timeframe input's liveness is the
  Node contract's `scanner-bridge:collector` item (role `collector`, due
  120 s after the collector's last recorded round; cpp-verify raises a
  warning 60 s after that). Each scanner's `railway.json` watches only its
  own directory, so Node-only merges stop restarting the scanners — whether
  the Railway panel overrides that is read at R0.
- **Retention.** 100,000 rows per source, not shared, trimmed by
  `retainComparisons` on the collector's 60 s cadence (no per-row count on
  insert). The trim finds its edge with a read and deletes in chunks of 2,000;
  the 7-day age deletes are chunked the same way (100,000 stale rows: 51
  statements, at most 23 ms each, where one statement held the write lock
  558 ms). Every statement walks an index.
- **Status cost.** `comparisonStatus` runs on the main thread for every
  `/state/scanner-mirrors` and heartbeat read. Measured locally at 200,000
  rows (100,000 tick, 100,000 timeframe refusals, 2,100 of them in the last
  hour): about 44 ms, of which 40 ms is the index-only populations read and
  1.7 ms the refusal breakdown. The unbounded breakdown it replaced took
  108 ms on the same table (the #1088 checker measured 270 ms).
- **Refusals.** Timeframe inputs refused by the feed are recorded as
  `input_refused` with `error` and `reason` (`bars_empty`, `last_bar_partial`,
  `ohlc_invalid`, `reference_identity_conflict`, ...). The breakdown by
  error and reason, `comparison.inputRefusedLastHour`, covers only the last
  hour (`inputRefusedWindowMs`), a range on the `(source, state,
  observed_ms)` index; the retained total stays in `comparison.populations`.
- **Collector status.** `/state/scanner-mirrors` returns `collector` (the
  worker's round record: `readAtMs`, `durationMs`, `tickPages`,
  `tickRecords`, `tickBacklog`, `error`, `lastError`, `delayMs`). The worker
  writes it at most once a second.
