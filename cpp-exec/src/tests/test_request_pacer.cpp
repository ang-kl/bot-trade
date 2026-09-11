// cpp-exec/src/tests/test_request_pacer.cpp — P2b-1: the per-connection
// budget (docs: 50/s) with a share only protection may spend.
#include <algorithm>
#include <cassert>
#include <cstdio>

#include "../request_pacer.hpp"

static void test_entries_stop_at_the_reserve_and_protection_spends_it() {
  RequestPacer p(PacerConfig{10, 30, 10}); // 10/s, bucket 10, 3 reserved
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
  RequestPacer p(PacerConfig{10, 30, 10});
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
  RequestPacer bad(PacerConfig{0, 200, 99});
  assert(bad.config().capacityPerSec == 1 && bad.config().protectionReservePct == 90 && bad.config().burst == 1);
  RequestPacer dflt;
  assert(dflt.config().capacityPerSec == 40 && dflt.config().protectionReservePct == 25); // below the documented 50/s
  assert(dflt.config().capacityPerSec < 50);
  assert(dflt.config().burst == 8); // a small burst, not a whole second's budget in one instant
}

// 11-09-2026 audit: the bucket used to hold a full second's budget, so any
// idle second was followed by a 40-request burst. With burst 8 at 40/s the
// most any 100 ms window can grant is the bucket plus that window's refill.
static void test_a_full_second_is_paced_not_burst() {
  RequestPacer p; // 40/s, burst 8, 25% reserved (2 tokens)
  long long t = 10'000;
  int granted = 0, maxWindow = 0;
  int window[10] = {0};
  for (int ms = 0; ms < 1000; ++ms) {
    while (p.tryAcquire(RequestClass::Entry, t + ms)) { granted++; window[ms / 100]++; }
  }
  for (int w : window) maxWindow = std::max(maxWindow, w);
  assert(granted <= 8 + 40 && granted >= 40);   // the bucket plus one second of refill
  assert(maxWindow <= 8 + 4);                   // no 100 ms window sees more than the bucket + its refill
  assert(window[9] <= 4);                       // the tail is steady-state: refill only
  // Protection still has its reserve in hand at the end of the burst.
  assert(p.tryAcquire(RequestClass::Protection, t + 1000));
}

int main() {
  test_entries_stop_at_the_reserve_and_protection_spends_it();
  test_refill_is_continuous_and_capped();
  test_config_is_clamped_and_reported();
  test_a_full_second_is_paced_not_burst();
  std::puts("test_request_pacer: all passed");
  return 0;
}
