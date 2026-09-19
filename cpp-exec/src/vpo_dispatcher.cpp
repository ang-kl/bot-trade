// cpp-exec/src/vpo_dispatcher.cpp — see vpo_dispatcher.hpp.
//
// Race-safety notes (owner asked explicitly for an explanation of how the
// ARMED->FIRED transition avoids a double-fire):
//
//   compare_exchange_strong(expected=ARMED, desired=FIRED) is the ONLY way
//   state ever leaves ARMED on the hot path. If two ticks arrive back to
//   back (or onTick() is ever called from more than one thread), only the
//   FIRST compare_exchange_strong call can observe state == ARMED and swap
//   it to FIRED; every other caller's `expected` gets overwritten to FIRED
//   by the failed CAS and its `if` short-circuits false. So exactly one
//   caller ever proceeds to placeOrder() for a given arm cycle, even under
//   concurrent onTick() calls on the same strategy.
//
//   The background recompute thread only ever transitions IDLE<->ARMED
//   (recompute() calls disarm() or arms — see vpo_strategy.hpp), never
//   touches FIRED. So there is no write race between the two threads on
//   the FIRED transition itself: only the hot thread ever produces FIRED,
//   and only resetAfterFire() (called by THIS dispatcher, single-threaded
//   from tryFire's own call site) ever clears it back to IDLE.
#include <optional>

#include "vpo_dispatcher.hpp"

#include "decision_ring.hpp"
#include "log.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <cstdio>

