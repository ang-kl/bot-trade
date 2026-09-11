// cpp-exec/src/tests/test_request_pacer.cpp — P2b-1: the per-connection
// budget (docs: 50/s) with a share only protection may spend.
#include <cassert>
#include <cstdio>

#include "../request_pacer.hpp"

static void test_entries_stop_at_the_reserve_and_protection_spends_it() {
  RequestPacer p(PacerConfig{10, 30}); // 10/s, 3 reserved
  long long t = 1'000'000;
  int granted = 0;
  while (p.tryAcquire(RequestClass::Entry, t)) granted++;
  assert(granted == 7);
  assert(!p.tryAcquire(RequestClass::Read, t));
  assert(p.counters().refusedEntry == 1 && p.counters().refusedRead == 1);
  int prot = 0;
  while (p.tryAcquire(RequestClass::Protection, t)) prot++;
  assert(prot == 3);
  assert(p.counters().refusedProtection == 1);
  assert(p.counters().granted == 10);
  assert(p.waitMsFor(RequestClass::Protection, t) == 100);  // one token refills in 100 ms at 10/s
  assert(p.waitMsFor(RequestClass::Entry, t) == 400);       // reserve (3) + 1 tokens
}

static void test_refill_is_continuous_and_capped() {
  RequestPacer p(PacerConfig{10, 30});
  long long t = 5'000;
  for (int i = 0; i < 10; ++i) p.tryAcquire(RequestClass::Protection, t);
  assert(!p.tryAcquire(RequestClass::Protection, t));
  assert(p.tryAcquire(RequestClass::Protection, t + 100));   // exactly one token back
  assert(!p.tryAcquire(RequestClass::Protection, t + 100));
  assert(p.waitMsFor(RequestClass::Entry, t + 100) == 400);
  for (int i = 0; i < 10; ++i) p.tryAcquire(RequestClass::Protection, t + 100'000); // a long idle refills to capacity, not beyond
  assert(!p.tryAcquire(RequestClass::Protection, t + 100'000));
  assert(p.counters().tokens < 1.0);
}

static void test_config_is_clamped_and_reported() {
  RequestPacer bad(PacerConfig{0, 200});
  assert(bad.config().capacityPerSec == 1 && bad.config().protectionReservePct == 90);
  RequestPacer dflt;
  assert(dflt.config().capacityPerSec == 40 && dflt.config().protectionReservePct == 25); // below the documented 50/s
  assert(dflt.config().capacityPerSec < 50);
}

int main() {
  test_entries_stop_at_the_reserve_and_protection_spends_it();
  test_refill_is_continuous_and_capped();
  test_config_is_clamped_and_reported();
  std::puts("test_request_pacer: all passed");
  return 0;
}
