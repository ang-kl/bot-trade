# Result — Bot-Trade Cockpit Live-Wiring and Decision-Insight

Prompt: `instr/Bot-Trade_Cockpit_Live-Wiring_Insight_Prompt_v1.md` (v1.0,
30 July 2026)
Executed: 2026-08-06 20:50–21:10 UTC (2026-08-07 04:50–05:10 SGT), market closed.

| | |
|---|---|
| Frozen SHA | `cf2dbf9e01e3ede657a8d3c0b1c6d0d0f1849784` (`main` = `origin/main`) |
| Worktree | clean at the time of audit |
| Mode | **read-only verification**. No source changed by this pass |
| Live trading actions | **none** |

---

## Why this document exists, and what it is not

The prompt has no Result document. The obvious inference — that it was never
run — is **wrong**, and this pass exists partly to correct it. Phases 1 through
7 and Phase 9 are implemented in source with tests; Phase 8's adapter exists.
What never happened was the closing verification, so nobody could say which
gates actually hold.

This is therefore not a discovery checkpoint for work about to begin. It is the
audit of work already done, against the prompt's own Definition of Done — and
it finds **one substantive violation of the prompt's core rule still live**.

---

## Verdict

# `IMPLEMENTED THROUGH PHASE 9 — WITH ONE CORE-RULE VIOLATION OUTSTANDING`

The violation is in Phase 3's territory and is stated in full below as
**CK-01**. Everything else the prompt asked for is either done and tested, or
honestly marked unknown.

---

## Phase-by-phase verification

| Phase | Subject | Source | Status |
|---|---|---|---|
| 1 | Identity + read-only endpoint | `agent/routes/state.js:381-411`, `agent/services/cockpit-snapshot.js` | **done, gate passes** |
| 2 | Position / account / execution snapshot | `cockpit-snapshot.js:94-290` | **done, gate passes** |
| 3 | Real bars and indicators | `agent/services/cockpit-bars.js` | **server done; frontend NOT bound — see CK-01** |
| 4 | Real tweak journal | `cockpit-snapshot.js:289+`, `position_events` | **done, gate passes** |
| 5 | Intention, armed actions, invalidation | `agent/services/cockpit-intention.js` | **done** |
| 6 | Correlation and portfolio context | `agent/services/cockpit-correlation.js` | **done** |
| 7 | Environment, macro news, fundamentals | `agent/services/cockpit-environment.js` | **done** |
| 8 | Frontend adapter and refresh | `src/App.jsx:33`, `src/cockpit/cockpit-data.js:136-141` | **partial — see CK-01** |
| 9 | Optional model explanation | `agent/services/cockpit-explain.js` | **done** |

### Gates verified by reading the tests, not by trusting the phase markers

`agent/services/cockpit-snapshot.test.js` (261 lines) contains the
account-isolation gate the prompt demands, and it is the real test rather than
a shape check:

- *"account A cannot read account B position — same 404 as a nonexistent id"* —
  the 404 equivalence matters; a distinguishable error would leak existence.
- *"identity must be explicit — an implicit scope is refused, not defaulted"*.
- *"another account's snapshot cache is DISCARDED, not borrowed"*.
- *"another account's events never appear, even on a colliding broker id"*.
- *"everything the shell cannot vouch for is UNKNOWN, never a default"*.
- *"phase 4: a seeded event appears exactly once, values and source verbatim"*
  and the both-ids-match variant — the duplicate-journal hazard the prompt
  names, tested directly.

`cockpit-environment.test.js:56` — *"GATE provider-not-configured: fundamentals
is not_ingested, always"*. `cockpit-environment.js:107-111` returns
`status: 'not_ingested'` with the reason inline. NON_NEGOTIABLE 9 holds.

`cockpit-snapshot.test.js:153` — *"spreadNow derives from cached bid/ask;
latency stays UNKNOWN"*. Latency has no authoritative source and is therefore
never shown. That is the Definition of Done applied against the temptation to
fill a bullet bar.

---

## CK-01 — the price history shown for a real position is generated

**Severity: HIGH. This is a live violation of the prompt's core rule.**

**The rule.** *"cockpit-data.js currently synthesises or hardcodes chart
history, candles, EMAs, VWAP … These must never be shown as live facts for a
real position."*

**Observation.** `src/cockpit/cockpit-data.js:230-236` seeds `store.hist2` from
a deterministic PRNG:

```js
if (!store.hist2) {
  let s2 = 991
  const rnd2 = () => { … }
  const N = 44, pts = []
  let p = entry
  for (let i = 0; i < N; i++) { p += (tp - entry) / N * .5 + (rnd2() - .5) * .13 * K; pts.push(p) }
  store.hist2 = pts
}
```

`:258` — `const combined = store.hist2.concat(store.hist.map(h => h.p))` — and
`:264`'s `flownPath` is drawn from `combined`. **There is no branch on `snap`.**
A bound real position gets the same 44 generated points as the unbound
reference cockpit, anchored to its real entry and target, drifting half the
distance to TP with seeded noise.

**The server side is not the problem.** Phase 3 shipped
`agent/services/cockpit-bars.js`, and the route serves bars and indicators
(`state.js:413`, `buildBarsAndIndicators`). Nothing in `src/` consumes them —
`grep bars src/cockpit/TradeCockpit.jsx src/App.jsx` returns only a label
string, `PRICE · 15m`.

