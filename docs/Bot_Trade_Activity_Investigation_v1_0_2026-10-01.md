# Bot-Trade investigation: uneven trading and continuing position management

Version 1.0 | 1 October 2026 | Requested statement cutoff: 06:22 SGT

## Executive finding

**There was no complete four-day trading or management stoppage across the five accounts.** The statements contain **16 distinct observed opening groups and 27 closing deals** from 28 September 00:00 to 1 October 06:22 SGT. Fifteen opening groups are reconstructed from deal rows labelled `openapi_cbot-t`; one NatGas opening is associated with `openapi_Tradingview`. Logs corroborate bot partial exits and trailing-stop activity.

**The inactivity concern is valid for particular accounts.** The larger demo accounts were blocked from ordinary new bot entries by position capacity. The supplied live account was blocked by a pending BTC order's estimated margin reservation, with a currency-handling defect affecting the calculation. Automated strategy disarms also occurred after the 28 September restoration and persisted through a restart.

**If “live trades” means real-money accounts, the scope matters:** four supplied statements map to the demo server. The sole supplied live-server account, `42993489`, has no recent fills and no open positions at the statement snapshot. It does have a pending BTC limit order. Activity on the four demo accounts is not proof of real-money execution.

Investigation only. No orders, positions, risk limits, trading switches, credentials, code releases or deployments were changed.

## 1. What the statements establish

The primary window covers four calendar dates but only **78 hours 22 minutes**. Checking the alternative rolling 96-hour window beginning 27 September 06:22 gives the same observed opening and closing counts. All statement timestamps explicitly use UTC+8. The snapshot cutoff of 06:22 is user supplied; the filenames show exports at 06:24-06:27 and the CSVs do not embed an export timestamp.

An “opening group” is a distinct account, symbol, direction, opening timestamp and entry-price combination, reconciled with remaining Positions rows. It is an observable proxy, not a broker Position ID count. Partial closing rows are grouped to avoid counting the same opening twice. Order submissions, cancellations, rejections and volume additions cannot all be counted from this export.

| cTrader account ID | Server | Currency | Observed new openings | Closing deals | Open positions | Pending orders | Window net P&L | Source |
|---|---|---|---|---|---|---|---|---|
| 42993489 | Live | SGD | 0 | 0 | 0 | 1 | 0.00 | S1 |
| 43097342 | Demo | SGD | 12 | 16 | 2 | 0 | -17.98 | S2 |
| 46130058 | Demo | USD | 0 | 1 | 5 | 0 | -18.06 | S3 |
| 46979908 | Demo | USD | 3 | 5 | 4 | 0 | 1.57 | S4 |
| 47790949 | Demo | USD | 1 | 5 | 8 | 2 | -1,485.79 | S5 |


The account IDs in parentheses in the filenames are the bot/cTrader account identifiers used in logs. The leading filename numbers are reproduced in the source register; no identity is inferred from similar-looking numbers. Server classification comes from the runtime cashflow collector's explicit account/host mapping at 06:25-06:32 SGT, just after the statement cutoff. No currency conversion or aggregation of SGD with USD is used.

For `47790949`, the sole new opening is the TradingView-labelled NatGas deal, which lost USD 990.00. Its other four closing deals concern earlier positions and carry `openapi_cbot-t`. The full USD 1,485.79 loss must not be attributed to new bot entries. A Channel field identifies the platform/method on the deal; it is not a complete audit of who requested every order or amendment.

### Activity by Singapore calendar date

| Date | Observed new opening groups | Closing deals |
|---|---|---|
| 2026-09-28 | 6 | 7 |
| 2026-09-29 | 4 | 11 |
| 2026-09-30 | 5 | 7 |
| 2026-10-01 | 1 | 2 |


The last row ends at 06:22, so it is not a full-day comparison. The latest observed opening is LLY.US on `43097342` at **01 October 01:55:54**, and the latest closing deal is a COST.US partial at **03:50:18**. These directly refute a blanket absence of new trades.

## 2. Why activity differs by account

