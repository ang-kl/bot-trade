// cpp-exec/src/vpo_config_store.cpp — see vpo_config_store.hpp.
#include "vpo_config_store.hpp"

#include <chrono>

namespace vpo {

long long VpoConfigStore::nowMs() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

void VpoConfigStore::setBars(const std::string& symbol, const std::string& timeframe,
                             std::vector<Bar> bars) {
  std::lock_guard lk(mtx_);
  bars_[symbol + "|" + timeframe] = BarEntry{std::move(bars), nowMs()};
}

std::vector<Bar> VpoConfigStore::getBars(const std::string& symbol, const std::string& timeframe) const {
  std::lock_guard lk(mtx_);
  auto it = bars_.find(symbol + "|" + timeframe);
  if (it == bars_.end()) return {};
  if (nowMs() - it->second.updatedAtMs > maxAgeMs_) return {}; // stale — treat as no data
  return it->second.bars;
}

void VpoConfigStore::setVolume(const std::string& strategyKey, double volume) {
  std::lock_guard lk(mtx_);
  vols_[strategyKey] = VolEntry{volume, nowMs()};
}

double VpoConfigStore::getVolume(const std::string& strategyKey) const {
  std::lock_guard lk(mtx_);
  auto it = vols_.find(strategyKey);
  if (it == vols_.end()) return -1;
  if (nowMs() - it->second.updatedAtMs > maxAgeMs_) return -1; // stale — refuse to size off it
  return it->second.volume;
}

} // namespace vpo