**Causal chain.** Phase 8's adapter bound the *sections* the prompt enumerated
(correlation, MARKET SAYS, armed actions, invalidation, advisories, RVOL,
spread, latency, WX) and the journal. The chart path was not in that list, so
it was never re-pointed, and the generator that preceded it stayed.

**How the code already knows.** `cockpit-data.js:289` states it plainly: *"the
route serves bars for the CHART, but no bar is resolved at each event's
timestamp — those columns read '—' rather than borrow the demo candle"*. The
journal was correctly refused the demo candle. The chart itself kept it.

**Counter-evidence considered, and why it does not excuse this.** The path is
clamped so a real instrument cannot draw hundreds of units off-canvas
(`:255`, `mapY` clamp, owner screenshot 2026-08-01), and the *live price dot*
is real — `:169-171` explicitly refuses to wobble a real price on the mock
wave. So the most visible number is honest. The **shape behind it** is not, and
a price path is read as evidence of how the trade has gone.

**Economic effect.** No order is affected — the cockpit executes nothing. The
effect is on decision quality: a generated flown path invites conclusions about
momentum, retracement and structure that the market did not produce.

**Minimum sufficient remedy.** Bind `snap.bars.rows` to `flownPath` and the
PRICE·15m candles; when `snap` exists and `bars.status` is not `ok`, draw
nothing and show the existing advisory row. Keep `store.hist2` for the unbound
reference cockpit only — the prompt permits DEMO in an explicit demo fixture,
and an unbound cockpit is exactly that. No layout change: the elements already
exist and only their data source moves, which
`<UI_BINDING_WITHOUT_LAYOUT_CHANGE>` explicitly contemplates.

**Regression test.** A bound snapshot with three known bars renders a path with
three mapped points and no PRNG output; a bound snapshot with
`bars.status: 'unknown'` renders no path and one advisory. Fails before, passes
after.

**Policy boundary.** None. No threshold, no risk rule, no broker interaction.

**Rollback.** Revert the binding; the generator is still present for the
unbound route.

**Not implemented tonight.** The owner's instruction for this session was
documents and read-only analysis, and this is a frontend behaviour change with
a visual consequence. It is specified above precisely enough to be one focused
PR.

---

## CK-02 — journal OHLC columns are permanently '—' for real positions

**Severity: low. Working as designed; recorded so the design is a decision
rather than an oversight.**

`cockpit-data.js:66, 289` — real journal rows deliberately show '—' for O/H/L/C
because no bar is resolved at each event's timestamp. This is the correct
refusal today. Once CK-01 binds real bars, resolving the nearest bar to each
event timestamp becomes possible and the columns can carry real values with a
stated tolerance. Doing so **before** CK-01 would mean resolving events against
generated candles, which is worse than '—'.

---

## CK-03 — `demoPanels` is a stale concept in the comments

**Severity: cosmetic.**

`cockpit-data.js:130-134` still describes bar history, RVOL, spread, latency,
correlated traffic and the tweak journal as fields "the agent does not serve
yet … flagged `demoPanels`". Every one of those except bar history is now
served and bound. The comment predates Phase 8 and now misdescribes the file it
sits in. Anyone reading it would conclude less is wired than actually is.

---

## Non-negotiables — status

| # | Requirement | Status |
|---|---|---|
| 1 | No fabricated live data | **VIOLATED by CK-01** for chart history only |
| 2 | No silent account fallback; carry accountId, dbPositionId, brokerPositionId, tradeId, symbol | holds — tested |
| 3 | Broker truth wins; conflicts return both provenances | holds |
| 4 | Timestamp everything that can stale | holds |
| 5 | Deterministic before generative | holds — Phase 9 is cache-only on the read path |
| 6 | No model call per tick | holds — cached by evidence revision |
| 7 | No expensive broker handshake on repaint/tick | holds — snapshot cache reused |
| 8 | Reuse `position_events` / `recordPositionEvent` | holds — no duplicate table |
| 9 | No calendar fundamentals; report `NOT_INGESTED` | holds — tested |
| 10 | Manage/Close not wired to broker actions | holds |

---

## Answers the cockpit can now give, per the Definition of Done

| Question | Answerable? |
|---|---|
| What position, which account, how fresh? | yes — `meta` + per-section `asOf`/`status` |
| Thesis, strategy, side, entry plan, initial risk? | yes — `intention` |
| What is the bot doing now and why? | yes — `currentDecision` with evidence IDs |
| Next unattended action, trigger, distance, rule source? | yes — `nextAction` |
| What would invalidate the thesis? | yes — `invalidation[]`, states distinguished |
| Market/correlation/execution/session/news support? | yes, **except** price structure — CK-01 |
| What is unavailable or stale? | yes — this is the surface's strongest property |

---

## Files that would change for CK-01, and files that would not

**Would change:** `src/cockpit/cockpit-data.js` (bind `snap.bars`, gate the
generator behind `!snap`), plus one test file.

**Would deliberately not change:** `TradeCockpit.jsx` (no layout, no element,
no token), `agent/services/cockpit-bars.js` (already correct), the route, and
every other cockpit service. The whole remedy is a data-source swap inside one
`if`.

---

## Boundaries observed

Audit-only. No code, config, broker state or live setting was changed. Live
account `42993489` untouched. Read-tier credential only. No production trading
action. No layout, token, label or geometry was altered or proposed for
alteration.
