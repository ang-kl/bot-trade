# bot-trade — Compact M3 Control Contract (v1, 2026-08-01)

**Status: draft under Phase B of the M3 consolidation. This document is the
single normative description of every interactive control's role, tokens,
states, geometry, typography and accessibility. Where it and code disagree
during migration, this document wins for migrated components and the code
wins for not-yet-migrated ones (see docs/ui-m3-migration-plan.md for which
is which).**

This is a **compact M3 adaptation** — Material 3's semantic roles, state
system and accessibility contract, deliberately NOT its stock geometry. The
9px control text, 2px button padding and 1px corner radius are explicit
owner density exceptions and are recorded as such. Do not describe the
result as strict M3.

Authority order (from the consolidation brief §4):

1. Trading safety, data honesty, correct behaviour.
2. Explicit owner requirements (repo + brief).
3. Binding cockpit specs (`design_handoff_trading_dashboard/*`, `src/cockpit/*`).
4. `docs/ui-spec.md`.
5. Existing shared tokens/primitives.
6. Material 3 defaults.

---

## 1 · Control taxonomy

Every interactive element in the app resolves to exactly one role. The
role decides the primitive; the primitive decides the tokens.

| Role | Primitive | Notes |
|---|---|---|
| Command — commit | `<Button variant="accent">` | ≤1 per decision region |
| Command — ordinary | `<Button variant="primary">` (neutral) | the default; never blue |
| Command — medium emphasis | `<Button variant="outlined">` | new in Phase C; alias of today's `ghost` |
| Command — low emphasis | `<Button variant="text">` | new in Phase C; alias of today's `subtle` |
| Command — destructive / risk-increasing | `<Button variant="danger">` | red, flat; keeps confirm flows |
| Command — icon-only | `<IconButton>` (Phase C) | REQUIRED `aria-label`; `title` where hover exists |
| Toggle (persistent binary state) | `<Switch>` (Phase C) | `role="switch"` + `aria-checked`; never a plain Button |
| Tabs / peer-view switch | `<Tabs>` / segmented (Phase C) | `role="tablist"`, `aria-selected`; accent = selection, never P&L colours |
| Filter / choice chip | interactive chip with `aria-pressed` | selected state visible without colour |
| Status badge | `<Badge>` | NON-interactive: no hover, no pointer cursor, never `onClick` |
| Disclosure | canonical `▸/▾` pattern (ui-spec §6) | `role="button"` + `aria-expanded` + Enter/Space |
| Field | `<Input>` via `<Field>` | density variants §5; commit-on-blur preserved |
| Link / navigation | `<a>`/`NavLink` | accent for active nav only |

Hard rules carried over from ui-spec.md §3 and the owner's standing intent:

- **No green anywhere** (`npm run check:no-green`).
- **Blue = positive / long / armed / ON** (`--color-state-on-*`, `--color-up`).
- **Red = negative / short / destructive / breached / OFF** (`--color-state-off-*`, `--color-down`).
- **Grey = neutral / unavailable / unknown — never OFF.**
- **`up`/`down` tones are P&L only; `on`/`off` tones are state only.**
- **Clay accent (`--color-accent`) is navigation + headings, never state.**
- **Colour is never the only cue** — every state also carries a word or glyph.
- Unknown data renders `—`; nothing plausible is fabricated.
- All numerics: `font-variant-numeric: tabular-nums`.

## 2 · Token consolidation

Two control-token families exist today and disagree:

| Token | Value | Used by |
|---|---|---|
| `--radius-control` | `1px` | `Button`, `Input`, pills (`.pill-1px`) |
| `--control-radius` | `7px` | `.compact-control` / `.button-normal` / `.button-danger` (sidebar session footer) |
| `Button` padding | `p-[2px]` literal | shared Button |
| `--control-padding-block/-inline` | `2px / 6px` | `.compact-control` |

