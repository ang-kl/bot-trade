# 00 — Reconciliation, before any code is edited

Phase 0 of `instr/Bot-Trade Verified Defect Repair and Decision-Integrity
Implementation Prompt v1.0.md`. Nothing in this document changes behaviour.
Its only job is to say which audit findings are still true **at this SHA**, and
to refuse to carry forward the ones that are not.

## Freeze

| | |
|---|---|
| Branch | `claude/handover-outstanding-file-1ktjs7` |
| `HEAD` | `9101eb4b206d5cbafc155c75cd68aaa9ba5f96c5` |
| `origin/main` | `9101eb4b206d5cbafc155c75cd68aaa9ba5f96c5` (identical — the branch was reset onto main after #669 merged) |
| Deployed | Railway `sg-trade` restarted 2026-08-06T07:38:17Z, i.e. **after** #666/#667/#668/#669. No `/state/version` route exists, so the deployed SHA is inferred from restart time and PR merge times, not read. |
| Node / npm | v22.22.2 / 10.9.7 |
| Compiler | g++ (Ubuntu 13.3.0-6ubuntu2~24.04.1) 13.3.0 |
| Frozen at | 2026-08-06 07:39 UTC = 15:39 SGT |

Merged today and therefore part of this HEAD: #666 (side-aware sidecar roster),
#667 (audit Part 2), #668 (housekeeping cadence + `?account=all`), #669
(hash-as-secret logout).

## Baseline — the safe command set

Run at the frozen SHA, working tree clean. Exit codes recorded as measured, not
as hoped.

| Command | Exit | Note |
|---|---|---|
| `node --test agent/**/*.test.js` | **1** | 2,841 pass / **1 fail**. The single failure is `agent/services/vpo-feeder.test.js` → "skips when cTrader credentials are not ready", which makes a real network call and fails `fetch failed` in this sandbox. Pre-existing: it fails identically with the working tree clean. |
| `npx eslint .` | 0 | |
| `npx vitest run` | 0 | 59 files, 755 tests |
| `npm run build` | 0 | |
| `npm run check:no-green` | 0 | |
| `make -C cpp-exec CXX=g++ test` | see `machine/baseline.json` | run after a `make clean` |
| `node agent/scripts/backtest-parity.mjs` | see `machine/baseline.json` | |
| `node agent/scripts/exec-parity.js` | see `machine/baseline.json` | **never** with `--order` |

The one failing test is preserved, not repaired and not hidden. It is not
related to any finding below.

## Reconciliation table

| Finding | Original evidence | Current HEAD | Reproduced? | Classification | Action |
|---|---|---|---|---|---|
| **F-SIZE-01** — loss exceeded the account's whole daily allowance (`46130058`) | Part 1 danger proposal | Sizing still converts through `contracts.js`, whose index contract sizes are *assumed* (`US30: 1, … JPN225: 1`, comment: "cTrader typically gives") and whose broker symbol fetch discards `lotSize` (`ctrader-creds.js:104` keeps only `symbolName→symbolId`) | **Not yet** — the specific trade has not been reconstructed | `BLOCKED — EVIDENCE REQUIRED`, with one `CORRECTNESS FIX` candidate already visible (guessed contract size does not fail closed) | Phase 1: reconstruct the trade's lineage from production read routes; then fixture + fail-closed tests |
| **F-RISK-01** — live/demo side contamination | Part 1 SHA: `getCtraderCreds` computed but did not return `isLive`; `sameSideAccountIds` read `undefined` | **FIXED.** `ctrader-creds.js` returns `isLive`; `acting-layer.js` now decides side from the **broker host** first (`credsAreLive`), falling back to the flag | Disproved at HEAD | `NOT A DEFECT` (already repaired) | Do not rewrite. Document the fixing commit; add only the missing regression cases named in Phase 2 |
| **Approval → order leak** | Part 2 funnel 1,802 → 18 → 10 → 7 | Funnel now (7d, read 07:41 UTC): **2,105 → 34 → 24 → 19** (70.6% of approvals ordered). But `/state/dispositions?days=7` returns `counts {}` with **`pendingNow: 55,417`** — after #668 deployed | **Partly.** The leak narrowed; the *terminal-state ledger is still empty in production* | `CORRECTNESS FIX` + `OBSERVABILITY FIX` | Phase 3: find why the sweep writes nothing in production, then reason attribution + a no-terminal-state alert |
| **Effective risk config truthfulness** | Part 2: `minRR` 4.5–6.16 per account vs global 1.5 | `GET /state/risk-full` reads only `req.query.account`; **any other parameter name is silently ignored** and the global config is returned. Unknown account ids resolve to global values with no signal. Overlays live in `acct:<id>:risk_config_json` (`risk.js:307`) written by `actions.js:3995‑4026` and `:4132` with **no actor, time, reason or previous value** | Reproduced at HEAD | `OBSERVABILITY FIX` (route) + `CORRECTNESS FIX` (silent parameter) — thresholds themselves are `OWNER POLICY DECISION` | Phase 4: strict parameters (400), `global`/`overlay`/`effective` with provenance, append-only overlay history. **No value changes.** |
| **Cup & Handle divergence** | Part 2: diagnostic 1,777 clearing all gates vs 0 production `cup_handle` signals | `cup-handle.js` (production) and `cup-handle-funnel.js` (diagnostic) are separate code paths; no harness compares them on identical input | Not yet reproduced under controlled input | `TEST/REPLAY INFRASTRUCTURE` | Phase 5: deterministic parity harness reporting the first divergent gate. No gate weakened. |
| **Trade-origin lineage** | Part 2: postmortems missing thesis/confluence/strategy | No `origin` column exists on trades (`db.js` has no origin enum; only `fvg_origin_vol_regime`, unrelated) | Reproduced at HEAD | `CORRECTNESS FIX` (schema + propagation) | Phase 6: canonical origin enum, propagation, coverage disclosure, reversible backfill |
| **Entry/exit calibration mismatch** | Part 2: entry ≈4.5–6.16R vs best winner 0.91R | Unchanged — no replay tooling exists | Reproduced as a *measurement*, not as a cause | `OWNER POLICY DECISION` pending `TEST/REPLAY INFRASTRUCTURE` | Phase 7: offline counterfactual only. No live exit setting touched. |

## Contradictions between the audits and current HEAD

1. **The funnel figures in Part 2 are already stale.** The repair prompt quotes
   1,802 → 18 → 10 → 7. The same route now reports 2,105 → 34 → 24 → 19 over a
   7-day window. Both are true of their own moment; only the second describes
   the system being repaired. Any work that treats "8 approvals vanished" as a
   fixed quantity is working from a number that has moved.

2. **`pendingNow: 55,417` is the finding, not the funnel.** #668 fixed the
   *cadence* (housekeeping ran on `loopCount % 100`, and `loopCount` resets
   every process start, so in production it never ran) and the `?account=all`
   read. Production has now restarted with that fix and the disposition table is
   still empty. So either the sweep is not reached, or it is reached and writes
   nothing. That is a live, present-HEAD defect and it is Phase 3's first
   question — **not** an assumption that #668 was wrong.

3. **F-RISK-01 is fixed and the fix is stronger than the audit asked for.** The
   audit asked for `isLive` to be returned. HEAD returns it *and* stops trusting
   it as the primary signal, because six `loop.js` call sites hand-assemble
   creds with no `isLive` field at all. Host-first is the correct invariant and
   it is already in place.

4. **Withdrawn claims stay withdrawn.** `fib_confluence` is ON by default
   (registry `defaultOn: true` since 2026-07-27); `pause-disposition.js:222`
   already checks the strategy toggle before arming, tested at
   `pause-disposition.test.js:172`; `entry_quality` **is** written
   (`loss-postmortem.js:528`). Nothing in this repair programme touches those
   three.

## Files and read-only routes to inspect, by phase

**Phase 1 (sizing)** — `agent/lib/contracts.js`, `agent/services/risk.js`
(sizing at ~`:443`), `agent/lib/ctrader-creds.js:104` (`ensureSymbolMap`
discards `lotSize`/`pipPosition`), `agent/services/vpo-feeder.js`.
Routes: `/state/trades?account=46130058`, `/state/perf-ledger`,
`/state/veto-breakdown`, `/state/risk-full?account=46130058`.

**Phase 2 (side isolation)** — `agent/lib/ctrader-creds.js`,
`agent/services/acting-layer.js`, `agent/services/loss-cap.js`,
`agent/services/profit-ratchet.js`, `agent/lib/exec-engine.js` (`execBaseFor`),
`agent/services/heartbeat.js` (`rosterDrift`).

**Phase 3 (approval lineage)** — `agent/services/opportunity-disposition.js`,
`opportunity-identity.js`, `opportunity-funnel.js`, `agent/loop.js`
housekeeping block, `agent/services/risk.js` (`POST_APPROVAL_FLAG`).
Routes: `/state/dispositions`, `/state/opportunity-funnel`, `/state/decisions`.

**Phase 4 (risk truth)** — `agent/routes/state.js:2817`,
`agent/services/risk.js:307`, `agent/routes/actions.js:3995`, `:4132`,
`agent/services/risk-matrix.js`.

**Phase 5 (cup parity)** — `agent/services/cup-handle.js`,
`cup-handle-funnel.js`, candidate selection (`bestByStrategy`), signal
persistence, strategy-liveness counting.

**Phase 6 (lineage)** — `agent/db.js` schema, `agent/services/reconciler.js`,
`agent/services/loss-postmortem.js`, `agent/services/perf-ledger.js`.

**Phase 7 (exit replay)** — `agent/services/profit-keeper.js`,
`profit-ratchet.js`, `cpp-exec` TrailEngine, `agent/services/guardian.js`.

## Proposed draft-PR boundaries

| PR | Scope | Touches money? |
|---|---|---|
| **A** | Sizing correctness: broker lot metadata, fail-closed on unknown contract size or FX conversion, golden fixtures per asset class | **Yes — sizing.** Owner sign-off before merge |
| **B** | Approval terminal-state integrity: why the sweep writes nothing, reason attribution, watchdog alert, idempotency tests | No |
| **C** | Effective risk truth: strict route parameters, global/overlay/effective + provenance, append-only overlay history. **No threshold changed** | No |
| **D** | Cup detector parity harness + positive controls | No |
| **E** | Trade-origin lineage: enum, propagation, coverage, reversible backfill | No |
| **F** | Offline exit counterfactual tooling | No |

B, C, D, E, F are pure correctness/observability and fall under the standing
auto-merge policy in `CLAUDE.md` once their gate is green. **A does not** — it
changes how real position size is computed, so it stops for the owner.

## Owner-policy decisions that will remain untouched

`minRR` (currently 3.0 on the four demo accounts and 4.5 on live `42993489`),
`perTradeRiskPct`, `maxRiskCapPct`, `dailyLossPct` / `dailyLossLimit`, equity
stops, exposure and position limits, strategy arming, profit-keeper and ratchet
policy, time caps, C++ trail policy, and the deployment of a second sidecar.
Evidence and counterfactuals will be produced for several of these; none will
be changed.

**No live trading action was taken.**
