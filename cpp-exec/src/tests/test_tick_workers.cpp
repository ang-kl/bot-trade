// cpp-exec/src/tests/test_tick_workers.cpp — P3b: symbol workers (TM-22,
// TM-23). The same input at 1, 2 and 4 workers yields the identical
// per-symbol event sequence; a full ring drops, counts and marks the
// symbol's continuity broken on its next delivered event, and the producer
// never blocks.
#include <cassert>
#include <chrono>
#include <cstdio>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

#include "../tick_workers.hpp"

using namespace tick;

namespace {
struct Seen {
  std::mutex m;
  std::map<uint32_t, std::vector<uint32_t>> seqBySymbol;
  std::map<uint32_t, int> workerBySymbol;
  bool mixedWorker = false;
  uint64_t gaps = 0;
  std::vector<uint32_t> gapSeqs; // the seqs delivered with gapBefore
};

std::vector<WorkerEvent> input(int symbols, int perSymbol) {
  std::vector<WorkerEvent> out;
  for (int i = 0; i < perSymbol; ++i)
    for (int s = 1; s <= symbols; ++s) {
      WorkerEvent e; e.symbolId = static_cast<uint32_t>(s); e.seq = static_cast<uint32_t>(i + 1); e.bid = 100 + i; e.ask = 101 + i; e.recvMs = 1000 + i;
      out.push_back(e);
    }
  return out;
}

void run(int workers, const std::vector<WorkerEvent>& in, Seen& seen, size_t ring = 1 << 12) {
  SymbolWorkers w(workers, ring, [&seen](int worker, const WorkerEvent& ev) {
    std::this_thread::sleep_for(std::chrono::microseconds(5)); // the consumer costs something
    std::lock_guard<std::mutex> lk(seen.m);
    seen.seqBySymbol[ev.symbolId].push_back(ev.seq);
    auto it = seen.workerBySymbol.find(ev.symbolId);
    if (it == seen.workerBySymbol.end()) seen.workerBySymbol[ev.symbolId] = worker;
    else if (it->second != worker) seen.mixedWorker = true;
    if (ev.gapBefore) seen.gaps++;
  });
  w.start();
  for (const auto& e : in) w.dispatch(e);
  w.flush();
  w.stop();
  const WorkerStats s = w.stats();
  assert(s.workers == workers && s.processed == s.dispatched);
}
} // namespace

static void test_same_per_symbol_sequence_at_1_2_and_4_workers() {
  const auto in = input(7, 300);
  Seen one, two, four;
  run(1, in, one);
  run(2, in, two);
  run(4, in, four);
  assert(one.seqBySymbol.size() == 7 && two.seqBySymbol.size() == 7 && four.seqBySymbol.size() == 7);
  for (uint32_t s = 1; s <= 7; ++s) {
    const auto& a = one.seqBySymbol.at(s);
    assert(a.size() == 300);
    for (size_t i = 0; i < a.size(); ++i) assert(a[i] == i + 1); // in order
    assert(two.seqBySymbol.at(s) == a && four.seqBySymbol.at(s) == a);
  }
  assert(!one.mixedWorker && !two.mixedWorker && !four.mixedWorker); // one symbol, one worker
  assert(one.gaps == 0 && two.gaps == 0 && four.gaps == 0);
  // four workers really spread the symbols
  std::map<int, int> perWorker;
  for (const auto& kv : four.workerBySymbol) perWorker[kv.second]++;
  assert(perWorker.size() >= 2);
  assert(SymbolWorkers::shardFor(5, 4) == 1 && SymbolWorkers::shardFor(8, 4) == 0 && SymbolWorkers::shardFor(9, 1) == 0);
}

static void test_a_full_ring_drops_and_marks_the_symbol_s_continuity_broken() {
  Seen seen;
  std::atomic<bool> hold{true};
  SymbolWorkers w(1, 4, [&seen, &hold](int, const WorkerEvent& ev) {
    while (hold.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1)); // the consumer is stuck
    std::lock_guard<std::mutex> lk(seen.m);
    seen.seqBySymbol[ev.symbolId].push_back(ev.seq);
    if (ev.gapBefore) { seen.gaps++; seen.gapSeqs.push_back(ev.seq); }
  });
  w.start();
  const auto t0 = std::chrono::steady_clock::now();
  for (uint32_t i = 1; i <= 50; ++i) { WorkerEvent e; e.symbolId = 41; e.seq = i; w.dispatch(e); }
  const auto tookMs = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
  assert(tookMs < 100); // the producer never waited on the stuck consumer
  WorkerStats s = w.stats();
  assert(s.dropped > 0 && s.dropped < 50 && s.droppedBySymbol.at(41) == s.dropped);
  hold.store(false);
  w.flush();
  { WorkerEvent e; e.symbolId = 41; e.seq = 51; w.dispatch(e); } // the first delivered event after the drops
  w.flush();
  w.stop();
  s = w.stats();
  // The consumer pops one event before it blocks, so a slot can free up
  // mid-burst and an earlier gap can be delivered too: at least one gap,
  // every gap delivered, and the first event after the last drops (51)
  // carries it.
  assert(s.gapsMarked >= 1 && seen.gaps == s.gapsMarked);
  assert(!seen.gapSeqs.empty() && seen.gapSeqs.back() == 51);
  const auto& seq = seen.seqBySymbol.at(41);
  assert(seq.back() == 51);
  for (size_t i = 1; i < seq.size(); ++i) assert(seq[i] > seq[i - 1]); // order kept across the gap
}

int main() {
  test_same_per_symbol_sequence_at_1_2_and_4_workers();
  test_a_full_ring_drops_and_marks_the_symbol_s_continuity_broken();
  std::puts("test_tick_workers: all passed");
  return 0;
}
