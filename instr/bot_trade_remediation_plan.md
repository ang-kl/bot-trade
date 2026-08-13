# 1.0 Master Engineering Specification & AI Fix Prompt Syntax

## 1.1 Specification Header & Metadata

* **Project Target:** `ang-kl/bot-trade`  
* **Purpose:** Systemic Codebase Refactoring, Risk Gate Hardening, and Capital Protection Implementation  
* **Primary Objective:** Eliminate capital depletion mechanisms, resolve position-sizing bugs, enforce positive mathematical expectancy, and restore trading profitability.

---

## 2.0 AI Prompt Syntax (Paste Directly into AI Coding Agent)

\# TASK SPECIFICATION FOR AI CODING AGENT (CURSOR / CLAUDE / CODEX / CHATGPT)

\#\#\# 2.1 CONTEXT & MISSION OBJECTIVE

You are an expert quantitative software engineer refactoring the \`ang-kl/bot-trade\` automated trading repository. The system is experiencing severe capital drawdown (-29.31% cumulative drawdown, ending balance $35,438.75 on a $50,000.00 initial deposit) driven by contract valuation bugs, negative mathematical expectancy, re-entrant order dispatching, premature time-cap liquidations, and multi-account state leakage.

Your mission is to implement strict, non-bypassable pre-flight risk checks, correct position sizing logic, enforce positive expectancy math, eliminate time-cap liquidations, deduplicate order dispatches, and pass all unit/integration test suites before live deployment.

\---

\#\#\# 2.2 DETAILED FILE-BY-FILE REFRACTORING SPECIFICATIONS

\#\#\#\# 2.2.1 File: \`agent/services/pending-orders.js\`

\* \*\*Problem:\*\* Sizing logic calculates raw contract lots on non-USD instruments (e.g., \`JPN225\`, \`USDX\`, \`EURX\`, \`XPTUSD\`, \`USDZAR\`) assuming 1 point equals standard FX pip values, bypassing USD cross-rate conversion. Additionally, re-entrant dispatch loops execute duplicate trades in the same millisecond (e.g., 17 duplicate \`DOW.US\` trades).

\* \*\*Refactoring Requirements:\*\*

  1\. \*\*Enforce Absolute USD Notional Sizing:\*\* Before dispatching any order, compute the exact USD Notional Exposure:

     $$\\text{USD Notional} \= \\text{Lots} \\times \\text{Contract Size} \\times \\text{Current Price} \\times \\text{FX Cross Rate to USD}$$

  2\. \*\*Notional Cap Check:\*\* Reject any order if \`USD Notional\` exceeds \`accountBalance \* maxRiskCapPct\` (hard cap: 1.5% max risk per trade).

  3\. \*\*Order Deduplication & Idempotency Key:\*\* Implement an \`IdempotencyKey\` for every signal:

     $$\\text{IdempotencyKey} \= \\text{hash}(\\text{accountId} \+ \\text{symbol} \+ \\text{strategy} \+ \\text{direction} \+ \\text{signalTimestamp})$$

  4\. Store \`IdempotencyKey\` in an in-memory TTL cache (60 seconds) or SQLite table \`active\_order\_locks\`. If an incoming order matches an active key, immediately abort execution with log \`DUPLICATE\_ORDER\_DISPATCH\_BLOCKED\`.

\#\#\#\# 2.2.2 File: \`agent/services/risk-gate.js\` & \`agent/routes/actions.js\`

\* \*\*Problem:\*\* Account overrides permit \`minRR \= 1.2 : 1\`. On the system's \~25-26% win rate, breakeven requires $R:R \\ge 2.84 : 1$, creating a negative expected value of $-0.428R$ per trade.

\* \*\*Refactoring Requirements:\*\*

  1\. \*\*Hard Reward-to-Risk Floor:\*\* Implement a non-bypassable code floor: Reject any trade signal with planned Reward-to-Risk ratio below \*\*2.8 : 1\*\* (default target: \*\*3.5 : 1\*\*).

  2\. Override database settings if \`minRR \< 2.8\`.

  3\. \*\*Dynamic Expectancy Validation:\*\* Compute expected value $E$ before approving any signal:

     $$E \= (W \\times \\text{minRR}) \- ((1 \- W) \\times 1.0) \\quad (\\text{where } W \= \\text{rolling 30-day win rate})$$

     If $E \\le 0.15\\text{R}$, reject signal with \`NEGATIVE\_EXPECTANCY\_VETO\`.

\#\#\#\# 2.2.3 File: \`agent/services/loss-guardian.js\` & \`agent/services/naked-position-guard.js\`

\* \*\*Problem:\*\* Loss Guardian enforces a 30m/1h time cap (\`time\_cap\_expired\`), force-closing setups during initial consolidation. Over 90% of time-capped trades liquidate at a loss. Furthermore, duration clocks historically started at order placement rather than fill time (PR \#697).

\* \*\*Refactoring Requirements:\*\*

  1\. \*\*Disable Fixed Minute Time Caps:\*\* Remove 30m/1h force-closure timers for technical setups (\`15m\`, \`1h\`, \`4h\`).

  2\. \*\*Enforce Fill-Time Duration:\*\* Ensure any duration or expiration calculation uses strictly the \`fill\_at\` timestamp, never \`placed\_at\`.

  3\. \*\*Technical Exit Enforcement:\*\* Ensure positions exit strictly via:

     \- Broker-side Stop Loss ($SL$) or Take Profit ($TP$).

     \- Technical structure invalidation.

     \- Hard Emergency Loss Floor ($3 \\times \\text{ATR}$).

\#\#\#\# 2.2.4 File: \`agent/services/profit-keeper.js\`

\* \*\*Problem:\*\* Profit Keeper arms at $+0.01\\text{R}$ (+0.01% balance / 1x ATR) and trails a tight 2.5x ATR stop, truncating winning trades at micro-profits (+0.01R to \+0.15R) before reaching \`TP1\`.

\* \*\*Refactoring Requirements:\*\*

  1\. \*\*Raise Arming Threshold:\*\* Do not arm Profit Keeper until trade unrealized profit reaches \*\*$\\ge \+1.2\\text{R}$\*\*.

  2\. \*\*Structure-Based Trailing:\*\* Replace tight ATR trailing with structure trailing behind 15m/1h swing highs/lows, allowing trades room to capture full 2R/3R targets (\`TP1\`).

\#\#\#\# 2.2.5 File: \`agent/services/scanner.js\`

\* \*\*Problem:\*\* Scanner generates simultaneous opposing signals on identical symbols (\`GD.US\`, \`0003.HK\`) and net-zero correlation clusters (\`NAS100\` Long \+ \`US30\` Short), locking margin and doubling spread costs.

\* \*\*Refactoring Requirements:\*\*

  1\. \*\*Mutually Exclusive Directionality:\*\* If an active position exists on \`Symbol X\` in direction \`D\`, reject all incoming signals in direction \`-D\` for \`Symbol X\`.

  2\. \*\*Correlation Cluster Netting:\*\* Cap net directional exposure across correlated asset clusters (e.g., US Equity Beta net position must not exceed $\\pm 2.0$).

\#\#\#\# 2.2.6 File: \`agent/services/account-capabilities.js\`

\* \*\*Problem:\*\* Server reboots run \`repairRosterMembership()\`, which scans unassigned \`account\_id IS NULL\` rows and auto-enables disabled or \`manage\_only\` accounts (PR \#702/PR \#704).

\* \*\*Refactoring Requirements:\*\*

  1\. Patch \`repairRosterMembership()\` to respect explicit \`enabled \= 0\` database flags.

  2\. Scope all position and order queries strictly with \`WHERE account\_id \= ? AND account\_id IS NOT NULL\`.

\#\#\#\# 2.2.7 File: \`agent/services/position\_monitor.js\` & Broker Dispatchers

\* \*\*Problem:\*\* 50.5% of losses fall into unlabelled \`other\` bucket; $178/day spent on 123k+ LLM polling calls.

\* \*\*Refactoring Requirements:\*\*

  1\. Pass mandatory strategy tags (\`label \= strategy\_name\`) on all API order submissions (\`openapi\_cbot-t\`).

  2\. Replace minute-by-minute LLM position polling loops with local deterministic C++/Node.js price-check rules.

  3\. Restrict LLM API calls to asynchronous macro-regime evaluation run once per hour/day.

---

# 3.0 Comprehensive List of Assumptions & Core Invariants

## 3.1 Assumptions (Why to Change)

1. **3.1.1 Win-Rate Stability Assumption:** The historical win rate (\~25–26%) is a structural baseline of the entry strategy. Expecting win rates to instantly jump to 50% without strategy changes is unrealistic; therefore, entry quality must be governed by raising $R:R$ thresholds ($\\ge 2.8 : 1$).  
2. **3.1.2 Contract Valuation Non-Uniformity:** Non-USD CFD contracts (`JPN225`, `USDX`, `EURX`, `XPTUSD`, `USDZAR`) have non-standard contract sizes and quote currencies that require explicit USD cross-rate conversion before lot calculation.  
3. **3.1.3 Market Noise & Time Horizon:** Short-term market noise on 1m–15m timeframes causes price to fluctuate. Forcing 30-minute time caps liquidates trades prematurely during normal consolidation.  
4. **3.1.4 Idempotency & Re-Entrancy:** Asynchronous Node.js event loops can trigger duplicate execution requests within milliseconds under heavy load unless guarded by atomic idempotency locks.  
5. **3.1.5 Deterministic vs. LLM Efficiency:** Local C++/Node.js code can evaluate price levels, trailing stops, and risk caps in sub-milliseconds at $0 cost, whereas LLM polling introduces latency, network dependencies, and $3,270+/month in API overhead.

## 3.2 Core Invariants (Unbreakable Rules That Must Hold)

1. **3.2.1 Invariant 1 (Notional Exposure Safety Floor):** No trade shall ever be dispatched if its calculated USD Notional Exposure exceeds `accountBalance * maxRiskCapPct` (hard cap: 1.5%).  
2. **3.2.2 Invariant 2 (Mathematical Expectancy Floor):** No trade shall ever be approved by the risk gate if its planned Reward-to-Risk ratio is below $2.8 : 1$.  
3. **3.2.3 Invariant 3 (Atomic Order Idempotency):** No two orders sharing the same `IdempotencyKey` shall ever be submitted to the broker within a 60-second window.  
4. **3.2.4 Invariant 4 (Directional Uniqueness per Symbol):** An account shall never hold concurrent Long and Short positions on the same symbol.  
5. **3.2.5 Invariant 5 (Account Roster Persistence):** A server reboot, roster repair script, or role update shall NEVER modify an explicit `enabled = 0` database setting without direct user input.

---

# 4.0 Analysis of Items Previously Missed by User & System

## 4.1 Re-Entrant Order Dispatching (Duplicate Orders)

1. **Discovery:** In `statement-07_05 12.08.2026.csv`, 17 identical `DOW.US` trades (`DID312704298`–`DID312704314`) were placed at `04 Aug 23:31:48`, costing \-$1,615.00.  
2. **Impact:** System lacked order deduplication, allowing event loop spikes to submit duplicate orders.

## 4.2 Cross-Currency Valuation Failure Across Multiple Asset Classes

1. **Discovery:** Single-trade catastrophic losses occurred on `JPN225` (-$9,171.76), `USDX` (-$1,090.00), and `EURX` (-$2,535.41 in 2 minutes).  
2. **Impact:** The valuation bug affected all non-USD currency indices and CFDs, requiring systemic cross-rate conversion.

## 4.3 Premature Time-Cap Clock Bug (PR \#697)

1. **Discovery:** Duration clock calculated elapsed time from `placed_at` instead of `fill_at` ([GitHub PR \#697](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DNH0vtaQtExvQuDoHUdLbYb8iiDZYDr0Co&mid=19fe98dd7c2b49f2)).  
2. **Impact:** Resting limit orders that took 25–30 minutes to fill were force-closed 0–5 minutes after fill.

## 4.4 Blind Risk Gates (PR \#692)

1. **Discovery:** Three risk gates contained SQL query syntax bugs ([GitHub PR \#692](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DP_J030S8Z1J_6Zg14R20z40P1&mid=19fdeda1ebf5a649)) that failed to retrieve historical trade rows.  
2. **Impact:** Risk gates ran "blindly," allowing invalid signals to pass.

## 4.5 Exit Price Magnitude Corruption (PR \#691)

1. **Discovery:** Database stored exit prices with decimal place shifts ([GitHub PR \#691](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMC0vK3O20q23xQp_Z219cR-p3A&mid=19fdec9c14a674a1)).  
2. **Impact:** Corrupted P\&L statistics and bypassed sign-check validation.

## 4.6 Session-Open Guard Traps

1. **Discovery:** Guard locks Stop Loss to breakeven if profit reaches $\\ge 0.3R$ in the first 30 minutes of major session opens.  
2. **Impact:** Opening market volatility causes immediate breakeven stop-outs.

## 4.7 Railway Infrastructure Instability

1. **Discovery:** Production and staging environments suffered repeated deployment crashes on Railway ([Email — Railway Deployment Crashes](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DP39k941SwEHkZHCSR5zb2SrcXTRmzgqYo&mid=19fee10252525b1e)).  
2. **Impact:** Open positions were left unmonitored during backend downtime.

## 4.8 Cup & Handle Dead Code in Scanner

1. **Discovery:** Cup & Handle strategy evaluated 825,676 scan traces, but 0 trades ever executed (203k failed shape checks, 0 cleared $R:R$ floor).  
2. **Impact:** Dead code causing scan phase compute waste.

---

# 5.0 Implementation & Verification Checklist

## 5.1 Pre-Implementation Safeguards

- [ ] 5.1.1 Set `Autotrade = OFF` in master dashboard before applying code edits.  
- [ ] 5.1.2 Create git backup branch: `git checkout -b refactor/risk-hardening-v2`.

## 5.2 Codebase Refactoring Tasks

- [ ] 5.2.1 Patch `agent/services/pending-orders.js` with USD Notional Exposure caps.  
- [ ] 5.2.2 Patch `agent/services/pending-orders.js` with `IdempotencyKey` deduplication lock.  
- [ ] 5.2.3 Hardcode `minRR >= 2.8` floor in `agent/services/risk-gate.js`.  
- [ ] 5.2.4 Disable fixed 30m/1h time caps in `agent/services/loss-guardian.js`.  
- [ ] 5.2.5 Ensure duration clock calculates strictly from `fill_at` in `agent/services/loss-guardian.js`.  
- [ ] 5.2.6 Raise Profit Keeper arming threshold to $\\ge \+1.2\\text{R}$ in `agent/services/profit-keeper.js`.  
- [ ] 5.2.7 Enforce Mutually Exclusive Directionality in `agent/services/scanner.js`.  
- [ ] 5.2.8 Patch `agent/services/account-capabilities.js` to preserve `enabled = 0` on reboot.  
- [ ] 5.2.9 Pass mandatory strategy tags (`openapi_cbot-t`) on all API order dispatchers.  
- [ ] 5.2.10 Replace minute-by-minute LLM position polling with local code rules in `agent/services/position_monitor.js`.

## 5.3 Automated Verification Testing (`npm test`)

- [ ] 5.3.1 Execute Unit Test 1: Verify 72.5 lots of `JPN225` trigger `NOTIONAL_EXPOSURE_EXCEEDED`.  
- [ ] 5.3.2 Execute Unit Test 2: Verify `minRR = 1.2` signals trigger `MIN_RR_BELOW_EXPECTANCY_FLOOR`.  
- [ ] 5.3.3 Execute Unit Test 3: Verify 20 concurrent duplicate HTTP POSTs produce 1 order and 19 `DUPLICATE_ORDER_DISPATCH_BLOCKED` rejections.  
- [ ] 5.3.4 Execute Unit Test 4: Verify duration calculation uses `fill_at` timestamp.  
- [ ] 5.3.5 Execute Unit Test 5: Verify `repairRosterMembership()` preserves `enabled = 0` state.

## 5.4 Integration & Backtest Simulation

- [ ] 5.4.1 Run refactored risk engine against `statement-07_05 12.08.2026.csv` dataset.  
- [ ] 5.4.2 Confirm catastrophic losses (`JPN225`, `USDX`, `EURX`) and duplicate `DOW.US` orders are vetoed.  
- [ ] 5.4.3 Deploy to Railway staging environment; monitor for 24 hours on Demo account before live re-arming.

