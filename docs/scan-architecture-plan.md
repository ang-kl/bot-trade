# Scan architecture — separate the concerns, move detection to C++

Owner, 2026-07-28: *"Scan should be separated from active trade management,
pending trade and scheduled scan and historical request per timeframe. Have a
scan strategy that will create optimum running in cpp. trimming the symbols
isn't the problem as TradingView can do that with 100s of symbols at once.
Batch size must be dynamically throttling."*

Status: **proposal**. No code changed. Every claim is cited to current source.

---

## 0. Why the owner is right and my "trim the watchlist" advice was wrong

I suggested cutting 217 symbols to ~70 to bring the revisit clock from 72
minutes to ~20. That was solving the wrong problem. TradingView watches
hundreds of symbols because it **subscribes once and maintains state from a
live stream**. We *re-request history on a timer*:

- `runFibScan` takes a fixed batch of **15** symbols per cycle
  (`agent/services/fib-strategy.js:549`, `610`) on a **5-minute** loop
  (`agent/loop.js:33`) → 217 ÷ 15 × 5 min ≈ **72 minutes** before a symbol is
  looked at again.
- Each symbol costs **one historical request per stale timeframe**, and
  `TIMEFRAMES` has **8** entries (`fib-strategy.js:65`).
- cTrader allows **5 historical requests/second**. With `SCAN_CONCURRENCY` at
  6 (`fib-strategy.js:84`) each pipelining per-timeframe requests, we were
  sending **20–40/s** — the self-inflicted throttling fixed today by the token
  bucket in `agent/lib/ctrader-ws.js`.

Trimming the list makes the *symptom* smaller. It leaves the architecture
polling. The fix is to stop re-asking for history we could have maintained.

---

## 1. The four concerns, and why they must not share a budget

Today one 5-minute loop runs scan, pending-order work, position monitoring,
guards, reconcile and quant sequentially, on the same thread, against the same
broker rate budget. So a slow scan delays stop management, and an open Trade
page (which spends ~2 of the 5 historical req/s on `broker-positions`) starves
the scan.

| concern | cadence it wants | latency tolerance | belongs |
| :-- | :-- | :-- | :-- |
| **Active trade management** — stops, trailing, loss cap, ratchet | ticks / seconds | **none** — money at risk | C++ (already: TrailEngine) |
| **Pending-order supervision** — is the armed level still valid | ticks / seconds | low | C++ (already: VpoDispatcher) |
| **Live scan** — is a setup forming | per closed bar | seconds | **C++ (to build)** |
| **Scheduled historical** — cold-start backfill, volume refresh, backtests | minutes / hours | high — it is catch-up | Node, rate-limited |

The principle: **anything that must react to price belongs where the ticks
already are.** Anything that is catch-up work belongs behind the rate limiter,
where being slow is acceptable.

---

## 2. What the sidecar already has (surveyed, with citations)

Genuinely present:

- **A live tick feed with dynamic subscription.** `SpotFeed`
  (`cpp-exec/src/spot_feed.cpp`) is a separate WS from the order connection by
  design (`spot_feed.hpp:3-14`). `ensureSymbols()` (`spot_feed.cpp:116-125`)
  queues new symbol ids under a mutex and the feed thread subscribes them on
  its next slice (`:131-155`, `:243`); queued ids survive a reconnect
  (`:180-184`). Reconnect is capped exponential backoff 1s→60s (`:285-303`).
  **No symbol cap in code** — the whole list goes in one subscribe frame
  (`:186-190`).
- **Native indicators**, documented as bar-for-bar ports of the JS: `atr`,
  `vwapAnchored`, `volumeProfile`, `sma`, `ema`, `rsi`
  (`cpp-exec/src/vpo_indicators.hpp:25-66`).
- **Eight pattern implementations** (`cpp-exec/src/vpo_strategies.cpp`):
  `vwap_trend`, `vp_value`, `ema_pullback`, `donchian_breakout`, `cup_handle`,
  `inv_cup_handle`, `fib_confluence`, `rsi2_reversion`.
- **A proven two-tier threading pattern.** `TrailEngine` explicitly refuses to
  do slow work on the tick thread and defers to a worker
  (`cpp-exec/src/trail_engine.hpp:18-21`). `SpscRing` (`spsc_ring.hpp`) exists
  as the handoff primitive, cache-line separated (`:64-66`).

---

## 3. The five gaps — and the one that changes the design

### 3.1 Spot ticks carry NO volume. This is the constraint, not a detail.

`SpotFeed::runOnce` reads only `bid` and `ask` (`spot_feed.cpp:277-280`).
There is no volume field in a spot event. So a bar built purely from ticks has
`Bar::v` unfillable — and volume is load-bearing for `vp_value`,
`volumeProfile()` itself, the cup-and-handle volume checks, and the donchian
breakout gate.

