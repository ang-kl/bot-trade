// cpp-exec/src/tests/test_decision_ring.cpp — the sidecar's decision log
// (owner invariant 1, 2026-08-31). What matters: seq is monotonic, the ring
// retains exactly the newest kSlots records across wrap-around, the cursor
// slice hands over precisely what the puller has not seen, and a bootId
// mismatch (restart) yields the full retained ring rather than a silent gap.
#include <cassert>
#include <cstdio>
#include <string>

#include "../decision_ring.hpp"

static void test_seq_monotonic_and_since() {
  DecisionRing r(8);
  assert(r.latestSeq() == 0);
  assert(r.since(0).empty());
  for (int i = 1; i <= 5; ++i) r.log("engine", "order_submit", 100 + i);
  assert(r.latestSeq() == 5);
  auto all = r.since(0);
  assert(all.size() == 5);
  assert(all.front().seq == 1 && all.back().seq == 5);
  assert(all[2].accountId == 103);
  // Cursor slice: strictly newer than `after`.
  auto tail = r.since(3);
  assert(tail.size() == 2 && tail.front().seq == 4 && tail.back().seq == 5);
  assert(r.since(5).empty());
}

static void test_wraparound_retains_newest() {
  DecisionRing r(4);
  for (int i = 1; i <= 10; ++i) r.log("trail", "amend_ok", 0, i);
  assert(r.latestSeq() == 10);
  // Only the newest 4 survive; asking from 0 re-syncs at the oldest retained.
  auto all = r.since(0);
  assert(all.size() == 4);
  assert(all.front().seq == 7 && all.back().seq == 10);
  assert(all.front().symbolId == 7);
  // A cursor pointing into the evicted region also re-syncs, not crashes.
  auto gap = r.since(2);
  assert(gap.size() == 4 && gap.front().seq == 7);
}

static void test_dump_json_boot_id_semantics() {
  DecisionRing r(8);
  r.log("order_guard", "refused", 42, 7, "guard_halt", "detail here");
  r.log("engine", "connected");
  // Same boot + cursor at latest → no entries, but bootId/latestSeq present.
  std::string same = r.dumpJson(2, r.bootId());
  assert(same.find("\"latestSeq\":2") != std::string::npos);
  assert(same.find("guard_halt") == std::string::npos);
  // Different (stale) bootId → the FULL retained ring comes back.
  std::string stale = r.dumpJson(2, "not-this-boot");
  assert(stale.find("guard_halt") != std::string::npos);
  assert(stale.find("\"component\":\"engine\"") != std::string::npos);
  // bootId is 16 hex chars and stable across calls within one boot.
  assert(r.bootId().size() == 16);
  assert(r.bootId() == r.bootId());
}

int main() {
  test_seq_monotonic_and_since();
  test_wraparound_retains_newest();
  test_dump_json_boot_id_semantics();
  std::printf("test_decision_ring: OK\n");
  return 0;
}
