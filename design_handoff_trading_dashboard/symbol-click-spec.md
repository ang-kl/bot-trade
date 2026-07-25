# Symbol click → Trade Cockpit — interaction spec for Claude Code

**Read order:** this file first (what a click means, what resolves, what renders when data is thin), then `trade-cockpit-spec.md` (the pixel/instrument spec for the cockpit itself). Reference designs: `Canvas.dc.html` (desktop) and `Canvas iPad Portrait.dc.html` (portrait). `COCKPIT.md` is superseded — ignore it.

---

## 1 · What is clickable

Every place a symbol appears in the app is an entry point. One component owns this: `<SymbolTarget symbol positionId? source>` — it renders the child as-is and attaches the click contract, so behaviour can never drift per surface.

| Surface | Element | Resolves to |
|---|---|---|
| Performance Dashboard — Open positions table | whole row | that row's `positionId` |
| Performance Dashboard — Closed trades table | whole row | that closed `positionId` (review mode, §5) |
| Performance Dashboard — symbol chips / leaderboards | chip | symbol → newest open position, else review mode |
| Trade Workflow Audit — step rows | symbol cell only (not the step body) | that step's `positionId` |
| Cockpit — Fleet strip | fleet chip | swaps cockpit in place, no re-open |
| Cockpit — TCAS traffic label | traffic chip | that symbol (may have no position → review mode) |
| Mobile — Now / History cards | whole card | same rules, portrait variant |

**Affordance.** Targets are not styled as links. Hover/focus: `background: var(--acs)`, `cursor: pointer`, and the symbol text shifts to `var(--acc)`. Focus ring `1px solid var(--acc)` + `outline-offset: 2px`. Keyboard: `role="button"`, `tabIndex 0`, Enter/Space open. Touch: 44px minimum row height on mobile surfaces.

**Not clickable:** aggregate rows (totals, averages), the account header, and anything inside an already-open cockpit other than Fleet and TCAS.

## 2 · Resolution — symbol vs. position

The cockpit is always **one position**, never a symbol aggregate. Resolution order on click:

1. `positionId` passed → use it.
2. Symbol only, exactly one open position → use it.
3. Symbol only, **several** open positions → open the cockpit on the newest and render a **position selector** in the header: after the strategy chip, a nowrap chip group `2 of 3 · ⌄` listing every open position for that symbol (opened-at, lots, R). Selecting one swaps the cockpit in place (same as Fleet). No extra modal.
4. Symbol only, no open position → **review mode** (§5) on the most recent closed position.
5. Symbol unknown / no history → do not open. Show a 2s toast `no position history for <SYMBOL>` and leave focus where it was.

State lives in the URL: `?trade=<positionId>`. In-place swaps (Fleet, position selector, TCAS) `replaceState`; the initial open `pushState`, so Back closes the cockpit and one Back exits — never a stack of swaps.

## 3 · Open / close behaviour

- Open is optimistic: the shell, header identity (symbol, side, lots, strategy) and every card frame paint **immediately** from the row's already-loaded summary. Only the instruments wait on the cockpit payload.
- Focus moves to the cockpit card; focus-trapped; Esc / backdrop / ✕ closes and returns focus to the originating element, scroll position untouched.
- Two clicks on the same row must not stack modals; a click on a different row while open **swaps** rather than reopening.
- Live subscription starts on open, is torn down on close, and on swap the old symbol's socket closes before the new one's animations begin (no cross-symbol tick bleeding into the other's tapes).

## 4 · States before the data lands

Every instrument has a defined not-yet state; nothing collapses, no layout shifts when data arrives.

- **Skeleton:** card frames, headings (chips included), axis lines, gridlines and labels all render. Data layers (candles, paths, bars, needles, list rows) are replaced by a `var(--edg)` fill at 1px–2px height on the element's own footprint. No spinners, no shimmer sweeps.
- **First paint:** instruments animate in once (candles grow, bullet bars widen, VSI needle settles). Subsequent ticks animate values only.
- **Partial payload:** an instrument with no data shows its frame plus a 9px `var(--mu)` caption in-place — `no traffic`, `no tweaks yet`, `no advisories`. Never an empty box.
- **Stale feed** (>5s without a tick): header OPEN pill stops pulsing and gains an amber `STALE 7s` suffix; live numerics dim to `var(--sb)`; instruments hold last value. No modal, no red.
- **Load failure:** the cockpit stays open, header identity intact, and a single amber advisory row reads `cockpit feed unavailable — retrying (3)`. Retry with backoff; recover silently.

## 5 · Review mode (closed position)

Same layout, same tokens, past tense — this is how a symbol click resolves when nothing is open.

- Header: `● OPEN` pill → grey `CLOSED <duration>` pill; P&L is the realised figure; the position selector, if any, lists closed trades.
- PFD: SPD/VSI freeze at their final reading and go grey (`var(--mu)`); PRICE·R tape shows entry/exit/TP/SL with the **exit** rail highlighted; MFE/MAE become the final values.
- MFD: the flown path runs entry → exit at full opacity; **no** dashed plan leg, no ETA, no TCAS vectors (traffic renders as static glyphs, correlation labels only).
- Armed Actions → **`ACTIONS TAKEN`** — the same rows, past tense, with the time each fired and whether it hit.
- Invalidation Watch → **`WHAT ENDED IT`** — the condition that actually triggered marked red and first, the rest ✓ grey.
- Risk Budget shows the budget **as it stood at close**, labelled `at close`.
- The Tweak Journal and its chart markers are unchanged — they are the point of review mode.

## 6 · Data contract additions

Beyond `GET /api/positions/:id/cockpit` in `trade-cockpit-spec.md`:

```ts
GET /api/symbols/:symbol/positions?state=open|closed|any&limit=10
→ [{ id, symbol, side, lots, openedAt, closedAt|null, strategy, strategyVersion, r, pnl, state }]
// drives resolution steps 2–4 and the header position selector

// cockpit payload gains, for review mode:
position: { …, state: 'open'|'closed', closedAt, exit, exitReason, realisedPnl, realisedR }
armed:    [{ …, firedAt|null, outcome:'hit'|'missed'|'cancelled'|null }]
invalidation: [{ …, triggeredAt|null }]
```

Resolution must be a **single** round trip in the common case: the row that was clicked already carries `positionId`, so go straight to the cockpit endpoint; only symbol-only entry points hit `/positions`.

## 7 · Acceptance checks

- Every surface in §1 opens the cockpit for the right position; aggregate rows do not.
- Keyboard-only: Tab to a row, Enter opens, Esc closes, focus returns to that same row.
- Symbol with 3 open positions shows the selector; switching does not close the modal and does not push history.
- Back button closes the cockpit exactly once, regardless of how many in-place swaps happened.
- Clicking a symbol with only closed history opens review mode — no dashed plan leg, no ETA, `ACTIONS TAKEN` / `WHAT ENDED IT` headings present.
- Unknown symbol shows the toast and does not open.
- With the feed blocked, the cockpit still opens, all frames and headings render, no layout shift when data arrives, and the retry advisory appears.
- Rapid clicks across five different rows leave exactly one cockpit, one live subscription, and no orphaned GSAP tweens (`gsap.globalTimeline.getChildren().length` stable).
- Review mode passes the same no-green, 11px-annotation, and no-scroll checks as the live cockpit.
