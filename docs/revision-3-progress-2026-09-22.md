# Revision 3 continuation - implementation evidence

Working authority: [revision 3](performance-cards-reassessment-2026-09-22-revision-3.md)
and `CLAUDE.md`. Reconciled on 22 September 2026, 14:30 SGT.

## Repository reconciliation

GitHub main is `7bf5bd1699b02422ab74588b7a62025e7a8edb10` (#1007).
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
