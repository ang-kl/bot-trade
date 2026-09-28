# V3 scope-coverage remedy progress

Version 1 - 28 September 2026. Append-only execution record. Times are UTC.

## Intent, interpretation and assumptions

The owner requested the remaining startup-performance and scanner remedies.
This subtask addresses the synchronous `scopeCoverage` cost located in the
27 September production CPU summary (1,788.7 ms attributed to that helper).
The summary identifies a function, not an exact route invocation. The local
experiment below therefore demonstrates a mechanism, not a measured share of
the production startup delay.

The starting source is local commit `f185389`; authority is the repository
`CLAUDE.md`, the owner's current scope and the dated verification follow-up.
Local edits and tests are authorised. Publication, production configuration,
deployment, broker operations and production-secret access are outside this
subtask.

## Invariants and checks before source edits

- Preserve scoped account plus NULL-row inclusion, exact integer counts,
  one-decimal percentage, empty-scope 100% and unscoped semantics: differential
  tests against the original aggregate, including skewed and empty fixtures.
- Preserve the caller's predicate, parameter order, qualified aliases and
  missing-table/column UNKNOWN fallback: generic-path regression cases.
- Preserve HTTP bodies and tied list order: actual risk-event route comparison
  against the original coverage query. No schema or list-query edits.
- Preserve current truth after attribution, retention and file reopen: local
  file-backed regression. No coverage cache is introduced.
- Bound the chosen path to existing per-account and NULL-row indexes: inspect
  the actual helper's `EXPLAIN QUERY PLAN`, not a separately invented query.

## Baseline reproduction before source edits

A synthetic file-backed database initialised through current `initDB` held
250,000 risk events and 250,000 scans. It used WAL and the current production
indexes. Account A had 14,231 rows, 8,065 rows were NULL, and the remainder
belonged to B. Risk-event payloads included roughly 500 bytes of retained JSON.

The current risk aggregate scanned the full covering
`idx_risk_events_lookback`, measuring 11.511-16.720 ms over five warm reads.
One statement with separate scalar counts for account A and NULL rows used
`idx_risk_events_account_latest` and `idx_risk_events_unattributed`, measuring
0.488-0.887 ms with the same counts. This requires no additional index.

Rejected alternatives were measured too. Splitting every table doubled the
unindexed scans traversal: 22.337-31.786 ms versus 14.737-15.740 ms. A compact
`scans(id, account_id)` covering index preserved the observed list tie order
but required 96.646 ms to build and improved the aggregate only modestly
(11.421-17.227 ms). Neither alternative is proposed.

The narrow design is a separate-count fast path only for the exact unfiltered
`risk_events` table and default `account_id` column. It keeps the existing
generic path for predicates, aliases, other tables and unscoped requests.
Both counts execute in one SQLite statement and therefore use one snapshot.

## Execution checkpoint

Regression tests are being added before the source edit. Source changes,
focused test results and final limitations will be appended below.

## Regression-first checkpoint

The four new regression groups were executed against the original source.
The plan regression failed as intended: the actual helper used a full
`idx_risk_events_lookback` scan. The three semantic/HTTP groups passed.
The parent approved the narrow fast path before its source edit. Invalid
extra parameter lists also retain the existing UNKNOWN result rather than
being silently discarded by the fast path.

## Risk correction validation

The narrow risk-events fast path passed 25 focused checks across the original
account-scope tests, the new coverage tests and the existing NULL-index route
regressions. Changed-file ESLint passed. No schema or route-list changes were
required for this correction.

## Scans covering-index investigation reopened

The parent supplied additional startup evidence: `/state/scans` began near
the observed startup freeze and completed after 64,035 ms; the production
database was 3,835 MB. This does not itself prove the coverage call caused
that stall, but it justified testing larger retained scan payloads.

A new file-backed fixture used 50,000 scans with 8,294-byte JSON thesis fields,
producing a 441,470,976-byte database. Actual production payload sizes have
not yet been established; this is a stress workload, not a production clone.
After reopening the database, with a 2 MiB SQLite cache and `shrink_memory`
before each read, the unchanged production helper measured 101.968-132.161 ms
without a covering index and 2.778-4.202 ms with:

```sql
CREATE INDEX IF NOT EXISTS idx_scans_scope_coverage ON scans(id, account_id);
```

Warm-repeat reads measured 103.969-154.643 ms before and 2.240-3.513 ms after.
The operating-system page cache was not cleared. These are SQLite-cache-cleared
and warm measurements, not cold-disk or Railway performance evidence.
Index creation took 145.780 ms and added 638,976 bytes. The helper changed from
`SCAN scans` to a compact covering-index scan; it still traverses retained
account keys rather than becoming a constant-time count.

The actual list SQL retained `idx_scans_at` with no temporary sort. Its full
50-row JSON digest, tied IDs and coverage counts were identical before and
after. The parent authorised preparing upgrade, HTTP, ordering, attribution
and retention regressions before the parent-owned database DDL edit.

## Calibrated scans workload and regression-first checkpoint - 00:56 UTC

The parent's bounded, read-only production read at 00:54:58 measured the
newest 25 scans' combined thesis, desk-note and session-fit text: mean
298.12 characters, maximum 333. It also confirmed the production helper's
current query plan is `SCAN scans`. The bounded sample does not establish
the payload distribution across all retained history.

The same local 50,000-row experiment was repeated with an exact 300-byte JSON
payload per scan. The baseline file was 24,883,200 bytes. SQLite-cache-cleared
reads measured 7.167-10.460 ms before and 2.393-4.919 ms after; warm reads
measured 7.097-9.632 ms before and 2.241-2.829 ms after. Index creation took
14.194 ms and added 638,976 bytes. Scope counts, the full 50-row list digest,
time-index list plan and tied-ID order remained identical. The 8 KiB result
above remains a stress case and is not presented as the typical workload.

All three new scans regression groups failed before the parent DDL edit:
the helper lacked the covering plan, ordinary reopen lacked the index, and
pre-account-column migration lacked the index. The existing HTTP baseline
read and tie-order assertions ran successfully before the upgrade assertion.
The parent now owns adding the tested DDL in `agent/db.js`; this subtask does
not edit that shared file.

## Final focused validation and freeze - 00:58 UTC

After the parent added `idx_scans_scope_coverage` in the existing database
index phase, the complete focused command passed: 28 tests, zero failures,
zero skips. It covered `account-scope.test.js`,
`account-scope-risk-coverage.test.js`, `scans-scope-coverage.test.js` and
`risk-event-scope-index.test.js`. Changed-file ESLint and `git diff --check`
also passed. The npm proxy-configuration warning did not fail lint.

The owned source and tests are frozen. No commit, push, full release gate,
production DDL or deployment was performed by this subtask.

INVARIANTS REPORT: Passed for exact OR-NULL counts, percentages and empty/
unscoped semantics; same-statement risk counts; qualified/predicate/missing-
schema fallback; actual risk/scans HTTP bodies and tied list order; retained
rows, reattribution and deletion; legacy account-column migration; reopen and
WAL/FULL settings. Checks are the 28 focused tests named above. Not Verifiable
for production speedup, cold-storage startup performance and the proportion
of the previous 64-second request delay attributable to these reads. The
scans count remains proportional to retained index entries, with a smaller
read footprint. Full combined-source release validation belongs to the parent.
