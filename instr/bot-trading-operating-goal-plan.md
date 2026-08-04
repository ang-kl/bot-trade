# Bot-Trading Operating Goal Plan

**Repository:** `ang-kl/bot-trade`  
**Document status:** Proposed operating baseline  
**Document version:** 1.0  
**Date:** 04 August 2026  
**Scope:** Strategy research, offline watchlist preparation, real-time market sensing, entry execution, live trade management, post-trade truth, reflection, controlled adaptation, capital governance, platform reliability, verification and audit. [§0.1]

---

## 1. Programme Goal

Build and operate a deterministic, evidence-led and capital-preserving multi-account trading system that researches opportunities offline, prepares a purposeful watchlist, detects opportunities in real time, executes only approved trades, manages every open position continuously, reconciles every outcome to broker truth, learns from results and improves through controlled testing rather than impulsive tuning. [§1.1]

The programme is not intended merely to maximise trade frequency. Its purpose is to deploy capital only when the expected opportunity justifies the risk, and to manage that risk continuously from entry until broker-confirmed closure. [Agur] [§1.2]

The operating model must remain understandable to the owner. At any time, the system should be able to explain what it is watching, why it is interested, why it acted or refused to act, how it is managing each open position, what happened at the broker and what has been learned. [§1.3]

---

## 2. North-Star Operating Questions

The programme should be able to answer the following questions at any time. [§2.1]

1. What markets and instruments are being watched? [§2.1.1]
2. Why is each instrument on the watchlist? [§2.1.2]
3. Which strategy, timeframe and entry-mode combinations are eligible? [§2.1.3]
4. What valid opportunities currently exist? [§2.1.4]
5. Why was a trade approved, vetoed, deferred or ignored? [§2.1.5]
6. Was the order acknowledged and filled correctly? [§2.1.6]
7. Is every open position currently protected at the broker? [§2.1.7]
8. What is the bot doing with each open position now? [§2.1.8]
9. When was each open position last reviewed? [§2.1.9]
10. What changed in the market after entry? [§2.1.10]
11. What happened financially at the broker? [§2.1.11]
12. What was learned from the trade? [§2.1.12]
13. Has that lesson been tested before changing future behaviour? [§2.1.13]

---

## 3. Workstream Structure

The Bot-Trade programme should be organised into eight lifecycle workstreams and three enabling workstreams. [§3.1]

### 3.1 Lifecycle Workstreams

- **WS-01 - Strategy Portfolio and Research** [§3.1.1]
- **WS-02 - Offline Market Preparation and Watchlist** [§3.1.2]
- **WS-03 - Real-Time Market Sensing and Opportunity Formation** [§3.1.3]
- **WS-04 - Trade Decision, Risk Approval and Entry Execution** [§3.1.4]
- **WS-05 - Live Trade Management and Exit** [§3.1.5]
- **WS-06 - Post-Trade Truth and Performance** [§3.1.6]
- **WS-07 - Reflection, Diagnosis and Learning** [§3.1.7]
- **WS-08 - Controlled Adaptation and Strategy Promotion** [§3.1.8]

### 3.2 Enabling Workstreams

- **WS-09 - Capital, Risk and Account Governance** [§3.2.1]
- **WS-10 - Platform, Data, Security and Reliability** [§3.2.2]
- **WS-11 - Verification, Release and Audit** [§3.2.3]

The twelve trading strategies are governed portfolio items that move through the workstreams. They are not twelve separate programme workstreams. [§3.3]

---

# WS-01 - Strategy Portfolio and Research

## 4. Goal

Maintain a coherent portfolio of strategies with explicit market hypotheses, deterministic rules, appropriate regimes, known failure modes and reproducible evidence. [§4.1]

## 5. Operating Boundary

This workstream owns strategy design, strategy evidence and strategy lifecycle. It does not approve or manage a specific live trade. [§5.1]

## 6. Responsibilities

1. Maintain the authoritative registry for all twelve strategies. [§6.1]
2. Document each strategy's market hypothesis. [§6.2]
3. Define deterministic entry, invalidation, stop, target and exit logic. [§6.3]
4. Define suitable and unsuitable market regimes. [§6.4]
5. Define supported instruments, sessions and timeframes. [§6.5]
6. Define required indicators, price history and data quality. [§6.6]
7. Identify strategy overlap and duplication. [§6.7]
8. Identify whether several strategies express substantially the same market exposure. [§6.8]
9. Conduct historical backtesting. [§6.9]
10. Conduct walk-forward and out-of-sample validation. [§6.10]
11. Include spread, commission, financing and realistic slippage. [§6.11]
12. Conduct parameter sensitivity testing. [§6.12]
13. Test whether small parameter changes destroy the apparent edge. [§6.13]
14. Measure expected win rate, payoff, profit factor, drawdown and holding time. [§6.14]
15. Compare expected performance with demo and live behaviour. [§6.15]
16. Maintain known failure conditions. [§6.16]
17. Quarantine strategies when evidence deteriorates. [§6.17]
18. Retire strategies that no longer justify operational complexity. [§6.18]

## 7. Strategy Dossier

Each strategy should have an authoritative dossier containing the following. [§7.1]

