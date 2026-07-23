// cpp-exec/src/vpo_config_store.hpp
//
// Thread-safe cache of bars-per-(symbol,timeframe) and volume-per-strategy-
// key, PUSHED IN by the Node keeper (POST /vpo-config) and read by
// VpoDispatcher's BarProvider/VolumeResolver callbacks. Node fetches the real
// trendbars and computes the real risk.js position size — nothing here
// invents either, same "no parallel sizing/indicator source of truth"
// posture as vpo_types.hpp/vpo_indicators.hpp.
//
// Entries older than `maxAgeMs` are treated as ABSENT (empty bars / negative
// volume) rather than served stale — if the Node feeder dies or the network
// path drops, the dispatcher's recompute() sees "no data" and disarms/stays
// idle, and tryFire()'s volumeResolver_ sees a negative volume and refuses
// to fire, instead of arming or firing a real order off minutes-old bars or
// a sizing figure computed against a balance that may have since changed.
#pragma once

#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "vpo_indicators.hpp" // vpo::Bar (== bt::Bar)

namespace vpo {

class VpoConfigStore {
public:
  explicit VpoConfigStore(long long maxAgeMs = 5 * 60 * 1000) : maxAgeMs_(maxAgeMs) {}

  void setBars(const std::string& symbol, const std::string& timeframe, std::vector<Bar> bars);
  // Empty when never set OR the last push is older than maxAgeMs.
  std::vector<Bar> getBars(const std::string& symbol, const std::string& timeframe) const;

  void setVolume(const std::string& strategyKey, double volume);
  // -1 when never set OR the last push is older than maxAgeMs (VolumeResolver
  // contract: <= 0 means "sizing unavailable, refuse to fire").
  double getVolume(const std::string& strategyKey) const;

private:
  struct BarEntry { std::vector<Bar> bars; long long updatedAtMs = 0; };
  struct VolEntry { double volume = -1; long long updatedAtMs = 0; };
  static long long nowMs();

  mutable std::mutex mtx_;
  std::map<std::string, BarEntry> bars_; // key: symbol + "|" + timeframe
  std::map<std::string, VolEntry> vols_; // key: strategyKey
  long long maxAgeMs_;
};

} // namespace vpo
