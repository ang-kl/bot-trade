// Codex · №12,318 · 2026-10-09; codex-footprint: native-hybrid-profit.
// Tick detection has no order authority. The existing durable Node claim
// arbitrates every partial with ordinary/protective closers before execution.
#pragma once
#include "json.hpp"
#include <atomic>
#include <condition_variable>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>

namespace hybrid {
long long clockMs();
bool positiveId(const jsn::Value& v, long long* out = nullptr);
struct Spec {
  std::string key, host, accountId, symbolId, positionId, side;
  long long tradeId = 0, expiresAtMs = 0;
  double trigger = 0;
};
bool decodeSpec(const jsn::Value& v, const std::string& host, long long now, Spec& out);

class TickEngine {
public:
  explicit TickEngine(std::string path, std::function<long long()> clock = clockMs);
  ~TickEngine();
  TickEngine(const TickEngine&) = delete;
  TickEngine& operator=(const TickEngine&) = delete;
  bool configure(const jsn::Value& specs, const std::string& host);
  // RAW event: each quote side keeps its own receive clock; reconnect resets
  // both sides. No disk, network, broker request or order runs on this thread.
  void onTick(const std::string& host, long long account, long long symbol,
              bool hasBid, long long bid, bool hasAsk, long long ask,
              long long generation, long long receivedAtMs, long long brokerAtMs);
  jsn::Value events(int waitMs = 0);
  bool acknowledge(const std::string& eventId);
  jsn::Value status();
  void start();
  void stop();
  bool flushOne(); // same worker operation, deterministic disk-boundary tests
private:
  struct State { Spec spec; bool pending = false; long long eligibleAfter = 0; };
  struct Quote { long long generation=0, bid=0, ask=0, bidAt=0, askAt=0, bidBrokerAt=0, askBrokerAt=0; };
  struct Trigger { Spec spec; Quote quote; long long at=0, decisionNs=0; };
  bool append(const jsn::Value& record);
  bool load();
  std::string path_, journalId_, error_;
  std::function<long long()> clock_;
  int fd_ = -1;
  long long nextSeq_ = 1, bytes_ = 0;
  std::atomic<bool> healthy_{false}, running_{false};
  std::mutex stateMtx_, diskMtx_;
  std::condition_variable workCv_, eventCv_;
  std::map<std::string, State> specs_;
  std::map<std::string, Quote> quotes_;
  std::deque<Trigger> queue_;
  std::map<std::string, jsn::Value> pending_;
  std::thread worker_;
  long long ticks_=0, queued_=0, refusedQueue_=0, lastDecisionNs_=0, maxDecisionNs_=0;
};
}