- Strategy ID and version. [§7.1.1]
- Strategy family. [§7.1.2]
- Market hypothesis. [§7.1.3]
- Entry logic. [§7.1.4]
- Exit logic. [§7.1.5]
- Stop-loss logic. [§7.1.6]
- Take-profit logic. [§7.1.7]
- Time-cap logic. [§7.1.8]
- Supported entry modes. [§7.1.9]
- Suitable volatility and trend regimes. [§7.1.10]
- Unsupported regimes. [§7.1.11]
- Supported symbols and timeframes. [§7.1.12]
- Required market data. [§7.1.13]
- Expected trade frequency. [§7.1.14]
- Expected win rate and payoff ratio. [§7.1.15]
- Expected profit factor. [§7.1.16]
- Expected MFE and MAE. [§7.1.17]
- Expected drawdown. [§7.1.18]
- Known failure patterns. [§7.1.19]
- Backtest period and data source. [§7.1.20]
- Walk-forward result. [§7.1.21]
- Demo and live results. [§7.1.22]
- Current lifecycle status. [§7.1.23]
- Last review and evidence-expiry dates. [§7.1.24]

## 8. Strategy Research Loop

**[LOOP-01 - Strategy Evidence Loop]** [§8.1]

`Strategy hypothesis`  
→ `Formal strategy specification`  
→ `Historical backtest`  
→ `Walk-forward validation`  
→ `Shadow observation`  
→ `Demo evidence`  
→ `Restricted live evidence`  
→ `Performance review`  
→ `Retain, modify, quarantine or retire`  
→ back to `Strategy hypothesis or specification`. [§8.2]

This loop is expected to run continuously across the life of each strategy. A strategy is never permanently proven. Its evidence must be refreshed as market conditions, transaction costs and execution behaviour change. [§8.3]

## 9. Deliverables and Measures

Primary deliverables include the strategy registry, strategy dossiers, backtest reports, walk-forward reports, correlation analysis, approved-strategy list, quarantined-strategy list and retired-strategy archive. [§9.1]

Measures should include the percentage of armed strategies with current evidence, backtest-to-demo deviation, demo-to-live deviation, insufficient-sample strategies, overlapping strategies and expired evidence. [§9.2]

---

# WS-02 - Offline Market Preparation and Watchlist

## 10. Goal

Prepare a deliberate, evidence-backed set of instruments and strategy combinations for the next trading session before the real-time decision path begins. [§10.1]

## 11. Operating Boundary

This workstream decides what deserves attention and under what conditions. It does not submit orders. [§11.1]

## 12. Responsibilities

1. Maintain the global market universe. [§12.1]
2. Maintain global and per-account watchlists. [§12.2]
3. Distinguish inherited and account-specific watchlists. [§12.3]
4. Screen instruments for liquidity. [§12.4]
5. Screen current spread and normal spread range. [§12.5]
6. Confirm market hours and session availability. [§12.6]
7. Confirm symbol mapping and broker tradability. [§12.7]
8. Confirm sufficient historical data. [§12.8]
9. Check current and recent volatility. [§12.9]
10. Check scheduled economic and market events. [§12.10]
11. Check financing and weekend-hold implications. [§12.11]
12. Assess current trend and volatility regime. [§12.12]
13. Match appropriate strategies to each instrument. [§12.13]
14. Identify unsuitable strategy-symbol combinations. [§12.14]
15. Calculate likely margin demand. [§12.15]
16. Detect correlated instruments and concentration. [§12.16]
17. Rank candidates by evidence quality and current suitability. [§12.17]
18. Remove stale or weak candidates. [§12.18]
19. Identify instruments requiring closer real-time observation. [§12.19]
20. Prepare conditional scenarios rather than fixed directional predictions. [§12.20]
21. Define what must occur before each candidate becomes actionable. [§12.21]

## 13. Watchlist Lifecycle

Each candidate should carry one controlled state. [§13.1]

`Discovered`  
→ `Under review`  
→ `Research candidate`  
→ `Session watch`  
→ `High-priority watch`  
→ `Entry-eligible`  
→ `Temporarily blocked, quarantined or removed`. [§13.2]

## 14. Candidate Plan

Every watchlist candidate should carry account scope, symbol, strategy, timeframe, entry mode, current regime, required setup, disqualifying conditions, expected session, maximum spread, event-risk window, risk class, confidence, evidence version, eligibility period and reason for inclusion. [§14.1]

## 15. Offline Watchlist Loop

**[LOOP-02 - Offline Watchlist Preparation Loop]** [§15.1]

`Review market universe`  
→ `Screen liquidity, spread, hours and data`  
→ `Assess regime and events`  
→ `Match strategy combinations`  
→ `Rank candidates`  
→ `Approve session watchlist`  
→ `Pass candidates to real-time sensing`  
→ `Receive live, post-trade and reflection feedback`  
→ `Add, downgrade, quarantine or remove candidates`  
→ back to `Review market universe`. [§15.2]

## 16. Cadence and Measures

A full preparation cycle should run before the principal trading session. Refreshes should run before major session openings, after material news and when volatility, spread or broker availability changes materially. [§16.1]

Measures should include percentage of trades originating from an approved candidate plan, watchlist-to-signal conversion, signal-to-approved conversion, performance by priority and inclusion reason, stale candidates, and trades on symbols absent from the relevant account watchlist. [§16.2]

