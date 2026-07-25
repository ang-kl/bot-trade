# SECTIONS.md — Completeness Checklist

Claude Code: audit your implementation against this list. Every box must exist before a page is "done". Order matters — sections appear top-to-bottom as listed.

## Page 1 · Performance Dashboard (desktop)
- [ ] Header: title + LIVE pulse badge + 5 session pills (Sydney/Tokyo/Singapore/London/New York, active = accent) + UTC clock + theme toggle
- [ ] Accounts row (3-col): balance, equity, day P&L, live floating $ + % of balance, TP nett / SL nett today, 30D forecast pace, daily loss-cap bar (blue/amber/red)
- [ ] Today since 22:00 UTC card (closed P&L, meta, PF)
- [ ] Open now — 3-column table w/ headers (Symbol · Side·lots · Live P&L · SL/TP away), hover detail, live ticking
- [ ] Account filter chips (All / USD 902 / AUD 907 / Demo 118 with balance + fc subtitle) — refilters ALL tables below
- [ ] Timeframe ledger: 14 rows (1H 4H 12H Yesterday 3D WTD 1W 2W 30D MTD LastMo 3M 6M 12M) × (carry in → net → carry out, Tr·Win·PF, TP/SL·edge, 6 market cells w/ PF+win subline, date range, why-insight) + expandable detail (top symbols per market, TP/SL plan, per-account split) + three-lens reconciliation note
- [ ] Windows strip driving the Deep dive (click a window card)
- [ ] Deep dive: 6 KPI chips, insight sentence, bar chart ONLY for windows >24h (value labels, date ticks, axis note, hover = leading market)
- [ ] Performance gradient — timeframe × account (heat table, 4 cols incl. Overall)
- [ ] Performance gradient — asset class × account · 30D
- [ ] Forex banded: 6 bands (Majors, EUR/GBP/JPY/comdoll crosses, Asia & exotics), 37 pair chips w/ hover TP/SL
- [ ] Strategy × market matrix · 30D (5 strategies × 6 markets + Net + Edge)
- [ ] Crypto 24/7 panel: 24H/7D/30D chips + BTC/ETH/SOL/XRP table (live price, Δnow, 7D P&L, Tr·Win·PF)
- [ ] Winners explained · 30D (full-width, headers: Date·in→out, Symbol, Side·lots, Outcome·plan·RVOL/VWAP/OBV, P&L)
- [ ] Laggards explained · 30D (same columns, side-by-side with winners)
- [ ] Macro regime matrix: SVG rings (5), Lo/Hi Vol legend, axes labels, 13 dots, 4 corner playbooks (Q1–Q4 w/ USD·gold + long/short) + current-read note
- [ ] Four quadrant cards flanking the chart (330px, ring-palette tint ∝ live net, open trades listed, honors account filter)
- [ ] O-I-A strategy strip: 6 items (hedging, cross-asset triggers, regime shifts, intraday filter, dynamic sizing, divergence execution)
- [ ] Balance in / out table (date, UTC+AEST, type, account, counterparty/fx, amount·ccy, status, net total)
- [ ] Data feed essentials: OHLCV / account state / execution params (live latency) / risk controls (4 cards)

## Page 2 · Performance Mobile (5 phone screens)
- [ ] Every screen: top pill nav (Now/Ledger/Markets/Trades/Accounts, active filled) — jumps between screens
- [ ] Now (430pt): header + LIVE + clock + ☾/☀ toggle, session pills, 3 account cards (TP/SL nett, 30D pace, loss-cap bar), Today card, Open positions w/ SL→TP progress bars, bottom tab bar
- [ ] Ledger (393pt): account filter chips, 14 tappable timeframe rows (carry in→out, net, edge) → expand: 6 market mini-cells + insight
- [ ] Markets: account filter chips, Crypto 24/7 table w/ headers, FX bands w/ pair chips
- [ ] Trades: account filter chips, Winners cards + Laggards cards (full anatomy incl. RVOL/VWAP/OBV line)
- [ ] Accounts: ☾/☀ toggle, gradient timeframe × account, gradient asset × account, regime matrix SVG + 2×2 quadrant cards, Balance in/out card, Data feed card

## Page 3 · Trade Workflow Audit (desktop)
- [ ] 3 O-I-A phase cards (Lab/Bridge/Market) with O/I/A text + pass counts
- [ ] 4 filter chips w/ counts (All / Full pipeline / Early·justified / Early·premature)
- [ ] Audit table, grid `100px 80px 88px 30px 38px 138px 60px minmax(185px,1fr) 68px`, panel overflow-x:auto
- [ ] GSAP stepper per row: 4 nodes, per-segment durations above line (grey/amber/red), total hold in meta, terminal pulse (blue/amber/red-square+45°), replay on filter change, bounded retry guard
- [ ] Premature rows: red tinted row bg; reasoning column with full text
- [ ] 3 verdict cards (integrity %, justified, premature)
- [ ] Back-link to Performance page + theme toggle

## Page 4 · Trade Workflow Audit Mobile (1 phone screen)
- [ ] Header + LIVE + ☾/☀, 3 phase stat chips, 4 filter chips
- [ ] One card per trade: sym/side/P&L header, date + total-hold meta, Lab/Bridge/close status line, GSAP stepper w/ durations, reasoning text, amber/red card borders by early-stop class
- [ ] 3 verdict cards
- [ ] Cross-links to desktop audit + mobile performance

## Cross-cutting (all pages)
- [ ] Blue up / red down, NO GREEN · Inter · tabular-nums · glass blur(22px) saturate(160%)
- [ ] Dark default desktop; mobile = system theme + toggle · `data-theme` on `<html>`
- [ ] Live tick ~2400ms · single-select chips · per-row expand state
- [ ] Every chart has axis labels, value labels, and a legend/explainer line
