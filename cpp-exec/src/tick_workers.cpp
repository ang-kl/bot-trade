// cpp-exec/src/tick_workers.cpp — see tick_workers.hpp.
#include "tick_workers.hpp"

#include <chrono>

namespace tick {

SymbolWorkers::SymbolWorkers(int workers, size_t ringPerWorker, WorkerHandler handler)
    : workers_(workers < 1 ? 1 : workers), handler_(std::move(handler)) {
  for (int i = 0; i < workers_; ++i) {
    rings_.push_back(std::make_unique<SpscRing<WorkerEvent>>(ringPerWorker));
    processed_.push_back(std::make_unique<std::atomic<uint64_t>>(0));
    droppedPer_.push_back(std::make_unique<std::atomic<uint64_t>>(0));
  }
}

SymbolWorkers::~SymbolWorkers() { stop(); }

void SymbolWorkers::start() {
  if (running_.load()) return;
  stop_.store(false);
  running_.store(true);
  for (int i = 0; i < workers_; ++i) threads_.emplace_back([this, i] { loop(i); });
}

void SymbolWorkers::stop() {
  if (!running_.load()) return;
  stop_.store(true);
  for (auto& t : threads_) if (t.joinable()) t.join();
  threads_.clear();
  running_.store(false);
}

void SymbolWorkers::dispatch(const WorkerEvent& in) {
  WorkerEvent ev = in;
  const int w = workerFor(ev.symbolId);
  auto it = gapPending_.find(ev.symbolId);
  if (it != gapPending_.end() && it->second) { ev.gapBefore = true; }
  if (rings_[static_cast<size_t>(w)]->push(ev)) {
    dispatched_.fetch_add(1, std::memory_order_relaxed);
    if (ev.gapBefore) { gapPending_[ev.symbolId] = false; gapsMarked_.fetch_add(1, std::memory_order_relaxed); }
    return;
  }
  // Full: the feed thread never waits. The symbol's continuity is broken
  // until its next delivered event, which carries gapBefore.
  dropped_.fetch_add(1, std::memory_order_relaxed);
  droppedPer_[static_cast<size_t>(w)]->fetch_add(1, std::memory_order_relaxed);
  gapPending_[ev.symbolId] = true;
  std::lock_guard<std::mutex> lk(symMtx_);
  droppedBySymbol_[ev.symbolId]++;
}

void SymbolWorkers::loop(int w) {
  SpscRing<WorkerEvent>& ring = *rings_[static_cast<size_t>(w)];
  for (;;) {
    bool did = false;
    while (auto ev = ring.pop()) {
      did = true;
      if (handler_) handler_(w, *ev);
      processed_[static_cast<size_t>(w)]->fetch_add(1, std::memory_order_relaxed);
    }
    if (stop_.load() && ring.empty()) break;
    if (!did) std::this_thread::sleep_for(std::chrono::microseconds(200));
  }
}

WorkerStats SymbolWorkers::stats() const {
  WorkerStats s;
  s.workers = workers_;
  s.dispatched = dispatched_.load();
  s.dropped = dropped_.load();
  s.gapsMarked = gapsMarked_.load();
  for (int i = 0; i < workers_; ++i) {
    s.perWorkerProcessed.push_back(processed_[static_cast<size_t>(i)]->load());
    s.perWorkerDropped.push_back(droppedPer_[static_cast<size_t>(i)]->load());
    s.processed += s.perWorkerProcessed.back();
  }
  std::lock_guard<std::mutex> lk(symMtx_);
  s.droppedBySymbol = droppedBySymbol_;
  return s;
}

void SymbolWorkers::flush() {
  for (;;) {
    bool empty = true;
    for (auto& r : rings_) if (!r->empty()) empty = false;
    if (empty) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  std::this_thread::sleep_for(std::chrono::milliseconds(5));
}

} // namespace tick
