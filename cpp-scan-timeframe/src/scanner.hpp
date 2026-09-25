#pragma once
#include "scanner_contract.hpp"
#include "backtest.hpp"
#include <condition_variable>
#include <functional>
#include <thread>
namespace scan {
inline std::string fibProfileHash() { return hash("fib_618_fade;closed;FX_DEFAULT;strict_without_filters;schema1"); }
std::string nativeProfileHash(const std::string& strategy, const jsn::Value& settings = jsn::Object{});
class TimeframeScanner {
public:
  // One cell per (feed, config, profile, timeframe) — never per feed epoch.
  // The plan registers 690 timeframe cells; Node's registry admits at most
  // 1024 profiles in all (agent/lib/scanner-bounds.js).
  static constexpr size_t kCellCapacity = 1024;
  // A cell is stale once nothing has offered it for this long and it has no
  // job queued or running. Node offers every registered cell on each legacy
  // scan rotation (about 12 minutes), duplicates included, so an hour is
  // several missed rotations. Stale cells are evicted only to admit a new cell.
  static constexpr long long kStaleAfterMs = 3600000;
  static constexpr size_t kQueueCapacity = 32;
  explicit TimeframeScanner(std::function<long long()> clock = nowMs, long long staleAfterMs = kStaleAfterMs);
  ~TimeframeScanner();
  jsn::Value submit(const jsn::Value& body);
  jsn::Value status();
  jsn::Value results(long long after) { return output_.read(after); }
  void flush();
private:
  struct Job { Identity identity; std::vector<bt::Bar> bars; bt::Options options; long long received = 0, closeAt = 0; jsn::Value source, calendar, settings; std::string key, strategy; };
  struct Cell { long long closeAt = 0, offeredAt = 0, completedAt = 0; size_t pending = 0; };
  void run(std::stop_token stop);
  std::function<long long()> clock_;
  const long long staleAfterMs_;
  std::mutex mutex_;
  std::condition_variable ready_, drained_;
  std::deque<Job> jobs_;
  // Work rows exist only for cells with a job queued or running: an idle
  // input-driven cell has nothing due, so it carries no deadline for
  // cpp-verify to judge and is counted in status().cells instead.
  std::map<std::string, jsn::Value> work_;
  std::map<std::string, Cell> cells_;
  size_t active_ = 0;
  long long evicted_ = 0;
  CandidateRing output_;
  std::jthread worker_;
};
}