Resolution (owner precedent order: the 2026-07-28 "1px curved corner"
instruction post-dates and superseded the footer brief's 7px):

- **Canonical radius: `--radius-control: 1px`** for every rectangular
  control. `--control-radius` becomes an alias of it during Phase C and is
  removed when `.compact-control` callers migrate. Genuine circles (switch
  knob/track, status dots, the round FAB) are shapes, not corner styling,
  and keep their radii.
- **Canonical padding: `2px` block; inline 2px (Button) / 6px (chip-like)**
  via `--control-pad-block: 2px` and `--control-pad-inline: 2px|6px`.
  Button keeps the owner's literal 2px around the label.
- One border width: `1px`.

## 3 · Interaction states (every interactive primitive)

| State | Treatment |
|---|---|
| enabled | per-variant tokens (§1) |
| hover (fine pointer only) | border → `--color-accent` or bg `color-mix` step; never size change |
| focus-visible | `outline: 2px solid var(--color-accent); outline-offset: 1px` — **outline, not ring-only**; must survive light/dark/sepia. Replaces today's `focus:ring-1 …/50` which is a sub-AA 1px 50%-alpha change |
| pressed | `active:scale-[0.98]` (Button) or bg `color-mix` deepen; both, never colour alone |
| selected / ON | `--color-state-on-*` fill + the word (ON, Armed…) or `aria-selected`/`aria-checked` visual pair |
| disabled | `opacity: .5` + `cursor: not-allowed` + `disabled`/`aria-disabled` |
| loading / pending | inline spinner-free: label swaps to a present-participle word ("Saving…") + `aria-busy`; control stays same size |
| error | `--color-error-*` border + text message; `aria-invalid` |

## 4 · Geometry

Fine pointer (desktop):

- Visible: 2px label padding, 1px border, 1px radius, one-line label.
- No decorative min-height.
- Operable target: WCAG 2.2 Target Size (Minimum) 24×24 or the spacing
  exception; the existing `.compact-control::before` ≥32px halo pattern is
  the approved mechanism.

Coarse pointer (iPad / phone):

- Every important control gets a **non-overlapping ≥44×44 CSS px target**
  (brief §8 — this supersedes the 36px halo minimum recorded 2026-07-31 as
  "M3 audit item 3"; the 36px choice is retained ONLY where a 44px halo
  would overlap a neighbour, and that exception must be per-control and
  commented).
- Visible control stays compact inside the target; font does not grow to
  reach it.
- Mechanism: padding/allocated box, not overlapping pseudo-element halos.
  Where halos remain (legacy `@media (max-width:430px)` rule), they must
  not capture taps belonging to neighbours (`z-index: -1` behind own
  control, as today).

## 5 · Typography

Main app: dense role scale, unchanged in Phase A–E (values are the owner's
density exception, not M3):

- Major heading 12px/800 · section 11px/700 · table head 10px/600 ·
  data/control text 9px (9.5px ledger exception).
- Literal `text-[9px]` etc. migrate to the `--fs-d*` tokens as files are
  touched; no blind replacement.
- Fields: `--font-field-max: 10px` cap stands.

Cockpit: scoped IBM Plex Sans / IBM Plex Mono + its own responsive
`typeScale.js` — untouched by the main-app scale, and vice-versa.

Any accessibility-driven size increase is a separate proposal, never a
side-effect of this migration.

## 6 · Fields

`Input` today is 14px/36px glass; `Field` overrides it with `!w-[76px]
!min-h-[26px] !py-0.5 !px-2 !text-[9px]`. Phase C introduces density
variants so the `!important` chain can retire:

- `standard` — current bare-Input rendering (14px text, 36px min-height).
- `compact` — the Field treatment (76px wide, 26px, 9px, right-aligned).
- `touchCompact` — compact + 44px min-height on coarse pointer ≤430px.

Preserved bit-for-bit: fixed 76px width, unit chips, min/max/step, pct
conversion (edit % ↔ store fraction), duration parsing (commit only parsed
values), commit-on-blur vs Save-button split (`onCommit` prop), invalid
styling. Every field keeps a persistent visible label; placeholders are
never the only label.

## 7 · What migrating must never change

- Any handler, POST route, payload, confirmation flow or disarm protection.
- Autotrade master/per-account switch semantics (S.A.T. keys are written by
  their existing writers only).
- Commit-on-blur vs Save semantics per page.
- The cockpit's no-outer-scroll contract, PFD/MFD/LOG variants, fonts,
  instrument geometry and data contract.
- The iOS pinned-element rule: nothing pinned carries `backdrop-filter`.
- The Card ▸/▾ + ⧉ contract and its Text/JSON/HTML copy behaviour.

## 8 · Open items

Filled in as Phase A inventory completes — see
`docs/ui-control-inventory.md` (route-by-route) and
`docs/ui-m3-migration-plan.md` (sequencing, rollback points).
