// cpp-exec/src/vpo_dispatcher.hpp
//
// VpoDispatcher — the "Dual-Tier Thread Safety" piece the owner asked for
// (2026-07-22): a background thread periodically recomputes each
// registered strategy's indicator math and arms/disarms it; a hot
// dispatcher loop, driven by every incoming tick, iterates ARMED
// strategies and fires a market order the instant the live price crosses
// the strategy's atomic trigger. The two threads never share a lock on the
// hot path — recompute() only WRITES a strategy's atomics, onTick() only
// READS triggerPrice/side and CAS-transitions state; see the .cpp for why
// that ordering rules out a torn read or a double-fire.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "engine.hpp"
#include "vpo_strategy.hpp"

namespace vpo {

// Mirrors agent/lib/lot-sizing.js's relativePoints(priceDistance, digits) —
// cTrader's relativeStopLoss/relativeTakeProfit wire fields are NOT a flat
// ×100000 of the price distance; they're additionally snapped to a step
// derived from the symbol's own decimal precision. Exposed (not file-local)
// so it's independently unit-testable, same as vpo_indicators.hpp's math.
double relativePoints(double priceDistance, int digits);

// Supplies bars to the background recompute thread. Returning an empty
// vector is treated as "no data yet" (recompute() will disarm on too-few-
// bars, same as every strategy already does).
using BarProvider = std::function<std::vector<Bar>(const std::string& symbol, const std::string& timeframe)>;

// Resolves position size for a strategy about to fire. Deliberately NOT
// implemented in this engine (see vpo_types.hpp) — this repo's real sizing
// logic (Kelly scaling, margin-headroom veto) lives in agent/services/
// risk.js. Returning <= 0 or NaN means "sizing unavailable" and the
// dispatcher REFUSES to fire rather than sending a fabricated volume —
// wire this to whatever calls back into the Node agent for a real number
// before this engine ever runs against a live account.
using VolumeResolver = std::function<double(const StrategyModule&)>;

class VpoDispatcher {
public:
  // `microTimeframe`/`macroTimeframe` are the labels passed to barProvider —
  // initial scope is one pair (owner: "15m up to 4h"), e.g. "4h"/"15m".
  VpoDispatcher(ExecEngine& engine, BarProvider barProvider, VolumeResolver volumeResolver,
                std::string macroTimeframe, std::string microTimeframe);
  ~VpoDispatcher();

  // Registers a strategy under management. Not safe to call once run()
  // has started (registration is a one-time setup step, not a hot-path
  // operation).
  void registerStrategy(std::unique_ptr<StrategyModule> strategy);

  // Starts the background recompute thread. recomputeIntervalMs gates how
  // often the (comparatively expensive) VWAP/VP math re-runs — the hot
  // tick path in onTick() is unaffected by this interval.
  void start(int recomputeIntervalMs = 5000);
  void stop();

  // THE hot path — call this from the tick-ingestion callback for every
  // live quote. Iterates only the strategies armed for this symbolId;
  // O(registered strategies for that symbol), no allocation, no locking.
  void onTick(long long symbolId, double bid, double ask);

  size_t strategyCount() const { return strategies_.size(); }

  // What this tier actually did. Audit F-L4-04: tryFire used to discard the
  // EngineResult entirely — `(void)result` — so a fill, a broker rejection
  // and a transport error were one indistinguishable non-event, and the only
  // way Node ever learned of a fill was a later reconcile adopting it.
  //
  // These are the counts behind GET /vpo-status. They are deliberately
  // outcome counts rather than a log scrape: an operator asking "has the C++
  // tier traded today, and did anything get rejected?" should not have to
  // read stderr to find out.
  struct Outcomes {
    uint64_t triggered = 0;   // trigger crossed and this caller won the CAS
    uint64_t placed = 0;      // broker accepted the order
    uint64_t rejected = 0;    // broker answered with an error frame
    uint64_t failed = 0;      // transport/guard failure, no broker verdict
    uint64_t noSizing = 0;    // refused: volumeResolver gave nothing usable
    long long lastFireAtMs = 0;
    std::string lastDetail;   // key + verdict of the most recent attempt
  };
  Outcomes outcomes() const;
  std::string statusJson() const;

private:
  void recomputeLoop(int intervalMs);
  // Attempts to fire one ARMED strategy whose trigger the tick crossed.
  // Returns true if a fire was attempted (successful or not) this call.
  bool tryFire(StrategyModule& s, double bid, double ask);

  ExecEngine& engine_;
  BarProvider barProvider_;
  VolumeResolver volumeResolver_;
  std::string macroTimeframe_;
  std::string microTimeframe_;

  std::vector<std::unique_ptr<StrategyModule>> strategies_;
  std::thread recomputeThread_;
  std::atomic<bool> running_{false};

  // Written on the tick thread, read by the HTTP thread. A short mutex, not
  // atomics: lastDetail is a string, and the whole block should be read as
  // one consistent snapshot rather than a torn mix of two attempts.
  mutable std::mutex outcomesMtx_;
  Outcomes outcomes_;
  void recordOutcome(const StrategyModule& s, const char* verdict, const std::string& detail);
};

} // namespace vpo
