<!-- Codex · 2026-10-16; codex-footprint: dynamic-market-context-investigation-plan. -->
# Claude Code instruction: investigate losses, establish reliable market context and design proactive decisions

**Status: investigation and design instruction. No application implementation or trading activation is authorised by this document.**

**Revision 2 — 16 October 2026 SGT.** Supersedes the first instruction merged in PR #1384. Carries forward the owner's reference to Codex №15,004 and the subsequent screenshot review, account statement, market-relationship discussion and explicit dynamic/proactive requirements. Read this entire instruction as one task; do not execute the superseded prompt as a separate competing plan.

Owner direction: assess each symbol through its market, sector, peers and relevant drivers; make correlation coverage dynamic and validated context proactive across proposed orders, working orders and existing positions. Establish actual loss causes before prescribing changes. The instruction to plan without building remains in effect.

## 1. Objective and permitted work

Determine why the supplied trades lost money, whether their exits followed their intended rules, and whether bot-trade uses the market information it already scans to maximise expected **whole-position net realised profit within the owner's risk limits**. Identify execution defects separately from weaknesses in trading policy. Produce evidence-backed correction proposals and a concrete design for reliable dynamic market coverage and active decisions.

Execute in dependency order: **incident reconstruction → input/label correctness → existing data and consumer coverage → proactive policy design → economic and fault-validation plan**. A new controller proposal alone does not complete the investigation. Neither later recovery nor an existing `stop_hunt` label proves the strategy was right. Do not manufacture a single common cause for different incidents.

Read fresh main and the deployed version before working. Use the existing authorised read-only account access available to Claude Code. Inspect code, copied data, broker readbacks and logs; perform offline analysis and write investigation documents. Do not modify application code, tests, configuration, watchlists, risk limits, orders, positions or stops. Do not build, deploy, merge, trigger trades, inject faults, run repair/backfill operations or activate the proposed controller. Verify endpoint side effects rather than relying on the HTTP verb. Do not request secret values in chat.

The required eventual design is **proactive**: eligible context changes must be able to change decisions and lead to verified actions through existing execution paths. A dashboard, journal field or permanently advisory detector does not meet that requirement. Current planning permission does not enable those actions now.

The owner's latest proactive requirement governs the proposed design even where older source comments describe pulse readings as advisory. Do not treat those historical comments as a reason to omit the requested policy design. Preserve existing account and portfolio risk ceilings, protective execution and ownership rules.

## 2. Source baseline and limits of the present evidence

At this redraft's source/runtime refresh on 16 October 2026 SGT:

- Fresh GitHub main was `c277bb0f75a3f2d038b7d9a60d426a0f8167d767`. Since the first instruction in PR #1384 (`5d5aa456`), PR #1382 merged application changes as `72ee47a5a6a7902a8f187c8fcf7a54a4d44f2afe`, followed by the test-fixture changes in PR #1385. Those changes were inspected during this redraft.
- A public `/health` response identified commit `72ee47a`, version `0.1.381`, status `ok`. It did not yet establish deployment of `c277bb0f`. Public health identifies the reported deployment; it does not verify private account state, effective settings, protection, repair completion or historical execution causes.
- The cloud used to prepare this instruction has no authenticated account binding. Complete private incident reconstruction through the owner's existing authorised Claude access. Do not infer account facts from the public pipeline summary.
- The correlation, pulse and classification logic referenced below was checked against the current source. Historical links pin the unchanged logic at `f9d084a`; separate links pin the new #1382 work at `72ee47a`. Recheck the implementation and configuration actually deployed during each incident.