---

# WS-03 - Real-Time Market Sensing and Opportunity Formation

## 17. Goal

Observe current market conditions and identify whether an approved watchlist candidate has become a valid trading opportunity. [§17.1]

## 18. Operating Boundary

This workstream creates and maintains a proposed trade opportunity. It does not approve risk or submit the order. [§18.1]

## 19. Responsibilities

1. Receive current prices, bars, spreads and session state. [§19.1]
2. Verify data source and timestamp. [§19.2]
3. Reject stale or incomplete data. [§19.3]
4. Confirm market-open status. [§19.4]
5. Monitor every active watchlist candidate. [§19.5]
6. Run only eligible strategies and approved timeframes. [§19.6]
7. Use closed bars where the strategy requires closed-bar confirmation. [§19.7]
8. Use tick-level logic only where explicitly designed and validated. [§19.8]
9. Detect strategy setups. [§19.9]
10. Calculate preliminary entry, stop and target geometry. [§19.10]
11. Record regime at signal time. [§19.11]
12. Record indicators, confluence and filters. [§19.12]
13. Detect duplicate or repeated proposals. [§19.13]
14. Distinguish a new opportunity from a persisting opportunity. [§19.14]
15. Create a stable opportunity identity. [§19.15]
16. Expire an opportunity when its setup no longer exists. [§19.16]
17. Escalate fast-moving opportunities without waiting for unrelated slower scans. [§19.17]

## 20. Opportunity Record

Every opportunity should include opportunity ID, timestamps, account eligibility, symbol, strategy, version, timeframe, entry mode, direction, proposed entry, stop, targets, planned reward-to-risk, regime, confluence, spread, session, expiry and current status. [§20.1]

## 21. Real-Time Sensing Loop

**[LOOP-03 - Real-Time Opportunity Loop]** [§21.1]

`Receive market update`  
→ `Validate freshness and market state`  
→ `Evaluate eligible strategy conditions`  
→ `Create or update opportunity`  
→ `Confirm, defer, invalidate or expire`  
→ `Send qualified opportunity to WS-04`  
→ `Continue monitoring until filled, vetoed or expired`  
→ back to `Receive market update`. [§21.2]

## 22. Cadence and Measures

Opportunity sensing should be strategy-specific. Tick or price-event logic should be used for strategies designed for rapid movement, per-minute checks for fast intraday state, and bar-close checks for closed-bar strategies. [§22.1]

A universal five-minute scan must not be treated as sufficient for every strategy or market. [§22.2]

Measures should include signal latency, stale-data rejection, duplicate-opportunity rate, expiry accuracy, context completeness and time from qualifying market condition to opportunity creation. [§22.3]

---

# WS-04 - Trade Decision, Risk Approval and Entry Execution

## 23. Goal

Convert a qualified opportunity into a correctly sized, authorised, broker-acknowledged and protected position. [§23.1]

## 24. Operating Boundary

This workstream begins when a valid opportunity exists and ends when the entry has reached a terminal disposition and any fill has been transferred to live trade management. [§24.1]

## 25. Responsibilities

1. Confirm the opportunity remains valid and unexpired. [§25.1]
2. Confirm the symbol remains tradable. [§25.2]
3. Confirm account mode permits entry. [§25.3]
4. Confirm the strategy is armed. [§25.4]
5. Confirm the symbol-strategy-timeframe combination is authorised. [§25.5]
6. Confirm the account watchlist permits the symbol. [§25.6]
7. Apply risk-based position sizing. [§25.7]
8. Apply position-size, exposure, drawdown and margin constraints. [§25.8]
9. Apply correlated-exposure and duplicate-symbol constraints. [§25.9]
10. Apply spread, slippage and event-risk restrictions. [§25.10]
11. Record every gate result. [§25.11]
12. Produce one final approval or veto. [§25.12]
13. Submit approved orders idempotently. [§25.13]
14. Record broker acknowledgement. [§25.14]
15. Resolve ambiguous submissions before retry. [§25.15]
16. Record full or partial fill. [§25.16]
17. Record rejection, cancellation or expiry. [§25.17]
18. Attach stop-loss and take-profit protection. [§25.18]
19. Verify the broker has accepted protective levels. [§25.19]
20. Transfer the filled position to WS-05. [§25.20]

## 26. Entry Lifecycle

`Opportunity created`  
→ `Eligibility confirmed`  
→ `Risk evaluated`  
→ `Approved or vetoed`  
→ `Order submitted`  
→ `Broker acknowledged`  
→ `Filled, rejected, cancelled, expired or uncertain`  
→ `Protection verified`  
→ `Transferred to trade management`. [§26.1]

## 27. Entry Execution Loop

**[LOOP-04 - Entry Decision and Execution Loop]** [§27.1]

`Receive qualified opportunity`  
→ `Revalidate market and policy`  
→ `Run risk gates`  
→ `Approve or veto`  
→ `Submit once`  
→ `Await broker response`  
→ `Reconcile ambiguous outcome if necessary`  
→ `Verify fill and protection`  
→ `Transfer position to WS-05 or close lifecycle`  
→ back to `Receive qualified opportunity`. [§27.2]

Every approved opportunity must have a recorded terminal disposition. No approval may disappear between the risk gate and order ledger. [§27.3]

