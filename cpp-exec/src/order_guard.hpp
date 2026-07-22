// cpp-exec/src/order_guard.hpp
//
// OrderGuard: the atomic hot-reconfig parameter block (item #3) plus the
// bracket-guarantee validator (item #4).
//
// #3 — Every knob is a std::atomic, read lock-free on the order hot path and
//   settable from the HTTP thread WITHOUT pausing execution. No mutex, no
//   torn reads: each field is independently atomic and the validate() path
//   only ever loads them.
//
// #4 — validateOrder() is the last line of defence before a market order
//   leaves this process: it REFUSES a naked order (no relativeStopLoss/
//   stopLoss attached) so a bug in the Node strategy tier can never leave a
//   position without a broker-side stop. It also enforces the atomic block:
//   a global halt (kill switch) and a max single-order volume cap. Pure
//   function over the JSON payload + a guard snapshot, so it's unit-tested
//   without a live engine or socket.
#pragma once

#include <atomic>
#include <string>

#include "json.hpp"

struct GuardSnapshot {
  bool halt;                 // global kill switch — reject everything
  bool requireBracket;       // reject market orders with no stop attached
  bool requireTarget;        // reject market orders with no take-profit attached
  double maxOrderVolume;     // reject orders above this volume (0 = no cap)
};

class OrderGuard {
public:
  // Defaults: bracket + target REQUIRED (capital preservation on by default,
  // owner-approved 2026-07-22: an SL-only position isn't "managed"), not
  // halted, no volume cap until the strategy sets one.
  void setHalt(bool v) { halt_.store(v, std::memory_order_relaxed); }
  void setRequireBracket(bool v) { requireBracket_.store(v, std::memory_order_relaxed); }
  void setRequireTarget(bool v) { requireTarget_.store(v, std::memory_order_relaxed); }
  void setMaxOrderVolume(double v) { maxOrderVolume_.store(v, std::memory_order_relaxed); }

  GuardSnapshot snapshot() const {
    return { halt_.load(std::memory_order_relaxed),
             requireBracket_.load(std::memory_order_relaxed),
             requireTarget_.load(std::memory_order_relaxed),
             maxOrderVolume_.load(std::memory_order_relaxed) };
  }

private:
  std::atomic<bool>   halt_{false};
  std::atomic<bool>   requireBracket_{true};
  std::atomic<bool>   requireTarget_{true};
  std::atomic<double> maxOrderVolume_{0.0};
};

struct OrderVerdict {
  bool ok = true;
  std::string reason; // machine code when ok == false (Node matches substrings)
};

// A market order carries a bracket when it has relativeStopLoss/relativeTakeProfit
// (the app's normal path) OR an absolute stopLoss. LIMIT/STOP pending orders
// are exempt from the bracket rule here — they carry their SL as a resting
// distance and are validated on the pending path.
bool orderHasBracket(const jsn::Value& payload);

// A market order carries a target when it has relativeTakeProfit or an
// absolute takeProfit. Same LIMIT/STOP exemption as orderHasBracket.
bool orderHasTarget(const jsn::Value& payload);

// The pure guard. Pass the payload and a GuardSnapshot; get a verdict.
OrderVerdict validateOrder(const jsn::Value& payload, const GuardSnapshot& g);
