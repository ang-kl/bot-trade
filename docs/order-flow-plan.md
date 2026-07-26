# Order Flow + Volume Profile: how they fit together

Owner request (2026-07-26): plan how to use `doc_reference/books/ORDER-FLOW-13.5.2024.pdf`
alongside the Volume Profile work already merged (#407). This is a plan
document — no strategy code beyond one correctness fix (§5) ships with it.

## 0. What the three books actually are

`ORDER-FLOW-13.5.2024.pdf`, `VOLUME-PROFILE-13.5.2024.pdf`, and
`VWAP-book-final-6-7-24.pdf` are one author's (Trader Dale) integrated
system, not three independent methods. The VWAP book says so directly
(p.6): *"I added Order Flow and VWAP to my trading toolbox... because they
both are volume-based indicators."* The architecture across all three is:

1. **Volume Profile / VWAP find the zone** — where big participants have
   been trading (VPOC, value area, anchored VWAP).
2. **Order Flow confirms the reaction** — when price returns to that zone,
   does the tape show someone actually defending it? (Order Flow book
   p.72: *"Confirmation setups... give you a hint when the market is
   starting to react to a Support/Resistance zone you found using one of
   your main trading setups."*)

Order Flow in this system was never meant to stand alone against Volume
Profile — it's the confirmation layer underneath it. That framing matters
for everything below.

## 1. The constraint that decides most of this plan

**cTrader's bar volume is a tick count, not a trade tape.** `agent/lib/ctrader-ws.js:672`:
`v` is *"the broker's tick volume for the bar"* — the number of price
updates, not contracts traded, and with no buy/sell split at all.

The Order Flow book's own core mechanic needs strictly more than that. Its
glossary (p.148): *"Ask: ...how many contracts were traded there with
Market Buy order... Bid: ...Market Sell order..."* Every one of the
following requires that Bid/Ask split, which this system's data does not
carry, and which the book itself says is unavailable even for NinjaTrader's
own Forex feed (Order Flow book p.25): *"The Forex data they provide does
not give Bid and Ask volume, only Total Volume... For this reason, you
cannot use all the Order Flow functions when trading Forex."*

Not buildable from what this system ingests, full stop:

| Concept | Needs | Book ref |
|---|---|---|
| Delta / Cumulative Delta | Ask − Bid per bar | p.19, p.34, p.91 |
| Imbalances / Stacked Imbalances | Ask ≥ 300% of Bid (or reverse), diagonally | p.28-30, p.148 |
| Absorption | heavy volume on **both** Bid and Ask at once | p.79 |
| Aggressive Orders confirmation | Bid/Ask skew per cell | p.84 |
| Unfinished Business (Failed Auction) | *"0 contracts traded at the Bid"* at a high | p.30, p.151 |
| Trades Filter (institutional size) | **per-trade** size, not per-bar volume | p.33 |

Two of the book's own five standalone setups are explicitly exempt from
this — they use total volume only, and the book says outright that they
work on Forex (p.32, p.47): *"This strategy does not use Bid x Ask, only
the Volume setting. Because of this, you can trade it also on Forex."*
Those two — Volume Clusters and Multiple Nodes — are exactly what carries
over. See §3.

### Considered and rejected: faking Bid/Ask from our L2 depth book

This system already captures L2 depth (P87/P88 — `cpp-exec/src/depth_book.cpp`,
`POST /depth`). It would be tempting to build "Delta" from resting bid/ask
depth instead of a trade tape. Rejecting this: depth is **resting orders**,
and the Order Flow book itself explains why that's the wrong signal (p.10):
*"Most pending orders never get filled. These orders are only placed in the
market to move the price... they are, in most cases, withdrawn."* Building
a Delta-shaped number out of the thing the book calls noise would produce
something that *looks* like Order Flow on a chart without being the thing
Order Flow actually measures. Not recommended at any point without a
separate, explicit validation project.

### Open question, explicitly not part of this plan

The live bid/ask **tick** stream (`SpotFeed`, not bar volume) is a
different data source than either of the above — a real two-sided quote at
every instant, refreshed continuously. A tick-rule classification
(a print that trades through the ask is buy-initiated; through the bid,
sell-initiated) is what some desktop FX order-flow tools use as their own
Delta proxy when a real exchange tape doesn't exist. This is **not**
proposed here: it would need its own empirical validation (does the
classification actually correlate with anything predictive on this
broker's feed?) before it could be trusted for even a paper strategy, and
building it without that validation would be exactly the kind of
unverified capability this codebase's audit discipline exists to catch.
Recorded as a candidate for a future, explicitly-scoped research task —
not this one.

## 2. What Order Flow's confirmation ROLE maps onto today

Given §1, this system cannot run Order Flow's actual confirmation setups.
But the architectural slot they occupy — *"wait for a sign that the market
is reacting to the S/R zone before you enter"* — is not empty. It's filled
by price-action confirmation already built into the newest strategies:

- `va_breakout` requires a **completed candle** to close beyond the
  value-area edge before treating it as broken (`agent/services/va-breakout.js`),
  then a pullback that **holds** the level — its own reaction check, done
  with price rather than Bid/Ask split.
- `vp_value` requires the reaction bar to **close back inside** the value
  area past the edge, not merely wick it (`agent/services/vp-value.js`).

Framed against the book: these strategies already have a confirmation
layer, built from the data actually available. The plan is not "add Order
Flow confirmation on top" — it's "recognize this system already occupies
that architectural slot with a different, verifiable input."

## 3. What DOES port cleanly, and where it goes

### 3a. Volume Clusters / Volume Accumulation → a new strategy: `vpoc_retest`

Named identically across both books (Order Flow p.38, Volume Profile
p.63) — a **continuation** setup, not a fade: price built a heavy-volume
node in a rotation, moved away from it by a candle or two, and a pullback
retest of that node is traded **in the direction of the move that
followed it**.

> *"You need to see the price move away from the Volume Cluster... Then
> you need to wait for a pullback. When the price returns... you enter
> your trade... If the heavy volume area was formed in an uptrend, then
> you go Long."* (Order Flow book, p.38-39)

This is a **third, distinct** posture next to the two VP strategies
already shipped:

| Strategy | Posture | Trades |
|---|---|---|
| `vp_value` | mean-reversion | fade the value-area **edge**, target the POC |
| `va_breakout` | continuation (edge failure) | the edge **giving way**, pullback hold |
| `vpoc_retest` (new) | continuation (node defense) | a retest of the **VPOC itself**, trend continuing |

Needs nothing new: `sessionProfile()` (`agent/lib/volume-structure.js`)
already computes the VPOC per session. The gate is price moving away from
it by ~1-2 bar-widths and then returning — same shape as `va_breakout`'s
pullback check, reusable.

Regime kind: `trend` (it explicitly trades *with* the move, the same
failure mode as `donchian_breakout` in a whipsaw).

### 3b. Multiple/Double/Triple Node → a new function, not a strategy

*"A very important place... the High Volume Node (HVN)... An extremely
strong level is formed when two or more High Volume Nodes meet at the same
price in consecutive footprints."* (p.27)

This is a **confluence signal**, not an entry trigger — it should feed
conviction on `va_breakout`, `vp_value`, and `vpoc_retest` the same way
`vpocMigration()` already does, not become a fourth standalone strategy.

Proposed: `multipleNodeLevels(profiles)` in `agent/lib/volume-structure.js`
— given N consecutive `sessionProfile()` results, find the local volume
peaks in each `rows` array (not just the single VPOC — a footprint can
have more than one node) and report which price bands recur across ≥2
sessions within a tolerance. Pure function, same testing pattern as
`vpocMigration`/`lowVolumeNodes`.

### 3c. Volume-Based Take Profit → an exit-layer enhancement

*"Take your profit in a heavy volume area... It is safer to take your
profit a bit sooner — just a little bit before the heavy volume area...
Since you don't need Bid x Ask data, you can use this Take Profit
placement strategy for Forex trading as well."* (p.97)

This is explicitly volume-only and explicitly FX-portable — no caveat
needed. It slots in next to the existing exit machinery (the R-ceiling
exit engine and `profit-keeper.js`'s ATR Chandelier trail,
`agent/services/profit-keeper.js`) as an additional check: before letting
a winner run into the next LVN/HVN ahead of it, tighten or bank partial
profit there rather than waiting for the R-ceiling or ATR trail alone to
catch it. Reuses `lowVolumeNodes()`/`sessionProfile()` unchanged.

### 3d. "Support becomes resistance" — already covered, no new work

VP book (p.24) and VWAP book's confluence chapter (p.59) both list this as
a standalone setup. `marketStructure()`'s `role` field
(`agent/lib/volume-structure.js`) already expresses exactly this: a
bullish open reports the prior VAH's role as `'support'`. No new code —
noted here so it isn't mistaken for a gap.

### 3e. Unfinished Business / Failed Auction — not buildable as specified

The book's exact test (*"a properly formed high needs to have 0 contracts
traded at the Bid"*, p.30) needs the Bid/Ask split this system doesn't
have. A **looser, volume-only analogue** is possible — a session extreme
printed on unusually thin total volume is a weak, unconfirmed high/low,
and price tends to revisit unconfirmed extremes — but this is an
approximation of a different, weaker claim than the book makes, and must
be labeled as such if it's ever built rather than presented as "Unfinished
Business."

## 4. Ranked next steps

1. **Done as part of writing this plan** (§5) — `fib_confluence` and
   `va_breakout` were missing from `regime-gate.js`'s `STRATEGY_KIND`
   registry, so both traded with **zero regime gating** since #407 merged.
   Found while researching this doc, fixed immediately as a correctness
   issue, not a new capability.
2. `multipleNodeLevels()` — pure function, cheap, no new entry gate,
   improves the confidence signal on strategies already shipped.
3. `vpoc_retest` — new default-off strategy, same shape and review posture
   as `va_breakout`/`vp_value`.
4. Volume-based take-profit assist in the exit layer.
5. **Not recommended without a separate validation project**: any
   Delta/Absorption/Imbalance reconstruction from depth or tick data (§1).

None of 2-4 touch risk limits, credentials, or live/demo mode, so under
the standing PR policy they'd ship as ordinary default-off strategy PRs —
flagged here explicitly because they're new *trading logic*, which the
owner may want to see before it's live regardless of the auto-merge
default.

## 5. What shipped alongside this plan

`agent/services/regime-gate.js` — `fib_confluence: 'meanrev'` and
`va_breakout: 'trend'` added to `STRATEGY_KIND`. A new test in
`regime-gate.test.js` asserts every key in `STRATEGY_KEYS` (the strategy
registry) has an entry here, so a future strategy shipping without one
fails a test instead of trading unguarded.