## 28. Measures

Measures should include approval-to-submit conversion, submission-to-acknowledgement conversion, acknowledgement-to-fill conversion, ambiguous submissions, duplicate submissions, slippage, approval-to-submit latency, fill-to-protection latency and approvals without terminal disposition. [§28.1]

---

# WS-05 - Live Trade Management and Exit

## 29. Goal

Protect and manage every open position continuously from the moment it is filled until final broker-confirmed closure. [§29.1]

## 30. Importance

This is a separate and critical workstream because market risk continues after entry. A valid entry can still become a poor trade through rapid volatility, failed protection, excessive profit give-back, widening spread, delayed exits, margin stress or conflicting management authorities. [§30.1]

The live manager must operate at the speed appropriate to the instrument and risk. A five-minute strategy scan is not sufficient as the sole mechanism for managing exposed capital. [§30.2]

## 31. Operating Boundary

This workstream begins when a position is filled or adopted from the broker. It ends only after broker-confirmed closure and transfer to post-trade reconciliation. [§31.1]

## 32. Immediate Post-Fill Protection

1. Confirm that the broker position exists. [§32.1]
2. Confirm account, position identity, direction and volume. [§32.2]
3. Confirm average fill price. [§32.3]
4. Confirm broker-side stop-loss. [§32.4]
5. Confirm take-profit instructions where required. [§32.5]
6. Confirm protection matches the authorised plan. [§32.6]
7. Detect partial fills. [§32.7]
8. Adjust protection for actual fill details where required. [§32.8]
9. Alert immediately if the position is naked. [§32.9]
10. Protect or close the position according to fail-safe policy if protection cannot be established. [§32.10]

## 33. Continuous Monitoring Responsibilities

The live manager should monitor current bid and ask, spread, unrealised P&L, P&L in R, MFE, MAE, distance to stop and targets, time in trade, volatility changes, gaps, spikes, loss acceleration, profit give-back, session transitions, market-close proximity, financing, account margin, correlated positions, broker connectivity and manual broker-side changes. [§33.1]

## 34. Authorised Trade-Management Actions

Depending on strategy and policy, the manager may hold, reduce risk, move stop to breakeven, trail the stop, tighten protection, take partial profit, reduce exposure, cancel an unfilled remainder, apply a time cap, close before shutdown or weekend, close after strategy or regime invalidation, close under account emergency, close when protection is missing, close when execution reliability fails, or adopt an owner-modified position. [§34.1]

## 35. Exit Governance

Every exit must state its authority and reason, including broker stop, take-profit, time cap, strategy invalidation, profit protection, loss acceleration, portfolio risk, margin protection, session close, weekend risk, manual owner action, emergency kill, reconciliation-detected closure or technical safety. [§35.1]

## 36. Response-Speed Architecture

### 36.1 Layer 0 - Broker-Native Protection

**Response speed:** immediate at the broker. [§36.1.1]

Essential stop-loss and take-profit protection should reside at the broker wherever possible. These protections must continue to function when the application, database, network, Telegram or user interface is unavailable. [§36.1.2]

### 36.2 Layer 1 - Tick or Price-Event Safety Engine

**Response speed:** each relevant tick or price event. [§36.2.1]

This layer may manage hard trailing, rapid adverse movement, profit ratchets, gaps, spikes, price-triggered partial exits and urgent protection verification. [§36.2.2]

This path must be deterministic, lightweight and clearly authoritative. Two components must not unknowingly write the same stop. [§36.2.3]

### 36.3 Layer 2 - Fast Position Monitor

**Response speed:** several seconds to approximately 30 seconds, adjusted by instrument and risk. [§36.3.1]

This layer should confirm broker position and protection, detect manual changes, abnormal spread or loss acceleration, track MFE and MAE, assess margin and apply authorised management rules. [§36.3.2]

Thirty seconds may be a useful baseline, but it is not adequate for every volatile instrument. Event-driven protection should be used where necessary. [§36.3.3]

### 36.4 Layer 3 - Per-Minute Management Review

**Response speed:** approximately once per minute while a position is open, or earlier when triggered. [§36.4.1]

The review should assess thesis strength, regime, momentum, volatility, progress against expected time, management milestones, profit give-back, loss acceleration, current reward-to-risk, correlated exposure, session transitions, scheduled events and whether partial exit, stop adjustment or full exit is required. [§36.4.2]

Per-minute review does not mean changing the trade every minute. It means reviewing every minute and acting only when an authorised threshold or state transition occurs. [Agur] [§36.4.3]

### 36.5 Layer 4 - Bar-Close Strategic Review

**Response speed:** at the strategy's operating bar close. [§36.5.1]

This layer should recalculate closed-bar indicators, confirm whether the original strategy remains valid, detect formal opposite signals, apply bar-close exit rules and reassess the time cap and runner. [§36.5.2]

### 36.6 Layer 5 - Session and Portfolio Review

**Response speed:** at session transitions and major checkpoints. [§36.6.1]

Relevant checkpoints include London open, New York open, London close, New York close, Asia handover, equity-market shutdown, daily rollover, weekend approach and major scheduled events. [§36.6.2]

## 37. Live Trade-Management Loop

**[LOOP-05 - Continuous Live Trade-Management Loop]** [§37.1]

