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
#include <mutex>
#include <map>
#include <set>
#include <string>

#include "json.hpp"

struct GuardSnapshot {
  bool halt;                 // global kill switch — reject everything
  bool requireBracket;       // reject market orders with no stop attached
  bool requireTarget;        // reject market orders with no take-profit attached
  double maxOrderVolume;     // reject orders above this volume (0 = no cap)
  // Per-ACCOUNT halts (2026-08-31 supervision plan). Node's equity stop is
  // deliberately per-account (owner 30-07: a global disarm on one account's
  // trip is the defect that module removed) — so its cpp mirror must be
  // scoped the same way, or halting one tripped account would halt every
  // healthy account sharing this sidecar. Empty = nobody halted.
  std::set<long long> haltAccounts;
  // P2a (11-09-2026): per-account ENTRY EPOCHS pushed by the keeper's guard
  // sync. An account listed here has its one-use permits REQUIRED at the send
  // boundary, and a permit from any other epoch is refused there. Absent =
  // no fence pushed for that account (an older keeper): a permit is still
  // checked when present, never demanded.
  std::map<long long, long long> entryEpochs;
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
  // Full replace (Node's guard sync derives the whole set declaratively each
  // push). A brief mutex here is a DELIBERATE deviation from the all-atomics
  // doctrine above: the set has no atomic representation, orders are a
  // handful per minute, and the lock is never held across I/O.
  void setHaltAccounts(std::set<long long> ids) {
    std::lock_guard<std::mutex> lk(haltAccountsMtx_);
    haltAccounts_ = std::move(ids);
  }
  // P2a: full replace, same declarative contract and the same short lock.
  void setEntryEpochs(std::map<long long, long long> m) {
    std::lock_guard<std::mutex> lk(haltAccountsMtx_);
    entryEpochs_ = std::move(m);
  }

  GuardSnapshot snapshot() const {
    GuardSnapshot g{ halt_.load(std::memory_order_relaxed),
                     requireBracket_.load(std::memory_order_relaxed),
                     requireTarget_.load(std::memory_order_relaxed),
                     maxOrderVolume_.load(std::memory_order_relaxed),
                     {} };
    std::lock_guard<std::mutex> lk(haltAccountsMtx_);
    g.haltAccounts = haltAccounts_;
    g.entryEpochs = entryEpochs_;
    return g;
  }

private:
  std::atomic<bool>   halt_{false};
  std::atomic<bool>   requireBracket_{true};
  std::atomic<bool>   requireTarget_{true};
  std::atomic<double> maxOrderVolume_{0.0};
  mutable std::mutex  haltAccountsMtx_;
  std::set<long long> haltAccounts_;
  std::map<long long, long long> entryEpochs_; // P2a; guarded by haltAccountsMtx_
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

// P2a (docs/tick-momentum/plan.md §9, §13; 11-09-2026): the ONE-USE PERMIT at
// the send boundary. An order for an account whose entry epoch the keeper
// has fenced must carry a permit from THAT epoch, unexpired, describing THIS
// order (account, symbol, side, volume), never seen before. `consumed` is the
// engine's bounded memory of redeemed permit ids — read and inserted here,
// under the execution mutex the engine holds at the boundary. Since P2a-2
// the VPO tier's fires carry the keeper's pre-issued permits, so there is no
// waiver: a fenced account's order without a permit is refused, whoever
// built it.
struct PermitVerdict {
  bool ok = true;
  std::string reason;   // machine code when ok == false
  std::string intentId; // the permit's intent, when one was presented
  std::string permitId; // consumed on ok; "" when no permit was presented
};
PermitVerdict validatePermit(const jsn::Value& payload, const GuardSnapshot& g,
                             std::set<std::string>& consumed, long long nowMs);

// WHOLE-PLAN AUDIT 11-09-2026 (plan §9 price bounds): a fire is allowed only
// while the executable price is within `maxDeviation` wire units of the
// price the permit was made at. Pure; the caller that knows the live quote
// (the tick fire path) applies it before the send. A non-positive reference
// or a negative bound never passes.
bool priceWithinBound(long long refPrice, long long nowPrice, long long maxDeviation);
