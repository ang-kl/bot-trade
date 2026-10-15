<!-- Codex · 2026-10-16; codex-footprint: dynamic-market-context-investigation-plan. -->
# Claude Code instruction: dynamic market context, proactive decisions and loss investigation

**Status: investigation and design instruction. No application implementation or trading activation is authorised by this document.**

Owner direction: symbols must be assessed in their market relationships; expand correlation computation dynamically and make validated market context proactive across proposed orders, working orders and existing positions. This consolidates the earlier loss-investigation prompt and the owner's subsequent requirements. The existing instruction to plan without building remains in effect.

## 1. Objective and permitted work

Investigate whether bot-trade uses the market information it already scans to maximise expected **whole-position net realised profit within the owner's risk limits**. Identify execution defects separately from weaknesses in trading policy. Produce a concrete design for dynamic market coverage and active decisions, together with evidence-backed correction proposals.

Read fresh main and the deployed version before working. Use the existing authorised read-only account access available to Claude Code. Inspect code, copied data, broker readbacks and logs; perform offline analysis and write investigation documents. Do not modify application code, tests, configuration, watchlists, risk limits, orders, positions or stops. Do not build, deploy, merge, trigger trades, inject faults, run repair/backfill operations or activate the proposed controller. Verify endpoint side effects rather than relying on the HTTP verb. Do not request secret values in chat.

The required eventual design is **proactive**: eligible context changes must be able to change decisions and lead to verified actions through existing execution paths. A dashboard, journal field or permanently advisory detector does not meet that requirement. Current planning permission does not enable those actions now.

The owner's latest proactive requirement governs the proposed design even where older source comments describe pulse readings as advisory. Do not treat those historical comments as a reason to omit the requested policy design. Preserve existing account and portfolio risk ceilings, protective execution and ownership rules.

## 2. Source baseline and limits of the present evidence

At the preparation of this instruction on 16 October 2026 SGT:

- Fresh GitHub main was `f9d084a25d3e99f14e7338722b07f603b8acce3b`.
- A public `/health` response identified commit `f9d084a`, version `0.1.381`, status `ok`. This identifies the public deployment; it does not verify private account state, effective settings, protection or historical execution causes.
- The cloud used to prepare this instruction has no authenticated account binding. Complete private incident reconstruction through the owner's existing authorised Claude access. Do not infer account facts from the public pipeline summary.
- Source observations below refer to this pinned commit. Recheck them against the implementation and configuration actually deployed during each incident.

