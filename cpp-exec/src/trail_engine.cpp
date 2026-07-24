// cpp-exec/src/trail_engine.cpp — see trail_engine.hpp.
#include "trail_engine.hpp"

#include <chrono>
#include <cmath>
#include <cstdio>

#include "engine.hpp"
#include "json.hpp"

using namespace std::chrono;

namespace {
void logLine(const std::string& msg) {
  std::fprintf(stderr, "[trail] %s\n", msg.c_str());
}
double roundTo(double v, int digits) {
  const double f = std::pow(10.0, digits);
  return std::round(v * f) / f;
}
} // namespace

double trailDecide(TrailSpec& s, double bid, double ask) {
  if (!(s.trailDist > 0)) return 0;
  // Exit side: a long closes on the bid, a short on the ask.
  const double px = s.dir == 1 ? bid : ask;
  if (!(px > 0)) return 0;
  // Advance the peak (best exit price in trade direction).
  if (s.dir == 1 ? px > s.peakPrice : (s.peakPrice <= 0 || px < s.peakPrice)) s.peakPrice = px;
  if (!(s.peakPrice > 0)) return 0;
  const double target = roundTo(s.peakPrice - s.dir * s.trailDist, s.digits);
  // Minimum improvement step: a tenth of the trail distance, floored at one
  // price step — avoids amend spam on every sub-point wiggle.
  const double step = std::max(std::pow(10.0, -s.digits), s.trailDist * 0.1);
  const bool improves = !s.hasSl
      ? true
      : (s.dir == 1 ? target >= s.lastSl + step : target <= s.lastSl - step);
  if (!improves) return 0;
  // Never place the stop through the current market (broker would reject).
  if (s.dir == 1 ? target >= px : target <= px) return 0;
  return target;
}

void TrailEngine::configure(const std::vector<std::pair<long long, TrailSpec>>& specs) {
  std::lock_guard<std::mutex> lk(mtx_);
  std::map<long long, TrailSpec> next;
  for (const auto& [id, incoming] : specs) {
    TrailSpec s = incoming;
    auto it = byPosition_.find(id);
    if (it != byPosition_.end()) {
      const TrailSpec& cur = it->second;
      // Keep local progress when it is further along than Node's snapshot
      // (ticks between keeper passes may have advanced peak and stop).
      if (cur.dir == s.dir) {
        if (s.dir == 1 ? cur.peakPrice > s.peakPrice : (cur.peakPrice > 0 && (s.peakPrice <= 0 || cur.peakPrice < s.peakPrice)))
          s.peakPrice = cur.peakPrice;
        if (cur.hasSl && (!s.hasSl || (s.dir == 1 ? cur.lastSl > s.lastSl : cur.lastSl < s.lastSl))) {
          s.lastSl = cur.lastSl;
          s.hasSl = true;
        }
      }
    }
    next[id] = s;
  }
  byPosition_.swap(next);
}

void TrailEngine::onTick(long long symbolId, double bid, double ask) {
  std::lock_guard<std::mutex> lk(mtx_);
  for (auto& [id, s] : byPosition_) {
    if (s.symbolId != symbolId) continue;
    const double target = trailDecide(s, bid, ask);
    if (target != 0) s.pendingSl = target;
  }
}

std::vector<long long> TrailEngine::symbolIds() {
  std::lock_guard<std::mutex> lk(mtx_);
  std::vector<long long> out;
  for (const auto& [id, s] : byPosition_) {
    bool seen = false;
    for (long long v : out) if (v == s.symbolId) { seen = true; break; }
    if (!seen) out.push_back(s.symbolId);
  }
  return out;
}

size_t TrailEngine::tracked() {
  std::lock_guard<std::mutex> lk(mtx_);
  return byPosition_.size();
}

std::string TrailEngine::statusJson() {
  std::lock_guard<std::mutex> lk(mtx_);
  jsn::Value v{jsn::Object{}};
  v.set("tracked", static_cast<double>(byPosition_.size()));
  v.set("amendsOk", static_cast<double>(amendsOk_.load()));
  v.set("amendsFailed", static_cast<double>(amendsFailed_.load()));
  jsn::Array rows;
  for (const auto& [id, s] : byPosition_) {
    jsn::Value r{jsn::Object{}};
    r.set("positionId", id);
    r.set("symbolId", s.symbolId);
    r.set("dir", s.dir);
    r.set("peakPrice", s.peakPrice);
    r.set("lastSl", s.hasSl ? jsn::Value(s.lastSl) : jsn::Value(nullptr));
    r.set("pendingSl", s.pendingSl != 0 ? jsn::Value(s.pendingSl) : jsn::Value(nullptr));
    rows.push_back(std::move(r));
  }
  v.set("positions", jsn::Value(std::move(rows)));
  return jsn::dump(v);
}

void TrailEngine::start(ExecEngine& engine) {
  bool expected = false;
  if (!running_.compare_exchange_strong(expected, true)) return;
  worker_ = std::thread([this, &engine] { workerLoop(engine); });
}

void TrailEngine::stop() {
  running_.store(false);
  if (worker_.joinable()) worker_.join();
}

void TrailEngine::workerLoop(ExecEngine& engine) {
  while (running_.load(std::memory_order_relaxed)) {
    std::this_thread::sleep_for(milliseconds(200));
    // Snapshot ONE pending amend per pass (engine requests serialize on the
    // engine mutex anyway; spreading them keeps this thread responsive).
    long long posId = 0;
    TrailSpec snap;
    {
      std::lock_guard<std::mutex> lk(mtx_);
      for (auto& [id, s] : byPosition_) {
        if (s.pendingSl != 0) { posId = id; snap = s; break; }
      }
    }
    if (posId == 0) continue;
    jsn::Value payload{jsn::Object{}};
    payload.set("positionId", posId);
    payload.set("stopLoss", snap.pendingSl);
    if (snap.accountId > 0) payload.set("ctidTraderAccountId", snap.accountId);
    auto r = engine.amendPosition(payload);
    std::lock_guard<std::mutex> lk(mtx_);
    auto it = byPosition_.find(posId);
    if (r.ok) {
      amendsOk_.fetch_add(1);
      if (it != byPosition_.end()) {
        it->second.lastSl = snap.pendingSl;
        it->second.hasSl = true;
        // Clear only if no newer target arrived while we were amending.
        if (it->second.pendingSl == snap.pendingSl) it->second.pendingSl = 0;
      }
      logLine("SL ratcheted pos=" + std::to_string(posId) + " -> " + std::to_string(snap.pendingSl));
    } else {
      amendsFailed_.fetch_add(1);
      // Drop the pending target — the next tick recomputes from live state,
      // so a broker rejection (stop too close, position gone) cannot loop.
      if (it != byPosition_.end() && it->second.pendingSl == snap.pendingSl) it->second.pendingSl = 0;
      logLine("SL amend FAILED pos=" + std::to_string(posId) + ": " +
              r.body.get("errorCode").asString() + " " + r.body.get("description").asString());
    }
  }
}
