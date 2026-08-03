# Risk-Decision Audit vs. the Go-Live Goal — ang-kl/bot-trade

**Goal audited:** win rate ≥ 68%, profit factor ≥ 1.68, by 2026-08-12 (the owner's stated real-money gate)
**Source of the goal:** `agent/services/goal-tracker.js:63-69` — `DEFAULT_GOAL`
**Commit audited:** `main` @ `e1c4cd5` (same checkout as the PR #573 audit)
**Scope:** (1) is the goal-tracker's own arithmetic deterministic and ungameable; (2) does the risk-decision pipeline (sizing, guards, circuit breakers) structurally protect or undermine that specific goal; (3) current live standing against the deadline.
**Method:** direct file read + `grep` verification of every cross-file claim + `node --test` where applicable. No live account/API access was available in this session — see §3.

Reproduce with:
```
git clone https://github.com/ang-kl/bot-trade.git && cd bot-trade
sed -n '1,300p' agent/services/goal-tracker.js
sed -n '1,230p' agent/services/risk.js
sed -n '1,200p' agent/services/performance-breaker.js
sed -n '1,130p' agent/services/adaptive-breaker.js
grep -n "armMinPf\|armMinWin\|armMinTrades" agent/services/strategy-autopilot.js
node --test agent/services/goal-tracker.test.js
```

---

## 1. Goal-tracker logic — determinism & verifiability

**PASS on determinism.** `goalTracker()` (`goal-tracker.js:162-199`) is a pure function of DB state and `now`: it reads closed trades via `accountAnalytics`, computes two closed-form inversions, and returns one of five verdict strings. No randomness, no LLM, no self-adjusting threshold.

- **Reachability math is inverted arithmetic, not a forecast.** Win-rate requirement: `needWins = ceil(T·(n+m) − w)` (`:107-110`, docstring `:14-26`). Profit-factor requirement solves for winners needed while holding the *current* average win/loss fixed (`:117-123`), and the assumption is surfaced to the caller rather than hidden (`profitFactor.assumes`, `:259-261`). This is the correct honest framing: PF cannot be inverted without an assumption, and the code states which one it made.
- **No "on track" state exists, by design** (`:128-136`): an account below target that keeps performing exactly as it has been mathematically never reaches the target, so the tracker refuses to report a state that implies passive optimism. This is the single strongest piece of evidence that the tracker is built to be verifiable rather than reassuring.
- **Sample-size gate outranks "met"** (`:141-152`, `RANK` order `:285`): `insufficient_sample` beats a passing number when `trades < minTrades` (default 30). A 2-for-2 record cannot report `met`.
- **Portfolio aggregation is not an average of per-account rates** (`:185-187`): it is recomputed from every trade, so two 50%-accounts with different trade counts do not silently average to 50%. Verified in code; not independently re-derivable without live data, but the comment states the reasoning correctly and matches the implementation shape.
- **Gaming surface, found and disclosed as a limitation, not a defect:** the goal itself (`winRatePct`, `profitFactor`, `deadline`, `minTrades`) is stored in `agent_state` and loadable/overridable (`loadGoal`, `:72-91`) with only numeric-and-positive validation (`num()`, `:78-81`) and a date-format check on `deadline` (`:82-84`). There is **no audit-log write** when the goal is changed — unlike `performance_breaker_json` changes, which do write an `action_log` row via `PB_AUTODISARM_OFF` (`performance-breaker.js:102-108`), a goal change leaves no equivalent trail in the code I read. **This means the go-live gate itself could be silently loosened (e.g., PF target lowered from 1.68 to 1.2) with no forced record of who changed it or when**, even though the arithmetic once loaded is fully deterministic. This is the one verifiability gap in an otherwise clean module.

---

## 2. Risk pipeline vs. the stated edge — coherence check

The central question: does anything in the risk-decision pipeline actually enforce, in real time, that the system is operating at or above the 68%/1.68 goal it is being held to? The answer is **no** — and the pipeline contains four independently-maintained numeric bars for related-but-different ideas, none of which match the goal, and none of which reference each other.

| # | Where | What it gates | Threshold | Auto-enforced? |
|---|---|---|---|---|
| 1 | `goal-tracker.js:63-69` | Go-live readiness (the actual question asked) | WR ≥ 68%, PF ≥ 1.68 | **No — read-only report.** Nothing in `loop.js` or `risk.js` consults `goalTracker()` before placing a trade. |
| 2 | `strategy-autopilot.js:89-92` | Which strategy/symbol/timeframe combos get ARMED for live trading | PF ≥ 1.7, WR ≥ 60%, trades ≥ 25 (backtest-derived) | Yes — governs arming, not per-trade risk. |
| 3 | `performance-breaker.js:38-61,169-196` | Rolling live-trade circuit breaker ("all hands on deck") | PF < 0.8 over last 20 closed (min 15) | **Alert only.** `autoDisarm: false` is the *current, owner-confirmed* default (`:43-60`, reversing an earlier 2026-07-20 decision to arm it after PF hit 0.15). |
| 4 | `services/rsi2-seed.js:39` | Backtest arming floor for one specific seed strategy | `GO_PF = 1.5` | Feeds into #2's arming decision for that strategy only. |

**Finding: the only automatic, rolling, PF-aware circuit breaker in the live path trips at PF 0.8 — less than half the 1.68 goal — and even then only sends an alert.** Quoting the breaker's own header: *"AUTO-DISARM IS OFF (owner, 2026-07-30: 'autoDisarm - leave it OFF'). The breaker ALERTS and does not stop trading by itself."* (`performance-breaker.js:14-15`). A strategy could run indefinitely in the band between PF 0.8 and PF 1.68 — arithmetically `at_risk` or `out_of_reach` on the goal-tracker's own verdict scale — without any code path pausing it. The goal-tracker computes the true gap; nothing reads that computation to act.

**This is a real structural gap, not a bug in either module** — each module is internally correct and deterministic on its own terms (§1 and the earlier PR #573 audit both confirmed this pattern of "correct locally, disconnected globally"). The gap is that "are we meeting the go-live gate" and "should we stop trading right now" are answered by two systems that do not talk to each other, using three different numbers (68/1.68, 60/1.7, 0.8) for conceptually adjacent ideas.

**What the pipeline does enforce, correctly and independently of edge quality (capital protection, not edge protection):**
- Per-trade R:R floor, `minRR: 1.5` globally, overridable per strategy (`risk.js:883`, `strategies.js:115-117` — only `rsi2_reversion` at 1.0, with the override documented and honoured by both the live gate and the backtest driver).
- Kelly is a **veto, not a sizer**: positive expectancy ships the full risk-budgeted size (capped by `perTradeRiskPct`/`maxRiskCapPct`, both 5% of balance by default); non-positive Kelly returns volume 0 (`risk.js:532-555`). Confirmed as deterministic and matching the prior `kelly-quarter-fix` finding already on record in this project.
- Adaptive-breaker (3 consecutive losses on ONE strategy) **does** auto-disarm that strategy (`adaptive-breaker.js:35`, `:92` `did: 'disarmed_strategy'`) — unlike performance-breaker, this one acts, but it is a streak detector, not a PF/WR detector, and its own header states plainly why it cannot catch a structurally-losing-but-non-streaky record (win/lose/lose/win/lose/lose grinding PF 0.2 with no 3-loss streak — `performance-breaker.js:7-12`).
- Equity-stop is a same-day dollar-drawdown circuit, unrelated to PF/WR by design (per-account, capital-preservation only).

**Math cross-check (deterministic, independently reproducible):** at the global R:R floor of 1.5, a 68% win rate implies PF ≈ (0.68 × 1.5) / (0.32 × 1) ≈ 3.19 — well clear of the 1.68 target, meaning the *stated* goal is comfortably inside what the R:R floor structurally supports **if realized win rate matches target**. Solving the other direction, PF = 1.68 at WR = 68% only requires average R:R ≈ 0.79 — i.e., the 1.68/68% goal is achievable even with wins smaller than losses on average, provided the win rate holds. The goal is therefore internally consistent with the sizing/R:R architecture; the gap identified above is purely about **real-time enforcement**, not about whether the target is mathematically reachable under the existing rules.

---

## 3. Current live standing against the 2026-08-12 deadline

**Not independently verifiable in this session.** This audit was run from a fresh `git clone` with no bearer token, no live broker session, and no access to the deployed instance's database or `/state/*` HTTP API — the same constraint this project's own scheduled runs record repeatedly (e.g. `edge-steward/2026-07-31-run-fast-monitor-BLOCKED-10th-REBASED.md`: *"Bearer token is still the literal placeholder `007`... No live position or decay review this run"*). I am not going to estimate or infer a win-rate/PF figure without querying the live ledger — that would be exactly the kind of unverified number standing in for hard data this audit exists to catch.

The system already exposes the deterministic answer as a live endpoint: `agent/routes/state.js:1518-1530` — `GET /state/goal-tracker?days=<n>`, which calls `goalTracker()` directly (§1) and returns per-account and portfolio `verdict` (`met` / `at_risk` / `out_of_reach` / `insufficient_sample` / `no_data`), the exact win/PF gap, and the required hit-rate on remaining trades.

**To get a verified current reading, run against the live instance:**
```
curl -s -H "Authorization: Bearer <real token>" \
  "https://<agent-host>/state/goal-tracker" | jq '.portfolio'
```
That response is the ground truth this audit cannot substitute for.

---

## 4. Critical issues (this audit)

| # | File | Line | Issue | Severity |
|---|---|---|---|---|
| 1 | `agent/services/performance-breaker.js` | 60 | The only live, rolling, PF-aware circuit breaker trips at PF 0.8 (< half the 1.68 goal) and, by explicit owner decision, only alerts — `autoDisarm: false`. Nothing else in the live path enforces the goal-tracker's own gate. | High (structural — the goal has no automatic enforcement mechanism, only a report) |
| 2 | `agent/services/goal-tracker.js` | 72-91 | `loadGoal()` accepts an override from `agent_state` with only type/range validation and no `action_log` write, unlike the parallel `performance_breaker_json` change path. A change to the go-live gate itself is unaudited. | Medium |
| 3 | Cross-file | n/a | Four independent numeric "edge" bars (68/1.68 goal, 60/1.7 arm bar, 0.8 breaker floor, 1.5 GO_PF seed floor) exist with no shared constant or cross-reference between them. Not a bug in any one file, but a coherence risk for future maintenance — a change to the goal will not propagate to the breaker or the arming bar, and vice versa. | Medium |

---

## 5. Verdict

The goal-tracker's own math is deterministic, verifiable, and deliberately refuses to report false optimism (§1) — that module is sound. The risk-decision pipeline's capital-protection layer (R:R floor, Kelly-as-veto, equity-stop, adaptive-breaker) is deterministic and, by the R:R-vs-target cross-check in §2, structurally compatible with the stated goal. **What does not exist is a closed loop between the two**: nothing in the live trading path reads `goalTracker()`'s verdict and acts on it, and the one mechanism that could (`performance-breaker`) is armed at a threshold less than half the goal and, even then, is alert-only by explicit owner instruction. Given the 2026-08-12 deadline is 9 days out at the time of this audit, that is the finding worth raising before, not after, the gate date: **the system will not stop itself from missing the goal — a human has to be reading the alerts and the `/state/goal-tracker` endpoint, because the code will not.**

**Needs Discussion** — not a code defect to "fix" so much as a decision the owner already made once (2026-07-30, turning auto-disarm off) that is worth re-confirming now that it's being measured against a specific dated, numeric go-live gate rather than a generic "don't bleed" breaker.

---

*Every threshold and line reference above was read directly from the cloned repository in this session; none is inferred from a comment describing behaviour elsewhere without independent confirmation, per the same standard applied in the PR #573 audit.*