| Source at the pinned commit | Confirmed observation | Investigation/design consequence |
|---|---|---|
| [agent/loop.js:6390](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/loop.js#L6390) and `:6397` | Correlation candidates come from active monitored positions and recent scans; the caller supplies `maxSymbols: 24`. | Broad scanner coverage does not guarantee that relevant benchmarks, peers or pending names receive relationship coverage. Measure actual inclusion, ordering and omissions. |
| [agent/services/correlation-matrix.js:230](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/correlation-matrix.js#L230) | The builder takes the first bounded symbol subset, fetches returns and writes a matrix. | Replace arbitrary coverage truncation in the proposed design with priority, coverage accounting and a bounded scalable scheduler. |
| [agent/services/correlation-matrix.js:27](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/correlation-matrix.js#L27) | Defaults include hourly returns, 60-return lookback and a maximum matrix age; these are configurable. | Inspect effective settings and source-bar freshness. Specify horizons and update triggers suitable for each decision rather than assuming defaults describe runtime. |
| [agent/services/correlation-matrix.js:64](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/correlation-matrix.js#L64) | Returns are reduced to arrays; Pearson pairs overlapping array tails. | Audit timestamp alignment upstream. Different sessions or missing bars can pair different intervals; do not assert this occurred without runtime evidence. |
| [agent/services/correlation-matrix.js:194](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/correlation-matrix.js#L194) | Changes between current and previous correlation matrices are already computed. | Reuse and validate existing shift detection rather than implementing a duplicate indicator. |
| [agent/services/risk.js:1705](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/risk.js#L1705) and `:2567` | Live and curated correlations already participate in admission/exposure vetoes. | Existing cross-market controls are present. Distinguish their concentration-control purpose from setup selection, market-regime reasoning and ongoing management. |
| [agent/services/risk.js:1996](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/risk.js#L1996) | Market pulse is recorded in the decision checks as advisory and does not itself veto. | Design an explicit active policy contract and trace every consumer; recording pulse alone is insufficient. |
| [agent/services/market-pulse.js:275](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/market-pulse.js#L275) and `:429` | Group detection and per-symbol context readings exist, with an age check. | Audit coverage, direction conventions and freshness; extend a shared context rather than creating incompatible parallel readings. |
| [agent/services/pending-orders.js:485](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/pending-orders.js#L485) | One working-order invalidation path uses the symbol's closed bar relative to its stored SL. | Inspect all pending paths for context revalidation. This observation alone does not prove the entire pending subsystem has no other controls. |
| [agent/services/momentum-limit-entry.js:63](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/momentum-limit-entry.js#L63) and `:100` | This limit-entry path evaluates risk and re-evaluates inside durable reservation. | Preserve and extend the last responsible check; do not replace it with a remote assessment that can become stale before reservation. |
| [agent/services/position-manager.js:383](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/position-manager.js#L383) | A price-based premise can cause full exit. | Define how validated market-context invalidation interacts with existing premise, stop, trailing, keeper and execution ownership. |
| [agent/services/loss-postmortem.js:107](https://github.com/ang-kl/bot-trade/blob/f9d084a25d3e99f14e7338722b07f603b8acce3b/agent/services/loss-postmortem.js#L107) and `:125` | When one aftermath candle touches both barriers, its closing price selects a verdict; a recovery verdict says the direction was right. | Candle close cannot establish intrabar event order or prove thesis validity. Such labels need explicit uncertainty and must not automatically train the proposed calibration policy. |

These are source observations and conditional data-quality concerns, not proof of the causes of the account losses. Identify existing functionality before proposing changes.

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

Inventory data from tick and timeframe scanners, market/sector indices, FX, commodities, correlation, pulse, regimes, candidate decisions, pending orders and monitored positions. For each source record actual coverage, source/account provenance, event time, ingestion time, cadence, retention, missingness, units, session/calendar and consumers.

Produce a lineage table: **collected → normalised → stored → related to peers/benchmarks → consumed by a decision → execution outcome**. Classify each gap as missing data, insufficient history, missing relationship, missing consumer, stale input or unverified execution. Avoid requesting a new feed for information already available but unused.

Determine which sources can support only price-regime inference and which can support fundamental explanations. A fundamental-shift claim requires timestamped evidence such as earnings/guidance, rate changes, policy announcements, commodity supply/demand or other relevant drivers. Price co-movement alone does not establish the cause. Label broker tick activity separately from exchange volume where relevant. Do not invent unavailable feeds or catalysts.

## 5. Required design: dynamic correlation coverage

Replace the fixed first-24-symbol concept in the proposed architecture with a changing, explicitly covered universe:

- **Mandatory subjects:** active positions, working entry orders, orders being submitted, and actionable candidates from every entry path, including tick and timeframe paths.
- **Relevant context:** market benchmarks, sector/industry peers and applicable currency, commodity or macro proxies for those subjects. Use verified instrument mappings and point-in-time membership; do not infer industry from ticker spelling.
- **Discovery coverage:** additional scanned symbols examined on a rotating schedule to find new groups, regime changes and potential leaders/followers. Report which names are not yet covered.

Dynamic does not mean unbounded all-pairs work on every tick. Specify bounded batches, cached aligned returns, incremental updates, factor/group computation, priority scheduling, data subscriptions, broker quotas and compute budgets. Mandatory coverage must not silently disappear when discovery exceeds a budget. Mark the affected decision's coverage as incomplete and apply a documented policy.

Align returns by actual event-time intervals before computing relationships. Define treatment of different exchange hours, holidays, missing bars, stale quotes, currency effects and corporate actions. Do not fill gaps with artificial zero returns or pair unrelated array tails. Retain sufficient overlap and sample-quality evidence per relationship; unknown correlation is not zero correlation.

Evaluate suitable short, intermediate and longer horizons, with robust estimation or shrinkage when supported by the data. Include current correlation, change from prior states, downside co-movement, breadth and relative strength. Estimate cluster risk using verified monetary exposure and sensitivity, not solely ticker counts. Preserve existing hard concentration constraints during any future integration.

Refresh on an appropriate schedule and on material events: new subjects, fills/closures, broker-order changes, volatility or relationship shifts, session transitions and relevant timestamped releases. Specify measured service-level targets from actual dependencies; do not invent a guaranteed latency or threshold.

## 6. Required design: market structure and propagation

Each symbol must be assessed against its context while preserving its own structure, liquidity, spread and premise. Relationships are conditional and can break; avoid forcing all instruments into a single fixed cluster.

Separate broad market movement, sector/industry movement and symbol-specific residual movement. Test lead/lag relationships after controlling for shared drivers, timestamp alignment and asynchronous trading. A sequence is a predictive hypothesis, not proof of causation.

Use complete comparable histories, multiple-testing controls and separate later periods to evaluate any discovered leader/follower relationship. Measure whether it predicts a usable move after costs, not merely whether two historical charts can be aligned. Twenty highly correlated symbols are not twenty independent confirmations.

Distinguish ordinary retracement, chop, broad trend, sector rotation, idiosyncratic events and externally supported fundamental shifts. Each assessment must expose confidence, evidence, horizon, coverage and expiry. Unknown remains valid. A market-context change may support a hold as well as an exit; the design must preserve profitable opportunities rather than equate more vetoes with success.

## 7. Required design: proactive decision contract

Define one versioned context assessment shared by decision consumers. It should name the subject, relevant members/factors, event-time cutoff, generation and expiry, coverage/quality, model version, confidence, regime, premise implications and evidence references. Record account-specific policy, risk and execution ownership separately.

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

Do not use the context as a reason to widen an existing stop, average down, expand total permitted risk or retain an invalid premise. A proposed wider **initial** stop requires recalculated smaller sizing and validation under the same monetary limits. Re-entry requires a fresh valid setup and a shared, bounded campaign risk budget.

## 8. Noise control, faults and degraded operation

Specify persistence, minimum effect size, confidence and hysteresis for statistical state changes; test their detection delay as well as false alarms. Do not choose thresholds by inspecting only the selected losses. Immediate hard protection and already-valid premise exits remain independent of smoothing delays.

Cover stale/missing feeds, unsupported symbols, disjoint sessions, partial computation, budget exhaustion, corrupt or inconsistent context versions, simultaneous order placement, timeout, rejected cancellation, restart and competing controller actions. Inspect existing mechanisms before proposing replacements.

Define a per-decision degradation matrix. For new risk that requires unavailable context, use an explicit defer/refuse outcome with reason, expiry and recovery condition; never present missing evidence as favourable. Preserve existing broker protection and management continuity on open positions. Unknown data alone must not trigger an invented market-invalidation liquidation. Specify any permitted fallback and its eligibility rather than silently changing global risk posture.

Market information may be shared when provenance and instrument identity permit. Balances, currencies, limits, pending-risk reservations, positions, credentials and execution receipts remain account-specific. Do not pool USD and SGD or certify unverified account money. Resolve the current account registry from authenticated evidence; do not guess additional demo or live account numbers. This instruction grants no live-trade activation.

## 9. Calibration and evaluation

Run market assessment continuously; calibrate policy from complete mature outcomes on a controlled schedule. Keep execution defects out of the labels used to infer strategy failure. Do not recalibrate after every loss or reinterpret an original premise after seeing the result.

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

Sequence proposed work by dependency: (1) establish incident causes and input correctness; (2) design dynamic coverage and reliable snapshots; (3) specify active policy consumption and execution arbitration; (4) validate economics and fault scenarios; (5) describe a future bounded activation and rollback plan. A temporary comparison phase can support validation, but the target must be functioning proactive decisions, not indefinite observation. Do not activate any phase in this task.

End by answering: what is already implemented; what is collected but unused; what is genuinely missing; which losses were valid protection; which defects are proven; which policy changes have supporting evidence; and what remains unproven. Distinguish completion of this investigation from implementation, activation and improved trading outcomes.

Stop after the investigation report and concrete proposed changes. Do not build or change the running bot under this instruction.

## 12. Evidence provenance for this instruction

Prepared from the owner's requests, the uploaded CSV and screenshots, source inspection at the pinned main commit, and a public deployment-identity check. The account-statement reconciliation and six screenshot matches are retained in the preparing cloud's `loss-investigation-2026-10-16` analysis directory. Those local files are not assumed to exist in Claude Code's environment; use the owner's original attachments or a verified project copy and state any missing source.

Conversation reference: Codex №15,006 statement analysis, followed by the owner's investigation-prompt, market-context, proceed and dynamic/proactive requirements. Shared transcript numbering is a recorded lower bound, not a measured full-corpus count. This file is a plan and handoff, not a deployment receipt or evidence that trading behaviour has changed.
