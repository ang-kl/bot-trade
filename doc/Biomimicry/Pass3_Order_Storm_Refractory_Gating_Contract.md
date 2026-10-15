# 1.0 Master Biomimetic Engineering Specification & AI Refactoring Contract (Pass 3: Pre-Trade Synaptic Gating & Order-Storm Refractory Locks)

## 1.1 Specification Header & Metadata

- **Project Target:** [ang-kl/bot-trade](https://github.com/ang-kl/bot-trade) (`agent/services/pending-orders.js`, `agent/services/scanner.js`, `agent/services/risk.js`, `cpp-scan-tick/`, and `cpp-scan-timeframe/`)
- **Purpose:** Upstream Sensory Gating, Atomic $Na_v$ Post-Firing Refractory Locks, Spinal Reciprocal Directional Exclusivity, and *Limulus* Lateral Cluster Risk Suppression
- **Framework Standard:** `Intent -> Context -> Biologize -> Discover -> Abstract -> Emulate -> Assumptions (E/C/I/A) -> Invariants -> Working Contract -> Execute -> Evidence`
- **Companion Specifications:**
  - Pass 1: [bot_trade_biomimetic_survival_contract.md](https://docs.google.com/document/d/1Aqhv286aiR4RIZoHwwLt-5uH3DplRSuKjlJoc0-LGvg/edit?usp=drivesdk&ouid=101003428420312682812) (Profit Keeper, Alpha Decay & Autopilot)
  - Pass 2: [bot_trade_cpp_immune_verification_contract.md](https://docs.google.com/document/d/1cs1Y6H6QdogV6C9STH9IQyzZEMaNby2tCxn75ILJo5E/edit?usp=drivesdk&ouid=101003428420312682812) (C++ Sidecar Immune Verification & Crash Resilience)
  - Pass 4: [bot_trade_pass4_drawdown_vascular_shunting_contract.md](https://docs.google.com/document/d/16TfXSqTs7Yl8ayKjWxd9NpIfrUtFyyk8f6Ec-dhQ7ME/edit?usp=drivesdk&ouid=101003428420312682812) (Drawdown & Multi-Currency Shunting)
  - Prior Baseline Reference: [bot_trade_remediation_plan_aligned.md](https://drive.google.com/open?id=1gxewYVEtaEbJDij6_emUiQaPxfXYqJRlOLpzoZopRfs) & [CLAUDE.md](https://github.com/ang-kl/bot-trade/blob/main/CLAUDE.md)

## 1.2 Biomimicry Design Spiral Provenance (Peer-Reviewed Grounding)

| Biological Model & Scale | Peer-Reviewed Source | Abstracted Engineering Principle | Target `bot-trade` Subsystem |
| :--- | :--- | :--- | :--- |
| **Membrane Biophysics:** Axon Initial Segment (AIS) Voltage-Gated $Na_v$ Channels | [PMC12784352](https://pmc.ncbi.nlm.nih.gov/articles/PMC12784352/); [PMC6041316](https://pmc.ncbi.nlm.nih.gov/articles/PMC6041316/) | **Atomic $h$-Gate Refractory Lockout:** Lock the dispatch gateway synchronously upon firing; drop all re-entrant impulses sharing the same origin tuple before computing contract sizing, currency conversions, or database writes. | `agent/services/pending-orders.js` (`IdempotencyKey` atomic lock) |
| **Spinal Circuitry:** Vertebrate Ia Inhibitory Interneurons in Locomotor Pools | [PMC3150186](https://pmc.ncbi.nlm.nih.gov/articles/PMC3150186/); [PMC11090886](https://pmc.ncbi.nlm.nih.gov/articles/PMC11090886/); [PMC11580138](https://pmc.ncbi.nlm.nih.gov/articles/PMC11580138/) | **Reciprocal Cross-Coupled Mutual Exclusion:** Activating directional channel $D$ on an entity automatically clamps opposing channel $-D$, rendering simultaneous Long/Short margin lockups structurally impossible. | `agent/services/scanner.js` & `agent/services/risk.js` |
| **Sensory Neurobiology:** Horseshoe Crab (*Limulus polyphemus*) Lateral Eye Ommatidia | [PMC2225927](https://pmc.ncbi.nlm.nih.gov/articles/PMC2225927/); [PMC2729416](https://pmc.ncbi.nlm.nih.gov/articles/PMC2729416/) | **Weighted Lateral Cluster Suppression:** Firing an exposure on one channel broadcasts a proportional suppression weight to all correlated peer channels, preventing multi-asset cluster overexposure. | `agent/services/risk.js` (US Equity Beta & Crypto CFD clusters) |
| **Central Sensory Gating:** Thalamic Reticular Nucleus (TRN) & Auditory Midbrain | [PMC6773087](https://pmc.ncbi.nlm.nih.gov/articles/PMC6773087/); [PMC7062464](https://pmc.ncbi.nlm.nih.gov/articles/PMC7062464/); [PMC6729842](https://pmc.ncbi.nlm.nih.gov/articles/PMC6729842/) | **Tier 0 Pre-Cortical Noise Shedding:** Filter incoming tick and bar streams against primitive geometric and R:R boundaries at the C++ scanner edge before allocating Node.js CPU to deep pattern recognition. | `cpp-scan-tick/` & `cpp-scan-timeframe/` |

## 2.0 AI Prompt Syntax (Paste Directly into AI Coding Agent: Claude / Codex / Cursor)

### 2.1 ALIGNMENT FRAMEWORK & EXECUTION DIRECTIVE

You are an expert quantitative software engineer refactoring the [ang-kl/bot-trade](https://github.com/ang-kl/bot-trade) repository. To prevent probabilistic completion drift, you MUST strictly adhere to this Specification Contract. Every code change must satisfy the explicit Intent parameters, the Assumptions Classification Matrix (E/C/I/A), the Unbreakable System Invariants, and the working rules in [CLAUDE.md](https://github.com/ang-kl/bot-trade/blob/main/CLAUDE.md) (including deterministic zero-LLM trade paths and the `npm run check:no-green` red/green color-blindness gate).

### 2.2 INTENT & SYSTEM CONTEXT

- **Intent:** Eliminate re-entrant duplicate order storms (such as the 17 identical `DOW.US` orders placed in 1 ms costing -$1,615.00), eradicate CPU waste on dead scanner traces (such as 825,000 Cup & Handle evaluations yielding 0 executed trades), eliminate margin-locking opposing Long/Short positions on the same instrument (`GD.US`, `0003.HK`), and prevent correlated cluster overexposure across US Equity Beta and Crypto CFDs ([PR #1317](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMrfjtcuVyn9WwXKrrsBYtvvMgp98KiQ_I&mid=1a129c4a08e4669a)).
- **Context:** Node.js central service (`agent/`) paired with high-frequency C++ scanners (`cpp-scan-tick`, `cpp-scan-timeframe`) and persistent execution sidecars (`cpp-exec`) connected to cTrader across 25 instruments and 6 timeframes.

### 2.3 ASSUMPTIONS CLASSIFICATION MATRIX (E / C / I / A)

- **E — Explicit (Human & Architecture Directed):**
  - **E1 (Absolute USD Notional Sizing Floor):** Compute USD Notional Exposure as Lots * Contract Size * Price * FX Cross Rate before dispatching any order; reject immediately if exposure exceeds `accountBalance * maxRiskCapPct` (hard cap: 1.5% max risk per trade) ([bot_trade_remediation_plan_aligned.md](https://drive.google.com/open?id=1gxewYVEtaEbJDij6_emUiQaPxfXYqJRlOLpzoZopRfs)).
  - **E2 (Directional Uniqueness per Symbol):** An account shall never hold concurrent Long and Short positions on the same symbol, nor shall a signal in direction $-D$ be approved if position $D$ is open.
  - **E3 (Cluster Directional Beta Caps):** Net directional cluster exposure shall not exceed +/- 2.0 on US Equity Beta (`DOW.US`, `SPX500`, `NAS100`, `US2000`) and shall treat each Crypto CFD as a single exposure leg ([PR #1317](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMrfjtcuVyn9WwXKrrsBYtvvMgp98KiQ_I&mid=1a129c4a08e4669a)).
  - **E4 (Zero-LLM Fast Path):** All pre-trade gating, cluster tallying, and deduplication locks must execute in deterministic synchronous code (sub-millisecond latency).

- **C — Contextual (Established by Repository & Prior Audits):**
  - **C1 (Non-USD Sizing Conversion Failure):** Contract sizing on `JPN225`, `USDX`, `EURX`, `XPTUSD`, and `USDZAR` previously assumed 1 point equaled standard FX pip values, bypassing USD cross-rate conversion and generating massive oversized lot dispatches (PR #690).
  - **C2 (Crypto CFD Single-Leg Recognition):** In `agent/lib/contracts.js` ([PR #1317](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMrfjtcuVyn9WwXKrrsBYtvvMgp98KiQ_I&mid=1a129c4a08e4669a)), 6-letter crypto symbols (`BTCUSD`, `XRPUSD`, `FILUSD`, `ETCUSD`, `TONUSD`, `SUIUSD`) must be recognized as single-instrument CFDs rather than decomposed into FX legs that trigger false `overexposed_USD` vetoes.
  - **C3 (Dead-Weight Scanner Churn):** Cup & Handle strategy evaluated 825,676 scan traces (203k failed shape checks, 0 cleared R:R floor), consuming continuous CPU without ever producing an executable signal.

- **I — Inferred (Biomimetically Derived & Validated):**
  - **I1 (Late Lock Contention):** Placing the deduplication check inside an asynchronous database query or after currency conversion allows re-entrant event loop ticks to calculate sizing in parallel before finding the duplicate, causing event-loop stalling. The lock must engage at the very entrance of `pending-orders.js`.
  - **I2 (Mutual Agonist/Antagonist Spasms):** Allowing opposing positions on the same symbol locks account margin and incurs double spread costs with zero mathematical chance of positive expected value.

- **A — Assumed (Governed by Unbreakable Invariants Below):**
  - **A1:** An atomic in-memory `IdempotencyKey` set with a 60-second TTL is sufficient to absorb all network retry spikes, socket reconnections, and asynchronous tick bursts.
  - **A2:** Filtering candles for minimum geometric bounds and R:R clearance inside `cpp-scan-timeframe` sheds 90%+ of dead-weight IPC traffic to the Node.js agent.

### 2.4 UNBREAKABLE BIOMIMETIC SYSTEM INVARIANTS

1. **Invariant 1 — Atomic $Na_v$ Refractory Lockout (`pending-orders.js`):** The deduplication lock must be acquired **synchronously and atomically** before any asynchronous operation, FX cross-rate lookup, or lot-sizing calculation begins. The `IdempotencyKey` (`hash(accountId + symbol + strategy + direction + signalTimestamp)`) must be stored in a dedicated in-memory TTL set (60 seconds). If an incoming order matches an active key, it must be rejected synchronously with log `DUPLICATE_ORDER_DISPATCH_BLOCKED`.
2. **Invariant 2 — Spinal Reciprocal Inhibition (`scanner.js` & `risk.js`):** No signal in direction $-D$ shall ever be approved for `Symbol X` if account $A$ holds an open position or pending order in direction $D$ on `Symbol X`. Attempted opposing orders must be vetoed immediately with log `OPPOSING_DIRECTION_RECIPROCAL_VETO`.
3. **Invariant 3 — *Limulus* Lateral Cluster Risk Cap (`risk.js`):** No trade proposal shall be approved if its addition causes the net directional beta of its cluster to exceed the cluster cap (+/- 2.0 on US Equities; +/- 3.0 on Crypto CFDs). Correlated signals exceeding the cap must be vetoed with log `LATERAL_CLUSTER_SUPPRESSION_VETO`.
4. **Invariant 4 — Absolute USD Notional Sizing Floor (`pending-orders.js`):** Every order's USD notional exposure (`Lots * Contract Size * Price * FX Cross Rate to USD`) must be verified to be strictly <= `accountBalance * 0.015`. If FX conversion rates are unavailable, stale (>60s), or missing, the order must be rejected with log `FX_CROSS_RATE_UNAVAILABLE_VETO`.
5. **Invariant 5 — TRN Tier 0 Scanner Gating (`cpp-scan-timeframe` & `cpp-scan-tick`):** Strategy scanning engines shall **never** evaluate complex multi-candle pattern geometry or deep indicator history on candles that fail Tier 0 pre-filtering: (a) minimum ATR threshold, (b) active market session hours, and (c) mathematical feasibility of meeting `minRR >= 2.8:1` within recent swing bounds.

### 2.5 WORKING CONTRACT: FILE-BY-FILE CODE REFACTORING

#### 2.5.1 File: `agent/services/pending-orders.js` (Atomic $Na_v$ Inactivation & USD Sizing)

1. **Implement Synchronous Atomic $Na_v$ Idempotency Lock:**
   - Initialize an in-memory `Set` / TTL Map `activeOrderLocks = new Map()`.
   - Compute `idempotencyKey = computeIdempotencyKey({ accountId, symbol, strategy, direction, signalTimestamp })`.
   - Check `activeOrderLocks.has(idempotencyKey)` **synchronously** at the very first line of the dispatch handler:
     ```javascript
     if (activeOrderLocks.has(idempotencyKey)) {
       logger.warn({ idempotencyKey, symbol, strategy }, 'DUPLICATE_ORDER_DISPATCH_BLOCKED');
       return { approved: false, reason: 'DUPLICATE_ORDER_DISPATCH_BLOCKED' };
     }
     activeOrderLocks.set(idempotencyKey, Date.now() + 60000);
     ```
   - Automatically purge expired keys every 30 seconds via an unref'd timer.
2. **Enforce Absolute USD Notional Sizing with Live Cross-Rates:**
   - Resolve `fxRateToUSD = getLiveFxCrossRate(symbolQuoteCurrency, 'USD', db)`. If `!fxRateToUSD || isStale(fxRateToUSD)`, veto order.
   - Calculate: `usdNotional = lots * contractSize(symbol) * currentPrice * fxRateToUSD`.
   - Reject order with `NOTIONAL_EXPOSURE_EXCEEDED` if `usdNotional > accountBalance * 0.015`.

#### 2.5.2 File: `agent/services/scanner.js` & `agent/services/risk.js` (Reciprocal Inhibition & Lateral Caps)

1. **Enforce Reciprocal Inhibition (Mutual Exclusion per Symbol):**
   - Query active positions and working orders for `accountId` and `symbol`.
   - If position with `side !== proposal.side` exists, veto proposal immediately with `OPPOSING_DIRECTION_RECIPROCAL_VETO`.
2. **Implement *Limulus* Lateral Cluster Suppression Bus:**
   - Define asset clusters:
     - `US_EQUITY`: `['DOW.US', 'SPX500', 'NAS100', 'US2000']` (Cap: +/- 2.0)
     - `CRYPTO_CFD`: `CRYPTO_BASES` from `agent/lib/contracts.js` ([PR #1317](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMrfjtcuVyn9WwXKrrsBYtvvMgp98KiQ_I&mid=1a129c4a08e4669a)) (Cap: +/- 3.0)
     - `FX_MAJORS`: Net currency leg exposure caps (+/- 2.0 on any single currency).
   - Tally currently open directional exposures in the cluster. If `Math.abs(clusterNet + proposalNet) > maxClusterCap`, reject with `LATERAL_CLUSTER_SUPPRESSION_VETO`.

#### 2.5.3 File: `cpp-scan-timeframe/` & `cpp-scan-tick/` (TRN Pre-Cortical Noise Shedding)

1. **Implement Tier 0 Fast Gating in C++:**
   - In `cpp-scan-timeframe`, insert a Tier 0 sanity check before invoking pattern recognizers (such as Cup & Handle, Donchian, or Fibonacci):
     - Discard bars where `candle.high - candle.low < minAtrThreshold`.
     - Check whether `(recentSwingHigh - candle.close) / (candle.close - recentSwingLow) < minRRFloor`. If mathematically impossible to satisfy `minRR >= 2.8:1`, drop the candidate immediately.
   - Decommission or gate the Cup & Handle scanner logic so zero CPU cycles are spent on patterns that fail Tier 0 geometry.

### 2.6 EVIDENCE & AUTOMATED ACCEPTANCE TESTING SUITE (`npm test`)

All changes must pass `node --test "agent/**/*.test.js"`, `npx vitest run`, and `npm run check:no-green`, plus the following acceptance tests:

1. **Test 2.6.1 (Atomic $Na_v$ 1 ms Order Storm Suppression):** Simulate 20 concurrent HTTP/socket order dispatches arriving within 1 ms sharing the same `accountId`, `symbol`, `strategy`, and `signalTimestamp`; verify exactly 1 order executes and 19 return `DUPLICATE_ORDER_DISPATCH_BLOCKED`.
2. **Test 2.6.2 (Cross-Rate USD Notional Sizing):** Submit orders for `72.5` lots of `JPN225` and `22` lots of `EURX`; verify both trigger `NOTIONAL_EXPOSURE_EXCEEDED` and zero orders are dispatched to cTrader.
3. **Test 2.6.3 (Spinal Reciprocal Directional Exclusion):** Open a Long position on `GD.US`; simulate a subsequent Short signal on `GD.US`; verify the Short signal is vetoed with `OPPOSING_DIRECTION_RECIPROCAL_VETO` and margin remains unencumbered.
4. **Test 2.6.4 (*Limulus* Lateral Cluster Cap Enforcement):** Open 2 Long positions on `DOW.US` and `NAS100` totaling +1.8 net beta; simulate a 3rd Long signal on `SPX500` (+0.5 beta); verify the 3rd signal is vetoed with `LATERAL_CLUSTER_SUPPRESSION_VETO`.
5. **Test 2.6.5 (Crypto CFD Single-Leg Whitelist Verification):** Submit manual and algorithmic proposals for `BTCUSD`, `ETHUSD`, `SOLUSD`, `FILUSD`, `ETCUSD`, `TONUSD`, and `SUIUSD`; verify `isCryptoSymbol()` returns `true`, currency legs are treated as single CFD units, and zero false `overexposed_USD` failures occur ([PR #1317](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMrfjtcuVyn9WwXKrrsBYtvvMgp98KiQ_I&mid=1a129c4a08e4669a)).
6. **Test 2.6.6 (TRN Scanner Tier 0 Noise Shedding):** Feed 10,000 synthetic compressed/flat candles to `cpp-scan-timeframe`; verify 10,000 candles are dropped at Tier 0 with zero deep strategy evaluations or IPC payloads sent to Node.js.

## 3.0 Cross-Scale Biomimetic Synthesis & Nature's Unifying Patterns

| Nature's Unifying Pattern | Biological Model | Implementation in `ang-kl/bot-trade` |
| :--- | :--- | :--- |
| **1. Uses only the energy it needs** | TRN pre-cortical gating drops 90%+ of irrelevant acoustic noise before cortical activation ([PMC6773087](https://pmc.ncbi.nlm.nih.gov/articles/PMC6773087/)). | Tier 0 C++ candle checks eliminate 825k dead Cup & Handle scan traces, saving server CPU. |
| **2. Recycles all materials** | Inactivated sodium channels undergo structural conformational recovery during repolarization. | Expired `IdempotencyKey` memory buffers are pruned continuously every 30s without database thrash. |
| **3. Resilient to disturbances** | Axonal membranes physically cannot be forced into runaway tetanic storms during the refractory period ([PMC12784352](https://pmc.ncbi.nlm.nih.gov/articles/PMC12784352/)). | Synchronous in-memory $h$-gate lock guarantees that network spikes or re-entrant loops cannot duplicate trades. |
| **4. Optimizes rather than maximizes** | Sensory lateral inhibition sharpens contrast rather than transmitting maximum raw light intensity ([PMC2225927](https://pmc.ncbi.nlm.nih.gov/articles/PMC2225927/)). | Caps net portfolio cluster exposure (+/- 2.0 US Beta), taking only the highest-conviction lead signal. |
| **5. Provides mutual benefits** | Agonist and antagonist muscle coordination enables smooth locomotion without joint damage ([PMC3150186](https://pmc.ncbi.nlm.nih.gov/articles/PMC3150186/)). | Reciprocal inhibition preserves account margin for profitable setups rather than tying it up in net-zero spreads. |
| **6. Runs on information** | Axonal action potentials are all-or-none discrete pulses governed by precise millivolt thresholds. | Order dispatches are atomic single pulses carrying exact strategy tags (`openapi_cbot-t`) and verified cross-rates. |
| **7. Uses safe chemistry & materials** | Hyperpolarization prevents excitotoxic calcium overload in neurons. | Absolute USD notional exposure caps (<= 1.5%) eliminate toxic cross-currency lot blowups (`JPN225`, `EURX`). |
| **8. Builds using abundant resources** | Compound eyes distribute processing across thousands of simple, cheap ommatidia ([PMC2729416](https://pmc.ncbi.nlm.nih.gov/articles/PMC2729416/)). | Fast in-memory hash sets handle deduplication at microsecond speeds without calling external services. |
| **9. Locally attuned and responsive** | Individual ommatidia attenuate neighbors based on local spatial proximity and intensity ([PMC2225927](https://pmc.ncbi.nlm.nih.gov/articles/PMC2225927/)). | Cluster suppression buses dynamically adapt exposure based on correlated sector groupings. |
| **10. Uses shape to determine functionality** | The ball-and-chain protein structure physically occludes the channel pore during repolarization ([PMC12784352](https://pmc.ncbi.nlm.nih.gov/articles/PMC12784352/)). | Pre-flight synchronous gating structurally prevents order construction until the entry lock is acquired. |

## 4.0 Implementation & Deployment Checklist

- [ ] **4.1 Pause Live Autotrading:** Send `/pause` via Telegram before deploying dispatch and scanner updates.
- [ ] **4.2 Create Feature Branch:** `git checkout -b feat/synaptic-gating-refractory-contract`
- [ ] **4.3 Implement Gating Modules:** Apply Sections `2.5.1` through `2.5.3` across `agent/services/` and `cpp-scan-*/`.
- [ ] **4.4 Run Full Automated Test Suite:**
  - `node --test "agent/**/*.test.js"`
  - `npx vitest run`
  - `npm run check:no-green`
- [ ] **4.5 Stress-Test Re-Entrant Dispatch on Demo (`5306502`):** Fire 50 concurrent rapid-fire POST requests for the same signal to `/actions/manual-order` and `/actions/preorder`; verify exactly 1 order reaches cTrader and 49 are blocked with `DUPLICATE_ORDER_DISPATCH_BLOCKED`.
