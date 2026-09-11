// cpp-exec/src/tick_strategy.hpp — P4: tick_momentum_breakout v1, the
// live implementation (docs/tick-momentum/plan.md §4-§6; register TM-01,
// TM-03, TM-04). Pure: one instance per symbol, fed accepted quotes in
// order by the symbol's worker, returning at most one signal per event and
// never touching a socket, a clock beyond the receive stamp, a candle or
// the LLM. Its reference is agent/lib/tick-strategy.js — the two must
// agree signal for signal on the checked-in fixtures
// (src/tests/fixtures/tick_momentum_*.json), which test_tick_strategy.cpp
// enforces.
//
// Units: wire integers; the midpoint is TWICE-mid (bid + ask) so half
// increments stay integers; ranges, D, V and B are in twice-mid units; the
// stop distance is in price units. Rounding: floor(x + 0.5), the reference's
// Math.round.
//
// Incremental (plan §5 "without rescanning every history buffer"): the
// prior-N range by monotonic deques, the prior-N volatility by a running
// sum of squared differences, the momentum window by a ring of the last M
// mids and a running sum of |dm|, the spread median by a two-multiset
// median. Every window excludes the candidate event.
#pragma once

#include <cstdint>
#include <deque>
#include <optional>
#include <set>
#include <string>
#include <vector>

namespace tick {

struct StrategyParams {
  int rangeEvents = 256;         // N
  int momentumEvents = 64;       // M
  double minEfficiency = 0.4;
  double spreadBufferMult = 0.5;
  int confirmations = 2;
  double stopVolMult = 2.0;
  long long minStopPrice = 1;
  long long priceIncrement = 1;
  long long maxSpread = 1000000;
  long long maxQuoteAgeMs = 60000;
  int expiryEvents = 256;
  int rearmCooldownEvents = 64;
  // Same canonical hash as the reference (sha256 of the canonical JSON, 16 hex).
  std::string profileHash() const;
  std::string canonicalJson() const;
};

struct StrategyQuote {
  uint32_t seq = 0;
  uint64_t recvMs = 0;
  bool hasBid = false, hasAsk = false;
  long long bid = 0, ask = 0;
  bool snapshot = false, crossed = false, changed = true;
};

struct TickSignal {
  std::string side;      // BUY | SELL
  uint32_t seq = 0;
  uint64_t recvMs = 0;
  long long trigger2 = 0;
  long long bid = 0, ask = 0;
  long long stopDistance = 0;
  long long spread = 0;
  double V = 0, E = 0;
  long long D = 0, H = 0, L = 0, B = 0;
  int setupId = 0;
  int confirmations = 0;
};

enum class SetupState { WARMING, ARMED, CONFIRMING, SIGNALLED, EXPIRED };
const char* setupStateName(SetupState s);

class TickMomentumStrategy {
public:
  explicit TickMomentumStrategy(StrategyParams p);
  std::optional<TickSignal> onQuote(const StrategyQuote& q);
  SetupState state() const { return state_; }
  const StrategyParams& params() const { return p_; }
  const std::string& profileHash() const { return hash_; }
  struct Rejected { uint64_t invalid = 0, spread = 0, stale = 0, repeat = 0; };
  const Rejected& rejected() const { return rejected_; }
  uint64_t accepted() const { return accepted_; }

private:
  struct Setup {
    long long H = 0, L = 0, bidHigh = 0, bidLow = 0, askHigh = 0, askLow = 0, B = 0;
    uint64_t armedAt = 0;
    int id = 0, confirmed = 0;
    std::string dir;
  };
  void invalidate();
  void pushAccepted(long long mid2, long long bid, long long ask, long long spread);
  long long medianSpread() const;

  StrategyParams p_;
  std::string hash_;
  // Prior accepted events, oldest first (bounded to N + M + 2).
  std::deque<long long> mids_, bids_, asks_, spreads_;
  // Running windows over the prior N diffs / prior N spreads.
  std::deque<long long> diffsN_;      // last N diffs of mids_
  double sumSqN_ = 0;                  // Σ dm² over diffsN_
  std::multiset<long long> lo_, hi_;   // spread median: lo_ holds the smaller half
  uint64_t accepted_ = 0;
  bool haveLast_ = false;
  uint64_t lastRecvMs_ = 0;
  SetupState state_ = SetupState::WARMING;
  std::optional<Setup> setup_;
  int setupSeq_ = 0;
  uint64_t signalledAt_ = 0, expiredAt_ = 0;
  Rejected rejected_;
};

} // namespace tick