`Position filled or adopted`  
→ `Verify broker position and protection`  
→ `Start tick, fast and per-minute monitoring`  
→ `Evaluate price, risk, thesis, time and portfolio state`  
→ `Hold, amend, reduce, partially close or exit`  
→ `Confirm broker response`  
→ `Update internal management state`  
→ `Continue monitoring while position remains open`  
→ `Broker-confirmed closure`  
→ `Transfer to WS-06`. [§37.2]

This is a continuous loop while capital remains exposed. [§37.3]

## 38. Per-Minute Review Loop

**[LOOP-06 - Per-Minute Open-Position Review Loop]** [§38.1]

`Every open position becomes due for review`  
→ `Confirm fresh price and broker state`  
→ `Evaluate thesis, volatility, momentum, MFE, MAE, give-back, time and account risk`  
→ `Determine whether a management threshold has been crossed`  
→ `Take no action or issue one authorised action`  
→ `Confirm broker result`  
→ `Record reason, authority and next review time`  
→ `Repeat approximately one minute later while open`. [§38.2]

The per-minute loop must not overlap itself for the same position. If one cycle is delayed or still executing, the next cycle should report the delay and avoid conflicting actions. [§38.3]

## 39. Per-Position Management Contract

Every open position should have a management record containing position ID, parent opportunity ID, trade ID, account, symbol, strategy, strategy version, timeframe, entry mode, entry price, filled volume, initial and current stop, initial and remaining targets, initial and current risk, maximum authorised loss, open time, time cap, session policy, weekend policy, management-policy version, last broker confirmation, last price update, last minute review, last action, next required review and current management state. [§39.1]

## 40. Management State Machine

`Filled`  
→ `Protection pending`  
→ `Protected`  
→ `Actively managed`  
→ `Risk reduced`  
→ `Partial profit taken`  
→ `Runner managed`  
→ `Exit requested`  
→ `Broker closed`  
→ `Transferred for reconciliation`. [§40.1]

Exception states should include naked position, stale price, broker unavailable, amend uncertain, conflicting authority, manual intervention, margin emergency, exit uncertain, locally closed but broker open, and broker closed but internal state open. [§40.2]

## 41. Authority Hierarchy

1. Broker-native hard protection. [§41.1.1]
2. Emergency account and equity controls. [§41.1.2]
3. Tick-level safety engine. [§41.1.3]
4. Fast position manager. [§41.1.4]
5. Per-minute management policy. [§41.1.5]
6. Bar-close strategy management. [§41.1.6]
7. Human owner instruction. [§41.1.7]
8. Reconciliation correction. [§41.1.8]

Human owner actions should normally be respected and audited rather than automatically reversed, unless they violate a non-negotiable capital-safety rule. [§41.2]

## 42. Measures

Measures should include verified broker-stop coverage, fill-to-protection time, price-update age, position-review age, stop-amend success, exit success, exit latency, conflicting stop writers, naked-position seconds, profit give-back, MAE before risk reduction, planned-rule exits, emergency exits, manual interventions, broker-state disagreements and positions not reviewed within the required cadence. [§42.1]

## 43. Non-Negotiable Rule

A position must never be considered safely managed merely because the main strategy loop is running. Protection, active management, broker reconciliation and emergency authority must each have their own functioning and observable path. [§43.1]

---

# WS-06 - Post-Trade Truth and Performance

## 44. Goal

Reconstruct what happened economically, operationally and procedurally after every trade. [§44.1]

## 45. Responsibilities

This workstream should confirm final broker closure, exit price and volume, realised P&L, commission, financing, spread, slippage, partial exits, scale-ins, reversals, parent-child lineage, planned and actual protective levels, management actions, manual changes, MFE, MAE, R result, holding time and management latency. [§45.1]

It should identify incomplete financial records, unattributable outcomes and discrepancies between broker truth, internal state and displayed performance. [§45.2]

## 46. Post-Trade Reconciliation Loop

**[LOOP-07 - Post-Trade Truth Loop]** [§46.1]

`Broker reports closure`  
→ `Fetch deal and financial details`  
→ `Reconcile volume, price, costs and P&L`  
→ `Reconstruct management history`  
→ `Resolve partial-close and lineage records`  
→ `Mark complete or incomplete`  
→ `Publish performance record`  
→ `Send complete trade to WS-07`  
→ `Continue correction until broker and ledger agree`. [§46.2]

## 47. Measures

Measures should include complete financial fields, complete management histories, broker-to-ledger reconciliation, unattributed P&L, slippage, profit give-back by exit method, performance by management-policy version, emergency exits, technical exits and partial-close attribution completeness. [§47.1]

---

# WS-07 - Reflection, Diagnosis and Learning

## 48. Goal

Determine whether each trade was well conceived, correctly executed, properly managed and honestly recorded. [§48.1]

## 49. Responsibilities

The reflection process should review material losses, unusual wins, flat trades, excessive MAE, excessive give-back, late entries, premature exits, stop hunts, thesis failures, chop, time-cap exits, management delays, broker incidents, technical incidents, manual interventions, risk vetoes, missed approvals and correctly vetoed opportunities. [§49.1]

It must separate process quality from monetary outcome and state sample size, confidence and uncertainty. [§49.2]

## 50. Reflection Dimensions

