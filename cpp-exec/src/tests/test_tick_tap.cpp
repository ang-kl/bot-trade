// cpp-exec/src/tests/test_tick_tap.cpp — 19-09-2026 (checker rounds on the
// fast-monitor quotes PR): the feed's raw tap EXCLUDES the quotes-only
// symbols from the recorder and the workers and admits everything else.
//  - no push yet: everything is recorded and dispatched, as before the PR;
//  - a symbol the feed carried before the push (VPO/trail/the tick list) is
//    still recorded and dispatched after a push that names it nowhere;
//  - a `quoteSymbolIds` symbol produces no recorder event and no dispatch;
//  - a symbol in BOTH lists is recorded; a later push naming a quotes-only
//    symbol in tickSymbolIds promotes it; a quotes-only symbol stays excluded
//    across pushes although it is now subscribed.
// The workers run their own threads, hence TSAN_TESTS.
#include <atomic>
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

static void test_only_the_quotes_only_symbols_are_excluded() {
  const std::string dir = tmpSpool();
  TickRecorder rec(cfg(dir), plenty());
  assert(rec.start());
  std::atomic<int> handled{0};
  SymbolWorkers workers(2, 1 << 10, [&handled](int, const WorkerEvent&) { handled.fetch_add(1); });
  workers.start();
  QuoteOnlyGate gate;
  SpotRawTap tap = makeRecorderTap(&rec, &workers, &gate);
  uint64_t expect = 0;
  auto fire = [&](long long id, bool admitted) {
    tap(id, true, 110000, true, 110020, 1);
    if (admitted) expect++;
    workers.flush();
    assert(rec.stats().events == expect);
    assert(workers.stats().dispatched == expect && static_cast<uint64_t>(handled.load()) == expect);
  };

  // no push yet: the feed carries 41 (VPO) and 77 (trail); both recorded
  fire(41, true);
  fire(77, true);
  assert(gate.quoteOnlyCount() == 0);
  std::puts("  no push: everything the feed carries is recorded and dispatched");

  // push 1: tickSymbolIds {41, 42}, quoteSymbolIds {77, 99, 42}; the feed
  // already carried 41 and 77 before this push
  gate.apply({77, 99, 42}, {41, 42}, {41, 77});
  assert(gate.quoteOnlyCount() == 1);        // only 99
  fire(41, true);                            // configured
  fire(42, true);                            // in both lists → recorded
  fire(77, true);                            // carried for the trail before the push → still recorded
  fire(99, false);                           // quotes-only → neither recorded nor dispatched
  std::puts("  push: a quotes-only symbol is excluded; the tick list, a both-lists symbol and a pre-subscribed symbol are recorded");

  // push 2 (the next probe): the same lists, and 99 is now subscribed —
  // it stays quotes-only because THIS gate marked it so
  gate.apply({77, 99, 42}, {41, 42}, {41, 77, 42, 99});
  assert(gate.quoteOnlyCount() == 1);
  fire(99, false);
  std::puts("  next push: a quotes-only symbol stays excluded although it is subscribed now");

  // push 3: the owner adds 99 to tick_symbols_json → promoted
  gate.apply({77, 42}, {41, 42, 99}, {41, 77, 42, 99});
  assert(gate.quoteOnlyCount() == 0);
  fire(99, true);
  std::puts("  promotion: naming a quotes-only symbol in tickSymbolIds records it again");

  // no tickSymbolIds on the push at all (a sidecar without the list): the
  // quote list alone excludes only what was not already carried
  gate.apply({77, 5}, {}, {41, 77, 42, 99});
  assert(gate.quoteOnlyCount() == 1);        // 5
  fire(5, false);
  fire(77, true);
  std::puts("  a push without tickSymbolIds excludes only the new quotes-only ids");

  // no gate at all: everything passes
  SpotRawTap ungated = makeRecorderTap(&rec, nullptr, nullptr);
  ungated(5, true, 1, true, 2, 1);
  expect++;
  assert(rec.stats().events == expect);

  workers.stop();
  rec.stop();
}

int main() {
  test_only_the_quotes_only_symbols_are_excluded();
  std::puts("test_tick_tap: all passed");
  return 0;
}
