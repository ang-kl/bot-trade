# Revision 3 controlled rollout: prepared, not authorised or executed

This runbook records concrete release scope for the continuation PRs. It does
not grant approval or alter Railway configuration. Authority is revision 3
section 18 and CLAUDE.md's deployment boundary.

## Verified deployment coupling

Project: `1832aca1-bc68-4bba-834f-cb0b3c4c05ca`.
Production: `7bc0dfc6-82c5-406c-a621-fd3ff549674d`.
All four services follow main; returned configuration has `checkSuites: false`
and no watch filters. The owner's #1008 merge deployed all four even though the
change touched Node/UI/docs only. Observed successful deployed main is
`4dbdc82996b97a7ace526c5e0dade7b4ff5d4c69` after the owner's #1009/#1010 merges
at 15:10:33 and 15:10:47 SGT. This is not gateway acceptance.

| Service | Service ID | Build root | Continuation code changes |
|---|---|---|---|
| bot-trade | `04945f5c-03d4-4d3f-bec1-f4debcefe5e6` | `/` | Node/UI/read models and account input correction |
| cpp-exec | `f5a3ba4a-52c0-4f4f-999b-45f758d607f0` | `/cpp-exec` | None |
| cpp-acct | `a370f641-1e1b-4893-83af-e5eb1e8ffb3c` | `/cpp-exec` | None |
| cpp-verify | `bc8fcb8d-8194-4acd-9a82-4098751e43cc` | `/cpp-verify` | None |

The gateway/verifier Dockerfiles copy their own Makefile, src and entrypoint.
Nevertheless current platform triggers restart them on unrelated main changes.
Do not assume directory separation prevents a deployment, and do not silently
change watch filters or deployment settings to avoid the approval boundary.

## Reviewable release scope

- #1009 (owner merged): account form submits only edited sizing fields; no untouched stale overwrite.
- #1010 (owner merged): identified calendar capture/read-only API; existing entry calendar unchanged.
- #1011: hourly ledger opening population and honest evidence labels.
- Accompanying P2 leverage isolation: named/selected accounts never borrow global
  leverage; existing 1:100 default remains labelled as an unverified assumption.

Each has its own local/PR gate and rollback commit. Re-read current main, head
SHAs, CI and review findings before release; the owner may merge independently.
Rebase/rerun the affected full gate after any integration conflict. Do not read
an optional successful review workflow as proof a reviewer actually ran.

## Required preflight and acceptance

1. Obtain the approved production rollout scope, including whether deployment
   coupling may be changed or whether all four service restarts are intended.
   A repo merge approval is not a substitute for this controlled rollout.
2. Read fresh per-account/position broker SL/TP and ownership, gateway account
   rosters, active writers, pending/in-flight intent identities and storage
   recovery checkpoints. Current dated account summaries do not provide all of
   those facts. The two TP1 exceptions remain separately unresolved.
3. Stop new submissions only for the approved affected scope while preserving
   existing-position handling. This is a live operational change and has not
   been performed. Do not force-close positions or change unrelated modes.
4. Preserve the deployed SHA and recoverable state. Restart one environment at
   a time where the approved platform rollout permits. Current auto-deployment
   starts all four, so this ordering cannot be claimed without an explicit plan.
5. Verify subscriptions, exact account roster, intent recovery/deduplication,
   broker SL/TP, writer ownership and management resumption after each restart.
   Then run authenticated account switching/save verification and collect
   identified calendar/report evidence; distinguish populated, stale and unknown.
6. Roll back the affected code upon identity mismatch, duplicate intent,
   lost/loosened protection, stale ownership or unacceptable management delay.
   A revert also triggers deployment and needs the same controlled handling.

Rollback owner: repository owner Adrian Ang. No credentials, modes, deployments,
account amendments or rollback commands were executed by this continuation.
Independent delivery, gateway latency and live account acceptance remain open.
