# BUILD ORDER — Trade Cockpit (per-symbol pop-up)

**Status: prescriptive.** This document is a work order, not a brief. Every number, colour, string, column width, animation duration and file name is given. Where a value is not stated here, take it **verbatim from the reference file named in that section** — do not derive, round, improve, or substitute one. If something appears to be missing or self-contradictory, **stop and ask**; do not fill the gap with a judgement call.

**Explicitly out of scope for your discretion:** colour choices, fonts, type sizes, spacing, radii, animation easing/duration, component libraries, CSS frameworks, chart libraries, icon sets, layout restructuring, renaming labels, changing copy, adding features, removing features, "modernising" anything.

---

## 0 · Inputs

Reference designs — these are the source of truth for every pixel decision:

| File | Role | Viewport |
|---|---|---|
| `Canvas.dc.html` | desktop cockpit — **canonical** | ≥1100px wide |
| `Canvas iPad Portrait.dc.html` | tablet portrait | 1024pt |
| `Canvas iPhone.dc.html` | phone | 390pt |

Companion specs, all in this folder:

| File | Covers |
|---|---|
| `symbol-click-spec.md` | what a click means; resolution; review mode; loading/stale/error states |
| `trade-cockpit-spec.md` | instruments, MFD algorithms, data contract |
| `canvas-variants-spec.md` | type system; measured geometry; permitted responsive differences |

**Read all four before writing code.** Open each reference file in a browser and interact with it — every behaviour you must reproduce is live in there.

**Conflict rule.** If this document and a companion spec disagree, **this document wins**. If a companion spec and a reference file disagree, **the reference file wins**. Never resolve a conflict silently — note it and ask.

---

## 1 · Build sequence

Work in this order. Do not start a step before the previous step's gate passes.

1. **Shell + tokens.** Modal, backdrop, rulers, header, theme switch. Gate: both themes render, Esc/backdrop/✕ close, `?trade=<id>` round-trips.
2. **Click contract.** `SymbolTarget`, resolution order, position selector, review mode, URL/history. Gate: every acceptance check in `symbol-click-spec.md` §7.
3. **Skeleton states.** Every card frame, heading, axis and gridline renders with no data. Gate: with the feed blocked, no layout shift when data arrives.
4. **PFD.** Five instrument columns, then the HDG strip. Gate: `scrollWidth <= clientWidth` on the instrument grid at that device's minimum width.
5. **MFD.** Axes → paths → terrain → traffic → volume pane → tweak markers. Gate: zero pairwise text overlaps, asserted programmatically.
6. **Journal + Risk**, including position economics and the OHLC disclosure. Gate: no clipped text at any of the three widths.
7. **Bottom strips.** Advisories, Armed Actions, Invalidation Watch, Fleet.
8. **Live wiring.** WebSocket, number rolls, stale detection, retry.
9. **Variants.** iPad portrait, then iPhone — by applying §6 only.
10. **Full acceptance pass** (§8) on all three variants, both themes.

---

## 2 · Tokens — copy exactly

```css
:root{--bg:#060913;--gl:rgba(18,24,46,.62);--gls:rgba(10,14,28,.9);--gbd:rgba(140,165,255,.22);--edg:rgba(90,110,200,.24);--acc:#4f8cff;--acs:rgba(79,140,255,.14);--up:#4f8cff;--dn:#ff4d6d;--dns:rgba(255,77,109,.12);--tx:#e8edfb;--sb:#9aa8cc;--mu:#6b7899;--vio:#a855f7;--wrn:#ffc466;--gsh:0 8px 40px rgba(0,0,0,.5)}
[data-theme="light"]{--bg:#eef1fb;--gl:rgba(255,255,255,.66);--gls:rgba(248,250,255,.92);--gbd:rgba(120,140,200,.35);--edg:rgba(100,120,190,.26);--acc:#2b5cff;--acs:rgba(59,108,255,.12);--up:#2b5cff;--dn:#e11d48;--dns:rgba(225,29,72,.1);--tx:#131a2e;--sb:#47536f;--mu:#5a6785;--vio:#7c3aed;--wrn:#a3510a;--gsh:0 8px 32px rgba(60,80,180,.16)}
```

