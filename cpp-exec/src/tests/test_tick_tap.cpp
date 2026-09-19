// cpp-exec/src/tests/test_tick_tap.cpp — 19-09-2026 (checker SHOULD 2 on the
// fast-monitor quotes PR): the feed's raw tap admits only the CONFIGURED tick
// universe into the recorder and the workers. A symbol the keeper subscribed
// for quotes only (an open monitored position, `quoteSymbolIds`) produces no
// recorder event and no worker dispatch; an unset universe (no push yet)
// admits everything, as before; an empty configured universe admits nothing.
// The workers run their own threads, hence TSAN_TESTS.
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

#include "../tick_tap.hpp"

using namespace tick;

namespace {
std::string tmpSpool() {
  char buf[] = "/tmp/tick_tap_XXXXXX";
  const char* d = mkdtemp(buf);
  assert(d);
  return std::string(d) + "/spool";
}
FreeSpaceProbe plenty() {
  return [](const std::string&, uint64_t& avail, uint64_t& total) { avail = 40ull << 30; total = 50ull << 30; return true; };
}
RecorderConfig cfg(const std::string& dir) {
  RecorderConfig c;
  c.spoolDir = dir; c.feedId = "demo.ctraderapi.com/…7342"; c.environment = 0;
  c.queueRecords = 1024; c.segmentBytes = 64ull << 20; c.spoolCapBytes = 2ull << 30; c.reserveMinBytes = 2ull << 30;
  c.fsyncEveryMs = 50; c.budgetCheckEveryMs = 0;
  return c;
}
} // namespace

static void test_a_quotes_only_symbol_is_neither_recorded_nor_dispatched() {
  const std::string dir = tmpSpool();
  TickRecorder rec(cfg(dir), plenty());
  assert(rec.start());
  std::atomic<int> handled{0};
  SymbolWorkers workers(2, 1 << 10, [&handled](int, const WorkerEvent&) { handled.fetch_add(1); });
  workers.start();
  SymbolUniverse universe;

  // unset: everything passes (the pre-quotes behaviour)
  SpotRawTap tap = makeRecorderTap(&rec, &workers, &universe);
  tap(41, true, 110000, true, 110020, 1);
  tap(99, true, 250000, true, 250040, 1);
  workers.flush();
  assert(rec.stats().events == 2);
  assert(workers.stats().dispatched == 2 && handled.load() == 2);
  std::puts("  unset universe: every symbol reaches the recorder and the workers");

  // configured {41}: 99 (subscribed for quotes only) is gated out
  universe.set({41});
  assert(universe.configured() && universe.size() == 1);
  tap(41, true, 110010, true, 110030, 1);
  tap(99, true, 250010, true, 250050, 1);
  tap(99, false, 0, true, 250060, 1);
  workers.flush();
  assert(rec.stats().events == 3);           // one more, for 41 only
  assert(workers.stats().dispatched == 3 && handled.load() == 3);
  std::puts("  configured {41}: the quotes-only symbol produces no record and no dispatch");

  // an empty configured list admits nothing — a decision, not an absence
  universe.set({});
  tap(41, true, 110020, true, 110040, 1);
  workers.flush();
  assert(rec.stats().events == 3);
  assert(workers.stats().dispatched == 3);
  std::puts("  configured {}: nothing passes");

  // no workers: the recorder still sees the admitted symbol
  universe.set({7});
  SpotRawTap noWorkers = makeRecorderTap(&rec, nullptr, &universe);
  noWorkers(7, true, 1, true, 2, 1);
  assert(rec.stats().events == 4);

  workers.stop();
  rec.stop();
}

int main() {
  test_a_quotes_only_symbol_is_neither_recorded_nor_dispatched();
  std::puts("test_tick_tap: all passed");
  return 0;
}
