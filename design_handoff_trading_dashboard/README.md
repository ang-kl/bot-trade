# Handoff: Global Trading Performance Dashboard (bot-trade)

## Overview
Four screens for a cTrader-connected algorithmic trading bot (repo: `github.com/ang-kl/bot-trade`), covering global multi-asset performance insight (crypto, forex, indices, commodities across Asia-Pac / Europe / US / Chicago sessions):

1. **Performance Dashboard** (desktop/notebook) — the master "ledger" page
2. **Performance Mobile** — the same data model across iPhone tab screens
3. **Trade Workflow Audit** (desktop) — O-I-A pipeline compliance & early-stop audit
4. **Trade Workflow Audit Mobile** — the audit as iPhone cards

## About the Design Files
The files in this bundle are **design references created in HTML** (`.dc.html` design-component prototypes). They show intended look, layout, data shapes, and behavior — they are **not production code to copy directly**. The task is to **recreate these designs in the bot-trade codebase's existing environment** (React + the repo's "Ultra Neo Glass" style system) using its established patterns, wired to the agent's real `/state` API instead of the mock data generators embedded in the prototypes.

## Fidelity
**High-fidelity.** Colors, typography, spacing, and interactions are final. Recreate pixel-perfectly with the codebase's existing components. All numbers in the prototypes are deterministic mock data (seeded PRNG in each file's logic class) shaped like the agent's closed-trade records — replace with live API data.

## Non-negotiable style rules (from the bot-trade repo)
- **Blue = profit/up (`#4f8cff` dark / `#2b5cff` light), red = loss/down (`#ff4d6d` / `#e11d48`). NO GREEN anywhere.**
- Font: **Inter** (Google Fonts), weights 400–900, `font-variant-numeric: tabular-nums` on all numbers.
- Glass panels: translucent backgrounds + `backdrop-filter: blur(22px) saturate(160%)`, 1px light borders, large soft shadows.
- Dark theme default on desktop; **mobile follows system theme** (`prefers-color-scheme`) with a manual ☾/☀ toggle.

## Design Tokens
CSS custom properties, dark / light:

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#060913` | `#eef1fb` | page background |
| `--gl` | `rgba(18,24,46,.62)` (mobile .72) | `rgba(255,255,255,.66–.72)` | glass panel bg |
| `--gbd` | `rgba(140,165,255,.22)` | `rgba(255,255,255,.8)` / `rgba(120,140,200,.35)` | panel border |
| `--edg` | `rgba(90,110,200,.24)` | `rgba(100,120,190,.26)` | row dividers, track bars |
| `--acc` / `--up` | `#4f8cff` | `#2b5cff` | accent + profit |
| `--acs` | `rgba(79,140,255,.14)` | `rgba(59,108,255,.12)` | accent tint fills |
| `--dn` | `#ff4d6d` | `#e11d48` | loss |
| `--dns` | `rgba(255,77,109,.12)` | `rgba(225,29,72,.1)` | loss tint fills |
| `--tx` | `#e8edfb` | `#131a2e` | primary text |
| `--sb` | `#9aa8cc` | `#47536f` | secondary text |
| `--mu` | `#6b7899` | `#5a6785` | muted text |
| `--vio` | `#a855f7` | `#7c3aed` | tertiary accent (section labels) |
| `--wrn` | `#ffc466` | `#a3510a` | warnings, justified early stops |

Page background overlay: three radial gradients (blue / purple / pink at ~16–32% alpha) fixed behind content.
Type scale is small/dense: section titles 12px/800, table headers 8.5px/700 uppercase, body cells 9–11px, hero numbers 14–26px/800–900. Radii: pills 999px, cards 12–16px, panels 14–18px.

## Screens

