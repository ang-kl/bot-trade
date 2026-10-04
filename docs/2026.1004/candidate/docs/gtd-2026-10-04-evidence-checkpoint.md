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

## 8. Cloud continuation — 4 October 2026, 15:12 SGT

This dated section supersedes earlier current-state claims only where new receipts are provided. The original capture above remains intact. The morning approval expired at 10:00 SGT; afternoon diagnosis and preparation do not renew merge, deployment, broker or historical-money authority. Continuation serial is a partial-corpus lower bound through № 11,084. The timestamp on № 11,080 was corrected by № 11,081 to 15:08 SGT. Actual model, effort and session metadata are unavailable.

**Prepared correction:** on the first adaptive keeper pass, full bars generate a since-entry trail; the next warm-cache pass restored only ATR and a short spike tail. It therefore pushed an empty trail set for the same eligible managed position. `TrailEngine::configure` replaces its entire account set, so an empty set removes that engine coverage. Broker SL/TP protection remains a separate receipt. This is a reproduced coverage defect, not a measured cause of historical losses or evidence of improved WR/PF.

The candidate retains the full fetched window and restores it on a cache hit from the same host/account. Unknown origin, another host/account or missing full bars triggers an authorised-source fetch. ATR period/multiplier, timeframe TTL, 500-entry bound, four-fetch concurrency, managed decision fence, book exclusion, SL/TP1, empty-set clearing of closed/disarmed positions and engine ratchet authority remain unchanged. The existing cache still holds one record per symbol/timeframe: alternating accounts can cause more bar fetches. Observe latency and broker load after any approved release; this patch does not certify load acceptance.

### A. Candidate and serving disposition

