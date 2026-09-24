# P1 follow-up: bounded scan-priority writes

Intent: reduce main-thread durable writes from watchlist tick bursts while
preserving immediate protection processing and exact priority consumption.
The owner authorized continued P1/P4 builds on 24 September.

Evidence: #1074's first production scan profile attributes 14,831.8 ms to
setState and 247.1 ms to flagScanPriority's own JavaScript frame. The latter
reads and rewrites the entire scan-priority map for each flat-symbol spike;
the observed first scan listed roughly 200 priority symbols. The call graph
establishes a write-amplification mechanism, not that all setState time is
from this writer. A local benchmark will isolate its contribution.

Interpretation: coalesce only these advisory rotation hints on a 250 ms timer.
Each queued symbol retains its latest actual event time. Consumption flushes
first, so a scan never misses an in-memory hint. Existing persisted hints merge
with new ones. Shutdown flushes pending hints. Unexpected process loss can lose
the pending advisory hints; ordinary scan rotation remains. Event-loop stalls
can delay the timer, so 250 ms is the scheduling interval, not a hard wall-clock
durability promise.
Broker protection, intents, quotes and order writes are never batched here.

Startup still took 70.6 s before BOOT on #1074. Add coarse monotonic database
initialization phase timings so the next correction targets measured work.
No migration is skipped, no durable sync setting changes, no data is deleted.

Scope: agent/services/guardian.js, new scan-priority-batch module/tests,
agent/db.js startup timings and tests, benchmark/evidence, this document and
the continuation ledger. No risk thresholds, arming, credentials or policies.

Invariants:
1. All queued symbols reach the next scan with their actual latest event time.
2. Consumption clears hints once; later events can requeue the same symbol.
3. Existing persisted hints survive a flush; failed writes do not drop pending hints.
4. Held-position protection uses the original immediate path.
5. A burst shares one bounded scheduled flush rather than one commit per tick.
6. Restart retains flushed hints; only pending advisory hints may be lost.
7. SQLite FULL/WAL, migration operations, all seven account controls and broker
   protection are preserved. Production timing/protection need fresh readback.

Local evidence: three isolated 1,000-event / 200-symbol WAL/FULL bursts reduced
the priority writer from 1,000 writes to one, 462.8–610.5 ms to 1.95–4.03 ms.
See docs/evidence/v3-scan-priority-batch-2026-09-25.json. This does not establish
the percentage of total production state-write time attributable to this path.
