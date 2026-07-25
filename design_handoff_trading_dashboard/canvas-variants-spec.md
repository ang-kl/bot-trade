# Reference geometry — Canvas desktop / iPad Portrait / iPhone

Companion to `symbol-click-spec.md` (click contract) and `trade-cockpit-spec.md` (instruments). This file is the **measured** truth: every number below was read out of the two reference designs. Where the two disagree, §4 says which one wins.

Reference files (current copies live beside this doc):
- `Canvas.dc.html` — desktop, the canonical cockpit.
- `Canvas iPad Portrait.dc.html` — portrait/tablet variant (1024pt).
- `Canvas iPhone.dc.html` — phone variant (390pt).

## 0 · Type

**Families.** `IBM Plex Sans` for all prose and labels; `IBM Plex Mono` for every numeric readout. The mono binding is automatic — `[style*='tabular-nums']{font-family:'IBM Plex Mono',…}` in the helmet — so any element already marked `font-variant-numeric:tabular-nums` picks it up. Do not set the mono family by hand.

**Weight.** Two weights only: **400** body, **600** emphasis (headings, chips, live values, breach figures). `700` is reserved for the header symbol and appears exactly once per screen. Nothing is 800/900.

**Size — one scale, three devices.** Desktop is the base; the variants are the base × a factor, rounded to 0.5px, floored at 8px (ruler labels stay 8px on every device and are never scaled).

| Role | Desktop ×0.95 | iPad ×0.92 | iPhone ×0.86 |
|---|---|---|---|
| Header symbol | 19px/700 | 18.5px/700 | 17px/700 |
| P&L · R | 15px/600 | 14.5px/600 | 14px/600 |
| Card heading | 12.5px/600 | 12px/600 | 11px/600 |
| Chip / pill / button | 11.5px/600 | 11px/600 | 10.5px/600 |
| Instrument annotation | 10.5px | 10px | 9.5px |
| Tape caption | 8.5px | 8px | 8px |
| Micro (POC, axis) | 8px | 8px | 8px |
| Ruler | 8px | 8px | 8px |

Applying a new factor is a mechanical pass over `font-size:` values — never hand-tune individual numbers, or the variants drift.

All three use the same tokens, the same `@keyframes pulse`, `body::before` radial-gradient field, and `a{color:var(--acc)} a:hover{color:var(--vio)}`.

---

## 1 · Shared chrome (identical in both files)

| Part | Spec |
|---|---|
| Horizontal ruler | `fixed; top:0; left:14px; right:0; height:13px`, `background:var(--gls)`, bottom border `var(--edg)`, repeating 90° gradient ticks, labels 8px `var(--mu)` tabular |
| Vertical ruler | `fixed; top:13px; left:0; bottom:0; width:14px`, right border `var(--edg)`, labels 8px vertical-lr |
| Ruler cursor | 1px `var(--acc)` line + 8px/700 readout chip, `color:var(--bg)` on `var(--acc)`, radius `0 0 3px 0` (x) / `0 3px 3px 0` (y), opacity 0 until pointer move |
| Page shell | `padding:16px 12px 6px 24px; display:flex; flex-direction:column; gap:5px; z-index:1` |
| Header | flex, `gap:10px`, wrap. Symbol 20px/700 `letter-spacing:-.02em` · side pill 12px/600 radius 999px (`var(--acs)` bg, `var(--up)` border) · strategy chip 11px/700 `var(--sb)` on `var(--acs)` radius 6px · OPEN pill 12px/700 with 6px pulsing dot · P&L 16px/700 tabular · clock 11px/600 `margin-left:auto` · button group `flex:none; white-space:nowrap; gap:6px`, each button 12px/700 radius 10px padding `4px 12px` (Manage accent, Close `var(--dn)`/`var(--dns)`, theme `var(--gbd)` border) |
| Card | `var(--gls)` / `1px solid var(--gbd)` / `box-shadow:var(--gsh)` / `backdrop-filter:blur(22px)`; radius 18px for PFD & MFD, 12px journal/risk, 16px fleet; padding `9px 12px` (instrument cards) or `4px 10px 5px` (journal) |
| Instrument sub-pane | `border-radius:10px; border:1px solid var(--edg); background:var(--acs); overflow:hidden` (mini-price pane uses radius 12px) |
| HDG strip | `height:44px`, radius 10px, caption 11px/600 at `left:6px; top:3px`, tape at `top:16px; height:26px` |
| MFD chart | `<svg viewBox="0 0 460 208">` inside `position:relative; padding-top:34px; padding-bottom:4px`; HTML label overlay `absolute; top:34px; bottom:4px; pointer-events:none`; y-labels 9px in a 22px right-aligned column; currency 6px at `top:-25px`; x-labels 8px at `top:-12px`; resolution-band strip at `top:-16px; height:4px` |

