# 03 — Approval → order lineage

Phase 3 of the Verified Defect Repair prompt. This document covers the part of
Phase 3 that is **proved at present HEAD**. Everything not proved is named as
open at the bottom rather than implemented on a guess.

---

### R3-1 — A single failing housekeeping step silently cancels every later step for eight hours, including the disposition sweep

**Classification:** `CORRECTNESS FIX`
**Severity:** high — it is the mechanism that keeps the §70.8 "approved then
silence" finding invisible
**Confidence:** high for the mechanism; the specific production step that threw
is **not** identified (see Counter-evidence)
**Status:** reproduced
**SHA:** `9101eb4b206d5cbafc155c75cd68aaa9ba5f96c5`
**Scope:** `agent/loop.js` housekeeping block

#### Observation

Read at 2026-08-06 07:41 and again at 07:43 UTC, with the production agent
restarted at 07:38 UTC — i.e. **after** #668's cadence fix was deployed:

```
GET /state/dispositions?days=7
{"window":7,"counts":{},"dropped":[],"droppedTotal":0,"latency":null,"pendingNow":55417}
… two minutes later …
{"window":7,"counts":{},"dropped":[],"droppedTotal":0,"latency":null,"pendingNow":55443}
```

`pendingNow` is non-zero and rising, so the `disposition` column exists and the
read path works. `counts` is empty, so **not one row has ever been settled**.

#### Causal chain

`agent/loop.js`, housekeeping block:

1. `setState(db, LAST_RUN_KEY, …)` stamps the 8-hour schedule **before** the
   work. That is deliberate and correct — a pass that throws must not re-run and
   re-throw on the very next loop.
2. Eight retention steps follow (`d1`…`d8`: four `DELETE`s plus
   `pruneDecisionLog`, `prunePositionEvents`, `pruneTradeHistory`,
   `pruneOperationalTables`). None of them was individually try/caught, under a
   comment asserting the opposite: *"Every step below is individually try/caught
   anyway, so a partial pass still makes progress."*
3. The §70.8 disposition sweep sits ~130 lines further down, inside the same
   `try`.
4. So any throw in steps 1–8 — a lock on a 526 MB database, a table a migration
   has not yet created, a prune helper meeting an unexpected row — jumps to the
   block's single outer `catch`, skipping the sweep.
5. Because the stamp was already written, the next attempt is **eight hours**
   later, where it fails the same way. The outage renews itself.

The shape of the bug is the shape of the finding it was hiding: something ran,
something else did not, and nobody was told.

#### Counter-evidence

This proves the *mechanism*, not which step threw in production. `log()` output
for the housekeeping block is not exposed on a read-only route, so the specific
failing step is unproved from here. Two other explanations remain formally open
and are cheap to rule out once this ships, because the new log line names the
failing step: (a) the pass has genuinely never been due since the fix deployed,
(b) the loop never reaches the block. Both are contradicted by `pendingNow`
having climbed across restarts for days, but neither is disproved.

#### Minimum sufficient remedy

`agent/services/housekeeping-run.js` — `runHousekeepingSteps(steps, {log})`
runs each step in its own `try`, records `{name, message}` for failures, and
continues. The loop's eight retention steps become named entries; the summary
line now ends with `— N step(s) FAILED: <names>` when any did.

Nothing about the schedule changes. Stamp-before-work stays.

#### Regression proof

`agent/services/housekeeping-run.test.js` — six tests. The first is the
regression: a middle step throws, and the assertion is that the step *after* it
still ran. It fails against the old inline code by construction, because there
the later step is unreachable.

#### Rollback

Revert the `loop.js` hunk to the inline `d1`…`d8` statements and delete
`housekeeping-run.js`. No schema, no state key, no config.

---

### R3-2 — One sweep batch cannot drain the backlog it was built for

**Classification:** `CORRECTNESS FIX`
**Severity:** medium
**Confidence:** high
**Status:** reproduced (arithmetic on measured production numbers)
**SHA:** as above
**Scope:** `agent/services/opportunity-disposition.js`, `agent/loop.js`

