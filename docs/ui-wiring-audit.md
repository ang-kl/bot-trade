# UI wiring audit

Owner, 2026-07-31: *"Is the display in all the pages wired to something? … Many
looks fake. Audit the wiring of all buttons, slides, fields and post actions on
buttons, visual cues."*

This is the evidence, not an opinion. Each pass is a mechanical check whose
method is written down so it can be re-run after any change. Findings are only
listed once verified by reading the code they point at.

Status: **passes 1–5 complete**. Pass 6 (M3 control inventory) is outstanding.

---

## Pass 1 — does every UI call reach a route that exists?

Method: extract every `agentGet/agentPost/agentPut/agentDelete` call site in
`src/`, extract every `router.<verb>('<path>')` in `agent/routes/` plus the
top-level `app.<verb>` handlers, and match each call against the route table
with `:param` segments treated as wildcards.

**Result: 176 routes registered, 126 distinct UI calls, ZERO calls with no
matching route.** No button on any page posts into the void.

Three call sites are reported by a naive scan as unmatched — `/state/backtest-
reports/`, `/state/position/`, `/actions/sessions/` — because their paths are
template literals the scanner truncates at `${`. All three resolve to real
parameterised routes (`/state/backtest-reports/:name`,
`/state/position/:id/cockpit`, `/actions/sessions/:sessionId/revoke`).

## Pass 2 — controls with no handler (a control that cannot do anything)

Method: scan every `<button>`, `<input>`, `<select>`, `<textarea>` opening tag
in `src/**/*.jsx` for an `on*` handler, ignoring shared primitives that receive
handlers through `{...rest}`.

**Finding W-1 (real, unfixed): the cockpit's Manage and Close buttons do
nothing.** `src/cockpit/TradeCockpit.jsx` renders both with full affordance —
accent border, pointer cursor, a "queues for next open" tooltip on Close — and
neither has an `onClick`. Clicking either is a no-op.

This is half-intended: the cockpit spec requires that *"Manage and Close have no
broker side effect"* while the read path is being built. But a button that looks
armed and silently does nothing is exactly the "looks fake" complaint. It needs
an owner decision, not a quiet fix:

- (a) wire them to the existing `/actions/position-close` and the position
  manager — real money actions, so real confirmation;
- (b) leave them inert but make that visible (disabled styling + a title saying
  "read-only in this build");
- (c) remove them until they do something.

Everything else the scan flagged is a false positive of the regex (multi-line
attributes, or the shared `Button`/`FormControls` primitives that forward
handlers via spread).

## Pass 3 — does a save tell you it saved?

Method: read every write wrapper and check what the user sees after a
successful POST.

- `Tune.jsx` `run()` — reloads, flashes a message, and writes a persistent
  `✓ Saved at HH:MM:SS` line. Good.
- `PositionManager.jsx` `run()` — sets a message that stays until the next
  action. Good.
- `Risk.jsx` `save()` — **Finding W-2 (real, FIXED in this pass)**: reloaded the
  data but showed nothing except a 0.24-second GSAP scale pulse on the button.
  The pulse is over before you look up, and is indistinguishable from nothing
  happening — which is precisely the owner's "I ALREADY applied, why doesn't it
  …". Risk now carries the same stamped `✓ Saved <section> at HH:MM:SS` line as
  Tune, written only AFTER the page has re-read the values from the agent, so
  the line means "the agent holds this", not "the request left the browser".

## Pass 4 — the cockpit's own demo data

Already tracked by the cockpit live-wiring work and named on screen:

- The tweak journal was six hardcoded rows. **Fixed** — it is now
  `position_events` verbatim, and an empty journal stays empty.
- The MFD chart, EMAs and volume profile are still the reference generator and
  are listed in `demoPanels`, which the cockpit prints in its DEMO DATA
  advisory. They are labelled, not disguised.
- Every other cockpit panel — traffic, armed actions, invalidation, advisories,
  engine bullets, WX, MARKET SAYS — is served by the snapshot contract, and a
  section the server cannot vouch for renders `—`/unknown rather than a demo
  number.

## Pass 5 — per-page data provenance ("is it actually wired?")

Three mechanical checks, run over every page and component.

**5a — every page is fed by real endpoints.** Extracted per file:

| Page | Reads | Writes |
| --- | --- | --- |
| Accounts | `/state/broker-cache`, `/state/market-hours` | `/actions/broker-positions` |
| Accounts ▸ Audit | `/state/trades`, `/state/postmortems`, `/state/symbol-clusters` | — |
| Connect | `/state/symbol-map` | 4 cTrader actions |
| Desk | 16 state endpoints (health, positions, orders, scans, risk-events, correlation, alpha-decay, heartbeats, llm-spend, …) | 5 actions |
| Performance | `/state/perf-ledger`, `/state/trades`, `/state/positions`, `/state/postmortems`, `/state/risk-events`, `/state/risk-full`, `/state/accounts` | — (read-only page) |
| Risk | `/state/risk-full` | 11 actions |
| Trade | 12 state endpoints | 7 actions |
| Tune | 25 state endpoints | 30 actions |

No page renders a card from a constant.

**5b — no hardcoded data tables.** Scanned every module-level `const NAME = [...]`
containing decimal numbers and used with `.map`: **zero hits** outside the
cockpit's clearly-labelled reference generator. There is no mock table feeding a
production page.

**5c — no field-name mismatches.** Every `snake_case` and `camelCase` field the
UI reads was checked against every name the agent emits. One `snake_case` name
is not emitted — `last_checked_at` in `Trade.jsx` — and it is a defensive
fallback beside the real `last_check_at`, not a broken read. The remaining
`camelCase` misses are all locally-computed objects or charting-library APIs.

This is the honest answer to "many looks fake": **the data is wired.** What
created the impression was three specific things, all now identified —
the cockpit's demo panels and its hardcoded journal (journal fixed, the rest
labelled), Risk's invisible save (fixed), and the two dead cockpit buttons
(W-1, awaiting a decision).

**Observation W-3 (not a defect, worth deciding).** Performance mixes two
formula homes: the ledger tiles come from the server (`/state/perf-ledger`),
while the streaks, day nets and hourly tiles are computed in the browser from
`/state/trades`. Both are real data, but the same concept having two
implementations is how they drift apart. Consolidating on the server-side
formulas is a follow-up worth taking deliberately, not a bug to slip in.

---

## Outstanding

**Pass 6 — M3 control inventory.** The owner's "buttons and selections are not
standardised to M3": enumerate every control variant in use (sizes, radii,
states, focus rings, touch targets) and list the divergences from a single
scale, with a proposed canonical set. Findings first; no restyling without
sign-off.
