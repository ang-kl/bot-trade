// Tests for DepthBook — L2 book state from ProtoOADepthEvent payloads.
// Wire fixtures follow OpenApiModelMessages.proto: quotes are {id, size,
// bid?|ask?} with prices x100000 and size in volume cents.
#include <cassert>
#include <cstdio>
#include <string>

#include "../depth_book.hpp"

namespace {

jsn::Value payload(const std::string& json) {
  auto v = jsn::parse(json);
  assert(v && v->isObject());
  return *v;
}

bool contains(const std::string& hay, const std::string& needle) {
  return hay.find(needle) != std::string::npos;
}

void testSidesScalingAndOrdering() {
  DepthBook b;
  b.applyEvent(payload(
      "{\"symbolId\":1,\"newQuotes\":["
      "{\"id\":1,\"size\":100000,\"bid\":108500},"
      "{\"id\":2,\"size\":200000,\"bid\":108490},"
      "{\"id\":3,\"size\":150000,\"ask\":108520},"
      "{\"id\":4,\"size\":50000,\"ask\":108510}]}"), 1000);
  assert(!b.empty());
  assert(b.lastAtMs() == 1000);
  std::string s = b.snapshotJson(10);
  // Prices descaled by 100000; bids best-first (1.085 before 1.0849), asks
  // best-first (1.0851 before 1.0852).
  assert(contains(s, "\"at\":1000"));
  size_t bid1 = s.find("1.085,");
  size_t bid2 = s.find("1.0849,");
  size_t ask1 = s.find("1.0851,");
  size_t ask2 = s.find("1.0852,");
  assert(bid1 != std::string::npos && bid2 != std::string::npos);
  assert(ask1 != std::string::npos && ask2 != std::string::npos);
  assert(bid1 < bid2);
  assert(ask1 < ask2);
  assert(contains(s, "\"sizeCents\":100000"));
}

void testUpdateByIdAndDelete() {
  DepthBook b;
  b.applyEvent(payload(
      "{\"newQuotes\":[{\"id\":7,\"size\":100,\"bid\":108500},"
      "{\"id\":8,\"size\":200,\"ask\":108520}]}"), 1);
  // Same id re-quoted replaces the entry (size and price move together).
  b.applyEvent(payload(
      "{\"newQuotes\":[{\"id\":7,\"size\":900,\"bid\":108400}]}"), 2);
  std::string s = b.snapshotJson(10);
  assert(contains(s, "1.084"));
  assert(contains(s, "\"sizeCents\":900"));
  assert(!contains(s, "\"sizeCents\":100,"));
  // Deletes remove by id; unknown ids are no-ops, not errors.
  b.applyEvent(payload("{\"deletedQuotes\":[7,999]}"), 3);
  s = b.snapshotJson(10);
  assert(!contains(s, "1.084"));
  assert(contains(s, "1.0852")); // ask id 8 survives
  assert(b.lastAtMs() == 3);
}

void testLevelCapAndMalformed() {
  DepthBook b;
  b.applyEvent(payload(
      "{\"newQuotes\":["
      "{\"id\":1,\"size\":1,\"bid\":100000},"
      "{\"id\":2,\"size\":1,\"bid\":99000},"
      "{\"id\":3,\"size\":1,\"bid\":98000},"
      "{\"id\":4,\"size\":1},"                 // neither side — skipped
      "{\"size\":1,\"bid\":97000}]}"), 5);     // no id — skipped
  std::string s = b.snapshotJson(2);
  assert(contains(s, "\"price\":1,"));    // 100000/100000
  assert(contains(s, "0.99"));
  assert(!contains(s, "0.98"));           // capped at 2 levels
  assert(!contains(s, "0.97"));           // malformed never entered
}

void testEmptyAndClear() {
  DepthBook b;
  assert(b.empty());
  b.applyEvent(payload("{\"newQuotes\":[{\"id\":1,\"size\":1,\"bid\":100000}]}"), 9);
  assert(!b.empty());
  b.clear();
  assert(b.empty());
  assert(b.lastAtMs() == 0);
}


void testOomGuardCap() {
  // Simulated quote-id churn without deletes: past kMaxEntries the book
  // resets instead of growing without bound (the silent-SIGKILL guard).
  DepthBook b;
  for (int i = 1; i <= 600; ++i) {
    b.applyEvent(payload("{\"newQuotes\":[{\"id\":" + std::to_string(i) +
                         ",\"size\":1,\"bid\":100000}]}"), i);
    assert(b.size() <= DepthBook::kMaxEntries);
  }
  // The book still works after a reset.
  b.applyEvent(payload("{\"newQuotes\":[{\"id\":9001,\"size\":5,\"bid\":100000}]}"), 999);
  assert(!b.empty());
}

} // namespace

int main() {
  testSidesScalingAndOrdering();
  testUpdateByIdAndDelete();
  testLevelCapAndMalformed();
  testEmptyAndClear();
  testOomGuardCap();
  std::puts("test_depth_book: OK");
  return 0;
}
