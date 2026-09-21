// cpp-exec/src/tick_firer.hpp — P6b: the tick entry path
// (docs/tick-momentum/plan.md §3, §9, §13; register TM-09, TM-10, TM-11,
// TM-40; the 11-09-2026 whole-plan audit's tick gaps).
//
// The shadow book's FILL is the moment a real order is placed for every
// account the keeper has put in TICK_MOMENTUM on this executor — with the
// keeper's pre-issued one-use permit for that account, symbol and side,
// sized HERE from the permit's own risk figures (the account's R in dollars
// and the symbol's dollar value per lot per price unit) at the signal's
// actual stop distance — never a cached minimum-stop volume — and refused
// when:
//   - no permit is held for that account/symbol/side (the keeper's authority
//     is the only source of one; the boundary would refuse anyway);
//   - the lot the R budget buys is below the symbol's minimum (an
//     unaffordable lot is refused, never rounded up);
//   - the fill price has moved past the overshoot bound from the price the
//     signal was made at (plan §9 price bounds);
//   - the recorder is not RECORDING (TM-40: a recording gap pauses new tick
//     entries; exits are another owner's and keep running);
//   - the fire queue is full (bounded; a refusal is counted, never a stall).
//
// The worker never blocks on the broker: fires are queued to one fire
// thread that calls the engine (placeOrder, the same send boundary as every
// other order — guard recheck, permit check, one-use). Every decision is
// rung. Nothing here reads a bar, a strategy pin or an account balance.
#pragma once
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>

#include "decision_ring.hpp"
#include "engine.hpp"
#include "json.hpp"
#include "tick_shadow.hpp"

namespace tick {

// One-use permits pushed by the keeper (/config tickPermits), keyed by
// account, symbol id and side. `take` is the single use: the permit leaves
// the store when the fire is built, so a second fill cannot reuse it.
class TickPermitStore {
public:
  void set(long long accountId, long long symbolId, const std::string& side, jsn::Value permit);
  std::optional<jsn::Value> take(long long accountId, long long symbolId, const std::string& side, long long nowMs);
  size_t size() const;
  void clearAccount(long long accountId);
  void clear();
private:
  static std::string key(long long a, long long s, const std::string& side);
  mutable std::mutex mtx_;
  std::map<std::string, jsn::Value> permits_;
};

struct FireCounters {
  uint64_t fills = 0;            // fills seen by the firer
  uint64_t queued = 0;
  uint64_t sent = 0;             // placeOrder returned ok
  uint64_t rejected = 0;         // placeOrder refused or the broker rejected
  uint64_t refusedNoPermit = 0, refusedUnaffordable = 0, refusedPriceBound = 0, refusedRecorder = 0, refusedQueueFull = 0, refusedSizing = 0;
  uint64_t refusedStopFloor = 0;   // stop distance below the permit's minStopFraction × entry
  uint64_t refusedStale = 0;       // queued longer than the permit's maxFireDelayMs at the send
  uint64_t abandoned = 0;          // queued fires dropped by stop()
};

struct TickFire {
  long long accountId = 0;
  jsn::Value payload;
  std::string intentId;
  long long fillMs = 0;          // the fill's clock (feed receive time)
  long long maxFireDelayMs = 0;  // from the permit; 0 = no bound
  // PR-1b (20-09-2026): the breakout fact the ShadowFill holds, carried to
  // the fire thread so the `fire_result` ring line can state WHAT MOVED.
  // Node has no other copy: signal→order is in-process here, no risk_events
  // row is written, and `position_history` REQUIRES `direction_reason` — a
  // tick close died with `missing: direction_reason` on ...0949. The payload
  // carries only RELATIVE stop/target distances, so the absolute prices are
  // kept here rather than re-derived.
  long long entry = 0, stop = 0, target = 0;
  std::string side;              // BUY | SELL, the fill's own side
};

class TickFirer {
public:
  TickFirer(ExecEngine& engine, TickPermitStore& permits);
  ~TickFirer();
  void setDecisionRing(DecisionRing* ring) { ring_ = ring; }
  // The accounts in TICK_MOMENTUM on this executor (keeper's /config push, full replace).
  void setAccounts(std::set<long long> accounts);
  std::set<long long> accounts() const;
  // TM-40: a predicate the firer asks before every fire; false refuses.
  void setRecordingCheck(std::function<bool()> ok) { recordingOk_ = std::move(ok); }
  // Tests: replace the engine call.
  void setSendHookForTests(std::function<EngineResult(const jsn::Value&)> h) { sendHook_ = std::move(h); }
  void start();
  // Stops the fire thread. Fires still queued are ABANDONED (counted and
  // rung), never sent after the stop — a shutdown must not place.
  void stop();
  // Tests: the clock the send-time age check reads.
  void setClockForTests(std::function<long long()> c) { clock_ = std::move(c); }
  // The book's fill on a worker thread: one fire per entry account with a
  // permit. Returns how many were queued.
  int onFill(const ShadowFill& f, long long nowMs);
  FireCounters counters() const;
  size_t queueDepth() const;
  std::string statusJson() const;

  // Pure sizing: lots = usdRisk / (stopDistance × usdPerLotPerUnit), floored
  // to the lot step, capped at maxLots, refused below minLots; returns the
  // broker volume (lots × volumePerLot). `why` names the refusal.
  static std::optional<double> sizeVolume(const jsn::Value& permit, long long stopDistance, std::string* why);
  static jsn::Value buildPayload(long long accountId, const ShadowFill& f, double volume, const jsn::Value& permit);
  // The order label: "tick:<profile>" plus the intent tag in the label's 8th
  // '|' field (agent/lib/trade-labels.js labelIntentId), so a position the
  // ring never settled is still reconciled from the broker's snapshot.
  static std::string labelFor(const ShadowFill& f, const std::string& intentId);

private:
  void loop();
  void fireOne(const TickFire& fire);
  ExecEngine& engine_;
  TickPermitStore& permits_;
  DecisionRing* ring_ = nullptr;
  std::function<bool()> recordingOk_;
  std::function<EngineResult(const jsn::Value&)> sendHook_;
  std::function<long long()> clock_;
  mutable std::mutex mtx_;
  std::set<long long> accounts_;
  std::deque<TickFire> queue_;
  FireCounters counters_;
  std::condition_variable cv_;
  std::thread thread_;
  std::atomic<bool> running_{false};
  static constexpr size_t kMaxQueue = 64;
};

} // namespace tick
