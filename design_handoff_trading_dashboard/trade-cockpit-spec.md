# Trade Cockpit — spec for Claude Code

**Start with `BUILD-ORDER.md`** — it is the authoritative work order and wins any conflict with this file. This document covers instrument meaning, MFD algorithms and the data contract.

**What this is.** A modal popup that opens when the user clicks any open-trade row (in the performance dashboard's "Open positions" table, the Fleet strip, or any symbol chip). One symbol, one open position, live-ticking. Reference designs: `Canvas.dc.html` (desktop), `Canvas iPad Portrait.dc.html` (1024pt), `Canvas iPhone.dc.html` (390pt). Read both — copy exact inline style values from them; they are the source of truth for pixel decisions.

---

## 1 · Trigger & shell

- Trigger: click/tap on an open-trade row → open modal for that `positionId`. Also reachable from the Fleet strip inside the cockpit itself (clicking a fleet chip swaps the cockpit to that symbol without closing the modal).
- Size: **65% width × 80% height of viewport at 2K**, min 1100×720, max 1600×980. Centred. Backdrop `rgba(4,7,16,.62)` + `backdrop-filter: blur(3px)`.
- Card: `background: var(--gls)`, `border: 1px solid var(--gbd)`, `border-radius: 18px`, `box-shadow: var(--gsh)`. **The page never scrolls** — everything fits; only the Tweak Journal and Advisories lists scroll internally.
- Dismiss: Esc, backdrop click, or the Close (✕) affordance. Deep-linkable: `?trade=<positionId>` so a refresh reopens the same cockpit. Restore scroll/focus to the originating row on close.
- Breakpoint: below 1100px wide (or portrait aspect) render the **portrait variant** — single column, PFD and MFD as folder tabs (see §7).
- Two page rulers, Microsoft-Word style: a 13px horizontal ruler pinned to the top and a 14px vertical ruler pinned to the left, major ticks every 100px (`var(--sb)`) with numeric labels, minor every 10px (`var(--mu)`). A 1px accent marker inside each ruler follows the pointer with a live px readout chip. **No full-page crosshair lines.**

## 2 · Design tokens (from the reference; do not invent)

```
--bg #060913   --gls rgba(10,14,28,.9)   --gbd rgba(140,165,255,.22)  --edg rgba(90,110,200,.24)
--acc #4f8cff  --acs rgba(79,140,255,.14) --up #4f8cff  --dn #ff4d6d   --dns rgba(255,77,109,.12)
--tx #e8edfb   --sb #9aa8cc   --mu #6b7899  --vio #a855f7  --wrn #ffc466
light theme: see [data-theme="light"] block in the reference
```

Fonts IBM Plex Sans + IBM Plex Mono (see `BUILD-ORDER.md` §3). **Up = blue, down = red — never green.** All numerics `font-variant-numeric: tabular-nums`.

**Type scale — superseded by `BUILD-ORDER.md` §3 and `canvas-variants-spec.md` §0. Historic note:** section headings 11px/700 (Market Says 11px too) · body rows 11px · micro labels 9px · sub-micro (POC, VOL axis captions) 7px · currency label on the price axis 6px · symbol title 20px/700 · header P&L 16px/700 · chart annotations (ENTRY, TP, WPT, WX, SUPPORT, RESISTANCE, EMA legend) exactly **11px**. Body rows are **never bold** — colour carries meaning.

**Heading chips:** every section heading sits in a chip tinted with its own hue at low alpha plus a 1px border in that hue, `border-radius: 5px; padding: 0 7px` — amber `rgba(255,196,102,.16)`, blue `rgba(79,140,255,.18)`, violet `rgba(168,85,247,.18)`, grey `rgba(154,168,204,.16)`. PFD and MFD titles are the only headings with **no** chip.

**Every explanatory sentence is a `ⓘ` hover tooltip, not inline text.**

## 3 · Header row (single line, never wraps)

`SYMBOL` · `LONG · <lots> lots` pill · strategy chip (`fib 61.8% fade v2.3` — strategy name **with version**) · `● OPEN <duration>` pulsing pill · `<P&L> · <R>` (P&L number-rolls on change) · UTC clock · **Manage** button · **Close** button (red) · theme toggle. The three buttons are a nowrap flex group so they never drop to a second row.

## 4 · Left column

### PFD card — 5-column instrument grid, `54px minmax(96px,1fr) 32px 94px 36px`, gap 5px, `overflow:hidden`, height 340px
The sum of fixed columns + gaps must always fit the card — verify `scrollWidth <= clientWidth`.

1. **SPD tape** — momentum in pips/min, ticks + boxed live value, coloured by sign.
2. **PRICE · 15m** (centre) — last 30 candles (blue = closed up, red = closed down), session VWAP dashed amber, horizontal TP/entry/SL rails, footer strip with the four absolute levels. Each candle hoverable (O/C).
3. **VOL** — volume-by-price histogram: 16 contiguous rows filling the column wall-to-wall (no gaps, no pill shapes), gradient fade to the right, amber glowing row = **POC**, violet wash = **Value Area (70%)**, grey = LVN. Bars animate to width on first paint only.
4. **PRICE · R tape** — the merged scale: each price tick with its R value beside it; TP/ENT/SL rails labelled `TP +1.55R` style (price in the tooltip); blue/red edge ticks for **MFE/MAE**; footer showing `MFE / ▼giveback / MAE`. Off-scale rails pin to edge slots with ▲/▼ and displace colliding ticks.
5. **VSI** — P&L rate in R/hour, needle rotates from centre.

Below the grid: **HDG strip** — trend bearing from multi-timeframe consensus, BEAR…CHOP…BULL scale that slides under a fixed pointer.

### Journal + Risk card — full-width sibling of the page grid, `3fr 1fr` (journal ¾, risk ¼)
- **TWEAK JOURNAL** — every adjustment since entry, up to **6 visible rows**, then scrolls. Each row: lettered key (a–f) in an outlined box · timestamp · action, coloured by class (trailing/coded = blue or violet, manual = amber, premature = red). Rows ellipsis with full text on hover.
- **RISK BUDGET** — gradient bar plus **absolute account-currency figures**: Balance, Equity (incl. open P&L), Daily loss-cap, Used today, Remaining + %.

## 5 · Right column — MFD card

Header: `MFD — NAV` + ⓘ + compact right-aligned legend (`━9 ┅20 ┈50 ╌VWAP`, full names in its tooltip). Under it, three **LEG chips** (flown / active / planned), 2 lines each, 10px, ellipsed.

**The chart.** SVG `viewBox="0 0 460 208"`, wrapped in a `position:relative` div with `padding-top:34px; padding-bottom:4px`. **All dynamic labels are HTML overlay spans** inside an absolutely-positioned box that exactly covers the SVG (`top:34px; bottom:4px`) — never `{{ }}` inside SVG `<text>` (it renders zero-size), and never SVG-unit font sizes for text that must be 11px on screen (the viewBox scales).

- **Y axis** = price: major gridlines with labels, 16 minor subdivisions at half weight. Currency code (e.g. `HKD`) as a 6px label at the top of the axis.
- **X axis** = time, **non-linear (log-like)** so recent time gets the most pixels. Piecewise segments (hours → px): `[-48,-24]→30..74`, `[-24,-4]→74..150`, `[-4,0]→150..190`, `[0,4]→190..330`, `[4,8]→330..448`.
- **Mixed resolution** minor gridlines per span: **1h** prior days · **10m** today · **15m** next 4h · **30m** thereafter to TP. A labelled resolution-band strip sits above the plot with the major time stamps (`…NOW 05:42 UTC…`); labels auto-thin so they never collide.
- **Price paths**: flown path (accent, glow) = the trade's real history since entry; dashed grey plan path to TP; EMA 9 (teal solid), EMA 20 (violet long-dash), EMA 50 (warm grey dotted); VWAP amber dashed. **Colour-blind safe: each line differs in hue *and* dash pattern; nothing depends on red-vs-blue.**
- **Terrain** = support/resistance as thin edge lines with faint fills and right-aligned labels.
- **Weather cell** = news event (pulsing ellipse + leader line to its label).
- **TCAS traffic** = correlated symbols as small aircraft glyphs with heading vectors; label chips show the symbol. Heading encodes trending-with vs against you.
- **Volume pane** = bottom 15% (y 182–210), separated by its own axis line: one column per bar, blue = closed up, red = closed down, bars sized to the gap between adjacent bars (tiling, 10% trimmed), hoverable for % of peak.
- **Tweak markers** = diamonds on the flown path with the 5px letter key (a–f) inside. **Bi-directional link with the journal**: hovering either side scales + glows the matched marker, dims the others, and tints the paired row.

**Label de-collision is a required algorithm, not hand-tuned offsets.** Traffic labels split into a left and a right column, are sorted by y, pushed apart to a minimum vertical gap, pushed out of registered obstacle bands (TP, WPT, WX, ENTRY captions), and hard-clamped to the price pane so none can enter the volume pane. Assert zero pairwise overlaps across all chart text nodes.

Below the chart: **MARKET SAYS** — same-heading vs diverging counts and one sentence reading the correlated flow (10.5px body).

Below that: **four bullet bars** in a 2×2 grid replacing the old dial gauges — RVOL, Spread, Margin, Latency. Each row is `label · bar · value`, with a grey band for the typical range and a tick for the threshold *that matters for that metric* (RVOL has a **minimum** 0.6×; spread max 2.5×, margin max 40%, latency max 90ms). Bar is accent normally, amber approaching, red breached. Tooltip explains the metric, its typical range, and tolerance state.

## 6 · Bottom strips

- **ADVISORIES** (left, wider) + **ARMED ACTIONS** (right, 512px) side by side. Advisories = time · level · message, newest first, scrolls. Armed actions = what the bot will do unattended (scale-out waypoint, trail tighten, news blackout) with live distance-to-trigger and ETA. TP/SL levels are **not** repeated here — the PRICE · R tape owns them.
- **INVALIDATION WATCH** — card-less full-width 5-column strip: ✓/✕ tick, short condition label, live value, per-row ⓘ with the exact trigger. Right-aligned verdict line ("thesis intact — all go-around conditions clear").
- **FLEET** — other open positions, **max 5** shown (labelled "top 5 of 8"): symbol · calibrated R bar (framed track, tick every 0.5R, amber centre = entry, span ±2R) · R value. Click to swap the cockpit to that symbol.

## 7 · Variants — see `canvas-variants-spec.md` §3/§3b and `BUILD-ORDER.md` §6 for the binding tables

### Portrait / tablet

1024pt wide, single column. **PFD and MFD become folder tabs** — one visible at a time, tab bar above the card, active tab merges into the card (`border-radius: 10px 10px 0 0`, bottom border matching the card fill). Journal + Risk stay paired; Advisories and Armed Actions split 50/50; Invalidation Watch drops to 3 columns; Fleet wraps instead of scrolling.

## 8 · Data contract

```ts
GET /api/positions/:id/cockpit
{
  position: { id, symbol, quoteCurrency, side, lots, openedAt, strategy, strategyVersion,
              entry, tp, sl, price, pnl, r, mae, mfe },
  account:  { currency, balance, equity, dailyLossCap, dailyLossUsed },
  bars:     [{ t, o, h, l, c, v }],              // 15m, covers entry-2d … now
  indicators: { vwap[], ema9[], ema20[], ema50[], rvol, obv, poc, valueArea:[lo,hi], hvn[], lvn[] },
  levels:   { support, resistance },
  health:   { spreadRatio, marginPct, latencyMs },
  regime:   { quadrant, agreesWithSide },
  events:   [{ t, kind:'news', label, windowMins }],
  journal:  [{ t, kind:'coded'|'trailing'|'manual'|'premature', label, detail, barIndex }],
  armed:    [{ kind, label, triggerPrice, detail }],
  invalidation: [{ key, label, trigger, current, ok }],
  traffic:  [{ symbol, correlation, trendBearing }],
  fleet:    [{ id, symbol, r }],
  advisories: [{ t, level:'ADVISORY'|'CAUTION'|'WARNING', message }]
}
```

Live updates over WebSocket (`price`, `pnl`, `r`, `health`, new `journal`/`advisories` entries) at ≥1 Hz; animate numeric changes with a short roll, never a jump. Snapshot the cockpit's derived values so a re-render never resets an in-flight animation.

## 9 · Acceptance checks

- Popup opens from any open-trade row; `?trade=<id>` restores it; Esc/backdrop/✕ close and return focus.
- Nothing scrolls except the Journal and Advisories lists at the target popup size.
- `scrollWidth <= clientWidth` on the PFD instrument grid and every bullet-bar row.
- Zero pairwise text overlaps in the MFD (assert programmatically over all text nodes in the chart container).
- All chart annotations measure 11px on screen in both desktop and portrait.
- Dark and light theme both pass contrast on heading chips, gridlines (major vs minor distinguishable), and bullet bars.
- No green anywhere; no red/blue-only distinctions in the EMA set.
- `prefers-reduced-motion` respected (positions still apply, instantly).