## 2 · Desktop — `Canvas.dc.html`

- **Page grid:** `grid-template-columns: 1fr 1.25fr; gap:6px; align-items:stretch`. Left column `flex column; gap:8px`.
- **PFD instrument grid:** `54px minmax(96px,1fr) 32px 94px 36px; gap:5px; height:340px; overflow:hidden`
  1. `54px` SPD tape — 9px caption, 8px tick dashes, boxed live value `1.5px solid` sign-coloured, radius 6px
  2. `minmax(96px,1fr)` PRICE·15m — heading chip violet, `<svg viewBox="0 0 200 150" preserveAspectRatio="none">`, TP rail `stroke-width .7`, entry dashed `3 2` amber, candles hoverable
  3. `32px` VOL profile — 16 contiguous rows, `linear-gradient(90deg,<col>,transparent)`, `min-width:2px`, violet value-area wash, 7px amber POC label at `right:1px`
  4. `94px` PRICE·R tape — 9px/700 header, MFE/MAE edge ticks `right:0; width:9px; height:2px` (`--up`/`--dn`), rails `#alt-tp`/`#alt-en`/`#alt-sl` 11px/700 with `border-top` rule, centre live box `1.5px solid var(--tx)`
  5. `36px` VSI — 11px label, `#pfd-vsi` bar `height:3px; transform-origin:left center`, ±2 scale labels 11px
- **Journal + Risk card:** `grid-template-columns: 3fr 1fr; gap` (journal ¾, risk ¼) — journal list `max-height:118px; overflow-y:auto`, rows `class="tw-row" data-key`, letter key 9px/700 in a 1px box radius 2px, time 11px `var(--sb)`. Risk bar `height:10px; radius 5px`, `#ei-fuel` gradient `--dn → --wrn → --acc`; figures grid `1fr auto; gap:0 6px; 11px; line-height:1.45`.
- **MFD:** leg chips `repeat(3,1fr); gap:5px`, radius 6px, padding `2px 7px`. Market Says body 10.5px. **Health = four bullet bars in a 2×2 grid.**
- **Bottom:** Advisories + Armed Actions side by side, Invalidation Watch 5 columns, Fleet radius 16px padding `6px 12px`, "top 5 of 8", R bar spanning ±2R with a tick every 0.5R and an amber entry centre.

## 3 · Portrait — `Canvas iPad Portrait.dc.html`

Everything in §1 plus:

- **Page grid:** `grid-template-columns: 1fr` — single column.
- **Folder tabs:** a tab bar above the card; active tab merges into it. Cards carry `border-radius: 0 18px 18px 18px`; visibility via `display:{{ pfdShow }}` / `{{ mfdShow }}` (`flex` | `none`), tab state `bg: var(--gls)` and `border-bottom: 1px solid var(--gls)` when active, else `transparent` / `var(--gbd)`.
- **PFD instrument grid:** `86px 1fr 54px 108px 54px; gap:7px; height:300px` — wider tapes, no `overflow:hidden` needed.
- **Journal + Risk card:** `grid-template-columns: 3fr 1fr`, same as desktop; journal list `max-height:150px`. It sits **after** the MFD card in source order, so on either tab the active display is first and the journal/risk, advisories, invalidation and fleet follow beneath it.
- **Invalidation Watch:** `repeat(3,1fr); gap:0 12px` instead of 5 across.
- **Fleet:** same card, `flex-wrap:wrap` instead of horizontal scroll.
- Touch: every fleet chip, tab, journal row and traffic label needs a **44px** minimum hit box in portrait — pad the target, don't grow the type.