### 1. Performance Dashboard (desktop, ~1660px card, information-dense)
Top-to-bottom:
- **Header**: title + LIVE pulse badge, session pills (Sydney 22–05, Tokyo 00–06, Singapore 01–09, London 08–16, New York 14–21 UTC; active = accent border/tint), UTC clock, theme toggle.
- **Accounts row** (3-col grid): per account (Live·Main USD #7114-902, Live·AUD #7114-907, Demo·burn-in #5003-118) — balance, equity, day P&L, live floating $ and % of balance, TP nett / SL nett today, 30D forecast pace $/day, and a **daily loss-cap bar** ("loss-cap used X% of −$cap"; at 100% the bot closes all & disarms; blue <33%, amber <66%, red above).
- **Today + Open now**: today-since-22:00-UTC closed P&L; open positions in 3 columns with headers Symbol / Side·lots / Live P&L / SL·TP-away, hover reveals entry→now, strategy, RVOL/VWAP/OBV context. Numbers tick every ~2.4s.
- **Account filter chips** (All / per-account with balance + forecast subtitle) — refilters every table below; carry-forward switches to that account's balance.
- **Timeframe ledger** (the core): one row per window — 1H, 4H, 12H, Yesterday, 3D(excl. today), WTD (broker week anchor **Sun 22:00 UTC = AU open**), 1W, 2W, 30D, MTD, Last month, 3M, 6M, 12M. Columns: carry in → net → carry out, trades·win%·PF, TP/SL counts + edge %, six per-market net cells (Crypto/Forex/Indices/Metals/Energy/Grains, each with PF+win% subline), date range on multi-day rows, and an auto-insight ("X led +$n · Y dragged −$m · edge +z% · best day …"). Row click expands: top symbols per market, TP/SL plan (planned R:R, required vs actual win rate), per-account split. A note explains the three-lens model (time rows × market columns × panels below; totals reconcile, nothing double-counted).
- **Performance gradients**: timeframe × account and asset-class × account heat tables (blue=gain/red=loss, intensity per column max, Overall column reconciles).
- **Deep dive** (driven by a windows strip): KPI chips, insight sentence, and — only for windows >24h — a **labeled bar chart** (value on every bar, date ticks, "net P&L per bucket $" axis note, hover names the leading market; weekly buckets on 3M+).
- **FX banded panel**: 37 pairs in bands (Majors, EUR/GBP/JPY/comdoll crosses, Asia & exotics) — band net + meta, every pair a chip with hover TP/SL detail.
- **Strategy × market matrix** (30D): five strategies (fib 61.8% fade, cup & handle, ema pullback, donchian breakout, rsi mean-rev) × six markets + net + edge.
- **Crypto 24/7 panel**: BTC/ETH/SOL/XRP — live price, Δnow, 7D P&L, tr·win·PF; 24H/7D/30D net chips (crypto never session-gated).
- **Winners & Laggards explained** (30D, side-by-side, full width): date, time in→out UTC, side·lots, outcome·planned R:R·risked·held, **RVOL/VWAP/OBV at open→close**, P&L.
- **Macro regime matrix**: growth × inflation SVG — 5 concentric volatility rings (teal center → amber → red outer), Lo/Hi Vol swatch legend, 4 axis labels, 13 asset-group dots colored by 30D net, quadrant corner playbooks (Q1 Overheating / Q2 Stagflation / Q3 Deflation / Q4 Goldilocks with USD/gold behavior + long/short lists). Flanked by **four quadrant cards** (330px each, ring-palette tints whose intensity tracks the live net of open trades in that quadrant) listing this account's open trades; account filter row above. Below: 6 compact O-I-A strategy applications (hedging, cross-asset triggers, regime shifts, intraday direction filter, dynamic sizing, divergence execution).
- **Balance in/out**: deposits/withdrawals/transfers — date, time UTC+AEST, type, account, counterparty (fx rate on cross-ccy), amount·ccy, cleared/pending, net total. Excluded from P&L; carry-forward adjusts on transaction date.
- **Data feed essentials**: OHLCV (1m…1D chips, 53 symbols), account/portfolio state, execution parameters (spreads, fees, live latency), risk controls.

### 2. Performance Mobile (iPhone 430pt + 393pt frames)
Five sections as phone screens, each with a **top pill nav** (Now / Ledger / Markets / Trades / Accounts — active filled) and bottom tab bar. Account filter chips on Ledger/Markets/Trades. Content mirrors desktop: Now (accounts + today + open positions with SL→TP progress bars), Ledger (tappable timeframe rows → 6 market mini-cells + insight), Markets (crypto table + FX bands), Trades (winners/laggards full anatomy), Accounts (both gradients, regime matrix + 2×2 quadrant cards, balance in/out, data feed). Hit targets ≥44px.

### 3. Trade Workflow Audit (desktop)
- Three **O-I-A phase cards** (Lab / Bridge / Market) with pass counts.
- Filter chips: All / Full pipeline / Early stop·justified / Early stop·premature (with counts).
- **Audit table** (grid `100px 80px 88px 30px 38px 138px 60px minmax(185px,1fr) 68px`, panel `overflow-x:auto`): date·in→out, symbol·side, strategy, Lab ✓, Bridge ✓/✕, **animated market-path stepper**, close type (TP/Trail/SL/Manual — manual amber if justified, red if premature), reasoning column, P&L. Premature rows get a red tinted background.
- **Stepper**: 4 nodes (pending → live → managed → closed/early) joined by 2px gradient segments; **per-segment durations** above the line (pending→live wait, live→managed, managed→close; grey normal / amber manual / red premature); total hold in the meta. GSAP: segments scaleX 0→1 staggered, nodes pop with back.out, terminal node pulses (blue glow clean / amber justified / red square pulsing + 45° twist for premature). Replays on filter change; guard: retry until GSAP **and** targets exist (bounded ~40×300ms).
- **Verdict cards**: pipeline integrity %, justified vs premature counts.

### 4. Trade Workflow Audit Mobile
Same data in one iPhone Max frame: phase stat chips, filters, one card per trade (header sym/side/P&L; meta date + total hold; the same GSAP stepper; reasoning below; amber/red card borders by early-stop class), verdict cards at the end.

## Interactions & Behavior
- Live tick: `setInterval` ~2400ms (tweakable) drives open-position prices (sinusoidal walk), latency readout, clock.
- All expand/collapse (ledger rows, region rows) toggle per-row state; filters are single-select chip groups.
- Theme: `data-theme` attribute on `<html>`; desktop default dark, mobile default = system preference.
- Charts: no chart library — bars/sparklines are plain divs/SVG paths. Every chart must have axis labels, value labels, and a legend line (user requirement).
- GSAP 3.12.5 from cdnjs, used only on the audit stepper.

## State Management
Per page: `theme`, selected timeframe window, per-row `open` map, `acct` filter ('all' | 0 | 1 | 2), audit `flt`, `tick` counter. Data derivations are cached per account filter.

## Data Model (replace mocks with `/state` API)
Closed trade: `{ t (epoch ms), sym, cat: crypto|fx|index|metal|energy|grain, strat, side, lots, rr (planned R:R), out: tp|part|sl|manual, pnl, dur (min), acc (account idx), rvO/rvC (RVOL at open/close), vwO/vwC (above/below VWAP), obv (rising/falling/flat) }`. Aggregations: net, win rate, profit factor, TP-full/partial/SL counts, avg planned R:R → required win rate `100/(1+rr)` → **edge = actual − required**. Transfers: `{ date, utc, kind, account, ccy, amount, note, status }`. Audit trade adds: `bridge (bool)`, `p2l/l2m/m2c` durations, close kind, reasoning string.

## Assets
No image assets. Google Fonts Inter; GSAP via CDN; iPhone frame in the mockups is presentation chrome only — not part of the product UI.

## Screenshots
Reference captures in `screenshots/`: `01-performance-dashboard.png`, `02-performance-mobile.png`, `03-workflow-audit.png`, `04-workflow-audit-mobile.png`.

## Files
- `Performance Dashboard.dc.html` — desktop dashboard (template + logic + mock generator)
- `Performance Mobile.dc.html` — mobile screens
- `Trade Workflow Audit.dc.html` — desktop audit
- `Trade Workflow Audit Mobile.dc.html` — mobile audit
- `ios-frame.jsx` — presentation-only iPhone bezel used by the mobile mocks
