# Revision 3 continuation - implementation evidence

Read the latest dated checkpoint at the end for current status. Earlier
tables and observations are historical snapshots, not continuing runtime claims.

Working authority: [revision 3](performance-cards-reassessment-2026-09-22-revision-3.md)
and `CLAUDE.md`. Reconciled on 22 September 2026, 14:30 SGT.

## Repository reconciliation

At the initial reconciliation GitHub main was `7bf5bd1699b02422ab74588b7a62025e7a8edb10` (#1007).
All 159 remote branches and the latest 30 PRs were inspected; the separate open-PR
query returned none. #985, #992-#1001, #1003, #1005, #1006 and #1007 are merged.
P1 and the P2a/P2b packages are reused, not rebuilt. These PRs do not complete
their entire parent priorities.

The old local `fix/account-balance-edit` worktree was clean at `b02b600` but had
no remote branch or PR. Its single unfinished change was recovered onto current
main as `codex/rev3-account-edit-20260922`. The remote
`work/rev3-workspace-export-20260922` branch (`a38c3fd`) contains only a development
dependency-export workflow, not another implementation. Earlier protection and
account work branches correspond to merged PRs; their different squash SHAs are
not outstanding features. Original worktrees and branches were preserved.

## State by package

| Package | Implemented | Tested | Merged | Deployed | Runtime-verified / next dependency |
|---|---|---|---|---|---|
| P1 protection request reserve | Yes, #1003 | Recorded local/CI gate | `1e81cc3785f362bb1449461093108411aaba365e` | Included in current deployment | Ordinary-read saturation acceptance still pending |
| P2a snapshot read model | Yes, #1006 | Recorded local/CI gate | `3a942d0b38d56dd1726d08f1d5f2d4a6376e82bf` | Included in current deployment | Authenticated account switching pending |
| P2b margin and permit inputs | Yes, #1007 | Recorded local/CI gate | `7bf5bd1699b02422ab74588b7a62025e7a8edb10` | Railway reports all four services successful on this SHA | Behavioural runtime acceptance pending |
| P2 account-edit routing | Recovered and reviewed on continuation branch | 5,205 Node tests pass, one existing skip; 900 Vitest tests pass; ESLint, build and no-green pass | No | No | Local browser blocked; authenticated runtime acceptance pending |
| P2c feed/calendar identity | Next scoped package | Pending | No | No | Existing calendar is symbol-name keyed, omits holidays and silently treats malformed/missing schedules as open |
| P3 target policy | Incomplete | Existing mandatory TP1 tests retained | Prior guard fixes only | Prior fixes only | Momentum null-target semantics and position-specific repairs remain unresolved; do not invent target prices |
| P4 ownership and management | Partial, prior protection fixes retained | Prior regression tests retained | Prior fixes only | Prior fixes only | Fresh quote/configuration/writer contracts, latency limits and scoped activation evidence pending |
| P5a watchdog / Controllers | Partial existing observations | Independent outbound alert acceptance absent | Prior observation fixes only | Prior fixes only | P2c calendar, completed-work contract and independent delivery required |
| P5b reporting | Incomplete | No new claim | No new package | No new package | Activity populations, account accounting and blocker attribution remain |
| P5c scanners | Planned | No parity/load acceptance | No | No | Feed/admission contracts, P4 acceptance and P5a supervision precede activation |
| P5d history | Partial existing snapshots/events | No new claim | Prior work only | Prior work only | Cashflow-aware records and retention remain |
| P6 research | #985 and follow-ups implemented | Current production-input validation pending | Prior work merged | Included in current deployment | Need attributable production replay inputs and matching profile hashes |
| P7 / P8 | Pending | No promotion/capacity evidence | No new change | No new change | P3/P6 evidence, safety and load gates; no threshold or universe changes |

## Fresh P0 observation and invariants

Read-only Railway retrieval returned the independent broker audit checked at
14:24:46-48 SGT, relayed by Node at 14:25:12 SGT. It reports 39 open positions
across seven accounts: zero missing SL and two missing TP1, one each on demo
suffixes 9908 and 0949. The other demo suffixes 7342 and 0058 have 7 and 8 open
positions; 9908 and 0949 have 9 and 14. Live suffix 3489 has one, 2148 and 9009
have zero. This is dated account-level evidence, not a fresh position-level
amendment proposal. No broker action was taken. The intended 5-demo/1-live roster
is still unreconciled against 4-demo/3-live connections.

| Invariant | Result | Evidence / limit |
|---|---|---|
| Numerical risk and validation limits preserved | Passed | No risk/strategy configuration edits |
| Mandatory TP1 guard preserved | Passed | No entry/protection guard edits; full agent suite passes |
| Broker TP1 coverage | Failed at dated observation | Two exceptions remain; current position-level resolution unverified |
| Manual ownership and account routing preserved | Passed for code | No ownership, credentials, mode or broker-writer changes |
| Account-edit isolation and atomic validation | Passed | HTTP tests cover explicit account, unrelated/global keys, zero, clear, currency and invalid mixed-field requests |
| Authenticated UI / runtime acceptance | Not Verifiable | Production browser is disconnected; local preview blocked by browser policy |
| No unapproved deployment or activation | Passed | No production mutations made by this continuation |

## Capability and release boundary

Local Git worktrees, editing, Node 24.19.0, native SQLite, ESLint, Vitest, Vite,
g++, make and OpenSSL headers work. The verifier C++ test suite passed.
CI uses Node 22, so PR CI remains part of the gate. The Node suite was run in UTC
with four concurrent files (all files included). Vitest's existing watchlist
date test fails in the host's non-UTC timezone and passes under UTC, as in CI;
no test was disabled. Native Git fetch failed with HTTP 502; GitHub connector
reads and repository publication are the available transport. No `gh` CLI.

The local preview starts on 127.0.0.1; the connected browser rejects that URL
with `ERR_BLOCKED_BY_CLIENT`. A wildcard-host Vite preview also encountered the
environment's `uv_interface_addresses` restriction. No local browser executable
or agent-browser CLI is installed. The connected production browser shows
"Agent not connected"; no credentials were changed or extracted for a browser.

Railway configuration reads show all four production services following `main`,
with `checkSuites: false` and no watch filters returned. Deployment history proves
that #1005 (documentation only), #1006 and #1007 each triggered deployments of
all four services. Therefore a new merge cannot be described as deployment-free.
Revision 3 section 18 requires a controlled gateway restart, scoped preflight and
resumption evidence. Keep implementation on review branches until that rollout
boundary is resolved. Do not disable deployment settings or change credentials
to get around it. This does not block unrelated local correctness work or PR CI.

Rollback owner: repository owner, Adrian Ang. Before rollout, preserve each
reviewed branch/PR and the current deployed SHA. A code revert is itself subject
to the deployment boundary; no automated live rollback or account action is
authorised by this record.

## Continuation checkpoint - 22 September 2026, 15:02 SGT

The owner (`ang-kl`) marked #1008 ready at 14:40:10 SGT and merged it at
14:40:15 SGT. Current main is `f06030f9ebb1fb11a64bdb06709577d6d522d8d2`.
Both PR checks passed. Railway reports successful deployments of all four
services from this SHA between 14:41:10 and 14:41:33 SGT. No deployment or
account mutation was requested by this continuation. Authenticated UI and
management-latency acceptance remain unverified.

| Reviewable change | Implemented | Tested | Merged | Deployed | Runtime verified |
|---|---|---|---|---|---|
| Account-edit recovery, [#1008](https://github.com/ang-kl/bot-trade/pull/1008) | Yes | Local gate + PR CI | Owner merged, `f06030f` | Railway reports success, all four services | No authenticated UI acceptance; subsequent review found the race below |
| Per-field account saves, [#1009](https://github.com/ang-kl/bot-trade/pull/1009) | Yes; prevents overwriting an untouched broker-refreshed value | 5,206 Node + 904 Vitest passes, one existing Node skip; full local gate + PR CI green | No at checkpoint | No | No |
| Identified calendar evidence, [#1010](https://github.com/ang-kl/bot-trade/pull/1010) | First P2c slice; advisory capture/read model | 5,217 Node + 900 Vitest passes, one existing Node skip; full local gate + PR CI green | No at checkpoint | No | No; all-account coverage/real broker fixtures remain |
| Hourly opening population, accompanying change | First P5b slice; all confirmed ledger rows | 5,212 Node + 905 Vitest passes, one existing Node skip; full local gate | No | No | No |

Detailed evidence and scope: `account-edit-delta-2026-09-22.md` on #1009,
`market-calendar-contract-2026-09-22.md` on #1010, and
[hourly-opening-population-2026-09-22.md](hourly-opening-population-2026-09-22.md).
The new branch trees were compared with the tested local trees before publication.
Native Git transport remains unavailable; authenticated GitHub publication works.

Fresh protection read after the owner's merge: broker checks at 14:49:39-40 SGT,
relayed at 14:49:49 SGT, still show 39 positions, zero missing SL and two missing
TP1 (demo suffixes 9908 and 0949). This is dated evidence, not a continuing
coverage guarantee. Node logs name ETHUSD and XRPUSD respectively, but no
position-specific target proposal or approved amendment is established.

Remaining dependency boundaries are unchanged: intended-versus-connected roster,
currency/leverage provenance, P3 target policy, P4 quote/configuration freshness
and writer/latency acceptance, then independent watchdog delivery and scanner
activation. These do not prohibit separate reporting/contract implementation.
The main-triggered four-service deployment remains a release boundary, not a
reason to claim unmerged code is deployed. No blanket activation approval is
inferred from the owner's individual #1008 merge.

## Main advanced - 22 September 2026, 15:16 SGT

GitHub records `ang-kl` merging #1009 at 15:10:33 SGT into
`8c0a54aafbf247a9314347f6ff7f3afbc26f547e`, then #1010 at 15:10:47 SGT into
`4dbdc82996b97a7ace526c5e0dade7b4ff5d4c69`. Both had green PR CI. Railway reports
all four services successful on the latter SHA. Neither authenticated account
save acceptance nor real calendar/management acceptance is thereby established.

The accompanying hourly change is [#1011](https://github.com/ang-kl/bot-trade/pull/1011).
Its original CI passed. Imports and generated inventory were reconciled against
the new main; the updated local gate is 5,225 Node passes, one existing skip,
and 909 Vitest passes, plus ESLint/build/no-green/syntax checks. Updated-head CI
is required. It remains unmerged/undeployed at this checkpoint.

P2 leverage isolation is being prepared separately: account-owned scalar input
or the existing labelled 1:100 assumption, never another account's global
leverage. Calendar malformed-identity handling has also been reproduced and is
being corrected separately. Neither is claimed complete by the earlier table.

## Continuation checkpoint - 22 September 2026, 16:10 SGT

Current inspected main is `39fd687d0feb6a9b5614cee093dfc3aaedabd71c`.
The earlier 159-branch reconciliation stands: old squash ancestors are not
outstanding features. Subsequent work used separate branches/PRs and the full
repository gate; no new repository, harness or architecture was substituted.

| Change | Implementation and tests | Merge evidence | Deployment | Runtime acceptance |
|---|---|---|---|---|
| #1008 account-edit recovery | Full local/PR gate; review race followed up in #1009 | `f06030f9ebb1fb11a64bdb06709577d6d522d8d2` | Included in observed main | Authenticated UI not verified |
| #1009 submit only edited fields | Full local/PR gate; concurrent broker refresh regression | `8c0a54aafbf247a9314347f6ff7f3afbc26f547e` | Included | Authenticated UI not verified |
| #1010 identified calendar evidence | Full local/PR gate; advisory model, legacy trading calendar unchanged | `4dbdc82996b97a7ace526c5e0dade7b4ff5d4c69` | Included | Real broker fixtures/all-account coverage not verified |
| #1011 all recorded hourly openings | Full local/PR gate; all confirmed ledger rows, exact 24 windows | `d2a660c8e5b1ea8b1697f58d3c5a857c89af6bbb` | Included | Authenticated UI/population reconciliation not verified |
| #1012 leverage isolation | Full local/PR gate; unchanged 1:100 assumption explicitly unverified | `f7255df9f77e925462fa23b4b2f14bc34de417b9` | Included | Broker leverage provenance remains unresolved |
| #1013 calendar malformed-input follow-up | 5,232 Node + 909 Vitest passes, one existing skip; full local/PR gate | `90ef5597bd298bb69768e067c03e7f8811b08ca5` at 15:55:40 SGT | Included | Advisory contract only; bounded formatter cache does not cache status |
| #1014 hourly provenance/clock follow-up | 5,233 Node + 911 Vitest passes, one existing skip; full local/PR gate | `39fd687d0feb6a9b5614cee093dfc3aaedabd71c` at 15:56:26 SGT | Railway reports all four services SUCCESS at this SHA, read 16:00 SGT | Incomplete future window explicitly marked; live UI not verified |
| #1015 selected-balance isolation | 5,233 Node + 909 Vitest passes on f7255df, one existing skip; full local gate; PR CI green after rebase onto 39fd687 | Open draft at checkpoint | No claim | No claim |
| #1016 tamper account/position lookup | 5,238 Node + 911 Vitest passes, one existing skip; full local/PR gate | Open draft | No | No |
| #1017 P&L alert account isolation | 5,237 Node + 911 Vitest passes, one existing skip; full local gate; PR CI pending | Open draft | No | No; test message sinks only |

Merged PRs were recorded as merged by `ang-kl`. This continuation did not call
merge/deploy tools or alter Railway configuration. The actual four-service
auto-deployment coupling still applies, including to documentation-only merges.
An owner's individual merge is not blanket approval for subsequent gateway
restarts, account amendments, mode activation or credential changes.

The #1010 review's suggested holiday unit change was checked against official
Spotware sources: `holidayDate` is epoch days. The implementation retains that
contract. The two valid #1011 findings were corrected in #1014 and replied to.

### Broker evidence and remaining exceptions

Last protection evidence at this checkpoint was checked **16:03:06-08 SGT** and
relayed at 16:03:36 SGT. All seven account reads succeeded: 39 positions, zero
missing SL, two missing TP1 on demo suffixes 9908 and 0949. These checks follow the
15:56 main deployment; they verify that audit reads resumed, not writer ownership,
management latency, authenticated UI correctness or continuous broker coverage.
Live suffixes 3489/2148/9009 held 1/0/0 positions; demo 7342/0058/9908/0949 held
7/8/9/14. Intended 5-demo/1-live versus connected 4-demo/3-live is unreconciled.
The exact intended roster cannot be inferred from empty balances or position counts.

No position-specific approved target price or fresh ownership/amendment proposal
has been established for the two TP1 exceptions. Existing valid stops remain
untouched. Read-only account summaries do not supply the evidence needed to
authorise a particular live action or claim continuous protection coverage.

### Exact remaining boundaries and next work

1. **P2 money contract:** native deposit-currency values still reach USD-named
   balance/P&L/history fields. Balance producers include boot, the primary loop,
   account selection, account-equity and nightly snapshots. Clearing them alone
   can remove percentage-based protection caps. Define consistent amount/currency
   and conversion evidence, plus explicit missing/stale-data behaviour for both
   new entries and existing positions. A fail-open/fail-closed policy change
   needs review under plan section 11; changing numerical limits is not a repair.
2. **P2c coverage:** capture currently observes existing symbol-detail requests.
   It is not an exhaustive intended-account/instrument refresh. Complete the
   intended roster, account/feed instrument map, source-event/receipt distinction,
   gaps/reconnect and broker fixture acceptance before consuming it as an entry
   or protection gate. Unknown remains unknown; no fictional market-open state.
3. **P3:** agree mandatory broker TP1 versus managed partial TP1/optional TP2
   semantics for momentum and existing positions. Null-target proposals stay
   blocked. Prepare position-specific repairs from fresh evidence; do not invent
   target prices or lift upstream caps to make reporting look active.
4. **P4:** the tamper identity correction is not the complete single-writer
   contract. Fresh quote/configuration/feed checks, reversal no-read behaviour,
   ownership transfer, broker read-back, fair/coalesced scheduling and completed
   work evidence remain. Protection latency/age limits and scoped runtime flags
   need the recorded policy/operational evidence before activation acceptance.
5. **P5a/P5c:** independent watchdog delivery, verifier-outage observation,
   six Controllers groups with all 34 children/eight profiles, and scanner
   extraction remain. Implement from shared contracts, test outages/parity/load,
   and retain the existing order path until ownership transfer is proven.
6. **P5b/P5d:** opening populations are corrected; closed P&L/detail populations
   still use the capped journal and say so. Cashflow-aware balances, complete
   close populations, first-blocker attribution and useful retained history
   remain separate authorised work. Do not call them completed or blanket-blocked.
7. **P6/maintenance:** reuse #985 and its corrections. Production replay inputs,
   profile hashes, storage contents/checkpoints and authenticated runtime state
   are not accessible in this executor. Empty/synthetic inputs cannot substitute
   for attributable production validation. P7/P8 promotion/capacity gates stay.

Unresolved policy or runtime access constrains the affected step. It does not
revoke authorised branch implementation, read-only profiling or corrective work.
The next developer should start from current main/open PRs, finish outstanding
reviews, then take the next contract/reporting slice in dependency order.

### Capabilities and verification limits

Editing, local Git worktrees, connector publication, local HTTP regression tests,
native SQLite, Node/ESLint/Vitest/Vite and the C++ verifier toolchain work. Native
GitHub fetch returns HTTP 502 and `gh` is absent; the GitHub connector provides
the available repository transport. Node is 24.19 locally versus 22 in PR CI.
All tested files were included. UTC matches CI. Existing timing-sensitive Node
checks occasionally fail on this host; complete serial reruns passed without
relaxing the 100-ms check, disabling tests or changing any trading threshold.

Authenticated visual acceptance remains unavailable: the production browser says
"Agent not connected", localhost is blocked by browser policy, no local Chromium
is installed, and wildcard Vite binding hits `uv_interface_addresses`. No secret
was extracted or changed to work around this. Railway metadata/log reads work;
production shell/filesystem access and authenticated state/actions access are
not available. Tests are not a substitute for those acceptance observations.

### Read-only resource checkpoint

Railway metrics read at approximately 16:10 SGT cover the previous 24 hours,
sampled every 300 seconds (289 samples per measurement). Units below are the
tool's reported GB. These span deployments and cannot establish short-duration
peaks, a protection deadline or a filesystem quota.

| Service | Memory current / maximum GB | Disk current GB | Disk sampled minimum / maximum GB |
|---|---:|---:|---:|
| bot-trade | 2.067 / 5.715 | 3.855 | 3.779 / 3.885 |
| cpp-exec | 0.022 / 0.072 | 2.010 | 1.864 / 2.010 |
| cpp-acct | 0.021 / 0.074 | 0 | 0 / 0 |
| cpp-verify | 0.004 / 0.022 | 0.793 | 0.792 / 0.793 |

Reported memory limit was 24 GB for each service. The zero disk series for
cpp-acct is a metric observation, not proof of empty storage or recorder
persistence. Current disk use near the sampled maximum on cpp-exec/verify
does not establish remaining capacity; quota, mount durability, segment/WAL/log
breakdown, retention and restart-recovery acceptance still need runtime evidence.
No storage deletion, volume/configuration mutation or process restart was made.

Rollback owner remains Adrian Ang. Preserve each PR and deployment SHA. A revert
also deploys all four services and requires the controlled scope/preflight in
[the prepared rollout runbook](controlled-rollout-preparation-2026-09-22.md).

## Continuation to P5 - 22 September 2026, 17:34 SGT

Owner instruction: continue the scope described in reply 8,395B paragraph 1
through P5 Reporting/history. Main is `e8b9cd98180bc965493469c1c2f553499de2025c`;
#1015, #1016, #1017 and #1018 have all merged. No open PRs were returned at
this continuation's reconciliation. The earlier 16:10/16:19 status is historical.
Railway previously reported all four services successful on this SHA; that is
not authenticated account, scanner or management acceptance.

Fresh P0 broker checks at 17:19:11-12 SGT, relayed 17:19:27, report 39 positions,
zero missing SL and two missing TP1 (demo suffixes 9908/0949). The intended
roster and position-specific target policy remain unresolved. No broker action
was taken.

P2 native-money evidence is implemented on the continuation branch. The full
local gate passed: 5,247 Node tests, one existing skip; 911 Vitest tests;
ESLint with zero warnings, production build, no-green and syntax checks.
See [the currency contract](account-money-evidence-2026-09-22.md). This adds
account/host/deposit-asset/receipt/currency evidence without a new broker read.
It does not complete the risk-input currency migration: the legacy scalar's
missing-conversion and loss-cap policy still needs explicit review.

At this checkpoint: implemented and locally tested; PR CI/publication pending;
not merged, not deployed and not runtime verified. Subsequent PR metadata or a
later checkpoint supersedes those states. Work continues on P4 monitor account
routing and actual completion evidence, then P5 Controllers/watchdog/scanners
and accounting/history. The full scope is not declared complete.


## Continuation checkpoint — 22 September 2026, 19:15 SGT

Scope remains the approved implementation through P5. Current main was read
back at 19:11 SGT as `e8b9cd98180bc965493469c1c2f553499de2025c`.
The following are separate draft review packages, **not merged or deployed**:

| Package | PR / dependency | Implemented and tested evidence |
| --- | --- | --- |
| P2 native account money | #1019, main | Currency/asset/account identity and freshness evidence; full local repository gate and PR test/review checks passed. Legacy risk consumers are not changed by this package. |
| P4 monitor work | #1020, main | Account/host scoped fallback quotes and completed per-position receipts; full local gate and PR checks passed. Exclusive writer/config freshness and latency acceptance remain open. |
| P5 Controllers | #1021, main | Six groups, retired history and actual completion evidence; full local gate and PR checks passed. Authenticated visual acceptance remains unavailable. |
| P5 activity | #1022, main | Full-ledger hourly opening/closing populations and currency-aware recorded P&L; full local gate and PR checks passed. Other capped performance panels remain separate work. |
| P5 account history | #1023, based on #1019 | Retained snapshots, native currencies, independently identified cashflows and bounded history API/UI; 5,254 Node tests passed (one skip), 912 Vitest tests passed, remaining local gate passed. PR test/review checks passed, read back at 19:10 SGT. |
| P5 independent watchdog | Current branch | Independent bounded probes, incident/outbox persistence, outbound-only Telegram implementation, canonical policy/ownership handoff contract, shared broker-calendar intervals and Controllers read model. Local C++ gate passed after recovery; final Node/UI gate running at this checkpoint. |
| P5 scanner extraction | Local work branch | Both new service binaries compile. Tick service reuses existing strategy/workers. Timeframe service currently covers only baseline closed-bar Fibonacci; full strategy parity, feed producers, Node comparison/admission boundary and runtime acceptance are outstanding. No ownership activation. |

The previous scratch Git metadata and shared dependency directory expired at
approximately 18:55 SGT. Source files survived. Recovery verified all 1,440
base blobs/tree against GitHub and reconstructed the exact five published
commits; no source work was discarded. Native SQLite was rebuilt successfully
against the actual Node 24 headers. The interrupted test run failed from
missing packages and is **not a passing gate**; the complete gate is rerunning.

The watchdog uses separate process and completed-work evidence; an idle
quote-driven scanner is not considered stalled, but its feed-age check remains
independent. A configured account without its first completed broker audit is
unknown. Missing/stale calendars cannot clear prior faults. Node retains alert
ownership by default; generic duplicate alerts transfer only under the explicit
handoff declaration, with manual approval buttons retained. No notifications,
credentials, settings, broker amendments, deployments or ownership handoffs
were performed. See `independent-watchdog-2026-09-22.md` for the contract and
remaining producer/rollout acceptance.

A main merge still automatically deploys all four existing Railway services.
The controlled restart/rollout boundary in revision 3 section 18 therefore
continues to apply despite green PR checks. Publishing reviewable branches does
not satisfy deployment or runtime verification. The external verifier-outage
observer is unselected/unprovisioned; authenticated visual/runtime acceptance,
P2 risk evidence policy, P3 momentum TP1 semantics and applicable P4 policy
limits remain precise open items, not reasons to stop unrelated implementation.
The 17:19 SGT broker audit is historical, not a current protection guarantee.

### Watchdog gate completion — 19:27 SGT

The recovered Node 24/better-sqlite3 combination crashed during native environment
cleanup; that run is not accepted. Local tooling was aligned with repository
CI's Node 22 (22.23.2), without changing dependency locks or application code to
hide the failure. On that runtime the complete watchdog branch gate passed:
**5,251 Node tests passed, one skipped, none failed**; **911 Vitest tests passed**;
ESLint zero warnings, production build, no-green and required syntax checks
passed. The C++ verifier binary and complete unit suite passed, including new
work/unknown-account cases. CI now explicitly installs the required libcurl
headers. This is local implementation/test evidence only; PR CI, merge,
deployment and runtime acceptance remain separate states.

## Shared scanner services — 22 September 2026, 19:38 SGT

Both new C++ services are implemented as independently buildable mirror-only
executables with bounded input/work/output, scoped feed identity, explicit
profile/version/expiry and completed-work receipts. `cpp-scan-tick` preserves
the existing incremental strategy and workers byte-for-byte and matches the
frozen JavaScript oracle with 1/2/4 workers. Tests also cover account/host
collisions, retries, restart-stable candidate IDs, gaps, warm-up, stale expiry
and bounded output. A process instance ID makes output-cursor resets explicit.

`cpp-scan-timeframe` currently implements only the original closed-bar FX
Fibonacci baseline without optional confluence filters. Frozen actual-JavaScript
fixtures match long/short/no-signal/warm-up decisions and numerical outputs;
unsupported strategy/options/partial-bar inputs are refused, retaining the
reference owner. **The full timeframe C++ target remains incomplete.** Gateway
feed transport and the Node comparison ledger are separate work branches.

Local gate: 5,245 Node tests passed, one skipped; 911 Vitest tests passed;
ESLint zero warnings, production build, no-green and required syntax checks
passed. Both service binaries and C++ suites passed again after adding process
identity and timeframe identity to output. No scanner service was provisioned,
activated or runtime-verified. See `shared-scanner-boundary-2026-09-22.md`.

The preceding watchdog is published as draft PR #1024 at
`0792280dc2cedef81cc2e786c9634e89a26df77b`. Its Node, review and C++ CI checks
were read back green at 19:38 SGT. It remains unmerged/undeployed because the
recorded controlled-rollout boundary still applies to main's automatic deploys.


## Continuation checkpoint — 22 September 2026, 19:53 SGT

The owner directed continuation through P5 in reply №8,395B·1. Main remains
`e8b9cd98180bc965493469c1c2f553499de2025c` at the latest repository check.
The following packages are implemented, tested and published as **draft PRs**;
none was merged, deployed or runtime-verified by this continuation:

| Package | PR | Evidence |
|---|---|---|
| P2 native account-money producer | #1019 | Full local gate and PR CI passed |
| P4 scoped monitoring/completed-work receipts | #1020 | Full local gate and PR CI passed |
| P5 Controllers grouping | #1021 | Full local gate and PR CI passed |
| P5 complete hourly activity | #1022 | Full local gate and PR CI passed |
| P5 native account/cashflow history | #1023, based on #1019 | Full local gate and PR CI passed |
| P5 independent watchdog/calendar/notification contracts | #1024 | Full local/C++ gate and PR CI passed |
| P5 two scanner service boundaries | #1025 | Full local gate and both C++ suites; PR CI passed |

This package adds a bounded, durable scanner **observation** collector. Candidate
identity/expiry/account-feed/profile checks, restart/gap accounting, immutable
conflict refusal and always-denied mirror admission are implemented. The collector
runs only when explicitly invoked with registered comparison profiles and its
own scanner credentials; no timer, config or candidate ownership was activated.
The status route is read-only and unknown before a verified observation. See
[scanner comparison records](scanner-candidate-records-2026-09-22.md).

Validation on this package: Node 22.23.2 full suite **5,247 passed, one existing
skip**; ESLint zero warnings; Vitest **911 passed**; production build, no-green
and required syntax checks passed. An initial full Node run stalled in an
existing route fixture and was stopped; the unchanged route file passed alone
and the complete rerun passed with a 120-second per-test timeout. No assertion,
trading threshold or gate was relaxed. The earlier native Node 24 SQLite cleanup
crash was resolved by using CI's Node 22 major with its native SQLite build.

Gateway mirror transport remains a separate uncommitted work package under
full gate. Full timeframe strategy ports, actual producer comparison/handoff,
scanner calendar/work integration, remaining complete reporting populations and
ordered blockers remain executable work. P2 missing-currency risk policy, P3
momentum TP1 semantics, P4 ownership/freshness decisions and runtime acceptance
remain separately unresolved. The baseline timeframe C++ port is not full
strategy parity. No new scanner is deployed.

All main merges still trigger the four running services. The controlled rollout
preflight and explicit deployment boundary therefore keep these packages draft.
Historical broker observations are not current verification. No broker targets,
credentials, trading modes, risk caps or research thresholds were changed.


## Continuation checkpoint — 22 September 2026, 20:15 SGT

Draft PRs #1019–#1026 are published, unmerged and undeployed. Their CI checks
were observed green: native account money (#1019), scoped monitoring receipts
(#1020), Controllers groups (#1021), complete hourly activity (#1022), native
account/cashflow history (#1023, based on #1019), independent watchdog (#1024),
both scanner boundaries (#1025), and isolated mirror records (#1026). This is
code/test evidence, not authenticated UI or live runtime acceptance.

This gateway mirror package completed the full Node/UI gate and full native
build/test plus all 15 ThreadSanitizer tests. See
[gateway mirror evidence](gateway-scanner-mirror-2026-09-22.md). It adds no broker
connection or trading authority and is disabled without explicit configuration.
Execution-permission failures on rebuilt local binaries were diagnosed; the
unchanged full reruns passed after restoring the local executable bits.

The complete reporting-populations package is undergoing its full gate. It
replaces remaining 100-row journal-derived totals, separates account units,
records unpriced/undated coverage and replaces the mislabeled equity curve with
complete daily realised-close aggregates. First-blocker attribution, integration,
full timeframe parity, calendar/work producers and candidate comparison/handoff
remain executable work. They are not reported complete.

Main remains e8b9cd98180bc965493469c1c2f553499de2025c at the last check. Every
main merge still triggers all four services; revision-3 §18 rollout preflight
remains a release boundary. No deployment, credentials, account amendments,
trading modes, numerical risk caps, mandatory TP1 or validation thresholds were
changed. Historical broker exceptions and account roster observations have not
been relabeled as current. Runtime shell and authenticated browser acceptance
remain unavailable; editing, GitHub publication, Node22/native SQLite and all
local repository toolchains are available.

## Continuation checkpoint — 22 September 2026, 20:25 SGT

Fresh GitHub reconciliation: main is
`c74165e2b1f5186a5bfe9925093d6e466025b3ea`. #1019 native money merged at
19:58:05 SGT and #1020 scoped monitor receipts at 19:58:27 SGT independently
of this continuation. Their deployment and runtime acceptance on this new SHA
have not been verified here. #1021's head advanced to
`e9231e162d8b5d1c80494062c96b2ac9dfebae22`, integrating that main and regenerating
the inventory; preserve that work. Its commit records its own full gate.

#1022–#1026 remain draft/unmerged. #1026 CI is green. The gateway mirror is
published as draft #1027, head `81728dfa26cc79da3262703b585201d606d79261`:
full local Node/C++/all 15 TSan tests and UI gate passed; CI pending at publication.
No endpoint, credential, scanner service, writer or production mode was activated.

This package completes the remaining journal-derived reporting populations and
corrects their units/availability and the realised-P&L curve. Full local gate:
5,252 Node tests passed with one skip; 918 Vitest tests passed; lint zero warnings,
build, no-green, syntax and generated inventory passed. It depends on #1022;
see [complete populations](performance-populations-2026-09-22.md). Implemented
and tested are not merged, deployed or runtime verified.

An independent blocker package is in progress: actual recorded first refusals,
post-approval failures, explicit unevaluated/unrecorded downstream diagnostics,
strict account scope, bounded details and complete record counts. Focused tests
pass; its full gate is pending. The complete history/reporting/Controllers
integration still needs its own combined gate. Full timeframe strategy parity,
bar supply, scanner calendars/work producers and legacy/new comparison remain
executable P5c work. P2 currency-risk policy, P3 target policy, P4 ownership/age
decisions and production acceptance remain separate unresolved boundaries.

All main merges still have the recorded four-service deployment coupling. No
merge/deploy, broker amendment, credential or mode change was performed here;
risk caps, mandatory TP1, manual ownership and validation thresholds stand.
Historical broker reports have not been described as current.

## Conflict-resolution checkpoint — 23 September 2026, 01:23 SGT

The owner explicitly requested resolving and merging all seven open PRs
#1022–#1028 after the four-service automatic deployment coupling had been
identified. Their conflicts were reconciled cumulatively in dependency order:
#1022, #1028, #1023, #1024, #1025, #1026, #1027. Historical checkpoints above
remain historical; this approval supersedes their draft merge holds for this
batch, without changing risk limits, credentials, trading modes, mandatory TP1,
manual ownership or validation thresholds. No new scanner service or optional
quote-mirror configuration was activated.

At this checkpoint #1022, #1028, #1023 and #1024 are squash-merged. Each merge
required the full local gate, green PR CI, a clean merge state and exact equality
between GitHub's proposed merged source tree and the tested integration tree.
Before each subsequent merge, all four previous deployments had to succeed and
the independent broker audit had to refresh across all seven accounts. The
17:20 UTC audit showed no missing SL and the same two pre-existing missing-TP1
exceptions on accounts ending 9908 and 0949. Existing P&L-watch budget failures
remain visible; this is not a claim of complete runtime acceptance or P5 parity.

All seven integrated branches passed the local Node, ESLint, Vitest, production
build, no-green, syntax and generated-inventory gates. The watchdog Node suite
was rerun serially after a responsiveness test missed its existing deadline
under compilation load; the deadline and assertions were not changed. The
watchdog and both scanners passed their C++ suites and no-order-authority symbol
checks. The gateway's full C++ suite passed after rebuilding an empty local
binary and correcting a pre-existing test synchronization race: the stale-fire
test now waits for both the counter and decision record within the same budget,
and the send check likewise waits for both observations. Production code and
final assertions are unchanged. ThreadSanitizer and the remaining merges are
still pending at this checkpoint.

At 01:30 SGT, #1025 is merged and #1026 has green PR CI. The gateway's
full C++ suite and all 15 ThreadSanitizer tests have passed locally. One
generated sanitizer binary needed its executable permission restored before
that successful run; no sanitizer setting, assertion or time budget changed.
#1026's deployment-audit gate and #1027's final publication/CI/merge remain.

At 01:32 SGT, #1026 is also merged as
`2c909165fe4c1330c1b8b2f4fc886ce70faf035b`, after the fresh 17:31 UTC
seven-account independent audit. Six of the seven requested PRs are merged;
#1027 is the final PR. Its integrated local JavaScript/UI/build gates, full C++
suite and all 15 ThreadSanitizer tests passed. Its remaining boundary is green
PR CI and the same deployment/audit gate, followed by final deployment readback.

## 23 September continuation

The seven-PR batch #1022–#1028 is merged, ending at main
`bf927258b34085517438137653e7b2fd35bda37a`. All four service deployments succeeded.
Readback at 06:43 SGT found no missing SL and the same two existing missing-TP
exceptions, one each on accounts 46979908 and 47790949. No target was amended.

Current authorized sequence: finish blocker reporting and reporting/history
acceptance, then scanner feed/comparison and watchdog integration. Target-policy
changes and scanner activation remain distinct approval boundaries. The blocker
and history implementation/acceptance evidence is recorded in
`reporting-acceptance-2026-09-23.md`; full gate/publication is in progress.

## Continuation checkpoint — 23 September 2026, 07:50 SGT

Blocker reporting/history evidence changes merged in #1029 as
`3c15b37e65fc6cfe67ce52763b39d786f1622d53`. The full local gate passed:
5,287 agent tests with no skips, 922 frontend tests, lint/build/no-green/syntax
and inventory. PR CI passed and all four Railway deployments succeeded.
The 07:45 SGT seven-account audit still showed zero missing SL and the two
pre-existing TP1 exceptions. No targets were amended.

Post-merge review identified three reporting classification corrections:
placement receipts must not inflate approvals; symbol-cap submission vetoes
are post-approval; regime, evidence and producer-retirement fences are upstream.
This follow-up adds structural JSON receipt classification, preserved receipt
evidence, stage corrections and behavioural/UI regressions. Publication uses
GitHub because the workspace is offline. The full PR CI gate is required;
no local validation is claimed for this follow-up.

Scanner feed/comparison and watchdog producer integration were implemented
locally in `scanner-integration` on `codex/rev3-scanner-integration-20260923`,
but remain uncommitted/unpublished at this checkpoint. Targeted integration
tests and the tick/timeframe native tests passed; tick ThreadSanitizer passed.
The combined agent gate returned 5,294 passes and one failure; its diagnostic
log is inaccessible while the workspace is offline. UI/lint/build/no-green,
syntax and inventory passed. The gateway C++ command exited 2 and needs log
inspection; verifier tests passed before its latest source edit, so that edit
needs revalidation. These are not a passing final integration gate.

Recovery must inspect `gates/scanner/agent.log` and `gateway-cpp.log`, preserve
the uncommitted work, integrate this reporting correction, finish the native
and sanitizer gates, then publish/merge and verify deployments. The scanner
work includes bounded off-thread bar/comparison polling, actual native tick
comparison inputs, account/feed/profile identity, retained comparison evidence,
scanner/calendar/completed-work producers, gateway receipts, watchdog no-order
evidence and an external observer with a manual-only CI workflow. No scanner
bridge, new scanner service, target policy or outbound notification was activated.

Authenticated production reporting/history acceptance remains outstanding.
Before the workspace outage, the browser showed the disconnected-agent screen.
Fixtures and deployment success do not establish real-account cashflow/history
or retention acceptance. Target-policy changes and scanner activation remain
the owner's distinct approval boundaries.

## Recovery checkpoint — 23 September 2026, 09:08 SGT

The owner resumed work with task-list reports every fifteen minutes or on
completion/blockage. Reporting correction #1030 merged as
`0d10cf2bb2a6db5ee2726415696beae10d221278`; PR CI and all four Railway
deployments passed. Authenticated history/cashflow/retention acceptance is
still outstanding. The current app is served at `sg-trade.up.railway.app`;
the old Vercel homepage is not the acceptance target.

The scanner work survived the workspace outage and was committed locally,
then integrated with current main. The earlier Node failure was the explicit
one-account routing allowlist: the new account-host identity reads are routing
only, now registered and behaviourally tested on both hosts. The interrupted
gateway build left one zero-filled generated binary; it was removed and
rebuilt from unchanged source. Gateway and verifier full native suites now
pass, including the final watchdog source edits. The combined application gate
and gateway ThreadSanitizer run are in progress, not yet claimed complete.

Additional regressions cover transactional comparison rollback, missing and
out-of-order native cursors, a latest entry blocker obscured by newer placement
receipts, no-order notice recovery, and honest absent/mismatched UI evidence.
The bounded feed/comparison and watchdog integration is being published as a
separate PR so recovery no longer depends on uncommitted local files. The
remaining timeframe strategy ports, authenticated production acceptance,
peak-load measurements and actual alert delivery remain explicit incomplete
work; scanner activation and target-policy changes still require their
distinct approvals.

## Acceptance checkpoint — 23 September 2026, 09:56 SGT

#1031 merged as `0b8a60041e51931a801d00981968ff61ac6cfc4b`. All seven
application gates passed: 5,300 agent tests without skips, 924 frontend tests,
zero-warning lint, build, no-green, syntax and inventory. Gateway/verifier and
both scanner native suites passed; all 15 gateway ThreadSanitizer tests passed.
All five PR workflows succeeded. All four Railway services deployed that SHA.
The 09:30:47–49 SGT seven-account audit showed zero missing SL and the same two
TP1 exceptions. The observation bridge and scanner services were not activated.

A real disk-backed isolated retention check verified the 90-day boundary,
account isolation, preserved cashflow events and equity ledger, and identical
results after database close/reopen. Production configuration and startup logs
confirmed Node's `/data/agent.db` mount. This does not prove that production
contains 90 days of complete cashflow/history coverage. cpp-acct still has no
volume listed; recorder/storage acceptance is not closed.

The secure browser connection request was interrupted by the user. It was not
retried. Fresh production readback remained disconnected, so authenticated
account, cashflow and historical coverage acceptance is still blocked. No
credential was extracted from another source and no successful login is claimed.

That disconnected read exposed lower Performance panels claiming empty results
despite unavailable evidence. #1032 corrected those panels and exports, cashflow
copy, fake feed-refresh evidence and unverified currency labels. It merged as
`0f32770ace275432ae806c2551ffff614f7ae3ca`; the proposed and deployed source tree
both matched `336e04c5acc5baa118aa7bda7d61c125c94ee2d2`. The final seven-part gate
passed with 5,300 agent tests, 929 frontend tests and no skips; both PR workflows
passed. All four services deployed successfully. A fresh production DOM read
verified journal/position/debrief unavailable states, unknown SL/TP counts and
unverified equity-stop state; the previous confident-empty claims were absent.

The post-deployment broker audit checked all seven accounts at 09:55:46–47 SGT:
32 open positions, zero missing SL, one missing TP1 on each of 46979908 and
47790949. No target was amended. GitHub returned no open PRs after #1032.

### Remaining work and explicit stop boundaries

| Priority | Verified progress | Remaining completion evidence |
|---|---|---|
| P0 / P3 targets | Fresh seven-account protection observation; blocker reporting merged | Position-specific TP1 resolution and momentum target semantics require the distinct target-policy approval; do not invent prices |
| P1 | Protection reserve implementation reused | Saturated ordinary-read/protection latency acceptance |
| P2 | Account identity/isolation and reporting packages merged | Authenticated account switching, intended roster reconciliation and currency/risk-policy completion |
| P4 | Gateway readback/receipts and protection fixes merged | Account-scoped quote/configuration freshness, writer ownership, latency and failure acceptance |
| P5a | Controllers/watchdog producers and independent observer integration merged | Approved delivery destination/settings, real alert and Node-down drill, external observer credentials/schedule; no outbound test or activation performed |
| P5b / P5d | Blocker/population/history code and disconnected UI acceptance passed | Authenticated real-account cashflow/history/retention coverage; allow 30–60 minutes for the first acceptance pass after secure connection, excluding fixes |
| P5c | Bounded feed/comparison integration and native baseline tests passed | Eleven remaining bar strategies plus remaining Fibonacci options, attributable parity, peak-load/protection measurements and handoff acceptance; scanner activation is separately approved |
| P6 | Existing research machinery reused | Current attributable datasets and matching-profile evidence validation |
| P7 | No new promotion or policy changes | Decisions after P3/P6 evidence |
| P8 | No symbol expansion | Account tradability, broker budgets and protection-safe load acceptance |
| Maintenance | Local retention/reopen and Node mount verified | Production quota/disk trend, recorder retention and per-service restart recovery |

This is not Version 3 completion. No honest whole-programme finish date can be
derived from a green merge gate: policy choices, authenticated data and remaining
strategy ports still affect scope. Fifteen-minute task reports were given while
actively working; no unattended fifteen-minute automation was created because
the exposed scheduling service supports at most hourly recurrence. This
documentation-only checkpoint is published on its continuation branch for the
next code PR, without another four-service deployment merely to update status.
Rollback owner remains Adrian Ang; a revert still follows the deployment gate.

## Authenticated continuation — 23 September 2026, 10:38 SGT

The owner entered credentials through the control browser and authorized
continuation. Fresh visible evidence confirmed an active application session
and all seven accounts. Production remained on #1032; its four services were
still successful. The authentication blocker is resolved for this session.

Real reporting showed retained account history with native currency, explicit
cashflow-coverage gaps, and unknown adjusted returns. Browsing older history
preserved its observed interval. Blocker pages 2 and 3 both reported 7,065 total
records for the frozen account window, rather than using the 50-row detail cap.

Account switching exposed a client reconciliation defect: AccountHistory and
BlockerReport were siblings with the same `key={acct}`. Switching the report
filter left both the previous account's 187-observation history and the newly
selected account's 178-observation history in the DOM. The duplicate persisted;
this was not merely a transient loading state. The fix gives the two sibling
types distinct account-specific keys, retaining deliberate remount/reset on an
account switch. The full gate and production multi-account readback are required.
No broker action or trading-account selection was changed. Acceptance uses the
Performance view-only filters; the floating account switch explicitly changes
the traded account and is outside this read-only check.

## Authenticated readback — 23 September 2026, 10:53 SGT

#1033 merged as `212c095c538bedf9befa305b7c32f2bb59a26df6`, with the exact
tested source tree `775a787d7f94db0e161f02d911b8e863be67bb91`. The local gate
passed 5,300 agent tests, 929 frontend tests, lint/build/no-green/syntax and
inventory; both PR workflows passed. All four services deployed successfully.
The seven-account audit at 10:46:33–35 SGT reported 32 open positions, zero
missing SL and the same two TP1 exceptions. No target was amended.

The original browser tab stalled during reload. A fresh tab in the same browser
successfully retained the authenticated session; no new credential prompt or
deployment was needed. The new bundle was exercised against all seven accounts
using only Performance's view filters. Each change left exactly one history
section and one blocker section, reset history to 24 hours/page 1, and showed
only that account's IDs in every displayed blocker detail row. The all-account
history view required selection of a single account instead of summing money.

| Account suffix | History observations in sampled 24-hour window | Blocker records in sampled 24-hour window |
|---|---:|---:|
| 9908 | 182 | 70 |
| 3489 | 191 | 62 |
| 2148 | 191 | 0 |
| 9009 | 191 | 4 |
| 7342 | 182 | 31 |
| 0949 | 182 | 94 |
| 0058 | 191 | 7,085 |

These were sequential reads at 10:49–10:50 SGT, not simultaneous population
counts to sum. History's 24-hour, 7-day and 30-day selectors worked. Older
observations preserved the observed interval; account changes reset both the
window and pagination. Frozen blocker pages 2 and 3 retained the same 7,085
total. Expanded evidence named an upstream stage-matrix refusal and marked
risk/submission as not evaluated. Pre-deployment history remained present after
restart, including comparable observations from 22 September 22:44 UTC.

Visual review found a remaining identity ambiguity: the global account FAB
could say All accounts while the Performance-local filter selected one account.
History and blockers now name their own requested account directly above their
contents. This display-only follow-up preserves the global trading-account
control and the independent report filters. Its own gate and deployed label
readback remain required before acceptance.

Reporting behavior is verified for the observed cases; data completeness is
not complete. All seven sampled histories report cashflow_coverage_gap and
withhold external-flow-adjusted change. The full population report named 23
unpriced closes and four closes without account identity. At 10:42 SGT the
health panel also reported three overdue, never-attempted P&L backfills. These
are explicit remaining data-quality work; no missing value was invented,
written off or turned into a successful zero during acceptance. No 90-day
production depth or complete historical cashflow reconciliation is claimed.

## Acceptance closure checkpoint — 23 September 2026, 11:05 SGT

#1034 is merged as `044788dc7d25a472e5228ed5e7b4329203a2a067`. Its exact
source tree `9d4ec40121bb6b3e22017ac5e380c7fd8220b20d` passed 5,300 agent tests
without skips, 930 frontend tests, zero-warning lint, build, no-green, syntax
and inventory. Both PR workflows passed, and all four Railway services deployed
successfully. Fetched main matched that source tree; no open PRs remained.

The final authenticated readback verified explicit aggregate headings and
correct history/blocker account labels for accounts ending 9908 and 0058,
with one panel of each type retained after switching. This completes the
display follow-up to the seven-account behavior checks above. A privately
saved screenshot records both scope labels; no credential or private screenshot
was published in the repository. Cloud-browser reload stalled twice during
this acceptance session; fresh tabs retained authentication and worked, and
the stale agent tabs were closed. This was not a reason to repeat deployments.

The final independent audit checked all seven accounts at 11:02:30–32 SGT:
32 positions, zero missing SL, and the same two missing-TP1 exceptions on
9908/0949. Initial startup UNVERIFIED readings were superseded by this fresh
successful audit. No target, numerical limit, trading-account selection,
credential or scanner activation setting was changed.

**Accepted:** authenticated reporting behavior for the observed account,
window, pagination, unavailable/zero, blocker-diagnostic and restart-persistence
cases. **Still incomplete:** full historical cashflow/P&L reconciliation,
including the seven cashflow-coverage gaps, 23 unpriced closes, four unattributed
closes and three overdue never-attempted P&L backfills observed earlier in this
session. Those dated observations are not continuously current readings.
P5c remaining native strategy ports/parity/load acceptance, P5a real alert
delivery and outage drills, and the other P0–P8 completion criteria remain as
listed above. Target policy and scanner activation retain distinct approvals.

This documentation/serial checkpoint is published on the continuation branch
for the next code PR. It does not trigger another status-only deployment.


## Version 3 continuation - 23 September 2026, 11:35 SGT

The owner requested continued implementation through Version 3 completion with
interval reports. Separate target-policy and scanner-activation approvals remain.
GitHub main remains `044788dc7d25a472e5228ed5e7b4329203a2a067`; all four Railway
deployments are successful. The 11:24:05-07 SGT independent broker reads again
reported 32 positions, zero missing stops and the same two TP1 exceptions.

P5 history diagnosis found that cashflow collection is tied to the nightly equity
pass, leaving newer observations outside its verified interval. A bounded
continuation collector is the next reporting package; no complete cashflow
reconciliation is claimed yet.

The P&L loop at 11:25 SGT still reported 23 unpriced closes: 20 previously
written off and three overdue never-attempted rows. Code inspection found that
cross-side reconciliation can close local trades but the P&L pass visits only
the selected broker environment. The accompanying correction wires a paced
read-only deal-history recovery after cross-side reconciliation. It uses each
registered account's own host and symbol map, and rejects account mismatches,
malformed monetary evidence, partial history, expired reads and a matched
position whose lifetime predates the verified window. Unattributed rows cannot
be claimed by this new path. Audit restamping is restricted to the same account.

Nine focused behavioural/wiring tests pass, including broker closure through
actual recovery, collision isolation, failed-read isolation, pacing, refused
accounts, strict unknown-row handling and partial-lifetime refusal. Full local
and PR gates, production rollout and the three-row readback remain required.
No target, numerical risk limit, ownership, selected account or scanner mode
changes. Rollback owner remains Adrian Ang.

The first full gate ran 5,309 agent tests: 5,308 passed and the exact routing
inventory failed because the new module was not listed. Its five environment
references were inspected: opposite-host selection, credential assembly and
registered-host verification only. The routing inventory now records those
exact counts and purpose; its detection rules remain intact. Other local gates
passed (930 frontend tests). The complete gate is rerun on this corrected tree.

## Recovery deadline and per-position coverage follow-up - 23 September 2026, 11:53 SGT

#1035 merged as `fa6ae4c826278b0b333279968cd2058c0eb5d5d7` after all seven
local gates (5,309 agent / 930 frontend tests), green CI and clean merge state.
All four Railway services deployed successfully. Fresh independent reads at
11:49:58-11:50:00 SGT found the same 32 positions, zero missing SL and two TP1
exceptions. No numerical limit, ownership, target or activation changed.

Post-merge automated review identified two defects, now corrected in this
follow-up: socket timeouts excluded queue/token waits, and one position whose
lifetime preceded the query aborted all recovery on its account. Production
confirmed the latter at 11:50:58 SGT for account 42993489; the three rows are
not claimed recovered. The wrapper now enforces a wall-clock deadline while
retaining an in-flight lock until the underlying read settles. An old, unknown
or future lifetime is excluded individually from monetary/price writes and
attempt counts; covered peers can recover. Raw deal receipts remain evidence.
Expired work is checked again after asynchronous module loading before writes.

Ten focused tests pass, including a never-returning queued read, later-account
progress, no repeated overlapping request, ignored late response and mixed
covered/uncovered trades. The full gate and production readback are pending.
Cashflow continuation work is isolated on its own branch while this correction
is completed. The older-position gaps remain explicit outstanding evidence.

The follow-up review also found that uncovered rows still voted on retry
pacing. The same lifetime predicate now scopes the eligible-work gate and
live/blocking pacing counts. The full ledger gap remains reported; an
uncovered-only account performs no futile bounded read, and a later eligible
close is immediately reachable. This does not write off or clear old money.
The added regression passes; the full gate is repeated on this exact fix.

## Continuous cashflow reporting package - 23 September 2026, 12:00 SGT

The nightly-only collection left current equity observations outside verified
cashflow history. A reporting-only collector now runs independently of the
main loop and UI, requesting at most one account/one seven-day interval every
30 seconds. Fresh account/host/currency evidence is required before and after
the read. Registered manage-only accounts are included; token refusals remain
respected. The transport has a five-second outer deadline, and a transport
that still has not settled holds the overlap lock. No late result can commit.

Completed intervals are the durable continuation cursor. Account rotation
persists even on failure so an unavailable peer cannot starve another account.
Intervals resume at the earliest retained uncovered observation within the
current observed currency/host regime. The record store compacts only proven
touching/overlapping windows of the same identity and currency, preserving
real gaps and atomic conflict handling. Broker error/partial payloads cannot
be marked complete. No failure increments coverage.

The history response and display carry collection status, its last successful
read and an optional dated reconciled portion. A later uncovered observation
still makes the full-window figure unavailable; unknown cashflow classes,
mixed currencies or partial pages cannot yield a complete monetary result.
The collector is registered and grouped with account records: 35 controller
names in total, 34 active and the existing one retired.

Focused validation: 20 backend tests and four history UI tests pass, including
the real producer-to-report path, deposits versus profit, bounded catchup,
restart continuation, failure fairness, non-overlap, stop/late response,
identity changes, transitive window compaction and honest partial reporting.
The full local gate, PR CI, production rollout and authenticated readback are
pending. Numerical risk thresholds, TP1, account ownership/selection, target
policy and scanner activation are unchanged. No broker writes or notifications
are issued by this collector. Rollback owner: Adrian Ang.

GitHub readback at 12:08 SGT showed #1036 already merged at 12:04:33 SGT as
`80cf59341d4b013d33bb469850e1a6bf381587df` with its original reviewed head.
All four new deployments succeeded. The later pacing correction was pushed
after that merge and is therefore included in this cashflow continuation PR.
It is not yet production evidence. The first isolated-checkout gate had three
native integration skips; its matching previously built executables were made
available. The next run exercised all 5,321 tests, with one legacy no-work
return-shape failure caused by an added zero-valued diagnostic. That field is
now strict-path-only, preserving the existing caller contract. No test was
removed or weakened. Full verification is repeated on the combined change.

## Native strategy parity continuation - 23 September 2026, 12:27 SGT

#1037's complete local gate passed: 5,321 agent tests without skips, 931
frontend tests and all seven checks. Its first CI attempt failed the unchanged
health-latency test at 404 ms against 100 ms. One diagnostic retry of the same
commit passed CI without any code, test or threshold change. Review is running;
no merge or production cashflow acceptance is claimed at this checkpoint.

The next isolated package adds four native strategy ports and corrects strict
swing-pivot parity in both existing C++ copies. The
[parity record](scanner-native-parity-2026-09-23.md) lists supported semantics,
64 frozen cases, four pivot boundaries, real HTTP comparison evidence and
remaining gaps. Five of twelve per-symbol strategies have partial native
coverage; full strategy coverage, production load and activation remain open.
Numerical settings, target policy, ownership and scanner activation are unchanged.

## Cashflow acceptance and background recording - 23 September 2026, 12:57 SGT

#1037 merged as `b08817d705b4092d194aa805ca6157c593c2e0db`; all four
deployments succeeded. All seven accounts subsequently completed cashflow
collection and authenticated history readback. Account 43002148 first showed
its failed collection and incomplete coverage, then automatically recovered
and showed complete coverage at the next successful read. No event was
invented to fill a gap. This accepts cashflow collection for the observed
intervals, not all Version 3 history requirements.

Acceptance found that equity/exposure/protection history stopped advancing
after the monitor view closed. The [background recorder](background-history-recording-2026-09-23.md)
now retains existing broker responses independently of the browser. Its first
full local gate passed 5,332 agent tests without skips, 932 frontend tests and
all seven checks. It requires a final gate with the new main, CI, review,
deployment and fresh receipt readback. Missing broker P&L remains missing.

#1038 merged as `5965f578274b4aeb90cdec1a0e700dab2315e3a6` after its complete
local gate, all four CI workflows and completed review without findings.
Deployment is running. This adds four native ports and comparison evidence;
it does not activate scanners or complete the remaining strategy/load gates.

The latest measured independent protection read still had 32 positions,
zero missing SL and two TP1 exceptions. Two overdue unpriced closed rows and
20 previously written-off gaps remain; position-specific broker history is
the next recovery investigation. The target-policy and scanner-activation
decisions remain separate owner approvals. Real alert-delivery/outage
acceptance and the other P0-P8 criteria are still outstanding.
