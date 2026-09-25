#pragma once
#include "scanner_contract.hpp"
#include "tick_strategy.hpp"
#include "tick_workers.hpp"

namespace scan {
class TickScanner {
public:
  // One stream per (feed, config, profile), never per gateway feed epoch. The
  // cap stays 512: every stream is one /watchdog work row (about 330 bytes),
  // and 1024 rows would pass cpp-verify's 256 KiB contract bound, which reads
  // as an unreachable service. The plan registers 106 (53 per gateway).
  static constexpr size_t kStreamCapacity = 512;
  // A stream nothing has fed for an hour, with no event in flight, is stale.
  // Stale streams are evicted only to admit a new stream.
  static constexpr long long kStaleAfterMs = 3600000;
  explicit TickScanner(int workers = 2, size_t queue = 2048, std::function<long long()> clock = nowMs, long long staleAfterMs = kStaleAfterMs);
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
    long long offeredAt = 0, inflight = 0; // inflight: dispatched events not yet fully consumed
    bool retired = false;                  // superseded by a newer epoch: drains, then is erased
    jsn::Value calendar;
  };
  // A new epoch never reuses its predecessor's slot: it gets a NEW slot id, so
  // an event of the old epoch still in a worker ring can never reach the new
  // slot's metadata. The old slot drains and is erased at its last event.
  struct Stream { uint32_t slot = 0; std::deque<std::string> retiredEpochs; long long turnovers = 0; };
  void consume(const tick::WorkerEvent& event);
  void evaluate(Slot& slot, const tick::WorkerEvent& event);
  std::function<long long()> clock_;
  const long long staleAfterMs_;
  std::mutex producer_, registry_;
  std::map<std::string, Stream> streams_;
  std::map<uint32_t, std::shared_ptr<Slot>> slots_; // current and draining slots
  uint32_t nextId_ = 0;
  long long turnovers_ = 0, evicted_ = 0, superseded_ = 0;
  CandidateRing output_, comparisons_;
  const size_t queueCapacity_;
  std::vector<std::atomic<size_t>> pendingPerWorker_;
  tick::SymbolWorkers workers_;
};
}