Each trade should be assessed across watchlist quality, strategy suitability, entry quality, risk sizing, execution quality, protection quality, trade-management quality, exit quality, reconciliation quality and final outcome. [§50.1]

## 51. Lesson Record

Every lesson should contain a lesson ID, trade and opportunity IDs, observed issue, evidence, affected strategy combination, entry-management-exit category, sample size, confidence, proposed hypothesis, recommended offline test, recommended real-time diagnostic, disconfirming conditions, expiry date and approval status. [§51.1]

## 52. Reflection Loop

**[LOOP-08 - Reflection and Diagnosis Loop]** [§52.1]

`Receive reconciled trade`  
→ `Review outcome and full decision history`  
→ `Assess entry, execution, management and exit`  
→ `Classify lesson or mark inconclusive`  
→ `Aggregate repeated patterns`  
→ `Create LessonRecord`  
→ `Send hypothesis candidates to WS-08`  
→ `Receive experiment results`  
→ `Confirm, revise or reject lesson`  
→ back to `Review future reconciled trades`. [§52.2]

---

# WS-08 - Controlled Adaptation and Strategy Promotion

## 53. Goal

Convert reliable lessons into tested and reversible changes without allowing recent outcomes to rewrite live behaviour impulsively. [§53.1]

## 54. Change Lifecycle

`Lesson`  
→ `Hypothesis`  
→ `Historical replay`  
→ `Walk-forward test`  
→ `Shadow observation`  
→ `Demo trial`  
→ `Restricted live trial`  
→ `Evaluation`  
→ `Keep, modify or roll back`. [§54.1]

## 55. Responsibilities

This workstream should define expected improvement, harmful side effects, disconfirming evidence, historical tests, regime tests, cost sensitivity, parameter sensitivity, shadow observation, demo scope, restricted-live scope, maximum rollout risk, evaluation duration, rollback thresholds, configuration differences, author, approver and experiment results. [§55.1]

Reflection may trigger protective demotion when predefined thresholds are breached. It should not automatically increase position risk, loosen loss caps or arm untested live strategies. [§55.2]

## 56. Controlled Adaptation Loop

**[LOOP-09 - Learning-to-Deployment Loop]** [§56.1]

`LessonRecord approved for testing`  
→ `Create hypothesis and experiment`  
→ `Run historical and walk-forward tests`  
→ `Run shadow and demo trials`  
→ `Approve or reject restricted-live trial`  
→ `Deploy within bounded scope`  
→ `Measure declared outcome`  
→ `Keep, modify or roll back`  
→ `Feed validated learning into WS-01 and WS-02`  
→ `Feed approved operational change into WS-03, WS-04 or WS-05`  
→ back to `LessonRecord approved for testing`. [§56.2]

---

# WS-09 - Capital, Risk and Account Governance

## 57. Goal

Set the boundaries within which every other workstream must operate. [§57.1]

## 58. Responsibilities

This workstream should govern portfolio and per-account risk appetite, per-trade risk, daily loss, equity stop, drawdown, maximum positions, symbol exposure, correlated exposure, margin usage, margin level, free equity, account modes, demo-to-live graduation, live suspension, emergency kill, re-arming, manual override, policy changes and operating goals. [§58.1]

Risk governance defines policy. WS-04 and WS-05 enforce that policy at entry and throughout the life of the trade. [§58.2]

## 59. Risk Governance Loop

**[LOOP-10 - Risk Policy Review Loop]** [§59.1]

`Set risk appetite and account modes`  
→ `Enforce policy at entry and during open positions`  
→ `Measure actual risk consumption and breaches`  
→ `Review incidents, drawdown, margin and concentration`  
→ `Retain, tighten or formally amend policy`  
→ `Record approval and effective date`  
→ back to `Set risk appetite and account modes`. [§59.2]

---

# WS-10 - Platform, Data, Security and Reliability

## 60. Goal

Ensure the trading lifecycle has trustworthy data, functioning services, secure control paths and safe recovery. [§60.1]

## 61. Responsibilities

This workstream should govern price-feed availability, tick and bar freshness, broker-session health, sidecar health, agent-loop health, fast-monitor health, per-minute-manager health, heartbeats, event-loop delay, database persistence, backup, restore, credentials, read and control access, audit identity, environment parity, cost monitoring, alerts, restart reconciliation and disaster recovery. [§61.1]

Every live-management component should expose whether it is running, its last successful cycle, last market-data timestamp, last broker confirmation, current authority, current position count, latest error and whether another component is performing the same action. [§61.2]

## 62. Reliability Loop

**[LOOP-11 - Platform Health and Recovery Loop]** [§62.1]

`Observe service, data and broker health`  
→ `Detect stale, failed or conflicting state`  
→ `Degrade safely, alert or fail closed`  
→ `Recover or restart`  
→ `Reconcile open positions and pending actions`  
→ `Verify protection and authority`  
→ `Return to normal operation`  
→ back to `Observe service, data and broker health`. [§62.2]

---

# WS-11 - Verification, Release and Audit

## 63. Goal

Prove that capital-sensitive changes behave as intended before and after deployment. [§63.1]

## 64. Responsibilities

