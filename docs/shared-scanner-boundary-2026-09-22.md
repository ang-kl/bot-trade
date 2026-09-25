# Shared scanner boundary — implementation checkpoint

Revision 3 P5c introduces two independent C++ executables with their own build
contexts: `cpp-scan-tick` and `cpp-scan-timeframe`. They are **mirror candidates
only**, have no broker connection or order-writing library, and require their
own `SCANNER_SECRET`. They must never receive a gateway or Node write credential.
No Railway service, credential, mode or scanner ownership was activated here.

Each input names cTrader host, account and symbol IDs, a feed epoch, config
version, strategy profile and explicit comparison-run candidate lifetime. The
same broker symbol ID on another account/host is separate work. Source time is
nullable and remains distinct from receipt and evaluation times. Stable
candidate identity includes the feed/config/profile/source sequence and, for
bars, timeframe. A fresh per-process output instance ID and bounded cursor report restart and overwrite gaps;
consumers must not treat a cursor hole as a complete comparison history.

Tick ingress is bounded to 512 records per request, 512 streams and fixed
worker queues. It reuses the existing incremental strategy and symbol workers
byte-for-byte. Retry sequences cannot emit duplicate candidates. A new epoch,
transport gap, overflow, snapshot, clock regression or invalid quote requires
re-warm. Original gateway record sequence is distinct from the per-stream
transport sequence. A profile/config change requires a new stream. Since V3
CV-1 (25-09-2026) a stream is keyed WITHOUT the feed epoch: a new epoch takes
the stream over on a new slot (the old slot drains, then is erased) and
rewarms; a superseded epoch is refused (`superseded_feed_epoch`, HTTP 400).
At capacity a stale stream (nothing fed for an hour, nothing in flight) is
evicted to admit a new one; with none stale the new stream is refused
visibly. Before CV-1 every gateway restart added a stream per symbol until
`stream_capacity` refused all input. The cap stays 512 because each stream is
one `/watchdog` row and 1024 rows would pass cpp-verify's 256 KiB bound.
Frozen existing JavaScript oracle cases test 1/2/4 workers, accounts, broker
hosts, expiry, gaps and retries. Output candidates cannot admit orders.

The initial timeframe native coverage is **only the original FX-tuned Fibonacci
closed-bar baseline without optional filters**. Unsupported strategies, options
and partial-bar semantics are explicitly refused and retain the reference
owner. Queue capacity is 32 jobs and one worker. Since V3 CV-1 the table holds
1024 cells, one per (feed, config, profile, timeframe) and never per feed
epoch: a restarted Node re-sending a checkpointed bar gets `duplicate`, and its
next bar lands in the same cell (measured before CV-1 on the plan's 690 cells:
512 admitted and 178 refused, then 0 admitted after one Node restart). A stale
idle cell (not offered for an hour) is evicted only to admit a new one. Closed
bars must have ordered source timestamps and complete OHLC values. Only a cell
with a job queued or running is a `/watchdog` work item (due from its oldest
waiting receipt); an idle cell has no deadline and is counted in
`status().cells` instead — a per-bar deadline passed cpp-verify's grace on
Node's own rotation, and a row per cell would put 690 cells far past the
verifier's 256 KiB contract bound. HTTP polling does not freshen work. The frozen reference fixtures include long, short,
warm-up, no-touch and flat data. This limited port does **not** complete the
approved timeframe C++ target or establish parity for the other strategies.

Remaining implementation/acceptance in dependency order:

1. Connect bounded gateway feed publishers, retaining direct protection and
   existing scanner ownership; report drops, lag and epoch changes.
2. Add the Node comparison ledger, strict candidate identity/version/expiry
   validation and durable duplicate-intent boundary. Never admit mirror results.
3. Port the remaining strategy semantics/options against frozen JavaScript
   inputs; preserve warm-up, session alignment, tick-volume meaning and
   closed/partial-bar rules. Retain an isolated reference worker on failed parity.
4. Verify watchdog coverage, measured p95/p99/max queue and protection behaviour,
   feed/reconnect/restart recovery, duplicate prevention and explicit rollback.
5. Only the approved controlled rollout may provision/activate services or
   transfer candidate ownership at an identified checkpoint. Neither compilation
   nor fixture parity proves live readiness or profitable tick entries.

The binaries listen on `PORT` (8080 default). Public `/health` declares the
mirror/no-order-authority boundary; bearer-gated `/watchdog` exposes completed
work and `/candidates?after=N` reads at most 256 retained results. Tick input is
`POST /feed` (256 KiB); timeframe input is `POST /evaluate` (1 MiB). Existing
HTTP server bounds remain in force. No endpoint provides order admission.
