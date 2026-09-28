# V3 performance and scanner remedies

Version 1.0 - 28 September 2026. Append-only execution record.

## 00:56 UTC / 08:56 SGT - implementation continuation

The owner ordered the next prescribed work: finish the remaining performance
and scanner remedies. This continues the approved V3 intent from local
f185389; it does not authorise a new push, deployment, account selection,
production registry/variable change or broker operation. The owner will run
observed acceptance after implementation handover. Engineering tests and
release verification remain the implementation responsibility.

Stage 1 Intent and stage 2 Interpretation: complete the remaining demonstrated
reporting bottlenecks and prepare exact scanner alignment without changing
trading authority. Stage 3 Assumptions: no instrument alias or account switch
is assumed safe. Stage 4 Invariants: preserve exact response contents/order,
account isolation, historical records, risk/proposal/TP1 ownership, scanner
strategy/hash/TTL and orderAuthority=false. Each correction needs a red
regression, output parity, bounded benchmark and review. Stage 5 Execution:
active. Stage 6 Evidence: open until the combined source passes its gates.

Work ownership and scope:

- Account coverage: agent/lib/account-scope.js and targeted coverage/index
  tests; risk_events uses existing disjoint indexes where semantics match.
  A proposed scans(id,account_id) covering index needs actual route ordering,
  migration, retention and file-backed benchmarks before adoption.
- Phase audit: agent/services/phase-audit.js, a leaf index/predicate module,
  focused tests, and the additive migration hook in agent/db.js. The new
  index/schema checks failed before source edits. Root added the hook after
  the nullable account-column migration; agent's focused verification follows.
- Startup diagnostics: agent/loop.js and focused lifecycle tests. The existing
  first starting phase never arms the profiler. Repair must remain opt-in and
  stop the profiler on normal, early-return and exception paths.
- Scanner: an offline proposal builder, tests and a private exact snapshot /
  proposal / rollback package. No production caller is added. A replacement
  timeframe registry follows the selected account through exact symbol names;
  old tick profiles and all strategy parameters remain preserved. Native cell
  capacity must be checked before any proposed application.
- Corresponding append-only lane progress records and this root record.

Fresh read-only production evidence at 00:52:55Z: CPU_PROFILE_PHASES is
scan,monitor, so a starting-phase trace would require a separately approved
opt-in configuration change. Exact broker maps contain US500 and several
distinct spot/future/perpetual oil instruments. SPX500/USOIL/UKOIL remain absent;
no replacement is inferred from a similar name. At 00:54:58Z EXPLAIN confirms
the scoped scans count performs SCAN scans. A bounded sample of the newest
25 rows has thesis/desk_note/session_fit text averaging 298.12 characters,
maximum 333. No full-history count was executed on production.

Historical first-loop logs show the equity seed finished in about two seconds,
then the scans request began near the freeze onset. This supports investigating
scans coverage; it is not a sampled causal attribution of the 58,220-ms stall.
The existing scan-phase CPU profile cannot explain an unprofiled starting phase.

Timeline: V3 closure remains late. Next: finish lane tests/benchmarks, inspect
fresh scanner state and exact broker metadata, review the combined changes,
run the full gate including available native paths, and save a reviewable
candidate. No production mutation has occurred. No runnable flow-check command
exists in this checkout; the stage assessment above is manual.

## 01:16 UTC / 09:16 SGT - review and combined-gate checkpoint

All implementation lanes are frozen. Cross-agent source review found no
query/profiler regression. Scanner review identified and corrected three
specific issues before handover: account-map freshness, explicit distinction
between exact registry rollback and native-cell recovery, and a one-byte
payload/hash discrepancy. Actual CLI payload bytes now match recorded SHA256
and byte counts. Native rollback needs a fresh capacity check after bridge
pause, with an idle/stale wait or separately approved restart if necessary.