| Source at the pinned commit | Confirmed observation | Investigation/design consequence |
|---|---|---|
| [agent/loop.js:6390](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/loop.js#L6390) and `:6397` | Correlation candidates come from active monitored positions and recent scans; the caller supplies `maxSymbols: 24`. | Broad scanner coverage does not guarantee that relevant benchmarks, peers or pending names receive relationship coverage. Measure actual inclusion, ordering and omissions. |
| [agent/services/correlation-matrix.js:230](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/correlation-matrix.js#L230) | The builder takes the first bounded symbol subset, fetches returns and writes a matrix. | Replace arbitrary coverage truncation in the proposed design with priority, coverage accounting and a bounded scalable scheduler. |
| [agent/services/correlation-matrix.js:27](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/correlation-matrix.js#L27) | Defaults include hourly returns, 60-return lookback and a maximum matrix age; these are configurable. | Inspect effective settings and source-bar freshness. Specify horizons and update triggers suitable for each decision rather than assuming defaults describe runtime. |
| [agent/services/correlation-matrix.js:64](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/correlation-matrix.js#L64) | Returns are reduced to arrays; Pearson pairs overlapping array tails. | Audit timestamp alignment upstream. Different sessions or missing bars can pair different intervals; do not assert this occurred without runtime evidence. |
| [agent/services/correlation-matrix.js:84](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/correlation-matrix.js#L84) | A null Pearson result becomes numeric zero in the stored pairwise matrix. | Undefined correlation, including zero-variance inputs, must remain distinguishable from measured low correlation before active policy uses it. |
| [agent/services/correlation-matrix.js:194](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/correlation-matrix.js#L194) | Changes between current and previous correlation matrices are already computed. | Reuse and validate existing shift detection rather than implementing a duplicate indicator. |
| [agent/services/risk.js:1705](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/risk.js#L1705) and `:2567` | Live and curated correlations already participate in admission/exposure vetoes. | Existing cross-market controls are present. Distinguish their concentration-control purpose from setup selection, market-regime reasoning and ongoing management. |
| [agent/services/risk.js:1996](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/risk.js#L1996) | Market pulse is recorded in the decision checks as advisory and does not itself veto. | Design an explicit active policy contract and trace every consumer; recording pulse alone is insufficient. |
| [agent/services/market-pulse.js:275](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/market-pulse.js#L275) and `:429` | Group detection and per-symbol context readings exist, with an age check. | Audit coverage, direction conventions and freshness; extend a shared context rather than creating incompatible parallel readings. |
| [agent/services/market-pulse.js:311](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/market-pulse.js#L311) | Group membership uses absolute correlation, including inverse relationships, but agreement counts raw up/down directions. | Specify and validate factor-relative direction. An inverse pair moving normally can be scored as having no group direction; do not turn that score into an active rule without resolving its interpretation. |
| [agent/services/market-pulse.js:480](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/market-pulse.js#L480) | Pulse computation loads a stored matrix and stamps a newly built pulse; the reader's age check is against pulse build time. | Carry matrix generation and constituent-bar ages through the context. A fresh pulse timestamp does not establish fresh dependencies. Confirm actual stale-input use before alleging an incident cause. |
| [agent/services/pending-orders.js:485](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/pending-orders.js#L485) | One working-order invalidation path uses the symbol's closed bar relative to its stored SL. | Inspect all pending paths for context revalidation. This observation alone does not prove the entire pending subsystem has no other controls. |
| [agent/services/momentum-limit-entry.js:63](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/momentum-limit-entry.js#L63) and `:100` | This limit-entry path evaluates risk and re-evaluates inside durable reservation. | Preserve and extend the last responsible check; do not replace it with a remote assessment that can become stale before reservation. |
| [agent/services/position-manager.js:383](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/position-manager.js#L383) | A price-based premise can cause full exit. | Define how validated market-context invalidation interacts with existing premise, stop, trailing, keeper and execution ownership. |
| [agent/services/loss-postmortem.js:107](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/loss-postmortem.js#L107) and `:125` | When one aftermath candle touches both barriers, its closing price selects a verdict; a recovery verdict says the direction was right. | Candle close cannot establish intrabar event order or prove thesis validity. Such labels need explicit uncertainty and must not automatically train the proposed calibration policy. |
| [agent/services/loss-postmortem.js:294](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/loss-postmortem.js#L294) | The decay flag uses the last five symbol/strategy/timeframe postmortems; this query has no account or policy-version filter. | Audit the intended pooling and consumers. Five possibly dependent outcomes are not sufficient evidence for an automatic system-wide recalibration. |
| [agent/services/news-calendar.js:1](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/news-calendar.js#L1) | A cached economic calendar and optional news-window entry gate already exist. | Reuse and audit available event context. Scheduled currency events do not by themselves provide sector earnings, release surprises or evidence of a fundamental shift. |
| [agent/services/loss-postmortem.js:608](https://github.com/ang-kl/bot-trade/blob/72ee47a5a6a7902a8f187c8fcf7a54a4d44f2afe/agent/services/loss-postmortem.js#L608) and [repair scope](https://github.com/ang-kl/bot-trade/blob/72ee47a5a6a7902a8f187c8fcf7a54a4d44f2afe/agent/services/aftermath-extend-apply.js#L9) | #1382 stores closed replay bars and provides one-shot repair/verification state. The repair leaves classification columns unchanged; the capture's verdict still reads the full reply. | Verify actual stored data and each verification state. Improved storage does not prove existing labels were corrected or classifyLoss has resolved forming-bar and intrabar ambiguity. |
| [agent/services/tick-activity.js:1](https://github.com/ang-kl/bot-trade/blob/72ee47a5a6a7902a8f187c8fcf7a54a4d44f2afe/agent/services/tick-activity.js#L1) | #1382 adds completed-minute tick counts, relative activity and price movement; it is measurement only. The ring is bounded in process memory and the persisted readout is a snapshot. | Reuse the measurement. Verify subscription health, warm-up, gaps and historical retention before interpreting quietness, spikes or claiming a full-day calibration sample. It is not an active scan-priority policy or fundamental feed. |

These are source observations and conditional data-quality concerns, not proof of the causes of the account losses. Identify existing functionality before proposing changes.

Two offline probes of the actual extracted pure functions reproduced additional source behaviour, without importing the application, opening a database or contacting a broker:

1. With `A=[0,0,0,0]` and `B=[0.01,-0.01,0.02,-0.02]`, Pearson returned null while the builder stored `A/B=0`.
2. An `A/B=-0.95` matrix put A and B in one group. Both trending with directions `+1/-1` produced direction 0, agreement 0.5 and `moving=false`; directions `+1/+1` produced agreement 1 and `moving=true` at the existing 0.6 agreement setting. This demonstrates the raw-direction interpretation, not that either synthetic case caused a real loss.

Reproduce and investigate those contracts before specifying automated consumers. Treat them as input/interpretation prerequisites, not evidence that all trading rules should change.

**Related work at the final source refresh:** PR [#1382](https://github.com/ang-kl/bot-trade/pull/1382), consolidating former #1379/#1381, merged at 06:37:40 SGT on 16 October; its application changes were inspected and its commit was reported by public health. It includes forming-bar storage/repair, scanning based on broker opening/pre-open conditions and tick-activity measurement. PR [#1385](https://github.com/ang-kl/bot-trade/pull/1385) merged at 06:39:55 SGT and changes FX-day test fixtures; that is not a production risk-policy fix. PR #1383 was still a draft concerning the protected-boundary authorisation marker. Recheck current status and inspect overlaps before proposing work. Carry completed changes forward, then verify account-specific operational outcomes. A PR description or green test is not evidence that a repair completed, nor permission to trigger one. Do not change or merge these PRs under this instruction.

## 3. Reconcile the supplied account evidence

Incident account: **Demo login 5306502 / cTrader account ID 47790949, USD**. Independently verify ownership using the existing authenticated source. The supplied filename and owner identify the account, but the CSV body has no account-ID column.

Use the owner's six screenshot pairs and `Demo 5306502 (47790949) statement-04_53 16.10.2026.csv`. Its timestamps explicitly use UTC+8 / SGT. Source SHA-256: `b0b2edeaafa7893d30c58588280bb89c7fd1b09a999d6f0023ebbc51f5b7647b`.

Independently verify the previously reconciled baseline:

| Measure | USD / count |
|---|---:|
| Unique closing deal records | 23 |
| Exported net realised result | -521.01 |
| Six screenshot deals combined | -615.95 |
| Other 17 closing deals combined | +94.94 |
| Reported commissions, already reflected in net | -11.67 |
| Ending balance | 42,326.57 |
| Unrealised P&L at export | +38.54 |
| Equity at export | 42,365.11 |

The closing window is 12–16 October 2026 SGT. An opening predates it, on 18 September. Do not call this lifetime performance or treat each closing deal as an independent trade. Verify apparent split closures: Cotton combined +274.90 on five lots; AUDUSD combined +192.78 on 1.38 lots. Preserve partial fills and charges before aggregating verified position lifecycles. Investigate screenshot fees versus CSV commissions as different fields rather than subtracting both again.

Reconstruct these incidents:

| Closing deal | CSV closing order | Symbol | Net USD |
|---|---|---|---:|
| 325136560 | 367385457 | GER40 | -227.25 |
| 324345442 | 366486681 | JPN225 | -220.52 |
| 324502658 | 366487114 | JPYX | -155.27 |
| 324627643 | 366852932 | GD.US | -93.89 |
| 324580093 | 366801901 | US30 | -55.32 |
| 325314459 | 367581934 | COST.US | -47.37 |
| 325171595 | 367426940 | US30 | -36.85 |
| 325160369 | 367415025 | NAS100 | -1.30 |

For each, join account, broker position ID, opening fills, amendments, partial fills and closing order/deals. Recover historical commit/configuration, strategy, premise, intended horizon, original SL/TP/risk, actual quantities and costs, stop trigger method and quote side, and the closing initiator. Trace requests, acknowledgements, readbacks, rejected requests, retries and reconciliation. Do not recover original risk from a later mutable stop or join different accounts by matching prices.

Resolve specifically:

1. **GER40:** closure at 15 October 15:00:01.403 SGT matches the broad reported missed-premise timeline around 14:57. Verify identity and trace detection, guard, arbitration, submission and execution before calling it a confirmed missed exit.
2. **NAS100:** opened 15 October 16:38:41.042 and closed 16:38:45.332 SGT. Determine whether the 4.290-second closure was valid protection or a defect. Its small cash loss should not displace the largest economic losses.
3. **US30 re-entry:** after the 13 October 18:50:00.695 losing close, deal 324651192 opened another buy at 22:20:16.891 and later earned 10.44. Inspect actual candidates and vetoes during the intervening 3h 30m. Missing logs do not prove no opportunity occurred.
4. **Pending SpotCrude:** the export shows a four-lot buy limit submitted 2 October 09:28:14.476 SGT, entry 68.548, TP 100.759, blank SL. Obtain a fresh broker readback and inspect protection-on-fill, acknowledgement and rejection handling. It is a pending order, not proof of an unprotected open position. Report confirmed exposure immediately without amending it under this instruction.
5. **Selection bias:** the supplied later screenshots favour GER40 and both US30 buys, while JPYX/GD.US shorts and the COST.US buy remain adverse at their displayed endpoints. Neither endpoint proves the original strategy's validity or the full recovery path. Include JPN225 and the full comparable cohort.

## 4. Audit existing data before asking for more feeds

Inventory data from tick and timeframe scanners, market/sector indices, FX, commodities, correlation, pulse, regimes, the economic calendar, tick-activity measurement, candidate decisions, pending orders and monitored positions. For each source record actual coverage, source/account provenance, event time, ingestion time, cadence, retention, missingness, units, session/calendar and consumers. Account for the new open-market/pre-open scan selection without confusing the scanning universe with mandatory context coverage: a closed benchmark may still be relevant, with its last observation's age made explicit.

Produce a lineage table: **collected → normalised → stored → related to peers/benchmarks → consumed by a decision → execution outcome**. Classify each gap as missing data, insufficient history, missing relationship, missing consumer, stale input or unverified execution. For each lifecycle path, show whether context is only displayed, recorded, consulted, capable of changing a decision, or followed by a verified broker action. Avoid requesting a new feed for information already available but unused.

Determine which sources can support only price-regime inference and which can support fundamental explanations. A fundamental-shift claim requires timestamped evidence such as earnings/guidance, rate changes, policy announcements, commodity supply/demand or other relevant drivers. Price co-movement alone does not establish the cause. Label broker tick activity separately from exchange volume where relevant. Do not invent unavailable feeds or catalysts.

## 5. Required design: dynamic correlation coverage

Replace the fixed first-24-symbol concept in the proposed architecture with a changing, explicitly covered universe:

- **Mandatory subjects:** active positions, working entry orders, orders being submitted, and actionable candidates from every entry path, including tick and timeframe paths.
- **Relevant context:** market benchmarks, sector/industry peers and applicable currency, commodity or macro proxies for those subjects. Use verified instrument mappings and point-in-time membership; do not infer industry from ticker spelling.
- **Discovery coverage:** additional scanned symbols examined on a rotating schedule to find new groups, regime changes and potential leaders/followers. Report which names are not yet covered.

Dynamic does not mean unbounded all-pairs work on every tick. Specify bounded batches, cached aligned returns, incremental updates, factor/group computation, priority scheduling, data subscriptions, broker quotas and compute budgets. Mandatory coverage must not silently disappear when discovery exceeds a budget. Mark the affected decision's coverage as incomplete and apply a documented policy.

Align returns by actual event-time intervals before computing relationships. Define treatment of different exchange hours, holidays, missing bars, stale quotes, currency effects and corporate actions. Do not fill gaps with artificial zero returns or pair unrelated array tails. Retain sufficient overlap and sample-quality evidence per relationship; unknown correlation is not zero correlation.

Evaluate suitable short, intermediate and longer horizons, with robust estimation or shrinkage when supported by the data. Include current correlation, change from prior states, downside co-movement, breadth and relative strength. Estimate cluster risk using verified monetary exposure and sensitivity, not solely ticker counts. Preserve existing hard concentration constraints during any future integration.

Separate statistical relationship, group membership and factor-relative trade exposure. Define signed orientation for inverse links and account for inconsistent sign cycles or weakly joined groups. A connected component is not proof that every pair has the same relationship or that every member should trade in the same raw direction. Keep unknown or unstable orientation explicit. Do not apply the current raw group-agreement reading as a universal direction gate.

Refresh on an appropriate schedule and on material events: new subjects, fills/closures, broker-order changes, volatility or relationship shifts, session transitions and relevant timestamped releases. Specify measured service-level targets from actual dependencies; do not invent a guaranteed latency or threshold.

## 6. Required design: market structure and propagation

Each symbol must be assessed against its context while preserving its own structure, liquidity, spread and premise. Relationships are conditional and can break; avoid forcing all instruments into a single fixed cluster. Distinguish market regime, sector rotation and a fundamentally explained shift; do not use those labels interchangeably.

Separate broad market movement, sector/industry movement and symbol-specific residual movement. Test lead/lag relationships after controlling for shared drivers, timestamp alignment and asynchronous trading. A sequence is a predictive hypothesis, not proof of causation.

Use complete comparable histories, multiple-testing controls and separate later periods to evaluate any discovered leader/follower relationship. Measure whether it predicts a usable move after costs, not merely whether two historical charts can be aligned. Twenty highly correlated symbols are not twenty independent confirmations.

Distinguish ordinary retracement, chop, broad trend, sector rotation, idiosyncratic events and externally supported fundamental shifts. Each assessment must expose confidence, evidence, horizon, coverage and expiry. Unknown remains valid. A market-context change may support a hold as well as an exit; the design must preserve profitable opportunities rather than equate more vetoes with success.

## 7. Required design: proactive decision contract

Define one versioned context assessment shared by decision consumers. It should name the subject, relevant members/factors and signed orientation, event-time cutoff, generation and expiry, coverage/quality, model version, confidence, regime, premise implications and evidence references. Include dependency versions and constituent event times; the youngest envelope timestamp cannot conceal the oldest decision-critical input. Record account-specific policy, risk and execution ownership separately.

Specify an active, deterministic policy contract with explicit outcomes such as **allow, allow at a validated reduced size, defer until a stated condition/deadline, refuse, cancel working entry, hold, tighten protection, partially exit or fully exit**. These are proposed decision types, not authorisation to execute now. Define the admissible evidence, strategy compatibility, precedence and owner risk constraints for each outcome. Favourable context never bypasses hard risk or creates a trade without a valid setup. Any change in proposed size must still satisfy broker quantity increments, minimums, costs, margin and the account's hard limits; an infeasible reduced size is not rounded up into additional risk.

| Lifecycle stage | Required eventual behaviour |
|---|---|
| Opportunity selection | Rank valid setups using benchmark/peer context, costs and opportunity quality. Detect concentration and avoid mechanically buying every correlated name. |
| Before submission | Revalidate fresh subject/context data, strategy premise and account limits at the last responsible point. All entry paths must consume the same policy contract. |
| Reservation/dispatch | Bind admission to the context/policy version and expiry; invalidate stale admission before sending. Preserve durable, account-owned capacity/risk reservation and execution idempotency. |
| Working pending order | Material context changes re-evaluate the order. Keep it when still valid; issue a verified cancellation when policy invalidates it. Do not replace/re-arm it in a loop or release capacity merely because cancellation was requested. |
| Fill during reassessment/cancellation | Reconcile broker events and residual order quantity before deciding the next action. Adopt and protect actual fills, including partial fills, without recording a cancellation as proof that nothing filled. |
| Existing position | Evaluate whether the original premise remains valid and select a bounded management action. Integrate with existing premise, trailing, breakeven, keeper and hard protection rules through one arbiter. |
| After closure | Reconcile the whole lifecycle, costs and context known at each decision. Use winners, losers and rejected opportunities for controlled calibration. |

Design autonomous operation within a defined enabled policy; do not require a human decision for every qualifying trade action. Preserve one account-owned execution path and explicit controller precedence. Safety/premise exits must not wait for a slower statistical confirmation or calibration job. No controller may cancel protective orders as though they were resting entries.

For each proposed active rule, specify a concrete trigger, persistence/quality requirements, strategy applicability, action, risk bound, execution owner, completion evidence and recovery behaviour. Show paired examples where otherwise comparable inputs lead to different decisions when valid market context changes, including a valid hold/entry that should be preserved. A generic confidence score or unconsumed event is not a rule specification. These examples are proposed contracts until validated; do not invent numerical production thresholds to make them executable now.

Do not use the context as a reason to widen an existing stop, average down, expand total permitted risk or retain an invalid premise. A proposed wider **initial** stop requires recalculated smaller sizing and validation under the same monetary limits. Re-entry requires a fresh valid setup and a shared, bounded campaign risk budget.

## 8. Noise control, faults and degraded operation

Specify persistence, minimum effect size, confidence and hysteresis for statistical state changes; test their detection delay as well as false alarms. Do not choose thresholds by inspecting only the selected losses. Immediate hard protection and already-valid premise exits remain independent of smoothing delays.

Cover stale/missing feeds, unsupported symbols, disjoint sessions, partial computation, budget exhaustion, corrupt or inconsistent context versions, simultaneous order placement, timeout, rejected cancellation, restart and competing controller actions. Inspect existing mechanisms before proposing replacements.

Define a per-decision degradation matrix. For new risk that requires unavailable context, use an explicit defer/refuse outcome with reason, expiry and recovery condition; never present missing evidence as favourable. Preserve existing broker protection and management continuity on open positions. Unknown data alone must not trigger an invented market-invalidation liquidation. Specify any permitted fallback and its eligibility rather than silently changing global risk posture.

Market information may be shared when provenance and instrument identity permit. Balances, currencies, limits, pending-risk reservations, positions, credentials and execution receipts remain account-specific. Do not pool USD and SGD or certify unverified account money. Resolve the current account registry from authenticated evidence; do not guess additional demo or live account numbers. This instruction grants no live-trade activation.

## 9. Calibration and evaluation

Run market assessment continuously; calibrate policy from complete mature outcomes on a controlled schedule. Keep execution defects out of the labels used to infer strategy failure. Do not recalibrate after every loss or reinterpret an original premise after seeing the result. Audit decay/history pooling across accounts, strategy versions, horizons and market regimes; a shared market observation does not make realised account outcomes interchangeable.

Define whole-position net, PF, win rate, scratches, costs, horizons and cohort eligibility before calculating results. Preserve the owner's applicable official scoreboard definitions; label research cohorts separately. Include open/pending exposure and outcomes crossing dataset boundaries. Assess missingness and selection introduced by existing gates.

For retracement studies, reconstruct executable bid/ask paths, original risk, MAE/MFE and the first event among recovery, invalidation and risk exhaustion. If OHLC cannot resolve intrabar ordering, retain ambiguity or obtain finer data; do not infer order from candle close. Do not treat recovery within an arbitrary future window as proof that a stop was wrong.

Compare the historical deployed baseline with separately specified candidate policies for entry confirmation, initial stop/size, trailing, premise invalidation and fresh-setup re-entry. Include costs, slippage, gaps, clustered losses, concurrent and pending exposures, turnover and missed profitable opportunities. Freeze candidate policies and test on separate later periods with leakage controls for overlapping horizons. Report uncertainty and effective sample size; the 23 closing deals cannot certify a system-wide advantage.

Where future offline stress testing is proposed, specify realistic faults and invariants from observed incident paths. Do not conduct live fault injection under this instruction. Do not claim code correctness, fault tolerance or improved returns merely because a model backtest or hypothetical scenario passes.

## 10. Acceptance criteria for the proposed implementation

Specify the evidence and tests that a later implementation would need. Do not implement them now.

1. A universe larger than 24 subjects includes every mandatory subject and its required context, or explicitly records and handles the precise coverage gap. Discovery remains bounded and cannot starve mandatory work.
2. Misaligned/missing-session returns cannot silently become a valid correlation; insufficient evidence remains unknown. Snapshot build time cannot conceal stale constituent data.
3. A qualifying change in market context causes a defined change in an otherwise comparable order/position decision, with the relevant context/policy version and reason recorded. An advisory stamp alone fails this criterion.
4. Context invalidation during placement, pending execution or cancellation cannot produce duplicate orders, lost fills, cross-account actions or prematurely released risk reservations. Actual broker outcomes determine completion.
5. Material valid changes reach all applicable entry, pending and management paths; benign fluctuations do not cause churn, repeated replacements or needless loss of profitable opportunities.
6. Existing protective orders and hard account/portfolio ceilings remain effective through stale feeds, worker failures, restarts and conflicting controller proposals. Quantify residual gaps instead of asserting universal fault tolerance.
7. The calibration dataset preserves whole positions, actual costs, historical context and ambiguity. No future data or post-hoc premise enters an earlier decision.
8. Economic acceptance requires evidence of better net outcomes under the same risk limits, with uncertainty, tail losses, false alarms, turnover and missed winners reported. Higher win rate, more blocked trades or green engineering checks alone is insufficient.
9. Zero-variance or insufficient-overlap pairs remain distinguishable from measured zero correlation. Inverse correlated groups are interpreted using an explicit signed/factor contract; ordinary inverse co-movement is not silently labelled a breakdown by a raw-direction vote.
10. A stale constituent or matrix cannot acquire validity merely because a new pulse/context envelope was written. The decision record names all critical versions, relevant event times and the precise degraded-mode action.
11. New tick-activity data distinguishes a genuinely silent observed interval from missing subscription/history, startup and connection gaps. A large relative reading against an unwarmed baseline cannot automatically become confidence in an entry. Existing measurements and available retention are verified before a longer calibration history is claimed.

## 11. Deliverables and sequence

Produce `doc/loss-investigation-demo-47790949-and-market-context-2026-10-16.md` with:

- A concise verdict and a statement of verified scope versus missing evidence.
- Incident timelines and accounting reconciliation, with broker/account identity and evidence references.
- A source-to-consumer data inventory and lifecycle coverage matrix, including all entry and pending paths.
- Findings classified as confirmed defect, intended behaviour, policy weakness, data/observability deficiency or insufficient evidence. For each, state intended versus observed behaviour, causal chain, historical version, confidence, severity and observed monetary impact. Separate estimated avoidable loss from observed loss.
- The dynamic-universe algorithm, computational budget, time alignment and freshness requirements.
- The context schema, proactive policy/state transitions, controller precedence and account-specific execution obligations.
- The fault/degradation matrix and proposed acceptance scenarios.
- A ranked minimal correction/design backlog. For every proposed change name the affected source, underlying contract, incident evidence, regression scenario and verification criteria. Do not present a symptom patch or general new module as an established root-cause fix.
- A calibration/economic-validation protocol and the exact missing evidence or feeds, if any.

Sequence the investigation and proposed work by dependency:

1. **Reconstruct incidents and verify protections.** Complete the statement reconciliation and available broker/decision traces. Report unresolved private evidence precisely; do not replace missing causes with a controller proposal.
2. **Establish trustworthy inputs and labels.** Resolve the contracts for alignment, unknown correlation, inverse direction, dependency freshness, activity coverage and intrabar ambiguity. Identify what the newly merged and still-open related PRs do and do not address. In particular, inspect `bars_verified_at` state and stored contents: a non-null marker may record an unavailable repair attempt rather than successful verification. Do not infer corrected classification columns from repaired replay bars.
3. **Map existing coverage and decision consumers.** Show where collected context stops influencing the lifecycle; distinguish missing observations from unused observations and existing controls from proposed controls.
4. **Design dynamic coverage and active policy.** Specify bounded computation, snapshots, triggers, account-owned reservations, controller precedence and verified actions for every applicable entry, pending and management path.
5. **Define validation and future activation.** Compare frozen candidate policies against the deployed baseline on separate later periods, specify realistic fault cases, and describe bounded activation/rollback. A temporary comparison phase can support validation, but the target must be functioning proactive decisions, not indefinite observation. Do not implement or activate any phase in this task.

End by answering: what is already implemented; what is collected but unused; what is genuinely missing; which losses were valid protection; which defects are proven; which policy changes have supporting evidence; and what remains unproven. Distinguish completion of this investigation from implementation, activation and improved trading outcomes.

Stop after the investigation report and concrete proposed changes. Do not build or change the running bot under this instruction.

## 12. Evidence provenance for this instruction

Prepared from the owner's requests, the uploaded CSV and screenshots, source inspection, offline pure-function probes, relevant draft PR inspection and a public deployment-identity check. The account-statement reconciliation, six screenshot matches and probe receipts are retained in the preparing cloud's `loss-investigation-2026-10-16` analysis directory. Those local files are not assumed to exist in Claude Code's environment; use the owner's original attachments or a verified project copy and state any missing source.

Conversation reference: the owner identifies Codex №15,004, 16 October 2026 04:24 SGT, as the starting response; the retained working evidence includes the preliminary screenshot investigation, №15,006 statement analysis, subsequent market-context requirements, and №15,007–15,009 document publication/merge. The exact №15,004 body is not in the retained working artifacts, so this redraft does not quote or invent its wording. Shared transcript numbering is a recorded lower bound, not a measured full-corpus count. This file is a plan and handoff, not a deployment receipt or evidence that trading behaviour has changed.
