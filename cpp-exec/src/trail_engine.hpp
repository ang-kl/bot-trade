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

class ExecEngine;

struct TrailSpec {
  long long accountId = 0;   // ctidTraderAccountId (multi-account session)
  long long symbolId = 0;
  int dir = 1;               // +1 long (trail below on bid), -1 short (trail above on ask)
  double trailDist = 0;      // price units behind the peak (Node: trailMult × ATR)
  double peakPrice = 0;      // best exit-side price seen (Node seeds, ticks advance)
  double lastSl = 0;         // last known broker SL (0 = none yet)
  bool hasSl = false;
  int digits = 5;            // symbol price precision for rounding
  double pendingSl = 0;      // computed target awaiting the worker (0 = none)
};

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

  void onTick(long long symbolId, double bid, double ask);

  // Symbols the tracked set needs from the spot feed.
  std::vector<long long> symbolIds();

  size_t tracked();
  std::string statusJson();

  // Worker lifecycle. start() is idempotent; stop() joins.
  void start(ExecEngine& engine);
  void stop();

private:
  void workerLoop(ExecEngine& engine);

  std::mutex mtx_;
  std::map<long long, TrailSpec> byPosition_;
  std::thread worker_;
  std::atomic<bool> running_{false};
  std::atomic<long long> amendsOk_{0};
  std::atomic<long long> amendsFailed_{0};
};
