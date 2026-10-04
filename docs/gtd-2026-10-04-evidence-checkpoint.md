# GTD evidence and next actions - 4 October 2026

Checkpoint: 11:06 SGT (4 October 2026). Production baseline: `1afda08fce6befd23d683fc1245e25c91e7d59d0` (#1227). This document updates execution status; the original [GTD capture register](gtd-2026-10-04-to-noon.md#8-complete-carry-forward-register-from-retrievable-sources) remains the complete retrievable backlog. Read it together with the [October 4 handover](handover-2026-10-04.md) and [MAE/Chandelier addendum](handover-2026-10-04-addendum-mae-chandelier.md).

**Business goal remains per-account WR >=75% and PF >=1.68.** The forward assessor is shipped, but achievement is not established. More trades, successful CI and deployment health do not establish either target. The automatic merge/deployment approval expired at 10:00 SGT; this next candidate remains for scoped approval.

## 1. What this work established

- All five original statement hashes matched. All 1,421 closing deals reconcile exactly to their own Net and Commissions footers. There are no duplicate deal IDs, malformed rows, negative holding durations or ambiguous matches to exported open positions.
- Grouping partial exits leaves 1,382 closed entry-cohort proxies. The COST.US partial on account 43097342 realised SGD 0.69 while still open and is excluded from closed-cohort metrics. There were 19 exported open positions on October 1; this is a different date and population from the 11 current positions.
- Every account with 20 historical cohort closes is below 75% WR in its latest-20 sample. These are historical proxies, not certified whole-position closes and not the forward qualification sample.
- A live WMT lesson recommends repeating a setup despite reporting banked 2.95R against only 0.07R best. A candidate correction makes newly generated inconsistent or invalid excursion windows inconclusive, without inventing a peak or changing realised money.
- A recorded BTC value-area breakout reached the risk gate and was refused because spread 15 exceeded 3% of its enforced 287.51746 stop distance. Its retained counterfactual later scored -1R. This supplies a real proposal/refusal trace; it is not a filled trade or realised profit.
- Scheduled scanning and analysis continue. Independent protection covers all 11 current positions. Funding, FX, conviction, stage, session, spread and tick-evidence refusals remain; blanket “ungated” is not a truthful status.

## 2. Historical account baseline

Source: the five supplied CSVs ending **1 October 2026 06:22 SGT**. Available closing history starts July 9 on accounts 46130058/47790949 and July 30 on the other three; the files do not provide three complete months of closes. Net is the broker export’s native-currency Net column, used once. Commission is reconciled separately, not deducted again. Swap, conversion fees and spread are not independently itemised sufficiently to audit every cost component.

**Grain limitation:** no broker Position ID or complete opening/closing volume balance exists in these CSV deal rows. Account + symbol + opening direction + precise opening time + entry price groups likely partial exits. Absence from the open-position section does not certify a full lifecycle. These account outcomes mix opening actors and strategies; closing Channel is not proof of who opened a position.

### Entire exported history, grouped cohort proxies

| Account | Unit | n | WR | PF | Net | Avg win | Avg loss magnitude | Closed-realised drawdown |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 42993489 | SGD | 6 | 50.0% | 3.66 | 16.65 | 7.64 | 2.09 | 5.41 |
| 46979908 | USD | 92 | 37.0% | 1.66 | 163.22 | 12.06 | 4.25 | 136.27 |
| 43097342 | SGD | 268 | 23.1% | 2.90 | 1,634.00 | 40.23 | 4.24 | 502.91 |
| 46130058 | USD | 554 | 28.3% | 0.62 | -19,489.01 | 199.20 | 128.84 | 23,834.08 |
| 47790949 | USD | 462 | 40.0% | 0.80 | -6,874.49 | 152.19 | 128.32 | 7,734.79 |

Drawdown above is the cumulative realised cohort-net path from zero in close order. It excludes deposits, withdrawals and floating P&L; it is not broker account-equity drawdown.

### Latest 20 historical cohorts

| Account | n | Winners | WR | PF | Net in native unit |
|---|---:|---:|---:|---:|---:|
| 42993489 | 6 | 3 | 50.0% | 3.66 | 16.65 SGD |
| 46979908 | 20 | 8 | 40.0% | 0.71 | -5.96 USD |
| 43097342 | 20 | 10 | 50.0% | 25.53 | 1,581.36 SGD |
| 46130058 | 20 | 11 | 55.0% | 1.66 | 491.24 USD |
| 47790949 | 20 | 11 | 55.0% | 0.58 | -913.82 USD |

Account 42993489 has only six cohorts, so the 20-close condition is unavailable even for this historical proxy. No historical row above qualifies the new forward target.

### Direction within the exported history

| Account / unit | Long n | Long WR / PF | Long net | Short n | Short WR / PF | Short net |
|---|---:|---|---:|---:|---|---:|
| 42993489 / SGD | 5 | 40.0% / 3.65 | 16.56 | 1 | 100.0% / undefined | 0.09 |
| 46979908 / USD | 43 | 20.9% / 0.16 | -113.81 | 49 | 51.0% / 3.49 | 277.03 |
| 43097342 / SGD | 175 | 20.0% / 3.67 | 1,717.50 | 93 | 29.0% / 0.62 | -83.50 |
| 46130058 / USD | 268 | 31.0% / 1.39 | 7,073.93 | 286 | 25.9% / 0.19 | -26,562.94 |
| 47790949 / USD | 241 | 39.4% / 0.89 | -2,078.70 | 221 | 40.7% / 0.71 | -4,795.79 |

Descriptive findings: account 46130058’s historical short cohorts lost USD 26,562.94 (PF 0.19); account 46979908’s long cohorts lost USD 113.81 (PF 0.16). These are account/direction segments without reliable entry-strategy attribution. They identify where to investigate, not permission to disable a side or assume a strategy caused the losses.

### Last 30 days of the statement window

| Account / unit | n | WR | PF | Net | Avg win | Avg loss magnitude |
|---|---:|---:|---:|---:|---:|---:|
| 42993489 / SGD | 3 | 66.7% | 0.24 | -4.09 | 0.66 | 5.41 |
| 46979908 / USD | 58 | 37.9% | 0.49 | -31.01 | 1.36 | 1.69 |
| 43097342 / SGD | 70 | 45.7% | 8.21 | 1,504.41 | 53.53 | 5.49 |
| 46130058 / USD | 74 | 41.9% | 0.35 | -3,661.73 | 63.23 | 133.85 |
| 47790949 / USD | 95 | 50.5% | 0.72 | -2,411.68 | 127.02 | 184.97 |

The very high PF on SGD account 43097342 includes one SGD 1,602.14 winning deal closed through `openapi_Tradingview`. Its TradingView closing-channel segment has 13 deal rows, 1 winner, 12 losers and net SGD 1,424.71. The `openapi_cbot-t` closing-channel segment has 211 deals, WR 31.28%, PF 1.36 and net SGD 234.70. These are deal-grain closing-channel segments, not audited bot-only strategy returns. The JSON and notebook preserve this grain distinction. Never average these PF ratios or pool SGD and USD money.

On the live Performance page, account 46979908 separately showed 93 priced recorded closes, 36.6% WR and net 163.23 in recorded account units; its tiles showed PF 1.69. Those later, database-owned closes differ from the statement population. They are neither a reconciliation match nor evidence of the forward 75% WR goal.

## 3. Actual BTC causal trace

### Recorded value-area breakout - a real risk refusal

Visible in Reasons at read **2026-10-04T02:28:52Z**:

| Step | Receipt |
|---|---|
| Identity | account 46130058, BTCUSD BUY, `va_breakout`, 10m; opportunity `46130058|BTCUSD|BUY|VA_BREAKOUT@1791047851308` |
| First / last refusal | 2026-10-03T17:17:44.871Z / 17:26:47.058Z, or October 4 01:17:44 / 01:26:47 SGT; seven repeat refusals on this one opportunity |
| Recorded proposal | Entry 84852.20, proposal SL 84671.45, target 85745.85 |
| First evidenced terminating decision | `spread_too_wide: 15.00000 > 3% of SL distance 287.51746` |
| Threshold arithmetic | 3% × 287.51746 = 8.6255238; spread 15 exceeds it. The enforced risk distance differs from the proposal stop distance; do not recompute R from the proposal stop and call it the gate’s result |
| Execution outcome | This proposal was refused at risk. No broker entry receipt is established for this opportunity |
| Later counterfactual | `stop`, -1R, scored 2026-10-04T01:18:24.591Z, 15 bars, `stop_unit=gate`; simulated exit at 2026-10-03T19:40Z |

The counterfactual is an observation from retained bars, not a broker fill, cost-adjusted realised return or proof of long-run filter benefit. It gives no reason to weaken the spread guard.

### Current FVG selection

Railway loop #28 at 2026-10-04T02:20:06Z allocated `fvg_retrace:BTCUSD(5, waited 1m)` and completed a long 5/10 synthesis. Later loops repeat it. The Trade page displayed FVG 1d at 5/10 alongside Fibonacci Confluence 1mo, VWAP 1w and EMA 4h signals at 10/10. Fair-share analysis chooses a strategy slot, not simply the highest displayed conviction; the chosen strategy is preserved through dispatch.

The Connect comparison read account 43002148 **inheriting the shared list**, 60/60 armed, with BTCUSD Settings “—”. The settings renderer displays `conv >=N` whenever a threshold is present; the shared BTC row therefore has no explicit threshold. In deployed `dispatchSymbolSignal`, the shared symbol row resolves `autoTradeThreshold || 8`; synthesis sets `auto_trade = conviction >= threshold`. **Source-derived conclusion:** this 5/10 proposal resolves threshold 8 and does not advance to stage/risk/entry fan-out. The stored synthesis boolean was not directly read back. No current risk refusal is invented for this FVG proposal.

`61.8% level=undefined` comes from a Fibonacci-specific diagnostic string reused for every strategy. FVG need not carry `level618`; synthesis preserves its own entry, SL, TP1 and TP2. This log wording does not establish a missing entry price or a halted analysis. Cosmetic correction is parked.

The new WR/PF assessor is reporting only. It is not an entry gate, and none of its thresholds caused either BTC refusal.

## 4. Funding, FX and management

| Account | Current ordinary entry constraint | Open positions checked |
|---|---|---:|
| 42993489 | SGD 51.41; `fx_rate_unavailable` | 0 |
| 43002148 | Unfunded, balance 0 | 0 |
| 43069009 | Unfunded, balance 0 | 0 |
| 43097342 | SGD 3102.80; `fx_rate_unavailable` | 1 |
| 46130058 | USD margin headroom 11075.01; strategy/risk/session still apply | 4 |
| 46979908 | USD margin headroom 274.68; strategy/risk/session still apply | 2 |
| 47790949 | USD margin headroom 10466.92; strategy/risk/session still apply | 4 |

Railway margin-pool receipts: 2026-10-04T02:35:24Z and unchanged at 02:54:40.535Z. Broker protection read-back in Desk at approximately 02:36Z showed all seven accounts, all 11 open positions, zero missing SL/TP1, and zero reserved/in-flight/unknown intents. A later independent-protection receipt at 02:55:09Z contains fresh broker reads at 02:54:41-42Z for all seven accounts, again with 11 open and zero missing SL/TP1. The three live accounts currently have no open positions. Protection existence does not prove dynamic Chandelier amendments or optimal exits.

The SGD conversion path requires a finite positive SGDUSD or USDSGD rate with age from 0 through 26 hours, from the broker-backed FX table. Direct and inverse legs are supported; an assumed rate and transitive fallback are not. The current receipt means neither usable direct leg is available. It does not establish whether a row is absent versus aged out. Existing-position monitoring and independent broker protection continue despite entry/margin-pool refusal. Preserve the freshness rule; inspect the next broker-leg refresh and the account’s actual market calendar before proposing a source-policy change.

All seven effective S/A/T switches were ON, active and time-based. Tick shadow was READY but tick entry BLOCKED by `profile_pinned`, `profile_matches_sidecar`, `replay_evidence`, and `validation_stage`; sidecar tick entry accounts were zero. Scheduled entries and tick entries are different paths. This is not an all-paths-ungated acceptance.

## 5. MAE/MFE and candidate correction

The deployed monitor writes `mfe_r`/`mae_r` onto monitored position rows; the normal close path changes status and retains rows. That establishes structural retention, not complete final excursion coverage for every closed trade. Postmortem replay is capped at 400 bars and can omit early holding periods. A clipped window may understate MFE/MAE. No full broker-position-ID, initial-risk and final-sample reconciliation was available for a complete closed-trade distribution.

A live account-46979908 WMT.US postmortem showed SELL, 1h, Vol. Profile Value, entry 108.71, SL 109.4, exit 106.68, net USD 3.20, Result Partial, and “CLEAN WIN - Repeat this setup; banked +2.95R of +0.07R best.” Its expanded detail repeats the contradiction without an evidence caveat. Prices displayed to two decimals yield approximately 2.94R; this rounding difference does not explain the 0.07R claimed maximum.

**Candidate:** after measuring the holding-period bars, `classifyWin` returns `inconclusive` if the recorded directional exit move exceeds their measured favourable maximum beyond floating-point roundoff, or their excursion values are nonfinite. It retains recorded realised R, withholds uncertified MFE/MAE values, and supplies no repeat/tighten/entry-timing recommendation. No peak is reconstructed from the fill. The sweep still stores original net money, account ownership and TP1 Result. The Desk groups a positive-net inconclusive lesson under Wins; uncertainty about excursion evidence does not relabel a profitable close as a loss.

Two backend regressions reproduce the WMT contradiction and verify stored classification, lesson, account, net and Result. An additional rendered-UI regression keeps positive-net WMT under Wins with its INCONCLUSIVE verdict and a negative-net close under Losses. The existing loss/win classes continue to pass. Existing stored lessons are **not** rewritten or deleted by this patch; their interpretation remains subject to the new evidence finding. It does not repair clipped bars, establish complete excursion coverage, alter risk/stop/entry policy, or claim that WR/PF will rise.

Since-entry Chandelier remains 3 × Wilder ATR(22), with entry-anchored peaks and only-ratchet authority. Momentum-book positions have their own stop authority and are excluded from keeper trailing. A valid eligibility denominator requires each position’s ownership, monitor linkage, scope/opt-outs/guards, current host, digits, initial risk and usable bar history. Eleven protected positions is not that denominator. No empirical benefit or complete spec/engine/broker-amend acceptance is claimed.

## 6. GTD done / next / waiting

| Action | Disposition | Outcome / exact next evidence |
|---|---|---|
| A1 readiness/security | Done for dated samples | #1222 security fix deployed; zero open alerts verified earlier. Main remains #1227. Seven S/A/T ON, 11 protected, empty unresolved intents. Not complete continuous-load acceptance |
| A2 after-cost baseline | Done for supplied historical account/direction proxy; strategy baseline blocked | Executed notebook, hashes, footer totals, windows, averages, exclusions and drawdown. Need full position-ID lifecycle export joined to entry strategy and signed costs |
| A3 FX | Bounded diagnosis done; source availability waiting | Exact direct-leg/26h refusal and independent management verified. Next inspect a fresh broker-leg receipt at the account’s real session opening |
| A4 MAE/MFE | Structural check and one concrete defect done; empirical comparison blocked | Review/deploy the inconclusive-evidence guard if approved. Complete excursion/lifecycle dataset before stop-width or exit-policy conclusions |
| A5 BTC | Done for one recorded risk refusal; current FVG threshold source-derived | Preserve opportunity identity, gate stop unit and counterfactual distinction. Await a naturally eligible proposal and broker receipt |
| A6 scanners/Chandelier | Partial; acceptance open | Tick shadow ready, entry evidence gates present; contract-rejection/warm-up gaps retained. Need eligible-position/spec list, engine read-back and natural broker amendment receipt |
| A7 candidate tests/review | In progress | PR #1228: postmortem evidence correction and financially correct UI grouping plus report/notebook. Backend 7,487 passed, four existing native checks skipped. Updated frontend 1,317/1,317, lint/build/colour and manual review passed; final-head CI pending after the UI integration finding |
| A8 merge/deploy/logs | Waiting for scoped approval | After final gates, approve the concrete PR and resulting production deployment. Verify exact deployed commit and fresh protection/loop/error receipts |

The 02:52:33.731Z loop explicitly reports **17 closed trades missing P&L and/or a postmortem**. This is a combined completeness count, not 17 confirmed missing-money rows; account/trade/field enumeration and broker-supported repair remain open.

The original carry-forward register remains active: P0/P3 natural fills/partials/ownership; P1/P4 load/phase timing and UI traces; P2 calendars/roster; P5a watchdog/incident ageing; P5b/P5d account/history completeness; P5c registry/feed/HTTP400/code56; P6/P7 tick evidence/promotion/24h soak; P8 retention/recovery/capacity; REC/WEB truthful reads; broker stop-policy unknowns; owner-only operations; preservation of unpublished October 1 work. None is silently closed by this checkpoint. Removed observer/Telegram work stays superseded.

**Until noon:** finish this one candidate’s required gate and manual review, make the report and PR reviewable, then release only if scoped approval arrives. After release, read the exact commit, protection, loop/error logs and newly generated lessons if a natural eligible close occurs. No unchanged replay cycle, broadened strategy universe, manufactured trade or speculative risk change is needed to fill the time.

**Waiting for real events/time:** at least 20 eligible forward closes, three/eight consecutive completed SGT days, market-specific openings, natural final partials, Chandelier amendments and tick soak. The WR/PF goal cannot be guaranteed by noon.

## 7. Verification, remaining gaps and hand-back

Railway still reports #1227 SUCCESS with the exact production baseline; no candidate deploy has occurred. A bounded `error` runtime-log filter from 02:49Z returned no matches through the approximately 02:55Z read. That is a sampled keyword result, not proof that every error class or every request is clear.

Candidate validation so far: focused postmortems 35/35; frontend 1,317/1,317 under UTC after the UI finding; zero-warning ESLint, production build, colour gate and all eight CI entry-point syntax checks passed. The first full backend run in the container’s local timezone passed 7,485 tests, failed two and skipped four (including the separately isolated latency/hygiene groups). The unchanged pending-order fixture parses a zone-less SQLite timestamp as local time; the unchanged frontend day/month fixture also assumes UTC. The unchanged pruning test requires a 1 ms timer to fire while a tiny batch yields through `setImmediate`, so its first failure does not establish a production non-yielding loop. The focused UTC pending-order/pruning spec run passed 53/53. The complete UTC backend gate passed 7,487 tests, zero failures and four existing native skips, with an empty private TMPDIR. Backend source is unchanged since that passing run. No assertion, test or production policy has been weakened. The first PR CI started on `3eeab9f`; manual integration review then found that the existing UI grouped every inconclusive verdict under Losses regardless of positive net. The candidate now preserves positive-net inconclusive rows in Wins and adds a rendering regression. The added UI regression initially used a DOM in the repository’s Node-only test environment; its harness was corrected to inspect server-rendered HTML without adding dependencies. The published UI fails the new regression because no Wins group exists for positive-net inconclusive WMT; the corrected UI passes, and the complete frontend suite passes 1,317/1,317; zero-warning lint, build and colour gate passed. Final-head CI is required for this actual code change; no unchanged test replay is requested and no green final gate is claimed before its receipt. Automated Claude review skipped its actual action, so manual review is the review evidence.

Manual source review reproduced the same WMT input on published and candidate classifiers: `clean_win` -> `inconclusive`; consistent long and short examples remained `clean_win`, and an invalid bar returned `inconclusive`. The change returns before either the adverse-entry, gave-back or clean-win recommendation; both directions use the same directional exit/peak comparison; the tolerance handles floating-point roundoff, not unexplained price gaps. The stored sweep regression verifies account, net P&L and TP1 Result. Existing rows are never updated by this candidate. Recorded R still uses the existing stop/initial-risk source and is not certified as original risk for all historical trades. A noncontradictory clipped window can still understate excursions; this candidate detects the demonstrated contradiction rather than certifying complete coverage.

| Invariant | Status | Evidence / limit |
|---|---|---|
| Exact statement identity and native totals | PASS | Five SHA-256 matches; 1,421 unique closing deals; net and commission footers exact |
| Partial exits are not inflated into separate whole trades | PASS for proxy method | Grouped entry cohorts; still-open COST partial excluded. Certified position lifecycle remains Not Verifiable |
| Strategy attribution and complete final excursions | NOT VERIFIABLE | Required fields absent in statements; current UI lessons are capped and contain one proven contradiction |
| New assessor controls no entries | PASS | Reporting-only implementation shipped #1226 |
| Current scan/analysis/protection alive | PASS for dated reads | Loops #37-43 completed 7.45-54.08 seconds; later #62 completed 7.506 seconds at 02:54:41Z; 11 broker-protected positions |
| Every path ungated / dynamic management fully accepted | NOT VERIFIABLE | Explicit funding, FX, conviction, stage, session, spread and tick eligibility conditions; no full Chandelier denominator |
| WMT excursion lesson truthful | FAILED in deployed stored sample | Candidate corrects future generation; historical stored sample retained |
| Trade page failure root cause | NOT VERIFIABLE | `/state/prices` aborted/503 then recovered 200 from 02:19:14Z. Reader already catches price failure. Page’s temporary offline/empty initial state recovered; no causal patch justified from that correlation |
| Candidate released / new targets achieved | NOT DONE / NOT ESTABLISHED | Await concrete approval; no eligible forward outcomes demonstrated |

Reproduction: [Python](analysis/gtd-statement-baseline-2026-10-04.py), [executed code notebook](analysis/gtd-statement-baseline-2026-10-04.ipynb), [aggregate/exclusion JSON](analysis/gtd-statement-baseline-2026-10-04.json). Set `BOT_STATEMENT_DIR` to the folder containing the five original uploaded CSVs. All code cells were executed sequentially using Python; a Jupyter kernel runner was unavailable. The notebook retains outputs and exact checks. Its in-memory RESULT includes every cohort/source line; the smaller JSON retains aggregate results, quality checks, exclusions and ten largest losing cohorts per account.

Source definitions: `agent/services/account-currency.js`, `fx-rates.js`, `fib-strategy.js`, `loss-postmortem.js`, `agent/loop.js`, `src/components/watchlist/WatchlistCompare.jsx`, and `src/lib/latest-prices.js` at the stated production baseline. Railway receipts come from deployment `087b0a2d-e408-4fb5-9591-58003c6084e4`; bounded log reads are samples, not exhaustive histories. Browser local timestamps are America/Los_Angeles; ISO receipt times above are authoritative and converted explicitly to SGT.

Conversation ref: continued GTD execution ordered by owner “proceed” after № 11,050; evidence updates № 11,051-11,064. Session link and measured effort unavailable in this environment; no identifier or effort is invented.
