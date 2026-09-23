#include "scanner.hpp"
#include "reference_strategies.hpp"
#include <regex>

namespace scan {
std::string nativeProfileHash(const std::string& strategy) {
  if (strategy == "fib_618_fade") return fibProfileHash();
  return tfscan::supports(strategy) ? hash(strategy + ";closed;reference_defaults;schema1") : "";
}
TimeframeScanner::TimeframeScanner(std::function<long long()> clock) : clock_(std::move(clock)), worker_([this](std::stop_token s) { run(s); }) {}
TimeframeScanner::~TimeframeScanner() { flush(); worker_.request_stop(); ready_.notify_all(); worker_.join(); }
jsn::Value TimeframeScanner::submit(const jsn::Value& body) {
  Job job; job.identity = identity(body);
  // A narrower native port must be explicit. VPO arm-before-touch routines
  // are not substitutes for closed-bar strategies or their volume filters.
  job.strategy = body.get("strategy").asString();
  const auto profile = nativeProfileHash(job.strategy);
  if (profile.empty() || job.identity.profile != profile
      || body.get("barMode").asString() != "closed" || !body.get("options").isObject() || !body.get("options").asObject().empty())
    throw std::invalid_argument("native_strategy_or_options_not_yet_supported; retain_reference_owner");
  job.received = integer(body.get("receivedAtMs"), 1, clock_());
  const auto duration = integer(body.get("barDurationMs"), 60000, 12 * 30 * 86400000LL);
  job.options.timeframe = version(body.get("timeframe"));
  std::smatch tf;
  static const std::regex format("^([0-9]+(?:\\.[0-9]+)?)(m|h|d|w|mo)$");
  if (!std::regex_match(job.options.timeframe, tf, format)) throw std::invalid_argument("canonical_timeframe_required");
  const std::map<std::string, long long> units{{"m",60000},{"h",3600000},{"d",86400000},{"w",604800000},{"mo",2592000000}};
  const auto value = std::stod(tf[1]); const auto milliseconds = value * units.at(tf[2]);
  if (!std::isfinite(milliseconds) || (tf[2] == "m" && std::floor(value) != value)
      || milliseconds != duration || duration % 60000 != 0) throw std::invalid_argument("timeframe_duration_mismatch");
  job.options.tfMinutes = duration / 60000.0;
  job.source = body.get("sourceTimestampMs"); if (!job.source.isNull()) integer(job.source, 1, 9007199254740991LL);
  if (!body.get("bars").isArray() || body.get("bars").asArray().empty() || body.get("bars").asArray().size() > 4096) throw std::invalid_argument("bar_window_bound");
  long long previous = -1;
  for (const auto& b : body.get("bars").asArray()) {
    const auto t = integer(b.get("t"), 0, job.received - duration);
    if (t <= previous) throw std::invalid_argument("bar_order");
    previous = t;
    bt::Bar bar; bar.t = t;
    double* fields[]{&bar.o, &bar.h, &bar.l, &bar.c, &bar.v}; const char* names[]{"o", "h", "l", "c", "v"};
    for (size_t i = 0; i < 5; ++i) {
      if (!b.get(names[i]).isNumber() || !std::isfinite(b.get(names[i]).asNumber()) || b.get(names[i]).asNumber() < 0) throw std::invalid_argument("bar_value");
      *fields[i] = b.get(names[i]).asNumber();
    }
    if (bar.l <= 0 || bar.h < std::max(bar.o, bar.c) || bar.l > std::min(bar.o, bar.c) || bar.h < bar.l) throw std::invalid_argument("bar_ohlc");
    job.bars.push_back(bar);
  }
  job.closeAt = previous + duration;
  job.key = job.identity.key + ":" + job.options.timeframe;
  job.calendar = body.get("calendar");
  {
    std::lock_guard lock(mutex_);
    const auto checkpoint = checkpoints_.find(job.key);
    if (checkpoint != checkpoints_.end() && checkpoint->second >= job.closeAt) return jsn::Value(jsn::Object{{"duplicate", true}, {"orderAuthority", false}});
    if (jobs_.size() >= 32 || (checkpoints_.size() >= 512 && checkpoint == checkpoints_.end())) throw std::runtime_error("bounded_capacity_unavailable");
    checkpoints_[job.key] = job.closeAt;
    auto row = work_[job.key].asObject();
    row["id"] = hash(job.key); row["role"] = "scanner"; row["state"] = "queued"; row["nextDueMs"] = job.received;
    row["accountId"] = job.identity.feed.get("accountId"); row["host"] = job.identity.feed.get("host"); row["symbolId"] = job.identity.feed.get("symbolId");
    row["calendar"] = job.calendar; row["timeframe"] = job.options.timeframe; row["strategy"] = job.strategy;
    work_[job.key] = jsn::Value(std::move(row)); jobs_.push_back(std::move(job));
  }
  ready_.notify_one(); return jsn::Value(jsn::Object{{"queued", true}, {"orderAuthority", false}});
}
void TimeframeScanner::run(std::stop_token stop) {
  while (true) {
    Job job;
    {
      std::unique_lock lock(mutex_); ready_.wait(lock, [&] { return stop.stop_requested() || !jobs_.empty(); });
      if (stop.stop_requested() && jobs_.empty()) return;
      job = std::move(jobs_.front()); jobs_.pop_front(); ++active_;
    }
    jsn::Value signal;
    if (job.strategy == "fib_618_fade") {
      const auto fib = bt::computeFibSignal(job.bars, job.bars.size(), job.options, false);
      if (fib.valid) signal = jsn::Value(jsn::Object{{"bias", fib.dir > 0 ? "long" : "short"}, {"entry", fib.entry}, {"sl", fib.sl},
        {"tp1", fib.tp1}, {"tp2", fib.tp2}, {"conviction", fib.conviction}, {"rr", fib.rr}, {"time_cap_minutes", fib.timeCapMinutes}, {"timeframe", job.options.timeframe}});
    } else signal = tfscan::compute(job.strategy, job.bars, job.options);
    const auto completed = clock_(); const bool expired = job.received + job.identity.ttl <= completed;
    jsn::Value result(jsn::Object{{"outcome", expired ? "expired" : !signal.isNull() ? "candidate" : "no_signal"},
      {"feed", job.identity.feed}, {"feedEpoch", job.identity.epoch}, {"configVersion", job.identity.config},
      {"profileHash", job.identity.profile}, {"strategy", job.strategy}, {"receivedAtMs", job.received},
      {"timeframe", job.options.timeframe}, {"barCloseAtMs", job.closeAt}, {"completedAtMs", completed}, {"orderAuthority", false}});
    if (!signal.isNull() && !expired) {
      auto c = candidate(job.identity, job.strategy, job.closeAt, job.received, job.source, completed, signal, job.options.timeframe);
      c.set("timeframe", job.options.timeframe);
      // Closed-bar economic identity survives gateway/scanner process epochs.
      c.set("basisId", hash(jsn::dump(jsn::Value(jsn::Array{job.identity.feed, job.identity.config, job.identity.profile, job.options.timeframe, job.closeAt}))));
      result.set("candidate", std::move(c));
    }
    output_.push(std::move(result));
    {
      std::lock_guard lock(mutex_); auto row = work_.at(job.key).asObject();
      row["state"] = "waiting_for_bar"; row["lastCompletedAtMs"] = completed; row["lastBarCloseAtMs"] = job.closeAt;
      // No new polling frequency: the next closed bar is the next scheduled
      // input for this unchanged strategy, subject to its verified calendar.
      row["nextDueMs"] = job.closeAt + static_cast<long long>(job.options.tfMinutes * 60000);
      for (const auto& pending : jobs_) if (pending.key == job.key) {
        row["state"] = "queued"; row["nextDueMs"] = pending.received; break;
      }
      row["outcome"] = expired ? "expired" : !signal.isNull() ? "candidate" : "no_signal";
      work_[job.key] = jsn::Value(std::move(row)); --active_;
    }
    drained_.notify_all();
  }
}
void TimeframeScanner::flush() { std::unique_lock lock(mutex_); drained_.wait(lock, [&] { return jobs_.empty() && active_ == 0; }); }
jsn::Value TimeframeScanner::status() {
  std::lock_guard lock(mutex_); jsn::Array work; for (const auto& [id, row] : work_) work.push_back(row);
  return jsn::Value(jsn::Object{{"schemaVersion", 1}, {"service", "cpp-scan-timeframe"}, {"observedAtMs", clock_()}, {"workComplete", true}, {"work", work},
    {"mode", "mirror"}, {"orderAuthority", false}, {"nativeCoverage", "closed bars: fib_618_fade FX baseline, donchian_breakout, rsi2_reversion, vwap_trend, fib_confluence; other semantics remain with reference owner"}});
}
}
