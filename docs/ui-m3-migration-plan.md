# bot-trade — Compact M3 Migration Plan (v1, 2026-08-01)

Companion to `docs/ui-m3-compact-contract.md` (the rules) and
`docs/ui-control-inventory.md` (the findings). This file tracks sequencing,
per-phase rollback points and verification results. One phase or route per
commit; no amend/squash during implementation; legacy styles are deleted
only after their last caller migrates.

## Baseline (Phase A)

- HEAD reviewed: `16defbd721b4dd0cdfa67702d908a61ada5a003b`
  (main after PR #543), package version 0.1.381.
- Gates at baseline, all passing:
  - `node --test agent/**/*.test.js` — pass (30 files)
  - `npx eslint .` — clean
  - `npx vitest run` — 379/379 across 30 files
  - `npm run build` — OK (index bundle 397.58 kB)
  - `npm run check:no-green` — OK
  - `npm run audit:ui` (static) — 0 horizontal overflow on all routes at
    1024/820/390; touch<44 flags only app chrome (static shell renders no
    live data: bodyLen 162 — the audit's numbers under-count page controls;
    treat as smoke, not coverage).
- `npm run audit:ui:live` requires a running agent backend; not available in
  this environment at baseline. Live measurements to be captured against
  `vite preview` where possible per phase.

## Phase status

| Phase | Scope | Commit (rollback point) | Gates |
|---|---|---|---|
| A | Baseline + inventory + conflict register | — (docs only, committed with B) | baseline recorded above |
| B | Contract + this plan + inventory docs | pending | n/a (docs) |
| C | Shared primitives: Button (outlined/text aliases, focus-visible outline), Switch, IconButton, Tabs, Badge non-interactivity, Input/Field density variants, token aliasing (`--control-radius` → `--radius-control`) | pending | component tests + full gate |
| D | `/performance` reference route | pending | full gate + measurements |
| E1 | `/desk` | pending | |
| E2 | `/trade` | pending | |
| E3 | `/accounts` + `/accounts/audit` | pending | |
| E4 | `/tune` | pending | |
| E5 | `/risk` | pending | |
| E6 | `/connect` | pending | |
| F | Cockpit (scoped: control roles + interaction states only) | pending | cockpit contract untouched |

## Compatibility rules in force

- `Button` keeps `primary/accent/danger/ghost/subtle` props working;
  `outlined`/`text` are additive aliases first, callers migrate after.
- `.compact-control` / `.button-normal` / `.button-danger` remain until the
  sidebar session footer migrates; radius alias lands first.
- `Field`'s `!important` overrides retire only when the density variants
  render pixel-identically (verified by component test + screenshot).
- No handler, route, payload or confirmation flow changes in any phase.

## Owner-approval queue

Items that would remove/relocate/merge/hide/rename a control or change an
established layout are parked here and NOT implemented until approved.
(Populated from the inventory.)

## Verification log

Per-phase results appended here as phases complete.
