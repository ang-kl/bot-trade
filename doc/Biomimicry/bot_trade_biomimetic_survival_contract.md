# 1.0 Master Biomimetic Engineering Specification & AI Refactoring Contract

## 1.1 Specification Header & Metadata

- **Project Target:** [`ang-kl/bot-trade`](https://github.com/ang-kl/bot-trade) (Node.js Central Agent \+ C++ Sidecars `cpp-exec`, `cpp-scan-tick`, `cpp-scan-timeframe`, `cpp-verify` \+ React/Vite Control Panel)  
- **Purpose:** Biomimetic Risk Gate Hardening, Dynamic Profit Retention (`profit-keeper.js`), Net-of-Cost Edge Decay Metering (`alpha-decay.js`), and Tri-State Strategy Autopilot (`strategy-autopilot.js`)  
- **Framework Standard:** `Intent -> Context -> Biologize -> Discover -> Abstract -> Emulate -> Assumptions (E/C/I/A) -> Invariants -> Working Contract -> Execute -> Evidence`  
- **Prior Baseline Reference:** [`bot_trade_remediation_plan_aligned.md`](https://drive.google.com/open?id=1gxewYVEtaEbJDij6_emUiQaPxfXYqJRlOLpzoZopRfs) & [`CLAUDE.md`](https://github.com/ang-kl/bot-trade/blob/main/CLAUDE.md)

## 1.2 Biomimicry Design Spiral Provenance (Peer-Reviewed Grounding)

| Biological Model & Scale | Peer-Reviewed Source | Abstracted Engineering Principle | Target `bot-trade` Subsystem |
| :---- | :---- | :---- | :---- |
| **Molecular / Cellular:** Blue Mussel (*Mytilus edulis*) Adductor Catch Muscle | [PMC7589332](https://pmc.ncbi.nlm.nih.gov/articles/PMC7589332/); [PMC1483069](https://pmc.ncbi.nlm.nih.gov/articles/PMC1483069/); [PMC12040844](https://pmc.ncbi.nlm.nih.gov/articles/PMC12040844/) | **Two-Phase Threshold Latch:** Separate active expansion from passive retention; keep the retention latch disengaged until clearing a primary threshold (`>= +1.2R`), then lock state at the broker at near-zero compute/API cost. | `agent/services/profit-keeper.js` (`cpp-exec` SL amendment latch) |
| **Anatomical / Physiological:** Mammalian Collecting Lymphangions & Bicuspid Valves | [PMC6459625](https://pmc.ncbi.nlm.nih.gov/articles/PMC6459625/); [PMC5063934](https://pmc.ncbi.nlm.nih.gov/articles/PMC5063934/); [PMC2292729](https://pmc.ncbi.nlm.nih.gov/articles/PMC2292729/) | **Chambered Variance Buffering:** Segment trajectories into discrete structural chambers; tolerate local intraluminal volatility within a chamber without moving the valve, and snap the check valve shut only when a closed bar crosses into the next chamber. | `agent/services/profit-keeper.js` & `src/lib/tp-ladder.js` |
| **Neural / Behavioral:** Vertebrate Dopaminergic Foraging Circuits (Marginal Value Theorem) | [PMC8076528](https://pmc.ncbi.nlm.nih.gov/articles/PMC8076528/); [PMC10996644](https://pmc.ncbi.nlm.nih.gov/articles/PMC10996644/); [PMC4624618](https://pmc.ncbi.nlm.nih.gov/articles/PMC4624618/); [PMC7329313](https://pmc.ncbi.nlm.nih.gov/articles/PMC7329313/) | **Variance-Adjusted Marginal Yield Comparator:** Evaluate active generators by comparing the bootstrap lower confidence bound of net-of-cost return rate against the portfolio opportunity floor (`+0.15R`), never by arbitrary wall-clock timers. | `agent/services/alpha-decay.js` & `agent/services/bar-form-research-core.js` |
| **Microbial / Ecological:** *Bacillus subtilis* Oligotrophic Slow-Growth & Bet-Hedging Sporulation | [PMC6385201](https://pmc.ncbi.nlm.nih.gov/articles/PMC6385201/); [PMC3869009](https://pmc.ncbi.nlm.nih.gov/articles/PMC3869009/); [PMC9286555](https://pmc.ncbi.nlm.nih.gov/articles/PMC9286555/); [PMC12890906](https://pmc.ncbi.nlm.nih.gov/articles/PMC12890906/) | **Tri-State Metabolic Throttling & Hysteresis:** Insert an ultra-low-burn `OLIGOTROPHIC_PROBE` state between `ARMED` and `ENCYSTED_DISARMED` to preserve environmental sensing without capital bleed and prevent binary re-arm thrashing. | `agent/services/strategy-autopilot.js` & `agent/services/risk.js` |

## 2.0 AI Prompt Syntax (Paste Directly into AI Coding Agent: Claude / Codex / Cursor)

### 2.1 ALIGNMENT FRAMEWORK & EXECUTION DIRECTIVE

You are an expert quantitative systems engineer refactoring the [`ang-kl/bot-trade`](https://github.com/ang-kl/bot-trade) repository. To prevent probabilistic completion drift, you MUST strictly adhere to this Biomimetic Specification Contract. Every code modification must satisfy the explicit Intent parameters, the Assumptions Classification Matrix (E/C/I/A), the Unbreakable System Invariants, and the Working Rules in [`CLAUDE.md`](https://github.com/ang-kl/bot-trade/blob/main/CLAUDE.md) (including deterministic zero-LLM trade paths and the `npm run check:no-green` red/green color-blindness gate).

### 2.2 INTENT & SYSTEM CONTEXT

- **Intent:** Achieve long-term capital survival and positive mathematical expectancy by refactoring `profit-keeper.js`, `tp-ladder.js`, `alpha-decay.js`, `bar-form-research-core.js`, and `strategy-autopilot.js` into a homeostatic, chamber-ratcheted, net-of-cost survival architecture.  
- **Context:** Node.js/SQLite central service (`agent/agent.db` on Railway) paired with C++ execution and verification sidecars (`cpp-exec`, `cpp-scan-tick`, `cpp-scan-timeframe`, `cpp-verify`) and a React dashboard (`src/` on Vercel). Incorporates active October 2026 workstreams (`NASA-5` real-path execution receipts and `NASA-6` chronological train/confirm validation).

### 2.3 ASSUMPTIONS CLASSIFICATION MATRIX (E / C / I / A)

- **E — Explicit (Human & Architecture Directed):**  
    
  - **E1 (Expectancy & R:R Floor):** Hard code floor `minRR >= 2.8 : 1` (default target `3.5 : 1`) and minimum expected value `E > +0.15R` net of transaction costs ([`bot_trade_remediation_plan_aligned.md`](https://drive.google.com/open?id=1gxewYVEtaEbJDij6_emUiQaPxfXYqJRlOLpzoZopRfs)).  
  - **E2 (Catch-Latch Arming Floor):** Raise Profit Keeper arming threshold from `+0.01R` to `>= +1.2R` (with Hybrid 2R scale-out trigger counted strictly from verified broker fill as established in [PR \#1357](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DNAL0CKmAwzQm9lV9XYhZ8V--CdHfLIOtA&mid=1a135142bfb577a4)).  
  - **E3 (Abolish Fixed Wall-Clock Liquidations):** Remove fixed 30m/1h `time_cap_expired` liquidations on technical setups (`15m`, `1h`, `4h`) and evaluate all hold durations strictly from `fill_at`.  
  - **E4 (Zero-LLM Trade & Monitor Path):** Eliminate minute-by-minute LLM position polling; all stop ratcheting and decay checks must execute deterministically in Node.js/C++.  
  - **E5 (Color-Blind Accessibility Gate):** Maintain zero green hues in any UI component added for probe/autopilot states (`blue` \= long/healthy/armed, `amber/slate` \= oligotrophic probe, `red` \= short/disarmed); pass `npm run check:no-green`.


- **C — Contextual (Established by Repository & Recent PR Audits):**  
    
  - **C1 (Net-of-Cost R Basis):** In `bar-form-research-core.js` ([PR \#1365](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DOYjHHxPanAZczeUJJ8iVX3pumFvwjueiM&mid=1a1376872821ef29)), `runBacktest` deducted transaction costs (default `0.02%`) only from `pnlPct`, leaving gross `r` values in `computeRStats`. All train/confirm and autopilot thresholds must evaluate on **net-of-cost R** (`rBasis: 'net_of_cost'`).  
  - **C2 (Held Lots vs. Opened Lots Ladder):** In `src/lib/tp-ladder.js` and `src/pages/Trade.jsx` ([PR \#1348](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMWF1a1rPQz6dJBIh364ym23gC_xcU4n9w&mid=1a132e36a75f483b)), after a partial close or scale-out (`scaled_out = 1`), `heldMoneyLadder()` must filter completed (`done`) targets before checking equal-lot shortcuts and return an empty/null money ladder when all targets are done.  
  - **C3 (Conversion Fee & Rate Recovery Provenance):** In `position-lifecycle-evidence.js` and `ledger-reconciliation.js` ([PR \#1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5)), omitted protobuf `pnlConversionFee` fields represent measured zeros (`0`), rate backfill must span the full 190-day commission window (`RATES_WINDOW_DAYS = 190`), and `stampFilledFromHistory` must validate `ctidTraderAccountId` before writing fills.  
  - **C4 (Per-Account Auto Trade Switch Truth):** In `alpha-decay.js` ([PR \#1347](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DM1s5rqfqmLXvC7P_5PyFw2K81TFMY-9W0&mid=1a132cb81f6edc10)), Edge Health must read each enabled account's own Auto Trade switch and preserve real denominators without fabricating `{ on: 0, of: 1 }` for non-registry strategies like `tick_momentum_breakout`.


- **I — Inferred (Biomimetically Derived & Validated):**  
    
  - **I1 (Premature Latch Jamming):** Continuous tick-by-tick ATR trailing inside normal wave consolidation mimics a bivalve muscle engaging its twitchin catch latch mid-contraction ([PMC7589332](https://pmc.ncbi.nlm.nih.gov/articles/PMC7589332/)), guaranteeing premature stop-outs before `TP1`/`TP2` can be reached.  
  - **I2 (Binary Disarm Blindness):** Switching a strategy directly from `ARMED` to `DISARMED` for 24 hours (`LIVE_DISARM_COOL_OFF_MS`) cuts off live fill/slippage telemetry during the cooldown and risks re-arming full size into an unverified regime once the timer expires.


- **A — Assumed (Governed by Unbreakable Invariants Below):**  
    
  - **A1:** Stepping trailing stops only on closed 15m/1h swing-chamber boundaries (after the `+1.2R` catch latch engages) provides sufficient compliant buffering to survive intra-bar volatility while locking structural gains.  
  - **A2:** An intermediate `OLIGOTROPHIC_PROBE` state (`0.01` micro-lot cap or shadow-receipt mode) for strategies in the `85%–100%` Profit Factor band or emerging from 24h cooldown prevents capital bleed while maintaining live sensory feedback.

### 2.4 UNBREAKABLE BIOMIMETIC SYSTEM INVARIANTS

1. **Invariant 1 — Twitchin Catch-Latch Threshold (`profit-keeper.js`):** No trailing or breakeven stop-loss amendment shall ever be dispatched while a position's broker-verified unrealized profit is below `+1.2R`. When `>= +1.2R` is first cleared, the initial catch-latch SL must cover `entry_price +/- (roundTripCommission + conversionFeeInPriceUnits)` so a latched stop never realizes a net-of-fee loss.  
2. **Invariant 2 — Lymphangion One-Way Chamber Ratchet (`profit-keeper.js`):** Once the `+1.2R` catch latch is engaged, the stop-loss shall **never** move continuously on intra-bar ticks and shall **never** move in the non-protective direction. Subsequent SL advances may occur **only** on the close of a 15m/1h bar that forms a confirmed higher swing low (for Longs) or lower swing high (for Shorts) above/below the prior chamber valve.  
3. **Invariant 3 — Dopaminergic MVT Net-of-Cost Expectancy Gate (`risk.js`, `bar-form-research-core.js`):** No strategy cell or trade proposal shall be judged `CONFIRMED` or `ARMED` on gross R. All Profit Factor, Max Drawdown, and Expectancy lower-bound gates must be computed on **net-of-cost R** (after spread, commission, and FX conversion fees) using the **bootstrap 5th-percentile lower bound** (`expectancyLowerR >= 0.15R`), with zero-loss positive-gain blocks treated as `+Infinity` profit factor.  
4. **Invariant 4 — *B. subtilis* Tri-State Autopilot Hysteresis (`strategy-autopilot.js`):** A disarmed strategy (`ENCYSTED_DISARMED`) shall **never** transition directly back to full-size `ARMED` upon expiration of `LIVE_DISARM_COOL_OFF_MS` (24h). It must first enter `OLIGOTROPHIC_PROBE` (capped at `0.01` lot or deterministic shadow-fill mode) and record at least `N >= 3` net-positive probe receipts (or pass untouched chronological `CONFIRM` bar validation) before restoring full `ARMED` risk allocation.  
5. **Invariant 5 — Account & Snapshot Self/Non-Self Isolation (`state.js`, `position-lifecycle-evidence.js`, `account-capabilities.js`):** No account shall ever inherit position quantities (`sp.lots`), opening fill volumes (`stampFilledFromHistory`), or Auto Trade arming states from a foreign account's snapshot or global legacy cache when `accountId` does not match, nor shall any reboot script modify an explicit `enabled = 0` account flag.

### 2.5 WORKING CONTRACT: FILE-BY-FILE CODE REFACTORING

#### 2.5.1 File: `agent/services/profit-keeper.js` & `src/lib/tp-ladder.js`

1. **Enforce Twitchin Catch-Latch Gate (`>= +1.2R`):**  
   - Abort any Profit Keeper evaluation if `currentR < 1.2` (where `currentR` is calculated from verified broker `entry_price`, `current_sl`, and live bid/ask mark).  
   - Upon first crossing `>= +1.2R`, compute `feeBufferPrice = computeFeeBufferInPriceUnits(db, trade, accountId)` incorporating commission and `pnl_conversion_fee`, and dispatch a single `cpp-exec` SL amendment to `entry_price + feeBufferPrice` (Long) or `entry_price - feeBufferPrice` (Short).  
2. **Enforce Stepped Lymphangion Swing-Chamber Ratcheting:**  
   - Replace continuous ATR tick-trailing with a discrete chamber state (`chamber_index`, `last_valve_price`, `last_bar_close_ts`).  
   - Only evaluate ratcheting on **closed** `15m` or `1h` candles. Advance `current_sl` to the newly confirmed swing low/high minus `0.25 * ATR` leaflet clearance **only** if the new valve price strictly improves upon `current_sl` by at least `0.3R` (preventing micro-amendment API spam).  
3. **Fix `heldMoneyLadder()` in `src/lib/tp-ladder.js` ([PR \#1348](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMWF1a1rPQz6dJBIh364ym23gC_xcU4n9w&mid=1a132e36a75f483b)):**  
   - Filter out completed targets (`t.done === true`) **before** evaluating the `Math.abs(held - opened) < 1e-9` shortcut so scaled-out positions (`scaled_out = 1`) where `trades.volume` was updated to residual lots do not double-count `TP1`.  
   - When `open.length === 0` (all targets done), return `[]` instead of falling back to `tps[tps.length - 1]`.

#### 2.5.2 File: `agent/services/bar-form-research-core.js` & `agent/services/alpha-decay.js`

1. **Enforce Net-of-Cost R and Bootstrap Lower Bound ([PR \#1365](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DOYjHHxPanAZczeUJJ8iVX3pumFvwjueiM&mid=1a1376872821ef29)):**  
   - Transform all split trades via `netRTrades(blocks.train)` and `netRTrades(blocks.confirm)` before computing `profitFactorR`, `maxDrawdownR`, and `expectancyLowerR`.  
   - Compute `expectancyLowerR` using the 1,000-iteration bootstrap 5th-percentile estimator (matching `tick-replay-sim.js`) rather than the Gaussian `mean - 1.96 * sd / sqrt(n)` approximation.  
   - When a confirmation block has `usable >= thresholds.minTestTrades`, `grossLoss === 0`, and `grossProfit > 0`, represent `profitFactorR` as `Infinity` (passing `>= thresholds.minProfitFactor`) rather than `null`.  
   - Persist `c.split` statistics for **every** evaluated cell in `persistRun` and expose them in `barFormResearchView` so training rankings are 100% reproducible.  
2. **Fix Non-Registry Strategy Denominators & Effective Account Links in `agent/services/alpha-decay.js` ([PR \#1347](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DM1s5rqfqmLXvC7P_5PyFw2K81TFMY-9W0&mid=1a132cb81f6edc10)):**  
   - For strategies outside `STRATEGY_REGISTRY` (such as `tick_momentum_breakout` or `unlabelled`), report `armedOn: { on: 0, of: enabledAccountIds.length, applicable: false }` rather than fabricating `{ on: 0, of: 1 }`.  
   - Include the effective target `accountId` in `/tune?tab=pipeline&arm=...&accountId=...` links when per-account overrides diverge from the shared matrix cell.

#### 2.5.3 File: `agent/services/strategy-autopilot.js` & `agent/services/risk.js`

1. **Implement Tri-State Oligotrophic Autopilot (`ARMED` / `OLIGOTROPHIC_PROBE` / `ENCYSTED_DISARMED`):**  
   - Extend strategy-timeframe-account state to support three states:  
     - `ARMED`: Shrunk net-R Profit Factor `>= 1.0 * armBar` and `expectancyLowerR >= 0.15`. Full risk-gated lot sizing (`<= 1.5%` USD notional cap).  
     - `OLIGOTROPHIC_PROBE`: Entered when shrunk net-R Profit Factor falls into `[0.85 * armBar, 1.0 * armBar)`, or after 2 consecutive net-R losses, or immediately upon completing the 24-hour `LIVE_DISARM_COOL_OFF_MS` dormancy period. In `OLIGOTROPHIC_PROBE`, `evaluateTrade()` caps `requestedVolume` at the instrument's minimum micro-lot (`0.01` lot) or routes to deterministic shadow-receipt logging (`probe_only = 1`).  
     - `ENCYSTED_DISARMED`: Entered when shrunk net-R Profit Factor drops below `0.85 * armBar` (`DISARM_PF_FRACTION`) or after 3 consecutive net-R losses. Locks out live execution for `LIVE_DISARM_COOL_OFF_MS` (24 hours).  
   - **Germination Gate:** Transition from `OLIGOTROPHIC_PROBE` back to `ARMED` requires at least 3 closed probe trades (or untouched chronological confirm bars) with net-of-cost `profitFactorR >= armBar` and `expectancyLowerR >= 0.15R`.  
2. **Enforce Precision-Safe R:R Rounding in `agent/services/risk.js` & `agent/lib/bracket-advice.js` ([PR \#1317](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMrfjtcuVyn9WwXKrrsBYtvvMgp98KiQ_I&mid=1a129c4a08e4669a)):**  
   - Ensure `ceilRr(x)` and `expectancyFloorFor(stats, floor, minE)` verify the candidate two-decimal ratio against the gate's exact comparison (preserving any positive remainder above a hundredth boundary, e.g., `3.0000004 -> 3.01`), and advance `describeBracketGap()` target price by 1 tick after `roundPrice()` if price-precision rounding drops the gate-visible R:R below the floor.

#### 2.5.4 File: `agent/services/position-lifecycle-evidence.js`, `agent/services/ledger-reconciliation.js` & `agent/routes/state.js`

1. **Isolate Self vs. Non-Self Account Data ([PR \#1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5), [PR \#1348](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMWF1a1rPQz6dJBIh364ym23gC_xcU4n9w&mid=1a132e36a75f483b)):**  
   - In `position-lifecycle-evidence.js`, validate that `response.ctidTraderAccountId === Number(accountId)` before passing deals to `stampFilledFromHistory()`, and decouple rate extraction from money-lifecycle `persistable` verdicts so `permanently_unsupported` reversal/partial histories still backfill execution rates across the full `RATES_WINDOW_DAYS = 190` range (including broker-only positions in `broker_deals`).  
   - In `ledger-reconciliation.js`, default omitted protobuf `pnlConversionFee` values to `0` on verified deals and remove the `position_id IS NOT NULL` restriction when summing account-level conversion fees so statement-imported closing deals are included.  
   - In `agent/routes/state.js`, preserve empty account-scoped snapshots (`s.present === true`, `s.positions.size === 0`) as authoritative rather than falling back to a foreign `globalSnap`, and compare snapshot timestamp against the reconciler's `broker_volume_units` timestamp so `current_lots` always reflects the fresher reading.

### 2.6 EVIDENCE & AUTOMATED ACCEPTANCE TESTING SUITE (`npm test`)

All changes must pass `node --test "agent/**/*.test.js"`, `npx vitest run`, and `npm run check:no-green`, plus the following mandatory acceptance tests:

1. **Test 2.6.1 (Twitchin Catch-Latch Threshold & Fee Buffer):** Simulate open positions at `+0.3R`, `+0.9R`, and `+1.19R`; verify `profit-keeper.js` dispatches zero broker SL amendments. Simulate crossing `+1.20R`; verify exactly 1 broker SL amendment is dispatched at `entry_price +/- feeBufferPrice`.  
2. **Test 2.6.2 (Lymphangion Stepped Swing-Chamber Ratchet):** Simulate a position at `+1.8R` experiencing intra-bar tick fluctuations of `+/- 0.4R` without a closed 15m/1h new swing chamber; verify SL remains stationary. Simulate a closed 15m bar confirming a new higher swing low improving SL by `>= 0.3R`; verify SL steps to the new chamber leaflet.  
3. **Test 2.6.3 (Scaled-Out Held Money Ladder):** Simulate a 9.5-lot position scaled out at `TP1` (`scaled_out = 1`, residual `heldLots = 4.7`, `trades.volume = 4.7`); verify `heldMoneyLadder()` excludes the completed `TP1` level and computes remaining TP money strictly on the 4.7 runner lots, returning `[]` when all targets are marked `done`.  
4. **Test 2.6.4 (Dopaminergic MVT Net-R & Zero-Loss Confirm Gate):** Run `trainConfirmSelection()` on a cell whose gross R passes `minExpectancyLowerR` but net-of-cost R (`0.02%` cost) fails via bootstrap 5th-percentile; verify verdict is `NOT_CONFIRMED`. Run a confirm block with 15 wins and 0 losses; verify `profitFactorR === Infinity` and verdict is `CONFIRMED`.  
5. **Test 2.6.5 (*B. subtilis* Tri-State Autopilot Hysteresis):** Trigger strategy disarm (`PF < 0.85 * armBar`); verify state enters `ENCYSTED_DISARMED` for 24h, then transitions to `OLIGOTROPHIC_PROBE` (`<= 0.01` lot cap) after 24h, and blocks full `ARMED` sizing until 3 net-positive probe receipts are recorded.  
6. **Test 2.6.6 (Self/Non-Self Account Snapshot & Fill Isolation):** Simulate Account A (0 open positions, fresh empty snapshot) and Account B (open position ID `101` with `5.0` lots in `globalSnap`); verify Account A never inherits `5.0` lots on overlapping position ID `101` and `stampFilledFromHistory()` rejects mismatched `ctidTraderAccountId` payloads.

## 3.0 Cross-Scale Biomimetic Alignment with Nature's Unifying Patterns

| Nature's Unifying Pattern | Biological Inspiration | Engineering Implementation in `ang-kl/bot-trade` |
| :---- | :---- | :---- |
| **1\. Uses only the energy it needs** | Bivalve catch muscle maintains shell closure via twitchin dephosphorylation with near-zero ATP consumption ([PMC7589332](https://pmc.ncbi.nlm.nih.gov/articles/PMC7589332/)). | Eliminates \$178/day minute-by-minute LLM polling and continuous tick-level SL amendments in favor of event-driven C++/Node state latches. |
| **2\. Recycles all materials** | Microbial ecosystems recycle all cellular metabolites and detrital outputs into new trophic loops. | Recycles rejected deals, reversal fills, and statement-imported rows ([PR \#1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5)) into `position_lifecycle_evidence` rate and prior tables. |
| **3\. Resilient to disturbances** | Lymphangion chains isolate retrograde pressure spikes behind bicuspid valves ([PMC2292729](https://pmc.ncbi.nlm.nih.gov/articles/PMC2292729/)). | Chambered SL ratchets, 60s `IdempotencyKey` locks, and account-scoped snapshots prevent localized volatility or socket glitches from cascading. |
| **4\. Optimizes rather than maximizes** | Risk-sensitive foragers optimize survival probability above starvation thresholds rather than raw gross intake ([Frontiers](https://www.frontiersin.org/journals/behavioral-neuroscience/articles/10.3389/fnbeh.2025.1644777/full)). | Optimizes net-of-cost bootstrap lower-bound expectancy (`E > +0.15R`, `minRR >= 2.8`) rather than raw win rate or trade count. |
| **5\. Provides mutual benefits** | Symbiotic feedback between sensory neurons and motor effectors refines foraging precision. | `cpp-verify` and `position-lifecycle-evidence.js` feed measured conversion fees and fill rates back into `risk.js` pre-trade sizing. |
| **6\. Runs on information** | Dopaminergic circuits track real-time phasic-vs-tonic net energy intake ([PMC8076528](https://pmc.ncbi.nlm.nih.gov/articles/PMC8076528/)). | Decisions rely strictly on verified broker receipts (`fill_at`, `broker_volume_units`, execution close rates) rather than unverified assumptions. |
| **7\. Uses non-toxic chemistry/operations** | Organisms detoxify metabolic byproducts before tissue necrosis occurs. | Hard `1.5%` USD notional exposure caps and single-direction-per-symbol locks prevent toxic margin lockups and cross-rate blowups. |
| **8\. Builds using abundant resources** | Structural tissues rely on abundant polymers, using rare trace elements only at active catalytic sites. | Deterministic C++ scanners (`cpp-scan-tick`, `cpp-scan-timeframe`) handle high-frequency filtering; scarce capital is deployed only on confirmed edges. |
| **9\. Locally attuned and responsive** | Each lymphangion contracts in response to its local stretch and pressure gradient ([PMC5063934](https://pmc.ncbi.nlm.nih.gov/articles/PMC5063934/)). | Trailing chambers adapt to each symbol's local 15m/1h swing structure and respect each account's individual Auto Trade switch ([PR \#1347](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DM1s5rqfqmLXvC7P_5PyFw2K81TFMY-9W0&mid=1a132cb81f6edc10)). |
| **10\. Uses shape to determine functionality** | Bicuspid leaflet geometry and bacterial spore coats physically enforce one-way flow and dormancy protection. | Stepped chamber geometry in `tp-ladder.js` and tri-state hysteresis in `strategy-autopilot.js` structurally prevent premature exits and thrashing. |

## 4.0 Synthesis of Recent Repository Audit Findings Addressed

| Pull Request / Audit Source | Root Defect Identified | Biomimetic Contract Remediation |
| :---- | :---- | :---- |
| [**PR \#1365 (`NASA-6 batch 1`)**](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DOYjHHxPanAZczeUJJ8iVX3pumFvwjueiM&mid=1a1376872821ef29) | Confirmation gates evaluated gross R instead of net-of-cost R, treated 0-loss blocks as `null` PF (`NOT_CONFIRMED`), used Gaussian instead of bootstrap lower bounds, and dropped non-top-N split stats. | Section 2.5.2 enforces `netRTrades()`, bootstrap 5th-percentile `expectancyLowerR`, `Infinity` PF on zero-loss blocks, and full cell split persistence. |
| [**PR \#1364 (Lifecycle & Fees)**](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5) | Rate backfill skipped `permanently_unsupported` and broker-only deals, capped backfill at 30 days instead of 190 days, omitted statement deals (`position_id IS NULL`) from conversion fees, and stamped fills without account validation. | Section 2.5.4 decouples rate recovery from money persistability, expands `RATES_WINDOW_DAYS = 190`, defaults omitted protobuf fees to `0`, and validates `ctidTraderAccountId`. |
| [**PR \#1357 (Hybrid 2R Trigger)**](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DNAL0CKmAwzQm9lV9XYhZ8V--CdHfLIOtA&mid=1a135142bfb577a4) | Scale-out and Profit Keeper triggers needed consistent anchoring to verified broker fills across capped and manual readers. | Section 2.5.1 anchors the `+1.2R` catch latch and Hybrid 2R scale-out strictly to broker-verified fill prices and fee buffers. |
| [**PR \#1348 (Held Lots vs. Sent Lots)**](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMWF1a1rPQz6dJBIh364ym23gC_xcU4n9w&mid=1a132e36a75f483b) | `heldMoneyLadder()` took the equal-lots shortcut before filtering `done` levels on scaled-out positions, returned a completed target when all levels were `done`, and preferred stale snapshots over fresher reconciler readings. | Section 2.5.1 and 2.5.4 filter `done` levels first, return `[]` when all targets are done, reject foreign fallback snapshots, and pick the fresher of snapshot vs. reconciler lots. |
| [**PR \#1347 (Per-Account Auto Trade)**](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DM1s5rqfqmLXvC7P_5PyFw2K81TFMY-9W0&mid=1a132cb81f6edc10) | Non-registry strategies (`tick_momentum_breakout`) fabricated `{ on: 0, of: 1 }` counts, and all-scope arm links routed to the shared matrix cell even when overridden per account. | Section 2.5.2 preserves real enabled-account denominators (`applicable: false`) and routes arm/disarm links to the effective `accountId`. |
| [**PR \#1317 (Order Pad & R:R Precision)**](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMrfjtcuVyn9WwXKrrsBYtvvMgp98KiQ_I&mid=1a129c4a08e4669a) | `ceilRr()` six-decimal pre-rounding erased sub-millionth remainders (`3.0000004 -> 3.00`), and `roundPrice()` could snap advised targets 1 tick below the gate-visible R:R floor. | Section 2.5.3 verifies rounded ratios directly against the gate's comparator and advances snapped target prices by 1 tick when needed. |

## 5.0 Pre-Deployment & Validation Day Execution Checklist

- [ ] **5.1 Pause Live Autotrading:** Issue `/pause` via Telegram or set Account Auto Trade switches to `OFF` before applying refactoring commits.  
- [ ] **5.2 Create Feature Branch:** `git checkout -b feat/biomimetic-homeostasis-contract`  
- [ ] **5.3 Apply File Refactorings:** Implement Sections `2.5.1` through `2.5.4` across `agent/` and `src/`.  
- [ ] **5.4 Run Automated Verification Gate:**  
      - `node --test "agent/**/*.test.js"`  
      - `npx vitest run`  
      - `npm run check:no-green`  
- [ ] **5.5 Validate C++ Sidecar Heartbeats & Railway Stability:** Confirm `controller_heartbeats` and `POST /heartbeat` liveness checks pass without SQLite `SQLITE_BUSY` lock contention across all 23 background loops to prevent the container restarts seen in [Railway's Oct 13, 2026 crash alerts](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DM134wjVmCOUqe1V6rB5cGTT7B_fQ7bft4&mid=1a137a18464fef54).  
- [ ] **5.6 Execute Demo Validation (`VALIDATION-DAY.md`):** Run 24 hours on Demo account (`5306502`) verifying `OLIGOTROPHIC_PROBE` transitions, `+1.2R` catch-latch SL amendments, and net-of-cost R ledger reconciliation before enabling live capital.