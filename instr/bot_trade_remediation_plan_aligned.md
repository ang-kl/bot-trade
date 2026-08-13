1.0 Master Engineering Specification & AI Fix Contract Syntax
1.1 Specification Header & Metadata
* Project Target: ang-kl/bot-trade
* Purpose: Advanced AI Alignment, Risk Gate Hardening, and Capital Protection Specification
* Framework Standard: Intent -> Context -> Interpretation -> Gap Analysis -> Assumptions (E/C/I/A) -> Invariants -> Contract -> Execute -> Evidence


________________


2.0 AI Prompt Syntax (Paste Directly into AI Coding Agent)
# TASK CONTRACT & SPECIFICATION FOR AI CODING AGENT (CURSOR / CLAUDE / CODEX / CHATGPT)


### 2.1 ALIGNMENT FRAMEWORK & EXECUTION DIRECTIVE


You are an expert quantitative software engineer refactoring the `ang-kl/bot-trade` automated trading repository. To prevent "probabilistic completion errors" (AI filler-thought drift), you MUST strictly adhere to this Specification Contract. You are permitted to execute code changes ONLY if they satisfy all explicit Intent parameters, Assumptions classifications, and System Invariants.


---


### 2.2 INTENT & CONTEXT


* **Intent:** Halt active capital depletion ($35,438.75 balance from $50,000 initial deposit), eliminate negative mathematical expectancy, fix non-USD contract valuation errors, stop re-entrant order storms, disable premature time-cap liquidations, and restore positive expected value.


* **Context:** Node.js/SQLite architecture, cTrader Open API, Railway deployment, 23 heartbeat loops, 25 symbols x 6 timeframes x 12 strategies, $178/day LLM spend.


---


### 2.3 ASSUMPTIONS CLASSIFICATION MATRIX (E / C / I / A)


All system assumptions are categorized below to govern AI implementation choices:


* **E — Explicit (Human Directed):**


  - **E1:** Hard floor `minRR >= 2.8 : 1` (default target: `3.5 : 1`).


  - **E2:** Remove 30m/1h fixed minute time caps (`time_cap_expired`).


  - **E3:** Raise Profit Keeper arming threshold from $+0.01\text{R}$ to $\ge +1.2\text{R}$.


  - **E4:** Stop minute-by-minute LLM position polling.


