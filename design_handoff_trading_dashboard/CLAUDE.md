# CLAUDE.md — Pixel-Perfect Implementation Rules

This repo implements four dashboard pages from the design package in `design_handoff_trading_dashboard/`. The `.dc.html` files there are the **single source of truth** for both UI and logic. These rules are binding for every session.

## UI — pixel-perfect, no exceptions
1. **Never invent a style value.** Before styling any element, open the matching section in the `.dc.html` file and copy the exact inline values: px sizes, font-size/weight, colors, rgba alphas, border-radius, gap, padding, grid-template-columns, box-shadow, backdrop-filter.
2. **Grid templates verbatim.** Table layouts use exact grid definitions (e.g. `100px 80px 88px 30px 38px 138px 60px minmax(185px,1fr) 68px`). Copy them character-for-character.
3. **Design tokens.** Use the CSS custom properties from the design files (`--bg --gl --gbd --edg --acc --acs --up --dn --dns --tx --sb --mu --vio --wrn`), dark + light values as defined there. Theme = `data-theme` attr on `<html>`.
4. **Hard rules:** blue = profit/up, red = loss/down, **never green**; Inter (400–900); `font-variant-numeric: tabular-nums` on all numerics; glass panels = translucent bg + `backdrop-filter: blur(22px) saturate(160%)`.
5. **Verify visually** against `design_handoff_trading_dashboard/screenshots/` after each section, before moving on. If any spacing/size/color differs, re-read the design file and correct — do not "improve" the design.

## Logic — copy the math, don't rewrite it
6. Each `.dc.html` has a `class Component` whose methods define the exact calculations: `agg()` (net, win rate, profit factor, TP/partial/SL counts, avg planned R:R, required win rate `100/(1+rr)`, **edge = actual − required**), carry-forward (`balAt`), loss-cap %, quadrant mapping, session windows (broker week anchor **Sun 22:00 UTC**), heat-cell shading (`alpha = .07 + .78 * (|v|/max)^.6`), duration formatting. Port these functions faithfully; only swap the seeded mock generator `D()` for the live `/state` API.
7. Preserve interaction semantics exactly: single-select filter chips, per-row expand state, ~2400ms live tick, GSAP stepper (segments scaleX stagger, nodes back.out(2.5), terminal pulse: blue clean / amber justified / red square + 45° twist premature; replay on filter change; bounded retry until GSAP + targets exist).
8. Data shapes must match the README's Data Model section so mock → live is a drop-in swap.

## Process
9. Work **one page, one section at a time**. Cite which design-file lines you ported in each commit/summary.
10. If something is ambiguous or missing from the design files, **stop and ask** — never fill gaps with your own design.
