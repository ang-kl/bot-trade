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
| A | Baseline + inventory + conflict register | `ed1cfde` | baseline recorded above |
| B | Contract + this plan + inventory docs | `e84aef4` (drafts), `ed1cfde` (final) | n/a (docs) |
| C | Shared primitives: Button aliases + focus-visible + loading, Switch, IconButton, Segmented, Disclosure, Input/Field density variants, `--control-radius` alias, global :where() focus-visible | `64d37d3` | vitest 395/395 (16 new), eslint, build, no-green, agent 1827/1827, audit:ui exit 0 |
| D | `/performance` reference route (behaviour-preserving aria/tone/keyboard fixes) | `017859b` | same gate, all green |
| E-s1 | Cross-route emphasis + tone corrections (Trade/Tune/Connect/Accounts/OrderLedger) | `bf3306a` | same gate, all green |
| E2 | /desk pass: manager-sheet tablists + IconButton closers + Double/Reverse→danger + radius tokens; OFF≠UNKNOWN status colours; LossReview aria + keyboard rows; StdTradeTable/OrderLedger disclosure aria | `d9e6cd9` | vitest 395/395, eslint, build, no-green, agent 1827/1827 |
| E3 | /trade pass: LONG/SHORT + OK tones → on/off, status dots, order-pad side selector → state tints, bot-manage checkbox → Switch with pending, Clean-up → danger | `882559e` | same gate, all green |
| E4 | /tune pass: Toggle → shared Switch adapter (14 sites, flows untouched), Autopilot radiogroup, MxCell aria-pressed=selection, GO/NO-GO → on/off, on-accent tokens | `72f2bc3` | same gate, all green |
| E5 | /risk pass: Pill commit-model titles (3 POST-now pills marked), five pairs → radiogroups, Pill ON → state tint, Reset staircase → danger, Emergency → warning | `4f55b97` | same gate, all green |
| E6 | /connect + /accounts (+audit) pass: nested-interactive fix (3 sibling buttons), BUY/SELL → on/off, collapse aria, StrategyInsights radiogroup + emphasis un-inverted, SymbolClusters aria-pressed | `a64f5fc` | same gate, all green |
| F | Cockpit (scoped): focus trap + dialog name, PFD/MFD/LOG tab roles, journal-row aria-expanded + Space, theme aria-pressed, MORE/LESS aria-expanded; W-1 report below; geometry parked | see log | cockpit contract untouched |

## Compatibility rules in force

- `Button` keeps `primary/accent/danger/ghost/subtle` props working;
  `outlined`/`text` are additive aliases first, callers migrate after.
- `.compact-control` / `.button-normal` / `.button-danger` remain until the
  sidebar session footer migrates; radius alias lands first.
- `Field`'s `!important` overrides retire only when the density variants
  render pixel-identically (verified by component test + screenshot).
- No handler, route, payload or confirmation flow changes in any phase.

## Owner-approval queue

Items that would remove/relocate/merge/hide/rename a control, change an
established layout, or add/remove a confirmation flow are parked here and
NOT implemented until the owner approves. Everything else in the inventory
(visual variant/role/token/aria fixes that leave behaviour identical) is
in scope for the phases without further asks.

1. **Consolidate the duplicate S/A/T editors** (sidebar MiniSwitch, Tune
   Toggle, Tune PhaseSwitch — 4 components, 3 sizes for the same money
   keys). Merging any of them removes/relocates controls.
2. **Add confirmations where blast radius demands them**: master `S`/`A`
   (stops all trading, currently bare tap), per-account disarms, `Modify
   protection` (moves a live SL, unconfirmed), `Import settings` (rewrites
   the whole risk config), Connect `Clear` (wipes the agent credential),
   `bot manage` checkbox (hands positions to/from the keeper). These are
   behaviour changes — safety-positive, but flows change.
3. **De-duplicate dual editors**: `Reset` vs `Reset to defaults` (same
   route, one page), Weekend bank / Loss Guardian / guardian-move-% each
   editable on both Risk and Tune.
