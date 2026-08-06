# 05 — Cup & Handle parity

Phase 5 of the Verified Defect Repair prompt. **No gate was weakened, no
threshold moved, no detector edited.** Everything below is a measurement.

---

### The claim under test

Audit Part 2: a diagnostic reported **1,777 traces clearing every gate** over a
week in which production emitted **zero `cup_handle` signals**. The diagnostic's
own verdict text: *"that is a bug, not a market."*

Three explanations were open, and the audit could not separate them, because
the two numbers came from two code paths fed different windows at different
times:

1. the diagnostic twin's gates differ from production's;
2. the twin sees different bars;
3. production fires and something downstream drops the signal.

---

### R5-1 — The gates are in parity. That is not where the divergence is.

**Classification:** `TEST/REPLAY INFRASTRUCTURE` → finding
**Status:** measured
**Scope:** `agent/services/cup-handle-parity.js` (new), `cup-handle.js` (read only)

`cupHandleParity(bars, timeframe, {dir, opts})` runs ONE bar array through both
`computeCupHandleSignal`/`computeInvCupHandleSignal` and
`traceCupHandleSearch`/`traceInvCupHandleSearch`, and reports whether they
agree, where the best candidate stopped, and — when they disagree — which
difference explains it.

Measured, in `cup-handle-parity.test.js`:

| Suite | n | production fired | twin would fire | disagreements |
|---|---|---|---|---|
| Structured variants (cup depth × handle length × breakout volume × bottom flatness) | 500 | 320 | 320 | **0** |
| Deterministic random walks | 200 | — | — | **0** |
| Positive controls (`cup_handle`, `inv_cup_handle`) | 2 | 2 | 2 | 0 |

The variant grid is the one that matters: random walks rarely contain a cup, so
they exercise the first gate and prove little. The variants are built to stop at
*different* gates — the 500-case scan reports candidates halting at
`no_cup_structure` (100) and `breakout_volume` (80), with 320 clearing
everything. On identical bars, **the two implementations never disagreed.**

So explanation (1) is disproved for the gate logic itself.

---

### R5-2 — The divergence was the bar window, and it was already fixed on 05-08

**Classification:** `NOT A DEFECT` (repaired before this audit ran)
**Status:** disproved as an open defect

`agent/services/fib-strategy.js:609` carries the repair and its reasoning:

> **THE TRACE MUST SEE EXACTLY WHAT THE SEARCH SEES (05-08-2026).** It used to
> be handed the full `closed` array while `computeCupHandleSignal` was handed
> `barsFor()` — up to 450 bars (`ema_pullback`'s requirement sets the fetch
> depth) versus `cup_handle`'s own 210. So the diagnostic searched more than
> twice the history of the code it claims to mirror, and over-reported clean
> setups.

That is explanation (2), named and fixed a day before the audit was written.

#### Production confirms it, and the 1,777 is a pre-fix aggregate

`GET /state/cup-handle-funnel`, read 2026-08-06 08:33 UTC:

| Window | traces | `wouldHaveFired` | deepest reached |
|---|---|---|---|
| 7 days (since 30-07) | 1,119,930 | **1,675** | `cleared_every_gate` |
| **1 day (since 05-08 08:33)** | 139,008 | **0** | `breakout_volume` |

Every "cleared every gate" trace is older than the window fix. In the last 24
hours nothing even reaches `rr_floor`: 746 candidates arrive at
`breakout_volume` and **all 746 stop there** — the breakout bar does not carry
the required volume expansion. That is a market condition, not a bug.

**This is the same trap the audit fell into twice before and I fell into
myself: a seven-day aggregate read as a statement about now.** The number was
real; the period it described had already been repaired.

---

### What is still open

Explanation (3) — production fires and something downstream drops it — is
**not** disproved here, only unneeded to explain the 1,777. With zero
would-have-fired traces in the current window there is nothing to test it
against; the moment a post-fix trace clears every gate and no `cup_handle`
signal appears beside it, `cupHandleParity` on those exact bars settles it in
one call.

### Blind spots, disclosed rather than implied

`UNTRACED_GATES` names what the twin structurally cannot see, and `parityScan`
returns it with every report:

- **`vwap_filter`** — production returns null on the wrong side of VWAP when
  `opts.vwapFilter` is set; `traceDirection` takes no `opts` at all. With that
  filter on, a setup production refuses still reads "would have fired".
- **`atr_unavailable`** — production refuses outright (`if (!a || a <= 0) return
  null`); the twin degrades to `sl: null` → rr 0 → `rr_floor`. Same decision,
  different reported reason.

### Policy boundary

No gate threshold (`DEPTH_MIN/MAX`, `ROUND_BOTTOM_BARS`, `BREAKOUT_VOL_X`,
`MIN_RR`, handle ratios) was read from config or changed. The harness cannot
make either path fire; every function it calls is a pure read.

**No live trading action was taken.**
