# V3 performance and scanner remedies - review and handover

Version 1.2 - 28 September 2026, 01:24 UTC / 09:24 SGT.

Local implementation candidate passed the complete local release gate.
The commit containing this report identifies the candidate. A current executable
scanner configuration package remains blocked by fresh production readbacks. Production application and observed acceptance remain
separate from local implementation evidence.

## Authority and scope

The owner instructed the next planned performance and scanner work. The starting
commit is `f185389`, which already contains the final partial-fill correction
and the narrow risk-event NULL index. Its broker-proof, immutable risk/cost,
manual-ownership and atomic handover checks are recorded in
`v3-verification-followup-2026-09-28.md`; those changes are inherited here.

This increment repairs demonstrated read-query costs, adds missing opt-in
starting-phase profiling and prepares an offline scanner-alignment builder.
It does not authorise publication, merging, Railway deployment, configuration
changes, account selection or broker operations. The owner will conduct
observed acceptance after implementation handover. Missing production evidence
does not invalidate a passed local test, and a local test does not establish
production behaviour.

## Changes and measured evidence

| Change | Behaviour and check |
| --- | --- |
| Risk coverage | The exact unfiltered risk-event path counts account and NULL sets in one SQL statement using existing indexes. Other predicates and tables retain the original aggregate. |
| Scans coverage | A compact `(id, account_id)` covering index avoids reading retained scan payloads. The count still scales with retained index entries. Timestamp-index list ordering is preserved. |
| Phase-audit reads | Two partial indexes retain the original LIKE predicates and account/global inclusion. The combined view merges two disjoint capped families in one statement and preserves descending ID order. |
| Starting profiler | The existing `starting` phase now honours explicit profiling opt-in before its first await. An outer cleanup stops sampling on normal, early-return and exception paths. |
| Scanner proposal builder | An offline script produces exact-name/account remapping, proposal/rollback bytes and review evidence, using the existing registered-account routing helper. It performs no production operation or account selection. |

All timings below are local synthetic file-backed measurements, not Railway
latency or proof of the complete startup cause. Scans experiments reopen the
database, use a 2 MiB SQLite cache and clear that cache between measurements;
the operating-system cache remains warm. The 300-byte payload was calibrated
against a bounded production sample: the newest 25 rows averaged 298.12 text
characters, maximum 333. That sample does not characterise all retained rows.

| Workload | Before | After |
| --- | ---: | ---: |
| Risk coverage, 250,000 rows, repeated warm reads | 11.511-16.720 ms | 0.488-0.887 ms |
| Scans coverage, 50,000 rows, 300-byte payload, SQLite cache cleared | 7.167-10.460 ms | 2.393-4.919 ms |
| Same scans, warm repeats | 7.097-9.632 ms | 2.241-2.829 ms |
| Scans stress case, 50,000 rows, 8,294-byte payload, SQLite cache cleared | 101.968-132.161 ms | 2.778-4.202 ms |
| Phase audit, 250,000 rows, all accounts, three reads per sample | 354.469-378.834 ms | 1.489-3.698 ms |
| Same phase audit, sparse account A | 384.500-415.071 ms | 1.975-2.341 ms |
| Same phase audit, unknown account plus global rows | 405.812-467.236 ms | 2.974-3.429 ms |

The phase-audit numbers use the later machine-readable experiment at
01:00:34 UTC in `v3-phase-audit-benchmark-2026-09-28.json`. The lane progress
record also retains an earlier run with different timings. Both are local
measurements; their variation is not removed. Exact output/row digests match.
Scope experiment details are in `v3-scope-coverage-2026-09-28.progress.md`.

### Additive migration and rollback

There are three new indexes in this increment, after the existing account-column
migrations and inside the recorded index-build phase:

| Index | Contents | Measured initial cost |
| --- | --- | --- |
| `idx_scans_scope_coverage` | Scans `(id, account_id)` | 14.194 ms, 638,976 bytes for the 50,000-row/300-byte fixture; 145.780 ms for the wide stress fixture |
| `idx_action_log_phase_switches` | Audit phase/arm families, `(id, account_id)` | Both phase indexes together: 280.628 ms, 647,168 bytes for 250,000 action-log rows |
| `idx_action_log_phase_controllers` | Audit controller family, `(id, account_id)` | Included in the preceding combined figure |

The inherited `idx_risk_events_unattributed` is a fourth index across the complete
unpublished package, already measured in the earlier report. Its initial build
scans retained risk history once. Initial creation of the three new indexes
also reads retained source tables; actual production migration duration and
space are unverified. Repeated phase-index installation measured 0.006-0.073 ms.

Indexes add maintenance work. In the latest phase fixture, 1,000 rolled-back
inserts measured 2.495-3.012 ms before and 2.660-3.775 ms after; a synthetic ID-based
25,000-row deletion of indexed AUDIT records measured 22.322-27.215 ms before and 37.596-56.055 ms after.
Production retention exempts AUDIT and PHASE_RAW_WRITE records. The separately
measured operational retention predicate was 30.211-34.979 ms
before and 30.816-40.213 ms after. These costs are retained alongside read gains.

Rolling application code back leaves additive SQLite indexes present, including
their write/storage overhead. A code rollback is not a schema rollback. If
index removal is required, present a separately scoped database operation;
do not silently drop indexes or claim deployment rollback removed them.

## Starting-profile operation awaiting approval