#### Observation

`sweepDispositions` runs `… WHERE disposition IS NULL ORDER BY id DESC LIMIT
5000`. Housekeeping runs every 8 hours. Production backlog: **55,443**.

55,443 ÷ 5,000 = 12 passes = **four days** before `/state/dispositions` can
describe the window an operator is actually looking at — and the funnel numbers
they read beside it move faster than that.

#### Minimum sufficient remedy

`drainDispositions(db, {maxBatches = 40, …})` — repeat the sweep until a batch
settles nothing, bounded by `maxBatches`, returning `batches` and `drained`. The
loop calls it instead of the single sweep and logs when the cap is hit, so a
truncated pass cannot read as a complete one. The work is one indexed scan plus
an `UPDATE` over rows that already exist; no broker call, nothing to rate-limit.

#### Regression proof

Three tests in `agent/services/opportunity-disposition.test.js`: a 25-row
backlog with `limit: 10` (one sweep settles 10, the drain finishes the other
15); a capped drain that reports `drained: false`; and an all-in-flight table
that terminates in one batch without re-querying.

#### Policy boundary

No risk threshold, no gate, no strategy, no order path. Retention windows
unchanged (30/90 days, ~2 years). The disposition *derivation* is untouched —
same rules, same grace window, just actually reached and actually finished.

---

## Deliberately NOT implemented in this PR

The Phase 3 specification asks for more than the two defects above. The rest is
not written here because it is not yet evidenced at HEAD, and the prompt's own
rule is that a defect must be reproduced before it is repaired:

- **Reason attribution on `dropped`.** Worth having, but the right reason set
  cannot be designed before a single real `dropped` row has been read — and
  there are none yet, because of R3-1. This is the first thing to revisit once
  the sweep has run in production.
- **A no-terminal-state watchdog alert.** Same dependency: the alert threshold
  should be set against the settled distribution, not invented.
- **The immutable transition ledger, idempotent retries, restart recovery.**
  `risk_events.id` is already the opportunity identity (§69.4.1) and
  `submitted_at` already times the verdict → submission interval. Whether a
  separate transition table is needed is a design question that should follow
  the first real reading, not precede it.

**Deployment status:** not deployed at the time of writing. **No live trading
action was taken.**

---

## Addendum, 08:20 UTC — the fix deployed, and the report is still empty

PR #670 merged and deployed (agent restart 08:09:58Z). Read at 08:12:

```
GET /state/dispositions?days=7   counts {}   pendingNow 55,608
```

**This is expected, and it is the self-renewing part of R3-1 showing itself
one last time.** The schedule stamp is written before the work, so whichever
earlier pass failed also consumed the window: the next attempt cannot happen
until eight hours after that stamp. The fix is in the process; the process is
waiting for its turn.

That produces a new, smaller problem — "deployed but not due yet" and "deployed
and still broken" read identically from outside, and the failing step's name
goes to `console.log`, which no route can query.

### R3-3 — the housekeeping outcome was not observable from any read route

**Classification:** `OBSERVABILITY FIX` · **Status:** reproduced (I hit it
myself, twice, within an hour of shipping the fix it was meant to verify)

`housekeepingStatus(db)` persists and serves the pass outcome, and
`/state/dispositions` now carries it:

```json
"housekeeping": {
  "lastAt": "2026-08-06T04:12:00.000Z",
  "nextDueAt": "2026-08-06T12:12:00.000Z",
  "dueInMs": 14040000,
  "due": false,
  "lastResult": {
    "at": "…", "ran": 7,
    "failed": [{"name": "prune-operational", "message": "database is locked"}],
    "dispositions": {"written": 0, "batches": 1, "drained": true, "pending": 55608}
  }
}
```

So the next reading answers three questions that previously required guessing:
has the pass run, when can it next run, and which step failed. Tested in
`housekeeping-run.test.js` — a cold database reports `due: true` with
`lastResult: null` (never run, **not** "ran and found nothing"), and a pass an
hour old reports `due: false` with roughly seven hours to go.
