# Virtual Pending Order Engine (VWAP + Volume Profile) — C++ sidecar, draft v0.1

Repo: `ang-kl/bot-trade` · Target: `cpp-exec/` (new module) + `agent/lib/exec-engine.js` (delegator wiring)
Status: **draft — awaiting owner sign-off before any code change**
Prepared: 22-07-'26, following review of `cpp-exec/src/engine.{hpp,cpp}`,
`order_guard.{hpp,cpp}`, `main.cpp`, `doc_reference/pending-order-mode.md`,
and the two source prompts (owner-supplied, 2026-07-22, "Strategy: Clear"
and "Strategy: Taleb").

---

## 0. What's being asked for, in plain terms

The owner shared two AI-coding prompts describing a strategy execution style:
instead of sending a broker-side pending (limit/stop) order and letting the
exchange manage it, the bot holds the "pending order" **in its own memory**
as a state machine — watches live price against a dynamically-recalculating
level (VWAP, Volume Profile POC, or similar), and the moment price touches
that level, fires a **plain market order**. No broker-side limit/stop order
ever exists for the entry.

The stated reasons (from the prompts, worth restating because they're the
actual design constraints, not just colour):
1. **VWAP/VP levels move every bar.** A resting limit order at today's VWAP
   is stale the instant the next tick prints. Keeping a broker order glued to
   a moving target means constant cancel/replace calls.
2. **Cancel/replace has real costs on some venues**: loss of FIFO queue
   priority, and API rate-limit exposure if you're re-quoting many symbols.
3. **Multi-timeframe convergence** (15m up to 12M) means some levels update
   every tick and others barely move for weeks — the engine has to handle
   both without keeping a year of tick data in RAM.

This is **not** a new strategy idea (VWAP/VP-based entries already exist —
`vwap-trend.js`, `vp-value.js`, `fib-strategy.js`'s own `vwap()`). It's a
proposed **execution mechanism**: replacing "place a limit order, monitor
it" with "hold a virtual level in memory, fire a market order on touch."
That's why this is scoped as its own spec rather than a strategy PR — it
changes how ANY strategy enters a trade, not what it trades.

---

## 1. Why this needs sign-off before code (not just review)

This is squarely inside "risk limits / execution" — the category the
standing PR policy carves out as needing an explicit human decision, not
just a green test gate:

- It moves entry logic from **broker-enforced** (a resting order the
  exchange holds even if the bot process dies) to **bot-enforced** (a
  market order only fires if the C++ process is alive, connected, and its
  state machine is armed). A crash/restart/disconnect window during which
  price touches the level means **the entry is silently missed** — no
  broker-side order was ever there to catch it. That's a real trade-off
  against the current design, not a strict improvement.
- It's a large new concurrency surface (a background thread recalculating
  indicators against a hot execution thread) in the same C++ binary that
  already handles real order placement (`ExecEngine::placeOrder`,
  `OrderGuard`) — a bug here is a live-money bug, not a UI bug.
- The two prompts describe a mechanism, not a specific instrument/timeframe
  set or sizing rule — several concrete decisions (§5) change the risk
  profile materially depending on the answer.

---

## 2. Does bot-trade actually need this? (this is the important part)

`doc_reference/pending-order-mode.md` — already in this repo — documents an
A/B test of exactly this trade-off, already run and already deployed: a
**resting LIMIT order at the fib 61.8% level, touch-filled by the broker**,
against a close-confirm entry. Result: **~10x more trades**, and it's live
today on an owner-approved GO set (EURUSD 3d/1d/12h, USDJPY 3d, GBPUSD
12h/1d, NZDUSD 4h, MSFT.US 12h/4h) with a DANGER set of instruments where
touch-fill was tested and rejected.

That means the core premise of the prompts' reason #2 — that resting
orders on this broker suffer FIFO-priority loss or rate-limit bans from
being re-quoted — has NOT been observed as a problem in this repo's own
existing resting-order mechanism. cTrader is a dealing/OTC-model broker,
not a lit order book with time-priority matching the way the prompts
assume (that assumption reads as written for an exchange-traded/FIX
context, not necessarily this one).

**This is the single most important open question (§5.1).** If amending or
replacing a resting order each cycle is cheap and reliable here — and the
existing pending-order-mode evidence suggests it is — then the honest
recommendation may be: **you likely don't need a virtual-order engine at
all.** The simpler thing (extend the existing resting-order path to VWAP/VP
levels, re-placing the order when the level moves) already gets the stated
benefit (adapts to a moving level) without taking on the crash-risk and
concurrency cost in §1. Building the harder mechanism when the simpler one
already covers the need would be effort spent on its own sake, not edge.