The read-only production check at 00:52:55 UTC found
`CPU_PROFILE_PHASES=scan,monitor`. That setting does not arm the new starting
capture. A separately approved Node configuration operation would change it to
`starting,scan,monitor`, with its resulting Node restart. Capture a bounded
diagnostic sample outside the graded market-session window, then restore the
exact prior value `scan,monitor` with its resulting restart. If the value has
changed concurrently, stop and re-scope the operation instead of overwriting it.

No setting has been changed. Existing sampling interval and default-off behaviour
remain unchanged. Profiling adds overhead when enabled. The source correction
provides attribution; it does not establish or repair the whole previously
observed 58,220-ms starting stall or 144,370-ms first loop. A phase label also
includes HTTP/ticker work that runs while the loop awaits other operations.

## Scanner replacement and remaining operational inputs

The earlier 902-profile tick-only proposal left timeframe profiles mismatched.
The replacement design totals **902 profiles** as follows:

| Population | Profiles | Treatment |
| --- | ---: | --- |
| Existing tick cohorts | 106 | Preserve both 53-profile cohorts unchanged |
| Current-feed tick cohorts | 106 | Add 53 profiles per currently observed feed account using exact symbol-name mapping |
| Timeframe cohort | 690 | Replace the old-account cohort with an exact-name remap to the currently selected account; preserve 46 symbols, three strategies and five timeframes |

The selected account, account activation, strategy parameters, profile hashes,
trading authority and broker positions remain unchanged by this design.
`orderAuthority` remains false. Current observations, account-owned maps and
registry revision must be reacquired before producing an executable package.
The authenticated browser session stalled during that acquisition; an older
review snapshot is not substituted for fresh inputs. No new proposal revision,
payload hash or production application is asserted here. The captured account
movement plan is `v3-scanner-alignment-plan-2026-09-28.json`; its expected
revision is deliberately fixed so a concurrent registry change is refused.
It is a builder input, not a registry-write payload.

SPX500, USOIL and UKOIL remain unresolved exact names in the declared universe.
Broker catalogue candidates such as US500 and distinct oil products are not
authorised aliases. The builder reports missing names and mapped names without
profiles separately. Choosing different instruments or expanding the preserved
strategy/timeframe population needs an explicit decision.

Application preflight requires a snapshot and feed/native observations no older
than five minutes, maps with valid nonfuture build timestamps strictly younger
than the existing 24-hour policy, current feed anchors and selected account,
exact registry revision, and sufficient native capacity with no pending work.
Partial map extracts must preserve all names mapping to the relevant IDs so
ambiguity checks remain valid. Payloads must meet the existing 1,024-profile
and 524,288-byte registration limits. Fresh executable bytes remain pending.

The separately approved operation would record the exact current
SCANNER_BRIDGE_ENABLED value, pause the Node observation bridge if needed,
wait for pending native work to drain, freshly recheck these conditions,
compare-and-set the exact replacement registry, then restore the recorded
bridge value. Any resulting Node restarts must be included in that approval.
It does not select an account, alter credentials or restart native services.

Native timeframe rollback needs its own capacity check. The table holds 1,024
cells, and registration does not delete previous native cells. Only idle cells
unoffered for one hour are eligible for eviction. If all 690 old cells remain,
adding 690 replacements can evict 356 old cells. An immediate database-registry
rollback may then lack space while replacement cells are still fresh. The tested
round trip proves exact in-memory database restoration only. After pausing the
bridge, recheck rollback capacity; if insufficient, wait for unwanted cells to
become idle/stale or obtain a separately approved native restart. Do not restart
automatically or call registry restoration complete native recovery.

## Release gate and handover status

| Check | Status at this report |
| --- | --- |
| Coverage/HTTP/index/migration focused checks | Passed: 28 tests, zero failures/skips |
| Phase-audit/trace/HTTP focused checks | Passed: 21 tests, zero failures/skips |
| Starting-profiler/CPU/breaker/book focused checks | Passed: 63 tests, zero failures/skips |
| Scanner proposal and real CLI byte/hash checks | Passed: ten groups, plus five account-model checks; zero failures/skips |
| Native builds | Recorded compiler/source/binary identities in `v3-native-build-identity-2026-09-28.json`; this is build evidence, not production execution |
| Frontend | Passed: 1,311 tests across 136 files |
| Build, full lint, explicit script lint, colour and whitespace | Passed |
| Combined backend and hygiene | Passed: 7,221 tests, zero failures/skips, private temporary directory empty. The earlier routing-inventory failure is corrected and retained in the progress record. |
| Remote CI, publication, deployment and production readback | Pending, separately scoped approval required |
| Fresh executable scanner package and native-capacity preflight | Pending |
| Owner observed acceptance | Pending after implementation handover: natural partial-fill behaviour, browser traces, market-session and economic outcomes |

Six-stage assessment: Intent, Interpretation and Assumptions are established
for this local scope; Invariants have named focused checks; Execution is locally
implemented; local automated Evidence passed. Operational inputs and production evidence remain open.
The final source/test manifest and log digests are recorded in
`v3-performance-scanner-gate-2026-09-28.json`; the source remained unchanged
through the complete final gate. No executable flow-check command was run. Cross-agent review is AI review,
not external independent verification.

INVARIANTS REPORT: Passed locally for exact response/count/order semantics,
account isolation and global inclusion, preserved retained rows, migration and
reopen, WAL/FULL, scoped profiler lifecycle and scanner identity/refusal/byte
checks. Inherited partial-fill risk, proof, ownership and rollback checks remain
documented in the earlier report. Not Verifiable for production latency,
production migration cost, complete startup attribution, current executable
scanner alignment/native recovery and owner-observed outcomes. V3 implementation
handover is not yet complete while these release/configuration steps are open.