The initial complete backend gate returned exit 1: 7,219 passed, one failed,
zero skipped. The sole failure was the account-model routing inventory for
the new offline script. It now obtains hosts from registeredCalendarAccounts
on its real in-memory database. The exact three-token allowance covers only
snapshot routing-column validation and account-row import, with an explicit
reason. The scanner, exact-count assertions and policy prohibitions remain
unchanged. Both-host malformed-flag/foreign-host regressions pass. The focused
post-fix result is 15 passed. A full backend rerun is now running against a
recorded manifest of all twelve changed/new source and test files.

Frontend: 1,311 tests across 136 files passed; build, lint, colour and
whitespace checks passed. Final source lint is rerunning after the routing
fix. Three unchanged native production binaries built using existing
Makefiles and g++ 13.3.0, without dependency installs. All four previously
skipped native-dependent checks passed; the full initial backend run also
had zero skips. Native identity and phase-audit benchmark JSON are saved
beside the review report. Existing build-size and C++ initialiser warnings
are retained, not promoted to failures or hidden.

Read-only GitHub/Railway checks at 01:13 UTC retained main 41aa2cb and the
same six successful deployments. The Node console/browser service then
returned two 300-second tool timeouts, including a connection-only probe.
This establishes an access limitation, not a production application outage.
The partial map-read operation did not yield a complete fresh snapshot.
Old map timestamps are not refreshed or substituted. Therefore no new
executable current scanner payload/revision is claimed. The exact account
movement plan is saved as v3-scanner-alignment-plan-2026-09-28.json; it is
input to the guarded builder, not a production write payload.

Source inspection confirms the ordinary independent-watchdog cache omits
timeframe cell inventory. The full native watchdog contract or the verifier's
retained service contract with valid receipt timestamps is required for
capacity evidence. Cached broker long names lack account/host/ID provenance
and cannot authorise aliases for SPX500, USOIL or UKOIL. These readbacks and
the separately scoped production changes remain outstanding. No push,
deployment, registry/variable/account change or broker action occurred.

## 01:24 UTC / 09:24 SGT - final local evidence and handover

Stage 6 local automated Evidence passed. The frozen-source backend command
node scripts/run-agent-tests.mjs returned exit 0: 7,221 tests passed, zero
failures, cancellations, skips or todos. The isolated latency group passed
30 checks, hygiene passed six, and the remaining group passed 7,185. The
runner's private temporary directory was empty after completion. All twelve
source/test hashes matched the manifest taken before the final run. The first
failed gate remains recorded above; it is not counted as a successful run.

Frontend 1,311/136 files, build, full lint, explicit .mjs lint, colour and
whitespace checks passed. Source inspection of the final scanner delta found
no new concrete defect; this is AI source review, not independent production
acceptance. The machine-readable gate record contains commands, counts,
source hashes and log digests. Native build identities and four real native
checks are included. No further optional test expansion is required locally.

INVARIANTS REPORT: Passed locally for response/count/order equivalence,
account/global scope, retained rows, account-column migration, reopen and
WAL/FULL; starting-profiler opt-in/cleanup; scanner exact-name/host/account
identity, stale-map refusal, shared routing, bounds, CAS/bridge guards,
registry-only round trip and actual payload bytes. The complete gate also
covers the inherited f185389 later-partial-fill proof, atomic handover and
risk constraints. Not Verifiable here: production migration cost or latency,
the complete first-loop cause, current scanner payload/native recovery and
the owner's later observed acceptance. Those are separate operational gates,
not a claim that V3 is production-complete. The six-stage assessment is manual;
no runnable flow-check command is present.

Next: save this verified local candidate, obtain the scoped publication
approval required by the uploaded CLAUDE.md, then run remote CI/review.
Separately, regain authenticated read access and reacquire maps, feed anchors,
registry identity and native capacity before producing exact current scanner
payload/rollback bytes for an approved configuration operation. Do not bypass
freshness with the older snapshot. No account selection or instrument alias
is included. Timeline remains late. Original checkout documentation edits
remain intact. No new push, merge, deployment, production change or broker
operation occurred in this increment.
