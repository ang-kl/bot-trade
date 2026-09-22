# P2b: account-owned margin evidence

Scope: revision 3's risk, VPO and tick-permit consumers. This change builds on
#1006's shared account snapshot reader. It does not activate an entry producer,
alter a numerical risk threshold or amend broker protection.

## Defects reproduced

- A proposal for account 22 passed with its own broker used margin above the
  cap because `evaluateTrade` omitted `accountId` when calling the portfolio
  margin helper. The helper then read the selected account's shared snapshot.
- A healthy account was vetoed by another account's low margin-level ratio.
- Non-selected accounts' fresh broker snapshots were ignored by the margin
  pool, including the pool consumed by the tick permit feeder.
- The retired VPO feeder used selected/global sizing inputs while sending to
  the account in its credentials. Retirement remains enforced by the real fence.

## Evidence policy preserved and made explicit

| Consumer | Accepted broker evidence | Missing, stale or invalid evidence |
|---|---|---|
| Portfolio margin / margin pool / tick permit pool | Matching account payload in its own cache; explicit timezone; non-future age strictly below five minutes; no snapshot error; finite nonnegative used margin in USD | Existing labelled local estimate, including conservative treatment of unattributed legacy positions. No borrowed global snapshot. |
| Main margin-level floor / VPO margin-level floor | Same identity/time/error rules; finite dimensionless margin-level percentage, including zero; deposit currency does not affect a ratio | Existing fail-open floor behaviour. This means the floor was not evaluated, not that the account passed a measured margin check. Other gates remain active. |
| VPO sizing | Balance and risk configuration for the account in the broker credentials | Missing balance produces unavailable volume (-1); a selected/global balance is never substituted. |

The five-minute cutoff is the existing entry-margin policy, separate from
P2a's fifteen-minute display policy. Future timestamps and foreign payloads are
unusable evidence, not fresh evidence. Fresh zero used margin is valid. Missing
or non-USD currency cannot be presented as a broker USD amount.

Main risk verdicts carry snapshot identity, timestamp, age and reason for both
margin checks; the margin pool carries the same evidence metadata. Unknown or
stale broker evidence is not reported as a verified zero. The fallback estimate
remains an estimate and can omit positions the local database has not observed.

## Verification and remaining boundaries

Behavioural regressions exercise opposite account conditions, absent/foreign/
stale/future evidence, real zero, currency mismatch, VPO sizing and existing
tick permit release/recovery against a non-selected account's snapshot. Existing
snapshot fixtures now identify their account rather than relying on a global key.

This does not yet establish a complete money contract: legacy balance producers
can stamp native deposit currency under `_usd`, leverage still has a legacy
fallback, and manual balance edits need account routing. These remain P2 work.
Snapshot `fetchedAt` is still response completion time, not a new guarantee about
each underlying broker field's source time. Runtime deployment and authenticated
UI acceptance must be recorded separately from test and merge success.