namespace vpo {

double relativePoints(double priceDistance, int digits) {
  const int d = std::max(0, std::min(5, digits));
  const double step = std::pow(10.0, 5 - d);
  const double snapped = std::round((priceDistance * 100000.0) / step) * step;
  return std::max(step, snapped);
}

VpoDispatcher::VpoDispatcher(ExecEngine& engine, BarProvider barProvider, VolumeResolver volumeResolver,
                             std::string macroTimeframe, std::string microTimeframe)
    : engine_(engine),
      barProvider_(std::move(barProvider)),
      volumeResolver_(std::move(volumeResolver)),
      macroTimeframe_(std::move(macroTimeframe)),
      microTimeframe_(std::move(microTimeframe)) {}

VpoDispatcher::~VpoDispatcher() { stop(); }

void VpoDispatcher::registerStrategy(std::unique_ptr<StrategyModule> strategy) {
  // Tell the strategy which period its macro bars will cover. Only this
  // class knows, and rsi2_reversion's timeframe floor is unenforceable
  // without it.
  strategy->setMacroTimeframe(macroTimeframe_);
  strategies_.push_back(std::move(strategy));
}

void VpoDispatcher::start(int recomputeIntervalMs) {
  if (running_.exchange(true)) return; // already started
  recomputeThread_ = std::thread([this, recomputeIntervalMs] { recomputeLoop(recomputeIntervalMs); });
  fireThread_ = std::thread([this] { fireLoop(); });
}

void VpoDispatcher::stop() {
  if (!running_.exchange(false)) return;
  fireCv_.notify_all();
  if (recomputeThread_.joinable()) recomputeThread_.join();
  if (fireThread_.joinable()) fireThread_.join();
}

void VpoDispatcher::recomputeAll() {
  for (auto& s : strategies_) {
    // A pending fire owns the setup until it resolves — see vpo_types.hpp.
    if (s->order().state.load(std::memory_order_acquire) == VposState::FIRED) continue;
    const std::vector<Bar> macro = barProvider_(s->order().symbol, macroTimeframe_);
    const std::vector<Bar> micro = barProvider_(s->order().symbol, microTimeframe_);
    s->recompute(macro, micro);
  }
}

size_t VpoDispatcher::disarmAll() {
  size_t idled = 0;
  for (auto& s : strategies_) {
    VirtualPendingOrder& o = s->order();
    const VposState before = o.state.load(std::memory_order_acquire);
    if (before == VposState::FIRED) continue;   // a pending fire owns its setup until it resolves
    if (idleUnlessFired(o) && before != VposState::IDLE) idled++;
  }
  const long long nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  lastDisarmAtMs_.store(nowMs, std::memory_order_relaxed);
  if (ring_) ring_->log("vpo", "disarmed", accountId_.load(std::memory_order_relaxed), 0, "",
                        std::to_string(idled) + " strategy/ies idled by the keeper");
  return idled;
}

void VpoDispatcher::recomputeLoop(int intervalMs) {
  while (running_.load(std::memory_order_relaxed)) {
    recomputeAll();
    std::this_thread::sleep_for(std::chrono::milliseconds(intervalMs));
  }
}

bool VpoDispatcher::tryFire(StrategyModule& s, double bid, double ask) {
  VirtualPendingOrder& o = s.order();
  if (o.state.load(std::memory_order_relaxed) != VposState::ARMED) return false;

  // Setup generation (vpo_types.hpp storeBracket): odd = a recompute is
  // writing this bracket right now — not a setup, skip the tick.
  const uint64_t gen = o.generation.load(std::memory_order_acquire);
  if (gen & 1u) return false;
  const double trigger = o.triggerPrice.load(std::memory_order_relaxed);
  const Side side = o.side.load(std::memory_order_relaxed);
  // A Buy virtual order arms expecting a pullback DOWN onto the level, then
  // a bounce — it fires the instant the live ask reaches (or trades
  // through) that level, buying at market. A Sell order is the mirror:
  // fires when the live bid rises to meet the level.
  const bool touched = (side == Side::Buy) ? (ask <= trigger) : (bid >= trigger);
  if (!touched) return false;

  VposState expected = VposState::ARMED;
  if (!o.state.compare_exchange_strong(expected, VposState::FIRED, std::memory_order_acq_rel)) {
    return false; // another caller already won the race this tick
  }

  if (preFireHook_) preFireHook_(); // test seam: a recompute landing between the CAS and the snapshot
  const FireIntent intent{&s, side, o.relativeStopLoss.load(std::memory_order_relaxed),
                          o.relativeTakeProfit.load(std::memory_order_relaxed), trigger};
  if (o.generation.load(std::memory_order_acquire) != gen) {
    // The bracket changed between the trigger read and the snapshot: the
    // intent could carry one setup's trigger with another's stop. Refuse it
    // and hand the strategy back to IDLE — the next recompute arms the new
    // setup cleanly and the next touch fires that one, coherent.
    o.state.store(VposState::IDLE, std::memory_order_release);
    {
      std::lock_guard<std::mutex> lk(outcomesMtx_);
      outcomes_.staleSetup++;
      outcomes_.lastDetail = s.key() + ": setup changed under the fire — refused";
    }
    if (ring_) ring_->log("vpo", "stale_setup", 0, o.symbolId, s.key(), "bracket rewritten between the trigger read and the fire snapshot; refused, strategy idle");
    return false;
  }
  {
    std::lock_guard<std::mutex> lk(outcomesMtx_);
    outcomes_.triggered++;
  }

  // Hand the SLOW half (sizing + placeOrder + outcome record) to the fire
  // thread — audit #6: running placeOrder here, on the SpotFeed read thread,
  // stalled tick delivery, heartbeats and the trail ratchet for up to a
  // minute per fire. The CAS above already guarantees single-fire; the
  // strategy stays FIRED until fireNow() resolves it.
  //
  // Not started (unit tests drive onTick directly, no SpotFeed thread to
  // protect) → fire synchronously, same behaviour as before the queue.
  if (!running_.load(std::memory_order_relaxed)) {
    fireNow(intent);
    return true;
  }
  {
    std::lock_guard<std::mutex> lk(fireMtx_);
    fireQueue_.push_back(intent);
  }
  fireCv_.notify_one();
  return true;
}

void VpoDispatcher::fireLoop() {
  while (running_.load(std::memory_order_relaxed)) {
    std::optional<FireIntent> in;
    {
      std::unique_lock<std::mutex> lk(fireMtx_);
      fireCv_.wait_for(lk, std::chrono::milliseconds(500), [this] {
        return !fireQueue_.empty() || !running_.load(std::memory_order_relaxed);
      });
      if (!fireQueue_.empty()) {
        in = fireQueue_.front();
        fireQueue_.erase(fireQueue_.begin());
      }
    }
    if (in) fireNow(*in);
  }
}

void VpoDispatcher::fireNow(const FireIntent& in) {
  StrategyModule& s = *in.s;
  VirtualPendingOrder& o = s.order();
  const Side side = in.side;

  const double volume = volumeResolver_ ? volumeResolver_(s) : -1.0;
  if (!(volume > 0.0) || std::isnan(volume)) {
    // Sizing unavailable — refuse to fire a fabricated order. Re-arm is
    // NOT automatic here: the strategy stays FIRED until the next
    // recompute cycle re-evaluates the setup from scratch, same as a
    // rejected order would.
    //
    // This is a REFUSAL, and it used to look identical to a fill from
    // outside the process. Counting it separately is the point: a tier that
    // arms all day and never sizes is broken in a way silence hides.
    {
      std::lock_guard<std::mutex> lk(outcomesMtx_);
      outcomes_.noSizing++;
    }
    recordOutcome(s, "no_sizing", "volumeResolver returned nothing usable");
    if (ring_) ring_->log("vpo", "refused", 0, static_cast<long long>(o.symbolId),
                          "no_sizing", s.key());
    s.resetAfterFire();
    return;
  }

  // PHASE 2: this tier must be told which account to trade. The sidecar refuses
  // an unstamped order, so firing without one would place nothing at all — and
  // the previous behaviour (the engine filling in its frozen primary) is exactly
  // the silent mis-route being removed. Refuse and COUNT it, the same shape this
  // function already uses for unavailable sizing: a tier that arms all day and
  // never fires is broken in a way silence hides.
  const long long acct = accountId_.load(std::memory_order_relaxed);
  if (acct <= 0) {
    {
      std::lock_guard<std::mutex> lk(outcomesMtx_);
      outcomes_.noAccount++;
    }
    recordOutcome(s, "no_account", "no ctidTraderAccountId configured — POST /vpo-config must name one");
    if (ring_) ring_->log("vpo", "refused", 0, static_cast<long long>(o.symbolId),
                          "no_account", s.key());
    s.resetAfterFire();
    return;
  }

  jsn::Value payload{jsn::Object{}};
  payload.set("ctidTraderAccountId", acct);
  payload.set("symbolId", static_cast<long long>(o.symbolId));
  payload.set("tradeSide", side == Side::Buy ? std::string("BUY") : std::string("SELL"));
  payload.set("orderType", std::string("MARKET"));
  payload.set("volume", volume);
  payload.set("relativeStopLoss", relativePoints(in.sl, o.digits));
  payload.set("relativeTakeProfit", relativePoints(in.tp, o.digits));
  payload.set("label", std::string("vpo:") + s.key());
  // P2a-2: the keeper's pre-issued permit for this strategy and side rides
  // with the order; the engine's send boundary checks it exactly as it checks
  // a keeper-placed order's. None held → counted here, refused there when
  // the account's epoch is fenced.
  if (permitResolver_) {
    const jsn::Value permit = permitResolver_(s, side);
    if (permit.isObject()) {
      payload.set("permit", permit);
      payload.set("intentId", permit.get("intentId"));
    } else {
      std::lock_guard<std::mutex> lk(outcomesMtx_);
      outcomes_.permitMissing++;
    }
  }

  const EngineResult result = engine_.placeOrder(payload);
  if (result.ok) {
    std::lock_guard<std::mutex> lk(outcomesMtx_);
    outcomes_.placed++;
  } else {
    std::lock_guard<std::mutex> lk(outcomesMtx_);
    (result.brokerError ? outcomes_.rejected : outcomes_.failed)++;
  }
  // A broker rejection and a transport failure are different facts and are
  // recorded as such. The old code kept neither.
  recordOutcome(s, result.ok ? "placed" : (result.brokerError ? "rejected" : "failed"),
                result.ok
                    ? std::string()
                    : result.body.get("errorCode").asString() + " " +
                          result.body.get("description").asString());
  s.resetAfterFire();
}

void VpoDispatcher::recordOutcome(const StrategyModule& s, const char* verdict,
                                  const std::string& detail) {
  const long long nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
      std::chrono::system_clock::now().time_since_epoch()).count();
  std::string line = std::string(s.key()) + " " + verdict;
  if (!detail.empty()) line += ": " + detail;
  {
    std::lock_guard<std::mutex> lk(outcomesMtx_);
    outcomes_.lastFireAtMs = nowMs;
    outcomes_.lastDetail = line;
  }
  // The log too: the counters answer "what happened", the log answers "when,
  // and in what order relative to everything else the sidecar was doing".
  // A placed order is information; every other verdict (no_sizing,
  // no_account, rejected, failed) is a refusal or a failure — stderr.
  if (std::strcmp(verdict, "placed") == 0) sidecar_log::logInfo("[vpo]", line);
  else sidecar_log::logError("[vpo]", line);
}

