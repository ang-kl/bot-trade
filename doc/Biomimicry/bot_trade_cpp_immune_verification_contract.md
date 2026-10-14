# 1.0 Master Biomimetic Engineering Specification & AI Refactoring Contract (Pass 2: C++ Sidecar Immune Verification & Systemic Fault Resilience)

## 1.1 Specification Header & Metadata

- **Project Target:** [`ang-kl/bot-trade`](https://github.com/ang-kl/bot-trade) (`cpp-verify/`, `cpp-exec/`, `agent/services/naked-position-guard.js`, `agent/services/position-lifecycle-evidence.js`, `agent/routes/state.js`, and `agent/index.js` Heartbeat Supervisor)  
- **Purpose:** Autonomous C++ Sidecar Immune Surveillance, Coincident Two-Signal Reconciler Verification, Lock-Free PINK1/Parkin Worker Stall Isolation, and Decapitation-Safe Octopus Peripheral Reflexes  
- **Framework Standard:** `Intent -> Context -> Biologize -> Discover -> Abstract -> Emulate -> Assumptions (E/C/I/A) -> Invariants -> Working Contract -> Execute -> Evidence`  
- **Companion Specifications:** [`bot_trade_biomimetic_survival_contract.md`](https://docs.google.com/document/d/1Aqhv286aiR4RIZoHwwLt-5uH3DplRSuKjlJoc0-LGvg/edit?usp=drivesdk&ouid=101003428420312682812), [`bot_trade_remediation_plan_aligned.md`](https://drive.google.com/open?id=1gxewYVEtaEbJDij6_emUiQaPxfXYqJRlOLpzoZopRfs), & [`CLAUDE.md`](https://github.com/ang-kl/bot-trade/blob/main/CLAUDE.md)

## 1.2 Biomimicry Design Spiral Provenance (Peer-Reviewed Grounding)

| Biological Model & Scale | Peer-Reviewed Source | Abstracted Engineering Principle | Target `bot-trade` Subsystem |
| :---- | :---- | :---- | :---- |
| **Cellular / Innate Immunity:** Natural Killer (NK) Cell "Missing-Self" Recognition | [PMC3984600](https://pmc.ncbi.nlm.nih.gov/articles/PMC3984600/); [PMC2532809](https://pmc.ncbi.nlm.nih.gov/articles/PMC2532809/); [PMC3661161](https://pmc.ncbi.nlm.nih.gov/articles/PMC3661161/); [PMC5305116](https://pmc.ncbi.nlm.nih.gov/articles/PMC5305116/) | **Inhibitory "Missing-Token" Audit:** Patrol all open broker exposures with a primed containment reflex held in check only by a complete 4-field self-integrity certificate (`MHC-I` token). Any missing field releases the brake immediately. | `cpp-verify/` & `agent/services/naked-position-guard.js` |
| **Intercellular / Adaptive Immunity:** T-Cell Two-Signal Co-Stimulation & DAMP Sensing | [PMC11277571](https://pmc.ncbi.nlm.nih.gov/articles/PMC11277571/); [PMC2853772](https://pmc.ncbi.nlm.nih.gov/articles/PMC2853772/); [PMC2928676](https://pmc.ncbi.nlm.nih.gov/articles/PMC2928676/); [PMC5554486](https://pmc.ncbi.nlm.nih.gov/articles/PMC5554486/) | **Coincident Two-Signal Fault Escalation:** Never execute a destructive state mutation or forced liquidation on a single state-mismatch observation (Signal 1); require an independent transport/receipt co-signal (Signal 2), entering read-only tolerance (`anergy`) otherwise. | `agent/routes/state.js` & `agent/services/position-lifecycle-evidence.js` |
| **Subcellular / Organelle:** PINK1/Parkin Selective Mitophagy | [PMC3656616](https://pmc.ncbi.nlm.nih.gov/articles/PMC3656616/); [PMC3039741](https://pmc.ncbi.nlm.nih.gov/articles/PMC3039741/); [PMC4764997](https://pmc.ncbi.nlm.nih.gov/articles/PMC4764997/) | **Passive Marker-Accumulation Stall Isolation:** Deposit an in-memory `pink1_counter` on each background worker loop that is cleaved to `0` only upon completing a non-blocking cycle; isolate and recycle only wedged loops without touching `agent.db` locks. | `agent/index.js` (`controller_heartbeats` & 23 background loops) |
| **Organismal / Neurobiological:** Octopus (*Octopus vulgaris*) Peripheral Axial Nerve Cord (ANC) | [PMC8988249](https://pmc.ncbi.nlm.nih.gov/articles/PMC8988249/); [PMC6478645](https://pmc.ncbi.nlm.nih.gov/articles/PMC6478645/); [PMC10755184](https://pmc.ncbi.nlm.nih.gov/articles/PMC10755184/); [PMC11430158](https://pmc.ncbi.nlm.nih.gov/articles/PMC11430158/) | **Decapitation-Safe Peripheral Reflex Arc:** Embed autonomous survival reflexes directly inside the C++ broker sidecars so emergency SL injection and duplicate order blocking continue uninterrupted if the central Node.js container crashes or restarts. | `cpp-exec/` & `cpp-verify/` (`POST /heartbeat` two-way ganglionic link) |

## 2.0 AI Prompt Syntax (Paste Directly into AI Coding Agent: Claude / Codex / Cursor)

### 2.1 ALIGNMENT FRAMEWORK & EXECUTION DIRECTIVE

You are an expert C++20 and Node.js systems engineer refactoring the [`ang-kl/bot-trade`](https://github.com/ang-kl/bot-trade) repository. To prevent probabilistic completion drift, you MUST strictly adhere to this Specification Contract. Every code change must satisfy the explicit Intent parameters, the Assumptions Classification Matrix (E/C/I/A), the Unbreakable System Invariants, and the working directives in [`CLAUDE.md`](https://github.com/ang-kl/bot-trade/blob/main/CLAUDE.md) (including deterministic zero-LLM trade paths and the `npm run check:no-green` red/green color-blindness gate).

### 2.2 INTENT & SYSTEM CONTEXT

- **Intent:** Eliminate production Railway container crashes ([Oct 13, 2026 Railway crash alerts](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DM134wjVmCOUqe1V6rB5cGTT7B_fQ7bft4&mid=1a137a18464fef54)), eradicate SQLite `SQLITE_BUSY` heartbeat lock contention across the 23 background loops, prevent reconciler panic on stale/foreign snapshots ([PR \#1348](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMWF1a1rPQz6dJBIh364ym23gC_xcU4n9w&mid=1a132e36a75f483b), [PR \#1362](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMm_gzaf3V4-A_dajNev7CGB6lCd_jtS7I&mid=1a1372064cb21b42), [PR \#1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5)), and equip `cpp-verify` and `cpp-exec` with autonomous peripheral survival reflexes that protect open broker positions even if the central Node.js service disconnects or reboots.  
- **Context:** Hybrid Node.js (`agent/`) and C++ sidecar (`cpp-exec/`, `cpp-verify/`, `cpp-scan-tick/`, `cpp-scan-timeframe/`) architecture running inside Docker on Railway (`sg-trade`) with persistent storage at `/data/agent.db` and Phase 2 of `CPP-ROADMAP.md` (`POST /heartbeat` two-way liveness) underway.

### 2.3 ASSUMPTIONS CLASSIFICATION MATRIX (E / C / I / A)

- **E — Explicit (Human & Architecture Directed):**  
    
  - **E1 (Zero Unprotected Broker Exposure):** Every open position at the broker must carry a verified broker-side stop-loss (`SL`) bounded by `<= 1.5%` USD account equity risk or `3 * ATR` emergency floor ([`bot_trade_remediation_plan_aligned.md`](https://drive.google.com/open?id=1gxewYVEtaEbJDij6_emUiQaPxfXYqJRlOLpzoZopRfs)).  
  - **E2 (Two-Way Sidecar Liveness):** Complete `CPP-ROADMAP.md` Phase 2 so `cpp-exec` and `cpp-verify` exchange bidirectional heartbeats with Node.js without blocking the SQLite write path.  
  - **E3 (Terminal vs. Mutable Verdict Separation):** As established in [PR \#1362](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMm_gzaf3V4-A_dajNev7CGB6lCd_jtS7I&mid=1a1372064cb21b42) and [PR \#1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5), `sweepCandidate` must skip futile 15-minute rereads of `permanently_unsupported` (\>500 deal) histories for fill extraction while still allowing mutable finals (`empty_at_broker`) and independent rate backfill.  
  - **E4 (Color-Blind Accessibility Gate):** Any UI health indicators added to the **Desk** tab for sidecar immune status or PINK1/Parkin loop health must strictly obey `scripts/check-no-green.sh` (`blue` \= nominal, `amber/slate` \= anergy/quarantine, `red` \= severed/fault).


- **C — Contextual (Established by Repository & Recent PR Audits):**  
    
  - **C1 (Foreign Snapshot Cross-Enrichment Bug):** In `agent/routes/state.js` ([PR \#1348](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMWF1a1rPQz6dJBIh364ym23gC_xcU4n9w&mid=1a132e36a75f483b)), when an attributed account had a valid snapshot with zero positions (`s.positions.size === 0`) or lacked a scoped cache, `snapById` substituted `globalSnap`, cross-contaminating position quantities across overlapping cTrader position IDs.  
  - **C2 (Unvalidated Account Stamp on Reversal Fills):** In `agent/services/position-lifecycle-evidence.js` ([PR \#1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5)), calling `stampFilledFromHistory()` before validating `response.ctidTraderAccountId` allowed an overlapping position ID from another account to overwrite `filled_volume`.  
  - **C3 (Railway Production Crash Loops):** On Oct 11–14, 2026, Railway emitted over 60 production crash notifications ([Railway crash thread](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DM134wjVmCOUqe1V6rB5cGTT7B_fQ7bft4&mid=1a137a18464fef54)) when synchronous SQLite lock contention, unhandled promise rejections, or memory spikes terminated the container.


- **I — Inferred (Biomimetically Derived & Validated):**  
    
  - **I1 (SQLite Heartbeat Self-Locking):** Having 23 background loops write liveness timestamps directly into SQLite (`controller_heartbeats`) turns the health monitor itself into a lock-contention amplifier during heavy candle/tick bursts—analogous to an immune sensor causing toxic inflammation in healthy tissue.  
  - **I2 (Central Brain Single Point of Failure):** Keeping `naked-position-guard.js` exclusively in Node.js leaves open positions defenseless during the 15–90 seconds it takes a crashed Railway container to restart and re-authenticate.


- **A — Assumed (Governed by Unbreakable Invariants Below):**  
    
  - **A1:** Buffering `controller_heartbeats` in a lock-free in-memory ring buffer (flushed to SQLite asynchronously in a single batched transaction every 30 seconds) eliminates 95%+ of heartbeat write transactions while providing sub-second PINK1 stall detection.  
  - **A2:** A 45-second central-silence window (`ANC_SEVERANCE_THRESHOLD_MS = 45000`) inside `cpp-verify` / `cpp-exec` is long enough to ignore normal Node.js GC pauses but short enough to autonomously attach emergency broker SLs during a container crash.

### 2.4 UNBREAKABLE BIOMIMETIC SYSTEM INVARIANTS

1. **Invariant 1 — NK Cell "Missing-Self" MHC-I Certificate (`cpp-verify` & `naked-position-guard.js`):** Every open broker position must continuously exhibit a valid 4-part **Self-Integrity Certificate** (`MHC_I_Token`): (a) matching `ctidTraderAccountId`, (b) broker-side `stopLoss` present and within `<= 1.5%` equity / `3 * ATR` risk bound, (c) positive verified `broker_volume_units`, and (d) non-opposing directional uniqueness on that symbol. Any position missing component (b) for more than 10 seconds triggers an automatic protective SL injection reflex.  
2. **Invariant 2 — T-Cell Two-Signal Co-Stimulation Gate (`state.js` & Reconciler):** The reconciler shall **never** mark an open local trade `closed`, overwrite its `filled_volume`, or liquidate a position based solely on a single missing position in a snapshot (Signal 1). Destructive state transitions require **Signal 2**: a verified closing deal execution receipt in `broker_deals` with matching `ctidTraderAccountId === accountId` and monotonic broker timestamp `>= last_reconciled_ts`. Without Signal 2, the position enters non-destructive `ANERGY_WAIT` state.  
3. **Invariant 3 — PINK1/Parkin Lock-Free Stall Isolation (`agent/index.js` Heartbeat Supervisor):** Background controllers shall **never** perform synchronous per-tick/per-loop `INSERT/UPDATE` writes to the SQLite `controller_heartbeats` table. Each loop cleaves its own in-memory `pink1_counter` to `0` on cycle completion; if `pink1_counter >= 3` consecutive missed intervals, the Parkin supervisor aborts only that loop's in-flight promise/handle, logs `PARKIN_LOOP_RECYCLED`, and respawns the worker without crashing the Node.js process.  
4. **Invariant 4 — Octopus ANC Peripheral Reflex Autonomy (`cpp-exec` & `cpp-verify`):** If `cpp-verify` or `cpp-exec` detects no valid heartbeat from the central Node.js coordinator for `>= 45 seconds` (`ANC_SEVERANCE_MODE`), the C++ sidecar immediately activates local peripheral reflex authority: (a) rejecting all new incoming order requests, (b) auditing all open broker positions every 5 seconds, and (c) autonomously submitting a protective broker-side stop-loss (`entry_price +/- emergencyStopDistance`) via `cpp-exec` for any naked position.  
5. **Invariant 5 — Terminal History Read Conservation (`position-lifecycle-evidence.js`):** The lifecycle sweep shall **never** schedule repeated 15-minute broker deal-history fetches for open positions already classified as `permanently_unsupported` (\>500 deals / paged history) for fill-volume recovery, preserving shared broker rate-limit slots for mutable positions (`empty_at_broker`).

### 2.5 WORKING CONTRACT: FILE-BY-FILE CODE REFACTORING

#### 2.5.1 Directory: `cpp-verify/` & `cpp-exec/` (Octopus ANC Reflex & NK Missing-Self Audit)

1. **Implement Bidirectional Ganglionic Heartbeat (`POST /heartbeat` & Shared Memory / Socket Ping):**  
   - Complete Phase 2 of `CPP-ROADMAP.md`: emit a lightweight JSON liveness frame `{ sidecar: "cpp-verify" | "cpp-exec", ts, openPositionsCount, socketConnected, mhcViolations }` every 10 seconds to the Node agent, and track `last_central_ack_ms` from Node.js.  
2. **Implement NK Cell `MHC_I_Token` Verifier in `cpp-verify`:**  
   - For every open position reported by the cTrader socket, evaluate the 4-part `MHC_I_Token`:  
     - `hasAccountMatch`: `pos.ctidTraderAccountId == configuredAccountId`  
     - `hasProtectiveStop`: `pos.stopLoss > 0` and `(side == LONG ? pos.stopLoss < pos.entryPrice : pos.stopLoss > pos.entryPrice)`  
     - `hasValidVolume`: `pos.volume > 0`  
     - `hasDirectionalUniqueness`: zero opposing positions open on `pos.symbolId` for the same account.  
   - If `hasProtectiveStop` is `false` for `> 10 seconds`, emit an immediate `MISSING_SELF_NAKED_POSITION` alert to Node.js.  
3. **Implement Decapitation-Safe `ANC_SEVERANCE_MODE` in `cpp-verify` / `cpp-exec`:**  
   - When `now_ms - last_central_ack_ms >= 45000` (Node.js container crashed or unreachable), transition sidecar state to `ANC_SEVERANCE_MODE`:  
     - Block any queued or re-entrant order-open commands.  
     - For any open broker position failing `hasProtectiveStop`, autonomously dispatch an `AmendPositionSLTPReq` protobuf message over the persistent cTrader socket setting `stopLoss` to the cached `emergency_sl_price` (or `1.5%` account balance risk cap / `3 * ATR` fallback).  
     - Append the autonomous action to a local append-only recovery journal (`/data/anc_reflex_journal.jsonl`) so Node.js imports the exact receipt upon reboot.

#### 2.5.2 File: `agent/index.js` & `agent/services/heartbeat-supervisor.js` (PINK1/Parkin Mitophagy)

1. **Replace Synchronous SQLite Heartbeat Writes with In-Memory PINK1 Counters:**  
   - Maintain an in-memory map `loopState.set(loopName, { pink1Counter: 0, lastCleavedAt: Date.now(), intervalMs, abortController })` for all 23 background controllers.  
   - An external `setInterval` ticks every `intervalMs` and increments `pink1Counter++` for each registered loop.  
   - When a loop finishes its unit of work cleanly, it calls `cleavePink1(loopName)` which resets `pink1Counter = 0` and updates `lastCleavedAt = Date.now()` in memory.  
   - Flush aggregated heartbeat timestamps to the SQLite `controller_heartbeats` table in a **single batched `BEGIN IMMEDIATE` transaction once every 30 seconds**, eliminating per-loop `SQLITE_BUSY` contention.  
2. **Implement Parkin Selective Worker Recycling & Process Crash Guard:**  
   - If any loop's `pink1Counter >= 3` (stalled for 3x its nominal interval), the Parkin supervisor invokes `abortController.abort()`, releases any held mutex/lock token, logs `PARKIN_WORKER_ISOLATED_AND_RECYCLED`, and re-initializes that single loop timer after a 5-second backoff.  
   - Install top-level `process.on('unhandledRejection')` and `process.on('uncaughtException')` DAMP handlers that log structured diagnostics and trigger Parkin loop isolation rather than allowing a transient broker timeout to crash the entire Railway container.

#### 2.5.3 File: `agent/services/position-lifecycle-evidence.js` (Two-Signal Verification & Read Conservation)

1. **Enforce Signal 1 \+ Signal 2 Account Verification Before Stamping Fills ([PR \#1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5)):**  
   - Before invoking `stampFilledFromHistory(db, response, accountId, positionId)`, verify **Signal 2**: `Number(response?.ctidTraderAccountId) === Number(accountId)` and basic deal-history structural integrity. If the response names a foreign account, abort with `{ lots: null, reason: 'foreign_account_response_rejected' }`.  
2. **Skip Futile Rereads of `permanently_unsupported` Open Positions ([PR \#1362](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMm_gzaf3V4-A_dajNev7CGB6lCd_jtS7I&mid=1a1372064cb21b42)):**  
   - In `sweepCandidate()` for the `filled` class, exclude open positions whose `position_lifecycle_evidence` row already has `final = 1` and `verdict = 'permanently_unsupported'` (since \>500-deal paged histories cannot shrink below the reader bound), while continuing to allow retries for mutable verdicts like `empty_at_broker`.  
3. **Decouple Rate Backfill from Money-Lifecycle Persistability ([PR \#1364](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DN7tXNv8MGWO_XE_2niV5XyweDM3H_zMqk&mid=1a1373cc27ef01b5)):**  
   - Extract and persist deal execution rates (`persistReceipts` rate columns) independently of `classified.persistable` so netted reversals and histories containing a rejected deal still populate conversion rates across the full `RATES_WINDOW_DAYS = 190` window, and union rate candidates from `broker_deals` so broker-only positions are covered.

#### 2.5.4 File: `agent/routes/state.js` (Coincident Two-Signal Snapshot & Freshness Reconciliation)

1. **Enforce Self/Non-Self Snapshot Isolation ([PR \#1348](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMWF1a1rPQz6dJBIh364ym23gC_xcU4n9w&mid=1a132e36a75f483b)):**  
   - When building `snapById`, treat an account's own present snapshot (`s.present === true`) as authoritative even when `s.positions.size === 0`.  
   - For legacy shared snapshots (`globalSnap`), require `globalSnap.accountId != null && Number(globalSnap.accountId) === Number(id)` (or restrict unattributed legacy caches strictly to the currently selected account) so multiple accounts lacking their first scoped snapshot never cross-read overlapping position IDs.  
2. **Compare Timestamp Freshness Between Snapshot and Reconciler (`current_lots`):**  
   - Compare `s.updatedAt` (snapshot timestamp) against `r.reconciled_at` (`broker_volume_units` timestamp). Select `sp.lots` (`lots_source = 'broker_snapshot'`) **only** when the scoped snapshot is at least as fresh as the reconciler reading; otherwise use `unitsToLots(r.broker_volume_units)` (`lots_source = 'reconciler_units'`).

### 2.6 EVIDENCE & AUTOMATED ACCEPTANCE TESTING SUITE (`npm test`)

All changes must pass `node --test "agent/**/*.test.js"`, `npx vitest run`, and `npm run check:no-green`, plus the following acceptance tests:

1. **Test 2.6.1 (NK Missing-Self Naked Position Reflex):** Simulate an open broker position in `cpp-verify` with `stopLoss = 0` for `> 10s`; verify `MISSING_SELF_NAKED_POSITION` fires and an emergency protective SL is attached within the `1.5%` equity / `3 * ATR` bound.  
2. **Test 2.6.2 (Octopus ANC Severance Mode):** Simulate a 45-second Node.js heartbeat blackout while `cpp-exec` / `cpp-verify` holds an open naked position; verify the C++ sidecar enters `ANC_SEVERANCE_MODE`, attaches the emergency broker SL autonomously, blocks new order dispatches, writes `/data/anc_reflex_journal.jsonl`, and reconciles cleanly when Node.js reconnects.  
3. **Test 2.6.3 (T-Cell Two-Signal Foreign & Stale Snapshot Rejection):** Simulate `getPositionDeals` returning a payload with `ctidTraderAccountId = 999999` for Account `5306502` on overlapping position ID `42`; verify `stampFilledFromHistory()` rejects the payload (`foreign_account_response_rejected`) and preserves existing `filled_volume`.  
4. **Test 2.6.4 (Snapshot vs. Reconciler Freshness Arbitration):** Simulate a partial close from `9.5` lots to `4.7` lots recorded by the reconciler (`reconciled_at = T + 10s`) while the cached snapshot still holds `9.5` lots from `T`; verify `/state` outputs `current_lots = 4.7` (`lots_source = 'reconciler_units'`).  
5. **Test 2.6.5 (PINK1/Parkin Worker Stall Isolation & Zero SQLite Contention):** Inject a simulated 3-interval promise hang into 1 of the 23 background loops while firing 500 concurrent candle updates; verify zero `SQLITE_BUSY` errors occur on `controller_heartbeats`, the wedged loop's `pink1Counter` reaches `3`, Parkin recycles *only* that loop (`PARKIN_WORKER_ISOLATED_AND_RECYCLED`), and the Node.js process remains up with zero crash exits.  
6. **Test 2.6.6 (Terminal History Read Conservation):** Seed an open position with `verdict = 'permanently_unsupported'` (`final = 1`) and another with `verdict = 'empty_at_broker'` (`final = 1`); verify `sweepCandidate(db, acct, 'filled')` skips the `permanently_unsupported` position while selecting the `empty_at_broker` position.

## 3.0 Cross-Scale Biomimetic Synthesis & Nature's Unifying Patterns

### 3.1 BIDARA Step 5 Reflection Across Scales

Grouping our four Pass 2 organisms reveals two complementary survival architectures:

- **Group 1 — Inverse Identity & Coincident Proof Filters (NK Cells \+ T-Cell Co-Stimulation):** Rather than maintaining an exhaustive blacklist of every possible software bug or network glitch, the system defines a compact **Self-Integrity Certificate (`MHC-I`)** ([PMC3984600](https://pmc.ncbi.nlm.nih.gov/articles/PMC3984600/)) and requires **Two-Signal Coincidence** ([PMC11277571](https://pmc.ncbi.nlm.nih.gov/articles/PMC11277571/)) before mutating state.  
- **Group 2 — Passive Degradation Sensors & Decentralized Ganglia (PINK1/Parkin \+ Octopus ANC):** Rather than funneling all liveness checks and emergency reflexes through a single central bottleneck (`agent.db` / Node.js main thread), liveness is measured passively via **work-coupled marker clearance** ([PMC3039741](https://pmc.ncbi.nlm.nih.gov/articles/PMC3039741/)) and survival reflexes execute locally in **peripheral C++ ganglia** ([PMC8988249](https://pmc.ncbi.nlm.nih.gov/articles/PMC8988249/)).

### 3.2 Alignment with Nature's 10 Unifying Patterns

| Nature's Unifying Pattern | Biological Mechanism | Implementation in `ang-kl/bot-trade` |
| :---- | :---- | :---- |
| **1\. Uses only the energy it needs** | NK cells and PINK1 sensors rely on passive receptor inhibition and work-coupled cleavage rather than active central polling ([PMC3984600](https://pmc.ncbi.nlm.nih.gov/articles/PMC3984600/); [PMC3039741](https://pmc.ncbi.nlm.nih.gov/articles/PMC3039741/)). | Eliminates 23-loop synchronous SQLite heartbeat writes and skips futile 15-minute rereads of `permanently_unsupported` \>500-deal histories ([PR \#1362](https://mail.google.com/mail/?extsrc=sync&client=h&plid=ACUX6DMm_gzaf3V4-A_dajNev7CGB6lCd_jtS7I&mid=1a1372064cb21b42)). |
| **2\. Recycles all materials** | PINK1/Parkin mitophagy digests stalled organelles and recycles amino acids without killing the host cell ([PMC3656616](https://pmc.ncbi.nlm.nih.gov/articles/PMC3656616/)). | Parkin worker supervisor aborts and recycles individual stalled background loops in-place without crashing the Railway container. |
| **3\. Resilient to disturbances** | Severed *Octopus vulgaris* arms maintain local protective reflexes independently of the brain ([PMC8988249](https://pmc.ncbi.nlm.nih.gov/articles/PMC8988249/)). | `cpp-exec` and `cpp-verify` enter `ANC_SEVERANCE_MODE` during Node.js restarts, autonomously guarding open broker positions. |
| **4\. Optimizes rather than maximizes** | Immune co-stimulation balances pathogen clearance against autoimmune tissue damage ([PMC2853772](https://pmc.ncbi.nlm.nih.gov/articles/PMC2853772/)). | Coincident Two-Signal reconciliation prevents false-alarm panic closures during transient API drops while guaranteeing real fills are recorded. |
| **5\. Provides mutual benefits** | Central brain intent and peripheral arm proprioception mutually inform one another ([PMC10755184](https://pmc.ncbi.nlm.nih.gov/articles/PMC10755184/)). | `cpp-verify` audits protect Node.js state integrity, while Node.js risk parameters calibrate `cpp-exec` emergency stop distances. |
| **6\. Runs on information** | T-cells integrate antigen affinity (Signal 1\) with DAMP trauma signals (Signal 2\) ([PMC5554486](https://pmc.ncbi.nlm.nih.gov/articles/PMC5554486/)). | State transitions require matching `ctidTraderAccountId` provenance and timestamp freshness (`s.updatedAt` vs. `r.reconciled_at`). |
| **7\. Uses safe, non-toxic operations** | Autophagy sequesters toxic reactive oxygen species inside autophagosomes ([PMC6678135](https://pmc.ncbi.nlm.nih.gov/articles/PMC6678135/)). | Unhandled promise rejections and foreign account snapshots are quarantined before they can corrupt `agent.db` or crash production. |
| **8\. Builds using abundant resources** | Innate immunity uses lightweight, ubiquitous surface markers (`MHC-I`) across all cells ([PMC2532809](https://pmc.ncbi.nlm.nih.gov/articles/PMC2532809/)). | Lightweight in-memory counters (`pink1Counter`) and bitmask certificate checks run at nanosecond cost, saving broker API quota for real trades. |
| **9\. Locally attuned and responsive** | Peripheral axial nerve cords respond immediately to local mechanical and chemical cues ([PMC6478645](https://pmc.ncbi.nlm.nih.gov/articles/PMC6478645/)). | `cpp-exec` reacts directly to live cTrader socket frames at millisecond latency without round-tripping through HTTP/SQLite. |
| **10\. Uses shape to determine functionality** | Complementary receptor-ligand geometry (`KIR` \+ `MHC-I`) physically blocks cytotoxicity on healthy cells ([PMC2532809](https://pmc.ncbi.nlm.nih.gov/articles/PMC2532809/)). | Structural schema validation (`MHC_I_Token`) structurally prevents an unbracketed or foreign-attributed position from passing audit. |

## 4.0 Implementation & Deployment Checklist

- [ ] **4.1 Pause Live Autotrading:** Send `/pause` via Telegram before deploying sidecar and supervisor changes.  
- [ ] **4.2 Create Feature Branch:** `git checkout -b feat/cpp-immune-verification-contract`  
- [ ] **4.3 Implement C++ & Node.js Modules:** Apply Sections `2.5.1` through `2.5.4`.  
- [ ] **4.4 Run Full Verification Gate:**  
      - `node --test "agent/**/*.test.js"`  
      - `npx vitest run`  
      - `npm run check:no-green`  
- [ ] **4.5 Simulate Container Crash & Severance Drill on Demo (`5306502`):** Open a test position on Demo, kill the Node.js worker process for 60 seconds while leaving `cpp-exec` / `cpp-verify` connected, verify `ANC_SEVERANCE_MODE` attaches the emergency SL and logs to `/data/anc_reflex_journal.jsonl`, and confirm clean reconciliation upon Node.js restart.