## 3b · Phone — `Canvas iPhone.dc.html`

Shell `width:390px; padding:14px 8px 10px 20px; gap:5px`. Everything in §1 plus:

- **Three folder tabs — PFD / MFD / LOG.** LOG carries every card below the two displays (Tweak Journal + Risk, Advisories, Armed Actions, Invalidation Watch, Fleet); each is gated on `{{ logShow }}` / `{{ logGrid }}`. Tabs are `flex:1` with `padding:13px 0` — full-width, 44px tall.
- **PFD instrument grid:** `50px minmax(96px,1fr) 24px 82px 28px; gap:4px; height:268px; overflow:hidden` — the five-column tape idiom survives; fixed columns + gaps = 200px, leaving ~160px for the candle pane.
- **Header** wraps to two lines: identity + P&L + clock, then a full-width button row (`flex-basis:100%` spacer forces the break; Manage/Close are `flex:1`, `padding:11px 14px`).
- **Stacked pairs:** journal + risk → `1fr`; bullet bars → `1fr` (4 rows); advisories + armed actions → `1fr`; invalidation → `repeat(2,1fr)`; fleet wraps.
- **Lists get room** because they own their pane: journal `max-height:210px`, advisories `max-height:150px`.
- **Touch:** journal rows `min-height:44px` with `padding:7px 2px`; tabs, buttons, fleet chips and traffic labels all ≥44px.

## 4 · Intentional differences (the complete list)

All three references are in parity on instruments, tokens and logic. The only permitted differences are the responsive ones:

| | Desktop | iPad | iPhone |
|---|---|---|---|
| Shell width | fluid | 1024px | 390px |
| Page grid | `1fr 1.25fr` | `1fr` | `1fr` |
| Panes | both visible | tabs PFD/MFD | tabs PFD/MFD/LOG |
| PFD columns | `54 · 1fr · 32 · 94 · 36` | `86 · 1fr · 54 · 108 · 54` | `50 · 1fr · 24 · 82 · 28` |
| PFD height | 340px | 300px | 268px |
| Journal + risk | `3fr 1fr` | `3fr 1fr` | `1fr` stacked |
| Bullet bars | 2×2 | 2×2 | 1×4 |
| Invalidation | 5 cols | 3 cols | 2 cols |
| Type factor | ×0.95 | ×0.92 | ×0.86 |
| Touch targets | — | 44px | 44px |

**Anything else that differs is a bug.**

All three files carry the same centre PRICE·15m candle pane, the same merged PRICE·R tape (MFE/MAE edge ticks, R-labelled rails, MFE/giveback/MAE footer), and the same four bullet bars — the attitude ball and the dial gauges are gone from all three.

## 5 · Acceptance checks (geometry)

- Desktop PFD grid: `scrollWidth <= clientWidth` at the minimum popup width (1100px); sum of fixed columns + 4 gaps fits.
- Portrait PFD grid: same check at 1024pt; card height 300px with no internal scroll.
- Phone PFD grid: same check at 390pt; fixed columns + gaps ≤ 200px so the candle pane keeps ≥150px.
- Phone: each of the three tabs shows its pane and nothing else; every card below the displays lives in LOG.
- Phone: no tap target under 44px (tabs, buttons, journal rows, fleet chips, traffic labels).
- Both: only the journal list (`max-height:118px`) and the advisories list scroll; the page does not.
- All: MFD chart annotations measure the device's annotation size from §0 (10.5 / 10 / 9.5px) — the 460×208 viewBox must never scale text, so labels stay in the HTML overlay.
- All: exactly one `font-weight:700` per screen (the header symbol); no 800/900; every tabular-nums element renders in IBM Plex Mono.
- Both: no attitude ball and no dial gauges remain in the DOM.
- Both themes: ruler ticks visible, major vs minor gridlines distinguishable, heading chips pass contrast.
