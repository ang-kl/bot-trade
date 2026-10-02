// cpp-exec/src/trail_engine.hpp
//
// TrailEngine — tick-level Chandelier SL ratchet (owner option 4,
// 2026-07-24, EUSTX50 post-mortem). Division of authority:
//
//   NODE decides POLICY. The profit keeper computes armed state, ATR and
//   the trail DISTANCE (including spike tightening) every ~3s and pushes a
//   per-position spec here via POST /trail-config (full replace — Node owns
//   the set; a position absent from the push stops tick-trailing).
//
//   THIS ENGINE executes at TICK SPEED between Node passes: on every
//   SpotFeed tick it advances the peak and, when the Chandelier target
//   improves the stop by at least a minimum step, amends the broker-side
//   SL. RATCHET-ONLY by construction — a target that does not improve the
//   stop is discarded, so Node and C++ can never fight (both only
//   tighten; the worse writer's amend is a no-op).
//
// Threading: onTick() (SpotFeed read thread) only updates state under a
// mutex — it NEVER calls the broker, because ExecEngine requests hold the
// engine mutex for up to 15s and would stall the tick/heartbeat loop. A
// dedicated worker thread drains pending amends every ~200ms.
#pragma once

#include <atomic>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "json.hpp"

class ExecEngine;

struct TrailSpec {
  long long accountId = 0;   // ctidTraderAccountId (multi-account session)
  long long symbolId = 0;
  int dir = 1;               // +1 long (trail below on bid), -1 short (trail above on ask)
  double trailDist = 0;      // price units behind the peak (Node: trailMult × ATR)
  double peakPrice = 0;      // best exit-side price seen (Node seeds, ticks advance)
  double lastSl = 0;         // last known broker SL (0 = none yet)
  bool hasSl = false;
  double currentTp = 0;      // admission snapshot; never used as the amend's TP
  bool hasTp = false;
  int digits = 5;            // symbol price precision for rounding
  double pendingSl = 0;      // computed target awaiting the worker (0 = none)
  unsigned long long generation = 0; // prevents an old completion updating a new config
  long long protectionCheckedAtMs = 0;
  // 02-10-2026: the position's entry price, so the worker can tell whether the
  // stop it is about to send locks profit (trailing is only asked for then).
  double entryPrice = 0;
  bool hasEntry = false;
};

// 02-10-2026 stop-loss policy, pushed by Node with /trail-config (full
// replace). Node decides the values; this engine only stamps them onto the
// ratchet amends it builds. triggerWire is the caller's own value (number or
// name) emitted verbatim; null = none. The engine never sends
// trailingStopLoss:false - turning trailing off is Node's explicit amend.
struct StopPolicyCfg {
  jsn::Value triggerWire;
  bool trailingOnLock = false;
};

// The ratchet amend the worker sends for one pending target. Pure so the
// policy fields are unit-tested without a broker: the trigger rides on every
// amend when configured; trailingStopLoss:true only when trailingOnLock is set
// and the spec's entry price shows this stop locks profit.
// The /trail-config `stopPolicy` object: {"stopLossTriggerMethod": number|name,
// "trailing": "on_lock"|"off"}. Absent, malformed or invalid anywhere = no
// policy at all (full-replace, never half a policy).
StopPolicyCfg parseTrailStopPolicy(const jsn::Value& v);

jsn::Value buildTrailAmend(long long positionId, const TrailSpec& snap, const StopPolicyCfg& cfg);

// Pure ratchet decision, unit-tested without a feed or engine: advance the
// peak from the exit-side price and return the rounded Chandelier target
// when it improves the current stop by at least minStep (a tenth of the
// trail distance, floored at one price step) — else 0.
double trailDecide(TrailSpec& s, double bid, double ask);

class TrailEngine {
public:
  // Full replace of the tracked set (Node's push). Specs for positions
  // already tracked keep the LOCAL peak/lastSl when they are further along
  // than the pushed values — ticks may have advanced them since Node read.
  void configure(const std::vector<std::pair<long long, TrailSpec>>& specs);

  // Full replace of the stop policy (absent/invalid on the wire clears it).
  void configurePolicy(const StopPolicyCfg& cfg);

  void onTick(long long symbolId, double bid, double ask);

  // Symbols the tracked set needs from the spot feed.
  std::vector<long long> symbolIds();

  size_t tracked();
  std::string statusJson();

  // Counter facts for GET /health (2026-08-31 supervision plan) — the
  // statusJson above is a full position dump; /health wants three numbers.
  long long amendsOk() const { return amendsOk_.load(std::memory_order_relaxed); }
  long long amendsFailed() const { return amendsFailed_.load(std::memory_order_relaxed); }

  // Optional decision ring (invariant 1): a ratchet executed or refused at
  // the broker is a decision. Non-owning; null = disabled. Set before start().
  void setDecisionRing(class DecisionRing* r) { ring_ = r; }

  // Worker lifecycle. start() is idempotent; stop() joins.
  void start(ExecEngine& engine);
  void stop();

private:
  void workerLoop(ExecEngine& engine);

  std::mutex mtx_;
  std::map<long long, TrailSpec> byPosition_;
  StopPolicyCfg policy_;
  std::thread worker_;
  std::atomic<bool> running_{false};
  std::atomic<long long> amendsOk_{0};
  std::atomic<long long> amendsFailed_{0};
  std::atomic<long long> alreadyTighter_{0};
  // Specs the last configure() refused for naming no account — see configure().
  std::atomic<long long> specsDroppedNoAccount_{0};
  std::atomic<long long> specsDroppedNoTarget_{0};
  unsigned long long generation_ = 0;
  class DecisionRing* ring_ = nullptr;
};