Rules, non-negotiable:

- **Up = blue (`--up`), down = red (`--dn`). Never green, anywhere, for any reason.**
- Every `var(--*)` you write must be one of the names above. No new tokens, no hard-coded hex outside this block — with exactly three exceptions, the EMA line colours `#14b8a6` (EMA 9), `#a855f7` (EMA 20), `#8b8578` (EMA 50), and the heading-chip tints listed in §4.
- Both themes are mandatory. Every element must be legible in both.

---

## 3 · Type — copy exactly

**Families.** `IBM Plex Sans` (400/500/600/700) for text; `IBM Plex Mono` (400/500/600) for numerics. Load once:

```html
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Numeric binding is automatic and must stay automatic:

```css
[style*='tabular-nums']{font-family:'IBM Plex Mono','IBM Plex Sans',monospace;letter-spacing:-.01em}
```

Mark every numeric element `font-variant-numeric: tabular-nums` and it inherits the mono family. **Do not set the mono family by hand on individual elements.**

**Weight.** Exactly two: **400** body, **600** emphasis. `font-weight:700` appears **once per screen** — the header symbol. No 500, no 800, no 900. Body rows are never bold; colour carries meaning.

**Size.** Desktop is the base. Variants are the base × factor, rounded to 0.5px, floored at 8px:

| Role | Desktop ×0.95 | iPad ×0.92 | iPhone ×0.86 |
|---|---|---|---|
| Header symbol | 19px/700 | 18.5px/700 | 17px/700 |
| P&L · R | 15px/600 | 14.5px/600 | 14px/600 |
| Card heading | 12.5px/600 | 12px/600 | 11px/600 |
| Chip / pill / button | 11.5px/600 | 11px/600 | 10.5px/600 |
| Instrument annotation | 10.5px | 10px | 9.5px |
| Chart caption (TERRAIN/ENTRY/TP/WPT/WX) | 7.5px/600 | 7.5px/600 | 7.5px/600 |
| Tape caption | 8.5px | 8px | 8px |
| Micro (POC, axis) | 8px | 8px | 8px |
| Ruler label | 8px | 8px | 8px |

Applying a factor is a **mechanical pass over `font-size:` values**. Never hand-tune an individual size — that is how variants drift, and drift is a defect.

---

## 4 · Shell, header, rulers

**Modal.** 65% × 80% of viewport at 2K; min 1100×720; max 1600×980; centred. Backdrop `rgba(4,7,16,.62)` + `backdrop-filter: blur(3px)`. Card `background:var(--gls); border:1px solid var(--gbd); border-radius:18px; box-shadow:var(--gsh); backdrop-filter:blur(22px)`.

**The page never scrolls.** Only these scroll internally: the Tweak Journal list and the Advisories list. Everything else fits at the target size. A page scrollbar is a defect.

**Rulers** (both, on every variant): horizontal `fixed; top:0; left:14px; right:0; height:13px`; vertical `fixed; top:13px; left:0; bottom:0; width:14px`. Major ticks every 100px in `var(--sb)` with 8px numeric labels, minor every 10px in `var(--mu)`. A 1px `var(--acc)` marker inside each ruler follows the pointer with an 8px/600 readout chip. **No full-page crosshair lines.**

**Header, one line, never wraps** (desktop and iPad): symbol · `LONG · <lots> lots` pill · strategy chip **with version** · `● OPEN <duration>` pulsing pill · `<P&L> · <R>` · UTC clock · **Manage** · **Close** (red) · theme toggle. The three buttons are a `flex:none; white-space:nowrap` group. On iPhone only, the header wraps to two lines and the button row goes full width (§6).

**Heading chips.** Every section heading sits in a chip: its own hue at low alpha + a 1px border in that hue, `border-radius:5px; padding:0 7px`. Tints: amber `rgba(255,196,102,.16)`, blue `rgba(79,140,255,.18)`, violet `rgba(168,85,247,.18)`, grey `rgba(154,168,204,.16)`. **PFD and MFD titles are the only headings with no chip.**

**Every explanatory sentence is a `ⓘ` hover tooltip, never inline body text.** Do not promote a tooltip to visible copy, and do not invent new tooltip text — copy the strings from the reference.

---

## 5 · Layout — desktop (`Canvas.dc.html`)

Page grid `grid-template-columns: 1fr 1.25fr; gap:6px; align-items:stretch`.

- **Left column:** PFD card only.
- **Right column:** MFD card.
- **Below the grid, full width across both columns:** the Journal + Risk card, then Advisories + Armed Actions, then Invalidation Watch, then Fleet.

The Journal + Risk card is a **full-width sibling of the page grid**, not a child of the left column. Inside it: `grid-template-columns: 3fr 1fr` — Tweak Journal ¾, Risk Budget ¼.

### 5.1 PFD card

Instrument grid: `grid-template-columns: 54px minmax(96px,1fr) 32px 94px 36px; gap:5px; height:340px; overflow:hidden`. Sub-panes: `border-radius:10px; border:1px solid var(--edg); background:var(--acs); overflow:hidden` (the candle pane uses radius 12px).

1. **SPD tape** — momentum, pips/min. Ticks + boxed live value with a `1.5px solid` sign-coloured border, radius 6px.
2. **PRICE · 15m** — `viewBox="0 0 200 150" preserveAspectRatio="none"`. Last 30 candles (blue closed-up, red closed-down), session VWAP amber dashed, TP rail `stroke-width .7`, entry dashed `3 2` amber, SL solid red. Footer strip: TP / ENT / SL / VWAP absolute levels. Each candle hoverable with O/C in the tooltip.
3. **VOL** — volume-by-price, 16 contiguous rows filling the column wall-to-wall (no gaps, no pills), `linear-gradient(90deg,<colour>,transparent)`, `min-width:2px`. Amber glowing row = POC with a 7px `POC` label at `right:1px`; violet wash = Value Area (70%); grey = LVN. Width animates on first paint **only**.
4. **PRICE · R tape** — price ticks each with their R value alongside; TP/ENT/SL rails labelled `TP +1.55R` style with the price in the tooltip; blue/red 9×2px edge ticks for MFE/MAE; footer shows **two** fields only — MFE and MAE — with giveback in the pane tooltip. Off-scale rails pin to edge slots with ▲/▼ and displace colliding ticks (the de-collision band includes the footer row).
5. **VSI** — P&L rate in R/hour; value and `R/hr` unit on separate lines; bar rotates from centre.

Below the grid: **HDG strip**, `height:44px`, radius 10px, caption at `left:6px; top:3px`, tape `top:16px; height:26px`. BEAR…CHOP…BULL slides under a fixed pointer.

### 5.2 Journal + Risk card

**TWEAK JOURNAL** — collapsed row grid `9px 34px 12px 1fr`, `gap:0 5px`, `min-height:24px`, `padding:1px 2px`, `border-bottom:1px solid var(--edg)`:

`▸` disclosure · `HH:MM` · lettered key (a–f) in an outlined box · what changed (ellipsised).

Clicking the row toggles it. Expanded, it adds a body spanning columns 2–5 containing, in this order:

1. full date + time, 9px `var(--mu)`
2. the reason, 10.5px `var(--tx)`
3. caption `BAR AT TWEAK · 15m`, 9px/600 `var(--mu)`
4. **O / H / L / C** of the 15m bar the tweak landed on — `grid-template-columns: repeat(4,max-content); justify-content:start; gap:1px 8px`. Close is tinted `--up`/`--dn` by direction. **The four values sit together at the left; they must never be spread across the card width.**
5. `<x.xx>R range · <±x.xx>R at tweak`, 9px `var(--mu)`

Row colour by class: coded/trailing = blue or violet, manual = amber, premature = red. List `max-height:150px`, then scrolls. Hovering a row highlights its chart marker and vice versa (§5.3).

**RISK BUDGET** — gradient bar `height:10px; radius:5px`, fill `linear-gradient(90deg,var(--dn),var(--wrn),var(--acc))`, then three grouped blocks, all `grid-template-columns:1fr auto; gap:0 6px`, tabular:

*Position economics* — Lot size (`<lots> · <shares> sh`) · Notional (quote currency · account currency) · Margin used (`<amount> · <x.x>× lev`) · `Margin/equity` (`nowrap`, red above 35%).

*Outcome strip* — three columns, `border-top:1px solid var(--edg)`:

| IF SL HIT | NOW | IF TP HIT |
|---|---|---|
| loss in account currency | live P&L | profit in account currency |
| `−1.00R` | live R | `+<rr>R` |
| % of balance | `of balance` | % of balance |

Then one 9px note: `risk <X> to make <Y> — <rr>:1 · SL <price> / TP <price>`.

*Account figures* — Balance · Equity (incl. open P&L) · Daily loss-cap · Used today · Remaining + %.

All money in the account currency, converted at the position's FX rate. **P&L must be FX-converted — never show a quote-currency figure with an account-currency symbol.**

### 5.3 MFD card

Header: `MFD — NAV` + ⓘ + right-aligned legend `━9 ┅20 ┈50 ╌VWAP` (full names in its tooltip). Then three **LEG chips** (flown / active / planned), `repeat(3,1fr)`, radius 6px, `padding:2px 7px`, two lines each, ellipsised.

**Chart.** SVG `viewBox="0 0 460 208"` in a `position:relative` div with `padding-top:34px; padding-bottom:4px`. **All dynamic labels are HTML overlay spans** in an absolutely-positioned box covering the SVG (`top:34px; bottom:4px; pointer-events:none`).

Two hard prohibitions:

- **Never** put `{{ }}` inside an SVG `<text>` — it renders zero-size.
- **Never** size text in SVG units when it must measure a fixed px on screen — the viewBox scales.

- **Y axis** = price. Major gridlines with labels in a **26px** right-aligned column, 16 minor subdivisions at half weight. Currency code as a 6px label at `top:-25px`.
- **X axis** = time, **non-linear**, piecewise (hours → px): `[-48,-24]→30..74`, `[-24,-4]→74..150`, `[-4,0]→150..190`, `[0,4]→190..330`, `[4,8]→330..448`.
- **Mixed-resolution minor gridlines:** 1h prior days · 10m today · 15m next 4h · 30m thereafter to TP. Resolution-band strip above the plot at `top:-16px; height:4px`; major stamps (`…NOW 05:42 UTC…`) auto-thin so they never collide.
- **Paths:** flown (accent + glow) = real history since entry; plan = dashed grey to TP; EMA 9 teal solid, EMA 20 violet long-dash, EMA 50 warm-grey dotted; VWAP amber dashed. **Every line differs in hue *and* dash pattern** — nothing may depend on telling red from blue.
- **Terrain** = support/resistance as thin edge lines with faint fills and right-aligned captions.
- **Weather cell** = news event: pulsing ellipse + leader line to its label.
- **TCAS traffic** = correlated symbols as aircraft glyphs with heading vectors and symbol label chips; heading encodes with/against you.
- **Volume pane** = bottom 15% (y 182–210) with its own axis line; one column per bar, blue closed-up, red closed-down, sized to the gap between adjacent bars (tiling, 10% trimmed), hoverable for % of peak.
- **Tweak markers** = diamonds on the flown path with the 5px letter key inside; hovering either the marker or its journal row scales + glows the match, dims the others, and tints the paired row.

**Label de-collision is a required algorithm, not hand-tuned offsets.** Split traffic labels into left and right columns, sort by y, push apart to a minimum vertical gap, push out of registered obstacle bands (TP, WPT, WX, ENTRY captions), hard-clamp to the price pane so none can enter the volume pane. Then assert zero pairwise overlaps.

Below the chart: **MARKET SAYS** — same-heading vs diverging counts + one sentence on the correlated flow. On iPad and iPhone it clamps to 2 lines with a `▾ MORE` / `▴ LESS` toggle.

Below that: **four bullet bars**, `repeat(2,1fr); gap:3px 14px`, each row `64px 1fr 44px` = label · bar · value. Grey band = typical range; a tick marks the threshold **that matters for that metric**: RVOL **minimum** 0.6×, spread max 2.5×, margin max 40%, latency max 90ms. Bar is `--acc` normally, `--wrn` approaching, `--dn` breached. Tooltip states the metric, its typical range and the tolerance state. **No dials, no needles, no gauges.**

### 5.4 Bottom strips

- **ADVISORIES** (left, wider) + **ARMED ACTIONS** (right, 512px), side by side. Advisories: time · level · message, newest first, scrolls. Armed actions: what the bot will do unattended, with live distance-to-trigger and ETA. **TP/SL levels are not repeated here** — the PRICE · R tape owns them.
- **INVALIDATION WATCH** — card-less full-width strip, **5 columns**: ✓/✕ tick · short condition · live value · per-row ⓘ with the exact trigger. Right-aligned verdict line.
- **FLEET** — radius 16px, `padding:6px 12px`. Other open positions, **max 5**, labelled `top 5 of 8`: symbol · calibrated R bar (framed track, tick every 0.5R, amber centre = entry, span ±2R) · R value. Click swaps the cockpit to that symbol.

---

## 6 · Variants — apply these deltas and nothing else

Everything not listed here is **identical across all three files**. A difference you introduce that is not in this table is a defect.

| | Desktop | iPad Portrait | iPhone |
|---|---|---|---|
| Shell width | fluid | 1024px | 390px |
| Shell padding | `16px 12px 6px 24px` | `16px 10px 8px 24px` | `14px 8px 10px 20px` |
| Page grid | `1fr 1.25fr` | `1fr` | `1fr` |
| Panes | both visible | tabs **PFD / MFD** | tabs **PFD / MFD / LOG** |
| PFD columns | `54 · 1fr · 32 · 94 · 36` | `86 · 1fr · 54 · 108 · 54` | `50 · 1fr · 22 · 84 · 36` |
| PFD gap / height | 5px / 340px | 7px / 300px | 4px / 268px |
| Journal + Risk | `3fr 1fr` | `3fr 1fr` | `1fr` stacked |
| Journal rows | disclosure, expanded on demand | same | same |
| Bullet bars | 2×2 | 2×2 | 1×4 |
| Advisories + Armed | side by side | side by side | stacked |
| Invalidation | 5 cols | 3 cols | 2 cols |
| Market Says | full text | 2-line clamp + MORE | 2-line clamp + MORE |
| Fleet | horizontal scroll | wraps | wraps |
| Header | one line | one line | two lines, full-width buttons |
| Type factor | ×0.95 | ×0.92 | ×0.86 |
| Min tap target | — | 44px | 44px |

**Folder tabs** (iPad + iPhone). Tab bar above the card; the active tab merges into it: card `border-radius: 0 18px 18px 18px`; active tab `background: var(--gls)` with `border-bottom: 1px solid var(--gls)`; inactive `transparent` / `var(--gbd)`. iPhone tabs are `flex:1` with `padding:13px 0`.

**Source order on iPad and iPhone is fixed:** header → tab bar → active display card → Journal + Risk → Advisories + Armed Actions → Invalidation Watch → Fleet. The active display is always first; the shared cards always follow beneath it, on **either** tab. On iPhone the shared cards live in the **LOG** tab.

**Touch.** On iPad and iPhone every tab, button, journal row, fleet chip and traffic label has a ≥44px hit box. **Pad the target — never grow the type to reach 44px, and never add empty height to a one-line row.** If a row needs to be 44px, give it a second line of real content.

---

## 7 · Data contract

Cockpit payload and live socket: `trade-cockpit-spec.md` §8. Resolution endpoint, review-mode fields and the multi-position selector: `symbol-click-spec.md` §6.

Additional binding rules:

- Live updates at ≥1 Hz over WebSocket. Numeric changes **roll**; they never jump.
- Snapshot derived values so a re-render never resets an in-flight animation.
- Subscribe on open, tear down on close. On a swap (Fleet / selector / TCAS), close the old socket **before** the new instrument animations begin.
- `prefers-reduced-motion`: positions and values still apply, instantly, with no tweens.
- Stale feed >5s: OPEN pill stops pulsing and gains `STALE <n>s`; live numerics dim to `var(--sb)`; instruments hold last value. No modal, no red.
- Load failure: cockpit stays open, identity intact, one amber advisory `cockpit feed unavailable — retrying (<n>)`. Backoff; recover silently.

---

## 8 · Acceptance — every check must pass on all three variants, both themes

Structural

1. No console errors or warnings on open, swap, or close.
2. Every `var(--*)` referenced resolves; no unresolved `var()` anywhere.
3. Exactly one `font-weight:700` per screen; no 500/800/900; every tabular-nums element renders in IBM Plex Mono.
4. No green anywhere. No distinction that depends only on red-vs-blue.

Layout

5. The page does not scroll. Only the Journal and Advisories lists scroll.
6. `scrollWidth <= clientWidth` on: the PFD instrument grid, every PFD sub-pane, every bullet-bar row, every journal row, and the MFD y-axis label column.
7. No text node is clipped or ellipsised unintentionally — assert `scrollWidth <= clientWidth` on every label that is not deliberately ellipsised.
8. Zero pairwise text overlaps in the MFD chart container, asserted programmatically over all text nodes.
9. Chart annotations measure the size from §3 on screen; the viewBox never scales text.
10. Collapsed journal rows have a pitch ≤26px on desktop and iPad, ≤26px on iPhone; expanded rows show the full OHLC block with the four values grouped at the left.

Behaviour

11. Every entry point in `symbol-click-spec.md` §1 opens the right position; aggregate rows do not.
12. Keyboard-only: Tab to a row, Enter opens, Esc closes, focus returns to that row.
13. A symbol with 3 open positions shows the selector; switching neither closes the modal nor pushes history.
14. Back closes the cockpit exactly once, regardless of how many in-place swaps happened.
15. A closed-only symbol opens **review mode**: no dashed plan leg, no ETA, `ACTIONS TAKEN` and `WHAT ENDED IT` headings present.
16. Unknown symbol: toast, no modal.
17. Feed blocked: cockpit opens, all frames and headings render, **no layout shift** when data arrives, retry advisory appears.
18. Five rapid clicks across different rows leave exactly one cockpit, one subscription, and no orphaned tweens (`gsap.globalTimeline.getChildren().length` stable).
19. Every tap target on iPad and iPhone measures ≥44px.
20. `prefers-reduced-motion` respected.

---

## 9 · Definition of done

- All 20 checks in §8 pass on all three variants in both themes, with evidence (the measured values, not "looks right").
- Every difference between your three implementations appears in the §6 table. Nothing else differs.
- No TODOs, no placeholder copy, no commented-out code, no invented labels.
- Anything you could not implement as specified is listed as an open question — **not** silently resolved.
