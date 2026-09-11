// cpp-exec/src/tick_workers.hpp — P3b (docs/tick-momentum/plan.md §8;
// register TM-22, TM-23). Symbol workers: a fixed number of threads, each
// owning a fixed shard of symbols (symbolId modulo worker count), each fed
// by its own bounded SPSC ring from the feed thread. Two symbols on
// different shards are processed in parallel; two events of one symbol are
// processed in order by one thread, always — the property TM-22 asks for
// ("identical per-symbol events/signals at 1/2/4 workers"). The feed thread
// never blocks: a full ring drops the event, counts it, and marks that
// symbol's CONTINUITY as broken (TM-23) until the consumer acknowledges the
// gap by seeing the next event with `gapBefore` set — a strategy must
// re-warm from there, never bridge it.
//
// The consumer is a callback per event. Nothing trades here: P4's strategy
// plugs in as the consumer; until then the only consumer counts.
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "spsc_ring.hpp"

namespace tick {

struct WorkerEvent {
  uint64_t recvMs = 0;
  uint32_t seq = 0;         // the feed's sequence for this symbol (monotonic per symbol)
  uint32_t symbolId = 0;
  int64_t bid = 0;
  int64_t ask = 0;
  uint8_t flags = 0;        // tick_recorder.hpp's Flag bits
  bool gapBefore = false;   // events were dropped before this one — continuity broken
};

using WorkerHandler = std::function<void(int worker, const WorkerEvent&)>;

struct WorkerStats {
  int workers = 0;
  uint64_t dispatched = 0, processed = 0, dropped = 0, gapsMarked = 0;
  std::vector<uint64_t> perWorkerProcessed;
  std::vector<uint64_t> perWorkerDropped;
  std::map<long long, uint64_t> droppedBySymbol;
};

class SymbolWorkers {
public:
  // workers >= 1; ringPerWorker records of buffering per worker.
  SymbolWorkers(int workers, size_t ringPerWorker, WorkerHandler handler);
  ~SymbolWorkers();
  void start();
  void stop();   // drains what is queued, joins
  bool running() const { return running_.load(); }

  // Feed thread only (single producer across all rings).
  void dispatch(const WorkerEvent& ev);

  static int shardFor(uint32_t symbolId, int workers) { return workers <= 1 ? 0 : static_cast<int>(symbolId % static_cast<uint32_t>(workers)); }
  int workerFor(uint32_t symbolId) const { return shardFor(symbolId, workers_); }

  WorkerStats stats() const;
  // Block until every ring is drained (tests).
  void flush();

private:
  void loop(int w);

  const int workers_;
  WorkerHandler handler_;
  std::vector<std::unique_ptr<SpscRing<WorkerEvent>>> rings_;
  std::vector<std::thread> threads_;
  std::atomic<bool> running_{false};
  std::atomic<bool> stop_{false};
  std::atomic<uint64_t> dispatched_{0}, dropped_{0}, gapsMarked_{0};
  std::vector<std::unique_ptr<std::atomic<uint64_t>>> processed_;
  std::vector<std::unique_ptr<std::atomic<uint64_t>>> droppedPer_;
  // Feed-thread state: which symbols have a gap pending (dropped since last delivered).
  std::map<uint32_t, bool> gapPending_;
  mutable std::mutex symMtx_;
  std::map<long long, uint64_t> droppedBySymbol_;
};

} // namespace tick