| Account | Supported explanation | What this does and does not prove |
|---|---|---|
| 42993489 | An existing BTCUSD buy limit reserves estimated margin of 1,106.32 against a logged cap of 20.58. Statement balance/free margin are SGD 51.46, open margin 0.00; no open positions. | Explains exclusion from the bot margin pool. The calculation mixes a native SGD balance with USD-oriented risk inputs; 1,106.32 is not broker-reported used margin. |
| 43097342 | Twelve recent opening groups and 16 closing deals. Capacity intermittently reached 5/5, then reopened as positions closed. Later proposals also encountered strategy OFF, R:R and minimum-lot checks. | This account demonstrably traded and had positions managed. An individual blocked cycle is not a four-day outage. |
| 46130058 | Six counted positions on 28 September became five after KO.US closed. Logs still show max_positions=5/5. Statement has five positions and no pending orders. | The ordinary entry cap is reached despite USD 30,302.69 balance and USD 29,044.40 broker free margin. More money does not create another position slot. |
| 46979908 | Three recent opening groups and five closing deals. Capacity was 5/5 in earlier samples; four positions remain. Some strategies were disarmed and other proposals failed R:R or minimum-lot affordability. | Neither permanently full nor completely inactive. One available slot does not guarantee an eligible signal. |
| 47790949 | Eight open positions plus two Cocoa stop orders explain max_positions=10/5 at cutoff. Earlier samples show 14/5 then 12/5 as positions close. | No unexplained two-slot excess remains at the snapshot. Cancelling the two orders alone would still leave eight positions above the ordinary five-position cap. |


### Capacity evidence over the window

The following are sampled runtime readings, not continuous measurements or averages:

| SGT sample | 43097342 | 46130058 | 46979908 | 47790949 |
|---|---|---|---|---|
| 28 Sep 13:00-13:10 | 5/5 | 6/5 | 5/5 | 14/5 |
| 29 Sep 12:00-12:10 | 5/5 observed | 5/5 | 5/5 observed | 12/5 |
| 30 Sep 12:00-12:10 | No capacity block claimed from this sample | 5/5 | No capacity block claimed from this sample | 10/5 |
| 01 Oct 06:10-06:22 | Statement: 2 positions, 0 orders | 5/5 | Statement: 4 positions, 0 orders | 10/5 = 8 positions + 2 orders |


The ordinary gate counts positions and working entry exposure. It does not immediately close an existing position simply because the current total exceeds the cap. Separate momentum and externally originated orders have their own paths, so the TradingView-labelled NatGas deal is not evidence that the ordinary bot gate admitted it.

The remaining gates also produced explicit pre-cutoff refusals. At 06:20:21, UBER.US on `43097342` failed `bad_rr 2.36<3`; at 06:21:28, GD.US failed `2.00<3` on both `43097342` and `46979908`. At 06:10:17, the GBPUSD minimum lot on `46979908` was estimated to risk USD 13.29 against a USD 7.02 budget. At 06:12:25, US2000 was rejected because its proposed direction conflicted with the detected market regime. These are logged decision reasons, not independent validation of the signal models, and they do not justify increasing risk to force a trade. Repeated “49 proposals” decision-audit summaries were not added together because they may describe an overlapping audit window.

### The earlier pending-order uncertainty is now substantially resolved

The earlier handover recorded working ledger entries but lacked independent current confirmation that the orders still existed. The new broker-exported statements list:

| Account | Pending order | Submitted SGT | Quantity / price | TP / SL in export |
|---|---|---|---|---|
| 42993489 | BTCUSD Buy Limit | 02 Feb 2026 12:25:01.657 | 0.05 lots at 44,252.71 | Both blank |
| 47790949 | Cocoa Buy Stop | 03 Sep 2026 17:05:47.440 | 1 lot at 6,347.6 | TP 6,450.9; SL blank |
| 47790949 | Cocoa Buy Stop | 03 Sep 2026 17:05:59.944 | 1 lot at 6,347.6 | TP 6,450.9; SL blank |


These are not merely old local records: they appear in the current statement's Orders section. The two Cocoa orders have distinct submission times. The CSV does not include pending Order IDs, so matching them to historical IDs `358927828` and `358927854`, and BTC ID `333512466`, is based on matching account, instrument, size and price rather than a new ID-level receipt.

The BTC arithmetic is reproducible: `0.05 × 44,252.71 × 0.50 = 1,106.31775`, rounded to **1,106.32**. The stored-balance cap is `51.46 × 0.40 = 20.584`, rounded to **20.58**. The source first requests a USD broker snapshot; when that cannot be used, it estimates exposure and adds pending-order reservations. The balance writer stores the broker-native balance under an `account_balance_usd` key. This is a real currency-provenance problem, not evidence that the broker has consumed SGD 1,106.32 of margin.

For Cocoa, `2 × 6,347.6 × 0.05 = 634.76`, exactly the difference between the statement's USD 2,844.94 margin and the bot's logged USD 3,479.70 used/reserved margin. This supports the additional-reservation mechanism. It is an arithmetic and source-code reconciliation, not a fresh execution of the deployed function against its database.

**Pending-order protection needs explicit review.** All three pending orders have blank SL fields; BTC also has no TP field. That does not mean the 19 filled positions lack protection. Whether a separate component would attach protection upon a future fill is not established by these exports. No order was cancelled or amended.

## 3. Strategies were automatically disarmed after restoration

