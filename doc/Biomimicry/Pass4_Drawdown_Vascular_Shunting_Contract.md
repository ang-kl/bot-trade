# 1.0 Master Biomimetic Engineering Specification & AI Refactoring Contract (Pass 4: Drawdown Containment, Multi-Currency Compartmentalization & Vascular Shunting)

## 1.1 Specification Header & Metadata

- **Project Target:** [ang-kl/bot-trade](https://github.com/ang-kl/bot-trade) (`agent/services/loss-guardian.js`, `agent/lib/contracts.js`, `agent/services/risk.js`, and `agent/services/ledger-reconciliation.js`)
- **Purpose:** Conifer Torus-Margo Cross-Currency Isolation, Shear-Activated vWF Hemostasis (Replacing Fixed 30m/1h Time Caps), and Mammalian Diving Reflex Progressive Drawdown Vasoconstriction
- **Framework Standard:** `Intent -> Context -> Biologize -> Discover -> Abstract -> Emulate -> Assumptions (E/C/I/A) -> Invariants -> Working Contract -> Execute -> Evidence`
- **Complete 4-Pass Companion Suite in Google Drive:**
  - **Pass 1 (Profit Retention & Autopilot):** [bot_trade_biomimetic_survival_contract.md](https://docs.google.com/document/d/1Aqhv286aiR4RIZoHwwLt-5uH3DplRSuKjlJoc0-LGvg/edit?usp=drivesdk&ouid=101003428420312682812)
  - **Pass 2 (C++ Sidecar Immune Verification):** [bot_trade_cpp_immune_verification_contract.md](https://docs.google.com/document/d/1cs1Y6H6QdogV6C9STH9IQyzZEMaNby2tCxn75ILJo5E/edit?usp=drivesdk&ouid=101003428420312682812)
  - **Pass 3 (Pre-Trade Order-Storm Refractory Gating):** [bot_trade_order_storm_refractory_gating_contract.md](https://docs.google.com/document/d/1n9kd7k3YKH_2PrHEaD0btuC-5t2rCpKNhtZ5_LLQw-o/edit?usp=drivesdk&ouid=101003428420312682812)
  - **Prior Baseline Reference:** [bot_trade_remediation_plan_aligned.md](https://drive.google.com/open?id=1gxewYVEtaEbJDij6_emUiQaPxfXYqJRlOLpzoZopRfs) & [CLAUDE.md](https://github.com/ang-kl/bot-trade/blob/main/CLAUDE.md)

## 1.2 Biomimicry Design Spiral Provenance (Peer-Reviewed Grounding)

| Biological Model & Scale | Peer-Reviewed Source | Abstracted Engineering Principle | Target `bot-trade` Subsystem |
| :--- | :--- | :--- | :--- |
| **Botanical Hydraulics:** Conifer Xylem Torus-Margo Bordered Pit Valves | [PMC2923884](https://pmc.ncbi.nlm.nih.gov/articles/PMC2923884/); [PMC13421541](https://pmc.ncbi.nlm.nih.gov/articles/PMC13421541/); [PMC4112641](https://pmc.ncbi.nlm.nih.gov/articles/PMC4112641/); [PMC9544843](https://pmc.ncbi.nlm.nih.gov/articles/PMC9544843/) | **Torus-Margo Embolism Containment:** Low-resistance flow through porous margo under normal pressure; if a single conduit cavitates (corrupted/missing FX quote or extreme price jump), the central impermeable torus snaps against the aperture to seal off *only* that conduit. | `agent/lib/contracts.js` & `agent/services/pending-orders.js` (non-USD cross-rate & `BWPUSD` FX leg isolation) |
| **Hematology / Fluid Mechanics:** Shear-Activated von Willebrand Factor (vWF) & Antithrombin III | [PMC3126677](https://pmc.ncbi.nlm.nih.gov/articles/PMC3126677/); [PMC9675031](https://pmc.ncbi.nlm.nih.gov/articles/PMC9675031/); [PMC4519838](https://pmc.ncbi.nlm.nih.gov/articles/PMC4519838/); [PMC5240924](https://pmc.ncbi.nlm.nih.gov/articles/PMC5240924/) | **Shear-Triggered Localized Clotting vs. Antithrombin:** Keep emergency liquidation coiled and inert during normal laminar consolidation (abolishing fixed 30m/1h timers); unfold emergency closure only under high adverse price shear + structure breach, while antithrombin prevents healthy positions from being liquidated. | `agent/services/loss-guardian.js` (fill-time clock & $3 * ATR$ shear stop) |
| **Systemic Physiology:** Mammalian Diving Reflex & Sympathetic Peripheral Vasoconstriction | [PMC3768097](https://pmc.ncbi.nlm.nih.gov/articles/PMC3768097/); [PMC9409260](https://pmc.ncbi.nlm.nih.gov/articles/PMC9409260/); [PMC4249686](https://pmc.ncbi.nlm.nih.gov/articles/PMC4249686/) | **Progressive Drawdown Vasoconstriction:** As oxygen/equity reserves decline during a dive/drawdown, progressively constrict peripheral (lower-tier) strategies and throttle risk-per-trade smoothly rather than running full size into a sudden brick-wall stop. | `agent/services/risk.js` & `agent/services/ledger-reconciliation.js` (tiered daily loss shunting) |

## 2.0 AI Prompt Syntax (Paste Directly into AI Coding Agent: Claude / Codex / Cursor)

### 2.1 ALIGNMENT FRAMEWORK & EXECUTION DIRECTIVE

You are an expert quantitative systems engineer refactoring the [ang-kl/bot-trade](https://github.com/ang-kl/bot-trade) repository. To prevent probabilistic completion drift, you MUST strictly adhere to this Specification Contract. Every code change must satisfy the explicit Intent parameters, the Assumptions Classification Matrix (E/C/I/A), the Unbreakable System Invariants, and the working directives in [CLAUDE.md](https://github.com/ang-kl/bot-trade/blob/main/CLAUDE.md) (including deterministic zero-LLM trade paths and the `npm run check:no-green` red/green color-blindness gate).

### 2.2 INTENT & SYSTEM CONTEXT

- **Intent:** Complete the fourth survival pillar of `ang-kl/bot-trade` by replacing destructive 30m/1h fixed time-cap liquidations (`time_cap_expired`, which liquidated >90% of consolidating setups at a loss) with shear-activated technical exits evaluated strictly from `fill_at`, sealing non-USD cross-currency valuation conduits (`JPN225`, `EURX`, `USDX`, `BWPUSD`) with torus-margo sanity valves, and implementing progressive mammalian diving-reflex risk throttling as daily drawdown approaches the daily equity cap.
- **Context:** Node.js central service (`agent/`) + C++ execution/verification sidecars (`cpp-exec`, `cpp-verify`) managing multi-currency CFD and FX accounts on cTrader.

### 2.3 ASSUMPTIONS CLASSIFICATION MATRIX (E / C / I / A)

- **E — Explicit (Human & Architecture Directed):**
  - **E1 (Abolish Fixed Minute Time Caps):** Remove all 30m/1h fixed `time_cap_expired` force-closure timers on technical timeframes (`15m`, `1h`, `4h`) and remove the session-open $+0.3R$ premature breakeven trap ([bot_trade_remediation_plan_aligned.md](https://drive.google.com/open?id=1gxewYVEtaEbJDij6_emUiQaPxfXYqJRlOLpzoZopRfs)).
  - **E2 (Strict Fill-Time Clock):** Evaluate all position holding durations strictly from the broker-verified `fill_at` timestamp ($T_{fill}$), never from order placement (`placed_at`, $T_{placed}$).
  - **E3 (Complete FX & Crypto Taxonomy):** Include `BWP` in the FX currency leg split whitelist and include `FIL`, `ETC`, `TON`, and `SUI` in `CRYPTO_BASES` in `agent/lib/contracts.js` ([PR #1317](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMrfjtcuVyn9WwXKrrsBYtvvMgp98KiQ_I&mid=1a129c4a08e4669a)).
  - **E4 (Color-Blind Accessibility Gate):** Any UI badges for drawdown vasoconstriction tiers (`NOMINAL`, `VASOCONSTRICT_TIER_1`, `VASOCONSTRICT_TIER_2`, `DIVING_REFLEX_LOCK`) must pass `npm run check:no-green` (`blue` = nominal, `amber/slate` = constricted, `red` = locked).

- **C — Contextual (Established by Repository & Prior Audits):**
  - **C1 (Resting Limit Order Time-Cap Bug):** In PR #697, resting limit orders that took 25–30 minutes to fill were force-closed 0–5 minutes after fill because `loss-guardian.js` measured elapsed time from `placed_at`.
  - **C2 (Cross-Currency Cavitation Events):** Single-trade catastrophic losses on `JPN225` (-$9,171.76), `EURX` (-$2,535.41), and `USDX` (-$1,090.00) occurred when non-USD point values bypassed cross-rate conversion (`bot_trade_remediation_plan_aligned.md` Section 4.2).
  - **C3 (Unmeasured Conversion Fee Drift):** In `ledger-reconciliation.js` ([PR #1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5)), omitting `position_id IS NULL` statement deals or treating omitted zero-valued protobuf `pnlConversionFee` fields as `NULL` understated daily net drawdown.

- **I — Inferred (Biomimetically Derived & Validated):**
  - **I1 (Disseminated Coagulation from Fixed Timers):** A fixed 30m/1h timer acts like systemic blood clotting inside healthy vessels—killing normal low-volatility consolidations while failing to react faster when genuine high-shear structural invalidation occurs.
  - **I2 (Step-Function Drawdown Cliff):** Running full 1.5% per-trade risk right up to the daily loss cap creates path-dependent ruin risk; progressive vasoconstriction preserves core equity and gives high-conviction setups more attempts to recover.

- **A — Assumed (Governed by Unbreakable Invariants Below):**
  - **A1:** A 3-tier progressive vasoconstriction schedule (100% risk scale above -1.0% daily net P&L, 50% scale between -1.0% and -2.0%, 25% scale between -2.0% and -3.0%, and 0% hard lock at <= -3.0%) smoothly dampens drawdown velocity.
  - **A2:** A Torus-Margo quote sanity check rejecting any cross-rate whose implied 1-lot USD value deviates by > 15% from its 24h rolling median isolates feed glitches per symbol.

### 2.4 UNBREAKABLE BIOMIMETIC SYSTEM INVARIANTS

1. **Invariant 1 — Torus-Margo Conduit Isolation (`contracts.js` & `pending-orders.js`):** Every instrument's point-to-USD conversion factor must pass a **Torus-Margo Sanity Valve** before lot sizing: (a) explicit quote currency resolution (`USD`, cross-rate pair, or index multiplier), (b) live cross-rate age <= 60s, and (c) implied USD notional per standard lot within +/- 15% of the symbol's 24-hour median. If a symbol fails this check, its torus valve seals (`CONDUIT_CAVITATION_SEALED`), blocking orders on *only* that symbol while leaving healthy symbols operational.
2. **Invariant 2 — Shear-Activated vWF Technical Exit (`loss-guardian.js`):** No open position on `15m`, `1h`, or `4h` timeframes shall ever be closed solely due to elapsed wall-clock minutes (`time_cap_expired` is permanently abolished). `loss-guardian.js` may trigger an emergency exit **only** when (a) elapsed time is measured strictly from verified `fill_at` ($T_{now} - T_{fill} > 0$) AND (b) price breaches the technical invalidation boundary or the $3 * ATR$ emergency shear floor.
3. **Invariant 3 — Antithrombin Session-Open Protection (`loss-guardian.js`):** The session-open guard shall **never** pull a position's stop-loss to breakeven at $+0.3R$ during the first 30 minutes of a session open; all breakeven ratcheting is governed exclusively by Pass 1 Invariant 1 (>= +1.2R Twitchin Catch Latch).
4. **Invariant 4 — Mammalian Diving Reflex Progressive Vasoconstriction (`risk.js` & `ledger-reconciliation.js`):** Per-trade risk allocation (`effectiveRiskPct`) must scale dynamically with the account's verified daily net-of-fee drawdown ($DD_{net}$, including commissions, swap, and `pnl_conversion_fee`):
   - **Zone 0 (Normal Perfusion, $DD_{net} > -1.0\%$):** `riskScale = 1.0` (100% of configured risk, max 1.5% cap), all `ARMED` strategies permitted.
   - **Zone 1 (Mild Vasoconstriction, $-2.0\% < DD_{net} \le -1.0\%$):** `riskScale = 0.50` (max 0.75% cap), `OLIGOTROPHIC_PROBE` live micro-lots paused (shadow-only).
   - **Zone 2 (Deep Vasoconstriction, $-3.0\% < DD_{net} \le -2.0\%$):** `riskScale = 0.25` (max 0.375% cap), only top-tier strategies with shrunk Profit Factor >= 1.3 * Arm Bar ("vital organs") permitted.
   - **Zone 3 (Full Diving Reflex Apnea Lock, $DD_{net} \le -3.0\%$):** `riskScale = 0.0`, all new entries vetoed (`DIVING_REFLEX_DAILY_CAP_LOCKED`).

### 2.5 WORKING CONTRACT: FILE-BY-FILE CODE REFACTORING

#### 2.5.1 File: `agent/lib/contracts.js` (Torus-Margo Valves & Complete Currency/Crypto Taxonomy)

1. **Complete Currency & Crypto Whitelists ([PR #1317](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMrfjtcuVyn9WwXKrrsBYtvvMgp98KiQ_I&mid=1a129c4a08e4669a)):**
   - Add `'FIL'`, `'ETC'`, `'TON'`, and `'SUI'` to `CRYPTO_BASES` so `isCryptoSymbol()` recognizes all supported 6-letter crypto CFDs (`FILUSD`, `ETCUSD`, `TONUSD`, `SUIUSD`) as single-instrument CFD legs.
   - Add `'BWP'` to the FX currency whitelist so `currencyLegs('BWPUSD', ...)` decomposes into `{ BWP: 1, USD: -1 }` for accurate USD exposure accounting.
2. **Implement `verifyTorusMargoValve(symbol, price, fxRateToUsd, medianUsdPerLot)`:**
   - Compute `usdPerLot = contractSize(symbol) * price * fxRateToUsd`.
   - If `!Number.isFinite(usdPerLot) || usdPerLot <= 0`, or if `medianUsdPerLot > 0 && Math.abs(usdPerLot - medianUsdPerLot) / medianUsdPerLot > 0.15`, return `{ open: false, reason: 'CONDUIT_CAVITATION_SEALED' }`.

#### 2.5.2 File: `agent/services/loss-guardian.js` (vWF Shear Exit & Antithrombin Guard)

1. **Abolish Fixed Minute Time Caps & Enforce `fill_at` Clock:**
   - Remove the 30m and 1h `time_cap_expired` forced-liquidation branches for `15m`, `1h`, and `4h` strategies.
   - Compute `holdingDurationMs = nowMs - Number(trade.fill_at)`. If `trade.fill_at == null || !Number.isFinite(Number(trade.fill_at))`, return `{ action: 'NONE', reason: 'unfilled_or_missing_fill_at' }`.
   - Remove the session-open $+0.3R$ premature breakeven clamp.
2. **Enforce Shear-Activated $3 * ATR$ Emergency Floor:**
   - Trigger emergency guardian market closure **only** if the broker-side `current_sl` is missing/failed AND unrealized adverse excursion exceeds `3.0 * atrAtEntry` (or 1.5% account equity).

#### 2.5.3 File: `agent/services/risk.js` & `agent/services/ledger-reconciliation.js` (Diving Reflex Vasoconstriction)

1. **Include All Account Deals & Default Zero Conversion Fees in `ledger-reconciliation.js` ([PR #1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5)):**
   - In `ledger-reconciliation.js`, default omitted protobuf `pnlConversionFee` fields to `0` on verified deals, and include all account-attributed `broker_deals` rows (including statement-imported deals where `position_id IS NULL`) when computing daily net P&L and `conversionFee.total`.
2. **Implement `computeDivingReflexScale(db, accountId, strategyPfRatio)` in `agent/services/risk.js`:**
   - Calculate `dailyNetDdPct` from verified closed deals + floating unrealized P&L net of commissions and conversion fees.
   - Return `{ zone: 0..3, riskScale: 1.0 | 0.5 | 0.25 | 0.0, allowEntry: boolean, reason }` according to Invariant 4, scaling `maxRiskPct = baseRiskPct * riskScale` before lot calculation.

### 2.6 EVIDENCE & AUTOMATED ACCEPTANCE TESTING SUITE (`npm test`)

All changes must pass `node --test "agent/**/*.test.js"`, `npx vitest run`, and `npm run check:no-green`, plus the following acceptance tests:

1. **Test 2.6.1 (Fill-Time Clock vs. Placed-Time Clock):** Simulate a limit order placed at $T_0$, filled at $T_0 + 28m$, and evaluated at $T_0 + 32m$; verify `holdingDurationMs === 4 * 60000` (4 minutes, not 32 minutes) and verify zero `time_cap_expired` closures occur at 32m, 60m, or 120m.
2. **Test 2.6.2 (Torus-Margo Cavitation Valve on `JPN225` & `EURX`):** Simulate a missing or $100x$ shifted cross-rate on `JPN225`; verify `verifyTorusMargoValve()` returns `{ open: false, reason: 'CONDUIT_CAVITATION_SEALED' }`, blocking `JPN225` while allowing a valid `EURUSD` trade on the same tick.
3. **Test 2.6.3 (`BWPUSD` FX Leg & 6-Letter Crypto CFD Taxonomy):** Verify `isCryptoSymbol()` returns `true` for `FILUSD`, `ETCUSD`, `TONUSD`, and `SUIUSD` (single CFD leg), and verify `currencyLegs('BWPUSD')` returns `{ BWP: 1, USD: -1 }` ([PR #1317](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMrfjtcuVyn9WwXKrrsBYtvvMgp98KiQ_I&mid=1a129c4a08e4669a)).
4. **Test 2.6.4 (Diving Reflex Progressive Vasoconstriction):** Simulate daily net drawdown at -0.5%, -1.4%, -2.3%, and -3.1%; verify `riskScale` steps through `1.0 -> 0.50 -> 0.25 -> 0.0`, and verify that at -2.3% (Zone 2), a marginal strategy (`PF = 1.05 * armBar`) is shunted off while a core strategy (`PF = 1.40 * armBar`) is sized at 0.25x nominal risk.
5. **Test 2.6.5 (Statement-Imported Conversion Fee Reconciliation):** Insert a statement-imported closing deal (`position_id = NULL`, `pnl_conversion_fee = -4.50`) and a protobuf deal with omitted `pnlConversionFee` (`0`); verify `ledger-reconciliation.js` reports `dealsNotRead === 0` and includes `-4.50` in `conversionFee.total` ([PR #1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5)).

## 3.0 Master 4-Pass Biomimetic Architecture Synthesis

With Pass 4 complete, every stage of a trade's lifecycle in [ang-kl/bot-trade](https://github.com/ang-kl/bot-trade) is governed by a peer-reviewed biological survival mechanism:

| Trade Lifecycle Stage | Governing Specification Contract | Primary Biological Models | Key `bot-trade` Files Protected |
| :--- | :--- | :--- | :--- |
| **Stage 1: Sensory Ingestion & Signal Gating** | **Pass 3:** [bot_trade_order_storm_refractory_gating_contract.md](https://docs.google.com/document/d/1n9kd7k3YKH_2PrHEaD0btuC-5t2rCpKNhtZ5_LLQw-o/edit?usp=drivesdk&ouid=101003428420312682812) | TRN Pre-Cortical Gating ([PMC6773087](https://pmc.ncbi.nlm.nih.gov/articles/PMC6773087/)), Axonal $Na_v$ Inactivation ([PMC12784352](https://pmc.ncbi.nlm.nih.gov/articles/PMC12784352/)), Spinal Ia Reciprocal Inhibition ([PMC3150186](https://pmc.ncbi.nlm.nih.gov/articles/PMC3150186/)), *Limulus* Lateral Suppression ([PMC2225927](https://pmc.ncbi.nlm.nih.gov/articles/PMC2225927/)) | `cpp-scan-timeframe/`, `cpp-scan-tick/`, `pending-orders.js`, `scanner.js` |
| **Stage 2: Pre-Flight Valuation & Drawdown Shunting** | **Pass 4:** `bot_trade_pass4_drawdown_vascular_shunting_contract.md` (This Contract) | Conifer Torus-Margo Pit Valves ([PMC13421541](https://pmc.ncbi.nlm.nih.gov/articles/PMC13421541/)), vWF Shear Hemostasis ([PMC9675031](https://pmc.ncbi.nlm.nih.gov/articles/PMC9675031/)), Mammalian Diving Reflex ([PMC3768097](https://pmc.ncbi.nlm.nih.gov/articles/PMC3768097/)) | `contracts.js`, `loss-guardian.js`, `risk.js`, `ledger-reconciliation.js` |
| **Stage 3: Live Execution Audit & Crash Survival** | **Pass 2:** [bot_trade_cpp_immune_verification_contract.md](https://docs.google.com/document/d/1cs1Y6H6QdogV6C9STH9IQyzZEMaNby2tCxn75ILJo5E/edit?usp=drivesdk&ouid=101003428420312682812) | NK Cell Missing-Self ([PMC3984600](https://pmc.ncbi.nlm.nih.gov/articles/PMC3984600/)), T-Cell Two-Signal Gating ([PMC11277571](https://pmc.ncbi.nlm.nih.gov/articles/PMC11277571/)), PINK1/Parkin Mitophagy ([PMC3656616](https://pmc.ncbi.nlm.nih.gov/articles/PMC3656616/)), Octopus ANC Ganglia ([PMC8988249](https://pmc.ncbi.nlm.nih.gov/articles/PMC8988249/)) | `cpp-verify/`, `cpp-exec/`, `naked-position-guard.js`, `state.js`, `heartbeat-supervisor.js` |
| **Stage 4: Profit Ratcheting & Strategy Autopilot** | **Pass 1:** [bot_trade_biomimetic_survival_contract.md](https://docs.google.com/document/d/1Aqhv286aiR4RIZoHwwLt-5uH3DplRSuKjlJoc0-LGvg/edit?usp=drivesdk&ouid=101003428420312682812) | Bivalve Catch Muscle ([PMC7589332](https://pmc.ncbi.nlm.nih.gov/articles/PMC7589332/)), Lymphangion Chambers ([PMC5063934](https://pmc.ncbi.nlm.nih.gov/articles/PMC5063934/)), Dopaminergic MVT ([PMC8076528](https://pmc.ncbi.nlm.nih.gov/articles/PMC8076528/)), *B. subtilis* Oligotrophy ([PMC6385201](https://pmc.ncbi.nlm.nih.gov/articles/PMC6385201/)) | `profit-keeper.js`, `tp-ladder.js`, `alpha-decay.js`, `bar-form-research-core.js`, `strategy-autopilot.js` |

## 4.0 Implementation & Deployment Checklist

- [ ] **4.1 Pause Live Autotrading:** Send `/pause` via Telegram before deploying Pass 4 changes.
- [ ] **4.2 Create Feature Branch:** `git checkout -b feat/pass4-drawdown-vascular-shunting`
- [ ] **4.3 Apply Refactorings:** Implement Sections `2.5.1` through `2.5.3` across `agent/lib/contracts.js`, `agent/services/loss-guardian.js`, `agent/services/risk.js`, and `agent/services/ledger-reconciliation.js`.
- [ ] **4.4 Run Verification Suite:**
  - `node --test "agent/**/*.test.js"`
  - `npx vitest run`
  - `npm run check:no-green`
- [ ] **4.5 Verify on Demo (`5306502`):** Confirm `verifyTorusMargoValve()` logs clean USD per-lot bounds on all 25 watchlist symbols and verify `computeDivingReflexScale()` reports Zone 0 (`riskScale = 1.0`) on the Desk status panel.
