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
  explicit TimeframeScanner(std::function<long long()> clock = nowMs);
  ~TimeframeScanner();
  jsn::Value submit(const jsn::Value& body);
  jsn::Value status();
  jsn::Value results(long long after) { return output_.read(after); }
  void flush();
private:
  struct Job { Identity identity; std::vector<bt::Bar> bars; bt::Options options; long long received = 0, closeAt = 0; jsn::Value source, calendar, settings; std::string key, strategy; };
  void run(std::stop_token stop);
  std::function<long long()> clock_;
  std::mutex mutex_;
  std::condition_variable ready_, drained_;
  std::deque<Job> jobs_;
  std::map<std::string, jsn::Value> work_;
  std::map<std::string, long long> checkpoints_;
  size_t active_ = 0;
  CandidateRing output_;
  std::jthread worker_;
};
}