[PR #1173](https://github.com/ang-kl/bot-trade/pull/1173) restored the ordinary intraday producer and issued a one-time strategy/account rearm. It explicitly retained later risk-guard disarms. The human-only restriction implemented there protected master/account **Scan OFF** writes; it was not a permanent exemption from **Trade OFF** controls.

The following are actual action logs, distinct from warnings that merely say a strategy “would be disarmed”:

| SGT timestamp | Controller | Observed action |
|---|---|---|
| 28 Sep 11:46:14 | Edge watchdog | Disarmed fib_618_fade globally and on 46130058/47790949; rsi_meanrev and va_breakout globally. |
| 28 Sep 15:07:08 | Edge watchdog | Disarmed vwap_trend globally and on 46130058. |
| 28 Sep 21:32:46 | Edge watchdog | Disarmed vp_value globally and on 46130058/47790949. |
| 28 Sep 21:39:03 | Adaptive breaker / edge watchdog | Breaker disarmed fvg_retrace; watchdog disarmed donchian_breakout globally and on 46130058/46979908/47790949. |
| 28 Sep 22:03:05 | Adaptive breaker | Disarmed va_breakout. |
| 29 Sep 21:35:20 | Edge watchdog | Disarmed rsi2_reversion globally and on 43097342/46130058. |
| 01 Oct 05:17:36 | Boot seeds | Left previously disarmed entries off. Global seed reported six on and seven previously disarmed. Account phase order reported seven already ordered, no new application. |


At **01 October 05:32:06**, the arming audit reported five ratcheted-off account cells across four accounts: `46130058` donchian_breakout/rsi2_reversion; `43097342` rsi2_reversion; `46979908` donchian_breakout; `47790949` donchian_breakout. Separate boot records include other held seed entries; the “20 held” boot count includes legacy and restoration seed tokens and must not be presented as 20 unique currently disabled strategies.

Fresh pre-cutoff logs still show `rsi2_reversion` OFF on `43097342` and `donchian_breakout` OFF on `46979908`. The watchdog's recorded inputs include negative expectancy/profit factor; the adaptive breaker uses loss-streak evidence. Their inputs were not independently recalculated from a complete strategy-labelled broker history in this investigation, so their statistical justification is not newly certified.

**Interpretation:** the restoration worked, but automatic controls subsequently narrowed the tradeable strategy set. The promise “all strategies remain on until a human switches them off” is not the behaviour implemented by #1173. Global scanning continued in the inspected logs. A future change to who may disarm trading is a policy decision with a distinct approval scope; it must not be smuggled into a bug fix or achieved by relaxing risk limits.

## 4. Existing positions were being managed

The bot logs and broker statement rows agree on concrete management events:

| Account / instrument | Bot log in SGT | Statement evidence | Conclusion |
|---|---|---|---|
| 43097342 / PANW.US | 29 Sep 00:01:14 PARTIAL_EXIT | DID321713806 at 00:01:13.863 closes 0.4 lots; DID321900081 later closes 0.5 lots. | Partial reduction followed by a later closing deal. |
| 46979908 / WMT.US | 29 Sep 21:32:28 PARTIAL_EXIT | DID321900224 at 21:32:28.128 closes 0.8 lots; DID321901708 at 21:35:31.754 closes 0.8 lots. | Active partial management corroborated. |
| 43097342 / NatGas | 30 Sep 18:46:09 PARTIAL_EXIT | DID322069661 at 18:46:09.711 closes 0.01 lots; DID322069998 at 18:49:30.443 closes 0.01 lots. | Active partial management corroborated. |
| 43097342 / COST.US | 01 Oct 03:50:19 PARTIAL_EXIT; repeated MOVE_SL logs | DID322195271 at 03:50:18.593 closes 0.1 lots; 0.2 lots remain with SL 913.77 and TP 900.21. | A runner remained after the partial close; stop-management activity is logged. |
| 43097342 / TSLA.US | 29 Sep 21:32:22 FULL_EXIT, time_cap_expired | DID321900184 at 21:32:22.140 closes 0.3 lots. | A bot-directed full-exit event is corroborated. |


The matching uses account where logged, instrument, precise timing and statement details; some fast-monitor log messages omit account and broker position IDs. In the COST case, it is the sole COST position in these statements. This corroborates the events without claiming a complete ID-linked management audit.

### A newly confirmed reporting defect: requested versus executed partial percentage

COST's log says “closed 50%” and “runner 0.20L”, while the statement records **0.10 lots closed and 0.20 remaining**. That observed split is one-third closed, not one-half. PANW similarly records 0.4 then 0.5 lots despite a 50% label on the first partial. The source floors the requested partial to the broker's volume step, but prints the original requested fraction in its success summary. The label therefore does not report the executed percentage. Broker volume-step metadata was not retrieved here; the code path and observed mismatch establish a reporting defect, not an unauthorised volume repair.

### Protection is present, but continuous management quality is not fully proved

- All **19 open positions** in the five exports have nonblank SL and TP values. The independent protection readings at approximately **06:20:53 SGT** agree: 2/5/4/8 positions on the four demo accounts, none missing SL or TP1; the three live-server accounts report zero positions.
- Eighteen of the 19 positions opened before the investigation window. Old holdings naturally make the Positions screen look unchanged. Age alone does not prove that the bot failed to evaluate or trail them.
- At **06:21:34**, the momentum pass reports zero entries/exits/trails on four accounts and **one exit held for a closed market**. At **05:30:36**, an earlier pass reports two trails. A “0 trailed” pass is a no-action result, not proof that the service stopped.
- The fast monitor repeatedly logs “previous pass still running” and skipped ticks in the latest sample. Code explicitly prevents overlapping passes. This establishes cadence degradation/overlap pressure, not a four-day absence of monitoring. Per-position evaluation age and missed actionable exits remain unmeasured.
- The management path also has separate manage-stage and external-position gates. The source observes externally owned positions without automatically taking them over. The historical ownership/status of every held position was not retrieved, so no claim is made that every open position was actively managed throughout the entire window.

The exact symbol/account behind the deferred momentum exit, its first eligible close time, and whether the market classification was correct require the decision/position event ledger. The CSV cannot establish that an earlier exit should have occurred. No counterfactual profit or “missed gain” is claimed.

## 5. Remaining software and evidence defects

1. **Zero-balance margin exception remains in production.** At 06:19:18 SGT, logs record `Cannot read properties of null (reading 'usedMargin')`. The deployed code allows `balance != null` into the margin gate but returns null from the margin function when `balance > 0` is false, then dereferences it. The earlier local fix is still unpublished. Current exact balances of live accounts `43002148` and `43069009` are not in the five statements; runtime describes no balance on record. Do not infer funded readiness from their enabled state.
2. **Currency handling remains unresolved for SGD accounts.** Both `42993489` and `43097342` are SGD-denominated. USD-only snapshot validation and native balance values stored under USD-labelled keys can force estimates and invalidate money comparisons. This is distinct from a genuine no-budget refusal.
3. **Accounting/UI evidence is incomplete.** The 05:17 boot audit reports only 81 complete histories out of 1,350 local closed-position histories. At 06:30, a post-cutoff sample reports 28 closed trade rows missing net P&L, including 22 already written off and six still repairable. These database populations differ from statement closing-deal rows and cannot be reconciled by comparing their raw counts. They are a plausible reason for incomplete UI explanations, not proof that the user's screen caused the apparent inactivity.
4. **The two inherited local fixes have not reached production.** GitHub main and the latest Node deployment still identify `8629232` from #1173. The handover's zero-balance and strategy Scan OFF permission fixes remain local. Their earlier tests do not prove deployed behaviour. This investigation did not run a release test suite or change those files.

## 6. What should happen next

These are proposed follow-ups, not actions performed by this report.

1. **Review the three pending orders with their broker IDs and current protective instructions.** Resolve whether the owner still intends each order. Any cancellation or protection amendment requires a separately scoped approval. Their existence is now evidenced; deleting “stale” ledger rows on the old hypothesis would be unjustified.
2. **Complete the currency contract and zero-balance fix before judging live entry readiness.** Use broker-native amounts plus explicit currency/conversion provenance, preserve numerical limits, and return a clear refusal when funding is absent. Follow the existing handover's tests, review and release gate.
3. **Settle the automatic trade-disarm policy explicitly.** Decide whether strategy controllers may disarm on measured losses or should report for human approval. Keep emergency protection and hard risk limits separate from strategy permission. The current source deliberately preserves later disarms across restart.
4. **Audit management by account and position ID.** Retrieve per-position last-evaluated time, current manage/ownership state, decision, market status, amendment acknowledgement and broker readback. Trace the closed-market deferred exit and repeated busy passes. This will answer whether a particular held trade was neglected.
5. **Correct partial-exit reporting and verify realised attribution.** Record requested fraction, actual executed units, remaining volume and realised net cost separately. The COST example demonstrates why a “50% closed” log cannot be used as broker truth.

Do not raise the five-position cap, increase permitted risk, force entries, rearm all strategies, activate scanners or cancel pending orders merely to make activity appear. Each would change policy or exposure without resolving all the observed defects.

## 7. Relationship to the existing V3 work

| Reference | How this investigation changes the evidence |
|---|---|
| [PR #1170](https://github.com/ang-kl/bot-trade/pull/1170) | Its resting-exposure count and margin mechanism explains the pending-order effects. Current statements now corroborate that the BTC and Cocoa orders exist. |
| [PR #1171](https://github.com/ang-kl/bot-trade/pull/1171) and [PR #1172](https://github.com/ang-kl/bot-trade/pull/1172) | Ordinary partial exits are now corroborated. They do not by themselves prove the separate terminal partial-entry-fill contract, atomic reservation handover or complete V3 acceptance. |
| [PR #1173](https://github.com/ang-kl/bot-trade/pull/1173) | Deployment succeeded at 28 Sep 11:44:26 SGT. PANW and UBER subsequently have actual broker-exported opening evidence. Later automatic strategy disarms are now observed, not merely possible. |
| [Handover in draft PR #1174](https://github.com/ang-kl/bot-trade/pull/1174) | Its zero-balance, scan-authority and currency work remains outstanding. The old “pending orders might be stale” uncertainty must be updated with these statements. |

The new evidence establishes operation on parts of the system. It does not close all seven-account, protection-latency, accounting, scanner or V3 acceptance requirements.

## 8. Method and verification limits

The analysis read the five supplied local CSV copies without modifying them. Python's CSV parser handled section boundaries and nonbreaking-space numeric formatting; Decimal arithmetic was used for money. Blank-ID subtotal rows were excluded from deal counts. All 1,421 closing-deal rows parsed, with no duplicate Deal IDs within an account, malformed row lengths or reversed opening/closing timestamps. Sums of Net values reconcile exactly with each statement's reported Deals subtotal, shown below.

Opening groups use the full displayed timestamp. For matching the Positions table, timestamps are compared at whole-second precision because that section omits milliseconds; the selected recent groups had no competing same-account/symbol/direction/price match. This provides a useful count of observable openings but not complete order or scale-in history. No order request count is fabricated.

The original exports have no explicit reporting-period header. Their earliest closing dates range from 9 to 30 July; some opening dates precede July because older positions closed during the exported period. The requested three-month coverage is taken from the user and is not independently certified as an exhaustive broker history.

All primary-window findings use source events at or before 06:22. The separately labelled 06:25-06:32 runtime sample corroborates host mapping and continued operation; it is not silently included in the statement period. Log retrieval was filtered and bounded, with counts and limits below. Absence from a capped or filtered log result is not proof that an event never happened.

Fresh read-only retrieval covered GitHub PR/main metadata, Railway deployment metadata and runtime logs. Local source inspection used the deployed Git commit for the modified risk file, avoiding the unpublished working-tree version. No production SQL, broker mutation, browser setting change or release command ran. cTrader's official History documentation was checked for the meanings of opening time, closing deals, Channel, volume and net realised P&L. No market forecast, investment recommendation or external FX assumption was used.

AI interpretation is not independent verification. The statement rows, statement subtotal controls, runtime records and inspected source are the evidence. Some protection records share the same application/reporting path; the broker exports provide a separate corroborating artifact, not continuous telemetry.

## Appendix A. Supplied source register and arithmetic controls

| Ref | Original filename | Closing-deal rows | Currency | Full-export net subtotal | Recomputed total |
|---|---|---|---|---|---|
| S1 | 1251247 Pepperstone (42993489) statement-06_25 01.10.2026.csv | 6 | SGD | 16.65 | Exact match |
| S2 | 5067353 Pepperstone (43097342) statement-06_26 01.10.2026.csv | 284 | SGD | 1,634.69 | Exact match |
| S3 | 5203012 Pepperstone (46130058) statement-06_27 01.10.2026.csv | 564 | USD | -19,489.01 | Exact match |
| S4 | 268549 Pepperstone (46979908) statement-06_26 01.10.2026.csv | 96 | USD | 163.22 | Exact match |
| S5 | 5306502 Pepperstone (47790949) statement-06_24 01.10.2026.csv | 471 | USD | -6,874.49 | Exact match |


Checksums identify the exact inputs used:

| Ref | SHA-256 |
|---|---|
| S1 | 984b5c82caab43b8aa26779e5db0fb33f4f7143cd76afb283f8bc52967e2faf6 |
| S2 | 79006ea2c3e5da9124ff277626b5c8c9b2acf6182cd40ca934581b2f9d4a3af1 |
| S3 | 5339f3f47169c5e8fc70c8a9639a492f7e0f9ceb137686dc8d9d43f9bf5e2960 |
| S4 | 21d8c99f3cbf45e9b4847268979c331d14b173dc8954af88df0c06b015ea738e |
| S5 | 6699c86c76637763871e56e3facf93f162ed27993fd98aafa0ba83487cf5c472 |


## Appendix B. Every observed recent opening

Source lines are 1-based CSV line numbers. Each row below is one opening group, not one closing deal. All except the marked TradingView row have `openapi_cbot-t` on associated deal rows.

| Account | Opened SGT | Instrument | Direction | Entry price | Evidence |
|---|---|---|---|---|---|
| 46979908 | 28 Sep 2026 20:46:23.771 | US2000 | Buy | 2828.2 | S4 deal line(s) 6 |
| 43097342 | 28 Sep 2026 21:31:00.289 | UBER.US | Buy | 69.21 | S2 deal line(s) 18 |
| 43097342 | 28 Sep 2026 21:31:00.365 | PANW.US | Buy | 372.59 | S2 deal line(s) 15,16 |
| 43097342 | 28 Sep 2026 21:35:56.800 | JPYX | Buy | 692.2 | S2 deal line(s) 17 |
| 43097342 | 28 Sep 2026 21:52:42.612 | TSLA.US | Buy | 362.07 | S2 deal line(s) 14 |
| 46979908 | 28 Sep 2026 22:00:11.000 | JPYX | Buy | 692.0 | S4 deal line(s) 5 |
| 46979908 | 29 Sep 2026 02:00:52.306 | WMT.US | Sell | 108.71 | S4 deal line(s) 3,4 |
| 43097342 | 29 Sep 2026 21:34:06.885 | DOW.US | Buy | 27.43 | S2 deal line(s) 12 |
| 43097342 | 29 Sep 2026 22:37:32.638 | JPM.US | Buy | 335.67 | S2 deal line(s) 11 |
| 43097342 | 29 Sep 2026 23:43:40.560 | GD.US | Sell | 331.19 | S2 deal line(s) 10 |
| 43097342 | 30 Sep 2026 10:03:40.496 | NatGas | Buy | 2.886 | S2 deal line(s) 9 |
| 43097342 | 30 Sep 2026 16:35:26.255 | NatGas | Buy | 2.892 | S2 deal line(s) 7,8 |
| 47790949 | 30 Sep 2026 18:02:14.523 | NatGas | Buy | 2.902 | S5 deal line(s) 3 / TradingView |
| 43097342 | 30 Sep 2026 20:33:21.286 | AUDUSD | Sell | 0.69848 | S2 deal line(s) 6 |
| 43097342 | 30 Sep 2026 23:59:44.458 | COST.US | Sell | 918.77 | S2 deal line(s) 3 / Positions line 292 |
| 43097342 | 01 Oct 2026 01:55:54.236 | LLY.US | Sell | 1176.01 | S2 deal line(s) 4 |


## Appendix C. Every closing deal in the window

These are closing deals, including partial reductions; 27 is not a count of 27 independent positions.

| Account | Deal ID | Closed SGT | Instrument | Closed lots | Net in account currency | Source line |
|---|---|---|---|---|---|---|
| 46979908 | DID321586017 | 28 Sep 15:03:37 | 0066.HK | 13 Lots | USD -0.20 | S4:7 |
| 46979908 | DID321663039 | 28 Sep 21:30:06 | US2000 | 0.1 Lots | USD -0.73 | S4:6 |
| 46130058 | DID321664817 | 28 Sep 21:31:43 | KO.US | 17 Lots | USD -18.06 | S3:3 |
| 47790949 | DID321666212 | 28 Sep 21:33:49 | GD.US | 11.1 Lots | USD -569.74 | S5:7 |
| 43097342 | DID321668029 | 28 Sep 21:35:21 | UBER.US | 22.7 Lots | SGD -21.19 | S2:18 |
| 43097342 | DID321668465 | 28 Sep 21:36:05 | JPYX | 5 Lots | SGD -4.48 | S2:17 |
| 46979908 | DID321677873 | 28 Sep 22:00:21 | JPYX | 1 Lots | USD -0.70 | S4:5 |
| 43097342 | DID321713806 | 29 Sep 00:01:13 | PANW.US | 0.4 Lots | SGD 7.98 | S2:16 |
| 47790949 | DID321812589 | 29 Sep 09:31:53 | 0005.HK | 263 Lots | USD 154.77 | S5:6 |
| 43097342 | DID321900081 | 29 Sep 21:32:04 | PANW.US | 0.5 Lots | SGD 8.49 | S2:15 |
| 43097342 | DID321900184 | 29 Sep 21:32:22 | TSLA.US | 0.3 Lots | SGD -3.29 | S2:14 |
| 46979908 | DID321900224 | 29 Sep 21:32:28 | WMT.US | 0.8 Lots | USD 1.14 | S4:4 |
| 47790949 | DID321900228 | 29 Sep 21:32:28 | KO.US | 13.3 Lots | USD -20.35 | S5:5 |
| 47790949 | DID321900229 | 29 Sep 21:32:29 | JPM.US | 5.3 Lots | USD -60.47 | S5:4 |
| 43097342 | DID321900230 | 29 Sep 21:32:29 | KO.US | 0.2 Lots | SGD -0.40 | S2:13 |
| 46979908 | DID321901708 | 29 Sep 21:35:31 | WMT.US | 0.8 Lots | USD 2.06 | S4:3 |
| 43097342 | DID321909092 | 29 Sep 21:56:27 | DOW.US | 9 Lots | SGD 0.69 | S2:12 |
| 43097342 | DID321939635 | 29 Sep 23:59:10 | JPM.US | 1.9 Lots | SGD -5.11 | S2:11 |
| 43097342 | DID321959449 | 30 Sep 02:00:30 | GD.US | 1.6 Lots | SGD -5.03 | S2:10 |
| 43097342 | DID322033921 | 30 Sep 14:29:54 | NatGas | 0.01 Lots | SGD 0.38 | S2:9 |
| 43097342 | DID322069661 | 30 Sep 18:46:09 | NatGas | 0.01 Lots | SGD 2.17 | S2:8 |
| 43097342 | DID322069998 | 30 Sep 18:49:30 | NatGas | 0.01 Lots | SGD 1.28 | S2:7 |
| 47790949 | DID322081664 | 30 Sep 20:20:06 | NatGas | 3 Lots | USD -990.00 | S5:3 |
| 43097342 | DID322090261 | 30 Sep 20:42:07 | AUDUSD | 0.01 Lots | SGD 0.20 | S2:6 |
| 43097342 | DID322100008 | 30 Sep 21:32:16 | JNJ.US | 0.1 Lots | SGD -0.58 | S2:5 |
| 43097342 | DID322180668 | 01 Oct 02:17:37 | LLY.US | 0.1 Lots | SGD 0.22 | S2:4 |
| 43097342 | DID322195271 | 01 Oct 03:50:18 | COST.US | 0.1 Lots | SGD 0.69 | S2:3 |


## Appendix D. Runtime and source provenance

- Repository main and inspected deployment source: `8629232fa173e13c177fe345e375944322762949`.
- Railway project: `1832aca1-bc68-4bba-834f-cb0b3c4c05ca`; production environment: `7bc0dfc6-82c5-406c-a621-fd3ff549674d`.
- Node service: `04945f5c-03d4-4d3f-bec1-f4debcefe5e6`; deployment: `8ebe5b63-d7fe-461c-89fb-337897a17068`.
- GitHub main and Railway Node commit agree; latest deployment reports SUCCESS. This is deployment identity evidence, not a continuous-uptime assertion. A boot was observed at 01 Oct 05:17 SGT; its restart cause was not investigated.
- Source files inspected: [risk calculation](https://github.com/ang-kl/bot-trade/blob/8629232fa173e13c177fe345e375944322762949/agent/services/risk.js), [resting exposure](https://github.com/ang-kl/bot-trade/blob/8629232fa173e13c177fe345e375944322762949/agent/services/resting-exposure.js), [edge watchdog](https://github.com/ang-kl/bot-trade/blob/8629232fa173e13c177fe345e375944322762949/agent/services/edge-watchdog.js), [adaptive breaker](https://github.com/ang-kl/bot-trade/blob/8629232fa173e13c177fe345e375944322762949/agent/services/adaptive-breaker.js), [fast monitor](https://github.com/ang-kl/bot-trade/blob/8629232fa173e13c177fe345e375944322762949/agent/services/fast-monitor.js), [execution and balance writers](https://github.com/ang-kl/bot-trade/blob/8629232fa173e13c177fe345e375944322762949/agent/loop.js), [strategy pins](https://github.com/ang-kl/bot-trade/blob/8629232fa173e13c177fe345e375944322762949/agent/config/strategy-pins.json), [global strategy seeds](https://github.com/ang-kl/bot-trade/blob/8629232fa173e13c177fe345e375944322762949/agent/config/global-strategies.json), and [restoration scope](https://github.com/ang-kl/bot-trade/blob/8629232fa173e13c177fe345e375944322762949/docs/v3-intraday-restoration-2026-09-28.md).
- Local handover inspected: `docs/v3-handover-2026-10-01.md`, version 1.0, 05:59 SGT, from the preserved earlier workspace. It is historical/context evidence, not substituted for fresh runtime facts.
- Official field reference: [cTrader History, Spotware](https://help.ctrader.com/ctrader/trading/history/), retrieved 1 October 2026. Net realised includes swaps and commissions, so commission is not subtracted again.

Successful `railway_get_logs` requests below use the exact Node deployment ID above. Times are UTC to reproduce the API requests; add eight hours for SGT. `OR` is the connector's filter operator. Returned counts describe these requests only; they are not event totals.

| Query | Start UTC | End UTC | Requested limit / returned | Filter |
|---|---|---|---|---|
| gate-28 | 2026-09-28T05:00:00Z | 2026-09-28T05:10:00Z | 500 / 137 | "max_positions" OR "Margin pool" OR "usedMargin" |
| gate-29 | 2026-09-29T04:00:00Z | 2026-09-29T04:10:00Z | 500 / 95 | "max_positions" OR "Margin pool" OR "usedMargin" |
| gate-30 | 2026-09-30T04:00:00Z | 2026-09-30T04:10:00Z | 500 / 48 | "max_positions" OR "Margin pool" OR "usedMargin" |
| node-cutoff | 2026-09-30T22:10:00Z | 2026-09-30T22:22:00Z | 160 / 109 | "max_positions" OR "Margin pool" OR "Stage gate" OR "usedMargin" OR "momentum book" OR "independent-protection" |
| management-28 | 2026-09-27T16:00:00Z | 2026-09-28T16:00:00Z | 500 / 161 | "MOVE_SL" OR "PARTIAL_EXIT" OR "broker:" OR "disarmed" OR "auto-disarm" |
| management-29 | 2026-09-28T16:00:00Z | 2026-09-29T16:00:00Z | 500 / 391 | "MOVE_SL" OR "PARTIAL_EXIT" OR "broker:" OR "disarmed" OR "auto-disarm" |
| management-30 | 2026-09-29T16:00:00Z | 2026-09-30T22:22:00Z | 500 / 66 | "PARTIAL_EXIT" OR "broker: closed" OR "disarmed" OR "auto-disarm" OR "break-even" |
| actions-history | 2026-09-27T16:00:00Z | 2026-09-30T22:22:00Z | 300 / 301 | "SL move(s)" OR "partial close(s)" OR "trailed on" OR "TRAIL" OR "breakeven" OR "partial-tp" OR "protective" |
| boot-current | 2026-09-30T21:16:00Z | 2026-09-30T21:20:00Z | 200 / 55 | "boot" OR "account" OR "override" |
| risk-cutoff | 2026-09-30T22:10:00Z | 2026-09-30T22:22:00Z | 200 / 91 | "bad_rr" OR "Fundable universe" OR "Regime gate" OR "armed timeframe" |


The actions-history query returned 301 rows despite a requested 300 and begins at 30 September 17:31 UTC. It is a tail sample, not a complete four-day history. Narrower daily requests support the dated examples. Additional broad stage/management queries were used for discovery, not aggregate counts. An initial service-resolved native log lookup returned older deployment identities; current native deployment IDs were subsequently used, and no current protection conclusion rests on those older logs. The Node independent-protection records and statements supply the relevant position/protection evidence.

## INVARIANTS REPORT

| Material invariant / claim | Check | Result and limitation |
|---|---|---|
| Source statements preserved | Read-only CSV analysis; input hashes retained | **Passed.** No uploaded CSV was edited. |
| Counts and money are correctly scoped | Section-aware parse, distinct opening grouping, closing-time filter, Decimal sums, broker subtotal comparison | **Passed** for supplied rows; opening groups remain a proxy without Position IDs. |
| No mixing of currencies or trade origins | SGD/USD separated; Channel retained; server mapping read from runtime | **Passed.** One TradingView-labelled opening is distinguished from the bot-labelled groups. |
| “No new trades across all five accounts” | 16 observed opening groups, including activity on 1 October | **Failed as a premise.** No recent fills are evidenced on the supplied live account. |
| Existing positions entirely unmanaged | Four corroborated partial exits, one full exit, trailing-stop logs | **Failed as a premise.** Continuous management of every position is **Not Verifiable**. |
| Open positions have SL and TP | All 19 Positions rows plus pre-cutoff protection receipts | **Passed** at the sampled times; effectiveness, future fill protection and continuous coverage are not proved. |
| Pending orders have SL fields | Three Orders rows examined | **Failed.** All three exported SL fields are blank; separate on-fill attachment is **Not Verifiable**. |
| Restored strategies remain on until human action | Actual controller disarm logs and persistent boot records | **Failed.** Automatic trade disarms occurred; global scan shutdown is not established. |
| Production margin evaluation is error-free and currency-correct | Fresh exception plus deployed source and SGD statements | **Failed.** Null-margin exception and currency-provenance defect remain. |
| Investigation leaves production and inherited patches unchanged | Only read-only connector/source operations; working patch digest matches handover | **Passed.** Existing tracked diff remains `32faf9b736523f98c443a35b3b8da1c86e5030b7f000c9507449f91c7367299f`; no release/test suite executed. |
| Full V3 completion / all seven accounts accepted | Scope comparison with handover and missing lifecycle evidence | **Not Verifiable; not claimed.** |

**AI NOTE:** The weakest remaining evidence is the per-position decision and acknowledgement trail. The cheapest useful verification loop is an account/position-ID join between broker events, management decisions and fresh broker snapshots. Another strategy change or AI review cannot substitute for that evidence.
