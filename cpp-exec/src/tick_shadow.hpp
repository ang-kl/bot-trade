// cpp-exec/src/tick_shadow.hpp — P6a: the shadow's OWN simulated portfolio
// (docs/tick-momentum/plan.md §2 "Shadow uses its own simulated portfolio";
// register TM-35 evidence, the SHADOW_PASSED stage).
//
// One ShadowBook per symbol, owned by the worker that owns the symbol (no
// lock shared between workers), driven by the same quotes the strategy sees
// and by the strategy's own signals, filling and exiting by EXACTLY the
// rules of the reference replayer (agent/lib/tick-replay-sim.js simulate):
//
//   1. manage the open trade on THIS event first — a long exits at the bid
//      that crossed its stop or target (a short at the ask), minus slippage;
//      a gap through the stop fills at the price that was there, never at
//      the stop; hold caps in events and in wall time;
//   2. then fill a pending signal at the first tradable event at or after
//      signal time + latency: a long at the ask plus slippage, stop and
//      target measured from the ACTUAL entry;
//   3. then the strategy's signal for this event is offered — the cost
//      screen (target / (spread + 2·commission + 2·slippage) ≥ minimum)
//      refuses it, an open or pending trade leaves it untaken (noFill).
//
// Nothing here places anything, reserves anything or reads an account: it
// records trades in PRICE units and R multiples; the keeper sizes each
// account's projection from that account's own risk budget. Why it lives on
// the sidecar and not the keeper: the quotes do (the spool is on the
// sidecar's volume and the keeper has no route to the stream), and a shadow
// that filled off a sampled price at loop cadence would not be the
// replayer's rule and could not be evidence for it.
//
// Closed trades go to one ShadowLedger per process (bounded ring, private
// mutex, never held across I/O — the DecisionRing's contract) that the
// keeper pulls with POST /tick-shadow {after, bootId} and persists.
#pragma once
#include <cstdint>
#include <deque>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "json.hpp"
#include "tick_strategy.hpp"

