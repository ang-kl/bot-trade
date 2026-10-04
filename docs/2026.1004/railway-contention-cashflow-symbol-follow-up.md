# Railway contention, cashflow and symbol follow-up

Prepared 2026-10-05 SGT from repository `main` at `2f29054aa2aa8dc88de1acb48800ae468bc33e00`.

Owner instruction: “investigate SQLite contention, cashflow-read failures, and missing symbol IDs. Resolve the issues and start the work of any remaining outstanding Auto-merge”. This authorizes these fixes and their green-gate merge. The dated archive and its earlier evidence remain intact.

Conversation ref: ordered and reported after the recorded continuation lower bound № 11,121; exact current per-reply serial and session link are not exposed in this partial cloud corpus. Effort: unavailable from current-session metadata; no value inferred.

## Database contention

Production continued to report cross-side reconciliation `database is locked`, including two accounts at 2026-10-04 19:12:59 UTC. Broker deal persistence had also reported a skipped receipt for this reason. The main SQLite connection uses WAL and a 5,000 ms busy timeout; the scanner worker has another writing connection.

Four regression cases use a real file-backed database and a real second WAL connection. The competing writer commits just after the first transaction read. Before the fix, reconciliation fails and the cashflow window and deal receipt writers throw `SQLITE_BUSY_SNAPSHOT`. A longer busy timeout cannot upgrade an invalidated snapshot.

Cross-side reconciliation, cashflow event/coverage persistence and broker deal persistence now reserve the writer with an immediate transaction before reading. The tests show each operation completing atomically, the peer waiting, and the peer writing successfully after commit. Broker I/O remains outside these transactions. Existing account identity, duplicate conflict, first-known balance and rollback checks remain in force.

## Cashflow collection

The reporting collector has a five-second end-to-end budget. The shared WebSocket pool has separate authentication and queue budgets, so a read could remain queued after its collector deadline. Cashflow reads now use one short-lived socket with authentication and historical pacing inside the same deadline. They enter the existing historical request limiter and have no immediate retry loop. The producer still selects one account/window per 30-second tick and retries an uncompleted interval on a later fair round.

Failures record a safe category and phase: timeout, queue timeout, transport, allowlisted broker rejection, database busy, storage failure or persistence failure. Broker descriptions and arbitrary messages are not copied into receipts or logs. A failed receipt write is logged safely as well. Tests verify redaction, unchanged gaps, late-read exclusion, fair scheduling and successful retry of the same window after a persistence failure.

## Account-owned symbol IDs

The previous tick warning reduced a resolver's account-specific reason to `no id`. Diagnostics now retain the feed account, broker host, exact requested name, resolution source and a safe reason. The configured and quotes-only universes have separate persisted receipts.

A changed unresolved request asks the existing symbol-map refresher for one newer account-owned list, including when the cached map is still within its daily TTL. The five-minute pass, one account per pass, 30-minute minimum gap, failure backoff, refused/disabled account checks and three reads per account per UTC day still apply. An unchanged miss is not re-dated on every probe or restart. The refreshed requested-name results are logged and kept with the refresh receipt.

Tests prove that a newly listed exact name acquires the feed account's own ID without using another account's global map. If the fresh list still lacks that exact name, it remains explicitly unavailable and does not generate repeated refreshes or guessed aliases. Invalid numeric IDs and conflicting IDs for the same normalized name cannot replace the stored map.

The production availability of `SPX500`, `USOIL` and `UKOIL` must be verified from those new own-list receipts after deployment. A legitimate broker-name difference requires an account-specific identity decision; it is not permission to substitute another instrument.

## Remaining work started: capacity and readiness evidence

At approximately 2026-10-04 19:49 UTC, Railway reported all six services online, one running replica each, no crashes and no unresolved warning/critical issue. The current two-hour metrics sample contained 121 samples per service:

| Service | Maximum CPU usage | Maximum memory GB | Latest reported disk GB | Mounted quota MB |
| --- | ---: | ---: | ---: | ---: |
| bot-trade | 0.4864 | 2.5061 | 5.2280 | 10,000 |
| cpp-verify | 0.0478 | 0.1244 | 1.0633 | 50,000 |
| cpp-acct | 0.0825 | 0.0416 | 2.0727 | 50,000 |
| cpp-exec | 0.1208 | 0.0447 | 3.6176 | 50,000 |
| cpp-scan-tick | 0.1069 | 0.0393 | 0 | None |
| cpp-scan-timeframe | 0.0021 | 0.0134 | 0 | None |

The provider reported CPU and memory limits of 24 for each service. These samples do not show CPU or memory saturation. Disk figures are provider-reported service metrics, not a per-path allocation audit. The node volume is the smallest mounted quota and needs continued growth/retention observation. This establishes the current capacity baseline for P8; it does not prove backup restoration, segment completeness or a future soak.

Current application credentials remain unavailable in the cloud environment. Railway's runtime reader supports text files and logs, but cannot execute SQLite queries or authenticated internal HTTP. Authenticated calendar, account phase/funds, whole-lifecycle history and full pre-market readiness checks therefore require secure application read access. Public health, service status, metrics and post-deployment receipts can still be verified.

Owner decisions on exact scanner account alignment, risk/activation and historical repairs; missing original statement/workspace bytes; natural execution/protection events; and elapsed soak/forward-day conditions remain open under the existing outstanding register. They cannot be replaced by test orders, invented identities or a passing build.

## Release verification

The full repository gate is required: backend suite including isolated latency/hygiene groups, zero-warning lint, frontend tests, production build, colour gate, and green CI for the exact PR head with a clean merge state. Targeted regression success is not the full release gate. After merge, verify the serving commit, all six live deployments, every account's cashflow round, own-list symbol results and repeated reconciliation cycles. A short clean log window is a bounded observation, not a completed soak.