**This kills the naive "build all bars from ticks" design.** Anyone who ships
it either fabricates volume or silently degrades four strategies.

**Resolution — split the two data needs, because they have different rates:**

| what | source | why |
| :-- | :-- | :-- |
| **Price structure** (o/h/l/c) | built from ticks in C++, continuously | this is what needs to be live, and ticks give it exactly |
| **Volume** | historical request, refreshed on a slow schedule | volume moves on bar boundaries, not tick-to-tick. A 1m-volume refresh per symbol every few minutes is a *tiny* fraction of the 5/s budget |

Every strategy then declares whether it needs volume. Price-only strategies
run at tick speed. Volume-dependent ones run on the freshest volume snapshot
and **say so in their output** — `volumeAsOf`, so a signal can never
silently rest on stale volume. Tick *count* is available as a genuine
liquidity proxy but must never be labelled volume.

### 3.2 No tick→bar aggregation exists

Grepped: nothing in `cpp-exec/src` aggregates ticks into bars.
`VpoConfigStore` is a **passive push-cache** — its header says so outright
(`vpo_config_store.hpp:4-8`, "PUSHED IN by the Node keeper… nothing here
invents either"). Its only writer is the `POST /vpo-config` handler
(`main.cpp:512`).

### 3.3 No signal-publication path at all

C++ has exactly **one** way to express a detection: place the order itself
(`vpo_dispatcher.cpp:118-127`). `GET /vpo-status` returns six counters and a
free-text `lastDetail` (`vpo_dispatcher.cpp:167-180`) — no per-strategy state,
no trigger prices, no symbol list. There is no outbound HTTP client in the
sidecar, so a scanner that *reports* rather than *trades* has nowhere to send
its findings.

### 3.4 The dispatcher does not scale to a universe

- `onTick` is **O(all strategies)** with the symbol filter *inside* the loop
  (`vpo_dispatcher.cpp:182-187`). At 200 symbols × 8 strategies that is 1,600
  iterations per tick, on the socket-reading thread.
- `tryFire` calls `placeOrder` **inline on the tick thread**
  (`vpo_dispatcher.cpp:127`), taking `ExecEngine::mtx_` with a 20s timeout
  (`engine.hpp:106-107`). One fire stalls tick ingestion for **every** symbol.
- The strategy registry is a plain vector, documented as unsafe to mutate
  after `run()` (`vpo_dispatcher.hpp:59-60`), and the universe comes from the
  `VPO_SYMBOLS` env string parsed at boot with a hardcoded if/else factory
  (`main.cpp:223-257`). **No runtime add/remove.**
- Strategies are hardwired to exactly **two** timeframe labels for the whole
  process (`vpo_dispatcher.hpp:104-105`); "8 timeframes" needs a per-strategy
  spec.
- `getBars()` **deep-copies the vector under the lock**
  (`vpo_config_store.cpp:19-25`). At scanner scale (1,600 strategies × 2 calls
  × 512 bars × 48B) that is ~79 MB of memcpy per pass, serialised behind one
  mutex.

### 3.5 The build has no optimisation flag

`cpp-exec/Makefile:6` — `CXXFLAGS := -std=c++20 -Wall -Wextra`, no `-O`. Both
the Makefile and the Docker build produce **`-O0`** binaries. Irrelevant for an
order sidecar; a 3–10× penalty for a scanner running volume profiles and
cup-handle searches. **Free performance, one line.**

### Memory is not a problem

`Bar` is 6 doubles = 48 bytes (`backtest.hpp:20-22`). 200 symbols × 8
timeframes × 512 bars ≈ **39 MB**. Cup-and-handle needs 210 macro bars
(`vpo_strategies.cpp:186`), so 256–512 depth is the realistic band. The
container has room.

---

## 4. Dynamic batch throttling

The owner's third instruction. The batch is currently the constant **15**
(`fib-strategy.js:610`), chosen before any rate limiter existed. Now that
`historicalRateStatus()` reports live pressure (`perSec`, `queued`, `tokens` —
shipped today, visible on `/health`), the batch can size itself:

```
budget   = tokens available for the scan's share of this cycle
requests = Σ over candidate symbols of (stale timeframes for that symbol)
batch    = grow while requests ≤ budget, shrink when queued > 0 persists
```

Rules that keep it honest:

- **Feedback, not a guess.** Grow by one symbol per cycle while the scan
  finishes inside its deadline with `queued == 0`; halve on a deadline trip or
  sustained queueing. Additive-increase / multiplicative-decrease, because
  overshoot is what caused the incident.
- **Floor of 1, ceiling from the cycle deadline** — never zero (coverage would
  stop silently), never more than the deadline can actually complete.
- **Count requests, not symbols.** A symbol with 8 stale timeframes costs 8×
  one with a single stale timeframe. Batching by symbol count is why load was
  unpredictable.
- **Log the chosen size and why** every cycle. A batch that quietly shrinks to
  1 looks like a broken scanner; it must be legible as throttling.

This is worth doing **before** the C++ move — it is contained, it makes today's
scanner adaptive, and it produces the telemetry that proves whether the C++
move is even necessary.

---

## 5. Target architecture

```
cTrader ──ticks──► SpotFeed (C++, 1 conn, dynamic subs)
                       │
                       ├─ BarBuilder    price-only o/h/l/c per (symbol,tf)   [NEW]
                       │                  emits "bar closed" events
                       ├─ TrailEngine   stops        (exists)
                       └─ VpoDispatcher pending levels (exists, needs indexing)
                              │
                       ScanWorkers ◄── bar-closed queue                      [NEW]
                       (pool, off the feed thread; evaluate only the
                        (symbol,tf) whose bar just closed)
                              │
                       SignalBuffer ── GET /signals?cursor=                  [NEW]
                              │
Node  ◄── polls signals ──────┘
  ├─ risk gate, sizing, order placement   (unchanged — money stays in Node)
  ├─ VolumeFeeder: slow historical volume refresh    [NEW, rate-limited]
  └─ Backfill: cold-start bars, chunked               [NEW, rate-limited]
```

Two deliberate choices:

1. **C++ detects; Node decides.** The sidecar publishes *signals*, it does not
   place scanner orders. Every gate, every lesson, every account rule and the
   audit trail live in Node — duplicating them in C++ would fork the risk
   logic, which is the last thing this system needs. (The existing VPO
   dispatcher keeps its direct-fire path for armed pending levels, where
   tick-latency is the whole point.)
2. **Evaluate on bar close, not per tick.** A pattern on a 15m chart cannot
   change between ticks within the same bar. Evaluating per closed bar reduces
   work by orders of magnitude versus per tick, and matches what the strategies
   actually consume.

**A caveat on parity, and it matters:** the C++ ports are documented as
*arm-a-level* detectors, not signal detectors (`vpo_strategies.hpp:16-33`), and
gates needing the breakout bar's own volume were **dropped, not faked**. So
C++ signals will not be byte-identical to today's Node scanner. Milestone S5
below exists to measure that gap rather than discover it in production.

---

## 6. Milestones

| # | milestone | why this order | risk |
| :-- | :-- | :-- | :-- |
| **S0** | `-O2` in the Makefile | one line, 3–10× on everything below | none |
| **S1** | **Dynamic batch throttling in Node** (§4) + per-symbol revisit telemetry | contained, immediate benefit, and the telemetry tells us whether S2+ is worth it | low |
| **S2** | `BarBuilder` in C++: ticks → price-only bars, bar-closed events on an SpscRing. Node keeps pushing volume via `/vpo-config`. | the core new capability, additive — nothing existing changes behaviour | med |
| **S3** | `SignalBuffer` + `GET /signals?cursor=`; symbol→strategy index; move `tryFire`'s order call off the tick thread | makes C++ able to *report*, and fixes the tick-thread stall that scale would expose | med |
| **S4** | Runtime-mutable strategy registry + per-strategy timeframe spec; chunked cold-start backfill from Node | removes the boot-time env universe; lets the watchlist change without a redeploy | med |
| **S5** | **Parity harness**: run Node scanner and C++ scanner side by side on staging, diff signals for a full week, publish the disagreement report | the only honest way to earn the cutover | low |
| **S6** | Cut over: C++ scans, Node consumes signals. Node scanner stays behind a flag for rollback. | | med |

S0 and S1 are worth doing regardless of whether S2–S6 ever happen.

---

## 7. Open decisions

1. **Volume freshness tolerance.** How stale may volume be before a
   volume-dependent signal should be suppressed rather than published with a
   `volumeAsOf` stamp? (My suggestion: suppress past 3 bar-widths of the
   strategy's macro timeframe.)
2. **Scan universe vs subscription universe.** One WS subscribe frame for 200+
   symbols is untested against this broker; a rejection currently fails the
   *whole* subscription and drops the connection (`spot_feed.cpp:191-195`).
   Probe on staging before assuming, and add graceful per-symbol degradation?
3. **Do price-only strategies get to run at higher frequency** than
   volume-dependent ones, or should the whole set stay in lockstep for
   comparability?
4. **Signal transport** — Node polls `GET /signals?cursor=` (simple, matches
   every other sidecar interaction) or C++ gains an outbound HTTP client to
   push (lower latency, new failure mode). I lean poll.
5. **How long does the Node scanner stay** after S6 — one week of parallel
   running, or permanently as a fallback?
