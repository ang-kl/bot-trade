# Trading coverage follow-up, 21 September 2026

## Current priority order, 22 September 2026

This table supersedes the implementation order below. The older observations
remain dated evidence, not current production state. Latest independent broker
readings: 08:16 SGT, relayed from cpp-verify by production on `d1c7f79` (#999).

| Order | Work | Verified state | Remaining acceptance |
|---|---|---|---|
| P0 | TP1 and SL coverage | Seven accounts independently read; 39 positions, zero missing SL, two missing TP1. Missing targets are on accounts ending 9908 and 0949. #992 exposes broker target refusals. #995/#998 require confirmed, bounded broker protection reads for book stop updates. | Identify the two current position exceptions from an authenticated detailed audit and apply a valid authorised target policy. Earlier recorded targets were behind the market; do not choose replacements merely to make coverage green. |
| P1 | Controllers accuracy and runtime delays | #997 deployed unknown/error states through collapsed Controllers, position rows and gauges. #999 deployed bounded calendar memoization and verifier diagnostics. Recent production monitor profiles were about 12 seconds; calendar conversion was no longer a top-five frame. | Reconnect the authenticated dashboard and verify rendered states. Attribute remaining synchronous work and I/O delays before claiming a one-second management cadence. |
| P2 | Independent cpp-verify checks | Fresh broker reads across all seven accounts are now visible in production logs, including the two TP exceptions. #1000 is merged and adds keepalives during idle periods and pending reads. | Verify deployment and subsequent checks remain fresh across multiple poll intervals; show exceptions in Controllers. |
| P3 | Tick protection on both services | Recording/shadow observation was previously verified on both services; tick trailing remains disabled. This PR makes tick stop updates preserve freshly read broker TP and require broker read-back. | Complete account-scoped configuration, ownership/concurrent-writer and feed identity checks, then verify bounded configuration/quote freshness and safe activation. This PR alone is not activation approval evidence. |
| P4 | Account coverage | #993 scoped broker positions/history/cache to the viewed account. Independent protection reads now cover all seven registered accounts, including empty accounts. | Recheck rendered account switching and every account's management path; a successful protection read does not prove entry or management eligibility. |
| P5 | Simulation, statistics and replay | #985 and follow-ups corrected scenario inputs, replay MTM, candidate block bootstrap, profile attribution and empty-replay diagnostics. | Run diagnostics against current production inputs and compare matching profile hashes. Zero trades means insufficient evidence, not a losing strategy. Validation thresholds remain unchanged. |
| P6 | Strategy and configuration | No unsupported strategy promotion or risk-limit change has been made. | Publish the effective strategy/blocker matrix from fresh runtime evidence; sunset or promote only from valid, attributable results. |
| P7 | Symbol universe and capacity | No blanket increase to 500 symbols per account. | Measure account eligibility, subscription/request budgets, processing latency and open-position protection coverage before expansion. |
| Maintenance | Temporary storage | The two large test fixture producers clean up their own directories. | Final production disk trend read-back remains outstanding. |

Independent protection counts at 08:16 SGT:

| Account suffix | Open | Missing SL | Missing TP1 |
|---|---:|---:|---:|
| 3489 | 1 | 0 | 0 |
| 2148 | 0 | 0 | 0 |
| 9009 | 0 | 0 | 0 |
| 7342 | 7 | 0 | 0 |
| 0058 | 8 | 0 | 0 |
| 9908 | 9 | 0 | 1 |
| 0949 | 14 | 0 | 1 |

The authenticated browser connection was lost when the session resumed. Railway
deployment and runtime evidence remained accessible. Therefore deployment status
and broker readings above are verified, while current rendered UI acceptance is
explicitly incomplete.

## Priority and acceptance record

| Order | Work | Change in this PR | Production acceptance still required |
|---|---|---|---|
| 1 | Mandatory TP1 | Remove the old momentum-book exemption from the existing bounded target repair path. Keep human-owned positions exempt, recorded-target restoration first, and live stop-preserving amendments. | Broker audit confirms TP on every reachable bot-owned position, or names the refused/uncomputable repair. A successful test is not a broker amendment. |
| 2 | Account coverage | Controllers explicitly mark token refusals; expose reserved, in-flight and unknown intents. | Reconcile local positions with broker truth on the funded live account. Latest sidecar logs at 12:55:31 UTC report all three live accounts authenticated. |
| 3 | PR #985 corrections | Convert quote-currency commission notional to USD. Exclude unused standing reservations; count real pending intents against capacity. Freeze rates, costs, risk, exposure, lot metadata and shared trades in immutable dated scenarios. | Current-conditions projections are not historical account execution evidence. Historical balances and exposure have not been reconstructed. |
| 4 | Statistics and replay | Executable-quote mark-to-market replay drawdown; deterministic moving-block expectancy beside the existing IID estimate; measured warm-up, rejected-event and purge-capacity diagnostics; exact profile attribution in the trial view. | Run new diagnostics on the production replay inputs after deployment. Do not infer strategy failure from empty trials. Shadow history has no quote-by-quote equity path, so its MTM drawdown is explicitly unavailable. |
| 5 | Temporary storage | Both research/segment test modules track and remove only their own temporary directories after their tests finish. | Run the test suite without leaving those large fixture directories behind. No broad deletion of existing `/tmp` content. |
| 6 | Live observation and UI | Heartbeat reads explicit disabled tick status even when `/health` has no tick object. Restart preflight additionally checks entry mode and unknown/in-flight intents. | Set `TICK_SPOOL_PATH=/data/tick` only after the protection and intent preflight passes, then verify live shadow and unchanged entry gates. |

## Production observations

Production was on merge `5f82869` (#988) during this inspection. These readings
describe that deployment, not the unmerged changes in this PR.

- Authenticated browser access was established through the Telegram login flow.
- The Controllers table showed demo recording and shadow ON, with zero tick entry accounts.
- All seven account rows showed `TIME_BASED`; tick entry readiness was blocked.
- The four demo audits showed 29 missing targets in total: 4, 8, 5 and 12.
- The funded live account's table showed three local positions unmatched to broker truth. The Connect detail later said its broker snapshot had not returned. Neither is proof of a flat or protected live book.
- Live `/tick-status` was not being pulled because the old heartbeat required a health `tick` object first. The live service has no `TICK_SPOOL_PATH` configured. This PR closes that reporting gap.
- Earlier token refusals for the two other live accounts were superseded by the sidecar's 12:55:31 UTC `3/3 account(s)` authentication report. Future refusals must remain visible if they recur.

## Statistics boundaries

The actual oracle warm-up is `max(rangeEvents + 1, momentumEvents)` prior
accepted prices. It is 1,025 for the 1,024/256 profile, not 1,280. Invalid or
stale observations reset the window. A nominal event count alone cannot prove
warm-up completion; `warmedEvaluations` records the actual decision opportunities.

The default purge is the greater of feature length and maximum holding events.
For a 1,024-event range the usual holding cap is 4,096 events, so short blocks
can have zero eligible entries even when the oracle has warmed. The new block
capacity and event rejection figures distinguish these conditions. No purge,
profile, holding limit, or acceptance threshold is reduced to produce a pass.

`blockExpectancy` is a candidate circular moving-block bootstrap with its seed,
resample count, percentile and block length on the result. The default length
is `ceil(sqrt(trades))`, an explicit assumption, not a measured independence
horizon or a day-based block. It is reported beside the existing validation
statistic. Adopting a different validation method remains a separate decision.

Replay MTM measures each open trade at the executable bid/ask net of configured
exit costs, including interim retracements before profitable closes. Existing
shadow close records cannot recreate that path; they retain a clearly named
closed-trade drawdown and a null MTM field. New replay results carry a statistics
version in the content identity so they cannot collide with old trial records.

Account scenarios persist in `tick_shadow_account_scenarios` with a content hash,
capture time, complete inputs and results. The old fills table remains a latest
projection cache. Replaying stored inputs does not consult today's balance,
exposure, lot rules or FX rates for its decisions. No account scenario is an
additional independent market observation.

The post-merge review identified two further corrections. Scenario snapshots
now include `ACCEPTED` ledger orders in pending capacity and duplicate-symbol
checks only when the same account's broker-order snapshot still marks that
order working. Historical acknowledgements survive fills/cancellations in the
intent ledger and cannot establish pending exposure on their own.
This reporting change does not alter the live permit feeder's state
set. Version 2 freezes each symbol's resolved quote currency, including an
explicit null/USD assumption, and supplies it to sizing, margin and fees.
Version 1 inputs lacked that information and must be recaptured; their stored
results remain available but cannot claim immutable replay.

## Live activation procedure

The user's continuation includes live observation activation. This is currently
blocked by failing preflight evidence, not by a need to repeat that request.

1. Deploy the reviewed code and obtain fresh Controllers runtime evidence.
2. Resolve the funded live account's unmatched local/broker records through reconciliation. Confirm all enabled live accounts have successful, fresh broker audits and no missing SL/TP.
3. Run `scripts/tick-shadow-preflight.mjs` on a fresh authenticated heartbeat response. Require no in-flight or unknown intents, existing `TIME_BASED` modes, and no tick-entry account roster.
4. Record the current variable state, then set only `TICK_SPOOL_PATH=/data/tick` on `cpp-acct`. This restarts the service and resets its in-memory trail state; broker protection must already be verified.
5. Read back fresh live and demo status: live tick workers available, shadow ON, advancing quote timestamps during an open market, zero tick-entry accounts/permits/sends, and unchanged entry modes and risk gates. Recheck broker SL/TP and Controllers after restart.
6. If these checks fail, restore the original unset spool variable and restart using the same protection checks. The prepared plan must not be called a completed activation.

The existing observation runbook contains the storage and disk-reserve details.
No order, live target amendment, validation promotion, environment variable,
account selection, or restart was performed during this code preparation.