namespace tick {

// PR-L: the per-symbol-class cost schedule, the mirror of
// agent/lib/tick-cost-schedule.js. A class row carries BOTH an absolute wire
// term and a bps term per side, because the broker charges two shapes: US
// stock is a flat $0.02 PER SHARE (2000 wire units, a wire unit being 1e-5 of
// price for every cTrader symbol), while HK stock and FX are proportional to
// price. One unit alone misprices the other — measured over the owner's own
// statements, US stock has CV 0.58 in price units against 0.975 in bps, and
// HK stock the reverse. Cost per side is
//   commissionWirePerSide + commissionBpsPerSide × price / 10000.
struct ShadowCost {
  double commissionWirePerSide = 0;   // absolute, wire units (US stock: a flat $0.02/share = 2000)
  double commissionBpsPerSide = 0;    // proportional (HK stock, FX)
  double slippageWirePerSide = 0;
  double slippageBpsPerSide = 0;
};

struct ShadowCostSchedule {
  std::map<std::string, ShadowCost> classes;      // class name → the four terms per side
  std::map<long long, std::string> symbolClass;   // symbolId → class name (pushed by the keeper)
  std::string fallbackClass;                      // charged when a symbol does not classify
  // The class this symbol is charged at — the mapped one, else the fallback,
  // else empty (no schedule at all: the absolute fields alone, as before).
  std::string classFor(long long symbolId) const;
  ShadowCost costFor(long long symbolId) const;
  jsn::Value json() const;
  bool empty() const { return classes.empty(); }
};

// Mirrors agent/lib/tick-replay-sim.js DEFAULT_SIM. `slippage` and
// `commissionPerSide` are the LEGACY GLOBAL absolute wire terms per side; they
// are folded into the book's effective cost row at construction and add on top
// of the class row. Both are 0 by default, as in the replayer.
struct ShadowSim {
  long long latencyMs = 250;
  long long slippage = 0;
  long long commissionPerSide = 0;
  double targetR = 3.0;
  double minTargetToCost = 3.0;
  int maxHoldEvents = 0;               // 0 → 4 × rangeEvents (the replayer's default)
  long long maxHoldMs = 6LL * 3600 * 1000;
  ShadowCostSchedule costs;
  std::string json() const;
};

// The two cost rules, mirroring agent/lib/tick-cost-schedule.js exactly.
// costExact is the unrounded per-side cost (commission uses it and is never
// quantised — rounding re-created the zero-cost bug on cheap symbols:
// DOGEUSD at 0.06851 is 6,851 wire units and 0.5 bps of that is 0.34).
// wireCostInt is for a term that must shift an INTEGER price (slippage) and
// rounds AWAY FROM ZERO, so a non-zero slippage is never a free fill.
double costExact(double wirePerSide, double bps, double price);
long long wireCostInt(double wirePerSide, double bps, double price);

struct ShadowTrade {
  long long symbolId = 0;
  std::string side;                    // BUY | SELL
  uint32_t signalSeq = 0, entrySeq = 0, exitSeq = 0;
  long long entry = 0, exit = 0, stop = 0, target = 0, stopDistance = 0;
  std::string reason;                  // stop | target | hold_events | hold_clock
  int holdEvents = 0;
  uint64_t holdMs = 0;
  uint64_t entryMs = 0, exitMs = 0;
  double grossR = 0, netR = 0;         // rounded to 4 dp, the replayer's toFixed(4)
  std::string profileHash;
  // PR-L: the cost model THIS trade was charged, on the row — so the keeper's
  // sensitivity line can strip it back off and re-price, and so the evidence
  // gate can prove the row was charged the schedule the sidecar reports,
  // rather than believing the report. Empty class + zeros = the pre-PR-L
  // spread-only model, which is the truth about every trade closed before it.
  std::string costClass;
  double commissionWirePerSide = 0, commissionBpsPerSide = 0;
  double slippageWirePerSide = 0, slippageBpsPerSide = 0;
};

struct ShadowOpen {
  std::string side;
  uint32_t signalSeq = 0, entrySeq = 0;
  long long entry = 0, stop = 0, target = 0, stopDistance = 0;
  uint64_t entryMs = 0;
  int tradableSeen = 0;
};

// P6b: the moment the book FILLS a pending signal — the price the real
// order would be placed at. Taken once by the fire path (takeFill).
struct ShadowFill {
  long long symbolId = 0;
  std::string side;
  uint32_t signalSeq = 0, entrySeq = 0;
  uint64_t recvMs = 0;
  long long entry = 0, stop = 0, target = 0, stopDistance = 0;
  long long signalBid = 0, signalAsk = 0;   // the quote the signal was made at
  std::string profileHash;
};

class ShadowBook {
public:
  ShadowBook(ShadowSim sim, int rangeEvents, long long symbolId, std::string profileHash);
  // Steps 1 and 2 for this event. Returns the trade this event closed, if any.
  std::optional<ShadowTrade> onQuote(const StrategyQuote& q);
  // P6b: the fill made by the last onQuote, if any — cleared on take.
  std::optional<ShadowFill> takeFill() { auto f = fill_; fill_.reset(); return f; }
  // Step 3: the strategy's signal for the SAME event, after onQuote. Returns
  // true when it became the pending trade.
  bool offer(const TickSignal& sig);
  struct Rejected { uint64_t cost = 0, noFill = 0; };
  const Rejected& rejected() const { return rejected_; }
  const std::optional<ShadowOpen>& open() const { return open_; }
  bool hasPending() const { return pending_.has_value(); }
  const ShadowSim& sim() const { return sim_; }
  // PR-L: the cost row this book charges, resolved once at construction from
  // the schedule and this book's symbol.
  const ShadowCost& cost() const { return cost_; }
  const std::string& costClass() const { return costClass_; }
  // ROUND-TWO CHECKER, MINOR 4: `cost_` is the EFFECTIVE cost this book
  // charges — the class row with the sim's global absolute terms already
  // folded in at construction. Charging `global + class` while RECORDING
  // only the class row meant the keeper stripped less slippage than the book
  // had added, so `reprice@1 === recorded netR` — an invariant this repo
  // pins — held only while both globals were 0. Folding once means the
  // number charged and the number recorded cannot drift apart.
  long long slipAt(double price) const { return wireCostInt(cost_.slippageWirePerSide, cost_.slippageBpsPerSide, price); }
  double commAt(double price) const { return costExact(cost_.commissionWirePerSide, cost_.commissionBpsPerSide, price); }
  void recordCostModel(ShadowTrade& t) const {
    t.commissionWirePerSide = cost_.commissionWirePerSide; t.commissionBpsPerSide = cost_.commissionBpsPerSide;
    t.slippageWirePerSide = cost_.slippageWirePerSide; t.slippageBpsPerSide = cost_.slippageBpsPerSide;
  }
  // Mark the open trade at the LAST executable side seen and close it with
  // the given reason ('reset' on a switch-off) — the replayer's data_end
  // rule: an unclosed trade must not vanish from the ledger (Statistics
  // auditor, 11-09-2026: dropping it is length-biased survivorship). None
  // when nothing is open or no tradable quote was ever seen.
  std::optional<ShadowTrade> markAtLast(const std::string& reason);
  static bool tradable(const StrategyQuote& q) { return q.hasBid && q.hasAsk && !q.snapshot && !q.crossed; }

private:
  ShadowSim sim_;
  ShadowCost cost_;
  std::string costClass_;
  int maxHoldEvents_;
  long long symbolId_;
  std::string hash_;
  std::optional<ShadowOpen> open_;
  std::optional<TickSignal> pending_;
  Rejected rejected_;
  bool haveLast_ = false;
  StrategyQuote last_;   // the last tradable quote (for markAtLast)
  std::optional<ShadowFill> fill_;
};

// The process-wide closed-trade ring. bootId is random per construction so
// the puller detects a restart; seq is monotonic within one boot.
class ShadowLedger {
public:
  explicit ShadowLedger(size_t slots = 4096);
  long long record(const ShadowTrade& t);           // returns the seq assigned
  std::vector<std::pair<long long, ShadowTrade>> since(long long after) const;
  long long latestSeq() const;
  uint64_t total() const;
  const std::string& bootId() const { return bootId_; }
  // {bootId, latestSeq, total, trades:[...]} for POST /tick-shadow. When the
  // caller's bootId does not match, the whole ring is returned (restart).
  std::string dumpJson(long long after, const std::string& callerBootId) const;
  static jsn::Value tradeJson(long long seq, const ShadowTrade& t);

private:
  const size_t slots_;
  const std::string bootId_;
  mutable std::mutex mtx_;
  std::vector<std::pair<long long, ShadowTrade>> ring_;
  long long seq_ = 0;
};

} // namespace tick
