// cpp-exec/src/tests/test_spsc.cpp — lock-free SPSC ring buffer.
#include <cassert>
#include <cstdio>
#include <thread>
#include <vector>

#include "../spsc_ring.hpp"

static void test_basic() {
  SpscRing<int> r(4);
  assert(r.capacity() == 4);       // already a power of two
  assert(r.empty());
  assert(r.push(1));
  assert(r.push(2));
  assert(r.push(3));               // capacity-1 usable slots (one reserved)
  assert(!r.push(4));              // full
  assert(*r.pop() == 1);
  assert(*r.pop() == 2);
  assert(r.push(4));               // slot freed
  assert(*r.pop() == 3);
  assert(*r.pop() == 4);
  assert(!r.pop().has_value());    // empty
}

static void test_pow2_rounding() {
  SpscRing<int> r(5);
  assert(r.capacity() == 8);       // rounded up
}

// One producer, one consumer, on separate threads — every value arrives
// exactly once, in order, nothing lost or duplicated.
static void test_threaded() {
  const int N = 200000;
  SpscRing<int> r(1024);
  std::vector<int> got;
  got.reserve(N);
  std::thread consumer([&] {
    int seen = 0;
    while (seen < N) {
      auto v = r.pop();
      if (v) { got.push_back(*v); seen++; }
    }
  });
  for (int i = 0; i < N; i++) {
    while (!r.push(i)) { /* spin while full */ }
  }
  consumer.join();
  assert((int)got.size() == N);
  for (int i = 0; i < N; i++) assert(got[i] == i); // FIFO, no gaps/dupes
}

int main() {
  test_basic();
  test_pow2_rounding();
  test_threaded();
  std::puts("test_spsc: all assertions passed");
  return 0;
}
