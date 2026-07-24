# Claude Code prompt — Workflow Audit additions (both audit pages)

Copy-paste this into Claude Code in the bot-trade repo:

---

Read `design_handoff_trading_dashboard/Trade Workflow Audit.dc.html` and `Trade Workflow Audit Mobile.dc.html` — they were updated with new sections. Amend the audit pages in this codebase to match, pixel-faithfully (copy exact inline style values from the design files; blue up / red down, NO GREEN; Inter; tabular-nums).

## 1. Expandable audit rows (desktop table + mobile cards)
Each trade row gets a ▸/▾ toggle (whole row clickable). Expanded panel is a 2-column grid (`1fr 1.2fr`, tinted `var(--acs)`, radius 10px, inset left 20px):

**Left — "Stage context"** (4 key-value rows, 64px label column):
- `Lab` — param version + setup score vs floor: `params v2.3 · setup score 0.72 (floor 0.55)`
- `Bridge` — `slippage 0.8bp · spread 1.2× backtest ✓` (⚠ instead of ✓ when spread ratio > 1.5)
- `Regime` — quadrant at entry + `direction agrees ✓` / `direction DISAGREES ✕`
- `MAE / MFE` — `-41 / +188 vs closed +$152`

**Right — "Management timeline — every decision, coded vs manual"**:
timestamped rows (38px time column): entry filled (slippage/spread), partial scale-out 50% @ 1R (coded rule ref), SL moved to breakeven (trailing rule), MANUAL closes last. Color: coded = `--sb` grey; manual = `--wrn` amber; premature manual = `--dn` red bold. Touched trades end with a counterfactual line in amber: `counterfactual: plan untouched → TP (+1.8R)`.

Data model additions per trade: `ver, conf, quad, agree, slipBp, sprX, mae, mfe, acts[{t,k,d,m,bad}], wouldHave`. Strategy display name now includes version (`fib 61.8% fade v2.3`).

## 2. "Vetoed signals — bot declined to trade" section (below the table)
Table: Date·signal / Symbol(+side) / Strategy / **Veto reason — which guard fired**. Five guard classes to support: correlation/regime saturation cap, news-calendar blackout (±15 min), spread guard (live vs backtest ratio), confidence floor (score < threshold after quadrant penalty), risk budget (daily loss-cap consumed → 0 lots). Subtitle: "valid Lab signals killed by a pre-trade guard · N in 30D · these protect the edge silently".

## 3. "Override scoreboard — human vs code" section (beside vetoes, grid 1.3fr/1fr)
Three stat tiles: **Circuit breakers saved** (+$, amber border, blue value) · **Premature closes cost** (−$, red border, red value) · **Net human impact** (signed, colored by sign). One-line verdict under them: net ≥ 0 → "interventions are net-protective so far — but only the circuit-breaker class"; else "manual hands are costing money vs letting the code run — premature closes dominate".

## 4. Mobile audit page
Same three additions adapted to cards: stage-context + timeline inside the expanded trade card, vetoes as a card list, scoreboard as three stacked tiles.

## 5. Bug guard
In any `componentDidUpdate(prevProps, prevState)` (or effect) driving the GSAP stepper replay: guard `prevState` — `if (ps && ps.flt !== state.flt)` — it can be undefined on some update paths and was throwing on every re-render.

Verify against `SECTIONS.md` when done and list anything still unchecked.
