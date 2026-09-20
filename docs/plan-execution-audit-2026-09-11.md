# Plan-execution audit — whole-plan synthesis (release auditor, plan.md §15)

Repo `/home/user/bot-trade`, HEAD `fd85140` (#892 P6a merged; tree `36cefa4`, byte-identical to the `2a3b5ff` tree the three investigators audited). Read-only. 11-09-2026 09:09 UTC (17:09 SGT). Inputs: `audit-A-tick.md` (tick-momentum docs), `audit-B-system.md` (16 system/architecture docs), `audit-C-ui.md` (11 UI docs + plan §13). Account ids last-4 only.

Counting rule used throughout: one row of an investigator's per-document table = one claim; a compound verdict takes its first token (`PARTIAL / SUPERSEDED` → PARTIAL, `EXECUTED, then SUPERSEDED` → EXECUTED, `EXECUTED (held)` → EXECUTED). The 42 readiness-register rows are counted once, in §4, not in the group A total.

---

## 1. Verdict — have the agents drifted from the plans?

**Yes, in one specific way, and no in another.** Across 519 claims in 30 documents the code has *not* wandered off to do something the plans did not ask for: 226 claims are EXECUTED (44%), 25 are SUPERSEDED by a later, usually stronger, design (the entry ledger for the duplicate lock, the tick programme for the scan rewrite, the type canon for the 12/11/10/9 scale), and every superseding decision is traceable to an owner order. Where the drift exists it is **drift by omission and by over-stating completion**: 112 claims NOT EXECUTED (22%), 116 PARTIAL (22%), 37 UNVERIFIABLE (7%), and the omissions cluster exactly where the plans said the money is — durability under the intent ledger (`synchronous = NORMAL`), permits that bind no bracket, protection with no single writer, a halt that is a snapshot on the manual reverse route, a live exit rule (`trailR: 0.5`) that is not the rule the evidence was measured on, and a fleet-arming page (Tune › Pipeline) that cannot say which entry engine is running. Per group — **A (tick programme, 202 claims):** 88 EXECUTED / 59 PARTIAL / 48 NOT EXECUTED / 0 SUPERSEDED / 5 UNVERIFIABLE (+2 N/A). **B (system plans, 157):** 72 / 29 / 24 / 12 / 20. **C (UI plans, 160):** 66 / 28 / 40 / 13 / 12 (+1 N/A). The readiness register, filed as 19 IMPLEMENTED / 9 PARTIAL / 14 PLANNED, audits as 8 EXECUTED / 21 PARTIAL / 12 NOT EXECUTED / 1 UNVERIFIABLE: eleven IMPLEMENTED rows rest on acceptance criteria (kill runs, bursts, measured demo rates, partial fills, an active reader) whose evidence does not exist in the repository.

The second half of the verdict is about evidence, not code. **No claim in any of the 30 documents is closed by runtime evidence.** Every "runtime" cell in all three reports is a route that exists in source or a log format that is pinned, never a value observed on the deployed system: the bearer token is lost (README "Owner-held preconditions", TM-37), no fault run of any kind exists (no kill-at-boundary, no ENOSPC, no offline executor, no 24 h soak), and the UI audit renders a 162-byte shell on all 42 route×width samples so no geometry number describes a page with data on it. The single highest-consequence state in the whole set — whether `POST /actions/earned-floor` stage 2 (`demoOnly:false`, `riskScale:1.0`) is applied in production, i.e. whether live accounts are admitting sub-3R entries at full risk right now — is readable only with that token. The plan's own completion test ("an implementer, an independent test and a runtime evidence condition") is therefore not met for any requirement, and TM-42 (PLANNED) is the most load-bearing row in the register. The test suites themselves are green and were re-run by the investigators: Node 4067/4067, C++ 30/30 binaries, Vitest 817/817, `check:no-green` OK.

---

## 2. Top-10 NOT EXECUTED / PARTIAL items, ranked by capital at risk

Ranking: can it place, size or fail to protect real money today, and how silently. One UNVERIFIABLE item outranks all ten and is listed first because it is the one thing a single authenticated read would settle.

**0 (UNVERIFIABLE, above the list).** `docs/archive/one-simple-system.md` P5a stage 2. Code defaults are stage 1 (`agent/services/earned-floor.js:42-46` `demoOnly:true, riskScale:0.5, minSample:15, minE:0.15`, confirmed); stage 2 was ordered and applied via `POST /actions/earned-floor` (`agent/routes/actions.js:537-556`) into runtime state. Closes with one `GET /state/earned-floor` once the bearer token is recovered.

| # | Document | Claim | Code gap (confirmed at HEAD unless marked) | What closes it |
|---|---|---|---|---|
| 1 | tm/plan.md §13; register TM-39 | "A halt between the two legs [of `/position-reverse`] must prevent the new leg" | `agent/routes/actions.js:2328` builds creds once; `agent/lib/ctrader-creds.js:32-33,68` snapshots `exec_guard_json`; `exec-engine.js:562-566` validates that snapshot; close `:2352`, open `:2361`. Live hole on the JS transport; C++ re-checks at `engine.cpp:746-762` (not re-checked here) | Re-read `exec_guard_json` (or `validateExecGuard` against a fresh `getState`) immediately before the opening leg, plus a test that flips halt between the legs |
| 2 | tm/plan.md §11; register TM-26 | "Specify and test FULL durability … for financial transitions" | `agent/db.js:978` `db.pragma('synchronous = NORMAL')` under the entry-intent ledger that prevents a blind resend | `synchronous = FULL` (globally or per ledger transaction) with a test pinning the pragma |
| 3 | position-write-authority.md §5 | 14 stop/close writers, one authority table, "no writer consults the arbiter" (declared open) | `agent/services/management-state.js:76` `WRITER_AUTHORITY` read only by `minute-review.js` (a reader); C++ `trail_engine.cpp` amends the same stop from another process | Call the authority check inside the one amend chokepoint both processes share, before the write |
| 4 | one-simple-system.md P1/P3 | "one exit: `trail_1R` … the live rule must match `exit-replay.js` or the evidence stops applying" | `agent/services/managed-exit.js:107` `trailR: 0.5` from entry vs `agent/lib/exit-replay.js:93` `{ name: 'trail_1R', trailR: 1.0 }` | Either replay at 0.5R-from-entry and re-publish the PF, or set the default to the rule that was measured |
| 5 | tm/plan.md §9; register TM-17, B08 | Permit is bound to "actual volume/bracket … the gateway rejects if the quote or bracket falls outside the permit's bounds" | `cpp-exec/src/order_guard.cpp:133-145` compares account/symbol/side/volume only; no price or stop/target fields | Add stop/target/price bounds to the permit contract and compare them in `validatePermit` (P6b prerequisite) |
| 6 | multi-account-migration-plan.md K1/K2 | `effectiveGuards(accountId)` with a tighten-only `min/max(global, account)` merge, 80% soft tier | `agent/services/global-guards.js` default-off object; per-account limits read separately (`5ffdbf4`); a looser per-account limit has nothing above it (not re-checked line-by-line) | One resolver every gate calls, merging tighten-only |
| 7 | tm/plan.md §3/§9; register TM-10 | "Exactly one automatic producer family can acquire a current-epoch grant" | `cpp-exec/src/order_guard.cpp:103-109` — an account with no pushed epoch needs no permit; `agent/services/exec-guard-sync.js:119` `catch { /* no accounts table — no epochs pushed */ }` fails **open** on a DB read error | Fail closed: on the catch push a refuse-all sentinel, or make the sidecar require a permit for every account |
| 8 | agent-graph-audit F-OBS-01 (UI) | `/state/risk-full?account=X` returns the same margin block for every account | `agent/services/cockpit-snapshot.js:85` reads the global `broker_snapshot_cache_json`; `src/pages/Risk.jsx:572` renders margin under an account heading; `GlobalScopeNote` is used at `:608/:1151/:1239` but not on the margin block | Wording: wrap the margin block in `GlobalScopeNote` today; code: scope the snapshot per account later |
| 9 | tm/plan.md §9; register TM-17, B08 | "correlated portfolio capacity … durably reserves capacity before any broker write" | `pendingExposure()` in `agent/services/entry-ledger.js` has no production caller (only its own test) | Call it from `risk.js evaluateTrade`'s margin/correlation check |
| 10 | tm/cpp-parallelism-investigation.md finding 6; B04 | "Have the existing risk authority size and reserve the concrete trade" | Permits bind the feeder's cached minimum-stop volume (`order_guard.cpp:138-144`); a wider actual stop implies more monetary risk than sized | Size from the actual bracket at reservation time and bind that volume |

Just below the cut, in order: `Reset breaker` re-arms with no confirmation (`src/pages/Trade.jsx:691`, confirmed); the owner's `supervised-drain` decision replaced by cancel-on-STOPPED (`agent/services/entry-drain.js`; `account-capabilities.js:184` still describes supervised-drain, confirmed); no control lease (TM-41); consumed-permit set forgotten on sidecar restart (`order_guard.hpp:112-118`); cockpit `Close` with no `onClick` (`TradeCockpit.jsx:313-314`, confirmed); no staging boot guard; `-O2` absent (`cpp-exec/Makefile:6`, confirmed).

---

## 3. Documents that over-claim

| Document | Claim | Reality | Fix |
|---|---|---|---|
| tm/readiness-register.csv | 19 rows IMPLEMENTED | 11 of them rest on acceptance evidence that does not exist (see §4); TM-25's own row ends "Measured demo rates: to be read from /health after deploy" (confirmed) | Wording: restate the 11 as PARTIAL; TM-12 up to PARTIAL |
| tm/README.md header | "defaults to TIME_BASED with tick observation OFF" | `agent/config/tick-observation.json` seeds one demo account to RECORD (owner-approved P3b) | Wording: add "except …" |
| tm/README.md P3b | "measured 24 h events/sec and bytes/day" | A code path (`tick_status_samples`, `/state/tick-recorder`); `storage-capacity.csv` still `SCENARIO_NOT_MEASURED` | Wording: "measurable"; code: check one measurement in |
| tm/plan.md §15 | "never mark source presence as runtime verification" | Several register rows do exactly that | Wording in register |
| outstanding-backlog-2026-07-26.md | "P1–P4, P6–P8 SHIPPED … every audit finding ranked ahead of a decision gate is now closed" | P3(a)'s guard shipped and the 9× 0066.HK duplicate happened anyway (`entry-ledger.js` header); P10 listed both open (gate D2) and shipped; `telegram_log` never built (`telegram_outbox` is a queue); six weeks unrevised | Wording: status column with dates; mark P3(a) "superseded by #881" |
| multi-account-migration-plan.md | "PROPOSAL — awaiting owner `!!`. No application code changes" | R1, R4, C1, C4, M1 columns, `decision_log`, K2 chokepoint halt, L3 (ledger) all shipped; `agent/repo.js` and the lint did not (confirmed absent) | Wording: per-phase status column |
| TRAVEL-HANDOVER.md §5 | "First real C++ fill still unobserved" | `VALIDATION-DAY.md` §6 records it CLOSED 16-07-2026 with a broker position id; §2's single-account world is gone | Wording: mark superseded |
| account-scope-plan.md §7 | Six "independently shippable" milestones, S1 ✅ | Only S1 shipped; S2 scaffolding; `scope_audit` 0 hits, no lint rule (confirmed); ~3 of ~34 components adopted | Wording: status per milestone; code: the register the owner asked for |
| VALIDATION-DAY.md | "No new features until this page is done" | ~19/20 boxes unticked, dozens of releases since; §4 centrepiece is slated "replace" | Wording: mark superseded except §6 |
| one-simple-system.md | "one exit: `trail_1R`", evidence PF 1.82 / +0.380R | Live default `trailR: 0.5` from entry (confirmed); the evidence does not transfer | Code or wording (item 4 above) |
| strategy-target-review-2026-09-02.md | Declared-targets table "transcribed from the strategy modules" | `tsmom_long` absent; the 09-09 cluster rule moved the arming posture; "Open" columns unfilled nine days on | Wording: add the row, fill or date the open item |
| multi-account-exit-routing-2026-07-30.md | "FIXED IN NODE … The C++ half is still to come" | C++ half shipped: `cpp-exec/src/engine.cpp:672-676` replaces `withAccountId()`, `guard_no_account` at `:836/:861/:866` (confirmed). Over-claims *absence* of a protection | Wording: status line |
| ui-wiring-audit.md header | "passes 1–6 complete. Pass 6's proposed scale awaits sign-off" | The scale was superseded by the type canon; M-3/M-4 closed; W-1 still open (confirmed: cockpit `Manage`/`Close` have no `onClick`) | Wording: name the successor |
| ui-audit-2026-07-30.md §1–§2 | Sidebar footer / `TabsPanel.jsx` | Both deleted by the same document's §5/§6 | Wording: strike or mark |
| ui-control-inventory.md | Findings register (no status claim) | ~40% out of date, no revision marker; 7 confirmations, `veto`, `Test fill`, focus rule, cockpit trap all changed since | Wording: revision marker |
| **ui-m3-migration-plan.md** Phase F | Audit C: "theme `aria-pressed` listed as delivered; absent from `TradeCockpit.jsx:317`" | **Refuted at HEAD** — `src/cockpit/TradeCockpit.jsx:317` reads `aria-pressed={themeOverride != null}`. The document does not over-claim this. Its verification log ("vitest 395/395", last entry 2026-08-01, now 817/817) is the only stale part | Wording: append to the log; audit C's #6 and its over-claim #1 should be struck |

Not over-claiming, and worth holding up as the standard: `go-live-plan.md`, `d4-loop-block-fix-plan.md`, `position-write-authority.md`, `prior-cohort-watch.md`, `cockpit-data-endpoint-spec.md` §4, `order-flow-plan.md`, `ui-spec.md`, `ui-m3-compact-contract.md`, `pnl-veto-investigation-2026-07-30.md`, `safe-implementation-first-response-2026-07-30.md`, `agent-graph-audit-2026-08-03.md`, `tm/README.md` (apart from the two lines above).

---

## 4. Readiness-register corrections (`docs/tick-momentum/readiness-register.csv`, 42 rows)

Filed (parsed with a CSV reader): 19 IMPLEMENTED / 9 PARTIAL / 14 PLANNED — audit A's prose says 20/8/14; its row table and the file agree on 19/9/14. Audited: 8 EXECUTED / 21 PARTIAL / 12 NOT EXECUTED / 1 UNVERIFIABLE — audit A's prose says 9/19/13/1; its own row table sums to 8/21/12/1, which is what is used here. "Check" = this synthesis re-read the cited code or register text at HEAD (✔ confirmed, ✘ refuted, — copied from A without re-checking).

| TM | Filed | Audited | Reason | Check |
|---|---|---|---|---|
| 01 | IMPLEMENTED | EXECUTED | tests pin no candle/LLM import; process-level run absent | — |
| 02 | PARTIAL | PARTIAL | broker ts never requested, `recvMs` wall clock, `quality.stale` not computed | ✔ (`spot_feed.*` 0 hits; `tick_recorder.hpp:76`) |
| 03 | IMPLEMENTED | EXECUTED | own note admits N/M windows are rescanned; efficiency only | ✔ (register text) |
| 04 | IMPLEMENTED | PARTIAL | acceptance "across restarts" — no restart test for setup state | — |
| 05 | IMPLEMENTED | PARTIAL | live exits via keeper paths unbuilt; row covers replay only | — |
| 06 | IMPLEMENTED | EXECUTED | | — |
| 07 | IMPLEMENTED | EXECUTED | | — |
| 08 | PLANNED | NOT EXECUTED | | — |
| 09 | PLANNED | NOT EXECUTED | | — |
| 10 | IMPLEMENTED | PARTIAL | unfenced account needs no permit; epoch push fails open on DB error | ✔ (`order_guard.cpp:103-109`; `exec-guard-sync.js:119`) |
| 11 | IMPLEMENTED | PARTIAL | acceptance wants dynamic per-producer tests; a regex pin + one case exist | — |
| 12 | PLANNED | PARTIAL (under-claims) | `test_engine_send_boundary.cpp` exists; B06 resolved | ✔ (file present) |
| 13 | IMPLEMENTED | PARTIAL | "kill at every boundary" — no fault run; sidecar journal in-memory | ✔ (register text) |
| 14 | IMPLEMENTED | EXECUTED | | — |
| 15 | PLANNED | NOT EXECUTED | | — |
| 16 | IMPLEMENTED | EXECUTED | autopilot/tuner untested | — |
| 17 | PARTIAL | PARTIAL | `pendingExposure` has no production consumer | ✔ (grep) |
| 18 | PLANNED | NOT EXECUTED | | — |
| 19 | IMPLEMENTED | PARTIAL | acceptance "global-off/account-pin-on matrix" (B12); `watchlists.js` untouched | ✔ acceptance text; watchlists not re-checked |
| 20 | IMPLEMENTED | EXECUTED | | — |
| 21 | PARTIAL | PARTIAL | no total-bytes assertion, no 128-key cap | — |
| 22 | PARTIAL | PARTIAL | events pinned, not signals | — |
| 23 | IMPLEMENTED | PARTIAL | acceptance "10x bursts … exits remain responsive" — neither exercised | ✔ acceptance text |
| 24 | IMPLEMENTED | EXECUTED | | — |
| 25 | IMPLEMENTED | PARTIAL | row's own last sentence: measured demo rates not yet read | ✔ (register text) |
| 26 | PLANNED | NOT EXECUTED | `synchronous = NORMAL` | ✔ (`db.js:978`) |
| 27 | PARTIAL | PARTIAL | one measurement; live side has no destination | — |
| 28 | IMPLEMENTED | PARTIAL | acceptance "all temp/compression/retry files counted"; row: "none exist yet" | ✔ (register text) |
| 29 | PLANNED | NOT EXECUTED | no archive | — |
| 30 | PLANNED | NOT EXECUTED | `SPACE_HEADROOM = 1.15` | ✔ (`db-compact.js:70`) |
| 31 | IMPLEMENTED | PARTIAL | acceptance "active reader" test; no in-use guard on retirement | — |
| 32 | PARTIAL | PARTIAL | 2 of 13 §13 surfaces | ✔ (`Tune.jsx` has no `EngineStatusPanel`; `src/` has no `Tick ·` label) |
| 33 | PARTIAL | PARTIAL | offline-executor case untested | — |
| 34 | IMPLEMENTED | PARTIAL | row: partials/margin/volume steps "not modelled"; test block never run | ✔ (register text) |
| 35 | PARTIAL | PARTIAL | i.i.d. bootstrap, closed-equity drawdown | — |
| 36 | PLANNED | NOT EXECUTED | | — |
| 37 | PLANNED | UNVERIFIABLE | lost bearer token | — |
| 38 | PLANNED | NOT EXECUTED | | — |
| 39 | PARTIAL | PARTIAL (under-claims) | halt-between-legs is a live snapshot hole on the JS path, not a missing convenience check | ✔ (item 1 above) |
| 40 | PLANNED | NOT EXECUTED | | — |
| 41 | PLANNED | NOT EXECUTED | | — |
| 42 | PLANNED | NOT EXECUTED | no row carries runtime evidence | — |

---

## 5. Per-document tables, condensed (every row kept; notes shortened)

Columns: Sec = the investigator's subsection; Where = the code/component cell as cited (line numbers as the investigator gave them, at the `2a3b5ff` tree = HEAD tree); Verdict = first token of the investigator's verdict. Ellipses mark truncation, not omission of rows.

### 5.A Group A

**tm/plan.md — §1–§17**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
| §1 | "Every authorized account can be configured for TIME_BASED, T… | agent/lib/entry-contracts.js:27; agent/services… | PARTIAL | TICK_MOMENTUM is refused outright at entry-mode.js:102-104 (tick_engine_not_b… |
| §1 | "tick trading should be available to all accounts but initial… | entry-contracts.js:307-317 defaultEngineStatus… | EXECUTED | A read never writes (entry-mode.js:68-79). |
| §1 | "Existing time-mode configuration is retained for switching b… | — | NOT EXECUTED | requestEntryMode (entry-mode.js:95-149) never saves or restores a time profil… |
| §1 | "No investigation can establish that every production setting… | — | UNVERIFIABLE | By construction; see §17. |
| §2 | requested_entry_mode / effective_entry_mode ("never inferred… | entry-contracts.js:256-257; entry-mode.js:133 (… | EXECUTED |  |
| §2 | transition_state (5 values) | entry-contracts.js:28; entry-mode.js:127-129 | EXECUTED |  |
| §2 | tick_observation OFF/RECORD/SHADOW, "can run while time entri… | entry-mode.js:217-235 | EXECUTED |  |
| §2 | validation_stage 5 stages | entry-contracts.js:30; tick-validation.js:120-2… | EXECUTED |  |
| §2 | config_revision, mode_epoch monotonic, reject stale | entry-mode.js:99-101,135-136 | EXECUTED |  |
| §2 | profile_id, profile_hash | entry-contracts.js:264-265; tick-validation.js:… | EXECUTED |  |
| §2 | environment, account_id, risk_group_id "immutable" | entry-contracts.js:253-255 | PARTIAL |  |
| §2 | readiness, blocked_reasons with source/observed/timestamp/rem… | entry-contracts.js:242-250; tick-readiness.js:3… | EXECUTED |  |
| §2 | fence_ack_epoch, separate unsent / in-flight / resting / unkn… | entry-contracts.js:263,267-272; entry-mode.js:1… | EXECUTED |  |
| §2 | "Shadow uses its own simulated portfolio" | cpp-exec/src/tick_shadow.cpp (175 ln), .hpp (13… | EXECUTED |  |
| §2 | "Live and demo capacity never subtract from each other" | side split cpp_exec / cpp_exec_demo (tick-shado… | PARTIAL |  |
| §2 | "Future accounts are discovered dynamically and start with ti… | tick-readiness.js:114-124 iterates accounts; en… | EXECUTED |  |
| §3 | "An account mode command includes its expected configuration… | entry-mode.js:99-101 | EXECUTED | EXECUTED |
| §3 | Step 1 "Fence the old entry epoch at the execution gateway …… | entry-mode.js:111 releaseOldEpoch; exec-guard-s… | EXECUTED | EXECUTED |
| §3 | Step 2 "Classify requests already written to the broker as in… | entry-ledger.js:272 intentCounts; entry-mode.js… | EXECUTED | EXECUTED |
| §3 | Step 3 "Cancel account-owned resting entry orders… Identify t… | agent/services/entry-drain.js (172 ln) | EXECUTED | EXECUTED |
| §3 | Step 4 "An unknown order outcome prevents activation of the n… | entry-mode.js:112,128; admitEntry refusal entry… | EXECUTED | EXECUTED |
| §3 | Step 5 "for tick mode, verify its profile, feed, warm-up, val… | tick-readiness.js:39-111 computes it | PARTIAL | PARTIAL — the readiness view exists but nothing consumes it as an activation… |
| §3 | Step 5 "for time mode, restore the saved time configuration" | — | NOT EXECUTED | NOT EXECUTED |
| §3 | Step 6 "Activate the new epoch at the gateway and report its… | entry-mode.js:161-188 acknowledgeEntryEpochs, :… | EXECUTED | EXECUTED |
| §3 | "Stop entries retains existing positions, broker stops, exits… | admitEntry only gates new entries (entry-mode.j… | PARTIAL | PARTIAL — true by construction; no test drives an exit while STOPPED. |
| §3 | "A manual new-order command is labelled MANUAL … never a hidd… | entry-mode.js:316 (manual families pass); entry… | EXECUTED | EXECUTED |
| §3 | "The existing account-wide emergency halt also blocks manual… | exec-engine.js:562-566 validateExecGuard | PARTIAL | PARTIAL — the guard is a snapshot read once at creds-build time (agent/lib/ct… |
| §3 | "Mode exclusivity covers every automatic producer, including… | entry-producers.js:29-107 lists 7 automatic pro… | PARTIAL | deps.autoTrade. agent/services/strategy-autopilot.js and adaptive-breaker.js… |
| §3 | "An all-accounts command returns individual account states an… | src/components/EngineStatusPanel.jsx (one POST… | PARTIAL | PARTIAL — register TM-33's own note: "Not yet exercised against an executor t… |
| §3 | "an unreachable gateway must cease entries on lease expiry" | — | NOT EXECUTED | NOT EXECUTED — no control lease anywhere (grep lease in order_guard.hpp/engin… |
| §4 | "Add a separate pure TickStrategy::onQuote(QuoteEvent, TickSt… | cpp-exec/src/tick_strategy.hpp (119 ln) / .cpp… | EXECUTED |  |
| §4 | "Reuse order transport and risk policy after correcting their… | VPO generation fence added (#888); tick path ha… | PARTIAL |  |
| §4 | Quote event carries environment, broker/feed identity, entitl… | entry-contracts.js:110-143 (contract); cpp-exec… | PARTIAL |  |
| §4 | "Use fixed-width encoding and checked conversions" | tick_recorder.hpp:22-27 explicit little-endian… | EXECUTED |  |
| §4 | "cTrader's first spot message can be a snapshot… it must warm… | tick_recorder.hpp:186 snapshotPending; tick_str… | EXECUTED |  |
| §4 | "reject entry calculations when either side is missing, stale… | tick_strategy.cpp:112-122 | PARTIAL |  |
| §4 | "A disconnect or local queue loss invalidates continuity, sta… | tick_workers.cpp gapBefore → folded to snapshot… | EXECUTED |  |
| §4 | "Track spread changes separately… These are quote ticks, not… | no volume inference anywhere in tick_strategy.* | EXECUTED |  |
| §5 | H/L over prior N with the candidate excluded; D over M; E = | D | EXECUTED | EXECUTED |
| §5 | "Maintain rolling statistics incrementally, without rescannin… | — | NOT EXECUTED | on every event". Efficiency, not correctness. |
| §5 | "Represent midpoint as twice-mid in integer wire units" | tick-strategy.js:10-13; C++ mirrors | EXECUTED |  |
| §5 | State machine WARMING → ARMED → CONFIRMING → SIGNALLED/EXPIRE… | tick_strategy.cpp:57-61,150-180 | EXECUTED |  |
| §5 | "Use a conservative round-trip cost estimate… Require suffici… | cost screen exists only in the simulator/shadow… | PARTIAL |  |
| §5 | "Confirm the estimate again using the actual account volume…… | none on the tick path | NOT EXECUTED | riskBudget → 0 hits); the only tick-side money figure is minStopPrice (tick_s… |
| §5 | "One account's rejection must not create an endless retry loo… | entry-contracts.js:151 signalId field | PARTIAL |  |
| §6 | The 10-row parameter table as an initial envelope | agent/lib/tick-strategy.js:24-37 DEFAULT_PARAMS… | EXECUTED |  |
| §6 | "Do not run the Cartesian product. First test the 12 combinat… | scripts/tick-research.mjs:58-59 — exactly [128,… | EXECUTED |  |
| §6 | "Then test a predeclared small set of local changes to the tr… | — | NOT EXECUTED | predeclared over scripts/tick-research.mjs → 0 hits. README lists it as a sti… |
| §6 | "Record every trial, including failures and abandoned variant… | tick_trials table (agent/db.js:645-659), POST /… | EXECUTED |  |
| §6 | "Quote age, side skew, signal TTL, absolute spread ceiling, m… | maxQuoteAgeMs, maxSpread in DEFAULT_PARAMS (tic… | PARTIAL |  |
| §7 | "Build a deterministic event replayer using the same strategy… | agent/lib/tick-replay-sim.js (195 ln); oracle a… | EXECUTED |  |
| §7 | "Store exact data manifests, decoder version, normalization r… | tick_trials.manifest_json/sim_json/params_json… | PARTIAL |  |
| §7 | "buy at the next eligible ask and sell at the next eligible b… | tick-replay-sim.js (fills, latency p90, slippag… | PARTIAL |  |
| §7 | "Use chronological train/validation/test blocks… Purge observ… | tick-replay-sim.js purge both ways + embargo, w… | EXECUTED |  |
| §7 | "Mark-to-market equity in regular clock-time intervals for Sh… | — | NOT EXECUTED |  |
| §7 | "Copies of the same signal across accounts are correlated exp… | tick-shadow.js:129-147 projects one R-series on… | EXECUTED |  |
| §7 | "Research acceptance requires positive net out-of-sample expe… | bootstrap 5th percentile tick-shadow.js:42-54 | PARTIAL |  |
| §7 | "Use an appropriate multiple-testing adjustment and inspect b… | — | NOT EXECUTED |  |
| §8 | "One asynchronous broker-session owner per environment… with… | cpp-exec/src/engine.*, ws_client.* reader/write… | EXECUTED |  |
| §8 | "Assign each key to one worker, so its sequence and strategy… | cpp-exec/src/tick_workers.cpp (93 ln), shard =… | EXECUTED |  |
| §8 | "Use a feed key containing environment, broker/entitlement an… | segment header carries feedId/environment/gener… | PARTIAL |  |
| §8 | "If a symbol's queue overflows, invalidate its generation and… | tick_workers.cpp drop + gapBefore; tick_strateg… | EXECUTED |  |
| §8 | "A hot symbol must not starve the other shards indefinitely:… | — | NOT EXECUTED | starv over tick_workers.* → 0 hits. README lists it open. |
| §8 | "Preserve the order of each symbol's signals across worker co… | — | NOT EXECUTED |  |
| §8 | "benchmark one/two/four workers under the actual cgroup quota… | — | UNVERIFIABLE |  |
| §8 | "Measure feed-to-decision, decision-to-admission, queue-to-wr… | — | NOT EXECUTED |  |
| §9 | "Route all automatic entry producers and manual orders throug… | entry-ledger.js:147 reserveEntry; exec-engine.j… | PARTIAL | PARTIAL — one path is outside it by design: producersOutsideExecEngine() ===… |
| §9 | "Its transaction validates… existing exposure, correlated por… | reserveEntry validates epoch + one-open-intent-… | PARTIAL | PARTIAL — margin/correlation stay in risk.js evaluateTrade, and pendingExposu… |
| §9 | "Return a one-use execution permit bound to intent ID, accoun… | entry-contracts.js:205-236; issued entry-ledger… | PARTIAL | PARTIAL — the sidecar check (order_guard.cpp:133-145) binds account, symbol,… |
| §9 | "The gateway rejects and requests re-admission if the current… | — | NOT EXECUTED | NOT EXECUTED — no price/bracket bounds in validatePermit (order_guard.cpp:95-… |
| §9 | "gateway redemption atomically moves RESERVED → DISPATCHING o… | entry-ledger.js:187 redeemPermit (changes()===1) | EXECUTED | EXECUTED |
| §9 | "A consumed permit… is never replayed as a fresh send authori… | order_guard.cpp:146-151 consumed set | PARTIAL | PARTIAL — the set is per-process and bounded (order_guard.hpp:112-118); a sid… |
| §9 | "A cached VPO volume or a boolean HTTP 'approved' response is… | order_guard.cpp:109 comment + entry-ledger.js:6… | EXECUTED | EXECUTED |
| §9 | Lifecycle "proposed, reserved, queued, submitted, accepted, p… | entry-ledger.js:41 INTENT_STATES | PARTIAL | PARTIAL — PARTIAL and CANCELLED are absent from INTENT_STATES (they exist onl… |
| §9 | "A restarted owner restores unresolved intents before accepti… | UNKNOWN survives reopen (entry-ledger.js:19-24) | EXECUTED | EXECUTED (Node side only; sidecar journal is an in-memory 512-slot ring — TM-… |
| §9 | "Gateways use a local monotonic control-lease deadline… Resta… | — | NOT EXECUTED | NOT EXECUTED (TM-41 PLANNED) |
| §9 | "a durable outbox" for the sidecar | — | NOT EXECUTED | NOT EXECUTED — README names it open. |
| §9 | "50 non-historical requests/second/connection and 5 historica… | cpp-exec/src/request_pacer.* (40/s, 25% protect… | EXECUTED | EXECUTED in code; measured demo rates NOT observed ("Measured demo rates: to… |
| §9 | "heartbeats every 10 seconds" | 9 s bound, feed slice 5 s → 1 s (#888) | EXECUTED | EXECUTED |
| §10 | "Treat each 10GB Railway volume as an independent, finite fil… | GET /tick-status reports statvfs per spool path | PARTIAL | PARTIAL — measured once (register TM-27: cpp-exec demo has a 50 GB volume at… |
| §10 | Three storage layers (in-memory history / bounded local spool… | layers 1-2: tick_recorder.*, tick_workers.* | PARTIAL | upload over agent/services + tick_recorder.cpp → 0 hits. TM-29 PLANNED. |
| §10 | "Keep raw ticks outside the operational SQLite database. Do n… | spool is on the sidecar volume; DB gets hourly… | EXECUTED | EXECUTED |
| §10 | Budget table: 4,096 records/symbol; 128 keys max; 128 MiB tic… | recorder queue is a 262,144 × 40 B ≈ 10 MiB SPS… | PARTIAL | interval in tick_recorder.cpp → 0 hits); no 128-key symbol cap; no 128 MiB to… |
| §10 | "Require availableBytes - reservedPendingWrites - nextWriteBy… | tick_recorder.cpp (probe ≤ every 2 s, charged f… | EXECUTED | EXECUTED |
| §10 | "a recorder gap blocks new tick entries, with existing-positi… | — | NOT EXECUTED | NOT EXECUTED — TM-40 PLANNED; there is no tick entry path to block. tick-read… |
| §10 | "An operational intent journal failure blocks all new risk" | — | NOT EXECUTED | NOT EXECUTED — no journal-health veto found. |
| §11 | "Use bounded drain batches, pre-write rotation accounting and… | cpp-exec/src/telemetry.cpp:35-53 | PARTIAL |  |
| §11 | "The previously reproduced multi-producer/SPSC loss also need… | telemetry.cpp:18 | EXECUTED |  |
| §11 | "Tick recording and durable order journaling must have separa… | tick_recorder.* vs event_journal.* | EXECUTED |  |
| §11 | "Move new recorder files to a directory it cannot touch… Neve… | spool on sidecar volume; agent/services/emergen… | EXECUTED |  |
| §11 | "The current compaction guard allows 1.15× DB size in free sp… | agent/services/db-compact.js:70 — export const… | NOT EXECUTED |  |
| §11 | "update to a tested dependency containing a fixed runtime and… | — | NOT EXECUTED | sqlite_source_id → 0 hits. |
| §11 | "Specify and test FULL durability or an equivalent durable jo… | agent/db.js:978 — db.pragma('synchronous = NORM… | NOT EXECUTED |  |
| §12 | B01 selected-account VPO credentials + mutable dispatcher acc… | PARTIAL | PARTIAL | Permits are now per-account and epoch-bound (entry-ledger.js:65 reserveVpoPer… |
| §12 | B02 quote callback lacks timestamps/freshness/generation | PARTIAL | PARTIAL | SpotRawTap now carries per-side presence + generation (spot_feed.hpp:36-39);… |
| §12 | B03 VPO trigger/rearm/mutable pointers | EXECUTED | EXECUTED | Generation-fenced storeBracket/tryFire (#888); test_vpo_dispatcher.cpp, test_… |
| §12 | B04 VPO cached sizing uses minimum stop | PARTIAL | PARTIAL | Permits bind the sized volume, so a mismatched volume is refused at the send… |
| §12 | B05 Autotrade-Off guard sync, halt compared by count | EXECUTED | EXECUTED | exec-guard-sync.js:88-101 compares haltAccounts by identity; guardDiffers at… |
| §12 | B06 C++ guard validated before the socket mutex | EXECUTED | EXECUTED | engine.cpp:746-779 — the fence recheck and the physical send share the bounda… |
| §12 | B07 blocking request loop, discarded unsolicited events | EXECUTED | EXECUTED | test_async_session.cpp (out-of-order, late, duplicate, id-less, partial-then-… |
| §12 | B08 risk checks precede async work; no atomic cross-symbol re… | PARTIAL | PARTIAL | One-key duplicate/final-slot race is durable; cross-symbol margin/correlation… |
| §12 | B09 60 s dispatch lock + 20 min dedupe suppress later tick se… | NOT EXECUTED | NOT EXECUTED | agent/lib/submission-dedupe.js unchanged; no durable event identity + separat… |
| §12 | B10 registry/stage matrix/bar backtests lack tick basis | PARTIAL | PARTIAL | basis is in the intent contract and the ledger (db.js:593) and the horizon ru… |
| §12 | B11 unknown timeframe bypasses horizon classification | EXECUTED | EXECUTED | account-horizon.js horizonAdmits({basis}); unknown basis refused *before* the… |
| §12 | B12 symbol picks intersect global enabled strategies | NOT EXECUTED | NOT EXECUTED | agent/services/watchlists.js unchanged; no global-off/account-on test. |
| §12 | B13 boot pins/autopilot/account selection can revive | EXECUTED | EXECUTED | entry-mode.test.js "STOPPED survives initDB reopen, ensureAccountRegistry, se… |
| §12 | B14 closed-market limit placement precedes evidence gate | NOT EXECUTED | NOT EXECUTED | entry-producers.js:55 still carries the note "plan B14: placement precedes th… |
| §12 | B15 pins / tsmom_long exception admit without tick evidence | EXECUTED | EXECUTED | tick-validation.js never reads pins or the evidence gate (source pin in tick-… |
| §12 | B16 trailing multiple writers, SL-only TP ambiguity | NOT EXECUTED | NOT EXECUTED | TM-15 PLANNED and honest: P1a scoped the TP-preservation contract out. trail_… |
| §12 | B17 telemetry race, unchecked I/O, soft rotation, unsafe clea… | PARTIAL | PARTIAL | See §11. |
| §12 | B18 volumes/UID/CPU quotas/deployed SQLite unknown | PARTIAL/UNVERIFIABLE | PARTIAL | One measurement recorded (TM-27); cgroup quota, UID, deployed SQLite version,… |
| §12 | "Build a read-only per-account readiness endpoint with every… | EXECUTED | EXECUTED | tick-readiness.js:39-111 (18 checks, all 5 classes at :107); tick-readiness.t… |
| §13 | "Inventory all automatic producers… Every route must reject s… | entry-producers.js:29-107; exec-engine.js:825-8… | EXECUTED |  |
| §13 | "The manual /position-double and the opening leg of /position… | agent/routes/actions.js:2257, :2328 credsForPos… | EXECUTED |  |
| §13 | "A halt between the two legs must prevent the new leg" | actions.js:2328 builds creds once; close at :23… | NOT EXECUTED |  |
| §13 | "Add database columns/contracts for signal_basis, strategy im… | entry_intents has basis, mode_epoch, signal_ref… | PARTIAL |  |
| §13 | "Use one server-derived engine status component with revision… | src/lib/use-engine-status.js:32 (one store over… | EXECUTED |  |
| §13 | Shared account header / all pages | identity, requested/effective engine, warming/s… | PARTIAL |  |
| §13 | Accounts | all discovered accounts, per-account and bulk a… | PARTIAL |  |
| §13 | Tune → Pipeline | start/stop, exclusive selector, transition ack,… | NOT EXECUTED |  |
| §13 | Tune → Strategy / replay | tick parameters + profile hash, immutable run e… | NOT EXECUTED |  |
| §13 | Tune → Watchlists | per-account tick eligibility, feed/symbol mappi… | NOT EXECUTED |  |
| §13 | Desk | tick candidates, range/momentum/efficiency, quo… | NOT EXECUTED |  |
| §13 | Trade | Tick · N=256/M=64 basis label, trigger/decision… | NOT EXECUTED |  |
| §13 | Accounts → Workspace | mode/config changes, actor, revisions, acks, ar… | NOT EXECUTED |  |
| §13 | Accounts → Workflow audit | quote → feature → signal → proposal → reservati… | NOT EXECUTED |  |
| §13 | Risk | current/reserved exposure per account & risk gr… | NOT EXECUTED |  |
| §13 | Performance | separate tick/time/manual and shadow/demo/live,… | NOT EXECUTED |  |
| §13 | Connect / engineering | service/commit/host/account roster, protocol su… | NOT EXECUTED |  |
| §13 | Vocabulary rule: render Entries stopped; 3 positions managed,… | engine-status-view.js label set | PARTIAL |  |
| §14 | P0 Baseline and contracts | "All known entry producers mapped; unknown runt… | PARTIAL |  |
| §14 | P1 Correctness and control | "Stop/switch crash matrix, producer closure, no… | PARTIAL |  |
| §14 | P2 Session and reservation boundary | "Accepted/partial/unknown recovery, final-slot… | PARTIAL |  |
| §14 | P3 Tick feed, buffers and archive | "Ordered 1/2/4-worker replay, bounded 24 h soak… | PARTIAL |  |
| §14 | P4 Strategy and research | "No-lookahead fixtures, costs/latency accountin… | EXECUTED |  |
| §14 | P5 Account integration and UI | "Selected/nonselected and live/demo account mat… | PARTIAL |  |
| §14 | P6 Shadow and demo | "Zero tick broker orders in shadow; measured de… | PARTIAL |  |
| §14 | P7 Live rollout and rollback | independent release audit, rollback | NOT EXECUTED |  |
| §14 | "Deployable artifacts default the new feature off at every st… | TICK_SPOOL_PATH unset by the change; observatio… | EXECUTED |  |
| §14 | "Follow existing repository checks… backend Node tests, ESLin… | .github/workflows/ci.yml:26, cpp-exec.yml:22 (m… | PARTIAL |  |
| §16 | "Tick signals execute with candle fetch and LLM services disa… | PARTIAL | PARTIAL | tick_strategy.* and tick-strategy.js import no candle/LLM module; nothing run… |
| §16 | "identical per-symbol normalized events, features, signals an… | PARTIAL | PARTIAL | events only (test_tick_workers.cpp); TM-22 downgraded for this. |
| §16 | "Competing symbols/accounts cannot exceed final position, ris… | NOT EXECUTED | NOT EXECUTED | one-key race only. |
| §16 | "All automatic entry producers reject the wrong basis or stal… | EXECUTED | EXECUTED | entry-mode.test.js, test_permit_check.cpp, exec-fallback.test.js. |
| §16 | "Every broker lifecycle case… No blind resend" | EXECUTED | EXECUTED | test_async_session.cpp; entry-ledger.js:250-257. |
| §16 | "Existing positions retain correct protection and TP through… | NOT EXECUTED | NOT EXECUTED | TM-15 PLANNED; B16 open. |
| §16 | "Storage soak for at least 24 hours at 20×100 events/s with 1… | NOT EXECUTED | NOT EXECUTED | TM-36 PLANNED. |
| §16 | "Archive recovery matches sequence/checksum manifests" | NOT EXECUTED | NOT EXECUTED | no archive. |
| §16 | "Restart, account selection, boot seeds, old UI requests, aut… | PARTIAL | PARTIAL | entry-mode.test.js covers restart/seed/selection; autopilot and failover unte… |
| §16 | "Every UI route is exercised with [8 fixture states]" | NOT EXECUTED | NOT EXECUTED | no browser matrix. |
| §16 | "Quant evidence uses actual bid/ask economics, predeclared tr… | PARTIAL | PARTIAL | economics and chronological blocks yes; predeclared trials and held-out run:… |
| §16 | "sub-50 ms p99 receive-to-local-admission" | UNVERIFIABLE | UNVERIFIABLE | no latency instrumentation, no measurement. |

**tm/cpp-parallelism-investigation.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
| Numbered | 1 | "A broker round trip occupies the global execut… | EXECUTED | EXECUTED |
| Numbered | 2 | "VPO can re-arm while a submission is unresolve… | EXECUTED | EXECUTED |
| Numbered | 3 | "Telemetry has multiple possible producers but… | EXECUTED | EXECUTED |
| Numbered | 4 | "A queued order can pass an old halt check. Rec… | EXECUTED | EXECUTED |
| Numbered | 5 | "C++ keepalive and rate control… heartbeat dead… | EXECUTED | EXECUTED |
| Numbered | 6 | "VPO sizing and account ownership… Replace [que… | PARTIAL | PARTIAL — the permit is not the full immutable intent (no actual bracket, no… |
| Numbered | 7 | "The Node duplicate lock is local and temporary… | EXECUTED | EXECUTED for the ledger; the 60 s in-memory map (exec-engine.js dispatch iden… |
| Numbered | 8 | "Trailing needs one protection-state owner… Tra… | NOT EXECUTED | NOT EXECUTED — TM-15 PLANNED; B16 open. |
| Numbered | 9 | "The Makefile has no release optimisation flag;… | NOT EXECUTED | NOT EXECUTED — no -O2; grep shows no symbol index on the VPO/trail tick loops… |
| cTrader constrain… | 50/s non-historical, 5/s historical; start at 40/4 | EXECUTED (code) / UNVERIFIABLE (measured) | EXECUTED | request_pacer.*, /health pacer; no measured demo rate |
| cTrader constrain… | "Best practice: at most two connections… Consolidate sessions" | PARTIAL | PARTIAL | one session owner per environment (engine.*), but the spot feed is still a se… |
| cTrader constrain… | Keepalive 8–9 s with short receive waits | EXECUTED | EXECUTED | test_spot_feed_heartbeat.cpp |
| cTrader constrain… | retryAfter preserved, request class deferred, never retried e… | EXECUTED | EXECUTED | engine.cpp:490-497; protection never deferred |
| cTrader constrain… | CONCURRENT_MODIFICATION → sequence mutations of the same posi… | NOT EXECUTED | NOT EXECUTED | no per-position sequencer found |
| cTrader constrain… | "Node history limiter… token bucket permits an initial burst…… | EXECUTED on the C++ side only | EXECUTED | EXEC_RATE_BURST=8 (main.cpp:468) + test_a_full_second_is_paced_not_burst; age… |
| cTrader constrain… | "protocol release 91 … Treat those messages as unavailable" | N/A (advice, not a requirement) | N/A | no PnL-subscribe code added |
| cTrader constrain… | FIX as a later experiment | N/A | N/A | none attempted |
| Architecture | "Apply that pattern once per environment, not once per symbol… | EXECUTED | EXECUTED | one engine + N tick workers |
| Architecture | "All C++ VPO fires must pass through [Node], or consume an ex… | EXECUTED | EXECUTED | reserveVpoPermits + validatePermit; permit_waived removed |
| Architecture | "OrderIntent should carry at least (environment, account, sym… | PARTIAL | PARTIAL | entry_intents (db.js:580-609) carries environment, account, symbol, side, SL/… |
| Architecture | "lifecycle should distinguish candidate → reserved → queued →… | PARTIAL | PARTIAL |  |
| Architecture | "schedule urgent closes and protective actions ahead of entri… | EXECUTED | EXECUTED | 25% protection reserve; entries/reads refused before a write, protection neve… |
| Architecture | "Add fairness so sustained entry traffic cannot starve reconc… | NOT EXECUTED | NOT EXECUTED | no fairness policy in the pacer |
| Architecture | "Coalesce unsent SL updates to the strongest valid tightening… | NOT EXECUTED | NOT EXECUTED | trail engine unchanged |
| Architecture | "measure a single execution replica per environment at 2 and… | UNVERIFIABLE | UNVERIFIABLE | needs Railway |
| Architecture | "PEER_URL is a liveness probe, not a leader election or fenci… | NOT EXECUTED | NOT EXECUTED | peer_probe.* unchanged; no lease |
| Architecture | "Use joined worker lifetimes and a drainable shutdown… Before… | PARTIAL | PARTIAL | Node restores UNKNOWN intents; no drainable shutdown sequence found in main.c… |
| Architecture | "Health must read cached status without acquiring an RPC-dura… | EXECUTED | EXECUTED | main.cpp:384-388 comment + connectMtx split |
| Architecture | "Record end-to-end timestamps: source event, received, comput… | NOT EXECUTED | NOT EXECUTED | no such instrumentation |
| Architecture | Implementation sequence rows 1–6 | 1 EXECUTED (minus the TP contract and queue-wai… | EXECUTED |  |
| Architecture | "Suggested initial test values: two compute workers, up to ei… | EXECUTED | EXECUTED | TICK_WORKERS=2, EXEC_MAX_IN_FLIGHT=8, 40/s (main.cpp:468-471) |
| Architecture | Engineering gates: "zero duplicate intents/fills attributable… | PARTIAL | PARTIAL | first two have tests; no stress test for oversubscription, no protection-race… |

**tm/README.md — phase map claims**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | Header | "no tick order can be placed by this repository" | EXECUTED |  |
|  | Header | "defaults to TIME_BASED with tick observation O… | PARTIAL |  |
|  | P1a | four sidecar defects + honest audit corrections | EXECUTED |  |
|  | P0 | contracts as code, producer inventory pinned, r… | EXECUTED |  |
|  | P1b | admitEntry at every Node producer, re-checked i… | EXECUTED |  |
|  | P1c | drain by stored broker id, QUIESCING→RECONCILIN… | EXECUTED |  |
|  | P2a-1/2 | durable ledger, epoch-fenced permit, VPO pre-is… | EXECUTED |  |
|  | P2b-1 | event journal + pacer | PARTIAL |  |
|  | P2b-2 | async session under TSan | EXECUTED |  |
|  | P3a | bounded recorder, 2 GiB spool, reserve, torn ta… | EXECUTED |  |
|  | P3b | recording on for one demo account; symbol worke… | PARTIAL |  |
|  | P4 | strategy + oracle agreeing on the fixture; repl… | EXECUTED |  |
|  | Drift (C++) #888 | eight named fixes + register corrections | EXECUTED |  |
|  | Drift (Node) #889 | eight named fixes | EXECUTED |  |
|  | P5 | readiness endpoint, validation importer, shadow… | PARTIAL |  |
|  | P6a | shadow's own portfolio, keeper pull, R judging,… | EXECUTED |  |
|  | P6b/P6c/P6d/P7 | "planned" | NOT EXECUTED |  |
|  | Owner-held preconditions | bearer token lost gates every preflight read | UNVERIFIABLE |  |

### 5.B Group B

**go-live-plan.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | D-1 "the gate is profit factor"; goal-tracker.js carries gate… | agent/services/goal-tracker.js:77 (gateOn: 'pro… | EXECUTED | The doc says "nothing was changed to implement it" — correct; the code predat… |
|  | P0-1 fix exit_price on broker-side closes + backfill the 56 c… | agent/services/pnl-backfill.js:124-139 (repairE… | EXECUTED | The *mechanism* is in and tested. Whether the 56 historical rows were actuall… |
|  | P0-2 record realised R; make requiredWinPct/edge read it | agent/services/trade-consistency.js:141-150 (st… | EXECUTED | The code comment at perf-ledger.js:118-119 quotes the plan's own §4 reasoning… |
|  | P0-3 split the exit-route table into the ledger, per strategy… | No exitRoute/exit_route field anywhere in agent… | NOT EXECUTED | Partially answered elsewhere: position-events.js MANAGEMENT_STATES + GET /sta… |
|  | P1-1 unknown_daily_pnl collapse; re-confirm 07-08 | Guard still live: agent/services/global-guards.… | UNVERIFIABLE | The re-confirmation is a production measurement. The knobs exist and are test… |
|  | P1-2 / D-2 decide fib_618_fade / fib_confluence — re-arm or r… | agent/services/strategies.js:61 — fib_618_fade… | PARTIAL | Disarmed by default — the "retire" half. The doc's second half ("stop scannin… |
|  | P1-3 usd_per_lot_unknown; template risk_budget=$N so the brea… | agent/services/risk.js veto strings; TRAVEL-HAN… | PARTIAL | The sizing bug is fixed and handed over. The *templating* of risk_budget=$N —… |
|  | Phase 3 certify: n ≥ 200 per account, 0 sign contradictions,… | perf-ledger.js is per-account (accountId param… | UNVERIFIABLE | Machinery present; the certification itself is a production reading. |
|  | "Account …3489 is live and is not touched by any step in this… | — | UNVERIFIABLE | Requires the registry in production. |

**account-scope-plan.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | S1 ✅ "DONE 2026-08-03" — ?account= + coverage on every accoun… | agent/lib/account-scope.js:54 requestedAccount,… | EXECUTED | The ✅ is earned, including the three side-fixes named (duplicate-route guard… |
|  | S2 useAccountScope + ScopeDot | src/lib/use-account-scope.js (hook, MODES), src… | PARTIAL | Code is there and self-documents its S2 scope. Nothing pins the four states o… |
|  | S3 sidebar becomes the single switcher; per-page switchers re… | src/pages/Accounts.jsx:231 still mounts <Accoun… | PARTIAL | A single *source* of the selected account exists (src/lib/selected-account.js… |
|  | S4 adopt across nine pages / ~34 components | Only three consumers: src/components/GoalTracke… | NOT EXECUTED | This is the deliverable the plan calls "expect a run of amber on first paint… |
|  | S5 scope_audit table + POST /actions/scope-audit + GET /state… | Zero hits for scope_audit anywhere in agent/ or… | NOT EXECUTED | The register — the thing the owner actually asked for ("a logged register to… |
|  | S6 the lint (no useAccountScope ⇒ build fails; // scope-exemp… | No rule in eslint.config.js; zero scope-exempt… | NOT EXECUTED | Correctly sequenced after S4, which did not land. |
|  | §9 "does not change any trading behaviour, risk limit or gate" | — | EXECUTED | No risk change traceable to this plan. |

**per-account-control-plan.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | §0 "switching accounts is abandonment" — sweepMonitoredPositi… | agent/db.js sweep helper; agent/routes/actions.… | EXECUTED | A1 landed (the doc's own §7.4 cites PR #455). The characterisation test name… |
|  | A1 stop the switch abandoning positions | agent/account-switch-retains.test.js, agent/mul… | EXECUTED | Reinforced later by docs/archive/multi-account-exit-routing-2026-07-30.md and the acc… |
|  | A2 enforce accounts.mode at scan / analyse / entry / pending;… | agent/services/account-capabilities.js:41 MODES… | EXECUTED | Stronger than the plan: registered was added, and the enabled=0-beside-a-MANA… |
|  | The ENTER capability ("the money switch") | Superseded and hardened: agent/services/entry-m… | SUPERSEDED | By the tick-momentum programme P1b/P2a (#879, #881). |
|  | A3 pause disposition for pendings — owner's supervised-drain… | agent/services/entry-drain.js (drainEntryOrders… | PARTIAL | The audit record and per-account routing exist. But the shipped disposition i… |
|  | A4 four traffic lights + open/pending counts, Manage-red → Te… | agent/services/account-traffic-lights.js; route… | EXECUTED | I found no Telegram wiring keyed to a red Manage light. The route is declared… |
|  | A5 workspace reads — viewed-account parameter through /state/… | agent/db.js:1397-1407 adds account_id to 13 tab… | EXECUTED | Note agent/services/viewed-account.js is the duplicate implementation the acc… |
|  | A6 settingFor() two-level resolver + inherited/overridden UI | agent/services/account-registry.js:208-213 — ac… | NOT EXECUTED | The convention exists (as it did in 07-2026); the *resolver* with inherit/ove… |
|  | §1 safety principle "managing an open position is never pausa… | account-capabilities.js:23,91-94,208 — MANAGE o… | EXECUTED | The invariant is encoded, not merely stated. |

**order-flow-plan.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | §5 "what shipped alongside this plan": fib_confluence: 'meanr… | agent/services/regime-gate.js:54 and :60 | EXECUTED | The registry has since grown to 13 strategies, all classified (:50-69), so th… |
|  | §1 constraint: cTrader bar volume is a tick count, no Bid/Ask… | agent/lib/ctrader-ws.js (v = tick volume); no d… | EXECUTED | The "considered and rejected" depth-derived Delta was not built — correct. |
|  | §1 open question: tick-rule classification from SpotFeed, "ex… | cpp-exec/src/tick_recorder.cpp, tick_strategy.c… | SUPERSEDED | The tick programme (10/11-09-2026) is exactly the "explicitly-scoped research… |
|  | §4 step 2 multipleNodeLevels() in agent/lib/volume-structure.… | Zero hits | NOT EXECUTED | Ungated; still open. |
|  | §4 step 3 vpoc_retest strategy | Zero hits; not in STRATEGY_KEYS or STRATEGY_KIND | NOT EXECUTED | Ungated; still open. |
|  | §4 step 4 volume-based take-profit assist (bank/tighten befor… | No lowVolumeNodes consumer in profit-keeper.js… | NOT EXECUTED | Effectively SUPERSEDED by one-simple-system.md P4, which ranks *all* profit-k… |
|  | §3d "support becomes resistance — already covered by marketSt… | agent/lib/volume-structure.js | EXECUTED |  |

**scan-architecture-plan.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | S0 -O2 in the Makefile ("one line, 3–10×, risk: none") | cpp-exec/Makefile:6 — CXXFLAGS := -std=c++20 -W… | NOT EXECUTED | The single cheapest item in group B, still open after 6 weeks — and now *more… |
|  | S1 dynamic batch throttling in Node (AIMD on historicalRateSt… | agent/services/fib-strategy.js:663-694 selectSc… | NOT EXECUTED | The telemetry half exists; the controller does not. A deadline *abort* exists… |
|  | S2 BarBuilder in C++ (ticks → price-only bars, bar-closed eve… | Zero hits for BarBuilder/bar_builder in cpp-exe… | NOT EXECUTED | The tick programme deliberately took the *other* branch of §5's choice: it do… |
|  | S3 SignalBuffer + GET /signals?cursor=; symbol→strategy index… | No /signals route in cpp-exec/src/http_server.c… | SUPERSEDED | The *capability* the milestone wanted — C++ able to report rather than only t… |
|  | S4 runtime-mutable strategy registry + per-strategy timeframe… | VPO_SYMBOLS env universe still parsed at boot (… | NOT EXECUTED | Mitigated in practice: vpo-feeder.js refuses the push for a STOPPED account (… |
|  | S5 parity harness (Node vs C++ side by side, a week of diffs,… | Analogue exists for the tick strategy: the refe… | SUPERSEDED | Fixture-level parity, not a week of live side-by-side. Honest read: the *disc… |
|  | S6 cut over | — | NOT EXECUTED | Correctly — S5's live-soak half never ran. |

**d4-loop-block-fix-plan.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | §2 extract monitorOnePosition, run at bounded concurrency 4 | agent/loop.js:1958 export async function monito… | EXECUTED | D4a answered exactly as recommended, and the constant is pinned by a test so… |
|  | D4b include the weekend-watch loop | monitorOneWeekendPosition referenced at agent/m… | EXECUTED |  |
|  | D4c verify recordAnthropicUsage/daily_tokens_used is not a lo… | I did not find a test asserting atomicity of th… | PARTIAL | The plan called this "must check before implementing". The check's *outcome*… |
|  | D4d staleness throttle — recommended not bundled | monitorOnePosition(db, s, pos, currentPrice, cl… | EXECUTED | Deferred as recommended, with the extension point in place. |
|  | §7 follow-up: services/event-loop-lag.js and services/cpu-pro… | agent/services/event-loop-lag.js, agent/service… | EXECUTED | And the operating discipline ("turn it back off once the burner is named") is… |
|  | §7 "the burner is not yet named" | — | UNVERIFIABLE | Needs a production profile read. |
|  | §6 rollout: hold for explicit owner review, not auto-merge | — | UNVERIFIABLE | Process claim. |

**position-write-authority.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | §1/§2 the inventory itself — 6 stop writers, 8 closers | agent/services/profit-keeper.js, trade-guard.js… | EXECUTED | The doc's own §"three earlier drafts were wrong because they were assembled f… |
|  | §3 §41 hierarchy encoded | agent/services/management-state.js:76 WRITER_AU… | EXECUTED |  |
|  | §3a ruling: automated managers outrank a hand-placed stop; no… | agent/services/minute-review.js writes a positi… | EXECUTED | The owner-confirmed override is implemented as ruled. |
|  | §3b RULE_TRIGGER classification with a test that fails on unc… | management-state.js:149-198 | EXECUTED | The test is the whole point of §3b and it exists. |
|  | §3c singleFlight in acting-layer.js; every acting layer filte… | agent/services/acting-layer.js (singleFlight) | EXECUTED |  |
|  | §5 the three things "this inventory does not yet answer": ord… | management-state.js has no caller among the 14… | NOT EXECUTED | The document says so itself ("it remains undone on purpose"). Not an over-cla… |
|  | §5 the §70.3 state machine (canTransition/arbitrate/deriveSta… | agent/services/position-events.js:39 MANAGEMENT… | EXECUTED | The deletion claim is corroborated: no canTransition/arbitrate/deriveState re… |
|  | §6 record writers table (minute-review, stampRealisedAudit, r… | agent/services/trade-consistency.js:141-181; ag… | EXECUTED |  |

**one-simple-system.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | P3 "one exit: trail_1R… the live rule must match exit-replay.… | Evidence side: agent/lib/exit-replay.js:93 { na… | PARTIAL | The live managed exit trails at 0.5R by default, and from entry (managed-exit… |
|  | P4 replaced mechanisms (time caps, bank targets, be_at_1R, pr… | agent/services/profit-keeper.js still carries t… | UNVERIFIABLE | Whether they are switched off in production config cannot be read from the re… |
|  | P5a PR-C earned-floor.js: E = W·rr − (1−W) > minE, rolling 30… | agent/services/earned-floor.js:40-56 EARNED_FLO… | EXECUTED |  |
|  | P5a pre-registered verdict: 30 closes, PF ≥ 1.5, read at GET… | earned-floor.js:295 EARNED_FLOOR_VERDICT_TARGET… | EXECUTED | The number is a number, as promised. Whether the cohort has reached 30 closes… |
|  | P5a Stage 2 (demoOnly:false, riskScale:1.0, minSample:10, min… | Route exists: agent/routes/actions.js:537-556 w… | UNVERIFIABLE | This is the highest-consequence unverifiable item in group B: stage 2 puts li… |
|  | P5 "the 3R expectancy floor… re-derivation needed — NOT VERIF… | closed by P5a | EXECUTED |  |
|  | P5 "suspect gates (lesson_tuner SL widening ×1.3, ratchet/sta… | agent/services/lessons-tuner.js still present | NOT EXECUTED | Still open; correctly not deleted. |
|  | P6 revisit at 30–50 forward closes | — | UNVERIFIABLE |  |

**outstanding-backlog-2026-07-26.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | P1 (#397) daily-loss caps cannot see a loss → unknown-and-blo… | agent/services/global-guards.js:35-36 blockOnUn… | EXECUTED | Claim holds. |
|  | P2 (#401) ADD/REVERSE hardened, no more allowNaked:true, leg-… | agent/routes/actions.js double/reverse handlers… | EXECUTED | Note it needed a second pass 14 months— i.e. six weeks — later (#889) for acc… |
|  | P3(a) (#396) ambiguous submission blocks a resubmit; order_fa… | agent/lib/submission-dedupe.js; superseded by a… | EXECUTED | entry-ledger.js header explicitly names this as the gap it replaces: "both ar… |
|  | P3(b)/P4 (#395) skipped executor; management routes by the po… | agent/lib/exec-engine.js resolveOrderAccount (a… | EXECUTED | Strengthened beyond the claim. |
|  | P5 (#414, #417) two-tier auth, read vs money-moving | agent/index.js:57-61 AGENT_SECRET_READ ("D12, 2… | EXECUTED | Genuinely well pinned. Credential rotation (audit OQ-16) remains UNVERIFIABLE. |
|  | P6 (#405,#406) VPO predicate divergences + counted outcomes | cpp-exec/src/vpo_strategies.cpp, vpo_dispatcher… | EXECUTED | Re-corrected by #888's drift pass. |
|  | P7 (#404) three C++ thread-safety findings, ThreadSanitizer-c… | cpp-exec/src/spot_feed.cpp (wakeReader() half-c… | EXECUTED | But note 37ddfc2 (#887): the demo sidecar restarted every 1–2 minutes after #… |
|  | P8 (#398) staleness ceilings (regime 240 min, news 7 days) | agent/services/regime-gate.js (latestRegime age… | EXECUTED |  |
|  | P9 (2026-07-27) LLM exit needs a deterministic second gate (c… | agent/loop.js monitorOnePosition EXIT path; nul… | EXECUTED | The claim is precisely matched by the test file. |
|  | P10 position_events + write sites ("also shipped, task ledger… | agent/db.js position_events (has account_id), a… | EXECUTED |  |
|  | P11 bar retention per open position | Not built as specified. agent/services/cockpit-… | SUPERSEDED | Solved differently — fetch-on-demand instead of retention. The seven panels t… |
|  | P12 GET /api/positions/:id/cockpit + WS patch stream · gate D… | Route is GET /state/position/:id/cockpit (agent… | PARTIAL | Path differs from the spec (/state/... not /api/...), but D3 was answered as… |
|  | P13 execution facts (spread, latency) + pairwise correlation | agent/services/cockpit-snapshot.js:244-272 — sp… | PARTIAL | Latency is explicitly unanswered rather than faked — the right call, but the… |
|  | P14 unblock the 127 s loop pass · gate D4 | see §6 above | EXECUTED | The gate's own precondition (a written plan first) was honoured — docs/d4-loo… |
|  | P15 cockpit polish, D5–D9 | src/cockpit/TradeCockpit.jsx, cockpit-data.js:6… | PARTIAL | The advisory's data-derived behaviour is pinned. D5–D9 individually (FLEET ra… |
|  | P16 telegram_log 400-day retention, all send paths in both mo… | No telegram_log table. agent/db.js:1586-1595 ha… | NOT EXECUTED | Explicitly gated ("nothing here begins until asked for by name"), so not a fa… |
|  | "Three markers that should never appear on the demo trio": or… | all three strings exist as markers | UNVERIFIABLE | Requires production. |
|  | M4 soak watch, demo trio …7342 / …9908 / …0058, live forbidden | roster now differs (the 09-09 cluster rule open… | SUPERSEDED | By the multi-account migration + the 09-09 cluster rule. |

**cockpit-data-endpoint-spec.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | §4 "Status (02-09-2026): built, and it differs from the draft… | agent/services/position-events.js:39,64-69,113-… | EXECUTED | The self-correction is accurate against the code — a rare and good property. |
|  | §4 GET /state/exit-counterfactual reports byState with meanRA… | agent/services/exit-chain.js:58 stateSequences,… | EXECUTED |  |
|  | §4 write sites: profit-keeper, loss-guardian, loss-cap, posit… | each module present; POSITION_EVENTS_RETENTION_… | EXECUTED |  |
|  | §3 endpoint GET /api/positions/:id/cockpit, Bearer auth, id s… | agent/routes/state.js:411 router.get('/position… | PARTIAL | Contract substantially delivered (position, bars, indicators, execution, twea… |
|  | §3 indicators server-computed (ema9/20/50, vwap, rvol, volume… | agent/services/cockpit-bars.js over agent/lib/i… | EXECUTED | And the "empty/partial/failed history is a STATUS, never synthetic candles" r… |
|  | §3 execution.latencyMs | cockpit-snapshot.js:246 — "latency has NO autho… | NOT EXECUTED |  |
|  | §3 streaming WS /api/positions/:id/cockpit/stream, tick/bar/t… | zero hits | NOT EXECUTED | §5 step 6 ranked it last and called it "a refinement, not a prerequisite" — c… |
|  | §5 step 2 "bar retention per open position — the largest sing… | see P11 above | SUPERSEDED | Fetch-on-demand. |
|  | §5 step 5 pairwise correlation, "needs a decision on window a… | agent/services/cockpit-correlation.js | EXECUTED | The decision was taken inside the module. |
|  | "Until each step lands, the corresponding panel stays demo an… | src/cockpit/cockpit-data.js:647 builds the advi… | EXECUTED | This is the strongest honesty mechanism in the cockpit work: the advisory can… |

**multi-account-migration-plan.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | R1 accounts table | agent/db.js:471-485 — matches the spec's column… | EXECUTED |  |
|  | R2 single-token model, Node main loop the only refresher | agent/lib/ctrader-auth.js maybeRefreshCtraderTo… | EXECUTED |  |
|  | R3 Telegram registry commands (/accounts, /enable, /disable,… | agent/services/telegram-control.js | PARTIAL | The capability model landed in the UI/routes (/actions/account-*, account-cap… |
|  | R4 hot reload (read fresh per cycle, no cache machinery) | registry read per pass in account-registry.js | EXECUTED |  |
|  | C1 hybrid worker model (one process, per-account logical work… | agent/loop.js per-account dispatch; sidecar cpp… | EXECUTED | The sameSession "primary is elected once and frozen" defect the plan implicit… |
|  | C2 one SpotFeed subscribing the union; guardian's own wsStrea… | cpp-exec/src/spot_feed.cpp still the single fee… | PARTIAL | The retirement half did not happen; two tick sources still exist. |
|  | C3 supervision — account_worker:<id> heartbeats, stall = expe… | agent/services/heartbeat.js CONTROLLERS/beat/ch… | PARTIAL | Per-controller supervision exists (CPP-ROADMAP Phase 1); per-account worker h… |
|  | C4 crash isolation via per-worker try/catch | agent/loop.js per-phase try/catch; agent/monito… | EXECUTED |  |
|  | M1 account_id on the scoped tables + backfill | agent/db.js:1397-1407 adds account_id to trades… | EXECUTED | Comment at db.js:1395 preserves the plan's own reasoning for the four tables… |
|  | M1 enforcement layer: agent/repo.js scoped DAO that refuses u… | agent/repo.js does not exist. No no-restricted-… | NOT EXECUTED | The *column* landed; the *enforcement* did not. This is the same shape as acc… |
|  | M1 agent_state per-account keys move to acct:<id>:<key> with… | account-registry.js:208-213 acctKey/getAcctStat… | PARTIAL | Same finding as per-account-control A6. |
|  | M2 in-memory globals per account (lastPushedKey, symbolsListC… | agent/lib/exec-engine.js session key now multi-… | PARTIAL | lastPushedKey — the plan's "the hard blocker" — is resolved. The smaller symb… |
|  | M3 filesystem namespacing /data/accounts/<id>/ | no such layout; one SQLite DB (as the plan allo… | PARTIAL | The DB decision was kept deliberately. The per-account artifact directories w… |
|  | M4 Telegram provenance prefix [L-…1247]/[D-…6502]; /use <id>… | not found in telegram.js/telegram-control.js | NOT EXECUTED |  |
|  | M5 contamination test — two in-memory accounts, query-level a… | agent/multi-account-routing.characterisation.te… | PARTIAL | Several targeted scope tests exist; the *instrumented-repo, every-query-carri… |
|  | 3A D1–D5 decision provenance (JSONL + decision_log index, ski… | agent/db.js:487-493 decision_log (with account_… | PARTIAL | The SQLite index table and skip records shipped. The /data/accounts/<id>/deci… |
|  | T1 severity taxonomy / T2 daily digest / T4 rate limiting | agent/services/telegram-digest.js + test; teleg… | PARTIAL | Digest and priority/batching landed. The four-severity taxonomy with a collap… |
|  | T3 inline-keyboard confirmation for LIVE mutations | src/components/common/AccountScopeFab.jsx:23 —… | SUPERSEDED | A typed-word confirmation in the web UI replaced the Telegram inline keyboard… |
|  | K1/K2 global guards, effectiveGuards(accountId) with tighten-… | agent/services/global-guards.js — DEFAULT_GLOBA… | PARTIAL | The guard object, the fail-safe (K4) and the portfolio cap exist and are test… |
|  | K2 hardening: "the JS exec path checks brackets but not halt…… | agent/lib/exec-engine.js:553-571 validateExecGu… | EXECUTED | The single most important item in this plan — the kill switch that only worke… |
|  | K5 guards evaluate against the most recent successful reconci… | agent/services/reconciler.js; acting-layer.js r… | PARTIAL | Ownership-requires-reconcile is enforced for *acting*; a 2×-cadence staleness… |
|  | L2 blocking reconcile after a gap, before any new decision fo… | agent/services/entry-mode.js transition states… | SUPERSEDED | By tick-momentum P1c. |
|  | L3 idempotency — persist a clientOrderId before the wire call… | agent/services/entry-ledger.js — entry_intents… | SUPERSEDED | By tick-momentum P2a (#881/#882). The plan's own fallback ("persist-before-se… |
|  | L4 degradation ladder on symbol-budget exhaustion (shed demo… | no shedding ladder found; request_pacer.cpp (#8… | PARTIAL | The protective reservation exists where it now matters (request pacing), not… |
|  | G1 baseline tag pre-multiacct-baseline | git tag → empty | NOT EXECUTED | Still zero tags in the repo. |
|  | G2 compatibility shim, byte-for-byte decision-log diff |  | UNVERIFIABLE |  |
|  | G3 5-day demo soak incl. a weekend · G5 rollback drill · G6 2… |  | UNVERIFIABLE | Railway-side. The staging runbook's own dbPersistent check is the only part r… |
|  | P3 staging boot guard: refuse to start if ENVIRONMENT=staging… | no ENVIRONMENT read in agent/index.js | NOT EXECUTED | A live-account-on-staging guard does not exist in code. Mitigated by earned-f… |
|  | OPEN DECISIONS 10–13 (symbol-subscription cap, max accounts p… |  | UNVERIFIABLE | Require Spotware/production. #13 is moot: the ledger route was taken. |

**CPP-ROADMAP.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | Phase 0 — exec sidecar + backtester in C++ | cpp-exec/src/engine.cpp, backtest.cpp, main.cpp | EXECUTED |  |
|  | Phase 1 — controller_heartbeats + agent/services/heartbeat.js… | agent/db.js controller_heartbeats; agent/servic… | EXECUTED |  |
|  | Phase 1 — watchdog on the 30 s fast-monitor ticker, independe… | agent/services/fast-monitor.js hosts checkHeart… | EXECUTED | The design rationale ("a dead main loop is still detected") is intact. |
|  | Phase 1 — C++ actively probed via GET /health, recorded as th… | probeCppExec in the heartbeat layer | EXECUTED |  |
|  | Phase 1 honest limit — "if the whole Node process dies, nothi… | agent/railway.json healthcheckPath: /health, re… | EXECUTED |  |
|  | Phase 2 — sidecar pushes its own heartbeat (POST /heartbeat t… | cpp-exec/src/heartbeat.hpp exists; aaf8b8a/#888… | PARTIAL | The doc itself scopes this as "small, when useful" and notes the staleness ch… |
|  | Phase 3 — port controllers to C++ only with evidence (a misse… | Not done for the *controllers*. But cpp-exec/sr… | NOT EXECUTED | The tick programme took Phase 3's *second* trigger (cadence below what JS can… |
|  | Non-goals (no scan/analyze rewrite; no nanosecond HFT) | held | EXECUTED | Worth noting scan-architecture-plan.md S2–S6 proposed exactly the scan rewrit… |

**VALIDATION-DAY.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | §0 precondition (Railway head commit, footer version, Telegra… | APP_VERSION in agent/index.js; agent/deploy-ima… | UNVERIFIABLE |  |
|  | §1 Desk/Tune autotrade agreement; ⏳ PENDING ARMED chip | src/pages/Desk.jsx, Tune.jsx | UNVERIFIABLE |  |
|  | §2 broker-true P&L to the cent; 7d realised matches cTrader H… | agent/services/pnl-backfill.js, broker_deals | UNVERIFIABLE | Related code has since been reworked twice (0bc59af, 5ffdbf4). |
|  | §3 sizing: USDJPY / NATGAS show numbers, not vetoes; a real u… | fix recorded in TRAVEL-HANDOVER.md §5 (v0.1.142) | PARTIAL | Code fix corroborated; the *observation* is not. |
|  | §4 Profit Keeper centrepiece (KEEPER pass, 🔒 ping, broker-sid… | agent/services/profit-keeper.js:374 amend | UNVERIFIABLE | And now partly obsolete: one-simple-system.md P4 ranks the profit-keeper knob… |
|  | §5 Manage sheet (Modify/Protect/Chart/Details, native SL visi… | agent/services/position-protect.js, src/pages/T… | UNVERIFIABLE |  |
|  | §6 ✅ C++ first-fill watch — CLOSED 2026-07-16: BUY BTCUSD 0.0… | relativePoints handling in the order builder (a… | EXECUTED | The only ✅ on the page, and it is the one with a broker artefact attached. Th… |
|  | §6 autopilot report under Past reports; EURUSD pending still… | agent/lib/autopilot-report.js; autopilot_verdic… | UNVERIFIABLE |  |

**TRAVEL-HANDOVER.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | §1 Telegram commands /status /pending /pause /resume /killall… | agent/services/telegram-control.js | PARTIAL | The control module exists; I did not verify this exact verb set survives. |
|  | §2 "Account: DEMO …6502"; autotrade ON; pending armed on a na… | — | SUPERSEDED | The single-account world this page describes no longer exists: the registry i… |
|  | §3 Strategy Autopilot /autopilot suggest | auto | PARTIAL | Autopilot survives; its arming authority is now shared with the edge watchdog… |
|  | §5 "First real C++ fill still unobserved" | contradicted by VALIDATION-DAY.md §6 (CLOSED 16… | SUPERSEDED | Two owner-facing documents disagree about the same item. This one is wrong. |
|  | §5 USDJPY sizing veto — struck through, "Fixed (v0.1.142)" | corroborated by the go-live plan's P1-3 context | EXECUTED |  |
|  | §5 monitored_positions not account-scoped — struck through, "… | agent/db.js monitored_positions.account_id; swe… | EXECUTED | Note the *sweep* behaviour this entry praises is the very thing per-account-c… |
|  | §5 "News is informational only — never gates a trade" | agent/services/news-calendar.js staleness bound… | EXECUTED |  |
|  | §6 recovery instructions (/killall, /pause, close in cTrader) |  | PARTIAL |  |

**prior-cohort-watch.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | The prior path: W′ = (n·W_live + 20·W_backtest)/(n+20), demo… | agent/services/earned-floor.js:49-56 (the prior… | EXECUTED | The doc's strongest claim — "the prior path stays demo-only by code whatever… |
|  | GET /state/earned-floor reports closedCohort, viaPrior, byAcc… | earned-floor.js:437 viaPrior, :439,502 byAccoun… | EXECUTED |  |
|  | Every admit prints [risk] earned_floor admit: … via=<measured | prior> acct=<id>, and log-watch pushes it to Te… | EXECUTED | Runtime evidence is a pinned log format, which is the strongest form availabl… |
|  | POST /actions/earned-floor { priorAdmit: false } turns the pr… | agent/routes/actions.js:551 accepts priorAdmit;… | EXECUTED |  |
|  | The widening criterion — "written down, not enforced in code"… | EARNED_FLOOR_VERDICT_TARGET = { closes: 30, min… | PARTIAL | The document is explicit that this is a written rule, not a gate. Honest, but… |
|  | The daily watch itself; "what would change my mind" |  | UNVERIFIABLE | Production readings. |

**strategy-target-review-2026-09-02.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | "Recommendations only. HARD_MIN_RR (3.0), STRATEGY_MIN_RR (rs… | agent/services/target-review.js imports the gat… | EXECUTED | The claim is enforced by a test, which is the right way to make a "read-only"… |
|  | GET /state/target-review?days=30&account=<id\ | all> with three readings (proposed / prior / re… | EXECUTED |  |
|  | Reporting thresholds: proposed only at ≥20 opportunities with… | in target-review.js | EXECUTED |  |
|  | shareBelowHard, badRrVetoShare, admissibleOnPrior, earnedFloo… | target-review.js | EXECUTED |  |
|  | The 19:40 SGT prior-side table (W′ per strategy, E at declare… | source is GET /state/earned-floor?prior=1 on th… | UNVERIFIABLE | A production reading by construction; the doc says so. |
|  | "Open: fill the proposal and realised columns from the deploy… | — | NOT EXECUTED | No filled-in version of the table exists in the repo nine days later. |
|  | Per-strategy recommendations, all "no change" | HARD_MIN_RR unchanged; fib_618_fade defaultOn:f… | EXECUTED | One caveat: the 09-09 cluster rule (4809939, "every strategy ON for all five… |
|  | Declared-targets table transcribed from the strategy modules | agent/services/strategies.js and the per-strate… | EXECUTED | tsmom_long (regime-gate.js:69) is in the registry but absent from this table… |

### 5.C Group C

**1 · ui-control-inventory.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
| 1a | D20 Double | src/components/PositionManager.jsx (subtle→ var… | PARTIAL | confirm present; still not danger |
| 1a | D21 Reverse | PositionManager.jsx | PARTIAL | as D20 |
| 1a | D22 Close (<price>) | PositionManager.jsx | PARTIAL | still a raw button, not Button variant="danger" |
| 1a | D25 Modify protection | PositionManager.jsx:146-157, control at :313 | EXECUTED | window.confirm added with an itemised summary (:157), tagged "Approval-queue… |
| 1a | D19 Modify (dead) | PositionManager.jsx:230 | NOT EXECUTED | still <button disabled> as the dominant full-width action; queue item 6 never… |
| 1a | D27 Cancel order | OrderManager.jsx | PARTIAL | confirm intact; still a raw button |
| 1a | D42 veto | OrderLedger.jsx:110-126 | EXECUTED | relabelled Veto, now rounded-[var(--radius-control)] + --color-down border +… |
| 1a | T2 Test fill 0.01 | src/pages/Trade.jsx:687-690 | EXECUTED | variant="ghost" → variant="danger"; prompt+confirm retained |
| 1a | T3 Reset breaker | Trade.jsx:691 | PARTIAL | now variant="danger" and only rendered when health.circuitBreaker, but still… |
| 1a | T4 Kill all | Trade.jsx:693-696 | EXECUTED | danger + confirm |
| 1a | T17 order-pad commit | Trade.jsx order pad | UNVERIFIABLE | pad only renders behind the FAB; no data-less render reaches it, no test |
| 1a | T18 Clean up stale pending orders | Trade.jsx:865-873 | PARTIAL | confirm text now names exactly what is cancelled and what is kept; variant st… |
| 1a | T19 bot manage checkbox | Trade.jsx:904-916 | EXECUTED | native checkbox → shared Switch with pending={optBusy===positionId} (:409 com… |
| 1a | T15 BUY/SELL side selector | Trade.jsx order pad | UNVERIFIABLE | as T17 |
| 1a | Master S/A/T (sidebar) | AccountSwitcher.jsx:158-160 | SUPERSEDED | the master row was removed from this panel (comment at :158): "the master vet… |
| 1a | Per-account S/A/T | AccountSwitcher.jsx:24-43 (MiniSwitch), handler… | EXECUTED | role="switch"+aria-checked+aria-label on the primitive; arm confirms (:131),… |
| 1a | Account row (pick) | AccountSwitcher.jsx:180-196 | EXECUTED | typed LIVE gate at :91; LIVE/DEMO still use --color-down/--color-up (P&L tone… |
| 1a | Tune master Scan/Analyze | src/pages/Tune.jsx:1664-1670 | EXECUTED | confirm on OFF only with the exact blast radius named ("NO new trades happen… |
| 1a | Tune master Autotrade | Tune.jsx:1671-1690 | EXECUTED | arm = confirm, disarm = typed "disarm" (:1682-1688), with the standing note t… |
| 1a | Autotrade scope | Tune.jsx:1704-1707 | EXECUTED | now a shared <Segmented label="Autotrade scope"> — orphan radios gone |
| 1a | Per-account S/A/T (Tune card) | AccountPhaseSwitches.jsx | PARTIAL | still a second editor of the same keys (queue item 1 unresolved) |
| 1a | Inherit | AccountPhaseSwitches.jsx:458 | NOT EXECUTED | still a command shaped like a fourth switch, no confirm |
| 1a | Turn ON/Turn OFF (stage matrix) | Tune.jsx:629 | NOT EXECUTED | plain neutral Button, no confirm on the trade stage |
| 1a | Five safety breakers | Tune.jsx breakers card sec-pipe-breakers | NOT EXECUTED | still rendered identically to master Autotrade |
| 1a | Burn-in | Tune.jsx:2204 | EXECUTED | confirm spells out REAL positions, cadence and every kill path |
| 1a | Asset-controller cells (25 inputs) | Tune.jsx asset controller | NOT EXECUTED | live exit-rule writes on blur, no save step, no confirm |
| 1a | N of M ▸ strategy picker | Tune.jsx → watchlist/StrategyPicker.jsx | NOT EXECUTED | clickable-styled-as-text retained |
| 1a | Apply selection: N instruments | Tune.jsx:3463 | NOT EXECUTED | still the neutral default variant for a live re-arm |
| 1a | Arm the bot (everything in one tap) | Tune.jsx:3476-3496 | PARTIAL | confirm is now explicit and names the off-switches; variant is still the neut… |
| 1a | Arm pending orders | Tune.jsx:3509-3518 | EXECUTED | variant="secondary" → variant="accent"; confirm names the combos. grep 'varia… |
| 1a | Import settings | Tune.jsx:3767 | PARTIAL | still variant="subtle"; confirm/preview not verified here |
| 1a | Add to Activate: … All incl. No-Go | Tune.jsx backtest tab | NOT EXECUTED | warning is still prose |
| 1a | Timeframe chips 4h ✕ | Tune.jsx pipeline | PARTIAL | logic tested, tap target not |
| 1a | Reset vs Reset to defaults | RiskReassess.jsx / Risk.jsx | NOT EXECUTED | queue item 3, duplicate editors still on one page |
| 1a | Apply N selected | RiskReassess.jsx | NOT EXECUTED | default variant, no confirm |
| 1a | Ten On/Off Pills | Risk.jsx:1242-1250 etc. | PARTIAL | commit-model titles added per the plan's E5 row, but two commit models still… |
| 1a | Halt (kill switch) | Risk.jsx:1242-1243 | PARTIAL | the label now reads Halted — no orders / Off, so colour is no longer the only… |
| 1a | Reset staircase | Risk.jsx:769 | EXECUTED | now danger, and :702 prose names "EVERY account's banked" |
| 1a | Close ALL positions | Risk.jsx:1282 | PARTIAL | correct variant; the close-one/close-all emphasis inversion is unmeasured wit… |
| 1a | Connect Clear | src/pages/Connect.jsx:207-212 | EXECUTED | confirm added, tagged "Approval-queue item 2"; text says the bot keeps running |
| 1a | Connect account row | Connect.jsx:268-305 region | UNVERIFIABLE | nested span-in-button fix claimed by plan phase E6; not reachable in the skel… |
| 1a | WatchlistCompare | components/watchlist/WatchlistCompare.jsx via C… | PARTIAL | format tested, the cross-account write path is not |
| 1b | P18 desktop ledger <tr onClick> | Performance.jsx:972-976 | EXECUTED | role="button" tabIndex={0} aria-expanded + Enter/Space, with the comment nami… |
| 1b | D41 loss-review <tr onClick> | LossReview.jsx:264-272 | PARTIAL | row click kept for pointer; a sibling caret <button aria-expanded aria-label=… |
| 1b | P31 regime SVG <g onClick> | PerfMacroSections.jsx:228-229 | NOT EXECUTED | still <g onClick> with no role/tabindex/keydown. Mitigated only because the l… |
| 1b | WatchlistScreener row | WatchlistScreener.jsx:169 | NOT EXECUTED | a fourth bare <tr onClick>, keyboard-dead, not in the original inventory |
| 1b | P30 account filter (regime) | PerfMacroSections.jsx:184 | EXECUTED | aria-pressed added; the 5th diverging filter copy remains (queue item 5) |
| 1b | P26 account scope | PerfAccountScope.jsx:58-81 | EXECUTED | radiogroup + roving tabindex; has a test: src/components/perf-account-scope.t… |
| 1b | Systemic 1 — raw <button> vs Button | counted this session | PARTIAL | raw <button>: Performance 15, Tune 36, Desk 4, Trade 2, Risk 1. Performance.j… |
| 1b | Systemic 6 — radius token | counted this session | PARTIAL | --radius-control now used 49×; competing literals still 19×8px, 18×6px, 13×12… |
| 1b | Systemic 12 — no loading state | Button.jsx, Switch pending | PARTIAL | Switch gained pending (used at Trade.jsx:904); Button still has no loading va… |
| 1b | Systemic 13 — focus invisible | src/index.css:1279 | EXECUTED | global :where(button,[role=button],[role=radio],[role=link],summary,select,in… |
| 1b | Systemic 19 — variant="secondary" | grep | EXECUTED | zero call sites remain; Button.jsx:27-28 documents the old bug and makes unkn… |
| 1c | C-47 aria-modal without trap/name | TradeCockpit.jsx:236-258, :813-814 | EXECUTED | real Tab trap (wrap both directions + re-entry), aria-label={"Trade cockpit —… |
| 1c | #13 PFD/MFD/LOG tabs | TradeCockpit.jsx:750 | EXECUTED | role="tab" + aria-selected |
| 1c | #8 journal row | TradeCockpit.jsx:571-575 | EXECUTED | aria-expanded + Enter and Space with preventDefault |
| 1c | #17 ▾ MORE/▴ LESS | TradeCockpit.jsx:851 | EXECUTED | aria-expanded added |
| 1c | W-1 #4 Manage | TradeCockpit.jsx:311-312 | NOT EXECUTED | still no onClick. Disabled only when the market is closed, so on an open mark… |
| 1c | W-1 #5 Close (red) | TradeCockpit.jsx:313-314 | NOT EXECUTED | still no onClick, not even disabled, and still carries the "queues for next o… |
| 1c | W-1 #12 Fleet chip | TradeCockpit.jsx:717 | NOT EXECUTED | role="button" tabIndex={0} with no onClick/onKeyDown — announced as a button,… |
| 1c | #6 theme toggle aria-pressed | TradeCockpit.jsx:317 | NOT EXECUTED | still no aria-pressed (plan Phase F claims it) |
| 1c | C-26/C-27 no WebSocket / ≥1 Hz | TradeCockpit.jsx:145-169 | NOT EXECUTED | polling + a test-flag staleness path; BUILD-ORDER's ≥1 Hz live feed is unbuilt |
| 1c | C-42 cockpit never audited | scripts/responsive-audit.mjs ROUTES | NOT EXECUTED | no route opens the cockpit; all 20 BUILD-ORDER acceptance checks stay unautom… |
| 1c | C-39 widths | audit run this session | EXECUTED | widths are now 1024/820/768/740/390/375 — 768/740/375 added since the invento… |
| 1c | C-40/C-41 touch/minFont never fail | run output | NOT EXECUTED | touch<44=3/3 printed on every route at every width and the run still exits 0 |

**2 · ui-m3-migration-plan.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | Phase D "ui-spec gets a correcting edit" (C-1/C-2/C-3) | docs/ui-spec.md:50-60 | SUPERSEDED | not a correcting edit — the whole §2 was replaced by the *type canon* (4 toke… |
|  | Phase E3 /trade pass | Trade.jsx | EXECUTED | Test fill → danger, bot manage → Switch + pending, Clean up confirm |
|  | Phase E4 /tune pass | Tune.jsx | PARTIAL | Segmented adopted for autotrade scope; 36 raw <button> remain on the page |
|  | Phase F W-1 report "controls themselves are untouched" | TradeCockpit.jsx:311-314,717 | EXECUTED | the report is accurate — and that is the problem: all three dead controls are… |
|  | Verification log "vitest 395/395" | npx vitest run today | SUPERSEDED | 817/817 across 71 files — the suite roughly doubled since; the log's last ent… |
|  | Approval queue items 1,3,4,5,6,7,8,9 | source checks above | NOT EXECUTED | item 2 is the only one discharged, and it is discharged thoroughly (7 confirm… |

**3 · ui-m3-compact-contract.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | §1 no green | scripts/check-no-green.sh OK, wired at .github/… | EXECUTED |  |
|  | §1 blue=ON / red=OFF / grey=unknown | EngineStatusPanel.jsx:68, engine-status-view.js… | EXECUTED |  |
|  | §1 colour is never the only cue | Risk.jsx:1243 (Halted — no orders), EngineStatu… | PARTIAL |  |
|  | §1 up/down = P&L only | AccountSwitcher.jsx:187 still paints LIVE/DEMO… | NOT EXECUTED |  |
|  | §1 icon-only ⇒ IconButton + aria-label | IconButton.jsx exists + tested | PARTIAL |  |
|  | §2 canonical radius 1px | 49 token uses vs ~110 literals + 10 rounded-full | NOT EXECUTED |  |
|  | §3 focus-visible outline | index.css:1279 | EXECUTED |  |
|  | §3 loading/pending + aria-busy | Switch pending only | PARTIAL |  |
|  | §4 ≥44 px coarse target | audit prints touch<44=3/3 on a 162-byte body | UNVERIFIABLE |  |
|  | §5 typography | src/lib/type-canon.test.js — 0 text-[Npx] liter… | EXECUTED |  |
|  | §7 "migrating must never change handlers/routes/confirmations" | pass-1 route match (wiring audit) + today's gre… | EXECUTED |  |

**4 · ui-spec.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | §2 type scale | docs/ui-spec.md:50-60 + src/lib/type-canon.test… | SUPERSEDED |  |
|  | §11 "no px literal anywhere" | measured: 0 | EXECUTED |  |
|  | §11 "every row with more to say expands, with the keyboard as… | PerfMacroSections.jsx:228, WatchlistScreener.js… | NOT EXECUTED |  |
|  | §11 npm run check:no-green passes | run today | EXECUTED |  |
|  | §11 loading states are skeletons | src/components/common/Skeleton.jsx exists | PARTIAL |  |
|  | §12 open decision 3 — collapse triangles on 11 Performance se… | still "Not started, awaiting go"; cockpit shipp… | NOT EXECUTED |  |
|  | §12 decisions 1,2,4 | unchanged | NOT EXECUTED |  |

**5 · ui-audit-2026-07-30.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | §1 sidebar footer / nav scrolls independently | src/App.jsx | SUPERSEDED |  |
|  | §2 horizontal scrollbar removed | TabsPanel.jsx | SUPERSEDED |  |
|  | §3 rem type scale "Correction (done)" | the row self-marks SUPERSEDED 05-08-2026 and §6… | SUPERSEDED |  |
|  | §6.1 text-[var(--fs-*)] → text-(length:--…) | src/lib/css-token-syntax.test.js present and pa… | EXECUTED |  |
|  | §6.2 session line, 10px cap, popover portalled | SessionFooter.jsx | UNVERIFIABLE |  |
|  | §6.5 self-revoke 409 | agent/routes/session-routes.test.js | EXECUTED |  |
|  | Summary table "Typography consistent across all pages — not m… | 0 px literals today | SUPERSEDED |  |
|  | Summary table "Body text on 1rem — not met" | --fs-body was deleted per §3's own note | SUPERSEDED |  |
|  | "Still outstanding: route-level minFont 8–9px" | audit today reports minFont=12 on a 162-byte bo… | UNVERIFIABLE |  |

**6 · ui-wiring-audit.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | Pass 1 — 176 routes, 126 UI calls, zero orphans | spot-checked: /actions/entry-mode, /state/entry… | EXECUTED |  |
|  | Pass 2 W-1 — cockpit Manage/Close do nothing | TradeCockpit.jsx:311-314 | NOT EXECUTED |  |
|  | Pass 3 W-2 — Risk save is invisible | Risk.jsx ✓ Saved line; Tune equivalent at Tune.… | EXECUTED |  |
|  | Pass 4 — journal is position_events | src/cockpit/cockpit-data.js + cockpit-data.test… | EXECUTED |  |
|  | Pass 5b — no hardcoded data tables | re-grep clean outside the cockpit reference gen… | EXECUTED |  |
|  | Pass 6 M-1 two radius vocabularies | 49 token uses / ~110 literals | PARTIAL |  |
|  | Pass 6 M-2 touch targets | audit:ui cannot see them | UNVERIFIABLE |  |
|  | Pass 6 M-3 focus effectively unstyled (6 elements) | index.css:1279 global rule | EXECUTED |  |
|  | Pass 6 M-4 type scale is "one size plus exceptions" | 0 px literals, 774 token call sites | SUPERSEDED |  |
|  | Pass 6 "Proposed canonical set (NOT applied)" — type 9/10.5/1… | the canon shipped different numbers | SUPERSEDED |  |

**7 · tm/plan.md §13 — the UI rows**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | Shared account header / all pages | EngineStatusLine.jsx, mounted at ActiveAccountH… | EXECUTED | one line: requested/effective label, tone, · stale, and mixedSummary in the t… |
|  | Accounts | EngineStatusPanel.jsx, mounted at Accounts.jsx:… | EXECUTED | per-account Stop/Time-based, bulk with per-account ackLine(), blockers groupe… |
|  | Tune → Pipeline | — | NOT EXECUTED | Tune.jsx:85 TABS = Pipeline / Watchlist / Backtest / Presets. No EngineStatus… |
|  | Tune → Strategy / replay | — | NOT EXECUTED | no tick parameters, no profile hash, no run-evidence view. validationStage ap… |
|  | Tune → Watchlists | Tune.jsx watchlist tab | NOT EXECUTED | no per-account tick eligibility, no feed/symbol mapping, no subscription/warm… |
|  | Desk | src/pages/Desk.jsx | NOT EXECUTED | no tick candidates, no quote freshness, no event rates, no queue lag |
|  | Trade | src/pages/Trade.jsx | NOT EXECUTED | no Tick · N=256/M=64 basis label anywhere — grep -n 'N=256' src/ is empty. No… |
|  | Accounts → Workspace | AccountsWorkspace.jsx (25 lines) → WorkspaceHis… | PARTIAL | the page exists and reads real logs, but nothing in it renders mode/config re… |
|  | Accounts → Workflow audit | WorkflowAudit.jsx | NOT EXECUTED | it is an "exact port" of design_claude/Trade Workflow Audit.dc.html (:1-10) o… |
|  | Risk / Performance / Connect rows | Risk.jsx, Performance.jsx, Connect.jsx | NOT EXECUTED | no tick/time/manual or shadow/demo/live separation anywhere |
| states | warming | engine-status-view.js:16, label "<mode> · warmi… | EXECUTED |  |
| states | active | :21 | EXECUTED |  |
| states | stopped | :20 → "Entries stopped" (matches the plan's exa… | EXECUTED |  |
| states | switching | :17-18 (QUIESCING/RECONCILING) with the resting… | EXECUTED |  |
| states | blocked | :14-15 + blockedReason | EXECUTED |  |
| states | stale | :31, STALE_AFTER_MS = 60_000, appended as · sta… | SUPERSEDED |  |
| states | unknown | :12, "engine status unknown" | EXECUTED |  |
| states | mixed-account counts | mixedCounts/mixedSummary :57-75; rendered in th… | PARTIAL |  |
| states | shadow | engineState() has no shadow branch. Surfaces on… | PARTIAL |  |

**8 · agent-graph-audit-2026-08-03.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | F-POLICY-01 · the live account's S.A.T. switches read ON whil… | agent/services/account-phases.js:128-152 + src/… | EXECUTED | canEnterAcct now forces autotrade effective to false with source: 'capability… |
|  | F-POLICY-01 · legacy roster bypassed the registry | agent/services/account-registry.js:250 filters… | EXECUTED |  |
|  | F-OBS-01 · /state/risk-full?account=X returns the same margin… | broker_snapshot_cache_json is read at agent/ser… | NOT EXECUTED | neither remedy was taken: the snapshot is not scoped, and the block is not la… |
|  | F-OBS-02 · 13.3% of approvals never become orders, visible on… | no UI surface | NOT EXECUTED | the audit's own "highest-value unblocked remediation target"; still on no pag… |
|  | F-VETO-01 · veto accounting counts occurrences not opportunit… | Desk.jsx risk-decisions | NOT EXECUTED |  |
|  | Header "three were defects … all three were repaired today" | agent/services/unresolved-pnl.js present; #593/… | EXECUTED |  |

**9 · pnl-veto-investigation-2026-07-30.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | Veto lives in Node, not C++ | agent/services/unresolved-pnl.js | EXECUTED |  |
|  | Guard deliberately not weakened | the OR account_id IS NULL predicate retained | EXECUTED |  |
|  | Observability: unattributedCount named in the reason string | unresolved-pnl.js:117, 288, 298, 330, 377-378 —… | EXECUTED |  |
|  | New agent/services/equity-stop.js, master never touched | file present; :17,:27 comments preserve the old… | EXECUTED |  |
|  | "19 new tests … first two named IRONCLAD" | agent/services/equity-stop.test.js — exactly 19… | EXECUTED |  |
|  | §3 autoDisarm default "awaits their word" | — | UNVERIFIABLE |  |
|  | §5 "no production evidence" | still true from here | UNVERIFIABLE |  |
|  | §7 next-step 2 · fix unattributed rows / add NOT NULL | not found | NOT EXECUTED |  |
|  | §7 next-step 4 · build the PnLState enum | not found | NOT EXECUTED |  |
|  | "Full gate: 1618 node tests, 303 vitest" | vitest is 817 today | SUPERSEDED |  |

**10 · multi-account-exit-routing-2026-07-30.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | Node half — chokepoint stamping in exec-engine.js | agent/lib/exec-engine.js:178 (comment), :606-62… | EXECUTED |  |
|  | guard_account_mismatch / guard_no_account refusals | exec-engine.js:613, :618 with the exact message… | EXECUTED |  |
|  | The nine exit call sites unchanged | withAccount applied at the delegator only | EXECUTED |  |
|  | .sort() removed from the memo key | — | EXECUTED |  |
|  | Characterisation tests pinned | agent/multi-account-routing.characterisation.te… | EXECUTED |  |
|  | "Status: … The C++ half is still to come" | cpp-exec/src/engine.cpp:672-695 — *"THIS REPLAC… | EXECUTED |  |
|  | "positionId collision across accounts UNVERIFIED" | unchanged | UNVERIFIABLE |  |
|  | "whether this is what happened on 2026-07-30" | unchanged | UNVERIFIABLE |  |

**11 · safe-implementation-first-response-2026-07-30.md**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|
|  | "No application code has been changed for this prompt" | — | EXECUTED |  |
|  | S-0 · OTP → CSPRNG | agent/index.js:15 imports randomInt from node:c… | EXECUTED |  |
|  | S-0 · /health exposure | :511 still skips auth for GET /health; but the… | EXECUTED |  |
|  | P1-5 · device sessions stored as raw bearer tokens, 90-day | agent/index.js:494-506 still JSON.parse(getStat… | NOT EXECUTED |  |
|  | P0-1 · remove the risk.js selected-account fallback | agent/services/risk.js:1044 still acctExplicit… | PARTIAL | the fallback survives, but :1035-1043 now records an account_source field so… |
|  | P0-1 · engine.cpp primaryAccountLocked() on writes | removed — see §10 | EXECUTED |  |
|  | P1-3 · "live autopilot at boot" | agent/db.js seeds autotrade_enabled: 'false' | N/A |  |
|  | P0-2 durable command model, P1-1 fast path, P1-2 post-fill en… | not re-checked in depth | UNVERIFIABLE |  |
|  | Phases 2–9 of the plan | — | NOT EXECUTED |  |

**12 · Ranked NOT EXECUTED / PARTIAL**

| Sec | Item | Where | Verdict | Note |
|---|---|---|---|---|

---

## 6. Method and limits

**What the verdicts mean here.** EXECUTED = code present **and** a test or a pinned runtime surface that would fail if the behaviour regressed. PARTIAL = part of the claim meets that bar. NOT EXECUTED = no code for the claim, or code whose acceptance criterion cannot be met as written. SUPERSEDED = a later owner-traceable decision replaced the claim (the successor is named in the row). UNVERIFIABLE = the claim is about the deployed system and this repository cannot answer it. **Source presence never counted as executed**: a route that exists in `agent/routes/state.js`, a log line whose format is pinned, a column in a DDL — these appear in the "Where" column as evidence of *wiring*, and the verdict still turned on a test or a fault run. The three investigators applied this rule independently; the counting rule in the preamble reduces their compound verdicts to one token each.

**Why UNVERIFIABLE is large (37 claims, plus every "runtime" cell).** Three things are missing from this environment and each removes a whole class of evidence: (1) the **bearer token is lost** (README "Owner-held preconditions", TM-37), so no `/health`, `/state/*`, `agent_state` value, veto count, P&L reading, earned-floor stage, strategy toggle, Railway volume, cgroup quota or deployed SQLite version was observed — every such cell is a route that exists, not a value; (2) **no fault run of any kind exists** in the repo — no kill-at-reserve/redeem/send/ack, no ENOSPC/EIO/inode/failed-rename, no offline executor, no 24 h soak, no 10× burst — so every register acceptance criterion phrased as a fault run (TM-13, TM-23, TM-28, TM-31, TM-36) is unmet by construction, and the "Fault-injection auditor" and "Race checker" roles named on six register rows have produced no evidence; (3) **no browser matrix** — `npm run audit:ui` renders a 162-byte shell on all 7 routes × 6 widths, `audit:ui:live` needs a reachable agent, and no fixture harness exists for the eight §13 page states, so every tap-target, overflow, contrast and zoom figure in any UI document is unmeasured, and cockpit/order-pad/manager-sheet DOM was never rendered. A green suite (Node 4067, C++ 30 binaries, Vitest 817) is happy-path and in-process adversarial evidence only.

**Citation spot-checks performed by this synthesis** (all against HEAD `fd85140`; tree identical to `2a3b5ff`):

| Citation | Group | Result |
|---|---|---|
| `agent/services/entry-mode.js:102-104` refuses TICK_MOMENTUM | A | ✔ |
| `agent/db.js:978` `synchronous = NORMAL` | A | ✔ |
| `cpp-exec/src/order_guard.cpp:103-109` unfenced → no permit; `:133-151` account/symbol/side/volume only, `consumed` set | A | ✔ |
| `agent/services/exec-guard-sync.js:119` catch fails open | A | ✔ |
| `agent/services/db-compact.js:70` `SPACE_HEADROOM = 1.15` | A | ✔ |
| `agent/services/entry-ledger.js:41` no PARTIAL/CANCELLED; `pendingExposure` no caller | A | ✔ |
| `cpp-exec/Makefile:6` no `-O`; no ASan/UBSan target (only `-fsanitize=thread` at `:43`) | A | ✔ |
| `entry-producers.js:55` B14 note | A | ✔ content; path is `agent/lib/`, not `agent/services/` (test file likewise in `agent/lib/`) |
| `agent/lib/ctrader-creds.js:32-33,68`; `exec-engine.js:562-566`; `actions.js:2328/2352/2361` | A | ✔ |
| `cpp-exec/src/telemetry.cpp:18,37,43-49` mutex, unbounded drain, post-drain rotation, unchecked `rename` | A | ✔ |
| `scripts/tick-research.mjs:58-61` grid + manifest without commit/risk | A | ✔ |
| `tick_recorder.hpp:76` `recvMs`; `subscribeToSpotTimestamp` absent from `spot_feed.*` | A | ✔ |
| no `tickReadiness*` consumer in `entry-mode.js`; "overshoot" absent from tick code | A | ✔ |
| register statuses; TM-25/28/34/13/03 self-contradicting evidence text; `test_engine_send_boundary.cpp` exists | A | ✔ (filed counts are 19/9/14, not 20/8/14) |
| `agent/services/managed-exit.js:107` `trailR: 0.5`; `agent/lib/exit-replay.js:93` `trail_1R` 1.0 | B | ✔ |
| `agent/services/earned-floor.js:40-56,122,138,295` stage-1 defaults, live scope, prior demo-only, verdict target | B | ✔ |
| `agent/services/fib-strategy.js:664,724` `batchSize` 15 | B | ✔ |
| `scope_audit` 0 hits; `agent/repo.js` absent; no `no-restricted-*` in `eslint.config.js`; `git tag` empty | B | ✔ |
| `cpp-exec/src/engine.cpp:672-676` replaces `withAccountId()`; `guard_no_account` at `:836,:861,:866` | B | ✔ |
| `agent/services/account-registry.js:208-213` `acctKey` | B | ✔ (functions are `getAccountState`/`setAccountState`, not `getAcctState`) |
| `account-capabilities.js:184` still describes supervised-drain | B | ✔ |
| `agent/index.js:494` raw-token `device_sessions`; `risk.js:1044` selected-account fallback | B/C | ✔ |
| `agent/services/cockpit-snapshot.js:85` global snapshot, `:246` latency has no source | B/C | ✔ |
| `src/cockpit/TradeCockpit.jsx:311-314` `Manage`/`Close` no `onClick`; `:717` fleet chip `role="button"` no handler | C | ✔ |
| `src/cockpit/TradeCockpit.jsx:317` "no `aria-pressed`" | C | **✘ refuted** — `aria-pressed={themeOverride != null}` is on that line |
| `src/pages/Trade.jsx:691` `Reset breaker` `danger`, no confirm | C | ✔ |
| `src/pages/Tune.jsx:85` TABS; 0 `EngineStatusPanel` on Tune (2 on Accounts); `:629`, `:3463`, `:3476` | C | ✔ |
| `src/pages/Risk.jsx:572` margin line; `:1242-1243` `Halt` pill; `GlobalScopeNote` at 608/1151/1239 only | C | ✔ |
| `src/lib/engine-status-view.js:11-23` six states, no shadow branch | C | ✔ |
| `src/components/AccountSwitcher.jsx:158` master-veto comment, `:187` LIVE/DEMO tones | C | ✔ content; lines are `:160` and `:188` |
| `WatchlistScreener.jsx:169` bare `<tr onClick>`; `PerfMacroSections.jsx:228` `<g onClick>` | C | ✔ content; path is `src/components/WatchlistScreener.jsx` (no `watchlist/`) |
| `src/index.css:1279` global `:focus-visible`; 0 hits for `tick-shadow|tick-signals|momentum-shadow` in `src/`; `RiskReassess.jsx` `Apply N selected` | C | ✔ |

Thirty-two citation groups checked; one refuted, three with shifted line numbers or paths (content confirmed), the rest exact. Everything not in this table is carried from the investigator's report and marked so in §4.

**Not done here, by instruction:** no repo file was edited; no route was called; no production account was read. Nothing in this document is a runtime observation.

> **12-09-2026:** the owner-principles programme is complete — PR-A..PR-H are
> merged (#895–#902) and deployed. The per-PR record with merge commits and
> runtime read-back is `docs/owner-principles-plan-2026-09-11.md` §7; what is
> still open (owner-side items and the follow-ups these sections flag) is its
> §8. The follow-ups below (§7–§12) are the per-PR dated sections the standing
> principle-5 rule asked for; a whole-plan re-audit over the merged tree is the
> next docs task, not done here.

## 7. PR-C follow-up — vetoes minimised (built 2026-09-11, principle 7)

Follow-up to `docs/owner-principles-plan-2026-09-11.md` §3.2 / §4 PR-C. The
position cap is unchanged by owner decision (`maxOpenPositions` 5, the
momentum book's 8, adopted/manual/book positions still counting).

| Plan item | Built | Where | Test |
|---|---|---|---|
| Eight cycle-level guards move to the per-account pre-filter as `decision_log` skips; gate keeps them as backstop | done — six account-level guards asked ONCE per account per cycle (memo on `loopCount`), two proposal-level (exposure, correlation) per symbol on the same position read; stages `account_pregate:<guard>` | `agent/services/account-pregate.js`; predicates exported from `agent/services/risk.js` (`balanceScopeVerdict`, `dailyLossVerdict`, `lossStreakVerdict`, `openPositionsForAccount`, `maxPositionsVerdict`, `exposureVerdict`, `correlationVerdict`) and called by `evaluateTrade` itself; wired in `agent/loop.js` after `margin_pool`, and right before `autoTrade` | `agent/services/account-pregate.test.js` (13) |
| `persistRiskEvent` dedupe on (opportunity_key, reason head) | done — `repeat_count` bumped and `last_at` stamped on the newest row when the head (`veto-breakdown.js reasonKey`) is unchanged and the row is under 6 h old (`VETO_REPEAT_WINDOW_MS`, measured from first sighting); approvals never merge | `risk.js mergeRepeatVeto`; migration in `agent/db.js` (`repeat_count INTEGER NOT NULL DEFAULT 1`, `last_at TEXT`); gap rule in `opportunity-identity.js` reads `COALESCE(last_at, created_at)` | `agent/services/risk-veto-dedupe.test.js` (10) |
| Readers sum `repeat_count`, report `distinct` beside it | done — decision-audit (`vetoed`/`vetoedDistinct`), veto-breakdown (`proposalsVetoed`/`proposalsVetoedDistinct`, per-guard `count`/`distinct`), journal (`vetoes: N (M distinct, rate R%)`), opportunity-funnel (`evaluations`), refusal-ledger (`refusals`, `last_at`), log-inspector, stage-matrix, evidence-gate report, fx-legs, `/state` daily gate route (`vetoed`/`vetoed_distinct`) | those files | dedupe test above; `journal.test.js` |
| Drop `OR mp.account_id IS NULL` from the position count for a scoped account | done — `openPositionsForAccount`: `(mp.account_id = ? OR ? IS NULL)`; NULL rows count only for an unscoped evaluation. Note: the duplicate-symbol, exposure and correlation checks read the same list, so an orphan row no longer blocks a scoped account on those either | `risk.js` | leak tests in `account-pregate.test.js` |
| `regime_block` and `evidence_gate` written as skips | done — `agent/services/gate-skips.js` (`recordRegimeBlock`, `recordEvidenceShadow`); the evidence skip carries the full proposal in `detail_json`; `evidenceGateReport` counts decision_log skips plus legacy rows | `loop.js` | `agent/services/gate-skips.test.js` (4); `evidence-gate.test.js` pin updated |
| `bad_rr` pre-filter catches what the gate would veto | done — `rrFloorVerdict` (risk.js) is the gate's R:R block extracted; `proposalPregate` calls it per account (the earned-floor admit/stretch is per account × strategy, which is why the producers' static 1.5 could not catch the 418: every producer floors at `STRATEGY_PREFILTER_RR` 1.5 while the gate floors at `HARD_MIN_RR` 3.0, and rsi2_reversion builds 1.2R with no floor at all). Stage `rr_prefilter` | `risk.js`, `account-pregate.js` | `account-pregate.test.js` |
| Goal: `vetoRate`, `wasteRate`, `vetoRateMax`, `vetoMinReachedGate` | done — `veto_rate` goal (13th row); `vetoRateMax` 0.9, `vetoMinReachedGate` 200; reads `decision_audit_last_json`, falls back to a live audit | `agent/services/goal-table.js` | `goal-table.test.js` |

**Measured from the code, not from production:** the 418 `bad_rr` and the
9,915 `max_positions` are the plan's 11-09 figures; nothing here re-read
production. The first cycle after deploy is the measurement: the audit's
`vetoedDistinct` against `vetoed`, and `account_pregate:*` rows in
`decision_log` where `risk_events` rows used to be.

**Checker round (same day) — three MAJORs, three MINORs, one note, all
built with a red-when-reverted test:**
1. `mergeRepeatVeto` refuses a merge across the FX day open (`firstMs <
   fxDayOpenMs(nowMs)`), so no "this FX day" reader under-reads its first
   hours.
2. The refusal ledger reads evidence-gate skips back from `decision_log`
   (`evidenceShadowRefusals`, keyed by `resolveOpportunity` per tuple in time
   order) and scores them as before; `waiting` counts both sources. ORDERING
   CHANGE, stated: the account and proposal pre-gates now run BEFORE
   `autoTrade`'s evidence gate, so a shadow strategy on an account the
   pre-gate refuses (at cap, daily cap tripped, …) writes the pre-gate skip
   and NO evidence-gate shadow record that cycle; `shadowRefusals7d` and the
   ledger's shadow population therefore count only the shadow proposals that
   reached the evidence gate, which after deploy is a smaller number than
   before. It is the same trade-off the plan makes for every upstream gate
   (a proposal refused for the account is not re-refused for the strategy);
   if the shadow record must be complete regardless of the account, the
   evidence gate would have to move ahead of the pre-gates — not done here.
3. The leak fix is the COUNT only: `openPositionsForAccount(db, acct,
   { countOnly: true })` feeds `max_positions`; `duplicate_symbol`, the
   symbol cap, exposure, correlation and the margin read keep the
   NULL-inclusive list (a NULL-account row on X still refuses a second entry
   on X).
4. A row carrying `post_approval` never absorbs a gate veto.
5. `max_positions` merges on the full reason (`6/5` is not `5/5`).
6. The pre-gate memo is keyed on the account's active-book fingerprint
   (count + newest id) as well as the cycle, so a close or a fill mid-cycle
   re-asks; `invalidateAccountPregate` is also called after a placed order.
7. `vetoMinReachedGate` 200 → 50.

**Known gaps, not widened here:**
- `mergeRepeatVeto` keeps the first sighting's `checks_json`/`proposal_json`;
  a repeat's live numbers survive only in the log line.
- `decision_audit_history` stores `vetoed` (now the summed figure); it has no
  `distinct` column.

## 7. Follow-up — PR-B, one account model (11-09-2026)

Dated follow-up per the plan's standing rule (`docs/owner-principles-plan-2026-09-11.md`, "Standing — principle 5"). PR-B implements §3.1's class-(b) removals and the four hardcoded-config replacements under the owner's decision "no distinction". What changed, file by file; every removed gate has a behavioural test that goes red if it returns.

| Gate / config (§3.1 row) | Change | Test |
|---|---|---|
| `entry-mode.js` `tick_live_refused` | deleted; readiness is the only gate | `entry-mode.test.js`: a live account with a ready readiness fn is admitted (WARMING) and refused only by `tick_not_ready` |
| `tick-permits.js` + `exec-guard-sync.js` live strike | `is_live === 1 \|\| environment === 'live'` dropped from both rosters (paired) | `tick-permits.test.js`, `exec-guard-sync.test.js`: a live account in effective STABLE `TICK_MOMENTUM` is listed on its own side |
| two-tier evidence ladder (`entry-contracts.js`, `tick-readiness.js`, `tick-validation.js`) | `VALIDATION_STAGES` = `UNVALIDATED, REPLAY_PASSED, SHADOW_PASSED, TRADED_PASSED`; `TICK_ENTRY_STAGES` shared by the contract and readiness; `TRADED_PASSED` judged on the account's own closed tick trades in R (`tradedTickEvidence`, lineage `entry_intents` FILLED `tick_momentum` → `trades.ctrader_position_id`); config key `demo` → `traded` (`minTrades/minProfitFactor/maxDrawdownR`, all null); `not_a_demo_account`, `approval_word_required`, `owner_only` gone; stored `DEMO_PASSED`/`LIVE_APPROVED` read as `TRADED_PASSED` (`normaliseLegacyStage` in `engineStatusFor`) | `tick-validation.test.js` (a live account reaches `TRADED_PASSED` on three tick closes; a time-based close does not count; legacy records read back), `tick-readiness.test.js` (live with `SHADOW_PASSED` is ready), `entry-contracts.test.js` |
| `earned-floor.js` `demoOnly` + demo-only prior | both deleted; the registry row is read for existence only | `earned-floor.test.js`: a live row admits by the measured path and by the prior path; the stretch opens on a live row; the cohort report lists live accounts |
| `stage-matrix.js` `exemptHandPinnedDemo` | renamed `exemptHandPinned`, no environment term; `adaptive-breaker.js` / `edge-watchdog.js` record `heldPinned` | `stage-matrix.test.js`, `adaptive-breaker.test.js`, `edge-watchdog.test.js`: a hand-pinned live scope is held; a scope inheriting the global list still follows the disarm |
| `config-controller.js` `includeLive` | removed (service, `loop.js`, `/state/config-proposals`) | `config-controller.test.js`: the live account is proposed for by default |
| `strategy-autopilot.js` `isLive && !allowLive` | removed with the `autopilot_allow_live` key end to end (`index.js` boot force-set, `/actions/autopilot`, `/state/config`, Tune copy) | `strategy-autopilot.test.js` source pin |
| `account-capabilities.js` `liveEntryRefusal` / `confirmLive` | deleted end to end (`account-registry.js setAccountEnabled`, `unarchiveAccount`, both routes) | `account-capabilities.test.js`: a live account is enabled/unarchived to `active` like any other; comment-stripped pin that neither name survives |
| UI: greyed dropdown, "Type LIVE" prompts | `AccountPhaseSwitches` dropdown enabled on every row; `AccountSwitcher`, `Connect`, and the fourth prompt in `AccountScopeFab` replaced by one neutral `window.confirm` naming last-4 and balance (`src/lib/account-confirm.js`); `WatchlistCompare`'s copy confirm on every destination | `src/lib/account-confirm.test.js`, `AccountScopeFab.test.jsx` |
| `managed-exit.js` `demoOnly` | option and branch deleted; a stored `demoOnly: true` is inert | `managed-exit.test.js` |
| `momentum-account.json` one account + `exclusive` | `accountId: "_all"` = every enabled account; per-account pass cursor (`momentum_account_state_json:<id>`); sizing from each account's own equity (`deps.equity(accountId)`, pinned in `loop.js`); `exclusive` and the `momentum_account_only` veto deleted; report per account with an aggregate for the goal table | `momentum-account.test.js`: two accounts sized 0.05 / 0.01 lots by balance, a third below the min lot excluded, a disabled account never runs |
| `tick-observation.json` one account | `{ "_all": "RECORD" }`; the seed expands `_all` to every enabled account and records the ids reached, so a later-enabled account is seeded on its next boot | `entry-mode.test.js` |
| `strategy-pins.json` five ids | `{ "_all": [12 strategies] }`; the seed expands `_all`, per-id keys still win | `stage-matrix.test.js` |
| invariant | `agent/lib/one-account-model.test.js`: comment-stripped grep of `agent/**` and `src/**` for `is_live`, `isLive`, `environment ===/!==`, `'demo'`, `'live'`, `LIVE_APPROVED`, `DEMO_PASSED`, `demoOnly`, `confirmLive`, `allowLive`, `exemptHandPinnedDemo` outside a file→pattern allowlist (the plan's routing list + display badges, one reason each); a by-name check that each retired gate is absent; the three configs declare `_all`; stale allowlist entries fail | red on `befed65` (71 tokens, 25 retired gates, 3 configs), green after |

Deviations from the plan text, stated: the plan wrote `momentum-account.json accountId: null means all`; the build uses the explicit `"_all"` sentinel (null keeps meaning "nowhere", as every existing test and the boot line read it) — the same sentinel the other two configs use. The plan named `docs/tick-momentum/runbook.md`; no such file exists — the ladder is documented in `plan.md` §2 and updated there.

**Residual gates, named (`RESIDUAL_GATES` in `agent/lib/one-account-model.test.js`, kept apart from the routing allowlist):** `agent/routes/actions.js` `/actions/validation-fill` refuses its 0.01 test order on a live selection; `agent/scripts/exec-parity.js` refuses its `--order` on a live host. Both guard a deliberate test order, not trading policy; owner decision pending 11-09-2026. The invariant pins each to its exact source line and its token count, so it cannot grow or move without this list changing.

**Checker corrections folded in (11-09-2026):** (1) the hand-pin exemption now holds only against a POOLED verdict — a breaker streak or a watchdog no-edge record measured on an account's OWN closes writes that account's `trade:false` (`accountsWithOwnStreak`, `accountsWithOwnNoEdge`, `disarmStrategyEverywhere({ ownVerdictScopes })`); with `_all` pins the previous exemption had left both guards unable to disarm anything anywhere. (2) The daily momentum pass applies the row-cursor `tryEnter` gates: a margin-exhausted account takes no entries (exits still run, the cursor is not advanced) and an unfundable name is skipped by name; a funded live account is proven through the pass with `isLive:true` and its own size. (3) The invariant scans by regex (`"live"`/`'LIVE'`, `environment ==`, `isDemo`, `live_flag` all caught — verified on the checker's `evade/` files), with exact per-file counts, stale-entry flagging, `scripts/` scanned and `cpp-exec/src` asserted branch-free. (4) The previously named account's global pass cursor is migrated to its per-account key once at boot (`migrateLegacyPassCursor`), so the first pass after deploy does not re-run the same UTC day.

**For the PR body — what changes on the LIVE accounts at the first loop after deploy.** Every enabled account, the live ones included, boots with all twelve non-momentum strategies hand-pinned ON for Auto Trade & Open (`strategy-pins.json` `_all`); each proposal on a live account now reaches dispatch through the evidence gate's pin path and is still subject to the risk gate (position caps, margin pool, earned floor on the account's own record, the 30-close verdicts, the watchlist's `accountMayTrade`), to the adaptive breaker and the edge watchdog (which now disarm a pinned strategy on that account's own losses), and to the account's armed phases. Where `tsmom_long` is armed on a live account, the daily momentum pass runs there once per UTC day after 21:05, sized by the 10 % vol target from that account's own equity, skipping unfundable names and taking no entries while its margin pool is exhausted. No tick order is possible on any account: every `tick-validation.json` threshold is null (`thresholds_unset`), so no account can reach `SHADOW_PASSED`, and the live sidecar has no `TICK_SPOOL_PATH`, so readiness fails `recorder_recording` there; the tick roster stays empty until PR-H's thresholds and the evidence chain exist. The removed live-only ceremonies (typed LIVE prompts, `confirmLive`, the greyed mode dropdown) mean a live account can be selected, enabled to `active` and armed with the same one-click confirm as any other — the environment badge remains for display only.

---

## 8. PR-E follow-up — every trade has a reason; no UNKNOWN (owner principle 4), 11-09-2026

Built against `bcd3a45` (#895) from `docs/owner-principles-plan-2026-09-11.md` §3.5 / §4 PR-E, then revised on the independent checker's findings (one blocker, four majors, five minors — all addressed below, each with a test that goes red when reverted). Account ids last-4 only.

### 7.1 What was unattributed (measured in §3.5, confirmed at HEAD before the change)

| Gap | Where | What it meant |
|---|---|---|
| `POST /actions/manual-order` wrote no `strategy`, no `risk_event_id`, no `trade_plans` row | `agent/routes/actions.js` (the order pad's only live entry button) | the sole entry path whose trade had no plan to score and no approval to walk back to; the approval id `persistRiskEvent` returned was discarded on the line it was made |
| `pending-orders.js` hard-coded `strategy = 'fib_618_fade'` at the fill and never stamped `pending_orders.strategy` at placement | `agent/services/pending-orders.js` | a limit placed for any other strategy became a fib trade at the fill; the column existed since `db.js` ~1351 and was read by nothing on this path |
| `entry_intents` UNKNOWN had no deal-history resolver, and only the primary account's intents were reconciled at all | `agent/services/entry-ledger.js`, `agent/loop.js` | an ambiguous send the reconcile snapshot and the sidecar ring could not name stayed UNKNOWN for good; on a non-primary account nothing ever looked |
| No operator UI for UNKNOWN | `/state/entry-intents`, `/actions/entry-intents/:id/resolve` appeared nowhere in `src/` | the last resolver (an operator with a reason) was reachable only by curl |
| `trades.origin` NULL on ~93 % of history; the backfill route had no button and no time bound | `/actions/backfill-trade-origin`, `origin-backfill.js` | a post-cutoff row with origin NULL (a write path's failure) would have been stamped `legacy_unattributed` and vanished into history |
| `'already_closed'` / `'closed at the broker …'` scored `exit_matched = 0` as `other` | `agent/services/trade-plans.js exitKind()` | a close the bot did not make was indistinguishable from an unexplained one |
| An adopted position wearing OUR label (a bot fill whose local row was lost) carried no strategy, plan or approval and was outside every check | `agent/services/reconciler.js` | the bot's own trade, filed as external |
| No invariant read the reason fields together | — | "unknown" could recur silently after four weeks of trading |

### 7.2 What now records a reason

- **Manual order** — `recordManualOrderTrade()` (exported from `actions.js`) writes `trades.strategy`, `trades.risk_event_id` (the id `persistRiskEvent` returns, now captured), the monitored row and a `trade_plans` row (`source: 'manual_order'`, planned entry = the estimate the gate sized on, the trader's stop and target). **m3:** the request's `strategy` is honoured only when it is a registry key (`manualOrderStrategy()` → `STRATEGY_KEYS`), else `manual_order`; never null. Route pin: `agent/routes/manual-order-plan.test.js` (4 tests; the older `order-cancel-account.test.js` pin re-pointed to `accountId: creds.accountId`).
- **Pending fill** — `persistFilledTrade` reads `row.strategy || <label's decoded strategy> || 'fib_618_fade'` (**m2**) for the trade, the monitored row and the plan; placement stamps `pending_orders.strategy`. `pending-orders.test.js` +3.
- **Deal-history resolver** — `resolveUnknownFromDeals(db, { accountId, deals, coverage, now })` over the ProtoOAGetDealListRes `deal` array (`wsGetDeals(...).deal`, the shape `pnl-backfill.js:291-295` pulls and `broker-history-import.js shapeDeals` persists): opening deals that FILLED (`dealStatus` FILLED / PARTIALLY_FILLED or absent — **M1**); matched by the intent tag in a deal's label/comment (`labelIntentId`) when a caller carries one, else by account + `symbol_id` (or symbol name) + side + a deal executed inside the send window — **from `created_at`** (the send) to `updated_at + DEFAULT_SENT_TIMEOUT_MS + 5 min` — whose `orderId` is not another intent's `broker_order_id` on the account (a limit's later fill is the limit's) and whose position's opening volume, summed over partial fills, equals the intent's volume when it carries one (**M1**). Match → FILLED with the position id, `resolution_source = 'deal_history'`. **No match → the row STAYS UNKNOWN whatever its age (B1: a capped pull cannot prove absence — `wsGetDeals` maxRows 500); there is no auto-REJECT and no `no_deal_in_window`.** The pull's window, count, matches and coverage are written after the original reason into `error_code` (`…; deal_history: N deal(s) pulled, K on this key in window A–B, none matched, coverage complete|partial|truncated or none, read T`) so the Unknowns block and the ledger view say what was looked at (**m4**). `settleUnknownsFromDealHistory()` pulls once per pass, only when the account holds an UNKNOWN, from the oldest UNKNOWN's creation, **follows `hasMore` pages from the last deal's timestamp up to `DEAL_PULL_MAX_PAGES` (20) and reports `truncated: true, coverage: null` past that** — coverage is a measured fact and is never acted on; a pull that throws settles nothing. Wired in `agent/loop.js` after `reconcileIntents` in the primary pass **and, per enabled other account, in the other-accounts sweep with that account's snapshot and id (M2)** — both pinned, comment-stripped. `entry-ledger.test.js` +8 (tag fill; window fill; M1's REJECTED-status / 5× volume / partial-sum / foreign-order cases; B1's stale-stays-UNKNOWN + `intent_unknown_stale` listing + m4 note; fresh stays; paging + truncation + never-rejects; m1; the two wiring pins).
- **Operator UI** — `EngineStatusPanel` gains an *Unknowns* block (`UnknownsList` presentational, `UnknownsBlock` container **taking the panel's account scope and filtering by the redacted last four; one fetch per scope — m5**): each UNKNOWN from `GET /state/entry-intents` with account last-4, symbol, side, age and error, a FILLED/REJECTED select, a reason field (≥ 3 chars, the route's own rule, refused locally before any post) and Resolve → `POST /actions/entry-intents/:id/resolve`; the ledger is re-read after every post. **m1:** `operatorResolve` accepts an optional `positionId` on FILLED (posted through the route) and it lands on the row. *Backfill trade origins* posts the dry run first and shows the plan's counts; *Apply backfill (N rows)* appears only after a plan and posts `{ apply: true }`. Helpers in `src/lib/unknown-intents.js`; spec `src/components/unknowns-block.test.jsx` (9 tests).
- **The invariant** — `findUnreasonedTrades(db, { sinceIso = '2026-08-17' })` in `close-completeness.js` over trades opened since the origin column's first write, status open or closed. Kinds: `origin_missing`, `origin_unknown`, `strategy_missing`, `plan_missing`, `risk_event_missing`, `close_reason_missing`, `plan_unscored`, **`backfilled_after_cutoff`** (M3: `legacy_unattributed` / `manual_broker` with `origin_source = 'backfill'` on a post-cutoff row), **`adopted_ours_unreasoned`** (M4: `reconciler_adopted` with our label — `isOurs(label_raw)` — and no strategy, plan or approval id), plus `intent_unknown_stale` (UNKNOWN older than `UNKNOWN_MAX_AGE_MS` = 4 h — listed, never rejected). Returns `trades` (the bot's own rows), `considered` (plus the adopted / backfilled rows read for M3/M4), `violations`, `counts`. Surfaced as the goal table's thirteenth goal `trade_reasons` (on_track at 0; off_track naming the kinds; not_measurable when there is no bot trade since the cutoff and no UNKNOWN — the note says this is a fact about trading volume, not a pass) and on the daily journal as `reasons: N violation(s) · closedByBroker: N`. `close-completeness.test.js` +2, `goal-table.test.js` +1 (counts 12 → 13 there and in `goal-table-routes.test.js`), `journal.test.js` +1.
- **Backfill bounded** — `planOriginBackfill` and `applyOriginBackfill` touch only rows with `opened_at < 2026-08-17` (NULL `opened_at` counts as pre-column); a plan forged with a post-cutoff id writes 0 rows (M3). `origin-backfill.test.js` +1.
- **Adopted bot fills stamped** — when the reconciler adopts a position whose label carries an intent tag with a ledger row on that account (`stampAdoptedFromIntent`), the trade gets `origin` by the intent's order type (`bot_market_dispatch` / `bot_pending_fill`), `strategy` from the label, `risk_event_id` = the nearest approved risk event on the same account/symbol/side in the five minutes before the intent was reserved (the gate runs before `reserveEntry`), and a plan from the intent's own stop and target (`source: 'reconciler_adopted_intent'`). Our label without a tag stays `reconciler_adopted` and is listed as `adopted_ours_unreasoned` (M4). `reconciler.test.js` +1.
- **Broker-made closes** — `exitKind('already_closed')` and `exitKind('closed at the broker …')` → `broker_closed`; no rule admits it; the journal counts `closedByBroker` apart. `trade-plans.test.js` +1.

### 7.3 What remains external-by-design (not a violation, not a gap)

- `reconciler_adopted` rows with a FOREIGN label, `manual_broker` and `external_system` rows carry no strategy and no plan: nobody here decided them. They are outside the invariant's population; the manual-order route's rows are `manual_broker` too and are checked by their own test, not by the invariant.
- A ProtoOADeal has no label field. The tag matcher fires only for a caller that annotates deals with the order label; in production the window matcher is the path, which is why the window starts at the send, not at the UNKNOWN stamp.
- An UNKNOWN with nothing in its window stays UNKNOWN at any age, on purpose: "no deal in what we pulled" is not "no deal". Past 4 h it is listed (`intent_unknown_stale`, the Unknowns block, the ledger view) for an operator who reads the broker's own history and resolves with a reason.
- The `risk_event_id` link on a stamped adoption is the nearest approval in the five minutes before the intent — provenance by proximity, recorded as such in the comment; a row with no approval in that window keeps `risk_event_id` NULL and is listed.
- The origin backfill is not run from this PR: it writes history and is the operator's click (dry run, then apply), per the route's own contract.

Not done here: no route was called, no production account was read, nothing was committed.

---

## 9. Follow-up — PR-D, direction is a stated reason (11-09-2026)

Dated follow-up per the plan's standing rule. PR-D implements §3.3 (principle 8) under the owner's decision "shorts on the momentum book under the 9/10 conviction floor with regime-gate alignment". Built on PR-B's `_all` momentum pass. Every behavioural change has a test that goes red when reverted.

| §3.3 row | Change | Test |
|---|---|---|
| no entry carries a direction reason | `direction_reason` set where each strategy assigns its bias (`donchian:close>hi20` / `close<lo20`, `va:close>vah` / `close<val` / `bullish_open>vah` / `bearish_open<val`, `ema:…`, `vwap:close>rising_vwap` / `close<falling_vwap`, `rsi2:close>sma100,rsi2<10` / `…>90`, `cup:` / `inv_cup:`, `fib:up_leg_retrace@<level>`, `fibconf:support_stack_N` / `resistance_stack_N`, `vp:val_reclaim` / `vah_reject`, `rsi:cross_up_30,trend_up` / `cross_down_70,trend_down`, `fvg:bull_gap_retrace` / `bear_gap_retrace`, `tsmom:long …` / `tsmom:short …` from the policy, `tick:break_high` / `break_low` on both oracles' signals and the sidecar's `signal` ring line as `dir=`); `synthesizeFibSignal` threads it; `autoTrade` puts `direction_reason` and `trend_at_evaluation` (the regime table's `{regime, trend_direction, computed_at, stale}` read at evaluation) on the proposal, so `persistRiskEvent` stores both in `proposal_json` | `direction-policy.test.js` (donchian / rsi2 / rsi_meanrev / vwap fire with the reason on both sides; a registry-wide comment-stripped pin that every strategy file sets it; `proposal_json` carries both fields; the tick oracle states `tick:break_high`), `tick-strategy.test.js` + `test_tick_strategy.cpp` (`dirReason` in the checked-in expected signals, both oracles agree) |
| `loop.js` `override_bias` flips with no reason | refused unless the watchlist item carries `override_reason` (a blank one is no reason): `decision_log` row `watchlist_override` / `direction_override_unreasoned override_bias=<side>`, `auto_trade` off, the strategy's side kept; a reasoned override flips the side and becomes `direction_reason: override:<reason>`; `override_reason` added to the watchlist's carried fields and the symbol-config route's allowed keys | `direction-policy.test.js` through the real `dispatchSymbolSignal` |
| `regime-gate.js:139-144` trend branch never read `trend_direction` | trend/breakout strategies (the momentum book included) are blocked AGAINST a fresh trending reading: `regime_block trend-vs-trend (<strategy>): <bias> trend signal against a <dir>-trending market`; aligned passes; quiet unchanged; an unknown direction on a trending regime fails open (unlike the fade branch); a stale row is no reading | `regime-gate.test.js` (a donchian short into a `trending`/`long` row blocked, aligned passes, quiet unchanged, DB-backed and fossil cases) |
| the 1.5× short rule lived only in the shadow | `agent/services/direction-policy.js`: `shortMinConviction` (ceil(longMin × mult), capped 10) lifted from the shadow, which now imports and re-exports it; `directionFor({ side, conviction, trendDirection, cfg })` → `{ ok, reason }` — a long needs the long floor, a short needs the short floor AND no up-trend reading; `permittedSides(trend)`; `regimes.trend_direction` holds `'long' \| 'short' \| null` (regime.js:129), so both that spelling and `up`/`down` are read | `direction-policy.test.js` (the shadow's function IS the policy's; the shadow refuses exactly what the book refuses) |
| `momentum-book.js` / `momentum-account.js` literal long-only | two-sided: shadow short rows and short holdings are read; a short is taken only when `directionFor` says ok (9/10 on the defaults, no fresh up-trend reading from `regimes`), priced at the bid, `consensus_bias: 'short'` → SELL, row `side = 'short'`, stop above entry; the trail moves a short's stop DOWN and never up (`trailStop`/`trailImproves` take a side); exits on the shadow's exit row or a dropped/flipped holding; adoption records the fill's own side; refusals are named in the pass summary (`short_rule: …`, `direction_against_trend: …`) | `momentum-book.test.js` (a 9/10 short enters as SELL with the stop above entry; 8 refused; against an up-trend refused; a down-trend agrees; a fossil reading does not block; the short trail falls and never rises; a rank exit closes it; reconcile re-proposes a held short under the same policy), `momentum-account.test.js` (the daily pass: a short row with SELL, 8 refused, up-trend refused, the shadow dropping it exits) |
| `tick-permits.js` no trend input | under a fresh trend reading the feeder withholds the against-trend side's permit (`direction_against_trend`), the ledger releases that side's standing row with `tick_direction_against_trend` (`reserveStandingPermits` entries may name `sides`); no or stale reading leaves both | `tick-permits.test.js` (up-trend → no SELL permit and the SELL row released; down-trend → no BUY; fossil → both) |

**A latent defect found by the first short trail test:** `trailStop` read `Number(prevStop)`, so a `null` previous stop was `0`; the long side's `Math.max(0, candidate)` hid it, the short side's `Math.min` would have taken 0 as the stop. Fixed (null is absent) — in the same change, since the two-sided trail is what exposed it. The same shape in `directionFor` (a null conviction read as 0) was caught by the checker's item (h) and fixed the same way.

**Independent checker's findings (11-09-2026), folded in:**
- BLOCKER — a shadow flip long→short landing in ONE book batch (the loop down for a shadow interval) coalesced `exit(long)` then `enter(short)` into the enter alone, so the exit was dropped and the long held while the shadow was short. Now an `enter` whose side differs from the open row's side exits that row FIRST (`rank exit (flip)`), then enters; the owed-exit sweep also fires on a last word `enter` on the other side. Pinned by the checker's counterexample ported into `momentum-book.test.js`, plus the refused-short and owed-flip variants.
- MAJOR 1 — the regime gate was NOT on the book's path (only `dispatchSymbolSignal` called it), so the earlier "two walls" claim in this section was false and the three private `trendReadingFor` copies hard-coded a 240-minute bound, ignoring `regime_gate_json`. Now ONE `trendReadingFor(db, symbol)` in `direction-policy.js` reads `loadRegimeGateConfig(db)` (age bound = `maxRegimeAgeMin`; gate OFF = no reading), used by the book, the account pass and the tick feeder; AND `checkRegimeGate(db, 'tsmom_long', side, symbol)` runs inside the book's `tryEnter` and the daily pass, writing a `decision_log` skip row (stage `regime_gate`) on a block — trend-in-quiet, the stale posture and the on switch now reach book entries. Tests: a quiet regime refuses a book long with the row; the off switch lifts it; the owner's 10-minute bound makes a 30-minute row a fossil.
- MAJOR 2 — regimes were computed only for symbols scanned in the last 6 h, so most of the momentum universe had no trend reading and the alignment was decorative. Now the quant phase computes regimes for `momentumUniverseSymbols(db)` as well (same code path), AND `directionFor` REFUSES a short with no fresh reading (`direction_no_trend_reading`) — "unknown is not a reading", the fade branch's own rule; longs are unchanged. Consequence stated plainly: with the regime gate switched off, no short is placed anywhere (the reading goes with the switch); a name outside the scan set and the universe gets no regime and therefore no short.
- MAJOR 3 — the registry-wide `direction_reason` pin could not fail for `fib_618_fade`, `cup_handle`/`inv_cup_handle`, `tsmom_long` (the string appears elsewhere in those files). Replaced by a function-scoped pin: each strategy's signal-building function's LAST `return {` block must carry it (`SIGNAL_FN` in `direction-policy.test.js`), plus `buildEntrySynth` behaviourally; each mutation (the field removed from that return) verified red before restore.
- Minors: (a)(b) the daily pass re-reads the open set after its exits, so a same-day flip exits the long and enters the short, tested; (c) the daily pass carries `bid` on the universe row and prices a SELL at it (tested: 2.899 not 2.9); (d) the watchlist override now runs BEFORE the regime gate so the gate judges the dispatched side, and a flip mirrors `sl`/`tp1`/`tp2` about the entry (tested: 108/121/126 → 115/102/97); (e) the book's and the daily pass's blocks are `decision_log` skip rows (PR-C's shape); the scan path's `trend-vs-trend` block in `loop.js` still writes the pre-PR-C `risk_events` veto in this branch (based on PR-B's commit) — the coordinator resolves that against `gate-skips.js recordRegimeBlock` at merge; (f) `momentumAccountReport` selects `side`; (g) the route refuses a blank `override_reason` (400; null clears), `WatchlistCompare` copies it, and an unreasoned override is logged and recorded ONCE per item (re-logged when the side or the reason changes); (h) a short's conviction must be a finite number — no fallback to the book's default, null reads as `?` and is refused; (i) the shadow's conviction is `round(strength × 10)` on an integer scale, so a rank ≤ 0.15 scores 8.5 → 9 and IS admitted by the floor — the floor is "9 on the integer scale", not "the weakest 10 %". Tick fills and adopted rows carry no persisted direction reason yet — the sidecar's ring line states `dir=`, but nothing writes it to `proposal_json` or the book row; PR-H.

**Not changed, stated:** the strategy key stays `tsmom_long` for both sides (the row's `side` says which; renaming the key would orphan every stage-matrix pin and evidence record). `readiness-register.csv` has no row about direction or side (TM-01/TM-04 cover the signal's dependencies and state machine), so it carries no PR-D note.

**Statistics note for the auditor — what the shadow's short rows show, and what to expect.** The shadow has logged short `enter`/`exit`/`refused` rows since #831 (`momentum_shadow`, `side = 'short'`, `reason LIKE 'short_rule%'` for the floor refusals); `momentumShadowReport(db).short` reads `{ entries, exits, refused, winRate, meanRetPct, sumRetPct, medianHoldH }` over the window and `refusedBy.short_rule` the count refused by the floor. The counts themselves are runtime, not readable here — this document was written from the repo, and no database was read. The auditor's read before the first live short: `GET /state/momentum-shadow` → `short.exits` ≥ 30 and `short.meanRetPct` beside `long.meanRetPct`; if the short leg has fewer than the 30-close verdict the long leg was held to, say so on the plan rather than letting the first short fill stand for evidence. The first live short is gated by conviction ≥ 9/10 (`shortMinConviction` on the shadow's stored config) AND a fresh `regimes.trend_direction = 'short'` for the symbol within the gate's configured age bound (`regime_gate_json.maxRegimeAgeMin`, 240 min default; no reading = no short) AND the regime gate itself (`checkRegimeGate` on the book's path); on the momentum account additionally by the vol-target size and the daily cadence. The read-back to expect in the log: `momentum book: short <SYMBOL> on …<last4> @ <bid> stop <above entry> (entered on shadow row <id>; tsmom:short conviction <c> ≥ 9 trend down)` (row-cursor accounts) or `momentum account: short <SYMBOL> on …<last4> @ <price> stop <…> <lots> lots (vol target; tsmom:short …)` (the daily pass); a refused one appears in the pass summary's `skipped` as `<account> <SYMBOL>: short_rule: conviction 8 < 9 (6×1.5)` or `… direction_against_trend: short into an up-trend (conviction 9)` or `… direction_no_trend_reading: …` or `… regime_block trend-in-quiet (tsmom_long) …` (the last also a `decision_log` row, stage `regime_gate`); the row in `momentum_book` carries `side = 'short'`, the trade `side = 'SELL'`, and `risk_events.proposal_json` carries `direction_reason` starting `tsmom:short` with `trend_at_evaluation`.

---

## 10. Follow-up — PR-G, the switch: human AND automatic (11-09-2026)

Dated follow-up per the plan's standing rule (principle 5). PR-G implements §3.4 / PR-G of `docs/owner-principles-plan-2026-09-11.md` under owner principle 2 ("prioritise for opportunities; the tick-based switch is on/off per account BY A HUMAN and AUTOMATICALLY by the bot"). Before it, `agent/loop.js` neither read nor wrote the entry mode, the only `action_log` actor had ever been `'owner'`, and the UI's Tick momentum button was hardcoded `disabled` under a stale P6 tooltip. The independent checker's round on the first build (seven counterexamples, `scratchpad/prg-counter.test.js`) is folded in below: each defect it proved is a regression test in the real suite now, named by its checker id.

| Item | Change | Test |
|---|---|---|
| The policy in the contract | `entryModePolicy: 'manual' \| 'auto'` on `EngineStatus` (`agent/lib/entry-contracts.js` `ENTRY_MODE_POLICIES`; `defaultEngineStatus` → `manual`; optional in the shape so a record written before PR-G still validates and `engineStatusFor` reads it back as `manual` — no account is handed to the bot by omission) | `entry-contracts.test.js`; `entry-mode.test.js` (absent field → manual) |
| The human's policy switch | `requestEntryModePolicy` (entry-mode.js): moves `configRevision` only, never the mode or epoch; a policy CHANGE clears the bot's memory for the account; `action_log` row at `/actions/entry-mode-policy`; `POST /actions/entry-mode-policy {accountId, policy, expectedRevision}` (409 on a stale revision); `entryEnginesView` exposes `entryModePolicy` | `entry-mode.test.js` |
| The seed | `agent/config/entry-mode-policy.json` `{ "_all": "manual" }` applied by `seedEntryModePolicyFromConfig` at boot (`agent/index.js`): once per content hash (`entry_mode_policy_seed_json`), `_all` expands to every enabled account, a per-id key wins, an account enabled later is seeded on its first boot; **on a content change only the ids whose DECLARED value moved are re-applied** (the previous map is kept in the seed record) — an operator's route-set policy on an untouched id stands (checker minor 9) | `entry-mode.test.js` (expansion, per-id, once, late joiner, changed-keys-only, the shipped file is all-manual) |
| The refusal | `requestEntryMode` refuses an `actor` starting `auto:` on a `manual` account — `policy_manual`, at the one writer | `entry-mode.test.js` |
| The human's switch is remembered | a HUMAN `requestEntryMode` (any actor not `auto:*`) writes the bot's memory `acct:<id>:entry_mode_auto_json`: `readyStreak: 0`, `blockedCycles: 0`, `humanOverride: { mode, at, epoch, actor }` (checker blockers 1 and 2: the first build let the streak grow through the "already TICK_MOMENTUM" and STOPPED holds, so a human's TIME_BASED was re-promoted on the next pass). The helpers live in entry-mode.js so the human route and the pass share one record | `entry-mode.test.js` (human zeroes and records; the bot's own switch does not); `entry-mode-auto.test.js` C-1, A-1 |
| The post-switch gateway, shared | `agent/services/entry-mode-gateway.js` `bindEntryModeGateway`: the route's post-switch block (forced guard push; VPO disarm for any mode but TIME_BASED; `markEntryModeBlocked` when the push is not made) extracted so the human route and the bot's pass bind the epoch identically; deps injectable | `entry-mode-gateway.test.js` (push ok binds + disarms with the account's own credentials; TIME_BASED never disarms; a failed push → BLOCKED; no credentials → BLOCKED; a throwing dep is reported; pin on the route's call and on the pass's CALL SITE, not its default parameter — checker note 11) |
| The automatic pass | `agent/services/entry-mode-auto.js` `evaluateAutoEntryModes` on the quant cadence (`loop.js`, every 6th loop, next to the regime; log `[entry-mode] auto: …last4 promoted/demoted/held (reason)`). Roster: EVERY registry account whose policy is `auto` — not the autopilot roster, so an account that left it (autopilot off, manage-only) is still demoted while `tickEntryAccountsFor` lists it (checker R-1); promotion additionally needs the autopilot roster. PROMOTE → TICK_MOMENTUM needs, in order: no standing human override (the human's last switch is not promoted past for `HUMAN_OVERRIDE_COOLDOWN_H` = 24 h or until the human changes mode or policy); `AUTO_PROMOTE_CYCLES` = 3 consecutive ready evaluations (`tickReadinessFor` clean AND `validationStage ∈ TICK_ENTRY_STAGES`), consecutive by TIME — a previous evaluation older than `STREAK_MAX_GAP_MS` = 90 min resets the streak and the held reason says so (checker A-2), the streak does not advance while STOPPED (checker A-1), one failing evaluation zeroes it; the side's last guard push and probe succeeded (`exec_guard_sync_last_error_json` for the side, `<side>_health_json` ok/dormant); the opportunity rule below. DEMOTE → TIME_BASED on ONE failing evaluation of an account in TICK_MOMENTUM. A promotion of the bot's own that stays BLOCKED for `AUTO_BLOCKED_CYCLES` = 2 passes is taken back to TIME_BASED by the bot and logged (`detail.why = blocked_after_auto_promotion`); BLOCKED under a human's epoch is held (checker C-2). HOLD otherwise: already in the target mode, STOPPED by a human (never lifted), WARMING / QUIESCING / RECONCILING. Every switch goes through `requestEntryMode(db, id, mode, { actor: 'auto:readiness', readiness, detail })` — the readiness re-check, revision, ack protocol, drain and `action_log` row apply unchanged — then `bindEntryModeGateway` | `entry-mode-auto.test.js` (13 tests: promotion; demotion; C-1; A-1; A-2; manual never touched; hysteresis; B-1 + opportunity; B-2 + the real counter; R-1; C-2 + side health; the writer's own refusal; the loop pin) |
| **The opportunity rule, as built** | over the last `OPPORTUNITY_WINDOW_H` = 24 h: `tickShadow` = `cpp_decisions` rows with `component = 'tick'`, `kind = 'signal'`, `side` = the account's sidecar side IN THE HEARTBEAT'S VOCABULARY (`sideForAccount` — the writer of `cpp_decisions.side`; one collapsed sidecar is `cpp_exec` for every account, where readiness would have said `cpp_exec_demo` — checker note 14), whose `detail` opens with `shadow` (the sidecar's TAKEN outcome; `shadow_cost` / `shadow_busy` are refused offers and do not count), **windowed on `ts_ms`** — the sidecar's own clock — because `at` is the ingest time (checker minor 8; a row with no `ts_ms` is not counted); `timeApprovals` = `risk_events` rows with `approved = 1` and the account's `account_id`, **compared as `datetime(created_at)` against a `datetime()` bound** because risk.js writes ISO text (checker major 4: a raw text compare against a sqlite-format bound counted every row on the since-day), counted by DISTINCT `opportunity_key` (a keyless row counts as itself) so a setup re-scored eight times is one opportunity (§70.8). Promote only when `tickShadow ≥ max(MIN_TICK_SHADOW = 1, timeApprovals)` — 0 ≥ 0 does not promote (checker major 3) and the minimum is named in the held reason. Both counts, the minimum, the window and the side travel on the action row | `entry-mode-auto.test.js` B-1, B-2 |
| UI | `src/components/EngineStatusPanel.jsx`: the Tick momentum button is `disabled` on the LIVE readiness predicate (`!readiness?.ready`, or already requested, or no full id) with the server's blockers in its title, and enabled it posts `/actions/entry-mode` like the other two; the panel's closing sentence no longer claims P6 does not exist (checker note 13); `src/components/EntryModePolicySwitch.jsx` (new) renders the server's `entryModePolicy` and posts `/actions/entry-mode-policy` with the row's `expectedRevision` through `src/lib/entry-mode-policy.js` `submitEntryModePolicy`, then `refreshEngineStatusAfterAction` (new in `use-engine-status.js`: waits for a poll already in flight, whose answer predates the post, then fetches again — checker minor 10) | `src/components/entry-mode-policy-switch.test.jsx` (5 tests) |

Deviations from the plan text, stated: (1) the plan wrote "exceeds" for the opportunity rule; the build uses "at least" (`≥`) with a floor of one taken signal — a tick path matching the time path is not a reason to keep the account off it, and a quiet account with nothing on either side is not promoted on the strength of nothing. (2) The bot never promotes an account a human has STOPPED, and never past a human's TIME_BASED for the cooldown: the plan's rule names readiness and opportunity only, and the human's switch is the human's. (3) The stage test in the pass (`validationStage ∈ TICK_ENTRY_STAGES`) duplicates readiness's `validation_stage` check on purpose: the pass is the thing that promotes, so it names the bar itself rather than trusting one field of an injected verdict.

**Mutation checks, as run (CLAUDE.md failure mode #1: the needle is grep-counted before and after; a mutation whose count did not move is reported as not landed, not as passed).** Each line: the mutation, the grep needle with its before → after count, and the red result.

| # | Mutation | Needle | Count | Result |
|---|---|---|---|---|
| M1 | `EngineStatusPanel.jsx`: the Tick button's `disabled={…readiness?.ready…}` → hardcoded `disabled` | `readiness?.ready` | 1 → 0 | vitest 1 failed |
| M2 | `entry-mode.js`: the `policy_manual` refusal → `if (false)` | `startsWith('auto:') && cur.entryModePolicy` | 1 → 0 | 1 fail |
| M3 | `loop.js`: `await evaluateAutoEntryModes(db)` → `({ lines: [] })` | `evaluateAutoEntryModes(db)` | 1 → 0 | 1 fail (loop pin) |
| M4 | `entry-mode-auto.js`: the not-ready `auto.readyStreak = 0` → no-op | `auto.readyStreak = 0` | 3 → 2 | 2 fail (hysteresis, demotion) |
| M5 | `entry-mode-auto.js`: `Math.max(minTickShadow, timeApprovals)` → `0` | `Math.max(minTickShadow, counts.timeApprovals)` | 1 → 0 | 1 fail (B-1) |
| M6 | `entry-mode-auto.js`: the roster's policy filter AND the inner `!== 'auto'` skip both removed (each alone is covered by the other) | `entryModePolicy === 'auto')` / `!== 'auto') { out.manual` | 1 → 0 / 1 → 0 | 10 fail |
| M7 | `entry-mode-gateway.js`: `markEntryModeBlocked` on a failed push → `if (false)` | `sync.error \|\| !sync.pushed` | 1 → 0 | 1 fail |
| M8 | `entry-mode.js`: an absent policy reads `'auto'` | `stored.entryModePolicy : 'manual'` | 1 → 0 | 1 fail |
| M9 | `entry-mode.js`: the human-switch memory write → `if (false)` | `if (!String(actor).startsWith('auto:')) {` | 1 → 0 | 3 fail (C-1, A-1, the hook test) |
| M10 | `entry-mode-auto.js`: the human-override hold → `if (false)` | `ho && ho.mode !== 'TICK_MOMENTUM'` | 1 → 0 | 1 fail (C-1) |
| M11 | `entry-mode-auto.js`: the time-gap streak reset → `false` | `nowMs - lastAt > streakMaxGapMs` | 1 → 0 | 2 fail (A-2, C-1's post-cooldown fresh streak) |
| M12 | `entry-mode-auto.js`: `datetime(created_at) >= datetime(?)` → raw `created_at >= ?` | `datetime(created_at) >= datetime(?)` | 1 → 0 | 1 fail (B-2: the sqlite-format row on the since-day dropped) |
| M13 | `entry-mode-auto.js`: the `ts_ms` window → always true | `ts_ms IS NOT NULL AND ts_ms >= ?` | 1 → 0 | 1 fail (B-2) |
| M14 | `entry-mode-auto.js`: the policy roster → `registryAutopilotAccounts` | `autoPolicyAccounts(db)` | 2 → 1 | 1 fail (R-1) |
| M15 | `entry-mode-auto.js`: the BLOCKED take-back → never | `auto.blockedCycles < blockedCycles` | 1 → 0 | 1 fail (C-2) |
| M16 | `entry-mode-auto.js`: the side-health refusal → `if (false)` | `if (!hs.ok) { finish` | 1 → 0 | 1 fail (C-2) |
| M17 | `entry-mode-auto.js`: the streak advanced inside the STOPPED hold | `=== 'STOPPED') { finish` | 1 → 0 | 1 fail (A-1) |
| M18 | `entry-mode.js`: the seed's changed-keys filter → re-apply all | `declared(seeded.accounts, id) !== String(v)` | 1 → 0 | 1 fail (minor 9) |

The checker's own file, run against the fixed worktree: C-1, A-1, A-2, B-1, R-1 and C-2 (which assert the defects) now fail; B-2 (which asserts the correct count) passes.

Runtime today: the shipped policy is `manual` for every account, so the pass logs `no account under policy auto (N manual on the roster)` on each quant cycle and writes nothing; flipping an account to `auto` (the panel's switch, or the JSON) puts it under the rule, and until PR-H's thresholds make `SHADOW_PASSED` reachable no account can pass the stage bar, so no promotion is possible yet — the demotion half is live from the first `auto` account in TICK_MOMENTUM. Known limit, stated: readiness's own `sideFor` still names the demo side `cpp_exec_demo` for its `<side>_tick_json` read even when one collapsed sidecar is probed as `cpp_exec`; the pass no longer depends on that name, but the readiness check does — a separate defect, not widened here.

---

## 11. Follow-up — PR-F, nothing fake on the website (11-09-2026)

Owner principle 6 ("the website shows no fake result; UI switches are
logic-built, not for show") and principle 4 (the twelve attribution reads).
Every decorative or half-wired control named in the plan's §3.5, what was
measured, and what it became. Built on `8e19800` (main + PR-B).

| Control (plan §3.5) | Measured at HEAD | Now | Test (red when reverted) |
|---|---|---|---|
| `TradeCockpit.jsx:311,313` Manage / Close, no `onClick`; Close "queues for next open" | confirmed: two `<button>`s with no handler, the title a false claim | `src/cockpit/CockpitActions.jsx` — rendered only for a bound position; Manage opens `PositionManager` (portalled, same overlay as `StdTradeTable`); Close confirms `symbol side lots` and posts `/actions/position-close` with the deep link's account; on a closed market Close is disabled, title "market closed — a close is refused by the broker until it opens" | `src/cockpit/cockpit-actions.test.jsx` (static render: hidden without a position, disabled + honest title when closed; source pin: no `queues for next open`, no `4 * 60 + 23`) |
| `TradeCockpit.jsx:174` "opens in 4h 23m" | confirmed: `Math.max(1, 4 * 60 + 23 - minuteTick)`, demo route only after an earlier fix, but the demo pill still counted down a fabricated time | `agent/routes/state.js` cockpit route now serves `position.nextOpenAt` from `nextOpenInfo` (symbol-hours schedule; null for heuristic symbols); `src/cockpit/cockpit-session.js` `sessionLabel` → "MARKET CLOSED · opens (dd hh:mm) · in Xh Ym" from that timestamp, "MARKET CLOSED" without it, "HKEX CLOSED" on the demo route — no countdown anywhere without a served time | same file: `opensIn`/`sessionLabel` cases |
| `TradeCockpit.jsx:717` fleet chips `role=button` "(mock)" | confirmed | plain labels, no pointer, no click claim (no cockpit switch is wired) | source pin in `cockpit-actions.test.jsx` |
| `cockpit-data.js:638` chart + VP synthetic under a real position | confirmed — and wider than the plan said: the risk budget read the demo account (`$184,920` / `$3,698`), the legs were dated demo legs, traffic / armed actions / invalidation / rates / WX fell back to the demo generators whenever the snapshot lacked them, MFE/MAE were "extremes since the modal opened" | `realChart()` renders the snapshot's served bars + indicators (`cockpit-bars.js`, PHASE 3) in the same view-model keys; no bars → "no chart data for this position — bars <status>: <server detail>" on the MFD, PRICE·tf and VP panes; demo overlays (terrain bands, waypoint circles, dashed plan) gated to the demo route; risk budget from `snapshot.account` or `—` with the fuel gauge withheld; legs from opened-at / first armed action / TP rail; real + no snapshot → NOT LOADED per panel; `DEMO DATA` pill demo-route only; `'0002.HK'`, `DEMO_FLEET`, HKD, 'Fibonacci 61.8% Fade' defaults demo-route only | `src/cockpit/cockpit-frame.test.js` (18 new/rewritten cases: real bars → 30 real candles, one tf band, POC from the served profile; unavailable → empty state with the server reason; no snapshot → NOT LOADED; fleet/MFE/risk/legs honesty; the demo route unchanged) |
| `PositionManager.jsx:230` / `OrderManager.jsx:101` disabled Modify | confirmed | removed; copy says why (no route) | `src/components/position-manager.test.jsx` |
| `PositionManager.jsx:113-118` pips 10/15/3 shown as settings | confirmed | empty until `/actions/position-guard-get` answers (`src/lib/position-guard-form.js`); "(not set)" labels; status line reading/stored/not set/not monitored/failed; an ON rule with empty pips refused at apply | same file (SSR first render, mapping, blocker, source pin on the defaults) |
| `Tune.jsx:3759-3761` RSI/VWAP/FVG "honoured by the manual routes only — `agent/loop.js` never reads them" | **the plan's claim is wrong at HEAD**: `loop.js:3511` `scanFilterOptions(db, getState)` reads `fib_*_filter` (trade cell on → annotate mode), spreads it into `runFibScan` (`loop.js:3544`), `computeFibSignal` records `filters_failed`, `tradeStageGate` (`loop.js:1424`, and the roster union at `:1185`) refuses and writes a `decision_log` row | nothing to wire; the chain was unpinned across four files | `agent/loop-confluence-filters.test.js`: VWAP ON refuses the fixture candidate naming the filter, OFF admits; RSI likewise; comment-stripped pin of both loop call sites — deleting `...stageFilterOpts,` from the `runFibScan` call turns it red (mutation run, 3 pass / 1 fail, restored) |
| `Tune.jsx:3458,3488` arm-benchmarks "writes a key nothing reads" | partly wrong: `GET /state/arm-benchmarks` (`state.js:4136`) reads it; no PAGE read it, the loop does not | **kept and given its reader**, per the route's own comment ("persist the backtest stats that justified the current arming, so Monitor can compare live results against them — the reality gap"): Tune loads `/state/arm-benchmarks` and prints the stored pairs beside the armed line (`src/lib/arm-benchmarks.js`). Not made a loop input — it is a comparison record, not a gate, and nothing in the code asks the loop to read it | `src/lib/arm-benchmarks.test.js` (shaping + source pin that Tune fetches and renders it) |
| twelve attribution endpoints, read by no page | confirmed (grep of `src/`) | `/reasons` (`src/pages/Reasons.jsx`, Trading nav group + phone More sheet): each endpoint with its own fields, arrays of objects as tables with the rows' own columns, per-block "not read — <reason>" on 401/network/500; no client-computed numbers | `src/pages/reasons.test.jsx` (two blocks from fixtures, the error state, the twelve routes declared in `state.js`, route + nav registered) |
| `docs/ui-control-inventory.md` stale at `16defbd` | confirmed | re-derived from HEAD by `scripts/ui-control-inventory.mjs` (116 action call sites, 79 state reads; **WIRED 116 · HALF 0 · DECORATIVE 0**); the Phase-A a11y register is superseded, not carried | `src/lib/ui-control-inventory.test.js` re-parses the table against `agent/`; mutations run: a row flipped to HALF → red, a row deleted → red |
| `npm run audit:ui` renders with no agent (failure mode #3) | confirmed: `?trade=` routes rendered the cockpit with no position, so the header actions and the sheet were never measured | the audit answers the cockpit snapshot and `position-guard-get` from `scripts/fixtures/cockpit-snapshot.json` on routes carrying `?trade=`, clicks Manage, opens Stop & Target and fails the run if the button, the sheet or the fixture-filled guard is missing; `/reasons` and `/desk?trade=1&tdb=1&tacct=1` added to the route list (quoted — the `&` was being eaten by the shell) | the audit itself: first run reported "bound-position route rendered no Manage button" (the identity params had been split off by the shell; then `agentConfigured()` wanted a secret) — both fixed, then green |

**`npm run audit:ui` result (11-09-2026, this worktree):** exit 0 across 9
routes × 6 widths (54 combinations), no page error, no duplicate singleton,
FAB ok on every route that mounts one. The bound-position route reports the
same `minFont=7` and one `WIDE: SPAN.` as the untouched HEAD build measured
on the same route (the cockpit's ruler labels and 7px chart annotations —
pre-existing, printed, not failing, and not this PR's subject).

**Plan text corrected:** §3.5's "agent/loop.js never reads them" and
"arm-benchmarks writes a key nothing reads" are both wrong as measured
above; the plan file carries a dated correction pointing here (principle 5).

### 11.1 Checker round (11-09-2026) — findings on the PR-F diff, each fixed

| # | Finding | Fix | Test |
|---|---|---|---|
| B1 | SPD / VSI / HDG were `wv()` sine generators under a real position (tick 0 "+1.90 / CHOP / TP 4.0h", tick 7 "−0.32 / BULL 46 / TP 21h"), and the first pass had removed the DEMO DATA pill that at least flagged the cockpit — the sentence "nothing renders demo under a real position" in §8 above was **wrong** | each instrument is derived from a served input or withheld: SPD = last two served bars ÷ timeframe minutes (pips at the price's dp), VSI = R since open ÷ hours since `position.openedAt`, HDG = EMA9 − EMA50 at the last served bar in risk units; unserved → `—`, no ETA, no BULL/BEAR/CHOP, needle at rest; `spdSource` / `vsiSource` / `hdgSource` name the reason | `cockpit-frame.test.js`: real with and without a snapshot identical at ticks 0/7/13 and digit-free; with served inputs `+2.00` / `+0.25` / `BULL 50` by hand arithmetic, still tick-invariant; the demo route still generates |
| M1 | cockpit Close posted `account` only when `?tacct=` was present; `/actions/position-close` fell back to the PRIMARY creds, `/actions/position-protect` used `getCtraderCreds(db)` for every position; the sheet's six posts carried no account; deleting the account spread left 44/44 green | routes: body `account` wins (`accountSource: 'body'`), else `credsForPosition` (the position's own trade / monitored row), reply echoes `accountId` + `accountSource`; the cockpit REFUSES Close (disabled, named reason) when the deep link has no account; `PositionManager` wraps every position post in `withAcct` and Desk/Accounts hand the row's account to the sheet | `agent/routes/position-account-routing.test.js` (a position recorded on account B with no account in the body resolves to B's creds, `accountSource: position_record`; source pins on both routes and on the six sheet posts); `cockpit-actions.test.jsx` `sendClose` posts `{ positionId, account }` and posts nothing without an account |
| M2 | "DECORATIVE 0" was unfalsifiable — only `'/actions/…'` literals became rows | second pass in the generator over `<button>` / `<Button>` / `role="button"` tags: bare `disabled`, no handler, a title claiming an action ("queues for next open", "(mock)"), or an `onClick` that only sets local `useState` nothing reads → DECORATIVE rows; named exceptions in `DECORATIVE_ALLOWLIST` (one today: `EngineStatusPanel.jsx` Tick-momentum's hardcoded `disabled`, PR-G's file); heuristic read-backs are labelled `(heuristic)` | `ui-control-inventory.test.js`: a probe page with the three patterns comes back DECORATIVE ×3 through the same `collect()`; real controls (submit, conditional disabled, template titles, lib setters) are not flagged; a stale allowlist entry fails |
| M3 | the countdown pin used 10:00 → 14:23 so `'4h 23m'` hard-coded would pass | cases now 1h 5m, 27h 0m, and a past timestamp → plain "MARKET CLOSED" | `cockpit-actions.test.jsx` |
| M4 | Close/Manage wiring pinned by text only (`onClick={undefined}` stayed green) | `CockpitActions` is invoked as a function and the Close element's real `onClick` is fired (once per click; inert while busy / closed / refused); the cockpit's close is a pure `sendClose({ managed, accountId, marketClosed, closing, confirm, post })` tested with a stub post — body `{ positionId, account }`, second click while closing guarded | `cockpit-actions.test.jsx` |
| minor | `state.js` cockpit bars fetch used the primary creds + shared symbol map for every account's position | the snapshot's own account (`credsForAccountId`) and `resolveSymbolId` on that account; the error names the account's last 4 | covered by the existing route shape; no unit test (inline handler) |
| note | with no snapshot and no `marketOpen` on the bound facts, Close stays enabled on a closed market and the broker's refusal surfaces as the toast | stated in a comment at the call site; the disabled state appears once the snapshot's `market_open` arrives | — |

**Not done, with reason:** the cockpit still has no route to *switch* to
another fleet position (the chips are labels); the size-amend route behind
the removed Modify buttons does not exist (the copy says so); the Reasons
page renders whatever the twelve endpoints return and therefore inherits
their bearer-token 401 on the deployed agent (PR-H's named blockage) — it
shows that per block rather than an empty page.

---
## 12. Follow-up — PR-H, blockages addressed, not carried (owner principle 3), 11-09-2026

Dated follow-up per the plan's standing rule. PR-H implements §4 PR-H of `docs/owner-principles-plan-2026-09-11.md` under the owner's decision of 11-09-2026 ("use the proposed defaults"; CLAUDE.md "Owner principles", decision on thresholds). Built on `2c84d8a` (#900, PR-G). Account ids last-4 only. Every item below names the test that goes red when it is reverted; the mutation table at the end counts each needle before and after.

### 12.1 What was built

| Plan item | Change | Test |
|---|---|---|
| The thresholds (all null → set) | `agent/config/tick-validation.json`: `replay { minTrades 40, minProfitFactor 1.3, maxDrawdownR 8, minExpectancyLowerR 0 }`, `shadow { minSignals 200, minHours 48, minTrades 30, minLosses 8, minProfitFactor 1.3, minExpectancyLowerR 0, maxDrawdownR 8, maxResetSharePct 20 }`, `traded { minTrades 30, minProfitFactor 1.3, maxDrawdownR 8 }` — the owner's numbers, not proposals; the `_note` records the decision and the key mapping. **Plus one key the owner did not list, named here for the owner's word (checker M-3):** `replay.minTestTrades 10` — a sample floor on the TEST block (a quarter of `minTrades`). It only tightens the bar: without it a two-trade test block passed on a bootstrap over two numbers, and a zero-trade block with a pasted figure passed `REPLAY_PASSED` outright. The importer refuses `test_block_too_small` when the test block's `trades` is not a finite number ≥ 10 (a block with a figure but no count is refused too). No stage answers `thresholds_unset` any more; a null anywhere still refuses that stage (the ask-first rule is code, not gone) | `tick-validation.test.js` "PR-H: the checked-in thresholds file carries the owner's exact numbers" (deepEqual on the raw file AND on `loadThresholds()`; the old key absent; an injected null refuses with nothing written) |
| **Key mapping (judgement call, stated)** | The code read `replay.minTestNetR` (the test block's net R) and had no expectancy floor; the owner's four replay thresholds name an expectancy lower bound and no net-R floor. `minTestNetR` is REPLACED by `minExpectancyLowerR`, judged on the same TEST block (the out-of-sample block, plan §7): the bootstrap 5th percentile of that block's trades' R. It is the stricter of the two (a lower bound ≥ 0 implies the block's mean ≥ 0 on the resample) and keeps the structural guard the old key carried — a research trial whose test block is withheld (`includeTest` unset) has no figure and cannot pass, and a trial imported before the replayer wrote the figure reads null and cannot pass either: it is re-run, not waved through. `trades`, `profitFactor` and `maxDrawdownR` read the trial's whole summary as before. The bootstrap moved from `services/tick-shadow.js` to `lib/tick-replay-sim.js` (`expectancyLowerR`, re-exported by tick-shadow) so the replay stage and the shadow stage judge by ONE statistic; `summarize()` now writes `expectancyLowerR` on the summary and on every unsealed block | same file: "PR-H replay stage against the file's exact numbers" — 40 / 1.3 / 8 / 0 pass at the boundary, 39 / 1.29 / 8.01 / −0.01 each fail alone, a withheld test block fails on `expectancyLowerR` with `withheld: true`, an old-shape trial (test block with `netR` only) fails, `profitFactor: null` fails; the replayer's blocks carry the figure and a withheld block does not |
| Per-stage fixtures against the exact numbers | shadow: 200 signals over 50 h and a 30-trade book with 8 losses (PF 2.75, DD 1R, lower bound > 0, resets 0 %) passes; 7 losses fails `['losses']`; 199 signals fails `['signals']`. traded: 30 own tick closes (PF 4) pass; 29 fail `['trades']` — nothing written on any refusal | same file: "PR-H shadow and traded stages against the file's exact numbers" |
| `replayChecks` exported | the replay stage's four checks as a pure function over a ledger trial, so the research route reports a verdict without moving a stage | used by both tests above and by the research-run tests |
| **Replay research as an operator action** | `agent/services/tick-research-run.js`: `listSegments` / `loadSegments` / `runTrials` / `stageAGrid` (the decoder and the twelve-point grid, moved out of `scripts/tick-research.mjs`, which now calls them — one decoder, not two), `replayFiles` (the pure CPU half), `tickResearchAction` (the same pipeline in-thread, for the script and tests) and **`startTickResearchJob`** (checker M-1: the replay measured 48.8 s on the event loop for a 200k-quote / 4-symbol grid, so the route runs it in a `worker_threads` Worker — `tick-research-worker.js` — ONE job at a time). `POST /actions/tick-research { stageA?, params?, sim?, includeTest?, symbol?, dryRun?, note?, maxSegments? }` answers **202 `{ jobId, poll }`**; `GET /state/tick-research-job?id=` carries `state` running/done/failed and, when done, the same result body the in-thread action returns (`trialIds`, each trial's `replay` verdict, `passing`, `inserted`); a second POST while one runs is **409 `research_running`**; a directory over **`MAX_RECORDS` 5,000,000 (from file sizes, no decode) is 413 `too_many_records`**. **`maxSegments` (added 20-09-2026)** bounds one job to the OLDEST n sealed segments — the same end `syncSegments` pulls, so the pulled set and the replayed set are the same segments — and the record cap is then applied to that slice, which is what makes the stage reachable at all on the demo deployment (measured 20-09-2026 01:54 UTC: 4 sealed 64 MiB segments = 6,710,880 records against the 5,000,000 cap, refused on every call, with a remedy — "copy a subset to `TICK_SEGMENTS_DIR`" — that named a door the keeper cannot open; `/state/tick-research` read `trials: []` and every account failed `replay_evidence`). It must be a whole number ≥ 1 or the request is **400 `bad_max_segments`** naming the value — never coerced to "replay everything". Both 413s (the local directory and the sidecar pre-flight) now name `maxSegments` and how many segments fit, measured from the sizes; a bounded request whose slice is still over the cap is refused from the LISTING, before a byte moves, the same as an unbounded one — **when the sides list per-segment sizes**, which the keeper's own `listAllSides` always does; a listing without them skips the bounded pre-flight by design (the cap is still enforced by `admit` after the pull) and says the remedy could not be measured rather than naming a guessed number. The 202, the polled job, the result body and the persisted trial manifest all carry `maxSegments` / `segmentsAvailable` / `segmentsDropped`, with `segmentsAvailable` taken from what the sides LISTED rather than from the cache the bound filled, and a segment that failed to pull is named on both the 202 and the job (`segmentsFailed`). `scripts/tick-research.mjs --max-segments <n>` is the same validator and the same slice **through the same function**: the script calls `replayFiles`, so the two doors write the same manifest and content-key the same evidence to the same trial id (checker, 20-09-2026: they did not — 932c7a86ea1c82effd67 against 088c4dff91b8292437fa over one slice — so a script trial could not say it was bounded and a re-run through the other door was not recognised as the same run). Trials are imported on the main thread through `importTickTrial` (content-keyed, so a re-run duplicates nothing); `dryRun` judges and writes nothing; `note` is stored capped at 500 characters with `noteTruncated` in the reply (checker m-3). **409 `{ error: 'no_segments', where }`** when the env is unset, blank, names a missing or empty directory, or the files decode to no valid quote event — never a fabricated trial, and no worker is started on a refusal. The stage still moves only through `POST /actions/tick-validation` | `tick-research-run.test.js` (a planted-fixture segment encoded with `lib/tick-segment.js` `encodeHeader`/`encodeRecord`: the segment path replays the SAME trades as the in-memory fixture; 409 for unset / blank / missing / empty / junk with zero rows written; the stage-A run imports 12 trials once with verdicts, a symbol filter that matches nothing is 409, the engine record is untouched); `tick-readiness-routes.test.js` over a real express app (409 with `where` naming the demo sidecar volume, `TICK_SEGMENTS_DIR` and the script; 202 with a segment directory, the job polled to `done`, the trial visible on `GET /state/tick-research`, 404 on an unknown job id; **and the M-1 test: a 300,000-quote segment posted, a second POST 409 `research_running`, `GET /health` on the same app answering under 100 ms while the job is still `running`**); `tick-research-run.test.js` M-1/M-2/m-3 tests (the job in-process with a 5 ms timer's lag under 100 ms, `no_segments` before any worker starts, a worker file that cannot load leaves no lock; 50k quotes + 50k repeats loading well under a second with every repeat carrying the nearest earlier quote's sides — the first fix was a reverse scan per repeat, 9.3 s on 40k + 40k, checker M-2; the 413 cap from file sizes on both the action and the job; the note cap) |
| Defect found by the fixture, fixed (script path) | the script pushed an identical REPEAT record with `bid: null, ask: null`; the oracle's null-side check precedes its repeat check (`tick-strategy.js:94-95`), so every repeat RE-WARMED the strategy — measured: 1 trade over the segment path against 2 in memory on the planted fixture. A repeat now carries the last quote's sides (that is what makes it a repeat) and counts nowhere. Any trial the script produced before this over real segments under-counted setups; none can have reached the production ledger through the keeper's own path (the segments were never reachable from it), and whether the owner imported script output by hand is NOT verifiable without the bearer token — a hand-imported pre-PR-H trial would also fail the new `expectancyLowerR` check (no figure) and so cannot pin a profile | `tick-research-run.test.js` "the segment path replays the same trades as the in-memory fixture" (RED at 1 ≠ 2 before the fix) |
| RECORD → SHADOW | `agent/config/tick-observation.json` `accounts._all`: `RECORD` → `SHADOW`. The seed rule (`seedTickObservationFromConfig`) applies once per CONTENT HASH: a changed file re-applies to every enabled account, a per-id key winning, an operator's earlier OFF overridden (the file is the owner's word), a disabled account untouched, an account enabled later reached on its first boot — so the switch reaches every account at the next boot, not only new ones | `entry-mode.test.js` "PR-H: the file moving _all RECORD → SHADOW re-applies at the next boot to EVERY enabled account" (RED if a reached account is skipped on a content change); the pins on the checked-in file in `entry-mode.test.js` and `one-account-model.test.js` moved to `{ _all: 'SHADOW' }` |
| **The window that could never open (found while checking the switch, fixed)** | `shadowWindow` opens at the FIRST SHADOW switch AFTER the profile pin. With the file seeding SHADOW at boot, the switch predates the pin on EVERY account, so `SHADOW_PASSED` would refuse `shadow_switch_unrecorded` for ever unless an operator re-posted the switch by hand after each pin — a blockage the RECORD → SHADOW move would have built. Now a successful `REPLAY_PASSED` import on an account already in SHADOW writes the window's opening row itself (`action_log` `/actions/tick-observation`, actor `tick-validation:pin`, at the pin's own second) — a time no operator chooses, so no losing stretch can be excluded by it (the Statistics auditor's concern (b) is preserved: a later switch away still breaks the window, and a re-post cannot move `first`). Also fixed: `shadowWindow` compared the pin's millisecond ISO against `action_log.at` at seconds, so a switch in the pin's own second sorted BEFORE the pin; and (checker m-1) a switch AWAY in the same second as the opening row was invisible to the `at > first.at` string compare — the break is now found by `action_log.id` order | `tick-validation.test.js` "PR-H: an account already in SHADOW when the profile is pinned … has its window opened BY THE PIN" (RED if the row is not written; the window's `since` equals the pin second; the OFF-after-pin case still `shadow_window_broken`; an account not in SHADOW at the pin gets no row; a refused pin writes nothing) |
| Readiness remedy | `replay_evidence`'s remedy names `POST /actions/tick-research` (and the script beside the spool as the alternative). Checker m-2: on a sidecar whose stored `/tick-status` is `enabled: false` (no `TICK_SPOOL_PATH`), `shadow_strategy_running` and `profile_matches_sidecar` are classed `infrastructure` with the remedy "set TICK_SPOOL_PATH on that sidecar (ask-first, TM-27)" instead of "check the next probe" — a switch that can never converge is not an integration defect | `tick-readiness.test.js` "PR-H checker m-2" (the no-spool remedy on a live account; the probe remedy kept when a spool exists) |

### 12.2 What SHADOW costs, and where it cannot run (measured in `cpp-exec/src/main.cpp`, read-only)

- **Cost.** SHADOW is a per-sidecar switch: `exec-guard-sync.js:161-162` derives the side's `tickShadow` from ANY account on that side in SHADOW, so `_all: SHADOW` puts the whole demo sidecar in shadow at the next guard push. The workers already exist when the recorder does (`main.cpp:254-337`: `TICK_WORKERS` threads, default 2, built inside `if (tickRecorder)`); SHADOW adds, on those threads, one `TickMomentumStrategy` + one `ShadowBook` per carried symbol fed every classified event, the signal ring line per signal and the shadow ledger the keeper pulls. Nothing is placed (`tickEntryAccounts` is empty until a human or PR-G's rule puts an account in `TICK_MOMENTUM`, and that needs `SHADOW_PASSED`). The CPU is on the sidecar, not the keeper; the keeper's added work is the `pullTickShadow` rows and the readiness view's reads.
- **The live sidecar (cpp-acct) has no spool, and the claim "shadow still runs off the feed there" is FALSE.** `main.cpp:185-203`: `TICK_SPOOL_PATH` unset → `tickRecorder` is null → the log line `TICK_SPOOL_PATH not set — tick recorder disabled`. `main.cpp:254-337`: the symbol workers, the strategies, the shadow books and `tickWorkers->start()` are all inside `if (tickRecorder) { … }`; `main.cpp:1215`: `/config tickShadow` is honoured only `&& tickWorkers`; `main.cpp:733`: `GET /tick-status` answers `{"enabled":false,"reason":"TICK_SPOOL_PATH not set"}`; `main.cpp:249-252`: the tick firer starts only with a recorder. So on cpp-acct today SHADOW is a declaration the sidecar cannot act on — no strategy, no signals, no shadow book — until the owner sets `TICK_SPOOL_PATH` on it (an infrastructure change, ask-first; cpp-acct has NO volume, TM-27). This PR does not touch C++. **Re-read at source 20-09-2026 (§17.1): this bullet's finding STANDS — with no `TICK_SPOOL_PATH` on cpp-acct there are no workers, no strategies, no shadow books and no firer, so "the shadow still runs off the feed there" is still FALSE. Only its remedy was wrong, and that is corrected in §12.3's row and in §17.1. The line numbers this bullet quotes have since moved: the construction gate now reads `main.cpp:191-193`, the firer `:259-263`, the workers/strategies/shadow books `:264`, `/config tickShadow` `:1361`, `/tick-status` `:764`.**
- **Readiness checks that cannot pass on the live side today, and why** (`tick-readiness.js`, read against the `{enabled:false}` status the heartbeat stores as `cpp_exec_tick_json`): `recorder_recording` (`status.enabled === false`), `disk_reserve_clear` (no `status.disk`), `feed_continuity` (no `status.events`), `profile_matches_sidecar` (no `status.strategy`), `shadow_strategy_running` (in SHADOW, `status.strategy.shadow` absent) — five infrastructure/integration blockers per live account, every one downstream of the missing spool path, none of them an evidence question. `recorder_status_fresh` passes as long as the heartbeat pulls the endpoint. A live account therefore stays `ready: false` under PR-G's rule and is never promoted — which is the correct reading of principle 1 (the same bar) against a sidecar that cannot meet it, not a demo/live gate.

### 12.3 Named remaining blockages (owner-side; not built here)

| Blockage | Measured | What unblocks it |
|---|---|---|
| The bearer token | every `/state/*` read from outside answers 401; no runtime claim in this file is closed by a runtime read (README "Owner-held preconditions", TM-37) | the owner supplies the token; the readiness/research/validation reads can then be exercised against production |
| Segment locality | the sealed segments are at `/data/tick` on cpp-exec (demo); the keeper has no path to them; the sidecar exposes no segment listing or download (`/tick-status` reports counts, `segmentsSealed`, the mount — not files; there is no `GET /tick-segments`) | either (a) the owner mounts or copies the spool where the keeper runs and sets `TICK_SEGMENTS_DIR`, then `POST /actions/tick-research`; or (b) run `scripts/tick-research.mjs` beside the spool and `POST /actions/tick-trials`; or (c) **the next C++ step, described, not built:** `GET /tick-segments` (the sealed segment list with name, bytes, first/last recvMs, CRC of the header) and `GET /tick-segments/<name>` (the sealed bytes, range-capable, refusing the open segment) on the sidecar, behind the exec secret; the keeper's research action would then stream segments from the demo side into a keeper-local cache directory and point `TICK_SEGMENTS_DIR` at it. Sealed segments are immutable, so a cache is safe; the 2 GiB spool cap bounds the transfer |
| The three symbols unresolvable on demo | `SPX500`, `USOIL`, `UKOIL` are in the momentum universe but have no id on the demo side (plan §4 PR-H); the recorder carries what resolves | a demo-side name mapping from the owner (or dropping them from the demo carry list) — a data question, not code |
| The live sidecar's spool | §12.2: no `TICK_SPOOL_PATH`, no volume on cpp-acct → no workers, no shadow, no tick firer | **Corrected 20-09-2026 (§17.1): the owner sets the path; a volume is needed only before arming.** A container-local spool path is enough for the workers, the shadow and its evidence (nothing survives a restart); the volume is what `disk_reserve_clear` needs before a live tick permit is issued. Either way it is an infrastructure change, ask-first (TM-27) |
| Bootstrap sample on the test block | the blocks are cut by EVENT index (thirds of the event stream, `blockSummaries`), NOT by trade count — the test block holds whatever fell in the last third after the purge. Measured here on the planted fixture with `includeTest`: train 0 / validation 0 / test 0 — both of the fixture's trades fall inside the purge windows at the block boundaries while `summary.trades` still counts 2 (the checker's own run read 0 / 0 / 2 on the block rows); either way, nothing like a third of the trades. The first draft of this row assumed "~13 of 40"; that was an unmeasured assumption (checker M-3). Hence `replay.minTestTrades 10`: a marginal profile fails honestly on the sample rather than passes on a bootstrap over two numbers | more data (a longer recording), never a lower threshold |

### 12.3a Checker notes carried as stated limits (11-09-2026), not built

- **N-1** — SHADOW runs from boot, BEFORE any profile pin, on every account; the pin's window row compensates for the window's opening, but a shadow trade OPENED before the pin and CLOSED after it counts (the portfolio filters on `exit_ms ≥ since`). Pre-existing (`shadowPortfolio` has always keyed on exit), bounded by one holding cap per open trade at the pin, stated here rather than patched.
- **N-3** — `importTickTrial` checks key PRESENCE only (`strategyId … blocks` non-null); a hand-posted trial with a plausible summary and a 10-trade test block carrying a figure passes `REPLAY_PASSED`. The ledger trusts the poster; the profile hash is checked against the params (`trial_hash_mismatch`) but the figures are not recomputed. **Follow-up, not this PR:** a `source` on the trial (`route:tick-research` with the segment manifest's file CRCs vs `post:tick-trials`) and the validation importer refusing to pin on a hand-posted trial, or recomputing the summary from a stored trade list.
- **N-4 / N-5** — a withheld test block's trades still count in `summary.trades` / `profitFactor` / `maxDrawdownR` (the summary is over every trade; only the block ROW is withheld), so `minTrades 40` is partly the test period; and `sim.includeTest: true` inside `body.sim` unseals the test block exactly as the top-level `includeTest` flag does — the flag is a convenience, not a gate. Both pre-existing (P4 / the drift correction); stated. The stage bar reads the TEST block's own figure and count, which a research run cannot supply, so the confirmation-run rule holds where it matters.
- **N-6** — merging this PR flips any hand-set OFF back to SHADOW on every enabled account at the next boot (the content hash changes; the file is the owner's word). Stated in the PR body. An operator's later switch stands until the file changes again.

### 12.4 Mutation checks, as run (present-before / absent-after grep counts; restored with `git checkout` of the file, then `touch`)

A note on method first: the first mutation pass restored each file with `git checkout -- <file>`, which on UNCOMMITTED work reverts the whole file, not the mutation — it silently undid four of this PR's edits (the thresholds file, the observation file, the replayer, the validation service) and could not restore the untracked research module at all, so two mutations stayed applied. Caught by `git status` after the run (the reverted files had dropped out of the modified list), every edit re-applied from the recorded change set, the targeted tests re-run (74 pass), and the pass repeated with a copy-based restore (`cp` before, `mv` back, `touch`; the needle re-counted after the restore). The table is the second pass. M8's first attempt did not land (needle 1 → 1, a perl escaping miss) and is reported from its second attempt; M9 landed and stayed GREEN on the first attempt — the `!test.withheld` guard was redundant with the absent figure — so an assertion was added (a block marked withheld that nonetheless carries a figure must still fail) and M9 re-run red.

| # | Mutation | Needle | Count | Result |
|---|---|---|---|---|
| M1 | `tick-validation.json`: `shadow.minLosses` removed | `"minLosses": 8, ` | 1 → 0 (restored 1) | 2 fail (the pin test; the shadow boundary fixture on `thresholds_unset`) |
| M2 | `tick-validation.js` `replayChecks`: the expectancy lower-bound check → `ok: true` | `ok: testLower != null && testLower >= replay.minExpectancyLowerR` | 1 → 0 (restored 1) | 1 fail (the −0.01 / withheld / old-shape fixtures pass when they must not) |
| M3 | `tick-research-run.js`: the `no_segments` refusal → `if (false)` | `if (!dir \|\| !files.length) {` | 1 → 0 (restored 1) | 3 fail (service 409 cases; the express route test) |
| M4 | `tick-validation.js`: the pin's window-opening row → `if (false)` | `if (stage === 'REPLAY_PASSED' && cur.tickObservation === 'SHADOW') {` | 1 → 0 (restored 1) | 1 fail (the seeded-SHADOW pin test) |
| M5 | `tick-research-run.js`: a REPEAT record back to null sides | `bid: prev.bid, ask: prev.ask` | 1 → 0 (restored 1) | 2 fail (1 ≠ 2 trades on the fixture segment; the stage-A run) |
| M6 | `tick-observation.json`: `_all` back to `RECORD` | `"_all": "SHADOW"` | 1 → 0 (restored 1) | 3 fail (both file pins; the PR-H seed test) |
| M7 | `tick-replay-sim.js` `summarize`: `expectancyLowerR` not written | `expectancyLowerR: expectancyLowerR(trades.map(t => t.netR)),` | 1 → 0 (restored 1) | 1 fail (the replayer's blocks carry the figure) |
| M8 | `tick-validation.js` `shadowWindow`: the seconds truncation of the pin time removed | `.replace(/\.\d+Z?$/, '').replace(/Z$/, '') : null` | 1 → 0 (restored 1) | 1 fail (a pin carrying millis no longer opens the window in its own second) |
| M9 | `tick-validation.js` `replayChecks`: the `!test.withheld` guard removed | `const testLower = test && !test.withheld && typeof test.expectancyLowerR` | 1 → 0 (restored 1) | 1 fail (a withheld block carrying a figure passes when it must not) |
| M10 | `actions.js`: the route renamed away | `router.post('/tick-research'` | 1 → 0 (restored 1) | 1 fail (the express route test: 404 where 409 is asserted) |

Checker round (the same copy-based harness; each needle counted before, after and after the restore):

| # | Mutation | Needle | Count | Result |
|---|---|---|---|---|
| M11 | `tick-research-run.js` `admit`: the record cap → `if (false)` | `  if (records > maxRecords) {` | 1 → 0 (restored 1) | 1 fail (413 expected on the action and the job) |
| M12 | `tick-research-run.js` `startTickResearchJob`: the one-at-a-time lock → `if (false)` | `if (jobs.current) { return { status: 409, … 'research_running'` | 1 → 0 (restored 1) | 2 fail (the in-process job test; the express M-1 test) |
| M13 | `tick-validation.js` `replayChecks`: the test-block sample floor → `ok: true` | `ok: testTrades != null && testTrades >= replay.minTestTrades` | 1 → 0 (restored 1) | 1 fail (two-trade / zero-trade / nine-trade / no-count / string-count blocks pass when they must not) |
| M14 | `tick-validation.js` `shadowWindow`: the break back to the `at` string compare | `sw.id > first.id && sw.to !== 'SHADOW'` | 1 → 0 (restored 1) | 1 fail (the same-second OFF is invisible again) |
| M15 | `tick-research-run.js` `researchPlan`: the note cap removed | `rawNote.slice(0, NOTE_MAX)` | 1 → 0 (restored 1) | 1 fail (5,000 characters stored) |
| M16 | `tick-readiness.js`: the no-spool branch → `false` | `const noSpool = !!status && status.enabled === false` | 1 → 0 (restored 1) | 1 fail (the live account is sent to "check the next probe" again) |
| M17 | `actions.js`: the route back to the in-thread action | `const r = startTickResearchJob(db, req.body` | 1 → 0 (restored 1) | 2 fail (no 202 / no job; `/health` blocked behind the 300k-quote replay) |

Gate in the worktree: First gate (before the checker round): `shopt -s globstar; node --test agent/**/*.test.js` 4,223 tests, 4,222 pass, 0 fail (the remainder is the suite's standing skip/todo count, unchanged by this PR — see the line below); `npx eslint .` exit 0; `npx vitest run` 74 files / 834 tests pass; `npm run build` built; `npm run check:no-green` OK. Per-file: `tick-validation.test.js` 16, `tick-research-run.test.js` 3, `tick-readiness-routes.test.js` 3, `entry-mode.test.js` + `one-account-model.test.js` 23 — all pass.

Gate after the checker round: `node --test agent/**/*.test.js` 4,233 tests, 4,232 pass, 0 fail, 1 standing skip; `npx eslint .` exit 0; `npx vitest run` 74 files / 834 pass; `npm run build` built; `npm run check:no-green` OK. Touched files: `tick-validation.test.js` 16, `tick-research-run.test.js` 7, `tick-readiness-routes.test.js` 4, `tick-readiness.test.js` 5 — all pass. Note for the PR: `agent/services/tick-research-worker.js` is a NEW file (the worker body) and must be added with the rest.

---

## 13. Follow-up — PR-I, the sealed-segment read path (segment locality closed), 16-09-2026

Dated follow-up per the plan's standing rule. PR-I builds the item this file's own §12.3 named and did NOT build ("the next C++ step, described, not built: `GET /tick-segments` … and `GET /tick-segments/<name>`") and `docs/owner-principles-plan-2026-09-11.md` §8 item 4. Account ids last-4 only. It is a READ path: it places no order, moves no stage, changes no threshold and touches no trading code path.

**The measurement that made it necessary (15-09-2026).** The demo sidecar had recorded 4.59 M tick events into `/data/tick` with 2 sealed segments (0.13 GB) and the Node keeper could not read one byte of them — the spool is a volume on the sidecar. `POST /actions/tick-research` therefore answered 409 `no_segments` every time and `REPLAY_PASSED` was unreachable: the evidence ladder's first rung had no data under it.

### 13.1 What was built

| Piece | Change | Test |
|---|---|---|
| The sidecar's sealed listing | `GET /tick-segments` (`cpp-exec/src/tick_segment_routes.cpp`, registered from `main.cpp`): `{enabled, spool, segments:[{name,bytes,sealedAtMs,index}…], openBytes, truncated, maxChunkBytes}` — SEALED only, oldest first, at most `kMaxListEntries` 500 with `truncated` saying so; `{enabled:false,reason:"TICK_SPOOL_PATH not set"}` (200) with no recorder, the same shape `/tick-status` already uses. The OPEN segment is reported as `openBytes` and never listed | `test_tick_segments.cpp` "listing: sealed only, oldest first, open never listed, cap sets truncated" (0 / 1 / many sealed, one `.open`, one `.torn`, two non-segment files) |
| The sidecar's bounded range read | `GET /tick-segment?name=&offset=&len=` → `{name,totalBytes,offset,len,eof,b64}`. `len` clamped to `kMaxChunkBytes` **1 MiB** (declared in `tick_recorder.hpp`); an offset at or past EOF is `len:0, eof:true` — not an error. `http_server` now keeps the raw query string (`HttpRequest::query` + `queryParam`), which it previously discarded; the route table is still keyed on the PATH alone | `test_tick_segments.cpp` "range reads: byte-exact, clamped to 1 MiB, past-EOF is eof not error" and "query: name/offset/len, percent-decoded, first occurrence wins" |
| **The security boundary** | `tick::isSealedSegmentName` accepts ONLY `^seg-[0-9]{13}-[0-9]{6}\.tks$` — the recorder's own sealed naming — as an anchored full match: the length check is what anchors the tail, so no path separator, no `..`, no `.open`, no other extension and no trailing suffix can match. Anything else is 400 `bad_name`; a name that validates but names nothing is 404 `not_found`. Two further independent guards: the opened file's `realpath` must equal the spool's `realpath` plus that name (so a SYMLINK inside the spool carrying a legal name cannot escape it), and its `st_nlink` must be 1 (so a HARDLINK, which has no target for `realpath` to resolve, cannot smuggle a file from anywhere on the filesystem — checker m-1) | `test_tick_segments.cpp` "name boundary" (11 cases) and "refusals: traversal, absolute, .open, wrong extension, bad digits, absent, symlink" |
| **The routes are reachable from the C++ suite** (checker M-3) | The two handlers were lambdas in `main.cpp`, which the Makefile excludes from every test binary — so nothing in the C++ suite could reach them, the wire contract existed twice (here and in the Node tests' fake sidecar), and the copies were never joined. Proven: a mutation replacing the query assignment in `http_server.cpp` with `req.query.clear()` killed the entire read path while all seven cases of `test_tick_segments` stayed green. The handlers now live in `cpp-exec/src/tick_segment_routes.{hpp,cpp}` and `main.cpp` calls `registerTickSegmentRoutes(...)` | `test_tick_segments.cpp` "e2e: the real routes on a real socket" and "e2e: {enabled:false} with no recorder; unreachable with no EXEC_SECRET" — a real `HttpServer` on a real port, driven with raw sockets: the listing, a multi-chunk read reassembled byte-exact, `bad_name`, `not_found`, a percent-encoded traversal, past-EOF, 401 with a wrong token, 401 with no header, and 401 with **no `EXEC_SECRET` configured at all**. It also pins the JSON field names (`b64`, `len`, `eof`, `totalBytes`, `name`, `offset`) the Node puller reads, which is where C++/JS drift would otherwise hide |
| Bearer REQUIRED | Both routes refuse 401 unless `Authorization: Bearer <EXEC_SECRET>` matches AND a secret is configured at all — segment bytes are market data. (`HttpServer` already gates every non-`/health` route; these two additionally refuse an unauthenticated deployment, where the server's own gate would otherwise admit a literal `Bearer `.) | the bearer branch mirrors `/health`'s `trusted`; exercised end to end by the Node tests' fake sidecar, which 401s a wrong token and `listSidecarSegments` reports it |
| No lock, and why that is TRUE | The reader opens the sealed file read-only and `pread`s the range. Sealed files are immutable **by construction**: the writer only ever holds the `.open` file (`openSegment` opens `openPath_`; `writeRecord`/`sealSegment` write through that same `FILE*`), sealing is the atomic rename, and the only thing that ever touches a `.tks` afterwards is `retire()`, which **unlinks** it. The unlink race is handled, not assumed: a file retired before the open answers 404, and one retired after it still reads its real bytes (the fd holds the inode) — never a short read presented as the whole file | `test_tick_segments.cpp` "retired mid-read: 404, never a short read dressed as the file" and "live writer: sealed reads are byte-exact with no lock" — a reader thread lists and range-reads while the recorder's writer thread seals ~39 segments; the file is in `TSAN_TESTS` |
| The keeper's puller | `agent/services/tick-segments.js`: `listSidecarSegments`, `pullSegment` (chunked at `MAX_CHUNK`, base64-decoded, written to `<destDir>/<name>.part` and **renamed** onto the real name only at eof), `syncSegments` (pull only what the cache does not already hold at the right byte length; bounded by `maxBytes` / `maxSegments`; `{pulled, skipped, bytes, truncated, failed}`), `syncFromSidecars`, `cachedSegments`, `tickSegmentsView` | `tick-segments.test.js` (20 tests) against a **fake sidecar** — a real http server speaking both routes with the same clamp, bearer gate and refusals |
| **Verification after the pull** | The renamed file is decoded with `agent/lib/tick-segment.js` (header magic, version and CRC, then every record's CRC). A segment that fails is DELETED and reported — a corrupt chunk never becomes a trial. The sidecar's listing is treated as DATA: every name is re-checked against the same pattern before it is used as a filename, so a hostile name in a listing cannot write outside the cache | `tick-segments.test.js` "a corrupt chunk is REFUSED and the file deleted" (corruption injected from the second chunk on; the file must not exist afterwards) and "a corrupt HEADER is refused the same way" |
| The research path | `POST /actions/tick-research` now calls `startTickResearchJobWithSync`: when nothing is reachable locally it asks each sidecar side, refuses 413 from the **listing** if the record cap cannot take what is there (§13.4 M-1), otherwise pulls what is missing into the cache directory and starts the job over the cache. **The whole sync — list, pull, base64-decode, verify — runs in its own worker thread** (`tick-segments-worker.js`, `syncInWorker`), not on the keeper's event loop: the per-segment verification is a full CRC scan costing ~200 ms per 16 MiB and ~1 s per 64 MiB, and the first version of this PR ran it on the loop (checker B-1 measured `/health` at 1.017 s mid-pull). The CPU-bound replay still runs in the research worker as before (PR-H's checker M-1). A directory that already has segments short-circuits the pull entirely | `tick-segments.test.js` "the research action pulls the sidecar's segments into the cache and THEN runs the job", "a local segment directory short-circuits the pull entirely (no sidecar call)" and "the sync runs in a WORKER"; `tick-readiness-routes.test.js` **"GET /health stays under 100 ms WHILE a multi-megabyte segment sync runs"** (a 16 MiB segment over the real default path, two independent samplers — an always-in-flight `/health` request and a 5 ms interval timer measuring loop lag) |
| The 409 stays honest | With nothing local AND no sidecar serving a segment the answer is still 409 `no_segments`, now with `where` = `NO_SEGMENTS_ANYWHERE` (it names that the sidecar was asked and `GET /state/tick-segments`), the pre-PR-I text kept as `localWhere`, and `sync` carrying what each side reported (unreachable, `enabled:false`, or zero segments). Never a fabricated trial | `tick-segments.test.js` "with nothing reachable anywhere the 409 is still honest"; `tick-readiness-routes.test.js` over a real express app |
| The read-only view | `GET /state/tick-segments`: the cache directory, what it holds, and per side what the sidecar has sealed, its `openBytes` and how many of its segments are already cached. It pulls nothing | `tick-segments.test.js` "reads what is there without pulling anything" (asserts the sidecar's chunk-call count is unchanged); `tick-readiness-routes.test.js` "PR-I: GET /state/tick-segments …" |

### 13.2 Judgement calls, stated

- **Base64 in JSON, not a binary body.** `HttpResponse` is `{int status; std::string body}` and `writeResponse` always sends `Content-Type: application/json`. That response path also serves order acks on the live trading socket, so it was NOT reshaped for a research read: adding a binary/content-type path there would put a research feature in front of execution. The cost is 33 % on the wire against a 1 MiB cap per call; the keeper pulls in chunks and the 2 GiB spool cap bounds the total. If this ever becomes the bottleneck, the right change is a separate reader endpoint, not a change to the shared writer.
- **Cache-dir default: `TICK_SEGMENTS_CACHE_DIR`, else `TICK_SEGMENTS_DIR`, else `<os.tmpdir()>/tick-segments`.** Falling back to `TICK_SEGMENTS_DIR` means a pull fills exactly the directory the operator already pointed research at. The tmpdir default is deliberate: a cache is reconstructible from the sidecar at any time, so nothing is lost when the container replaces it, and it cannot quietly fill a data volume nobody sized for it. An operator who wants it kept sets either variable.
- **Verification runs after the rename, and the rename runs at eof.** The `.part` file is what guarantees "never a half file under the real name"; the post-rename decode is what guarantees "never a corrupt segment handed to research". Both are asserted, and a failed verification deletes the file.
- **`sealedAtMs` is the file's mtime at second resolution** (`st_mtime`; `st_mtim`/`st_mtimespec` are not portable across the Linux CI and macOS dev builds). It is the moment of the sealing rename, not a record timestamp — the segment's own start is in its name.
- **The listing is capped at 500 entries, not paged.** 500 × 64 MiB is 32 GiB, well above the 2 GiB spool cap, so `truncated` should never be true in this deployment; it exists so a misconfigured spool cannot produce an unbounded response.
- **The `.open` exclusion IS the name pattern's tail anchor** (measured: the length check, since `seg-…tks.open` is 33 bytes against the pattern's 28). The listing's `.open` branch exists to REPORT `openBytes`, not to exclude — a second exclusion check there would be a guard that cannot fail (this file's own "Recurring failure modes" #3), and §13.4's M4 shows exactly that: disabling the branch alone leaves the open file unlisted and only loses the byte count. The mutation table therefore mutates the anchor itself.
- **The path boundary is THREE checks, and each was measured.** (a) the name pattern refuses names; (b) `realpath` refuses what a legal name can point AT, which covers symlinks; (c) `st_nlink == 1` refuses a HARDLINK, which (a) and (b) both miss — a hardlink has no target to resolve, so `realpath` returns the link's own path inside the spool while the inode is a file from anywhere on the same filesystem. Checker m-1 proved it by reading `VICTIM-BYTES-OUTSIDE-THE-SPOOL` through a legally-named hardlink. A segment this recorder sealed always has exactly one link (created by `fopen`, renamed once, never linked), so the check costs nothing and refuses only planted names.
- **The listing uses `lstat`, not `stat`** (checker m-2). `stat` follows a symlink, so a `seg-…tks` link to `/etc/passwd` was listed with the TARGET's size — an authenticated caller learned the size of a file outside the spool, and every sync carried an entry it could never fetch (the read path refuses it), so the failure list grew for ever. `lstat` + `S_ISREG` drops the link at the listing instead.
- **Two of the three guards were measured to be independently sufficient against traversal.** The name pattern and the `realpath`-inside-the-spool check are not decoration for one another: §13.4's M3 removed both and a probe then read a file outside the spool through `../secret`; with only the pattern removed the read is still refused, and with only `realpath` removed a symlink inside the spool escapes. Neither alone covers what the other does — the pattern refuses names, `realpath` refuses what a legal name can point AT.

### 13.3 What this does NOT do

- It does not switch anything on: no recorder switch, no observation mode, no entry mode, no threshold.
- It does not archive (TM-29's bucket is still not built) and does not change retention: the sidecar's 2 GiB spool cap and its oldest-first retirement are untouched. A segment retired while the keeper has not pulled it is gone — the cache is a copy of what is there now, not a backup.
- It does not resolve the bearer token (TM-37): no runtime claim here is closed by a production read. Every claim above is closed by a test in this repository.
- It does not run on the live sidecar, which still has no `TICK_SPOOL_PATH` and no volume (§12.2): `GET /tick-segments` there answers `{enabled:false}`, which the keeper reports rather than treats as an error.

**Known limits, stated rather than fixed here (checker, 15-09-2026):**

- **`GET /state/tick-segments` asks each side SERIALLY with a 20 s timeout**, so with both sidecars unreachable the route can take ~40 s to answer. It is a read-only operator view, not on any trading path, and it is behind the keeper's own auth — but it is not a route to put on a dashboard poll. Fixing it means either a shorter per-side timeout for the view or asking the sides concurrently; neither is in this PR.
- **A large sync competes with the recorder for the same volume.** The reads are `pread` on sealed files and take no lock (that is the whole design), but they are still I/O against the disk the writer thread is appending to and the mount whose free-space reserve the recorder polls. Pulling a full 2 GiB spool is not free for the recorder. The record-cap bound (§13.4 M-1) keeps one request to ~190 MiB, and the switch is an operator action, not a loop — but nothing here throttles or schedules the transfer, and a soak (TM-36) has not been run with a sync in flight.
- **The cache is a copy, not a backup.** A segment the sidecar retires before the keeper pulls it is gone; retention is still the local 2 GiB spool cap, and the archive (TM-29) is still not built.
- **`GET /state/tick-segments` matches cached segments by byte length only.** It deliberately does not decode: verification is a full CRC scan and that route answers on the keeper's event loop (the B-1 lesson). Its `cached` count is therefore a hint; the sync's own presence test decodes, in the worker, and re-pulls anything that fails (§13.5 M-2). The route says so in its `note`.

### 13.4 Mutation checks, as run

Method (PR-H §12.4's lesson, kept): **copy-based restore** — `cp` the file before, `mv` it back after, `touch` it, and count the needle before, after the mutation and after the restore. `git checkout` is never used on uncommitted work; it reverts the whole file. The harness **refuses to proceed when the count does not change**, and it did so twice here, which is the check working rather than a formality: (i) a first attempt at M1 used a replacement that still contained the needle (count 1 → 1, refused); (ii) a first attempt at M4 used a needle that matched **two** lines (`start()`'s torn-tail quarantine contains the same text at a different indent), so the edit was refused rather than applied to both sites. Both were re-run with a unique needle and a replacement that removes it.

| # | Mutation | File | Needle | Count | Result |
|---|---|---|---|---|---|
| M1 | the name pattern accepts everything (`isSealedSegmentName` → `return true`) | `cpp-exec/src/tick_recorder.cpp` | `  if (name.size() != kNameLen) return false;` | 1 → 0 (restored 1) | RED — `test_tick_segments` aborts at the name-boundary case `!isSealedSegmentName("../seg-…tks")` (line 97) |
| M2 | the spool-containment check removed (`realpath(file) == realpath(dir)+"/"+name` → `false`) | same | `        std::string(realFile) != std::string(realDir) + "/" + name) {` | 1 → 0 (restored 1) | RED — aborts at the SYMLINK case (line 227): a legally-named symlink in the spool now reads `/etc/passwd` |
| M3 | **both** guards removed together | same | both needles above | 1 → 0 each (restored 1 each) | RED at line 97; and a one-off probe (not committed) measured the escape directly: with both off, `readSegmentChunk(spool, "../secret", …)` returns `status=OK, 6 bytes, "s3cret"`; with only the name pattern off it returns `BAD_NAME`; unmutated, `BAD_NAME`. **Each guard is independently sufficient against traversal; neither is decoration.** |
| M4 | the `.open` exclusion weakened — the listing's `.open` branch disabled AND the name pattern's tail anchors relaxed (`size() != kNameLen` → `<`, `endsWith(".tks")` → `find(".tks")`) | same | the branch's first two lines; the two anchor lines | 1 → 0 each (restored 1 each) | RED at line 98 (`seg-…tks/../../../etc/passwd` now accepted). Disabling **only** the listing's `.open` branch is RED at line 138 (`many.openBytes == 999`) while the open file stays unlisted — i.e. the exclusion itself lives in the name pattern's length anchor, and the branch is what REPORTS `openBytes`. Both measured separately. |
| M5 | the post-pull verification removed (`if (!seg.header \|\| seg.truncated) {` → `if (false) {`) | `agent/services/tick-segments.js` | `if (!seg.header \|\| seg.truncated) {` | 1 → 0 (restored 1) | RED — 2 of 12 fail: the corrupt-chunk test (the bad segment survives under the real name) and the corrupt-header test |
| M6 | the atomic `.part` rename removed (`partPath` = the real name) | same | `const partPath = \`${finalPath}.part\`` | 1 → 0 (restored 1) | RED — 5 of 12 fail, including "nothing exists under the REAL name while the transfer is in flight" (the probe sees the half file mid-pull) and the research-route test |
| M7 | the one-job-at-a-time short-circuit in `startTickResearchJobWithSync` removed (`if (jobs.current)` → `if (false)`) | `agent/services/tick-research-run.js` | `  if (jobs.current) return startTickResearchJob(db, body, { ...rest, maxRecords, segmentsDir })` | 1 → 0 (restored 1) | RED — 1 of 12 fails: a second POST while a job runs must be refused BEFORE anything is pulled (the injected sync counter must stay 0) |

### 13.5 Checker round (15-09-2026) — one blocker, three majors, five minors, each fixed and each pinned

An independent checker attacked the diff. Every finding below is fixed in the same pass, and every fix carries a mutation that turns a named test red — **including two of my own fixes that did not work the first time and were caught here rather than in review.**

| # | Finding | Fix | Mutation → test |
|---|---|---|---|
| **B-1** (blocker) | the pull's VERIFICATION (`readFileSync` + full CRC scan, ~1 s / 64 MiB) ran on the keeper's event loop, reached from `POST /actions/tick-research`; measured `/health` 0.0009 s → **1.017 s** → 0.0006 s. My own comment claimed only network I/O was awaited — true of the code, false of the effect | the whole sync (list, pull, decode, verify) moved into a worker thread: `agent/services/tick-segments-worker.js` + `syncInWorker` | `syncInWorker` → `syncFromSidecars` (in-thread): `tick-readiness-routes.test.js` B-1 test RED at **`/health` 235 ms** |
| **M-1** (major) | up to 2 GiB was pulled and the request THEN refused 413 (`admit` ran after the sync); measured 413 with 2,400,064 bytes already on disk | a pre-flight: every side is LISTED, the records implied by the listed bytes are checked against `MAX_RECORDS`, and 413 is answered before a byte moves; the sync is additionally bounded by `MAX_RECORDS × RECORD_BYTES + SYNC_HEADROOM_BYTES` | the pre-flight → `if (false)`: the M-1 test RED (it asserts `sync.pulled === 0`, an empty cache dir AND that the sidecar's chunk-call count did not move) |
| **M-2** (major) | a cached segment of the right LENGTH but the wrong bytes was skipped for ever (presence was byte-length only, and verification only ran on the pull path) — reachable in the normal deployment because the cache defaults to `TICK_SEGMENTS_DIR`, an operator-populated directory | presence now means DECODES: `cachedSegments(dir, { verify: true })` runs the real decoder; a file that fails is left out of the map so the sync re-pulls and overwrites it, and it is reported in `corrupt` with `repulled` saying whether the sidecar could repair it. It is **not deleted** — it may be the operator's own file | `{ verify: verifyCache }` → `{ verify: false }`: both M-2 tests RED (the corrupt copy is skipped, and the unrepairable one is silently counted present) |
| **M-3** (major) | nothing pinned the real routes: they were lambdas in `main.cpp`, which no test binary links, so the wire contract existed twice and the copies were never joined. Proven — `req.query.clear()` in `http_server.cpp` killed the whole read path with a green suite | the handlers moved to `cpp-exec/src/tick_segment_routes.{hpp,cpp}`; `main.cpp` calls `registerTickSegmentRoutes(...)`; `test_tick_segments` drives that same registration through a real `HttpServer` on a real socket | the same `req.query.clear()` mutation: now RED at the e2e listing assertion |
| **m-1** (minor) | a HARDLINK defeated the `realpath` boundary (no target to resolve); proven by reading `VICTIM-BYTES-OUTSIDE-THE-SPOOL` | `st_nlink != 1` → `bad_name` after `fstat` | `if (sb.st_nlink != 1)` → `if (false)`: the hardlink case RED |
| **m-2** (minor) | `::stat` follows symlinks, so a legally-named link was listed with the TARGET's size (a foreign file's size leaked, and every sync carried a permanently failing entry) | `::lstat` + `S_ISREG` at the listing | `::lstat` → `::stat`: the symlink-listing case RED |
| **m-3** (minor) | two concurrent POSTs both pulled, and both used one `<name>.part` that each one's `finally` deleted (one caller saw a phantom ENOENT on its rename) | the job slot is claimed BEFORE the sync, and each pull owns `<name>.<pid>.<uuid>.part` | three mutations, each RED: the lock removed; **the lock claimed after the first `await`** (see below); the shared `.part` name |
| **m-4** (minor) | three pull guards were unpinned (mutations stayed green): the declared-length check, the pulled-vs-total check, and the no-progress guard — the last one spins for ever against a sidecar answering `len:0, eof:false` | three tests, one per guard, the no-progress one wrapped in a 5 s race so a hang fails rather than hangs | each guard → `if (false)`: the m-4 test RED in all three cases |
| **m-5** (minor) | the 1 MiB cap was requested but never enforced on the ANSWER — an 8 MiB chunk was fully decoded and buffered, and only the CRC rejected it | `declared > MAX_CHUNK` is refused **before** the base64 decode | the check → `if (false)`: the m-5 test RED |

**Three of my own fixes were wrong on the first attempt, and the mutation pass (or a re-read) is what found them — not the green suite.**

1. **The B-1 regression test was a guard that could not fail.** Its first draft slept 5 ms between `/health` calls and took its start stamp AFTER the sleep, so a 200 ms block landing inside the gap was invisible: putting the sync back on the event loop left the test GREEN. It now keeps a request always in flight AND runs an independent 5 ms interval timer measuring loop lag. The mutation then failed at 235 ms.
2. **The `syncLock` was a check-then-act across an `await`.** It was claimed after `await import('./tick-segments.js')`, so both callers ran their synchronous prefix, both saw a null lock and both pulled — measured as **48 chunk requests where one pull is 24**. The strengthened m-3 test (which counts the sidecar's chunk calls rather than only reading the 202/409 pair) is what exposed it; the status pair alone stayed correct, because the loser still lost, just after paying for the bytes. The claim moved above the first `await`.
3. **The M-1 pre-flight double-counted the cache.** It summed "records the sides list" with "records the cache holds" — but after a successful sync those are the SAME segments, so a second request over the same data was refused 413 well inside the cap. Found by re-reading the fix, not by a test, so a test was added (a second request after a successful sync must still be 202) and the mutation — counting the whole cache instead of only the segments the sides do not list — turns it red. A cache-only segment still counts towards the cap; that half is asserted in the same test.

**Gate in the worktree, after the checker round** — run from a **deliberately emptied `cpp-exec/bin/`** so no stale binary could pass (the checker's warning; `make` compares mtimes, and every test binary depends on the whole library anyway, so touching `tick_recorder.cpp` forces all 33 to rebuild):

- `shopt -s globstar; node --test agent/**/*.test.js` — **4,263 tests, 4,262 pass, 0 fail, 1 skip**.
- `npx eslint .` exit 0. `npx vitest run` 79 files / 892 tests pass. `npm run build` built. `npm run check:no-green` OK.
- `make -C cpp-exec CXX=g++ test all tsan` from an empty `bin/`: **33 test binaries built and run, 31 pass lines** (the suite's binaries print `all passed`, `all assertions passed` or `OK`), **the sidecar `bin/cpp-exec` linked** — which is what compiles `main.cpp` with the new `registerTickSegmentRoutes` call, since the `test` target builds every source EXCEPT `main.cpp` — and **all 10 ThreadSanitizer binaries pass with zero `WARNING: ThreadSanitizer` and no `*** Error` anywhere in the log**. `test_tick_segments: all passed` appears twice: once plain, once under TSan.
- Per-file for the touched suites: `tick-segments.test.js` 21, `tick-readiness-routes.test.js` 17 (6 of its own plus the helper file's), `tick-research-run.test.js` 11, `test_tick_segments.cpp` 11 cases.

---

## 14. Follow-up — PR-J, exit asymmetry: the winners stop being capped (built 16-09-2026, from the 09–11-09 statements)

*(Numbered 14 as ordered. This file carries no §13 — the numbering is the PR
order, not a contiguous count; §7 also appears twice, from the PR-C and PR-B
rounds.)*

Dated follow-up per the plan's standing rule (owner principle 5, "the `.md`
plans are checked"). Built on `217b4c3`. Ordered by the owner ("finish the
outstanding") after the measurement below. **This changes EXIT BEHAVIOUR on
accounts holding real money**, so both halves are config-driven, each revertible
by ONE stored value, and both switches are named here with the key and the route
that writes them.

### 14.1 The measurement that ordered it

Five broker statements, 95 bot deals, 09–11 Sep:

| Fact | Value |
|---|---|
| Winners' median move | +0.39 % |
| Losers' median move | −0.76 % |
| Average win ÷ average loss | 0.72 |
| Win rate | 51 % |
| Realised R:R | ≈ 1.01 |
| Closed inside 1 h | 34 of 95 |

Ten trades were closed in ONE batch at 21:31:00 SGT (the US open) by the
position manager's time cap after 17–21 h held, several of them in profit.
The expectancy is negative **by construction**, not by bad entries: the winners
were capped at +1R by `takeAtR` and cut mid-move by the clock, while the losers
ran to their full 1–3 % stops. A 51 % win rate with a 0.72 win/loss ratio cannot
pay. PR-J removes the two caps and leaves the losers' side exactly as it was.

### 14.2 What changed

**Rule 1 — the time cap stops closing winners** (`agent/services/position-manager.js`,
the cap branch that runs before the price gate):

- R < `timeCapHoldMinR` (default **0**) → `FULL_EXIT`, with the reason string
  `time_cap_expired (<cap>)` **unchanged**. A loser still dies at the clock.
- A position whose price cannot be read → `FULL_EXIT`, unchanged. The 03-08-2026
  rule stands: an unpriceable position past its deadline is more urgent, not
  less. `r` is null, and null is not ≥ the threshold.
- R ≥ `timeCapHoldMinR` → **not closed, and not held at full risk**. The stop is
  tightened to `max(breakeven, peak − timeCapTrailAtrMult × distance)` for a
  long (min for a short) — **floored at breakeven**, TIGHTEN-ONLY — the row is
  stamped `time_cap_trail_at`, and the reason is `time_cap_trailing`. The stamp
  is what stops the branch being re-decided every cycle: from the next pass the
  ordinary ladder (managed trail, breakeven, invalidation) governs.
- **If even that floor would not tighten the stop, the hold is REFUSED and the
  position is closed**, with the pre-PR-J reason string. This is the checker's
  BLOCKER B1, and it is the load-bearing correction to the first draft of this
  PR. Without the floor the trail was `peak − 1.5 × 1R`, which with the entry
  stop at −1R only tightens at peak ≥ 1.5R — while the winners this PR was
  written about move **+0.13R to +0.39R** (+0.39 % median against 1–3 % stops).
  Every one of the ten positions in the 21:31 batch would have been stamped,
  held for up to 72 h and left at **full original risk**: a realised
  +0.13R…+0.39R converted back into −1R of open risk, up to ≈$10,600 of newly
  open risk on the $35,320 account at 3 %. The rule is now "hold only if the
  hold improves the stop"; a hold that cannot improve the stop is an unpriced
  extension of risk, and the cap closes as before.
- `timeCapMaxExtraHours` (default **72**) is the backstop: past `time_cap_at`
  plus that many hours a held winner is closed with
  `time_cap_expired_backstop`. "Hold the winner" can never mean "hold forever".

**Rule 2 — the +1R take becomes a partial, and the rest trails**
(same file, the bank-target branch; wired through `agent/services/managed-exit.js`):

- Where the managed take fires (R ≥ `bankTriggerR`, i.e. `takeAtR` 1.0 for the
  families in `takeAtRFamilies` — unchanged, still `['mean_reversion']` only),
  the action is now `PARTIAL_EXIT` of `takeFractionAtR` (default **0.5**), the
  stop moves to **at least breakeven** and the remainder trails
  `takeTrailAtrMult` (default **1.5**) behind the peak, tighten-only.
- The row is stamped `bank_partial_at`, and the remainder is **never** re-banked
  at the same trigger — without that stamp the remainder sits above the trigger
  on the very next pass and is banked again, a loop of ever-smaller partials
  each paying spread.
- `PARTIAL_EXIT` was already an executed action in `agent/loop.js` and already
  sizes from broker truth; no new execution path was written.

**Trail distances, and how often the ATR is really there.** Both trails are ATR
multiples where an ATR is available and multiples of the position's own initial
risk (1R, also a price distance) where it is not; the reason string says which
basis was used (`1.5×ATR` or `1.5R (no ATR)`). The ATR is READ from the profit
keeper's in-memory cache (`cachedAtrForSymbol`, new in `profit-keeper.js`) —
never fetched on the monitor's path.

An earlier draft of this section claimed the 1R fallback is "the common path".
**That claim is withdrawn: it cannot be determined from the repo.** What the
repo does say: the keeper's default mode is `adaptive` and it runs from the same
process and the same ticker as the monitors, so the cache is shared; it writes an
ATR per symbol it processes, valid for one bar of `atrTimeframe` (default 1h);
and it processes only positions in its own scope (`guard_json` null,
`keeper_opt_out` not 1, the source whitelist). Whether production's stored
`profit_keeper_json` sets `adaptive` or `fixed`, and what the resulting hit rate
is, is **not knowable from this repository** — it is a runtime fact and is not
asserted here either way. The B1 arithmetic above is stated in the 1R basis
because that is the reachable-by-construction path; with an ATR the distance can
be tighter OR looser than 1.5R, and the breakeven floor plus the tighten-only
guard bound both cases identically.

### 14.3 The two revert switches

Storage key: **`agent_state.managed_exit_json`** (the existing managed-exit
policy record). Route: **`POST /actions/managed-exit`** — added by this PR,
because until now the record could only be changed by a raw state write, which
is not a revert path anybody can use under pressure. The route merges into what
is STORED and replies with the EFFECTIVE policy read back through the loader.

| To revert | POST body | Effect |
|---|---|---|
| Rule 1 | `{"timeCapHoldWinners": false}` | The time cap closes winners again, with the pre-PR-J reason string and no stamp. Pinned by a test. |
| Rule 2 | `{"takeFractionAtR": 1.0}` | The take closes the whole position again, reason `bank_target_1R (current R=…)`. Pinned by a test. |

`timeCapHoldMinR`, `timeCapTrailAtrMult`, `timeCapMaxExtraHours` and
`takeTrailAtrMult` are tunable through the same route, **within clamps applied
in the loader** (so a raw `agent_state` write is bound too, not only the route):
`timeCapHoldMinR` ∈ [0, 10], `timeCapMaxExtraHours` ∈ [1, 168] hours,
`timeCapTrailAtrMult` and `takeTrailAtrMult` ∈ (0, 10], `takeFractionAtR`
∈ (0, 1]. Checker M1: before the clamps, `{"timeCapHoldMinR": -99}` made
`r >= minR` true for every losing position — one state write disabled the
loss-side time cap on every account — and `timeCapMaxExtraHours: 100000`
defeated the backstop this document calls a hard bound.

**The boolean fields take only booleans.** `on` and `timeCapHoldWinners` are
read with `typeof === 'boolean'`; anything else keeps the ordered default, and
the route answers **400 `not_a_boolean`**. The earlier `=== true` read the
string `"true"` as false, so an operator asking to switch the rule ON would have
switched it OFF (checker minor 1).

**One more thing to be plain about (checker minor 2):** because the four
time-cap fields deliberately bypass the registry and the policy's `on` flag,
`{"on": false}` no longer switches off the whole of PR-J — it stops the managed
trail and the take, and leaves the cap's hold-the-winner behaviour running. The
only full revert of rule 1 is `{"timeCapHoldWinners": false}`. The four time-cap fields
deliberately ride OUTSIDE the managed-exit registry/`on` check: the time cap is
a signal-owned rule that reaches every account, so an override that reached only
governed accounts would be a switch that reverts half the change. The take's
fraction rides only where the take itself rides — an out-of-scope family has no
take, so its fraction stays 1 and nothing about it changes.

### 14.4 What this does NOT change

- **Stops.** No stop is ever widened. Both new trails are tighten-only, and the
  loosening case is pinned by a test and by mutation (b).
- **Sizing, entry rules, the risk config.** Untouched.
- **The loss guardian's behaviour where its cap applies** — but its DEFERRAL
  changed, and had to (checker M2). It skipped `maxHoldHours` for any position
  carrying its own `time_cap_at`, on the reasoning that the position manager's
  cap always closes. It no longer always closes, so a held position would have
  had **no time-based owner at all** for up to 72 h. The guardian now defers
  only while the cap is still going to close the position:
  `hasOwnTimeCap: time_cap_at != null && time_cap_trail_at == null`. Once the
  hold is stamped, the guardian's own cap applies again. There is still no
  double-close: exactly one of the two owns any position at any time.
- **The momentum/book rules** and every family outside `takeAtRFamilies`.
- **`takeAtRFamilies` itself** — still the 07-09 scope, `['mean_reversion']`.
- **The reason string a loser carries at the clock** — `time_cap_expired (…)`,
  byte for byte, so the ledger and the postmortems keep reading.

### 14.5 Residual risk, stated plainly

Holding winners past their cap raises overnight and weekend gap exposure: a
position that would have been closed at 21:31 SGT can now sit through a US
session, a roll, or a Friday close, and a gap through the trailed stop fills
worse than the stop level. That is a real, new exposure and it is the price of
not capping the winners. Four things bound it: a position is held ONLY if the hold improves its stop, and
the stop it gets is at least breakeven (B1), so a held position carries no
open loss at the moment it is held; the `timeCapMaxExtraHours` backstop closes it
72 h past its cap whatever it is doing, and that number is clamped to a week;
the loss guardian's `maxHoldHours` applies again once the hold is stamped (M2);
and the weekend/naked-position controllers are unchanged and still run. What is NOT bounded is gap risk inside those 72 h; if that proves
too wide, `timeCapMaxExtraHours` is the number to cut — or
`timeCapHoldWinners: false` to revert the rule entirely.

### 14.6 Replay of the 21:31 batch — NOT run, and why

`agent/services/exit-counterfactual.js` is the service built to measure exactly
this, and it could not be driven here. It replays from
`trade_postmortems.bars_json` in the PRODUCTION ledger; this worktree has no
such rows and the repo carries no fixture of the 09–11 Sep deals. Its replay
rules (`agent/lib/exit-replay.js`) also do not model the new hold-and-trail cap,
so a comparison would need a new rule variant there as well. Rather than invent
a number, the statement stands: **the old-vs-new figure for the 21:31 batch has
not been measured.** The behavioural difference is pinned by tests
(`exit-asymmetry.test.js`: a +2R position 3 h past its cap is trailed and left
open where it would previously have been closed), not by a replayed P&L.

### 14.7 Files, tests and mutations

Changed: `agent/services/position-manager.js`, `agent/services/managed-exit.js`,
`agent/services/profit-keeper.js` (read-only ATR helper), `agent/loop.js`
(the cached ATR passed in; `roundAmendPayload` + `symbolDigitsFor` shared by both
amend sites; `stampExitMarks`, which writes from the broker outcome; the
unfillable-partial fallback), `agent/services/fast-monitor.js` (the same ATR and
the same stamp helper), `agent/services/loss-guardian.js` (the narrowed
deferral), `agent/services/cockpit-intention.js` (the held-position card and
invalidation state), `agent/db.js` (two columns + migrations),
`agent/routes/actions.js` (the revert route, with boolean strictness). New:
`agent/services/exit-asymmetry.test.js`. Updated tests:
`position-manager.test.js`, `managed-exit.test.js`, `keeper-integration.test.js`
(three cases encoded the old "a winner at the cap is closed" behaviour and now
encode the new one, with the pre-PR-J behaviour kept under the revert switch),
`amend-preserves-tp.test.js` (the rounding pin follows the shared helper, plus
the partial branch and a behavioural rounding test).

Mutation checks (needle counted present-before → absent-after, file restored by
copy and re-counted):

| # | Mutation | Needle | Count | Result |
|---|---|---|---|---|
| a | the `R ≥ timeCapHoldMinR` hold branch forced false | `const wouldHold = holdWinners && r != null && r >= minR` | 1 → 0 (restored 1) | 7 fail, incl. "time cap expired on a WINNER → trails instead of closing" |
| b | the cap trail's tighten-only guard removed | `if (isTighter(pos.side, pos.current_sl, trailSL)) {` (the `time_cap_trailing` return) | 1 → 0 (restored 1) | 1 fail: "the cap trail NEVER loosens an existing stop" |
| c | the backstop removed | `const backstopped = backstopAt != null && now.getTime() >= backstopAt` | 1 → 0 (restored 1) | 1 fail: "the backstop closes the held winner at timeCapMaxExtraHours" |
| d | the partial's "already banked" stamp guard removed | `if (!pos.bank_partial_at) {` | 1 → 0 (restored 1) | 1 fail: "the remainder is NEVER re-banked at the same trigger" |
| e | the B1 breakeven FLOOR removed (`trailSL = t`) | `trailSL = long ? Math.max(trailSL, t) : Math.min(trailSL, t)` | 1 → 0 (restored 1) | 7 red: every case in the 0.13R–0.9R band |
| f | the M1 minR clamp reverted to the raw read | `timeCapHoldMinR: clamp(…, 0, 10, true)` | 1 → 0 (restored 1) | 2 red: the clamp test and the end-to-end loser close |
| g | the M4 outcome gate removed (stamp regardless of the broker) | `if (!outcome \|\| outcome.error \|\| outcome.skipped) return false` | 1 → 0 (restored 1) | 2 red: the broker-error and skipped cases |
| h | the M4 unfillable-partial fallback removed | `if (eval_.fallbackFullExitIfUnfillable) {` | 1 → 0 (restored 1) | 1 red: the below-min-lot fallback |
| i | the M2 guardian deferral put back to `time_cap_at != null` | `hasOwnTimeCap: r.time_cap_at != null && r.time_cap_trail_at == null` | 1 → 0 (restored 1) | 1 red: the guardian caller pin |
| j | the M5 held-position card branch removed | `if (row.time_cap_trail_at) {` | 1 → 0 (restored 1) | 1 red: the cockpit card test |
| k | the M3 partial rounding removed (raw `eval_.newSL` back in the payload) | `stopLoss: runnerSend.stopLoss,` | 1 → 0 (restored 1) | 1 red: the PARTIAL_EXIT rounding pin |

Mutations a–d were run on the first build; e–k were added for the checker round
(one per fix) and a–d re-run against the corrected code. Every needle was counted
present before, absent after, and present again after the copy-restore.

Gate in the worktree after the checker round:
`shopt -s globstar; node --test agent/**/*.test.js` 4,286 tests / 4,285 pass /
0 fail / 1 standing skip; `npx eslint .` exit 0; `npx vitest run` 79 files /
892 tests pass; `npm run build` built; `npm run check:no-green` OK. No C++
touched.

### 14.9 Checker round (11-09-2026) — what the independent review changed

One BLOCKER, four MAJORs and three minors, all fixed in place:

| # | Finding | Fix |
|---|---|---|
| B1 | in the +0.13R…+0.39R band this PR is about, nothing was trailed: the position was stamped and held at FULL ORIGINAL RISK for up to 72 h | the trail is floored at breakeven, and a hold that would not tighten the stop is refused — the cap closes as before (§14.2) |
| M1 | `timeCapHoldMinR: -99` disabled the loss-side cap on every account; `timeCapMaxExtraHours: 100000` defeated the backstop | clamped in the LOADER, so a raw state write is bound too, not only the route (§14.3) |
| M2 | the loss guardian deferred to exactly the positions now being held, leaving them with no time-based owner | it defers only while the cap will still close: `time_cap_at != null && time_cap_trail_at == null` (§14.4) |
| M3 | the partial's runner-leg amend was the one price-bearing path with no digit rounding, and PR-J made it reachable | `roundAmendPayload` + `symbolDigitsFor` hoisted and used at BOTH amend sites; the DB records what was sent |
| M4 | stamps were written before execution, so a refused amend or an unsizable partial disarmed the rule forever | `stampExitMarks` writes only on `!error && !skipped`; an unfillable bank partial falls back to the full exit it replaced |
| M5 | the cockpit still promised "full exit when now ≥ cap" for a position that had been held | the card branches on the stamp and the policy: a held position shows `time_cap_backstop` with the backstop eta, and the invalidation reads `answered` |
| minor 1 | `"true"` stored FALSE — asking to enable silently disabled | booleans read with `typeof`; the route answers 400 `not_a_boolean` |
| minor 2 | `on:false` no longer reverts the whole change | stated plainly in §14.3: the only full revert of rule 1 is `timeCapHoldWinners:false` |
| minor 3 | on a stop-less row the trail would have PLACED a stop at peak − 1.5R | closed by B1's floor, with its own test |

The checker also asked whether the "the 1R fallback is the common path" claim
could be confirmed. It could not, and it is withdrawn — see §14.2.

### 14.8 What an operator sees on the first loop after deploy

- Positions sitting past their time cap **in profit, where the hold improves the
  stop** stop being closed. Their row reads `PM:MOVE_SL` / `FAST:MOVE_SL` with a
  reason beginning `time_cap_trailing`, their broker stop moves to at least
  breakeven, and `time_cap_trail_at` is set **only after the broker confirms**.
  A position already stopped tighter than breakeven is still closed at the cap,
  exactly as before.
- If an amend is refused (MARKET_CLOSED and similar), the row reads
  `broker_error` and **no stamp is written** — the next pass decides again.
- The cockpit's position card no longer says "full exit when now ≥ cap" for a
  held position; it shows a `time_cap_backstop` card whose eta is the backstop
  time, and the time-cap invalidation reads `answered` rather than `met`.
- Positions past their cap **at a loss** behave exactly as before:
  `PM:FULL_EXIT`, `time_cap_expired (…)`.
- The next `mean_reversion` position to touch +1R produces a `PARTIAL_EXIT`
  (`bank_partial_1R 50%`) instead of a full close: half the volume banked, the
  stop at or above breakeven on the runner, `bank_partial_at` stamped, and the
  0.5R managed trail carrying the remainder from then on.
- Open-position count and margin usage therefore run HIGHER than before at the
  same cadence — held winners keep their margin. The position cap
  (`maxOpenPositions` 5, the book's 8) is unchanged and still binds new entries.

## 16. Follow-up — PR-L, the tick shadow's cost model stops being zero (16-09-2026)

**This only TIGHTENS the evidence bar. It places no order and changes no
trading rule.** It changes what `SHADOW_PASSED` and `REPLAY_PASSED` mean, which
is why every number below says whether it was measured or assumed, and why
§16.4 says exactly what happens to evidence already recorded.

### 16.1 Why zero was a problem, given 236 closed shadow trades

`agent/config/tick-shadow-sim.json` carried `commissionPerSide: 0` and
`slippage: 0` for every symbol, and said so in its own `_note`: "leave 0 to
record spread-only costs". Meanwhile the demo sidecar has recorded 4.59 M
events and the shadow portfolio has closed **236 trades** — evidence heading
for the `SHADOW_PASSED` bar in `agent/config/tick-validation.json` (200
signals / 48 h / 30 trades / 8 losses / PF ≥ 1.3 / expectancy lower bound ≥ 0 /
max DD 8 R / resets ≤ 20 %).

A profit factor computed with commission 0 is an **upper bound**, not an
estimate, and the owner's own statements say the gap is not small: one 9618.HK
deal paid **115.49 USD of commission against a 388.64 USD gain** (30 % of the
gross), and one account paid 137.75 USD of commission across three days on 656
USD of realised profit.

### 16.2 Two rounds of the SAME defect, one layer apart

**Round one.** The first draft measured the costs, pushed them, hashed them,
wrote the hash onto every `SHADOW_PASSED` record — and computed the verdict
from the recorded `net_r` column without reading any of it. A sidecar running
a deliberately drifted schedule still promoted the account.

**Round two, one layer down.** The fix added four checks and a
`cost_class IS NOT NULL` filter. A second checker then verified this: **six
rows carrying `cost_class: 'fx'` and all four cost terms ZERO**, with the
sidecar honestly echoing the repo schedule and a matching symbol map, passed
all four checks and reached `SHADOW_PASSED`. `'not_a_class'` passed. A single
space `' '` passed both the SQL `<> ''` and the predicate. The four checks
proved what the sidecar **said**; the filter proved a string was non-empty;
nothing reached back to what any book had **subtracted**.

And it is not an adversarial case. `main.cpp` applies a pushed sim to **new
books only** — books already open keep the cost resolved at construction — so
for the whole window after any schedule push, `/health` declares the new
schedule while closing trades were charged the old one.

**A fifth check now reaches the books.** A closed row counts as evidence only
when all three hold:

1. its class is one this repo prices and the schedule has that class;
2. its four recorded cost terms **equal** that class row — the book writes
   what it resolved, so this is the book's own arithmetic, not a declaration
   about it;
3. its own `netR` is arithmetically consistent with its own `grossR` under
   those terms — a row whose cost fields were filled in without being spent
   fails here even if 1 and 2 pass.

A row closed under the previous schedule fails (2) and falls out of the
evidence rather than being counted under a model it never paid.

### 16.2.1 The five checks, and what each one can and cannot see

| check | refuses when | proves |
|---|---|---|
| `costScheduleKnown` | no sim reported | the sidecar's declaration |
| `costScheduleCharged` | the declared schedule is all zeros | " |
| `costScheduleMatchesRepo` | its hash is not the repo's | " |
| `costSymbolMap` | it prices no symbol, or its map ≠ the keeper's pushed map | the keeper compared to itself |
| **`costRowsCharged`** | **the bar is not met by rows the books demonstrably charged it** | **what the books subtracted** |

The first four are the sidecar's word and the keeper's own bookkeeping. Only
the fifth crosses from the declaration to the arithmetic, and it is the one
the round-two case needed.

`costRowsCharged` stays silent on an empty window — nothing has traded yet,
and the ordinary `trades` check says so. It speaks only once closed rows
exist.

### 16.2.3 The round-one checks, for the record

The round-one checks, for completeness — see §16.2.1 for why they were not
enough on their own:

| check | refuses when |
|---|---|
| `costScheduleKnown` | the sidecar reports no sim, so what it charged is unknown. The repo's schedule is never stamped on a verdict the sidecar may not have earned under it. |
| `costScheduleCharged` | the schedule it reports is all zeros — spread-only. |
| `costScheduleMatchesRepo` | its hash is not the repo's. |
| `costSymbolMap` | it prices **no** symbol, or its symbol map is not the one the keeper pushed. A stale map hashes identically, because the map is deliberately not part of the schedule's identity — so only this check can see it. |

The verdict is computed over **charged rows only**
(`shadowPortfolio(..., chargedUnder: <the schedule the sidecar reported>)`).
The 236 rows already on the ledger carry no cost class and contribute nothing.
Refusal reason: `shadow_cost_model_unproven`, with `costFailed` naming which
checks failed and `refused` counting the rows by reason.

**Both rungs were free.** The replay rung had the same hole one step earlier —
`researchPlan` defaulted `sim` to `{}`, so `REPLAY_PASSED` could be cleared at
zero cost. `replayChecks` gains a blocking `costModel` check — which, after round two,
pins to `scheduleHash(repo)` the same way the shadow rung does, because
`charged` alone was `> 0` and **`commissionBpsPerSide: 1e-12` cleared it**
while a trial at `1e-9` promoted an account end to end. A trial's `sim`
arrives from outside (`body.sim` wins over the repo default, and
`POST /actions/tick-trials` imports JSON produced off-box), so "some cost" was
never the test. The schedule now rides the research plan: `replayCostContext(db)` hands it the repo
schedule plus the symbol-id → class map the keeper pushed, and `runTrials`
charges each symbol its own class. A symbol id that is in no pushed map is
replayed **uncharged** rather than charged the dearest fallback — a research
run must still produce a readable trial — and the trial then records
`costSource: 'none'`, which the rung refuses.

### 16.3 Why a class carries BOTH a wire term and a bps term

A cTrader wire unit is **1e-5 of the symbol's own price for EVERY symbol** —
`cpp-exec/src/tick_recorder.hpp` ("Prices are cTrader wire units (1e-5)") and
`spot_feed.cpp`'s `kPointsPerPrice = 100000`. There is no per-symbol digit
scaling to key off, so an absolute number alone cannot be shared across
symbols: `slippage: 1` is 0.001 % of EURUSD and 3e-8 % of NAS100.

But measuring the statements says the broker charges **two different shapes**,
and one unit misprices the other:

- **HK stock and FX are proportional.** In bps their spread is tight — HK CV
  **0.022** across 20 deals and six names; in absolute price units, CV 0.741.
- **US stock is a flat $0.02 PER SHARE per side.** 56 of 60 deals land in
  0.0199–0.0205 price units, from DOW.US at **$29.84** to LLY.US at **$1,222** —
  the same two cents across a 41× price range. In bps those same deals run
  0.16 → 6.80, CV **0.975**.

So a class row is
`cost = commissionWirePerSide + commissionBpsPerSide × price / 10000`, and the
replayer (`agent/lib/tick-cost-schedule.js`) and the sidecar's ShadowBook
(`cpp-exec/src/tick_shadow.cpp`) apply exactly that, pinned against each other
by `tick_shadow_expected.json` — which now carries four cases covering both
shapes and all four cost terms.

**Quantisation.** Rounding the cost to whole wire units re-created the very bug
this PR removes: DOGEUSD traded at 0.06851 is 6,851 wire units, and 0.5 bps of
that is 0.343, which rounds to **0** — `netR === grossR`, free again, on seven
real deals in the owner's own statements. Two rules now, identical in both
engines: **commission is never quantised** (subtracted as a real number before
the R division), and **slippage rounds away from zero** (it has to shift an
integer price, and a non-zero slippage must never become a free fill). Rounding
away from zero overstates the cost on very cheap symbols, which is the safe
direction for an evidence bar, and it is stated rather than hidden.

### 16.4 Where each number came from — measured, narrow, or placeholder

**Basis**: `agent/seed-statements/*.csv`, three accounts, dated 21-08-2026.
**683 deal rows parse; 9 are undecidable** (no price move or no gross), leaving
674. Per deal: `gross USD = Net USD − Commissions`; `USD per price unit =
|gross| / |entry − close|`; round-trip commission in price units =
`|Commissions| / that`; per side = half.

| class | per side | shape | n (decidable) | reading |
|---|---|---|---|---|
| `stock_us` | **2000 wire** ($0.02/share) | flat | 60, all charged | **MEASURED.** 56 inside 0.0199–0.0205 price units. |
| `stock_hk` | **15.0 bps** | rate | 20, all charged | **MEASURED.** median 15.0044, six names inside 14.33–16.03. |
| `fx` | **0.35 bps** | rate | 235; 54 charged, 181 free | **MEASURED, pessimistic side.** median 0.3556 of the charged plan. |
| `commodity` | **0.08 bps** | rate | 73; **6 charged, all XAUUSD** | **NARROW SAMPLE.** Not a class measurement. |
| `index_cfd` | **0** | — | 186, all zero | **MEASURED ZERO** (a genuine zero, not an empty cell). |
| `crypto` | **0** | — | 100, all zero | **MEASURED ZERO.** |
| slippage, every class | **0.5 bps** | rate | — | **PLACEHOLDER. Not measured.** |

**The unit each class is really charged in** (round two). Three of the six are
not rates at all, and saying "MEASURED as a RATE" was mis-identifying the fee:

- **US stock: a flat $0.02 per share per side**, plus a **$0.02/side minimum**.
  Model fit over the 60 charged deals, commissions quoted to the cent, 2c
  tolerance: per-share with no minimum **57/60**, per-share **with** the
  minimum **60/60**.
- **FX: a flat $3.50 per lot per side** — 62 charged deals, median $3.5021,
  CV 0.034.
- **XAUUSD: a flat $3.5000 per lot per side**, CV 0.0000 — i.e. $0.035/oz.

**Neither a per-lot fee nor a per-deal minimum can be expressed in this cost
model, and that is by design**: the shadow book is size-free — it records
price units and R, and each account sizes its own projection — so it never
sees a lot count. The bps figures are therefore approximations of a per-lot
fee, and their error is now stated per class instead of implied:

| class | approximation error |
|---|---|
| `fx` | exact for USD-base pairs; **overcharges GBP-base ~35%, undercharges NZD-base ~41%** (measured: USDJPY 0.354, USDCAD 0.355, EURUSD 0.303, GBPUSD 0.260, NZDUSD 0.595) |
| `commodity` | 0.08 bps reproduces $0.035/oz only near the $4,245 gold of these statements; **at $6,000 it overcharges ~41%** |
| `stock_us` | the per-share term is exact; the **minimum is not modelled, so the schedule UNDERCHARGES very small positions** — at one share or fewer the real fee is $0.02/side regardless |

Every one of those directions is known and written down rather than hidden.

**A correction to this document and to the config, round two.** The config said
the four `stock_us` outliers *"are multiples of $0.02 and read as multi-fill
deals"*. **That was a guess published as a finding, and it is false.** The four
are TSLA 0.2 lots, LHX 0.3, LLY 0.3, AVGO 0.8 — the four **smallest**
quantities in the sample, each paying **exactly $0.04 round trip**, where
$0.02 × quantity would be $0.008–$0.032. They pay *more* than the per-share
fee, not a multiple of it: they are hitting the minimum. A multi-fill
explanation predicts the **largest** deals, not the smallest. The per-share
conclusion and the 2000-wire figure are unaffected and were independently
re-derived; only the stated mechanism was wrong. It is retracted in the config
text, and `tick-cost-schedule.test.js` now pins the retraction so the wrong
mechanism cannot quietly come back.

Three earlier honesty corrections, also in the config text:

- **`stock_us` was quoted as "median 0.646 bps" in the first draft. That was
  wrong** — it was the midpoint of a bimodal sample (24 DOW.US rows at 6.0–6.8
  bps *because DOW is a $30 stock*, 36 rows at 0.16–0.72), and seven more
  DOW.US rows would have moved the "measured" figure tenfold. The fee is per
  share; modelling it as a rate was modelling the wrong thing.
- **`commodity: 0.08` is n = 6 on one symbol.** It is carried because it is
  non-zero and small, not because six gold deals settle what NatGas costs, and
  the config says so in those words.
- **Slippage is a placeholder in every class.** The statements carry no
  intent-vs-fill pair. One documented placeholder, not six invented ones.

`agent/lib/tick-cost-schedule.test.js` pins all 24 numbers **by value**. The
first draft asserted only that the prose contained the word "MEASURED", and a
checker moved `commodity` from 0.08 to 0 with the whole suite still green.

### 16.5 What happens to the evidence already recorded

**Nothing is silently re-judged, and nothing already recorded is re-scored.**

- The 236 closed shadow trades keep their recorded `net_r`. They carry NULL in
  `cost_class` / `commission_wire` / `commission_bps` / `slippage_wire` /
  `slippage_bps`, which is the truth about them: closed spread-only. They are
  **excluded from the SHADOW_PASSED verdict** — not re-priced, not discounted,
  simply not evidence for a cost model they never paid. The view reports them
  as `uncostedTrades` so the exclusion is visible rather than a quiet gap.
- Any `SHADOW_PASSED` record written before this PR carries no
  `provenance.costSchedule`. Read it as earned under the spread-only model.
- The schedule applies to books created **after** the push (the existing P6a
  rule), so no open shadow trade is re-priced mid-flight. In practice: the
  demo sidecar starts charging at the next shadow re-warm, and the bar becomes
  reachable again only after 30 charged trades and 8 charged losses close.

### 16.6 The sensitivity result

`/state/tick-shadow` carries `costSensitivity` per side and per profile: profit
factor, net R and average R at **0 ×, 1 × and 2 ×** the schedule, each trade
re-priced from its recorded fill prices with its own slippage stripped first.
The class comes from the **row's own** `cost_class` where it has one and only
otherwise from the keeper's current symbol map, and a disagreement between the
two is counted as `classDisagreements` — a symbol id re-mapped between the
trade and the read is exactly where a silent re-price lies.

Round-trip cost as a fraction of R, at a stop of 20 bps of price:

| class | cost per round trip | EURUSD | NAS100 | AAPL.US | 0700.HK | DOGEUSD |
|---|---|---|---|---|---|---|
| `index_cfd` / `crypto` | 1.0 bps | 0.050 R | 0.050 | 0.050 | 0.050 | 0.050 |
| `commodity` | 1.16 bps | 0.058 | 0.058 | 0.058 | 0.058 | 0.058 |
| `fx` | 1.70 bps | 0.085 | 0.085 | 0.085 | 0.085 | 0.085 |
| `stock_hk` | 31.0 bps | — | — | — | **1.550 R** | — |
| `stock_us` | flat $0.02 + 1 bps | — | — | **0.115 R** | — | — |

Two findings the owner should see:

1. **HK stock is not a haircut, it is the trade.** A 31-bps round trip eats
   1.55 R at a 20-bps stop, so a 3 R target cannot clear it and the
   `minTargetToCost` screen (3) will now refuse most HK-stock signals outright
   rather than record them as profitable. That is what the 9618.HK deal —
   115.49 USD on a 388.64 USD gain — was already saying.
2. **The US-stock fee scales with the SHARE PRICE, not the trade.** The same
   $0.02 is 0.115 R on AAPL at $310 and would be 1.2 R on a $30 stock at the
   same 20-bps stop. A tick strategy on cheap US names is not viable at these
   fees, and that is now visible in the schedule instead of being averaged away
   by a class-wide bps figure.

The live per-trade figures come from `/state/tick-shadow`; they could not be
computed here, because this worktree has no copy of the demo sidecar's ledger.
The table above is arithmetic on the schedule and does not need it.

### 16.7 What an operator sees on the first loop after deploy

- The guard push carries `tickShadowSim.costs` with the six classes and an
  `id → class` map, **only when at least one symbol resolved**. With none
  resolved the schedule is omitted entirely — an empty map is a full replace
  that would charge every book the 15-bps fallback and overwrite a correct map
  the sidecar already holds. With recording OFF the schedule is **cleared**
  (`costs: {}`), so no stale map survives a switch off and back.
- A symbol name that does not classify is logged once per side and charged the
  fallback: `symbol X has no cost class — charged the fallback schedule`.
- `SHADOW_PASSED` refuses with `shadow_cost_model_unproven` until the demo
  sidecar is redeployed with this build and has closed enough rows that were
  **demonstrably charged** the schedule it reports — not rows that merely
  carry a class name. That is expected and it is the point.
- **Right after any schedule push**, books already open keep closing under the
  old schedule; those rows fail `cost_terms_differ` and drop out of the
  evidence until the books re-warm. The refusal names the count and the
  reason, so the window is visible rather than a silent stall.
- `REPLAY_PASSED` refuses any trial whose `sim` shows `costSource` other than
  `class`, so a research run on a symbol the keeper has never mapped cannot
  clear the rung.
- The shadow portfolio's profit factor **falls** from the next re-warm onward,
  and HK-stock signals begin being refused by the cost screen
  (`rejectedCost` rises). Neither is a regression.

### 16.8 What this PR does NOT close

- **The slippage placeholder.** 0.5 bps per side is a number nobody measured.
  Until the owner supplies a real intent-vs-fill figure, the 0 × / 1 × / 2 ×
  spread in §16.6 is the honest way to read the bar.
- **`commodity` at n = 6.** One symbol cannot speak for a class. If the owner
  trades metals at size this needs re-measuring.
- **The six-letter FX rule.** `costClassOf` classifies any six-letter name as
  FX unless it matches the crypto-base list. BNBUSD was silently FX until this
  PR; the next such pair will be too. The statements-derived test catches the
  ones the owner has actually traded, not the ones they might.
- **The per-deal minimum and the per-lot fee.** Both fit the statements better
  than the rate this schedule charges (60/60 vs 57/60 for the US minimum), and
  neither can be modelled while the shadow book is size-free. Closing this
  needs the book to carry a size, which is a larger change than a cost table.
- **A class whose every term is zero cannot produce evidence.** `index_cfd`
  and `crypto` have zero commission and clear the "charged" checks only on the
  0.5 bps slippage placeholder. If the owner sets that placeholder to zero,
  those two classes become uncharged and no trial or shadow trade on them can
  pass a rung. That is arguably correct — a zero-cost class yields zero-cost
  evidence — but it is a coupling worth knowing about before editing the
  placeholder.
- **The C++ build gate had no header dependencies.** Found in round two and
  fixed as its own commit ahead of this one, because it is repo-wide and not
  PR-L's: `make -C cpp-exec test` rebuilt nothing on a header change and
  re-ran stale binaries, so any such result quoted before that commit — mine
  included — was vacuous.

---

## 17. Follow-up — two corrected claims and two gaps with no register row (docs only, 20-09-2026)

Dated follow-up per the plan's standing rule, and per owner principle 5 (**the
`.md` plans are checked** — kept audited against the code). **This section
changes no code and no configuration.** It records what the code does today,
where earlier sections of this file said otherwise, and two things the code
does that nothing in the repository declares as intent.

Every `file:line` below was opened on `b9f5931` before it was written here.
Nothing in this section is claimed as IMPLEMENTED; TM-27 stays `PARTIAL` and
the two new register rows are filed `PLANNED`.

### 17.1 Corrected claim 1 — the spot feed is its own connection, and a second connection ADDS a rate budget

Earlier readings treated the sidecar's quote feed as traffic on the order
connection, and therefore treated cTrader's rate limit as a budget the feed and
the order path share. Both halves are wrong at source.

- **The feed is a dedicated, subscribe-only WebSocket.**
  `cpp-exec/src/spot_feed.hpp:3-10` states the design and the reason in the
  file's own words: a tick arriving while the engine's "single
  mutex-serialized connection" is blocked awaiting an
  `EXECUTION_EVENT`/`RECONCILE_RES` would be "silently logged by
  `handleUnsolicited()` and dropped — never reaching the dispatcher", so "a
  second, subscribe-only connection avoids that entirely; it never sends
  order/reconcile traffic, so it's always free to read". `SpotFeed` owns its
  own `CtraderWs ws_` (`spot_feed.hpp:177`), distinct from `ExecEngine`'s
  `CtraderWs ws_` (`engine.hpp:313`).
- **The rate limit is per CONNECTION.** `cpp-exec/src/request_pacer.hpp:6-12`
  quotes the cTrader Open API docs directly: "a maximum of 50 requests per
  second per connection for any non-historical data requests" and "5 requests
  per second per connection for any historical data requests". The 5/s figure
  is the HISTORICAL limit only; the ordinary limit is 50/s. The pacer's own
  comment adds that "this sidecar holds ONE connection, so the budget is per
  process" — that is the pacer's scope (the engine's request connection), not
  a statement that the feed draws on it.

The consequence, stated plainly because the earlier reading had it backwards:
**a second connection adds a budget, it does not split one.** The spot feed
does not spend the engine's 50/s, and the engine's pacing is not relieved by
the feed being quiet.

### 17.2 Corrected claim 2 — a Railway VOLUME is not required to run the tick shadow; `TICK_SPOOL_PATH` is

`TICK_SPOOL_PATH` is the construction gate for the **entire** tick block, not
only for the disk writer:

- `cpp-exec/src/main.cpp:191-193` — the recorder is constructed only when the
  variable is non-empty.
- `main.cpp:259-263` — `tickFirer.start()` is inside `if (tickRecorder)`.
- `main.cpp:264` — the symbol workers, the tick strategies and the shadow
  books are built inside the same guard (`TICK_WORKERS`, default 2).
- `main.cpp:1361` — `POST /config tickShadow` is honoured only
  `&& tickWorkers`, so with no workers the switch is ignored.
- `main.cpp:764` — `GET /tick-status` answers
  `{"enabled":false,"reason":"TICK_SPOOL_PATH not set"}`.

What the path has to point at is modest. `TickRecorder::start()`
(`cpp-exec/src/tick_recorder.cpp:311-361`) needs a creatable directory and an
exclusive `flock` on `<dir>/.recorder.lock`; a container-local path satisfies
both. And `main.cpp:200-206` KEEPS the recorder object even when `start()`
fails — the failure is logged ("recording stays off") and the workers, the
strategies and the shadow books are still built.

The shadow does not read the spool. It runs off the raw tap:
`cpp-exec/src/tick_tap.hpp:80-81` describes the tap `main.cpp` installs on the
feed, and `tick_tap.cpp:17-21` dispatches the classified observation to the
workers on every admitted event, independently of whether anything is written.
A full spool stops only `writeRecord` (`tick_recorder.cpp:587-600`, state
`PAUSED_RESERVE`).

**Where a volume does matter: arming.** `disk_reserve_clear`
(`agent/services/tick-readiness.js:80`) fails on `PAUSED_RESERVE` or a mount
over the stop threshold, and it is one of the three `PAUSE_CHECKS`
(`agent/services/tick-permits.js:50`) whose failure withholds an account's
standing tick permits. So the boundary is:

| Want | Needs |
|---|---|
| Workers, strategies, shadow books, shadow evidence | `TICK_SPOOL_PATH` set to any creatable directory — **container-local is enough** (nothing survives a restart; a restart is what the recording loses) |
| A durable recording, and sealed segments to replay | a mounted volume |
| **Arming** (a live tick permit) | a mounted volume, because `disk_reserve_clear` is a `PAUSE_CHECK` |

Two related facts, both read at source:

- **The spool cap is 2 GiB, not 10 GB.**
  `cpp-exec/src/tick_recorder.hpp:178-181`: `spoolCapBytes = 2ull << 30`,
  `reserveMinBytes = 2ull << 30`, `reservePct = 20` (and
  `segmentBytes = 64ull << 20`). The "10GB volumes" in
  `docs/tick-momentum/plan.md` §10 and in TM-27's requirement title are the
  owner's reported Railway volumes as filed on 10-09-2026 — not the spool cap,
  and not the mount that was later measured (50 GB at `/data` on cpp-exec).
  `docs/tick-momentum/README.md` already stated 2 GiB in its phase table and
  now states it in the preconditions too.
- **The spool directory is created with a single-level `::mkdir`**
  (`tick_recorder.cpp:321-322`), not `mkdir -p`. `/data/tick` works on cpp-exec
  because `cpp-exec/entrypoint.sh:13,19` runs `mkdir -p` and `chown appuser`
  as root before `runuser` drops privileges. A sidecar without that entrypoint
  step, given a nested path, fails at the first missing parent.

**What is NOT corrected: §12.2's finding stands.** cpp-acct has no
`TICK_SPOOL_PATH`, so it has no workers, no strategies, no shadow books and no
firer, and "the shadow still runs off the feed there" remains FALSE. Only the
remedy was wrong. §12.3's row now reads "the owner sets the path; a volume is
needed only before arming" in place of "the owner sets the path and a volume",
and §12.2 carries the same correction inline together with the current line
numbers, which had drifted from the ones that bullet quotes.

### 17.3 Gap with no register row — a tick fill is not owned by the bot's position machinery (new row TM-43)

This is the principle-5 failure this section exists to record: the behaviour is
in the code, it is not what anyone appears to have intended, and no plan, no
register row and no test declares it either way.

The chain, each link opened:

1. **The label.** `cpp-exec/src/tick_firer.cpp:74-78` builds
   `"tick:" + profileHash`, appending `"|||||||" + intentId` when there is an
   intent tag; `:114` sets it on the order payload.
2. **The parser.** `agent/lib/trade-labels.js:192-194` splits on `|`,
   uppercases field 0 and looks it up in `REV_SOURCES`. `"TICK:<hash>"` is in
   no such table, so `source` is `null`.
3. **Ownership.** `isOurs` (`trade-labels.js:340-343`) returns true only for
   `autopilot`, `copilot` or `preopen`. It returns **false**.
4. **Adoption.** `agent/services/reconciler.js:395-400` therefore sets
   `adoptedSource = 'external'` and the thesis "External position —
   reconciliation import"; `reconciler.js:498` gates `stampAdoptedFromIntent`
   on `ours`, so it is never called.

`external` is then skipped by every enumeration built for bot positions:

| Where | Line | Effect on a tick position |
|---|---|---|
| `agent/loop.js` `selectActivePositions` | `2596-2600` | admitted by the whitelist (`autopilot`, `preopen`, `external`) — the one place it is not filtered out |
| `agent/loop.js` equity stop | `5258` | `if (p.source === 'external') continue` — skipped |
| `agent/loop.js` exit-mark stamping | `2331` | `if (pos.source !== 'external') stampExitMarks(...)` — not stamped |
| `agent/services/fast-monitor.js` | `326`, `347` | skipped twice: excluded from the sidecar quote pull, then `continue`d in the per-position loop ("observe-only") |
| `agent/services/session-open-guard.js` | `81` | `AND (source IS NULL OR source != 'external')` — skipped |
| `agent/services/naked-position-guard.js` | `62` (stated), `475` (`HUMAN_SOURCES`) | deliberately exempt as "the owner's own trade" |
| `agent/services/profit-keeper.js` | `406` | **covered** (scope `all` and scope `external,manual` both include it) |
| `agent/services/loss-guardian.js` | `146` | **covered** |
| `agent/services/cockpit-intention.js` | `79` | reports it as keeper-managed, on the same rule |

The firer sets a broker bracket at placement — `relativeStopLoss` and
`relativeTakeProfit` on the order (`tick_firer.cpp:111-113`) — and that is the
whole of the protection a tick position would carry from the bot's side.

**So a tick position placed today would be managed by the MANUAL-position path**
— broker bracket, profit keeper, loss guardian — and would be invisible to the
fast monitor, the equity stop, the session-open guard, the naked-position guard
and exit-mark stamping. That may even be a defensible choice. Nothing in the
code says it was made. Filed as **TM-43** (`PLANNED`, related blocker B16):
"A tick fill is owned and managed by the same machinery as a bar entry."

### 17.4 Gap behind it — a tick close cannot produce a complete `position_history` row (new row TM-44)

`agent/services/position-history.js:79` lists `direction_reason` among
`REQUIRED_FIELDS`, so by the module's own definition a row without it is
incomplete. The value has exactly one source: `directionReasonFor`
(`position-history.js:99-106`) reads `risk_events.proposal_json`, the record
carries it at `:286-292`, and `:255` stamps
`sources.direction_reason = 'risk_events.proposal_json'`.

The tick path writes no `risk_events` row — there is no such write in
`agent/services/tick-*.js` — so there is nothing for that lookup to find.

The one mechanism that would attach a risk event to an adopted position,
`stampAdoptedFromIntent`, is unreachable for a tick fill (§17.3, gated on
`ours`) and **would miss even if it were reached**: its lookup is a ±5-minute
window around the INTENT's `created_at` (`agent/services/reconciler.js:45-53`),
while a standing tick permit is created by the feeder pass minutes to hours
before the fill it eventually authorises. The window misses by construction,
not by timing luck.

Downstream, the capture queue pays for this on every tick close: `MAX_ATTEMPTS`
6 (`agent/services/position-capture.js:73`) and `MAX_REVERIFY` 3
(`position-capture.js:143`) are spent chasing a verdict that cannot complete,
and the row still records no reason.

Owner principle 4 — **"Unknown" must not happen** after four weeks of trading;
every trade has a reason — is measured against the bar path today. Measured
against the tick path it cannot hold. Filed as **TM-44** (`PLANNED`):
"A tick position's close lands as a complete `position_history` row."

### 17.5 What this section does not claim

- Nothing here is IMPLEMENTED. TM-27 remains `PARTIAL`, and its evidence column
  now names what is still unmeasured: no per-service mount/UID/statfs/free/inode
  snapshot for either environment (the `/state` reads still answer 401, TM-37),
  and cpp-acct has no spool path set at all.
- TM-43 and TM-44 are `PLANNED`. Neither describes work done in this change.
- No tick order has been placed by this repository, and this change does not
  make one possible.
- The facts in §17.1–§17.4 are read from source, not from a live service.
  Nothing here was confirmed against a running sidecar, because the bearer
  token blockage in §12.3 is unchanged.
