# Charting Indicators

Plain-language reference for the chart overlay system: what indicators exist,
how the timeframe ladder works, how the Telegram `/chart` flow runs, and the
design decisions behind it.

## Indicator set

Computed by identical (mirrored) pure functions in `agent/lib/indicators.js`
and `src/lib/indicators.js`. The server computes overlays for Telegram charts
so they match the app exactly.

- **sma20 / sma50 / sma200** — simple moving averages. Trend read: stack order
  (20 over 50 over 200 = up-stack).
- **ema20 / ema50** — exponential moving averages; react faster than SMA.
- **vwap** — volume-weighted average price, cumulative from an anchor index
  (default: start of loaded bars).
- **avwap** — anchored VWAP; anchor picked by TIMESTAMP (first bar at or after
  the anchor time). Use it to measure "average price paid since event X".
- **fvg** — fair value gaps: 3-bar price gaps. Zones carry a direction
  (bull/bear) and are marked filled once later price trades through them.
- **vp** — volume profile (see below).

## Volume profile — the four types

All return price rows with volume, plus POC (highest-volume price), VAH and
VAL (top/bottom of the 70% value area around the POC).

- **session** — profile of the last session window (default 24h of bar time).
  Use for "where did today's business happen".
- **visible** — profile of only the bars on screen; the caller passes the
  visible range. Use while zooming/scrolling.
- **fixed** — an explicit from/to range you choose (same math as visible,
  different intent). Use to profile one event, e.g. a single rally leg.
- **composite** — the whole loaded series. Use for the big-picture map of
  long-term acceptance levels.

## Timeframe ladder

Defined in `src/lib/chart-timeframes.js` (`CHART_TF_GROUPS`):

- **min**: 1m, 2m, 5m, 15m, 30m
- **hour**: 1h, 2h, 4h, 8h, 12h
- **day**: 1d, 3d, 5d
- **week**: 1w, 2w
- **month**: 1mo, 2mo, 3mo, 6mo, 12mo

Synthetic timeframes (2m, 8h, 5d, 2w, 2mo, 6mo, 12mo, ...) are aggregated by
the agent from native feed bars (`agent/lib/timeframes.js`), capped at 1y.
Any ladder step is legal in the app and in `/chart`.

## Telegram /chart flow

`/chart <SYMBOL> [tf=1h] [+ai]`

1. Agent fetches 300 bars for the timeframe.
2. Computes default overlays: sma20/50/200, vwap, fvg, vp (session).
3. `agent/services/annotate.js` builds plain-words annotation lines
   (SMA stack, price vs vwap, unfilled FVGs, POC/VAH/VAL, and one line per
   enabled strategy — "no setup" when none).
4. `agent/lib/chart-render.js` renders a SELF-CONTAINED HTML document —
   inline SVG, no external assets, dark/light aware — saved under the
   reports dir and sent to the owner as a Telegram document, with the
   annotation lines as the caption (1024-char cap).

Cost: the whole flow uses **zero LLM tokens**. Everything is deterministic
math. The only exception is the `+ai` suffix: when `GEMINI_API_KEY` is set,
one Gemini call (owner's key, never Anthropic) adds a short (~120 words)
commentary to the caption. No key, or any failure = no commentary, chart
still delivered.

## Decision: no separate charting service

We did NOT build a standalone chart-rendering service. Split of work:

- **Browser** renders (lightweight-charts in the app; self-contained HTML
  for Telegram documents).
- **Agent** computes (indicators, profiles, annotations) so every surface
  shows identical numbers.

Escalation path if it ever matters: volume-profile math is the only
potentially heavy piece; if it measures slow, move it to cpp-exec. Do not
add a rendering service before that point.

## Colour rules (owner is red-green colour-blind)

- Only **blue** `#2563eb` (`--blue`) and **orange** `#c2410c` (`--orange`).
- Candles: blue = up, orange = down. FVG zones: orange at 15% opacity with
  a dotted border. VP: blue bars with a labelled POC line.
- Colour is never the only signal: every state is also carried by words
  (labels, annotation lines) or shape (dotted borders, markers).
