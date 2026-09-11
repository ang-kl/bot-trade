// cpp-exec/src/tick_shadow.cpp — see tick_shadow.hpp.
#include "tick_shadow.hpp"

#include <chrono>
#include <cmath>
#include <random>
#include <sstream>

namespace tick {

static double round4(double x) { return std::round(x * 1e4) / 1e4; }

std::string ShadowSim::json() const {
  jsn::Value v{jsn::Object{}};
  v.set("latencyMs", static_cast<double>(latencyMs));
  v.set("slippage", static_cast<double>(slippage));
  v.set("commissionPerSide", static_cast<double>(commissionPerSide));
  v.set("targetR", targetR);
  v.set("minTargetToCost", minTargetToCost);
  v.set("maxHoldEvents", static_cast<double>(maxHoldEvents));
  v.set("maxHoldMs", static_cast<double>(maxHoldMs));
  return jsn::dump(v);
}

ShadowBook::ShadowBook(ShadowSim sim, int rangeEvents, long long symbolId, std::string profileHash)
  : sim_(sim), maxHoldEvents_(sim.maxHoldEvents > 0 ? sim.maxHoldEvents : 4 * rangeEvents),
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
      if (q.bid <= o.stop) { exit = q.bid - sim_.slippage; reason = "stop"; }
      else if (q.bid >= o.target) { exit = q.bid - sim_.slippage; reason = "target"; }
    } else {
      if (q.ask >= o.stop) { exit = q.ask + sim_.slippage; reason = "stop"; }
      else if (q.ask <= o.target) { exit = q.ask + sim_.slippage; reason = "target"; }
    }
    if (!exit && (o.tradableSeen >= maxHoldEvents_ || q.recvMs - o.entryMs >= static_cast<uint64_t>(sim_.maxHoldMs))) {
      exit = o.side == "BUY" ? q.bid - sim_.slippage : q.ask + sim_.slippage;
      reason = o.tradableSeen >= maxHoldEvents_ ? "hold_events" : "hold_clock";
    }
    if (exit) {
      const long long gross = o.side == "BUY" ? *exit - o.entry : o.entry - *exit;
      const long long net = gross - 2 * sim_.commissionPerSide;
      ShadowTrade t;
      t.symbolId = symbolId_; t.side = o.side; t.signalSeq = o.signalSeq; t.entrySeq = o.entrySeq; t.exitSeq = q.seq;
      t.entry = o.entry; t.exit = *exit; t.stop = o.stop; t.target = o.target; t.stopDistance = o.stopDistance;
      t.reason = reason; t.holdEvents = o.tradableSeen; t.holdMs = q.recvMs - o.entryMs; t.entryMs = o.entryMs; t.exitMs = q.recvMs;
      t.grossR = round4(static_cast<double>(gross) / static_cast<double>(o.stopDistance));
      t.netR = round4(static_cast<double>(net) / static_cast<double>(o.stopDistance));
      t.profileHash = hash_;
      closed = t;
      open_.reset();
    }
  }
  // 2. fill a pending signal at the first tradable event past the latency
  if (pending_ && !open_ && ok && q.recvMs >= pending_->recvMs + static_cast<uint64_t>(sim_.latencyMs)) {
    const TickSignal& p = *pending_;
    const long long entry = p.side == "BUY" ? q.ask + sim_.slippage : q.bid - sim_.slippage;
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
  const long long exit = o.side == "BUY" ? last_.bid - sim_.slippage : last_.ask + sim_.slippage;
  const long long gross = o.side == "BUY" ? exit - o.entry : o.entry - exit;
  const long long net = gross - 2 * sim_.commissionPerSide;
  ShadowTrade t;
  t.symbolId = symbolId_; t.side = o.side; t.signalSeq = o.signalSeq; t.entrySeq = o.entrySeq; t.exitSeq = last_.seq;
  t.entry = o.entry; t.exit = exit; t.stop = o.stop; t.target = o.target; t.stopDistance = o.stopDistance;
  t.reason = reason; t.holdEvents = o.tradableSeen; t.holdMs = last_.recvMs >= o.entryMs ? last_.recvMs - o.entryMs : 0; t.entryMs = o.entryMs; t.exitMs = last_.recvMs;
  t.grossR = round4(static_cast<double>(gross) / static_cast<double>(o.stopDistance));
  t.netR = round4(static_cast<double>(net) / static_cast<double>(o.stopDistance));
  t.profileHash = hash_;
  open_.reset(); pending_.reset();
  return t;
}

bool ShadowBook::offer(const TickSignal& sig) {
  // 3. a signal while a trade is open or pending is not taken
  if (open_ || pending_) { rejected_.noFill++; return false; }
  const double cost = static_cast<double>(sig.ask - sig.bid) + 2.0 * static_cast<double>(sim_.commissionPerSide) + 2.0 * static_cast<double>(sim_.slippage);
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
