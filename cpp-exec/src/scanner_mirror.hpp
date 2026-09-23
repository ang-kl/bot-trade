#pragma once
#include "spsc_ring.hpp"
#include "tick_recorder.hpp"
#include "tick_strategy.hpp"
#include "json.hpp"
#include <atomic>
#include <functional>
#include <thread>

// Optional mirror transport. Feed-thread work is one fixed-size ring push;
// serialization, HTTP, retries and per-symbol state belong to the consumer.
// It owns only the new scanner's credential, never a broker/Node credential.
class ScannerMirror {
public:
  enum class Delivery { Accepted, Retryable, Rejected };
  using Send = std::function<Delivery(const std::string&)>;
  static constexpr unsigned maxDeliveryAttempts = 6;
  ScannerMirror(std::string host, long long account, std::string configVersion,
                long long candidateTtlMs, tick::StrategyParams profile, Send send,
                size_t queueCapacity = 16384);
  ~ScannerMirror();
  void observe(const tick::Record& record, long long sourceTimestampMs) noexcept;
  jsn::Value status() const;
  static Send httpSender(const std::string& url, const std::string& secret);
private:
  struct Event { tick::Record record; long long sourceTime = 0; uint64_t losses = 0; };
  void run(std::stop_token stop);
  std::string host_, account_, config_, epoch_;
  long long ttl_;
  jsn::Value profile_;
  std::string profileHash_;
  Send send_;
  SpscRing<Event> queue_;
  std::atomic<uint64_t> accepted_{0}, consumed_{0}, dropped_{0}, failed_{0}, delivered_{0};
  std::atomic<uint64_t> attempts_{0}, retries_{0}, retryRecords_{0}, exhausted_{0}, rejected_{0}, pending_{0};
  std::atomic<long long> lastInput_{0}, lastDelivered_{0};
  std::atomic<bool> workerFailed_{false};
  std::jthread worker_;
};
