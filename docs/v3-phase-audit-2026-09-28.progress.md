# V3 phase-audit read remedy progress

Version 1 - 28 September 2026

## 28 September 2026 - implementation checkpoint, before source changes

Owner instruction continues the remaining measured startup-performance remedies.
The parent delegated phase-audit reporting only. This is a local implementation;
there is no permission inferred for publication, deployment or production writes.

Source: `agent/services/phase-audit.js` performs descending-id, capped reads of
`action_log` for three fixed LIKE path families. There are no secondary indexes
on that table. `/state/phase-audit` independently reads switches and controllers;
`phaseTraceView` uses the combined recent list. Sparse relevant history under a
large unrelated tail forces full-table backwards scans even with a small LIMIT.
The preceding dated production record attributes 4,517.2 ms of sampled CPU to
these reads; it does not attribute the entire startup delay to them.

Scope: phase-audit source, a leaf index/predicate helper, a new retained-history
regression, this append-only log, and a parent-owned `agent/db.js` migration hook.
Two exact-predicate partial id indexes are proposed. Split reads use each family;
the combined list uses one SQL statement with two independently capped branches,
then descending id and the original overall cap. Thus one SQLite read snapshot
and at most 1,000 candidates are retained for the final combined sort.

Named checks: legacy-response equivalence over account scopes and limit edge
cases; mixed-case LIKE paths; malformed/primitive/array JSON; body-field overrides;
tied timestamps; actual query plans; pre-account-column migration; reopen;
inserts/updates/retention; row digests; WAL/FULL; actual scoped HTTP responses.
Tests are written before source changes. Focused execution and benchmark follow.
Six-stage manual review: intent/interpretation/assumptions/invariants met for the
delegated local remedy; execution underway; evidence open. No runnable flow-check
command is present. Overall V3 completion remains late; this is not acceptance.

## 28 September 2026 00:59 UTC - local remedy frozen

The original new regression failed twice for the intended missing optimisation:
full `SCAN action_log` plans and absent indexes. The test oracle's initial
handling of numeric account id zero was corrected to match the existing explicit
null/empty-string scope rule before relying on those failures. Existing tests
were not edited. The HTTP equivalence check passed before and after the repair.

The implementation adds two partial indexes on `(id, account_id)`, using the
exact original LIKE family predicates. The parent added the leaf migration hook
after `db.exec(INDEXES)` and before the existing `indexes` timing boundary, after
the nullable account-column migration. The report references the same literal
predicates. Combined recent output uses one SQL statement, two disjoint capped
branches and the original final id ordering before JSON shaping.

An id-only first candidate reduced unrelated-history scanning but still loaded
foreign-account payload rows. A bytecode assertion reproduced that limitation
before the index gained account_id. The final bytecode check proves the account
filter/output reads that field from the narrow index, not the payload table.
This refinement leaves unique-id ordering and response contents unchanged.

Focused gate: `node --test agent/services/phase-audit-history-read.test.js
agent/services/phase-audit.test.js agent/services/phase-trace.test.js
agent/routes/state-phase-audit.test.js` passed 21 tests, zero failures/skips.
Changed-file ESLint and `git diff --check` passed. Full combined release gates
remain the parent's responsibility after all parallel source edits are frozen.

Final file-backed benchmark at 00:58:43 UTC used 250,000 rows with approximately
1.8 KB JSON bodies, 50,000 earlier relevant audits, 200,000 newer unrelated rows,
tied timestamps and deliberately skewed account membership. Each sample reads
the two split lists and the combined recent list, cap 100. Five repeated local
measurements gave:

| Scope / operation | Original | Final indexes / queries |
| --- | --- | --- |
| All-account three reads | 356.554-622.933 ms | 2.024-2.299 ms |
| Sparse account A three reads | 398.432-504.585 ms | 1.738-2.777 ms |
| Unknown account, global rows only | 434.299-625.498 ms | 3.325-3.848 ms |
| 1,000 mixed inserts, rolled back | 2.508-2.873 ms | 2.656-4.722 ms |
| 25,000 retained rows deleted, rolled back | 29.117-39.410 ms | 41.110-54.061 ms |

Initial creation of both indexes took 354.305 ms and allocated 647,168 bytes.
Repeated idempotent installation took 0.006-0.076 ms. Row digests before and
after matched exactly; both indexed and unindexed integrity checks returned
`ok`. The raw measurements and reproducible local script were given to the
parent for the release evidence package. Timing variability is retained; this
synthetic local fixture is not a production latency claim.

INVARIANTS REPORT: Passed locally - exact output content, account isolation and
global inclusion, original LIKE/case behaviour, tied timestamp/id order, bounds,
malformed and unusual JSON shaping, single-statement combined snapshot, pre-column
migration, reopen, writes/retention semantics, retained row digest, WAL/FULL and
SQLite integrity. Not Verifiable here - actual deployed latency and one-time
migration duration at production history size. The indexes add measured write
and retention work. Scope-rejected rows still require walking their narrow audit
family index; this is not constant-time work for every possible account skew.
The measured phase-audit cost is addressed, not the whole 58-second startup stall
or 144-second first loop. No production operation, commit or publication occurred.

## 28 September 2026 01:01 UTC - retention-policy clarification and handover

Source inspection of `retention.js` confirms production housekeeping exempts
AUDIT and PHASE_RAW_WRITE forever. The preceding generic 25,000-row deletion
measurement deliberately removes indexed audit rows as a stress case; it is not
the production pruning policy. The actual operational predicate was therefore
measured separately, over 25,000 eligible unrelated rows in a bounded id range,
with the exact original date/method exclusions. This fixture uses a single
rollback transaction; production cooperative pruning yields every 200-row window.

The 01:00:34 UTC expanded benchmark again preserved the row digest and indexed
integrity. Actual-policy 25,000-row pruning/rollback measured 30.211-34.979 ms
without the indexes and 30.816-40.213 ms with them. Indexed-row deletion stress
was 22.322-27.215 ms without and 37.596-56.055 ms with the indexes. The three
report reads measured 354.469-378.834 ms to 1.489-3.698 ms for all accounts,
384.500-415.071 ms to 1.975-2.341 ms for sparse account A, and
405.812-467.236 ms to 2.974-3.429 ms for unknown/global-only scope. Index creation
took 280.628 ms, again 647,168 bytes; repeated installation was 0.006-0.073 ms.
Mixed 1,000 inserts/rollback measured 2.495-3.012 ms without and 2.660-3.775 ms
with the indexes. These later measurements are a second run, not replacements
for the earlier retained timing evidence.

The existing retention suite also passed all 18 tests, including perpetual audit
retention and cooperative pruning. Total focused evidence is 21 report/migration
tests plus 18 retention tests, zero failures/skips. Source remains frozen; raw
expanded benchmark JSON and its script were passed to the parent for persistence
with the release package. No further source change is needed for this subtask.