* **C — Contextual (Established by Repository/System):**


  - **C1:** Contract sizing on `JPN225`, `USDX`, `EURX` failed cross-rate USD conversion (PR #690).


  - **C2:** Exit prices recorded with decimal magnitude shifts (PR #691).


  - **C3:** Duration clock evaluated `placed_at` instead of `fill_at` (PR #697).


  - **C4:** Roster repair script auto-enabled disabled accounts on reboot (PR #702/#704).


* **I — Inferred (AI Derived & Validated):**


  - **I1:** 17 duplicate `DOW.US` orders in 1 ms caused by re-entrant event loops lacking idempotency locks.


  - **I2:** Opposing Long/Short positions on identical symbols (`GD.US`, `0003.HK`) lock margin and double spreads for net-zero market exposure.


  - **I3:** Cup & Handle strategy (825k traces, 0 executed) is dead code in the scanner causing CPU churn.


* **A — Assumed (Governed by Hard Invariants Below):**


  - **A1:** Idempotency key TTL set to 60 seconds is sufficient to absorb network retry spikes.


  - **A2:** Replacing tight ATR trailing stops with 15m/1h swing-structure trailing allows trades room to reach 2R/3R targets (`TP1`).


---


### 2.4 UNBREAKABLE SYSTEM INVARIANTS (RULES THAT MUST NEVER BE BROKEN)


1. **Invariant 1 (Notional Exposure Safety Floor):** No trade order shall ever be dispatched if its calculated USD Notional Exposure ($\text{Lots} \times \text{Contract Size} \times \text{Price} \times \text{FX Cross Rate}$) exceeds `accountBalance * maxRiskCapPct` (hard cap: 1.5%).


2. **Invariant 2 (Mathematical Expectancy Floor):** No trade signal shall ever be approved by the risk gate if its planned Reward-to-Risk ratio is below $2.8 : 1$, or if calculated Expected Value $E \le 0.15\text{R}$.


3. **Invariant 3 (Atomic Order Idempotency):** No two orders sharing the same `IdempotencyKey` ($\text{hash}(\text{accountId} + \text{symbol} + \text{strategy} + \text{direction} + \text{signalTimestamp})$) shall ever be submitted to the broker within 60 seconds.


4. **Invariant 4 (Directional Uniqueness per Symbol):** An account shall never hold concurrent Long and Short positions on the same symbol.


5. **Invariant 5 (Account Roster Persistence):** A server reboot, roster repair script, or role update shall NEVER modify an explicit `enabled = 0` database setting without direct user input.


---


### 2.5 WORKING CONTRACT: FILE-BY-FILE CODE REFACTORING


#### 2.5.1 File: `agent/services/pending-orders.js`


1. Enforce USD Notional Sizing: Calculate $\text{USD Notional} = \text{Lots} \times \text{Contract Size} \times \text{Price} \times \text{FX Rate}$. Reject order if exposure > 1.5% balance.


2. Implement atomic `IdempotencyKey` cache (60s TTL). Abort duplicate attempts with log `DUPLICATE_ORDER_DISPATCH_BLOCKED`.


#### 2.5.2 File: `agent/services/risk-gate.js` & `agent/routes/actions.js`


1. Enforce `minRR >= 2.8` code floor. Override database parameters if `minRR < 2.8`.


2. Evaluate expected value $E = (W \times \text{minRR}) - ((1 - W) \times 1.0)$. Veto if $E \le 0.15\text{R}$.


#### 2.5.3 File: `agent/services/loss-guardian.js` & `agent/services/naked-position-guard.js`


1. Remove fixed 30m/1h force-closure timers for technical setups.


2. Calculate position duration strictly from `fill_at` timestamp.


3. Enforce technical exits ($SL$, $TP$, structure invalidation, emergency $3 \times \text{ATR}$ floor).


#### 2.5.4 File: `agent/services/profit-keeper.js`


1. Raise arming threshold to $\ge +1.2\text{R}$.


2. Replace tight ATR trailing with structure trailing behind 15m/1h swing highs/lows.


#### 2.5.5 File: `agent/services/scanner.js`


1. Enforce Mutually Exclusive Directionality: Reject signal $-D$ on `Symbol X` if position $D$ is open.


2. Cap net cluster directional exposure ($\pm 2.0$ max on US Equity Beta).


#### 2.5.6 File: `agent/services/account-capabilities.js`


1. Patch `repairRosterMembership()` to respect explicit `enabled = 0` flags.


2. Scope all queries with `WHERE account_id = ? AND account_id IS NOT NULL`.


#### 2.5.7 File: `agent/services/position_monitor.js` & Broker Dispatchers


1. Tag all orders with mandatory strategy labels (`openapi_cbot-t`).


2. Replace LLM polling with local deterministic C++/Node.js price-check rules.


---


### 2.6 EVIDENCE & ACCEPTANCE TESTING SUITE (`npm test`)


1. **Test 2.6.1 (Notional Exposure Calculation):** Verify 72.5 lots of `JPN225` or 22 lots of `EURX` trigger `NOTIONAL_EXPOSURE_EXCEEDED`.


2. **Test 2.6.2 (Expectancy Floor Gate):** Verify `minRR = 1.2` signals trigger `MIN_RR_BELOW_EXPECTANCY_FLOOR`.


3. **Test 2.6.3 (Order Idempotency Lock):** Simulate 20 concurrent duplicate HTTP POSTs; verify 1 order executes and 19 return `DUPLICATE_ORDER_DISPATCH_BLOCKED`.


4. **Test 2.6.4 (Fill-Time Clock Calculation):** Verify duration evaluates from $T_{\text{fill}}$, not $T_{\text{placed}}$.


5. **Test 2.6.5 (Roster Preservation on Reboot):** Verify `repairRosterMembership()` preserves `enabled = 0`.


________________


3.0 Evaluation of File Clarity & Architectural Alignment
3.1 Clarity & Completeness Assessment
1. 3.1.1 Elimination of Ambiguity: By explicitly categorizing requirements into Explicit (E), Contextual (C), Inferred (I), and Assumed (A), the specification removes guesswork for the AI coding agent.
2. 3.1.2 Bounding AI "Filler Thoughts": Section 2.4 establishes 5 unbreakable System Invariants that act as hard guardrails. The AI coding agent is strictly prohibited from generating completion code that violates any invariant.
3. 3.1.3 Executable Contract: The prompt syntax transitions software development from "vague prompt iterations" to a formal Working Contract backed by automated acceptance tests (npm test).


________________


4.0 Analysis of Items Previously Missed by User & System
4.1 Re-Entrant Order Dispatching (Duplicate Orders)
1. Discovery: In statement-07_05 12.08.2026.csv, 17 identical DOW.US trades (DID312704298–DID312704314) were placed at 04 Aug 23:31:48, costing -$1,615.00.
2. Impact: System lacked order deduplication, allowing event loop spikes to submit duplicate orders.
4.2 Cross-Currency Valuation Failure Across Multiple Asset Classes
1. Discovery: Single-trade catastrophic losses occurred on JPN225 (-$9,171.76), USDX (-$1,090.00), and EURX (-$2,535.41 in 2 minutes).
2. Impact: The valuation bug affected all non-USD currency indices and CFDs, requiring systemic cross-rate conversion.
4.3 Premature Time-Cap Clock Bug (PR #697)
1. Discovery: Duration clock calculated elapsed time from placed_at instead of fill_at (GitHub PR #697).
2. Impact: Resting limit orders that took 25–30 minutes to fill were force-closed 0–5 minutes after fill.
4.4 Blind Risk Gates (PR #692)
1. Discovery: Three risk gates contained SQL query syntax bugs (GitHub PR #692).
2. Impact: Risk gates ran "blindly," allowing invalid signals to pass.
4.5 Exit Price Magnitude Corruption (PR #691)
1. Discovery: Database stored exit prices with decimal place shifts (GitHub PR #691).
2. Impact: Corrupted P&L statistics and bypassed sign-check validation.
4.6 Session-Open Guard Traps
1. Discovery: Guard locks Stop Loss to breakeven if profit reaches $\ge 0.3R$ in the first 30 minutes of major session opens.
2. Impact: Opening market volatility causes immediate breakeven stop-outs.
4.7 Railway Infrastructure Instability
1. Discovery: Production and staging environments suffered repeated deployment crashes on Railway (Email — Railway Deployment Crashes).
2. Impact: Open positions were left unmonitored during backend downtime.
4.8 Cup & Handle Dead Code in Scanner
1. Discovery: Cup & Handle strategy evaluated 825,676 scan traces, but 0 trades ever executed (203k failed shape checks, 0 cleared $R:R$ floor).
2. Impact: Dead code causing scan phase compute waste.


________________


5.0 Implementation & Verification Checklist
5.1 Pre-Implementation Safeguards
* 5.1.1 Set Autotrade = OFF in master dashboard before applying code edits.
* 5.1.2 Create git backup branch: git checkout -b refactor/risk-hardening-v2.
5.2 Codebase Refactoring Tasks
* 5.2.1 Patch agent/services/pending-orders.js with USD Notional Exposure caps.
* 5.2.2 Patch agent/services/pending-orders.js with IdempotencyKey deduplication lock.
* 5.2.3 Hardcode minRR >= 2.8 floor in agent/services/risk-gate.js.
* 5.2.4 Disable fixed 30m/1h time caps in agent/services/loss-guardian.js.
* 5.2.5 Ensure duration clock calculates strictly from fill_at in agent/services/loss-guardian.js.
* 5.2.6 Raise Profit Keeper arming threshold to $\ge +1.2\text{R}$ in agent/services/profit-keeper.js.
* 5.2.7 Enforce Mutually Exclusive Directionality in agent/services/scanner.js.
* 5.2.8 Patch agent/services/account-capabilities.js to preserve enabled = 0 on reboot.
* 5.2.9 Pass mandatory strategy tags (openapi_cbot-t) on all API order dispatchers.
* 5.2.10 Replace minute-by-minute LLM position polling with local code rules in agent/services/position_monitor.js.
5.3 Automated Verification Testing (npm test)
* 5.3.1 Execute Unit Test 1: Verify 72.5 lots of JPN225 trigger NOTIONAL_EXPOSURE_EXCEEDED.
* 5.3.2 Execute Unit Test 2: Verify minRR = 1.2 signals trigger MIN_RR_BELOW_EXPECTANCY_FLOOR.
* 5.3.3 Execute Unit Test 3: Verify 20 concurrent duplicate HTTP POSTs produce 1 order and 19 DUPLICATE_ORDER_DISPATCH_BLOCKED rejections.
* 5.3.4 Execute Unit Test 4: Verify duration calculation uses fill_at timestamp.
* 5.3.5 Execute Unit Test 5: Verify repairRosterMembership() preserves enabled = 0 state.
5.4 Integration & Backtest Simulation
* 5.4.1 Run refactored risk engine against statement-07_05 12.08.2026.csv dataset.
* 5.4.2 Confirm catastrophic losses (JPN225, USDX, EURX) and duplicate DOW.US orders are vetoed.
* 5.4.3 Deploy to Railway staging environment; monitor for 24 hours on Demo account before live re-arming.