VpoDispatcher::Outcomes VpoDispatcher::outcomes() const {
  std::lock_guard<std::mutex> lk(outcomesMtx_);
  return outcomes_;
}

std::string VpoDispatcher::statusJson() const {
  const Outcomes o = outcomes();
  jsn::Value v{jsn::Object{}};
  v.set("strategies", static_cast<double>(strategies_.size()));
  v.set("triggered", static_cast<double>(o.triggered));
  v.set("placed", static_cast<double>(o.placed));
  v.set("rejected", static_cast<double>(o.rejected));
  v.set("failed", static_cast<double>(o.failed));
  v.set("noSizing", static_cast<double>(o.noSizing));
  // Non-zero means this tier armed, triggered, and then could not fire because
  // no account is configured — visible in /vpo-status instead of only in stderr.
  v.set("noAccount", static_cast<double>(o.noAccount));
  v.set("permitMissing", static_cast<double>(o.permitMissing));
  v.set("staleSetup", static_cast<double>(o.staleSetup));
  v.set("accountId", static_cast<double>(accountId_.load(std::memory_order_relaxed)));
  const long long disarmAt = lastDisarmAtMs_.load(std::memory_order_relaxed);
  v.set("lastDisarmAt", disarmAt > 0 ? jsn::Value(static_cast<double>(disarmAt)) : jsn::Value(nullptr));
  v.set("lastFireAt", o.lastFireAtMs > 0 ? jsn::Value(static_cast<double>(o.lastFireAtMs))
                                         : jsn::Value(nullptr));
  v.set("lastDetail", o.lastDetail.empty() ? jsn::Value(nullptr) : jsn::Value(o.lastDetail));
  return jsn::dump(v);
}

void VpoDispatcher::onTick(long long symbolId, double bid, double ask) {
  for (auto& s : strategies_) {
    if (s->order().symbolId != symbolId) continue;
    tryFire(*s, bid, ask);
  }
}

} // namespace vpo
