# HVN-Targeted Take Profit Spec — bot-trade

**Repo**: `ang-kl/bot-trade`
**Branch**: TBC (recommend `feature/hvn-tp`, cut from current working branch)
**Status**: Draft for Claude Code implementation — PROPOSE-FIRST: no file may be edited until the implementation plan in §7 is echoed back and approved
**Author**: Adrian Ang
**Source**: Trader Dale, *Order Flow* (13.5.2024), pp. 97-101 "Volume-Based Take Profit"; pp. 113-137 Volume Profile setups
**Origin conversation**: Order flow PDF audit, 01-08-2026

---

## 0. Objective

Add a **volume-structure take-profit candidate** to `agent/lib/bracket-advice.js`: when a TP suggestion is requested, compute the nearest High Volume Node (HVN) in the trade's direction and offer it alongside the existing R:R-floor suggestion. The trader (or strategy caller) chooses; nothing is auto-filled.

Rationale (profit-factor lever): fixed R:R targets ignore where price statistically pauses. Placing TP at the near edge of the next HVN raises the probability the target is tagged before an adverse rotation, lifting win rate without widening stops. This is Trader Dale's Volume-Based TP rule adapted to tick-volume profiles (the standard FX approximation — see audit finding §1.3, order-flow footprint data is not available on the cTrader feed and is out of scope here).

This is a **suggestion-layer change only**. No execution path, sizing, or guard logic changes.

---

## 1. Non-Negotiable Constraints

1. **Advice, never auto-fill.** `describeBracketGap()` currently returns a suggestion the caller must act on. That contract is preserved exactly. No order payload is ever mutated (existing file-header covenant, bracket-advice.js lines 12-15).
2. **R:R floor still binds.** An HVN target below the strategy's `minRrFor()` floor would be refused by the risk gate on submission. Such an HVN candidate must be **suppressed, not rounded up** — a suggestion the gate rejects is worse than none (existing comment, bracket-advice.js ~line 73).
3. **`lib/` must not import `services/`.** bracket-advice.js lives in `agent/lib/`. The HVN computation must depend only on `lib/indicators.js` (`volumeProfile`) and/or `lib/volume-structure.js`. Do NOT import `services/strategies.js` beyond the existing `minRrFor` import, and do not touch the known import-cycle path (volume-structure.js header documents the risk.js → registry → vp-value.js cycle).
4. **Fail-open to current behaviour.** If bars are absent, stale, or the profile is degenerate (flat series, <30 bars), the function returns exactly today's R:R-floor suggestion. HVN logic must never make the advice path throw.
5. **Precision discipline.** All suggested prices pass through the existing `roundPrice()` helper with broker `digits` when available.
6. **No new data fetches inside lib/.** Bars are passed in by the caller via `ctx.bars`. bracket-advice.js stays pure and synchronous.

---

## 2. HVN Definition (new, `agent/lib/volume-structure.js`)

`volume-structure.js` currently exports LVN logic (`LVN_MAX_POC_FRACTION = 0.3`). Add the mirror:

```js
export const HVN_MIN_POC_FRACTION = 0.7
```

A profile bucket is an **HVN** when its volume ≥ 70% of the POC bucket's volume. Adjacent qualifying buckets merge into one node; the node's price is its volume-weighted centre, and its **near edge** (the boundary closest to entry) is the tradeable level.

New pure function:

```js
/**
 * hvnNodes(bars, opts) → [{ price, nearEdgeLo, nearEdgeHi, volume, pctOfPoc }]
 * Sorted by price ascending. Pure read over bars; takes no trade decisions
 * (file covenant). Reuses volumeProfile() from indicators.js — composite
 * type by default, buckets configurable (default 24, matching existing use).
 */
export function hvnNodes(bars, opts = {}) { ... }
```

Threshold 0.7 is the initial value only; it must be a named export so the backtest sweep (§6) can vary it (0.6 / 0.7 / 0.8).

---

## 3. Changes to `agent/lib/bracket-advice.js`

### 3.1 New helper (module-private)

```js
/**
 * hvnTakeProfit({ entry, sl, side, bars, digits, rrFloor })
 * → { price, node, rr } | null
 *
 * 1. Direction from the stop (same rule as existing code: sl < entry → long).
 * 2. nodes = hvnNodes(bars). Filter to nodes strictly beyond entry in the
 *    trade direction, with the node's near edge at least 1 bucket-step away
 *    (a target inside the entry's own node is noise).
 * 3. Candidate = near edge of the FIRST such node (Dale's rule: "place TP
 *    a bit BEFORE the heavy volume area", p. 98 — the near edge is that
 *    "bit before" made mechanical).
 * 4. rr = |candidate - entry| / |entry - sl|. If rr < rrFloor → return null
 *    (Constraint 2: suppress, never inflate).
 * 5. Return roundPrice(candidate, { digits, entry, sl }) with rr and node
 *    metadata for the suggestionBasis string.
 */
```

