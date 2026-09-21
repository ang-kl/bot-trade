// cpp-exec/src/tick_firer.cpp — see tick_firer.hpp.
#include "tick_firer.hpp"

#include <chrono>
#include <cmath>

#include "order_guard.hpp"

namespace tick {

std::string TickPermitStore::key(long long a, long long s, const std::string& side) {
  return std::to_string(a) + ":" + std::to_string(s) + ":" + side;
}

void TickPermitStore::set(long long accountId, long long symbolId, const std::string& side, jsn::Value permit) {
  std::lock_guard<std::mutex> lk(mtx_);
  permits_[key(accountId, symbolId, side)] = std::move(permit);
}

std::optional<jsn::Value> TickPermitStore::take(long long accountId, long long symbolId, const std::string& side, long long nowMs) {
  std::lock_guard<std::mutex> lk(mtx_);
  auto it = permits_.find(key(accountId, symbolId, side));
  if (it == permits_.end()) return std::nullopt;
  jsn::Value p = it->second;
  permits_.erase(it);
  const double exp = p.get("expiresAtMs").asNumber(0);
  if (exp <= 0 || static_cast<long long>(exp) < nowMs) return std::nullopt; // expired: gone either way
  return p;
}

size_t TickPermitStore::size() const { std::lock_guard<std::mutex> lk(mtx_); return permits_.size(); }

void TickPermitStore::clearAccount(long long accountId) {
  std::lock_guard<std::mutex> lk(mtx_);
  const std::string prefix = std::to_string(accountId) + ":";
  for (auto it = permits_.begin(); it != permits_.end();) {
    if (it->first.rfind(prefix, 0) == 0) it = permits_.erase(it); else ++it;
  }
}

void TickPermitStore::clear() { std::lock_guard<std::mutex> lk(mtx_); permits_.clear(); }

TickFirer::TickFirer(ExecEngine& engine, TickPermitStore& permits) : engine_(engine), permits_(permits) {}
TickFirer::~TickFirer() { stop(); }

void TickFirer::setAccounts(std::set<long long> accounts) {
  std::lock_guard<std::mutex> lk(mtx_);
  accounts_ = std::move(accounts);
}
std::set<long long> TickFirer::accounts() const { std::lock_guard<std::mutex> lk(mtx_); return accounts_; }

void TickFirer::start() {
  if (running_.exchange(true)) return;
  thread_ = std::thread([this] { loop(); });
}

void TickFirer::stop() {
  if (!running_.exchange(false)) return;
  // Abandon what is still queued BEFORE waking the thread: nothing queued
  // is sent after a stop (RACE CHECKER 11-09-2026: the old loop sent one
  // more fire on its way out).
  std::deque<TickFire> dropped;
  {
    std::lock_guard<std::mutex> lk(mtx_);
    dropped.swap(queue_);
    counters_.abandoned += dropped.size();
  }
  for (const auto& d : dropped)
    if (ring_) ring_->log("tick", "fire_abandoned", d.accountId, static_cast<long long>(d.payload.get("symbolId").asNumber(0)), "stopped", "intent=" + d.intentId);
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

std::string TickFirer::labelFor(const ShadowFill& f, const std::string& intentId) {
  std::string label = "tick:" + f.profileHash;
  if (!intentId.empty()) label += "|||||||" + intentId; // 8th field = the intent tag
  return label;
}

std::optional<double> TickFirer::sizeVolume(const jsn::Value& permit, long long stopDistance, std::string* why) {
  const double usdRisk = permit.get("usdRisk").asNumber(0);
  const double perUnit = permit.get("usdPerLotPerUnit").asNumber(0);
  const double volumePerLot = permit.get("volumePerLot").asNumber(0);
  const double lotStep = permit.get("lotStep").asNumber(0);
  const double minLots = permit.get("minLots").asNumber(0);
  const double maxLots = permit.get("maxLots").asNumber(0);
  if (stopDistance <= 0) { if (why) *why = "sizing: stop distance is not positive"; return std::nullopt; }
  if (!(usdRisk > 0) || !(perUnit > 0) || !(volumePerLot > 0) || !(lotStep > 0) || !(minLots > 0)) {
    if (why) *why = "sizing: the permit carries no risk figures (usdRisk, usdPerLotPerUnit, volumePerLot, lotStep, minLots)";
    return std::nullopt;
  }
  double lots = usdRisk / (static_cast<double>(stopDistance) * perUnit);
  if (maxLots > 0 && lots > maxLots) lots = maxLots;
  lots = std::floor(lots / lotStep + 1e-9) * lotStep;
  if (lots + 1e-12 < minLots) {
    if (why) *why = "unaffordable_lot: the account's R buys " + std::to_string(lots) + " lot(s), below the minimum " + std::to_string(minLots);
    return std::nullopt;
  }
  return std::round(lots * volumePerLot);
}

jsn::Value TickFirer::buildPayload(long long accountId, const ShadowFill& f, double volume, const jsn::Value& permit) {
  jsn::Value payload{jsn::Object{}};
  payload.set("ctidTraderAccountId", static_cast<double>(accountId));
  payload.set("symbolId", static_cast<double>(f.symbolId));
  payload.set("tradeSide", f.side);
  payload.set("orderType", std::string("MARKET"));
  payload.set("volume", volume);
  // The bracket the book filled with, in the broker's relative units: the
  // feed's wire price and cTrader's relative stop share the 1e-5 scale.
  payload.set("relativeStopLoss", static_cast<double>(f.stopDistance));
  const long long tp = f.target > f.entry ? f.target - f.entry : f.entry - f.target;
  payload.set("relativeTakeProfit", static_cast<double>(tp));
  payload.set("label", labelFor(f, permit.get("intentId").asString()));
  payload.set("comment", std::string("abot-tick"));
  payload.set("permit", permit);
  payload.set("intentId", permit.get("intentId"));
  return payload;
}

int TickFirer::onFill(const ShadowFill& f, long long nowMs) {
  std::set<long long> accounts;
  { std::lock_guard<std::mutex> lk(mtx_); counters_.fills++; accounts = accounts_; }
  if (accounts.empty()) return 0;
  // TM-40, asked ONCE per fill (the recorder's status copies its per-symbol
  // map): no permit is spent while the recorder is not RECORDING.
  const bool recording = !recordingOk_ || recordingOk_();
  int queued = 0;
  for (long long acct : accounts) {
    auto refuse = [&](const char* kind, const std::string& why, uint64_t FireCounters::*ctr) {
      { std::lock_guard<std::mutex> lk(mtx_); (counters_.*ctr)++; }
      if (ring_) ring_->log("tick", "fire_refused", acct, f.symbolId, kind, f.side + " " + why + " seq=" + std::to_string(f.signalSeq) + " profile=" + f.profileHash);
    };
    if (!recording) { refuse("recorder_not_recording", "the recorder is not RECORDING — new tick entries pause (TM-40)", &FireCounters::refusedRecorder); continue; }
    const long long ref = f.side == "BUY" ? f.signalAsk : f.signalBid;
    auto permit = permits_.take(acct, f.symbolId, f.side, nowMs);
    if (!permit) { refuse("no_permit", "no keeper permit held for this account/symbol/side", &FireCounters::refusedNoPermit); continue; }
    const double frac = permit->get("overshootFraction").asNumber(0.25);
    const long long maxDev = static_cast<long long>(std::floor(frac * static_cast<double>(f.stopDistance)));
    if (!priceWithinBound(ref, f.entry, maxDev)) {
      refuse("price_bound", "fill " + std::to_string(f.entry) + " is more than " + std::to_string(maxDev) + " from the signal's " + std::to_string(ref), &FireCounters::refusedPriceBound);
      continue;
    }
    // The account's policy floor on the stop (plan §3: the greatest of the
    // volatility distance, the broker's minimum and the policy floor): a
    // stop below minStopFraction × entry would let the R budget buy a lot
    // the account cannot carry — refused, never resized.
    const double minStopFrac = permit->get("minStopFraction").asNumber(0);
    const long long floorDist = minStopFrac > 0 ? static_cast<long long>(std::llround(minStopFrac * static_cast<double>(f.entry))) : 0;
    if (f.stopDistance < floorDist) {
      refuse("stop_below_floor", "stop " + std::to_string(f.stopDistance) + " is below the policy floor " + std::to_string(floorDist) + " (" + std::to_string(minStopFrac) + " of the entry)", &FireCounters::refusedStopFloor);
      continue;
    }
    std::string why;
    auto vol = sizeVolume(*permit, f.stopDistance, &why);
    if (!vol) { refuse(why.rfind("unaffordable_lot", 0) == 0 ? "unaffordable_lot" : "sizing", why, why.rfind("unaffordable_lot", 0) == 0 ? &FireCounters::refusedUnaffordable : &FireCounters::refusedSizing); continue; }
    TickFire fire;
    fire.accountId = acct;
    fire.payload = buildPayload(acct, f, *vol, *permit);
    fire.intentId = permit->get("intentId").asString();
    fire.fillMs = nowMs;
    fire.entry = f.entry; fire.stop = f.stop; fire.target = f.target; fire.side = f.side;
    fire.ref = ref;
    fire.maxFireDelayMs = static_cast<long long>(permit->get("maxFireDelayMs").asNumber(0));
    bool full = false;
    {
      std::lock_guard<std::mutex> lk(mtx_);
      if (queue_.size() >= kMaxQueue) full = true;
      else { queue_.push_back(fire); counters_.queued++; }
    }
    if (full) { refuse("queue_full", "the fire queue is full (" + std::to_string(kMaxQueue) + ")", &FireCounters::refusedQueueFull); continue; }
    if (ring_) ring_->log("tick", "fire", acct, f.symbolId, f.side,
                          "vol=" + std::to_string(static_cast<long long>(*vol)) + " stop=" + std::to_string(f.stopDistance) + " entry=" + std::to_string(f.entry) +
                          " seq=" + std::to_string(f.signalSeq) + " intent=" + fire.intentId + " profile=" + f.profileHash);
    queued++;
  }
  if (queued) cv_.notify_one();
  return queued;
}

void TickFirer::loop() {
  while (running_.load()) {
    TickFire fire;
    {
      std::unique_lock<std::mutex> lk(mtx_);
      cv_.wait(lk, [this] { return !running_.load() || !queue_.empty(); });
      if (!running_.load() && queue_.empty()) return;
      if (queue_.empty()) continue;
      fire = queue_.front();
      queue_.pop_front();
    }
    fireOne(fire);
  }
}

void TickFirer::fireOne(const TickFire& fire) {
  const long long sym = static_cast<long long>(fire.payload.get("symbolId").asNumber(0));
  // The price bound was judged at the fill on the worker; this thread is
  // serial and a slow broker can hold it for tens of seconds per fire, so a
  // fire that aged past the permit's maxFireDelayMs is refused at the send
  // (RACE CHECKER 11-09-2026), not placed at a price nobody looked at.
  if (fire.maxFireDelayMs > 0) {
    const long long now = clock_ ? clock_() : static_cast<long long>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    if (now - fire.fillMs > fire.maxFireDelayMs) {
      { std::lock_guard<std::mutex> lk(mtx_); counters_.refusedStale++; }
      if (ring_) ring_->log("tick", "fire_refused", fire.accountId, sym, "fire_stale", "queued " + std::to_string(now - fire.fillMs) + " ms > " + std::to_string(fire.maxFireDelayMs) + " intent=" + fire.intentId);
      return;
    }
  }
  const EngineResult r = sendHook_ ? sendHook_(fire.payload) : engine_.placeOrder(fire.payload);
  if (r.ok) {
    { std::lock_guard<std::mutex> lk(mtx_); counters_.sent++; }
    if (ring_) ring_->log("tick", "fire_result", fire.accountId, sym, "ok", "intent=" + fire.intentId +
                          " pos=" + std::to_string(static_cast<long long>(r.body.get("position").get("positionId").asNumber(0))) +
                          " order=" + std::to_string(static_cast<long long>(r.body.get("order").get("orderId").asNumber(0))) +
                          // PR-1b (20-09-2026): the breakout fact, so the keeper's
                          // fire ledger can write a direction_reason that states what
                          // moved instead of naming the strategy back at itself.
                          " entry=" + std::to_string(fire.entry) + " stop=" + std::to_string(fire.stop) +
                          " target=" + std::to_string(fire.target) + " side=" + fire.side +
                          // PR-1b follow-up (21-09-2026): the signal reference the
                          // fill crossed, so the ledger states what moved, not just
                          // where the fill landed.
                          " ref=" + std::to_string(fire.ref));
  } else {
    { std::lock_guard<std::mutex> lk(mtx_); counters_.rejected++; }
    if (ring_) ring_->log("tick", "fire_reject", fire.accountId, sym, r.body.get("errorCode").asString(), "intent=" + fire.intentId + " " + r.body.get("description").asString());
  }
}

FireCounters TickFirer::counters() const { std::lock_guard<std::mutex> lk(mtx_); return counters_; }
size_t TickFirer::queueDepth() const { std::lock_guard<std::mutex> lk(mtx_); return queue_.size(); }

std::string TickFirer::statusJson() const {
  FireCounters c; std::set<long long> a; size_t depth;
  { std::lock_guard<std::mutex> lk(mtx_); c = counters_; a = accounts_; depth = queue_.size(); }
  jsn::Value v{jsn::Object{}};
  v.set("accounts", static_cast<double>(a.size()));
  v.set("permitsHeld", static_cast<double>(permits_.size()));
  v.set("queueDepth", static_cast<double>(depth));
  v.set("running", running_.load());
  v.set("fills", static_cast<double>(c.fills));
  v.set("queued", static_cast<double>(c.queued));
  v.set("sent", static_cast<double>(c.sent));
  v.set("rejected", static_cast<double>(c.rejected));
  v.set("refusedNoPermit", static_cast<double>(c.refusedNoPermit));
  v.set("refusedUnaffordable", static_cast<double>(c.refusedUnaffordable));
  v.set("refusedPriceBound", static_cast<double>(c.refusedPriceBound));
  v.set("refusedRecorder", static_cast<double>(c.refusedRecorder));
  v.set("refusedQueueFull", static_cast<double>(c.refusedQueueFull));
  v.set("refusedSizing", static_cast<double>(c.refusedSizing));
  v.set("refusedStopFloor", static_cast<double>(c.refusedStopFloor));
  v.set("refusedStale", static_cast<double>(c.refusedStale));
  v.set("abandoned", static_cast<double>(c.abandoned));
  v.set("places", !a.empty());
  return jsn::dump(v);
}

} // namespace tick
