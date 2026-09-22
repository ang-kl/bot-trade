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
