// cpp-exec/src/tick_firer.cpp — see tick_firer.hpp.
#include "tick_firer.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>

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

std::optional<jsn::Value> TickPermitStore::takeIf(long long accountId, long long symbolId, const std::string& side, long long nowMs,
                                                   const std::function<bool(const jsn::Value&)>& accept) {
  std::lock_guard<std::mutex> lk(mtx_);
  auto it = permits_.find(key(accountId, symbolId, side));
  if (it == permits_.end()) return std::nullopt;
  const double exp = it->second.get("expiresAtMs").asNumber(0);
  if (exp <= 0 || static_cast<long long>(exp) < nowMs) { permits_.erase(it); return std::nullopt; } // expired: gone either way
  if (!accept(it->second)) return std::nullopt;   // refused by the caller's checks: the permit stays
  jsn::Value p = std::move(it->second);
  permits_.erase(it);
  return p;
}

void TickPermitStore::replaceAccounts(const std::set<long long>& accounts, std::vector<Entry> entries) {
  std::lock_guard<std::mutex> lk(mtx_);
  for (auto it = permits_.begin(); it != permits_.end();) {
    const long long acct = std::strtoll(it->first.c_str(), nullptr, 10);
    if (accounts.count(acct)) it = permits_.erase(it); else ++it;
  }
  for (auto& e : entries) permits_[key(e.accountId, e.symbolId, e.side)] = std::move(e.permit);
}

