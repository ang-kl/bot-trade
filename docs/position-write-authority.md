# Position write authority — who may touch a live position, and when

**Operating Goal Plan §70.2:** *"Inventory all current trade-management
controllers and authorities."*
**§69.5.2:** *"Inventory every component that can amend, reduce or close a
position."*

This is that inventory. It exists because §36.2.3 states a rule the code does
not currently enforce:

> Two components must not unknowingly write the same stop.

Six components can write a stop. Eight can close a position. §41 defines an
eight-level authority hierarchy to order them; **nothing in the code encodes
it.** They run in whatever sequence their host happens to call them.

Every row below was confirmed by reading the call site. Three earlier drafts of
this table were wrong because they were assembled from `grep` output — a
substring match put two bookkeeping modules (`pnl-backfill`,
`broker-history-import`) in the closer list on the strength of the field name
`closePositionDetail`, and a comment in `loop.js` made `profit-ratchet` look
like it ran on two paths. An inventory whose whole value is trustworthiness
cannot be built from matches.

---

## 1. Stop writers (`amendPosition`)

| Component | Call site | Trigger | §41 level |
|---|---|---|---|
| C++ TrailEngine | `cpp-exec/src/trail_engine.cpp` | tick, separate process | 3 — tick safety engine |
| `profit-keeper.js` | `:374` | fast monitor, 60s band | 4 — fast position manager |
| `trade-guard.js` | `:155` | fast monitor, 60s band | 4 — fast position manager |
| `loss-guardian.js` | `:234` | fast monitor, 60s band | 4 — fast position manager |
| `position-protect.js` | via route / Telegram | operator action only | 7 — human owner instruction |
| `restrategize.js` | main loop | bar-close review | 6 — bar-close strategy |

**The concurrency fact:** three of these share one 60-second tick, and a fourth
writes from a different process on every tick. They are not coordinated. They
are merely, today, unlikely to disagree — `profit-keeper` only tightens toward
profit, `loss-guardian` only acts on positions with no stop, `trade-guard` only
acts on positions carrying explicit rules. The separation is by *convention in
each module's own filter*, not by an arbiter.

That convention is undocumented and unenforced, which is exactly the shape of a
bug that appears the first time two filters overlap.

## 2. Position closers (`closePosition`)

| Component | Trigger | §41 level |
|---|---|---|
| `loss-cap.js` | fast monitor, 60s band | 2 — emergency account control |
| `profit-ratchet.js` | fast monitor, 60s band | 2 — emergency account control |
| `profit-keeper.js` | fast monitor, 60s band | 4 — fast position manager |
| `trade-guard.js` | fast monitor, 60s band | 4 — fast position manager |
| `loss-guardian.js` | fast monitor, 60s band | 4 — fast position manager |
| `weekend-bank.js` | main loop, reconcile phase | 6 — session/portfolio review |
| `loop.js` | main loop, several phases | mixed |
| `routes/actions.js` | operator action | 7 — human owner instruction |

## 3. What §41 says, and what the code does

§41's hierarchy, highest authority first:

1. Broker-native hard protection ← **the only layer with real primacy today**
2. Emergency account and equity controls
3. Tick-level safety engine
4. Fast position manager
5. Per-minute management policy ← **exists as of 2026-08-04, `minute-review.js`**
6. Bar-close strategy management
7. Human owner instruction ← **see the ruling below**
8. Reconciliation correction

Level 1 is genuinely primary: broker-side SL/TP survive the app, the database
and the network, and every open position carries them. Below that, levels 2, 3,
4 and 6 all write, and none of them knows the others exist.

**The gap this inventory establishes:** there is no arbiter, no per-position
record of who last acted (§70.3), and no way for a lower-authority component to
know a higher one has already decided. `position_events` records what happened
*after the fact*; nothing consults it *before* acting.

## 3a. RULING: §41.1 wins over §41.2 (owner, 2026-08-04)

Encoding §41 in `management-state.js` surfaced a contradiction inside the plan.

- **§41.1's numbered list** puts *human owner instruction* at level 7, below
  *fast position manager* at 4. A profit keeper **may** move a stop the owner
  set by hand.
- **§41.2's prose** says owner actions are *"normally respected and audited
  rather than automatically reversed, unless they violate a non-negotiable
  capital-safety rule"*. A fast manager is not a capital-safety rule, so under
  the prose it should **not** reverse the owner.

Both cannot hold. The owner's ruling: **follow the numbered list.** The
automated managers outrank a hand-placed stop, and the code does not block them.

What the owner asked for instead of a block:

> "highlight/telegram if bot want to move the hand-placed stop because of
> stop-loss adjustment"

That is what `minute-review.js` does. A block would have traded one silent
failure for another — a position left sitting on a stop that nothing is
maintaining. A notice keeps the machinery working and puts the human in the
loop. The notice distinguishes the two cases, because the right response
differs:

| Override by | §41 level | Both readings agree? | What it means |
|---|---|---|---|
| `loss_cap`, `profit_ratchet`, `equity_stop` | 2 — capital safety | **yes** | an account-level limit fired |
| `cpp_trail_engine` | 3 — tick safety | no | ratchet in the profitable direction |
| `profit_keeper`, `fast_monitor`, `session_open_guard`, `trade_guard`, `loss_guardian` | 4 — fast manager | no | the contested case |
| `position_manager`, `llm_monitor`, `restrategize` | 6 — bar-close | no | the contested case |

Detection is after-the-fact by design: the review reads `position_events` and
reports, it never pre-empts. **It writes nothing to a position** — adding a
fifth writer to a system whose four writers are kept apart only by convention
would make the problem worse, not better (§36.2.3).

One notice per owner instruction, not one per trailing step. The
`authority_override` row it leaves behind is also what stops a repeat, so the
dedupe survives a restart without any extra state.

## 4. Known-safe by convention, not by construction

These are the filters that currently keep the writers apart. They are listed so
that a future change which widens any one of them is understood to be a
concurrency change, not just a scope change:

- `profit-keeper` — only positions in profit, only tightens toward profit
- `loss-guardian` — only positions with NO stop, or past an optional time cap;
  never tightens a valid mean-reversion stop
- `trade-guard` — only positions with `guard_json` set by the operator
- `loss-cap` / `profit-ratchet` — closes on account-level breach, not on a
  view about the position
- `TrailEngine` — ratchets only in the profitable direction, refuses an
  unstamped payload

## 5. What this inventory does not yet answer

- **Ordering within the 60s tick.** Four writers, one tick, sequence fixed by
  the order they appear in `fast-monitor.js`. That is an implementation detail
  standing in for a policy.
- **Cross-process arbitration.** The C++ TrailEngine and the Node keepers can
  both amend the same position's stop within the same second. Nothing detects
  it; `position_events` would record two writes and no conflict.
- **Wiring the writers to the arbiter.** §70.3 defined the state machine and
  §41's hierarchy in code (`management-state.js`), and §70.4's review now
  *consults* it — but no writer does. Each of the fourteen still acts on its own
  filter and asks nobody. That is the larger and riskier half, and it remains
  undone on purpose.

Those are the next items on §70, and this document is their input.
