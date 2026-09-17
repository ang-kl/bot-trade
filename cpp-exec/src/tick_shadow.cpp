// cpp-exec/src/tick_shadow.cpp — see tick_shadow.hpp.
#include "tick_shadow.hpp"

#include <chrono>
#include <cmath>
#include <random>
#include <sstream>

namespace tick {

static double round4(double x) { return std::round(x * 1e4) / 1e4; }

// PR-L: the replayer's costExact / wireCostInt, behaviour for behaviour —
// agent/lib/tick-cost-schedule.js. Math.round on a positive value is llround
// on a positive value, and both floor the result at 1 when the exact cost is
// above zero, so a non-zero slippage never rounds away to a free fill.
double costExact(double wirePerSide, double bps, double price) {
  const double flat = std::isfinite(wirePerSide) ? wirePerSide : 0.0;
  const double prop = (std::isfinite(bps) && std::isfinite(price) && bps > 0 && price > 0) ? bps * price / 10000.0 : 0.0;
  return flat + prop;
}

long long wireCostInt(double wirePerSide, double bps, double price) {
  const double exact = costExact(wirePerSide, bps, price);
  if (!(exact > 0)) return 0;
  const long long r = std::llround(exact);
  return r < 1 ? 1 : r;
}

std::string ShadowCostSchedule::classFor(long long symbolId) const {
  auto it = symbolClass.find(symbolId);
  if (it != symbolClass.end() && classes.count(it->second)) return it->second;
  if (!fallbackClass.empty() && classes.count(fallbackClass)) return fallbackClass;
  return std::string();
}

ShadowCost ShadowCostSchedule::costFor(long long symbolId) const {
  const std::string c = classFor(symbolId);
  if (c.empty()) return ShadowCost{};
  return classes.at(c);
}

jsn::Value ShadowCostSchedule::json() const {
  jsn::Value v{jsn::Object{}};
  v.set("fallbackClass", fallbackClass);
  jsn::Value cs{jsn::Object{}};
  for (const auto& [name, c] : classes) {
    jsn::Value one{jsn::Object{}};
    one.set("commissionWirePerSide", c.commissionWirePerSide);
    one.set("commissionBpsPerSide", c.commissionBpsPerSide);
    one.set("slippageWirePerSide", c.slippageWirePerSide);
    one.set("slippageBpsPerSide", c.slippageBpsPerSide);
    cs.set(name, std::move(one));
  }
  v.set("classes", std::move(cs));
  jsn::Value sm{jsn::Object{}};
  for (const auto& [id, name] : symbolClass) sm.set(std::to_string(id), name);
  v.set("symbolClass", std::move(sm));
  return v;
}

std::string ShadowSim::json() const {
  jsn::Value v{jsn::Object{}};
  v.set("latencyMs", static_cast<double>(latencyMs));
  v.set("slippage", static_cast<double>(slippage));
  v.set("commissionPerSide", static_cast<double>(commissionPerSide));
  v.set("targetR", targetR);
  v.set("minTargetToCost", minTargetToCost);
  v.set("maxHoldEvents", static_cast<double>(maxHoldEvents));
  v.set("maxHoldMs", static_cast<double>(maxHoldMs));
  v.set("costs", costs.json());
  return jsn::dump(v);
}

static ShadowCost effectiveCost(const ShadowSim& sim, long long symbolId) {
  ShadowCost c = sim.costs.costFor(symbolId);
  c.commissionWirePerSide += static_cast<double>(sim.commissionPerSide);
  c.slippageWirePerSide += static_cast<double>(sim.slippage);
  return c;
}

ShadowBook::ShadowBook(ShadowSim sim, int rangeEvents, long long symbolId, std::string profileHash)
  : sim_(sim), cost_(effectiveCost(sim, symbolId)), costClass_(sim.costs.classFor(symbolId)),
    maxHoldEvents_(sim.maxHoldEvents > 0 ? sim.maxHoldEvents : 4 * rangeEvents),
    symbolId_(symbolId), hash_(std::move(profileHash)) {}

std::optional<ShadowTrade> ShadowBook::onQuote(const StrategyQuote& q) {
  std::optional<ShadowTrade> closed;
  const bool ok = tradable(q);
  if (ok) { last_ = q; haveLast_ = true; }
  // 1. manage the open trade on this event (exits use THIS event's executable side)
  if (open_ && ok) {
    ShadowOpen& o = *open_;
    o.tradableSeen++;
    std::optional<long long> exit;
    std::string reason;
    if (o.side == "BUY") {
      if (q.bid <= o.stop) { exit = q.bid - slipAt(static_cast<double>(q.bid)); reason = "stop"; }
      else if (q.bid >= o.target) { exit = q.bid - slipAt(static_cast<double>(q.bid)); reason = "target"; }
    } else {
      if (q.ask >= o.stop) { exit = q.ask + slipAt(static_cast<double>(q.ask)); reason = "stop"; }
      else if (q.ask <= o.target) { exit = q.ask + slipAt(static_cast<double>(q.ask)); reason = "target"; }
    }
    if (!exit && (o.tradableSeen >= maxHoldEvents_ || q.recvMs - o.entryMs >= static_cast<uint64_t>(sim_.maxHoldMs))) {
      exit = o.side == "BUY" ? q.bid - slipAt(static_cast<double>(q.bid)) : q.ask + slipAt(static_cast<double>(q.ask));
      reason = o.tradableSeen >= maxHoldEvents_ ? "hold_events" : "hold_clock";
    }
    if (exit) {
      const long long gross = o.side == "BUY" ? *exit - o.entry : o.entry - *exit;
      const double net = static_cast<double>(gross) - (commAt(static_cast<double>(o.entry)) + commAt(static_cast<double>(*exit)));
      ShadowTrade t;
      t.symbolId = symbolId_; t.side = o.side; t.signalSeq = o.signalSeq; t.entrySeq = o.entrySeq; t.exitSeq = q.seq;
      t.entry = o.entry; t.exit = *exit; t.stop = o.stop; t.target = o.target; t.stopDistance = o.stopDistance;
      t.reason = reason; t.holdEvents = o.tradableSeen; t.holdMs = q.recvMs - o.entryMs; t.entryMs = o.entryMs; t.exitMs = q.recvMs;
      t.grossR = round4(static_cast<double>(gross) / static_cast<double>(o.stopDistance));
      t.netR = round4(net / static_cast<double>(o.stopDistance));
      t.profileHash = hash_;
      t.costClass = costClass_;
      recordCostModel(t);
      closed = t;
      open_.reset();
    }
  }
  // 2. fill a pending signal at the first tradable event past the latency
  if (pending_ && !open_ && ok && q.recvMs >= pending_->recvMs + static_cast<uint64_t>(sim_.latencyMs)) {
    const TickSignal& p = *pending_;
    const long long entry = p.side == "BUY" ? q.ask + slipAt(static_cast<double>(q.ask)) : q.bid - slipAt(static_cast<double>(q.bid));
    const double tgt = sim_.targetR * static_cast<double>(p.stopDistance);
    ShadowOpen o;
    o.side = p.side; o.signalSeq = p.seq; o.entrySeq = q.seq; o.entry = entry; o.stopDistance = p.stopDistance;
    o.stop = p.side == "BUY" ? entry - p.stopDistance : entry + p.stopDistance;
    // The replayer keeps the target as a double (entry ± targetR·stop); wire
    // prices are integers, so with an integral targetR the two agree exactly.
    o.target = p.side == "BUY" ? entry + static_cast<long long>(std::llround(tgt)) : entry - static_cast<long long>(std::llround(tgt));
    o.entryMs = q.recvMs; o.tradableSeen = 0;
    open_ = o;
    ShadowFill f;
    f.symbolId = symbolId_; f.side = p.side; f.signalSeq = p.seq; f.entrySeq = q.seq; f.recvMs = q.recvMs;
    f.entry = entry; f.stop = o.stop; f.target = o.target; f.stopDistance = p.stopDistance;
    f.signalBid = p.bid; f.signalAsk = p.ask; f.profileHash = hash_;
    fill_ = f;
    pending_.reset();
  }
  return closed;
}

std::optional<ShadowTrade> ShadowBook::markAtLast(const std::string& reason) {
  if (!open_ || !haveLast_) { open_.reset(); pending_.reset(); return std::nullopt; }
  const ShadowOpen& o = *open_;
  const long long exit = o.side == "BUY" ? last_.bid - slipAt(static_cast<double>(last_.bid)) : last_.ask + slipAt(static_cast<double>(last_.ask));
  const long long gross = o.side == "BUY" ? exit - o.entry : o.entry - exit;
  const double net = static_cast<double>(gross) - (commAt(static_cast<double>(o.entry)) + commAt(static_cast<double>(exit)));
  ShadowTrade t;
  t.symbolId = symbolId_; t.side = o.side; t.signalSeq = o.signalSeq; t.entrySeq = o.entrySeq; t.exitSeq = last_.seq;
  t.entry = o.entry; t.exit = exit; t.stop = o.stop; t.target = o.target; t.stopDistance = o.stopDistance;
  t.reason = reason; t.holdEvents = o.tradableSeen; t.holdMs = last_.recvMs >= o.entryMs ? last_.recvMs - o.entryMs : 0; t.entryMs = o.entryMs; t.exitMs = last_.recvMs;
  t.grossR = round4(static_cast<double>(gross) / static_cast<double>(o.stopDistance));
  t.netR = round4(net / static_cast<double>(o.stopDistance));
  t.profileHash = hash_;
  t.costClass = costClass_;
  recordCostModel(t);
  open_.reset(); pending_.reset();
  return t;
}

bool ShadowBook::offer(const TickSignal& sig) {
  // 3. a signal while a trade is open or pending is not taken
  if (open_ || pending_) { rejected_.noFill++; return false; }
  // The screen prices the round trip at the signal's MID — one price for both
  // ends, the replayer's rule (lib/tick-replay-sim.js step 3).
  const double mid = static_cast<double>(sig.bid + sig.ask) / 2.0;
  const double cost = static_cast<double>(sig.ask - sig.bid) + 2.0 * commAt(mid) + 2.0 * static_cast<double>(slipAt(mid));
  const double target = sim_.targetR * static_cast<double>(sig.stopDistance);
  if (cost > 0 && target / cost < sim_.minTargetToCost) { rejected_.cost++; return false; }
  pending_ = sig;
  return true;
}

static std::string randomId() {
  std::random_device rd;
  std::mt19937_64 g(rd() ^ static_cast<uint64_t>(std::chrono::steady_clock::now().time_since_epoch().count()));
  std::ostringstream o; o << std::hex << g();
  return o.str();
}

ShadowLedger::ShadowLedger(size_t slots) : slots_(slots ? slots : 1), bootId_(randomId()), ring_(slots_) {}

long long ShadowLedger::record(const ShadowTrade& t) {
  std::lock_guard<std::mutex> lk(mtx_);
  const long long s = ++seq_;
  ring_[static_cast<size_t>(s % static_cast<long long>(slots_))] = { s, t };
  return s;
}

std::vector<std::pair<long long, ShadowTrade>> ShadowLedger::since(long long after) const {
  std::lock_guard<std::mutex> lk(mtx_);
  std::vector<std::pair<long long, ShadowTrade>> out;
  if (seq_ == 0) return out;
  const long long oldest = seq_ > static_cast<long long>(slots_) ? seq_ - static_cast<long long>(slots_) + 1 : 1;
  const long long from = after + 1 < oldest ? oldest : after + 1;
  for (long long s = from; s <= seq_; ++s) out.push_back(ring_[static_cast<size_t>(s % static_cast<long long>(slots_))]);
  return out;
}

long long ShadowLedger::latestSeq() const { std::lock_guard<std::mutex> lk(mtx_); return seq_; }
uint64_t ShadowLedger::total() const { std::lock_guard<std::mutex> lk(mtx_); return static_cast<uint64_t>(seq_); }

jsn::Value ShadowLedger::tradeJson(long long seq, const ShadowTrade& t) {
  jsn::Value v{jsn::Object{}};
  v.set("seq", static_cast<double>(seq));
  v.set("symbolId", static_cast<double>(t.symbolId));
  v.set("side", t.side);
  v.set("signalSeq", static_cast<double>(t.signalSeq));
  v.set("entrySeq", static_cast<double>(t.entrySeq));
  v.set("exitSeq", static_cast<double>(t.exitSeq));
  v.set("entry", static_cast<double>(t.entry));
  v.set("exit", static_cast<double>(t.exit));
  v.set("stop", static_cast<double>(t.stop));
  v.set("target", static_cast<double>(t.target));
  v.set("stopDistance", static_cast<double>(t.stopDistance));
  v.set("reason", t.reason);
  v.set("holdEvents", static_cast<double>(t.holdEvents));
  v.set("holdMs", static_cast<double>(t.holdMs));
  v.set("entryMs", static_cast<double>(t.entryMs));
  v.set("exitMs", static_cast<double>(t.exitMs));
  v.set("grossR", t.grossR);
  v.set("netR", t.netR);
  v.set("profile", t.profileHash);
  // PR-L: the cost model this trade was charged, carried to the keeper.
  v.set("costClass", t.costClass);
  v.set("commissionWirePerSide", t.commissionWirePerSide);
  v.set("commissionBpsPerSide", t.commissionBpsPerSide);
  v.set("slippageWirePerSide", t.slippageWirePerSide);
  v.set("slippageBpsPerSide", t.slippageBpsPerSide);
  return v;
}

std::string ShadowLedger::dumpJson(long long after, const std::string& callerBootId) const {
  const long long from = callerBootId == bootId_ ? after : 0;
  const auto rows = since(from);
  jsn::Value v{jsn::Object{}};
  v.set("bootId", bootId_);
  v.set("latestSeq", static_cast<double>(latestSeq()));
  v.set("total", static_cast<double>(total()));
  jsn::Array arr;
  for (const auto& [s, t] : rows) arr.push_back(tradeJson(s, t));
  v.set("trades", jsn::Value(std::move(arr)));
  return jsn::dump(v);
}

} // namespace tick