This workstream should cover unit tests, integration tests, broker-simulator tests, JavaScript and C++ parity, tick replay, per-minute trade-management tests, fast-market tests, price gaps, spread spikes, broker disconnection, partial fills, ambiguous submissions, stop-amend failure, exit failure, restart with open positions, manual intervention, database restore, staging, demo acceptance, restricted-live canary, independent review, deployment verification, rollback and incident audit. [§64.1]

## 65. Mandatory Trade-Management Scenarios

Before a trade-management release reaches live capital, it must prove the following. [§65.1]

1. A position receives broker protection immediately after fill. [§65.1.1]
2. A missing stop is detected and remediated. [§65.1.2]
3. A failed stop amend does not falsely update internal state. [§65.1.3]
4. A fast price move triggers the correct authority. [§65.1.4]
5. Two controllers cannot fight over the stop. [§65.1.5]
6. A partial close updates remaining volume correctly. [§65.1.6]
7. A manual broker change is detected. [§65.1.7]
8. A broker-side close is reconciled. [§65.1.8]
9. A process restart adopts and protects existing positions. [§65.1.9]
10. A stale price feed causes safe degradation. [§65.1.10]
11. A one-minute management cycle cannot overlap itself. [§65.1.11]
12. A delayed cycle is visible and alerted. [§65.1.12]
13. A failed exit remains open internally until broker truth confirms closure. [§65.1.13]
14. An emergency account stop overrides ordinary strategy management. [§65.1.14]

## 66. Release Assurance Loop

**[LOOP-12 - Verification and Release Loop]** [§66.1]

`Proposed change`  
→ `Unit and integration tests`  
→ `Replay and failure-mode tests`  
→ `Independent review`  
→ `Staging deployment`  
→ `Demo acceptance`  
→ `Restricted-live canary`  
→ `Production verification`  
→ `Monitor and rollback if necessary`  
→ `Incident or outcome review`  
→ back to `Proposed change`. [§66.2]

---

## 67. End-to-End Operating Loop

**[MASTER LOOP - Bot-Trading Operating Loop]** [§67.1]

`Strategy research`  
→ `Offline watchlist preparation`  
→ `Real-time market sensing`  
→ `Opportunity record`  
→ `Risk approval`  
→ `Entry execution`  
→ `Protection verification`  
→ `Continuous live trade management`  
→ `Per-minute open-position review`  
→ `Exit`  
→ `Broker reconciliation`  
→ `Performance record`  
→ `Reflection`  
→ `Hypothesis`  
→ `Offline and demo testing`  
→ `Controlled deployment`  
→ `Updated strategy, watchlist or operating policy`  
→ back to `Strategy research and offline preparation`. [§67.2]

The master loop contains nested loops operating at different speeds: strategy evidence over days to months, watchlist preparation by session or day, market sensing by tick to bar close, entry execution over milliseconds to minutes, trade management continuously, per-minute review approximately each minute while open, post-trade reconciliation after closure, reflection by trade and period, adaptation over days to months, and platform health continuously. [§67.3]

---

## 68. Programme Definition of Done

The operating model is complete only when all twelve strategies have current dossiers, every watchlist inclusion has a reason and expiry, every opportunity has a stable identity, every approval has a terminal disposition, every fill receives verified broker protection, every position is observed at its required speed and reviewed per minute, every management action names its authority and reason, conflicting controllers are prevented, every exit is broker-confirmed, every economic outcome reconciles, every material trade is reviewed, every lesson becomes a hypothesis before live change, every risk-expanding change is approved, and every deployment is testable and reversible. [§68.1]

---

# 69. Implementation Checklist

## 69.1 Programme and Governance

- [ ] Approve this operating goal plan as the programme baseline. [§69.1.1]
- [ ] Assign an owner to each workstream. [§69.1.2]
- [ ] Define decision rights for research, execution, risk, live management and release. [§69.1.3]
- [ ] Create one authoritative risk-policy register. [§69.1.4]
- [ ] Create one authoritative strategy registry. [§69.1.5]
- [ ] Define demo, restricted-live and full-live account modes. [§69.1.6]

## 69.2 Strategy Portfolio

- [ ] Complete dossiers for all twelve strategies. [§69.2.1]
- [ ] Record supported symbols, timeframes, entry modes and regimes. [§69.2.2]
- [ ] Record known failure modes. [§69.2.3]
- [ ] Record current backtest, walk-forward, demo and live evidence. [§69.2.4]
- [ ] Identify overlapping or duplicate strategies. [§69.2.5]
- [ ] Assign lifecycle status to every strategy. [§69.2.6]

## 69.3 Offline Watchlist

- [ ] Define watchlist lifecycle states. [§69.3.1]
- [ ] Add inclusion reason and expiry to every candidate. [§69.3.2]
- [ ] Add session, spread, event-risk and regime conditions. [§69.3.3]
- [ ] Add per-account candidate plans. [§69.3.4]
- [ ] Record watchlist-to-trade conversion. [§69.3.5]
- [ ] Remove or quarantine stale candidates automatically. [§69.3.6]

## 69.4 Opportunity and Entry Lifecycle

- [ ] Introduce a stable opportunity ID. [§69.4.1]
- [ ] Link opportunity, risk event, order, fill, trade and position records. [§69.4.2]
- [ ] Give every approved opportunity a terminal disposition. [§69.4.3]
- [ ] Prevent duplicate and ambiguous resubmissions. [§69.4.4]
- [ ] Record approval-to-submit and submit-to-fill latency. [§69.4.5]
- [ ] Verify broker-side protection immediately after fill. [§69.4.6]