| Item | Refreshed receipt / disposition |
|---|---|
| Main | `1afda08fce6befd23d683fc1245e25c91e7d59d0` (#1227); unchanged |
| #1228 | Open, draft, unmerged, conflict-free, no auto-merge; head `4ea69e1071a8801b108aec858fc9605aac67c6c2`; base unchanged main |
| #1228 verification | Exact-head CI run [37173116382](https://github.com/ang-kl/bot-trade/actions/runs/37173116382) SUCCESS. Reused, not rerun. Recorded backend 7,487 pass / four native skips; frontend 1,317 |
| #1228 review | Reviews list empty; optional wrapper SUCCESS but actual review action SKIPPED. Existing manual review only; no independent review claimed |
| New correction | Distinct draft proposed on `fix/chandelier-warm-cache-2026-10-04`, stacked on #1228's branch. Its delta is the cache correction, two regressions and appended continuity/checkpoint text. It does not recreate or overwrite #1228 |
| New verification | Focused unchanged-source offline reproduction FAILED: pushed counts [1,0]. Corrected-source reproduction PASSED: [1,1], one bar read, zero errors, amendments, closes or database writes. Actual keeper/ATR/account/book modules; DB, management applicability and broker I/O are mocks. Both changed JS files pass Node syntax checks. Real SQLite regressions and full gates require the new exact-head CI; pending at capture |
| Serving bot | Railway `087b0a2d-e408-4fb5-9591-58003c6084e4`, SUCCESS; recorded commit remains main `1afda08`. Neither candidate is deployed |
| Other services | Six online, each 1/1 running, no active warning/critical or recent failure in the two-hour status sample. The old empty staged patch is untouched |
| Fresh behaviour | Active bot deployment window 07:05:50–07:12:04Z. Complete scan/analysis loops #311/#312/#313: 7.556/14.965/8.460 seconds. BTC long FVG analysis remains 5/10, R:R 1.5. No current fill is inferred |
| Protection | Independent broker reads 07:10:39.654–07:10:41.048Z (15:10 SGT): account counts 42993489=0, 43002148=0, 43069009=0, 43097342=1, 46130058=4, 46979908=2, 47790949=4. Eleven open; zero missing SL/TP1 |
| C++ attribution | Read cpp-exec deployment `cfb15390-68fe-4bbd-b874-e7b01a59046d` and cpp-acct `7dec1004-62a3-45ed-aaed-76d13095688b` by service/deployment identity. Both return no runtime entries in the bounded 07:05Z–read window; no engine or broker amendment certification |

Local workspace contained no Git checkout or recoverable October 1 unpublished patch. Sources were obtained from the approved GitHub connector, pinned and checked by Git blob hash. No synthetic history was adopted, reset, clean or force-push performed. The originating owner's unpublished work was inaccessible: its byte-for-byte preservation cannot be certified here. Parent #1228's instruction ledger and original checkpoint are retained.

The shell network proxy is unavailable; Git fetch cannot connect to proxy port 8080. Native SQLite, ESLint and Vitest dependencies are absent locally. No proxy bypass, credential extraction, account mutation, variable change or financial repair was attempted. GitHub/Railway connector reads remain available. A draft PR's existing CI is the available full-toolchain check; a focused mocked reproduction is not represented as the full gate.

### B. Close-gap register and exact blockers

| Population | Count / source timestamp | Observable fields / classification | Next retrieval and done-check |
|---|---|---|---|
| Combined close completeness | 17; bot log 2026-10-04T07:10:04.730224512Z | Missing P&L and/or postmortem; account, host, native currency, row/position/deal IDs and per-row missing field are absent from this log | Approved read-only row export of the exact completeness population, preserving the predicate and capture time. Each row needs identity, missing fields, reason and evidence source |
| Historical unpriced closes | 19; bot log 2026-10-04T07:10:04.410105385Z | All written off with a reason, broker history beyond horizon; money remains unknown. Per-row identity and write-off timestamp absent from log | Export the 19 written-off rows as well as ordinary unknown rows; retain reasons. Then seek archived whole-lifecycle statements/history where obtainable |
| Overlap / differences | Not Verifiable | No identity join available. 17+19 is not a certified 36-row population | Join by account/host and stable position/trade identity; report intersection and both differences, then classify missing lifecycle, ambiguous identity, horizon, exit attribution, money and postmortem gaps |
| Repair proposal | Waiting for evidence and owner approval | No guessed P&L, zero filling, deletion or history rewrite | Propose each exact supported row repair with broker-native signed costs and before/after values. Apply only within a separate explicitly approved scope |

A row-level register cannot be fabricated from these aggregate logs. No individual unknown row is claimed enumerated. Application read access (`AGENT_SECRET_READ`) is not configured in this environment. Configure it through environment secret settings, without putting values in chat, or supply current approved read-only exports. Useful supported readers include account-scoped `/state/ledger-reconciliation-rows`, `/state/position-history-missing`, `/state/unknown-pnl` and postmortems. The ordinary unknown reader may exclude written-off rows, so it alone does not establish the historical 19. The exact completeness/write-off row exports must include them.

Required row columns: capture timestamp, account ID, broker host, native currency, trade/position/order/deal identity, closed status/time, missing field names, stored net/cost/exit/postmortem state, write-off reason/time, source provenance, available broker evidence and proposed retrieval/repair. Financial repair remains a proposal.

### C. Statement identity and performance diagnosis

All five repository CSVs were fetched at pinned main and verified against their Git blob identities. Only account 42993489 matches the analysis's original SHA-256 manifest. The other four do not. CRLF/LF/BOM variants did not explain the mismatch. The inherited baseline is retained as dated evidence, but **was not rerun or recertified from these substitute bytes**.

| Account | Original manifest SHA-256 | Current repository CSV SHA-256 | Status |
|---|---|---|---|
| 42993489 | `984b5c82caab43b8aa26779e5db0fb33f4f7143cd76afb283f8bc52967e2faf6` | `984b5c82caab43b8aa26779e5db0fb33f4f7143cd76afb283f8bc52967e2faf6` | Passed |
| 46979908 | `21d8c99f3cbf45e9b4847268979c331d14b173dc8954af88df0c06b015ea738e` | `365a49cc414a880348f0bf0658263f3560bac0e6e8b4e2ad0ad798e81c2f4211` | Failed identity |
| 43097342 | `79006ea2c3e5da9124ff277626b5c8c9b2acf6182cd40ca934581b2f9d4a3af1` | `694a7b29fa9e055369094060b86c2fb74dc2ac147420b417cbdf15c1c07e93d5` | Failed identity |
| 46130058 | `5339f3f47169c5e8fc70c8a9639a492f7e0f9ceb137686dc8d9d43f9bf5e2960` | `29e81e93d6896ce620988ad97df07ded1a4e28b9ea67bd86f61d97d1cbb20a14` | Failed identity |
| 47790949 | `6699c86c76637763871e56e3facf93f162ed27993fd98aafa0ba83487cf5c472` | `54fba3f0ab0a00d2f921a236edd6cd45b8c8dae0e8777182fc175ba36213c2ff` | Failed identity |

Next: recover the four original uploaded statements through an approved evidence channel, or compare the replacement files at row level against originals and explicitly establish a revised provenance. Do not silently change the original manifest. The Python/notebook/JSON remain on #1228; historical statements never qualify the forward target.

Accounts 46130058 and 47790949 remain priorities based on the inherited loss baseline. Their historical proxies are not newly verified here, and lack certified whole-position/entry-strategy ownership. A causal strategy, stop-width, entry-timing, cost or exit-give-back ranking is **Not Verifiable** without a comparable complete population. The cache defect is one reproducible implementation finding; its financial impact is unquantified. D1–D4 research is reused and no unchanged replay grid was run.

Required analysis export: whole-position lifecycle and every partial deal, account/host/currency, entry strategy and source ownership, direction, original entry/stop/risk, volumes, entry/exit times and prices, gross plus signed commission/swap, separately reported conversion fee, broker exit cause, monitor linkage, timestamped MFE/MAE and final sample, full holding-period bar coverage and exclusions. Then compute net WR/PF, n, average win/loss and drawdown separately per native account. A retained last monitored sample and the postmortem's capped 400 bars do not certify final excursions.

### D. Chandelier acceptance chain

| Link | Current evidence | Gap / done-check |
|---|---|---|
| Broker-open population | Dated independent reads show 11 protected positions | This is not the eligible monitored non-book denominator |
| Ownership and eligibility | Source enforces authorised account, broker reconciliation, active monitor linkage, scope, guard/opt-out and momentum-book exclusion | Need per-position row identity, account/host, eligibility/exclusion reason, risk source and linkage |
| Bars, ATR and digits | Source uses full bars for since-entry 3 × Wilder ATR(22); actual mocked path reproduces warm-cache loss and local correction | Need current account/host-specific usable bars, timeframe/age, digits and spec receipt for each eligible position |
| Spec to engine | Empty configuration replaces engine coverage; local corrected path retains one eligible spec on a warm hit | Need accepted live configuration and engine read-back; no coverage inferred from successful deployment |
| Engine to broker | Never-loosen source rail unchanged; SL/TP1 exist in dated independent reads | Need naturally occurring amendment and broker read-back for the same position/host/account |
| Empirical benefit | Not assessed | Comparable complete after-cost exits and final excursions before any WR/PF benefit claim |

No manual amendment, forced order or instrument activation was issued. Open crypto can provide natural evidence only where an actual eligible monitored non-book position exists; current broker IDs/specs are inaccessible. Other instruments wait for their actual sessions, with no global Monday opening time substituted.

### E. Done / next / waiting and carried groups

Done: unchanged #1228 disposition/check refresh; dated serving/protection/loop reads; exact CSV identity audit; one red-to-green cache reproduction and minimal local correction; two genuine repository regressions added; source/syntax review. New full gates and independent review are not yet certified at capture.

Next: run the distinct draft's existing full CI once, bind its result to the exact final head, inspect the complete diff and actual review action. Record final receipts in the hand-back without a docs-only source change. Obtain the precise data exports above, then reconcile gaps and eligible trailing rows before any financial conclusion.

Waiting: project owner for scoped merge/deployment; secure read access or exports for application/broker identities; original statement evidence; natural eligible fills, final partials and broker trail amendments; completed forward SGT days. The expired morning authority is not reused. There is no unattended monitor or new schedule.

For the following retained groups, implementation means the next authorised evidence task; owner means project owner for policy and acceptance. Frozen acceptance contracts and earlier failed receipts remain in force. None is closed by this patch.

| Group | State / owner | Smallest next action / done-check | Evidence age / limits |
|---|---|---|---|
| P0/P3 | Waiting for natural event; implementation / owner acceptance | Trace an ordinary eligible fill through partial/final lifecycle, ownership, reservation and protection; required receipts for every step | Earlier handovers inherited; no new broker fill in this task |
| P1/P4 | Next; implementation / owner acceptance | Capture phase/load/recovery timing and actual device/request failure traces; meet the original bounded acceptance contract | New loops #311–313 only; not continuous load or device acceptance |
| P2 | Next; implementation; owner for roster changes | Refresh account roster and per-instrument calendars/holiday/DST/Sunday coverage; compare configured and broker-owned identities | Seven protection reads at 15:10; calendar/current roster fields unavailable |
| P5a | Waiting for evidence; implementation / owner scope | Reconcile independent watchdog, bounded detection/recovery and verifier incident ageing with current removals; obtain incident receipts | Six service states at 15:12 are not watchdog acceptance |
| P5b/P5d | Waiting for read access / owner repair | Enumerate the two close populations, reconcile identities and full costs/exits/currency; approve exact supported repair separately | Aggregate 17/19 at 15:10; per-row join unavailable |
| P5c | Next when reads available; owner for payload mutation | Refresh scanner registry/account alignment, profiles/cells/parity, HTTP400/code56 causes and broker instrument names | Earlier D1–D4 and handover receipts retained; no alignment mutation |
| P6/P7 | Waiting for natural/time evidence and owner soak scope | Qualify tick samples/replay and promotion/retirement; run 24-hour soak only if separately authorised | Tick shadow and timeframe entries remain distinct; no new replay or activation |
| P8 | Next when reads available; implementation / owner scope | Collect recorder caps/gaps/drops/spool/volume/recovery receipts; compare to retention/capacity contracts | No fresh durable storage/recovery proof |
| REC/WEB | Partial; implementation | Obtain fresh account-native report data and outcome-relevant UI traces; preserve missing evidence in display | #1228's UI correction verified on its unchanged head; no new browser/device certification |
| Stop-policy broker semantics | Waiting for natural broker receipts; owner for manual operations | Verify trailing read-back, omitted-flag reset, anchor and TP trigger semantics independently | Source ratchet checks do not certify the four broker behaviours |
| Owner decisions | Waiting; owner | October 10 account/funding/loss cap, alignment payloads, pooled switch-off, tick activation, Monday freeze, variables and named manual operations | No choices inferred or executed |
| October 1 unpublished work | Waiting for original checkout; owner / implementation | Inventory originals, distinguish superseded and remaining changes without destructive cleanup | Not present in this cloud snapshot; remote preservation Not Verifiable |
| V3 acceptance | Waiting; owner | Close only with group-specific required receipts and owner acceptance | Noon acceptance remains incomplete |
| Removed observer/Telegram | Superseded; owner for remaining human backlog | Retain removals; reconcile any remaining human credential/backlog item without rebuilding authority | No removed delivery or stop service recreated |
| Log cosmetics / unrelated UI | Later | Reopen only if it blocks a selected causal diagnosis | No cosmetic patch |

### F. Goal assessment, invariants and release boundary

**Win rate: Not Assessed. Profit factor: Not Assessed, separately for every account.** No complete eligible after-cost whole-position population after 2026-10-03T23:35:00Z was obtained. The latest-20 route and the three/eight completed-SGT-day routes remain separate OR routes per metric; today is provisional. Unknown or unattributed qualifying outcomes are not dropped. USD/SGD are not pooled, PF ratios are not averaged, no-loss PF remains undefined, scratches are non-wins, and partial deals count once when the entire lifecycle closes.

| Material invariant | Status | Actual check / age / limit |
|---|---|---|
| Native money and signed-cost treatment | Passed for correction scope; live calculation Not Verifiable | Code delta changes no financial fields/formula; focused managed path zero DB writes. Current complete lifecycle export unavailable |
| Whole-position population and exclusions | Not Verifiable | No certified forward or historical lifecycle dataset; no sample inflated or exclusion silently removed |
| Account/host ownership | Passed for source/focused mock scope; live Not Verifiable | Own account fence retained; new warm-cache reuse requires matching host/account. Negative real-DB regressions await new CI |
| SL/TP1 protection | Passed for dated independent sample | Seven broker reads at 15:10 SGT: all 11 protected. Not continuous or dynamic-trailing acceptance |
| Never-loosen authority | Passed for source scope; broker behaviour Not Verifiable | Engine source unchanged; generated spec preserves current SL/TP1 in mocked path; no natural amendment receipt |
| Approved risk/activation | Passed for change scope | No risk/default/gate/registry/variables/activation edits or mutations. No manual order |
| Reporting-only targets | Passed for change scope | Assessor/dispatch source untouched by this delta; no target entry veto introduced |
| Truthful missing evidence | Passed for this report | Unknown P&L retained; no 17+19 sum; four statement hash failures explicit; no invented review, data or benefit |
| Exact statement identity | Failed for four repository CSVs | Pinned-byte audit above; earlier five-match PASS applies only to its original files and capture |
| Exact tested source | Passed for focused local receipt; full gate pending | Unchanged source SHA-256 `deba4c8479fd6efc2a85d4ee96b22dcad97c2d3b47b324a2c85b78b8d50eea39` fails [1,0]; corrected `c00e73dd8e682f5daed1b21c40600674308777971d541146e376e9fe4e9f5620` passes [1,1]. New exact-head CI required |
| Independent review | Not Verifiable / absent | Self source review is not independent; no PR review receipt. #1228 automated actual action skipped |
| Exact released identity | Not Verifiable for candidate / not released | Serving baseline is unchanged; draft/local preparation is not deployment |
| Unpublished-work preservation | Passed for available workspace; originating work Not Verifiable | No reset/clean/force-push or synthetic history; inaccessible original checkout cannot be certified |
| Natural events / full V3 acceptance | Not Verifiable | No forced order, manual trail amendment or scheduled soak; owner/time/data receipts remain open |

**Release is WAITING FOR APPROVAL.** Before any approved release, identify the concrete PR/head(s), merge order and affected services. The new draft depends on #1228; approving one does not silently approve the other. Expected production impact for this cache change is the Node bot-trade service using existing C++ trailing; native code is unchanged, but exact release configuration must be checked. After release verify merge SHA, serving commit, complete fresh cycles, protections/errors/refusals/completeness and same-position natural broker receipts.

Rollback baseline: Node bot-trade commit `1afda08fce6befd23d683fc1245e25c91e7d59d0`, deployment `087b0a2d-e408-4fb5-9591-58003c6084e4`, service `04945f5c-03d4-4d3f-bec1-f4debcefe5e6` in the stated Railway production environment. A source rollback needs its own authorised action and does not undo broker actions already executed. No merge/deploy approval is requested before the concrete checked candidate is ready.

## 9. Publication boundary — 4 October 2026, 15:19 SGT

**No remote candidate was created.** Automatic approval review rejected `github_create_tree` for publication to `ang-kl/bot-trade`: the direct request authorised reading the attachment, not writing proprietary source and documentation to that repository. No tree SHA, commit, branch or new PR was created, and no workaround was attempted. #1228 and production remain unchanged.

The implementer had interpreted the attached continuation brief as an instruction to execute beyond the direct read request. Local preparation is reversible and remains available for review. The final four-file patch targets the genuine #1228 parent `4ea69e1071a8801b108aec858fc9605aac67c6c2` and preserves that parent's instructions and checkpoint. Publication requires explicit approval of this concrete patch/draft scope; merge/deployment would still require separate exact-head approval.

Additional focused offline boundary checks PASSED for foreign host, foreign account and missing full bars: three own-source fetches, three valid since-entry specs, zero amendments/closes/database writes. These checks still use mocked database and broker I/O. The two real SQLite regressions have **not** run, full local gates are blocked by unavailable toolchain/network, and new CI has **not** started. Independent review remains absent. Earlier “pending at capture” wording does not mean a CI run was launched.

Done: attachment read, repository/serving read-only refresh, local reviewable correction, focused red/green and boundary evidence, exact identity audit, appended carry-forward register. Next: owner reviews the patch and decides whether to authorise draft publication plus existing CI. Waiting: that publication decision, secure app read access/exports, original statement bytes and natural/time-dependent acceptance. WR and PF remain Not Assessed for each account. Material live/whole-lifecycle/release/unpublished-original invariants remain Not Verifiable as listed above. Continuation lower bound through № 11,088; later replies take precedence.