### 3.2 `describeBracketGap()` extension

When `field === 'tp'` and `Array.isArray(ctx.bars) && ctx.bars.length >= 30`:

- Compute both candidates: existing `rrFloor` price and `hvnTakeProfit()`.
- Return shape gains two optional fields, additive only (no existing field renamed or removed — callers and tests must not break):

```js
{
  ...existing fields,
  suggestion,            // unchanged: the R:R-floor price (primary, always present when computable)
  suggestionBasis,       // unchanged
  hvnSuggestion,         // number | null
  hvnSuggestionBasis,    // e.g. "near edge of HVN node at 1.27410 (92% of POC
                         //  volume, composite 24-bucket profile over 240 bars),
                         //  2.1R against the stop"
}
```

- `message` string: when `hvnSuggestion` exists, append one clause: `"… ${suggestion} satisfies the R:R floor; ${hvnSuggestion} sits at the near edge of the next high-volume node (${rr}R)."` No other message change.

### 3.3 Explicitly NOT in scope

- No change to `bracketGapField()`, `roundPrice()`, exec chokepoint, guards, sizing, or any `services/` file except the two named in §4.
- No SL-side HVN/LVN logic (that is lever 2, separate spec).
- No autopilot or VPO wiring.

---

## 4. Caller Wiring (minimal, two sites)

The two routes that build `ctx` for `describeBracketGap` (verify exact paths against current repo state before editing; expected: the manual-trade advice route and the analysis-execution route that already read `volMeta.digits`) each pass `bars` they **already hold in scope** for the symbol/timeframe in play. If a route does not already hold bars, it passes nothing and the HVN fields stay null — Constraint 6 forbids adding fetches for this feature.

---

## 5. Tests (write BEFORE implementation, per repo discipline)

`agent/lib/volume-structure.test.js` — add:
- T1: synthetic bars with one obvious volume shelf → single HVN node, correct near edges.
- T2: adjacent qualifying buckets merge into one node.
- T3: flat series / empty bars → `[]`, no throw.
- T4: HVN and LVN thresholds do not overlap on the same fixture.

`agent/lib/bracket-advice.test.js` — add:
- T5: long trade, HVN beyond entry above rrFloor → both suggestions present, hvn basis names node % and R multiple.
- T6: HVN candidate below rrFloor → `hvnSuggestion: null`, primary suggestion untouched.
- T7: no `ctx.bars` → output byte-identical to current behaviour (regression pin).
- T8: short trade direction derived from stop, HVN selected below entry.
- T9: rounding respects `digits` (reuse existing precision fixture pattern).

---

## 6. Validation Gate (before merge)

Run `backtest-sweep` on the VA-breakout family comparing TP modes {rrFloor-only, hvn-edge, min(hvn, rrFloor-price... i.e. nearer-of)} across HVN_MIN_POC_FRACTION ∈ {0.6, 0.7, 0.8}. Promotion criterion: **profit factor improvement with win-rate lift and no drawdown deterioration beyond current tolerance** on ≥ 2 symbols. Record the sweep table in the PR description. If no configuration beats baseline, the feature ships suggestion-only (it is advice; the trader still benefits from seeing the level) but is NOT wired into any strategy default.

---

## 7. Propose-First Execution Order (Claude Code)

Echo this plan back for approval before touching any file:

1. **G0 — Read**: bracket-advice.js, volume-structure.js, indicators.js `volumeProfile`, both caller routes, both test files. Confirm §4 paths. Report discrepancies; STOP if the return shape of `describeBracketGap` has changed since this spec.
2. **G1 — Tests first**: add T1-T9 failing tests. Commit.
3. **G2 — Implement**: `HVN_MIN_POC_FRACTION` + `hvnNodes()` in volume-structure.js; `hvnTakeProfit()` + `describeBracketGap` extension in bracket-advice.js. Commit when T1-T9 green and full suite green.
4. **G3 — Wire callers** (§4). Commit.
5. **G4 — Sweep** (§6). Attach results. STOP for owner decision on strategy wiring.

Each gate ends with a two-line status bar per `~/.claude/CLAUDE.md`. No gate proceeds without explicit approval.

---

## 8. Known Interactions / Do-Not-Touch

- `loop.js:1029` orphan/dedup bug — unrelated; do not modify loop.js in this branch.
- `hold_duration_ms` never-written bug — unrelated.
- vpo-feeder / cpp-exec sizing contract — untouched (this spec never computes size).
- Volatility-gate spec Layer 2 — a future revision may scale the HVN near-edge buffer by vol regime; out of scope now, noted so the two specs stay compatible.
