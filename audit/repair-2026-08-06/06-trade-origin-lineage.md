# 06 — Trade-origin lineage

Phase 6 of the Verified Defect Repair prompt.

---

### R6-1 — Nothing recorded how a trade came to exist

**Classification:** `CORRECTNESS FIX`
**Severity:** high — it makes every edge metric a mixture of things that are not
comparable
**Status:** reproduced at HEAD
**Scope:** `agent/lib/trade-origin.js` (new), `agent/db.js`, four write paths,
`GET /state/attribution`

#### Observation

Audit Part 2 found postmortems missing thesis, confluence and strategy
attribution. The audit's first explanation — "`entry_quality` is populated by
nothing" — is **withdrawn and stays withdrawn**: `loss-postmortem.js:528` writes
it and a test covers it.

The real defect is narrower and worse. Those positions had been **adopted by
reconciliation from broker truth**, not opened through dispatch. Nothing had
computed a thesis because nothing had made a decision — and no column said so.

Before this change, `SELECT ... FROM trades` offered `source` and
`label_strategy`. Neither answers the question. A reconciler-adopted position
carries `label_strategy = 'fib_confluence'` because reconciliation **parsed that
string off the broker's position comment**. That is provenance of a string, not
of a decision, and win rate / profit factor / expectancy were being computed
over the mixture with nothing on screen to say what the mixture was.

Concretely: the nine 0066.HK duplicates in task #179 were adopted in one
reconcile pass with thesis *"Adopted bot position — label
autopilot/fib_confluence"*. Under the old schema they counted toward
`fib_confluence`'s record.

#### Minimum sufficient remedy

One closed enum, one column, written **where the trade is created** — never
inferred later from what a row happens to contain:

| origin | written by |
|---|---|
| `bot_market_dispatch` | `loop.js` market-order intent row |
| `bot_pending_fill` | `pending-orders.js` on fill |
| `reconciler_adopted` | `reconciler.js` adoption |
| `manual_broker` | the two `actions.js` manual/LLM routes |
| `external_system` | reserved; nothing writes it yet |
| `legacy_unattributed` | derivation only — "this row predates attribution" |
| `unknown` | normalisation fallback; never a default at a write site |

`cleanBotOrigin()` admits **only** the first two. That is the audit's
instruction made mechanical: *"Do not use adopted or manual trades as clean
evidence of strategy expectancy."*

Reconciliation still records the label it found, and now marks the row
`reconciler_adopted` beside it — satisfying *"Reconciliation must not invent a
strategy"* without discarding evidence.

#### The line that decides an old row's fate

`deriveOrigin()` promotes an `autotrade` row to `bot_market_dispatch` **only if
it carries a `risk_event_id`** — the gate verdict. Without one it is
`legacy_unattributed`. Anything else unrecognised is `legacy_unattributed` too,
which is a statement about the record rather than a guess about the trade. The
one thing derivation must never do is launder a row into a clean bot origin on
thin evidence, since that is precisely what the column exists to prevent.

#### Coverage, beside the metrics

`GET /state/attribution` now:

- accepts `groupBy=origin`, so "which of these were actually ours" is one query;
- returns `originCoverage` with every response:

```json
{"n": 3, "clean": 1, "cleanPct": 33.3, "known": 3,
 "byOrigin": {"bot_market_dispatch": 1, "reconciler_adopted": 2},
 "note": "1 of 3 trades (33.3%) come from this system's own dispatch; the rest are adopted, manual or unattributed and are NOT evidence of strategy edge."}
```

That sentence is the one the Go-Live Gate card needed on 2026-08-03, when six
panels showed identical numbers because every row was unattributable.

#### Reversible backfill

`agent/scripts/backfill-trade-origin.mjs` — **dry run by default**, `--apply` to
write, `--rollback --apply` to undo.

Rows it writes carry `origin_source = 'backfill'`; write paths carry `'write'`.
Rollback clears only the former, so undoing a backfill can never erase an origin
recorded at the moment a trade was created. That contract is asserted in
`trade-origin.test.js`, not merely documented.

**The backfill is deliberately NOT run automatically and not run here.** It
rewrites every historical trade row; it is the owner's call when to apply it,
and the dry run prints the full plan first.

#### Regression proof

`agent/lib/trade-origin.test.js` — 14 tests: the enum is closed and
normalisation cannot widen it; only dispatch and pending fills count as edge;
adoption derived from either signal; the `risk_event_id` line; every derivation
lands inside the declared set; coverage arithmetic and its empty-window case;
the columns exist; a stamped row round-trips; rollback spares write-time
origins; and the route reports coverage and groups by origin.

#### Policy boundary

No risk threshold, gate, sizing rule or order path is touched. No historical row
is modified by this PR — the column is added, new trades are stamped, and
changing old rows requires running the script deliberately.

#### Residual risk

- `external_system` has no writer. It exists so that a future integration has a
  name to use rather than falling into `unknown`; today nothing produces it.
- Trades created before this deploys read `origin: null` until the backfill is
  run, and `originCoverage` counts those as `unknown` — visible, not silent.
- The four stamped write paths are the ones that exist today. A fifth added
  later without an `origin` would be invisible; the coverage figure on
  `/state/attribution` is what would surface it.

**No live trading action was taken.**