---

## 3. Proposed architecture, IF the owner still wants the virtual engine

Scoped to answer the prompts' own structure, translated to this repo's
actual constraints — kept here so the option is documented, not because §2
is resolved in its favour:

### 3.1 State machine (per symbol × timeframe combo)
```cpp
enum class VposState { IDLE, ARMED, FIRED };
struct VirtualPendingOrder {
  std::atomic<VposState> state{VposState::IDLE};
  std::atomic<double> triggerPrice{0.0};   // e.g. current VWAP or VP POC
  Side side;                              // long/short the armed setup implies
  std::string symbol, timeframe;
  // sizing/SL/TP resolved from the SAME risk.js gate the rest of the bot
  // uses — this engine does NOT invent its own sizing math.
};
```
Mirrors the existing `OrderGuard` pattern (`cpp-exec/src/order_guard.hpp`):
atomics for the hot path, no locks on the price-check side.

### 3.2 Two-tier data, per the prompts' own memory-efficiency ask
- **Macro timeframes (1D–12M):** build VWAP/VP once at init from historical
  OHLCV bars already available via `wsGetTrendbarsBatch` (this repo already
  fetches trendbars in bulk — see `fib-strategy.js`). Recompute on a slow
  timer (e.g. every closed bar), NOT per tick.
- **Micro timeframes (15m–4h):** update from the live tick stream
  (`CtraderWs`'s existing spot/tick subscription) tick-by-tick.
- A background thread owns the recompute; it publishes only the **current
  trigger price** to an atomic — the hot tick-check thread never touches
  the raw bar arrays, exactly as the second prompt asks.

### 3.3 Trigger → execution
On tick: hot thread compares live bid/ask against `triggerPrice.load()`. On
touch, transition `ARMED → FIRED` (atomic CAS so a race can't double-fire),
then call the SAME `ExecEngine::placeOrder()` market-order path that already
exists — this is not a new order-placement code path, just a new caller of
the existing one.

### 3.4 Reuse, not reinvent
- VWAP/VP math: `agent/lib/indicators.js` mirror convention already exists
  (MIRROR TWIN pattern between `src/lib/`, `agent/lib/`, and would need a
  THIRD C++ mirror here — a real maintenance cost, see §5.4).
- Sizing/SL/TP/margin gate: MUST go through the existing `risk.js` gate
  before a virtual order is even armed — this spec does not touch sizing.
- Bracket/target enforcement: the existing `OrderGuard::requireBracket`/
  `requireTarget` checks (added this repo cycle) apply unchanged to whatever
  market order the virtual engine fires.

---

## 4. Out of scope (deliberately, same posture as the Cup & Handle spec)

- No change to `risk.js` sizing, margin gate, or SL/TP requirement.
- No change to any strategy's entry LOGIC (what counts as a valid VWAP/VP
  setup) — that's `vwap-trend.js`/`vp-value.js`'s job, unchanged.
- Not a replacement for `OrderGuard`'s bracket/target checks — additive.
- Not touching the existing fib touch-fill pending-order mechanism
  (`pending-order-mode.md`) — that stays as-is regardless of what happens here.

---

## 5. Open decisions for owner sign-off before implementation

1. **Does cTrader actually have the FIFO-priority-loss problem the prompts
   describe?** (§2) The existing touch-fill pending-order evidence suggests
   no. If confirmed, the recommendation is: extend that existing mechanism
   to VWAP/VP levels (re-place the resting order when the level moves by
   more than some threshold) instead of building a virtual-order engine.
2. **If the owner still wants the virtual engine despite §2** — which
   existing strategies would actually use it? (`vwap_trend`? `vp_value`? a
   new one?) — changes the timeframe/instrument scope in §3.2.
3. **Missed-entry-on-crash risk (§1):** is a market-order-only virtual
   engine acceptable given a crash/disconnect silently drops the entry with
   no broker-side order to catch it? Or does this need a hybrid — broker
   order as a fallback catch, virtual engine as the primary/faster path?
4. **Third mirror-twin surface:** VWAP/VP math would need to exist in
   THREE places (`src/lib/`, `agent/lib/`, and this new C++ module) instead
   of two — is that maintenance cost acceptable, or should the C++ side call
   back into Node for the indicator math instead of reimplementing it?
5. **Multi-timeframe scope for v1:** build all of 15m–12M at once (per the
   second prompt), or start with ONE timeframe pair (e.g. 4h macro / 15m
   micro) and prove it against the extend-the-resting-order alternative
   before generalizing?

No implementation proceeds until these are answered.