## 69.5 Live Trade Management

- [ ] Make WS-05 a first-class programme workstream. [§69.5.1]
- [ ] Inventory every component that can amend, reduce or close a position. [§69.5.2]
- [ ] Define one authority hierarchy for stop and exit actions. [§69.5.3]
- [ ] Define the per-position management contract. [§69.5.4]
- [ ] Create an explicit management state machine. [§69.5.5]
- [ ] Confirm broker-native stop protection for every eligible position. [§69.5.6]
- [ ] Establish tick or event-driven protection for rapid markets. [§69.5.7]
- [ ] Establish the fast-position monitor. [§69.5.8]
- [ ] Establish a non-overlapping per-minute review loop. [§69.5.9]
- [ ] Record the last review and next review for every open position. [§69.5.10]
- [ ] Alert when a position misses its required review cadence. [§69.5.11]
- [ ] Record every management action, authority and reason. [§69.5.12]
- [ ] Confirm broker result before updating internal stop or closure state. [§69.5.13]
- [ ] Detect conflicting stop writers. [§69.5.14]
- [ ] Detect naked positions immediately. [§69.5.15]
- [ ] Test rapid loss, profit give-back, spread spike and gap scenarios. [§69.5.16]
- [ ] Test broker disconnection while positions remain open. [§69.5.17]
- [ ] Test restart and adoption of open broker positions. [§69.5.18]
- [ ] Connect live-management history to post-trade reflection. [§69.5.19]

## 69.6 Post-Trade Truth

- [ ] Complete P&L and exit fields for every closure path. [§69.6.1]
- [ ] Reconcile partial closes and tranche P&L. [§69.6.2]
- [ ] Preserve parent-child lineage for adds, reductions and reversals. [§69.6.3]
- [ ] Reconcile management actions with broker deals. [§69.6.4]
- [ ] Record MFE, MAE, give-back and management latency. [§69.6.5]
- [ ] Flag incomplete or unattributable trade records. [§69.6.6]

## 69.7 Reflection and Adaptation

- [ ] Standardise the LessonRecord schema. [§69.7.1]
- [ ] Review both winning and losing trades. [§69.7.2]
- [ ] Separate process quality from outcome. [§69.7.3]
- [ ] Link lessons to strategy dossiers. [§69.7.4]
- [ ] Convert lessons into explicit hypotheses. [§69.7.5]
- [ ] Require historical replay and walk-forward testing. [§69.7.6]
- [ ] Require shadow and demo evidence before live promotion. [§69.7.7]
- [ ] Define restricted-live rollout and rollback thresholds. [§69.7.8]
- [ ] Prevent automatic risk expansion from weak samples. [§69.7.9]

## 69.8 Platform and Reliability

- [ ] Expose health for every controller and loop. [§69.8.1]
- [ ] Expose last successful run and last data timestamp. [§69.8.2]
- [ ] Expose current authority for each live-management component. [§69.8.3]
- [ ] Detect stale price, broker and account snapshots. [§69.8.4]
- [ ] Test database backup and restore. [§69.8.5]
- [ ] Test restart reconciliation with open positions. [§69.8.6]
- [ ] Separate read-only and control credentials. [§69.8.7]
- [ ] Record actor identity for material configuration changes. [§69.8.8]

## 69.9 Verification and Release

- [ ] Add unit tests for all management state transitions. [§69.9.1]
- [ ] Add integration tests for fill, protection, amend and exit. [§69.9.2]
- [ ] Add tick-replay tests. [§69.9.3]
- [ ] Add per-minute loop overlap tests. [§69.9.4]
- [ ] Add fast-market and stale-data tests. [§69.9.5]
- [ ] Add JavaScript and C++ parity tests. [§69.9.6]
- [ ] Require independent review for capital-sensitive changes. [§69.9.7]
- [ ] Require staging and demo acceptance. [§69.9.8]
- [ ] Use restricted-live canary deployment. [§69.9.9]
- [ ] Verify rollback before production release. [§69.9.10]

---

## 70. Immediate Priorities

1. Establish WS-05 as an independent workstream. [§70.1]
2. Inventory all current trade-management controllers and authorities. [§70.2]
3. Define one per-position management record and state machine. [§70.3]
4. Implement the non-overlapping per-minute management loop. [§70.4]
5. Ensure broker-native protection remains the primary safety layer. [§70.5]
6. Ensure rapid markets use tick or event-driven safeguards. [§70.6]
7. Ensure the five-minute strategy loop is never the sole position protector. [§70.7]
8. Close approval-to-order silent gaps. [§70.8]
9. Complete trade lineage and P&L reconciliation. [§70.9]
10. Connect management history to reflection and controlled adaptation. [§70.10]

---

## 71. Closing Operating Principle

Research carefully. Prepare deliberately. Sense the market continuously. Enter only with authority. Protect immediately. Review every open position at the required speed. Manage without overreacting. Reconcile every outcome. Reflect honestly. Test every lesson. Promote cautiously. Roll back quickly when evidence turns against the change. [§71.1]
