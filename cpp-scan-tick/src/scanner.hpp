#pragma once
#include "scanner_contract.hpp"
#include "tick_strategy.hpp"
#include "tick_workers.hpp"

namespace scan {
class TickScanner {
public:
  explicit TickScanner(int workers = 2, size_t queue = 2048, std::function<long long()> clock = nowMs);
  ~TickScanner();
  jsn::Value submit(const jsn::Value& batch);
  jsn::Value status();
  jsn::Value candidates(long long after) { return output_.read(after); }
  jsn::Value comparisons(long long after) { return comparisons_.read(after, 128); }
  void flush() { workers_.flush(); }
private:
  struct Meta { long long sourceSequence = 0, receivedAt = 0; jsn::Value sourceTime; bool gap = false; };
  struct Slot {
    Slot(Identity identity, tick::StrategyParams params) : identity(std::move(identity)), strategy(params) {}
    Identity identity;
    tick::TickMomentumStrategy strategy; // only the assigned worker evaluates it
    std::mutex mutex;
    std::map<uint32_t, Meta> metadata;
    uint32_t lastSubmitted = 0;
    long long lastCompleted = 0, lastReceived = 0, lastSubmittedReceipt = 0, lastSourceSequence = 0, resets = 0, expired = 0;
    jsn::Value calendar;
  };
  void consume(const tick::WorkerEvent& event);
  std::function<long long()> clock_;
  std::mutex producer_, registry_;
  std::map<std::string, uint32_t> ids_;
  std::map<uint32_t, std::shared_ptr<Slot>> slots_;
  uint32_t nextId_ = 0;
  CandidateRing output_, comparisons_;
  const size_t queueCapacity_;
  std::vector<std::atomic<size_t>> pendingPerWorker_;
  tick::SymbolWorkers workers_;
};
}