4. **Collapse-control duplication on Desk** (Card ▾ + Section heading ▾,
   different persistence) — removing either changes an established pattern.
5. **The account filter exists 5× on Performance** with two diverging
   state atoms (regime matrix ignores page scope) — merging is a
   relocation; the state divergence may even be intentional.
6. **Dead `Modify` buttons** (PositionManager/OrderManager) — removing a
   visible control needs a nod, even a permanently disabled one.
7. **Order FAB prominence** (48px accent circle opening the order pad) —
   demoting the largest control in the app is a layout/hierarchy change.
8. **Cockpit spec-vs-code contradictions (C-12…C-51)** — most divergences
   carry in-code owner instructions that were never folded back into the
   specs; reconciling means editing binding documents. Phase F touches
   only control roles/states; every geometry item stays parked here.
9. **`Halt (kill switch)` display inversion** (Risk.jsx:709) — fixing the
   Pill so "halted" reads as the red/armed state is a display-only bug fix
   per the Pill's own documented intent, but it inverts the colour of a
   safety control the owner sees daily; flagged before changing.

## Conflict decisions taken (within delegated authority)

- Canonical radius 1px / padding 2px (contract §2) — owner's 2026-07-28
  instruction post-dates the footer brief's 7px family.
- Coarse-pointer target 44px with per-control commented exceptions
  (contract §4) — consolidation brief §8 supersedes the 36px note of
  2026-07-31; recorded, not silent.
- ui-spec.md §11/§5/§6 stale "12px body" text loses to §2's 12/11/10/9
  scale (C-1/C-2/C-3) — §2 carries the later owner instruction; ui-spec
  gets a correcting edit in Phase D's commit.
- `up/down` tones are P&L-only; direction/approval/state badges migrate to
  `on/off`/`info` per Badge's own documented vocabulary.
- Selected/armed states use `--color-state-on-*`; the clay accent stays
  navigation-only (ui-spec §3 rule 3).

## Phase F — W-1 dead-control report (cockpit)

Wired-looking controls that do NOTHING today. Removing or wiring them is
an owner decision (queue item 6 covers the same class); this report is the
Phase F deliverable, the controls themselves are untouched:

1. **`Manage` header button** (TradeCockpit.jsx ~:294) — styled as the
   primary header action, disables when the market closes, has no onClick.
2. **`Close` header button** (~:296) — red danger styling, live-looking
   title ("queues for next open"), no onClick and not even disabled. On a
   money screen a dead red Close is the worst of the class: it teaches the
   user that red buttons here do nothing.
3. **Fleet chip** (~:693) — role=button + tabIndex so it is focusable and
   announced as a button, but has no onClick/onKeyDown; the spec says a
   click swaps the cockpit to that position.
4. (Same class, page-side, already in queue item 6: PositionManager /
   OrderManager `Modify` — permanently disabled dominant buttons.)

Still open in the cockpit after Phase F (out of scope here): MFD tweak
markers are mouse-only, ~14 cursor:help tooltip affordances have no
keyboard equivalent, no :focus-visible styling exists in src/cockpit/ (the
global :where() outline from Phase C applies only where cockpit CSS does
not override outline), and every geometry/size divergence stays parked as
C-12…C-51 in the approval queue.

## Deviations recorded (not silently skipped)

- /accounts/audit SymbolClusters + WorkflowAudit chips keep their 999px
  capsules and exact hex styles: the owner's "exact prototype styles"
  port instruction binds those two components; only missing aria was
  added. Reconciling them with the radius token needs an owner call.
- OrderLedger's inline expander keeps its `Close` label (collides with
  market-close `Close` elsewhere) — renames are queue-gated.

## Verification log

Per-phase results appended here as phases complete.

- E2–E6 + F (2026-08-01): every phase ran the full gate — vitest 395/395,
  eslint clean, build OK, check:no-green OK, agent tests 1827/1827 — all
  green on every run. Static audit unchanged (skeleton shell; live
  measurements still require a reachable agent backend).
