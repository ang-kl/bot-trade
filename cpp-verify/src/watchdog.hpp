#pragma once
#include "json.hpp"
#include <functional>
#include <map>
#include <mutex>
#include <thread>

namespace verify {
struct WatchPolicy {
  long long probeMs = 15000, serviceGraceMs = 60000;
  long long managementGraceMs = 60000, scannerGraceMs = 120000, noOrdersMs = 300000;
  long long repeatMs = 3600000;
  jsn::Value accountGraceMs{jsn::Object{}};
};
// Pure clock-injected incident state. No broker methods and no Node database.
// The process wrapper serializes access and persists BEFORE attempting delivery.
class WatchState {
public:
  explicit WatchState(WatchPolicy policy = {}) : policy_(policy) {}
  bool restore(const jsn::Value& state);
  jsn::Value snapshot() const;
  void probe(const std::string& service, bool reachable, const jsn::Value& contract, long long now);
  void protection(const jsn::Value& report, long long now);
  void evaluate(long long now);
  jsn::Value nextDelivery(long long now) const;
  void delivery(const std::string& id, bool accepted, const std::string& messageId,
                long long retryAfterMs, long long now);
  jsn::Value status(long long now) const;
  long long probeIntervalMs() const { return policy_.probeMs; }
private:
  void incident(const std::string& id, bool bad, const std::string& severity,
                const jsn::Value& detail, long long now, bool once = false);
  void enqueue(const std::string& id, jsn::Value& record, const std::string& transition, long long now);
  WatchPolicy policy_;
  std::map<std::string, jsn::Value> services_, incidents_, outbox_;
  long long dropped_ = 0;
};
bool watchAllowsNotification(const jsn::Value& snapshot, const jsn::Value& delivery, long long now);

class Watchdog {
public:
  explicit Watchdog(std::function<jsn::Value()> protection);
  ~Watchdog();
  void start();
  jsn::Value status();
private:
  void run(std::stop_token stop);
  bool persist();
  std::function<jsn::Value()> protection_;
  WatchState state_;
  std::mutex mutex_;
  std::jthread worker_;
  std::string path_, error_;
  bool enabled_ = false, writable_ = false, master_ = false, owner_ = false;
  int lockFd_ = -1;
};
}