bool TickPermitStore::has(long long accountId, long long symbolId, const std::string& side, long long nowMs) {
  std::lock_guard<std::mutex> lk(mtx_);
  auto it = permits_.find(key(accountId, symbolId, side));
  if (it == permits_.end()) return false;
  const double exp = it->second.get("expiresAtMs").asNumber(0);
  if (exp <= 0 || static_cast<long long>(exp) < nowMs) { permits_.erase(it); return false; } // expired: gone either way
  return true;
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

void TickFirer::setBootId(std::string bootId) { std::lock_guard<std::mutex> lk(mtx_); bootId_ = std::move(bootId); }
std::string TickFirer::bootId() const { std::lock_guard<std::mutex> lk(mtx_); return bootId_; }

void TickFirer::setSlots(const std::map<long long, SlotPush>& pushed) {
  std::lock_guard<std::mutex> lk(mtx_);
  slots_.clear();
  for (const auto& [acct, sp] : pushed) {
    const long long made = static_cast<long long>(fires_.count(acct) ? fires_.at(acct) : 0);
    // Node's firesSeen is a count of THIS boot's fire rows; a push naming
    // another boot (or none) acknowledges nothing, so every fire this boot
    // made is still subtracted.
    const long long seen = (!sp.bootId.empty() && sp.bootId == bootId_) ? std::max(0LL, sp.firesSeen) : 0;
    const long long unacked = std::max(0LL, made - seen);
    slots_[acct] = std::max(0LL, std::max(0LL, sp.slots) - unacked);
  }
  ++slotGen_;
}

std::map<long long, long long> TickFirer::slots() const { std::lock_guard<std::mutex> lk(mtx_); return slots_; }

void TickFirer::noteEntry(long long accountId, const std::string& label) {
  if (label.rfind("tick:", 0) == 0) return;
  std::lock_guard<std::mutex> lk(mtx_);
  counters_.entriesNoted++;
  auto it = slots_.find(accountId);
  if (it != slots_.end() && it->second > 0) --it->second;
}

bool TickFirer::reserveSlot(long long acct, bool& limited, uint64_t& gen) {
  std::lock_guard<std::mutex> lk(mtx_);
  gen = slotGen_;
  auto it = slots_.find(acct);
  limited = it != slots_.end();
  if (!limited) return true;              // no figure for the account: unlimited (pre-GW-1 behaviour)
  if (it->second <= 0) return false;
  --it->second;                           // check and spend in ONE critical section: two workers cannot both take the last slot
  return true;
}

void TickFirer::refundSlot(long long acct, bool limited, uint64_t gen) {
  if (!limited) return;
  std::lock_guard<std::mutex> lk(mtx_);
  // A push since the reservation replaced the figure, and that figure
  // already accounts for this fire: giving the slot back would count it twice.
  if (gen != slotGen_) return;
  auto it = slots_.find(acct);
  if (it == slots_.end()) return;
  ++it->second;
  counters_.slotsRefunded++;
}

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
  for (const auto& d : dropped) refundSlot(d.accountId, d.slotLimited, d.slotGen);
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
  std::string boot;
  { std::lock_guard<std::mutex> lk(mtx_); counters_.fills++; accounts = accounts_; boot = bootId_; }
  if (accounts.empty()) return 0;
  // TM-40, asked ONCE per fill (the recorder's status copies its per-symbol
  // map): no permit is spent while the recorder is not RECORDING.
  const bool recording = !recordingOk_ || recordingOk_();
  const long long ref = f.side == "BUY" ? f.signalAsk : f.signalBid;
  int queued = 0;
  for (long long acct : accounts) {
    auto refuse = [&](const char* kind, const std::string& why, uint64_t FireCounters::*ctr) {
      { std::lock_guard<std::mutex> lk(mtx_); (counters_.*ctr)++; }
      if (ring_) ring_->log("tick", "fire_refused", acct, f.symbolId, kind, f.side + " " + why + " seq=" + std::to_string(f.signalSeq) + " profile=" + f.profileHash);
    };
    if (!recording) { refuse("recorder_not_recording", "the recorder is not RECORDING — new tick entries pause (TM-40)", &FireCounters::refusedRecorder); continue; }
    // GW-1 (gap 1): the account's slot is reserved BEFORE the permit is
    // looked at, and the reservation is one critical section with the check,
    // so two workers filling for one account cannot both take its last slot.
    // A refusal here leaves the permit untouched.
    bool limited = false;
    uint64_t gen = 0;
    // A fill with no permit at all is refused 'no_permit' whatever the
    // slots say (checker nit: it used to read 'account_cap' at 0 slots).
    // A peek only — the permit is still spent inside takeIf, after the slot.
    if (!permits_.has(acct, f.symbolId, f.side, nowMs)) {
      refuse("no_permit", "no keeper permit held for this account/symbol/side", &FireCounters::refusedNoPermit);
      continue;
    }
    if (!reserveSlot(acct, limited, gen)) {
      refuse("account_cap", "no position slot left for this account until the keeper's next push (maxOpenPositions, counted per fire)", &FireCounters::refusedAccountCap);
      continue;
    }
    // GW-1 (gap 3): every check runs INSIDE takeIf, and the permit is spent
    // only when all of them pass. The predicate is pure — it reads the fill,
    // the permit and the boot copied above, and takes no lock (it runs under
    // the store's lock; statusJson takes mtx_ and then the store's lock).
    const char* kind = nullptr;
    std::string why;
    uint64_t FireCounters::*ctr = nullptr;
    double volume = 0;
    auto accept = [&](const jsn::Value& permit) -> bool {
      // Gap 5: a permit issued for another parameter profile is not this
      // strategy's to spend. A permit with no hash (an older keeper) is not checked.
      const std::string ph = permit.get("profileHash").asString();
      if (!ph.empty() && ph != f.profileHash) {
        kind = "profile_mismatch"; why = "the permit names profile " + ph + ", this strategy runs " + f.profileHash; ctr = &FireCounters::refusedProfile;
        return false;
      }
      // Gap 6: a permit pushed to another boot of this gateway (a probe read
      // the old boot, the push landed on the new one) is refused; the fresh
      // engine's empty consumed-permit set could not tell it was already spent.
      const std::string pb = permit.get("bootId").asString();
      if (!pb.empty() && pb != boot) {
        kind = "permit_other_boot"; why = "the permit was pushed to boot " + pb + ", this gateway is boot " + boot; ctr = &FireCounters::refusedBoot;
        return false;
      }
      const double frac = permit.get("overshootFraction").asNumber(0.25);
      const long long maxDev = static_cast<long long>(std::floor(frac * static_cast<double>(f.stopDistance)));
      if (!priceWithinBound(ref, f.entry, maxDev)) {
        kind = "price_bound"; why = "fill " + std::to_string(f.entry) + " is more than " + std::to_string(maxDev) + " from the signal's " + std::to_string(ref); ctr = &FireCounters::refusedPriceBound;
        return false;
      }
      // The account's policy floor on the stop (plan §3: the greatest of the
      // volatility distance, the broker's minimum and the policy floor): a
      // stop below minStopFraction × entry would let the R budget buy a lot
      // the account cannot carry — refused, never resized.
      const double minStopFrac = permit.get("minStopFraction").asNumber(0);
      const long long floorDist = minStopFrac > 0 ? static_cast<long long>(std::llround(minStopFrac * static_cast<double>(f.entry))) : 0;
      if (f.stopDistance < floorDist) {
        kind = "stop_below_floor"; why = "stop " + std::to_string(f.stopDistance) + " is below the policy floor " + std::to_string(floorDist) + " (" + std::to_string(minStopFrac) + " of the entry)"; ctr = &FireCounters::refusedStopFloor;
        return false;
      }
      std::string sizeWhy;
      auto vol = sizeVolume(permit, f.stopDistance, &sizeWhy);
      if (!vol) {
        const bool unaffordable = sizeWhy.rfind("unaffordable_lot", 0) == 0;
        kind = unaffordable ? "unaffordable_lot" : "sizing"; why = sizeWhy; ctr = unaffordable ? &FireCounters::refusedUnaffordable : &FireCounters::refusedSizing;
        return false;
      }
      volume = *vol;
      return true;
    };
    auto permit = permits_.takeIf(acct, f.symbolId, f.side, nowMs, accept);
    if (!permit) {
      refundSlot(acct, limited, gen);
      if (kind) refuse(kind, why, ctr);
      else refuse("no_permit", "no keeper permit held for this account/symbol/side", &FireCounters::refusedNoPermit);
      continue;
    }
    TickFire fire;
    fire.accountId = acct;
    fire.payload = buildPayload(acct, f, volume, *permit);
    fire.intentId = permit->get("intentId").asString();
    fire.fillMs = nowMs;
    fire.entry = f.entry; fire.stop = f.stop; fire.target = f.target; fire.side = f.side;
    fire.ref = ref;
    fire.maxFireDelayMs = static_cast<long long>(permit->get("maxFireDelayMs").asNumber(0));
    fire.slotLimited = limited; fire.slotGen = gen;
    bool full = false;
    {
      std::lock_guard<std::mutex> lk(mtx_);
      if (queue_.size() >= kMaxQueue) full = true;
      else { queue_.push_back(fire); counters_.queued++; fires_[acct]++; }
    }
    // A full queue consumed the permit (as before GW-1) but gives the slot back.
    if (full) { refundSlot(acct, limited, gen); refuse("queue_full", "the fire queue is full (" + std::to_string(kMaxQueue) + ")", &FireCounters::refusedQueueFull); continue; }
    if (ring_) ring_->log("tick", "fire", acct, f.symbolId, f.side,
                          "vol=" + std::to_string(static_cast<long long>(volume)) + " stop=" + std::to_string(f.stopDistance) + " entry=" + std::to_string(f.entry) +
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
      refundSlot(fire.accountId, fire.slotLimited, fire.slotGen); // never sent: the slot is free again
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
    // A definite reject frees the slot. TIMEOUT and DISCONNECTED are NOT
    // definite — the order may have reached the broker (engine.cpp
    // failAllPending on a dropped session; "a timeout is not proof that the
    // order failed") — so those keep the slot until the keeper's count says
    // otherwise.
    if (!isAmbiguousReject(r.body.get("errorCode").asString())) refundSlot(fire.accountId, fire.slotLimited, fire.slotGen);
    if (ring_) ring_->log("tick", "fire_reject", fire.accountId, sym, r.body.get("errorCode").asString(), "intent=" + fire.intentId + " " + r.body.get("description").asString());
  }
}

bool TickFirer::isAmbiguousReject(const std::string& code) { return code == "TIMEOUT" || code == "DISCONNECTED"; }

jsn::Value TickFirer::healthEntry(const jsn::Value& st, bool trusted) {
  jsn::Value e{jsn::Object{}};
  for (const char* k : {"places", "accounts", "permitsHeld", "sent", "rejected", "refusedAccountCap", "refusedProfile", "refusedBoot"})
    e.set(k, st.get(k));
  const jsn::Value& slots = st.get("slots");
  e.set("slotAccounts", static_cast<double>(slots.isObject() ? slots.asObject().size() : 0));
  if (trusted) e.set("slots", slots);
  return e;
}

FireCounters TickFirer::counters() const { std::lock_guard<std::mutex> lk(mtx_); return counters_; }
size_t TickFirer::queueDepth() const { std::lock_guard<std::mutex> lk(mtx_); return queue_.size(); }

std::string TickFirer::statusJson() const {
  FireCounters c; std::set<long long> a; size_t depth; std::map<long long, long long> sl; std::string boot;
  { std::lock_guard<std::mutex> lk(mtx_); c = counters_; a = accounts_; depth = queue_.size(); sl = slots_; boot = bootId_; }
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
  // GW-1 (WP-D D3): the per-fire cap, the profile and boot refusals, and the
  // slots left per account (absent = unlimited; an empty object = the keeper
  // has pushed no tickSlots, the pre-GW-1 behaviour).
  v.set("refusedAccountCap", static_cast<double>(c.refusedAccountCap));
  v.set("refusedProfile", static_cast<double>(c.refusedProfile));
  v.set("refusedBoot", static_cast<double>(c.refusedBoot));
  v.set("slotsRefunded", static_cast<double>(c.slotsRefunded));
  v.set("entriesNoted", static_cast<double>(c.entriesNoted));
  jsn::Value so{jsn::Object{}};
  for (const auto& [acct, n] : sl) so.set(std::to_string(acct), static_cast<double>(n));
  v.set("slots", std::move(so));
  v.set("bootId", boot);
  v.set("places", !a.empty());
  return jsn::dump(v);
}

} // namespace tick
