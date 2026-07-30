// Tests for the tick-level trail ratchet (owner option 4). Pure logic only
// — trailDecide and TrailEngine state, no WS/engine.
#include <cassert>
#include <cstdio>

#include "../trail_engine.hpp"

namespace {

TrailSpec longSpec() {
  TrailSpec s;
  s.symbolId = 1;
  s.dir = 1;
  s.trailDist = 0.0010; // 10 pips on a 5-digit pair
  s.digits = 5;
  // Required since PHASE 2 (owner, 2026-07-30): configure() now DROPS a spec
  // that names no account, because amendPosition refuses an unstamped payload.
  // A helper without this would silently make every configure() test a no-op.
  s.accountId = 4002;
  return s;
}

// PHASE 2: a spec with no account is refused at ingest, not at amend time.
//
// workerLoop is the only caller of ExecEngine::amendPosition inside the sidecar,
// and amendPosition now refuses a payload with no ctidTraderAccountId. An
// un-accounted spec left in the map would therefore sit there ratcheting nothing
// while amendsFailed_ climbed — a SILENT stop-loss failure, the worst shape this
// file could fail in. Dropping it at ingest makes the lost coverage visible.
void testConfigureDropsSpecsWithNoAccount() {
  TrailSpec ok = longSpec();
  TrailSpec bad = longSpec();
  bad.accountId = 0;

  TrailEngine te;
  te.configure({ { 11, ok }, { 22, bad } });
  assert(te.tracked() == 1);
  const std::string st = te.statusJson();
  assert(st.find("\"positionId\":11") != std::string::npos);
  assert(st.find("\"positionId\":22") == std::string::npos);
  // Reported, not merely absent — a count of zero would look like full coverage.
  assert(st.find("\"specsDroppedNoAccount\":1") != std::string::npos);

  // A negative id is just as unusable as zero.
  TrailSpec neg = longSpec();
  neg.accountId = -4002;
  te.configure({ { 33, neg } });
  assert(te.tracked() == 0);
  assert(te.statusJson().find("\"specsDroppedNoAccount\":1") != std::string::npos);

  // And a clean push clears the counter, so it reflects the LAST configure.
  te.configure({ { 44, ok } });
  assert(te.tracked() == 1);
  assert(te.statusJson().find("\"specsDroppedNoAccount\":0") != std::string::npos);
}

void testLongRatchet() {
  TrailSpec s = longSpec();
  // First tick: peak = bid, target = peak - dist, no existing SL → improves.
  double t = trailDecide(s, 1.10000, 1.10010);
  assert(t == 1.09900);
  s.lastSl = t; s.hasSl = true;
  // Higher bid → peak advances, target improves by ≥ step (0.0001).
  t = trailDecide(s, 1.10120, 1.10130);
  assert(t == 1.10020);
  s.lastSl = t;
  // Small wiggle below the step → no amend.
  t = trailDecide(s, 1.10125, 1.10135);
  assert(t == 0);
  // Lower bid: peak holds, target does not improve → 0. RATCHET-ONLY.
  t = trailDecide(s, 1.09000, 1.09010);
  assert(t == 0);
  assert(s.peakPrice == 1.10125); // peak never retreats
}

void testShortRatchet() {
  TrailSpec s = longSpec();
  s.dir = -1;
  // Short trails above on the ASK.
  double t = trailDecide(s, 1.09990, 1.10000);
  assert(t == 1.10100);
  s.lastSl = t; s.hasSl = true;
  // Ask falls → target tightens downward.
  t = trailDecide(s, 1.09790, 1.09800);
  assert(t == 1.09900);
  s.lastSl = t;
  // Ask rises again → no improvement → 0.
  t = trailDecide(s, 1.09990, 1.10000);
  assert(t == 0);
}

void testNeverThroughMarket() {
  TrailSpec s = longSpec();
  s.trailDist = 0.00001; // pathological: distance below one price step
  // Target would land at/above the bid → refused.
  double t = trailDecide(s, 1.10000, 1.10010);
  assert(t == 0 || t < 1.10000);
}

void testConfigureKeepsLocalProgress() {
  TrailEngine e;
  TrailSpec s = longSpec();
  e.configure({{ 42, s }});
  // Ticks advance the local peak beyond what Node knows.
  e.onTick(1, 1.10500, 1.10510);
  // Node re-pushes a stale peak — local progress must survive.
  TrailSpec stale = longSpec();
  stale.peakPrice = 1.10000;
  e.configure({{ 42, stale }});
  e.onTick(1, 1.10000, 1.10010); // lower tick: with kept peak 1.105, target stays 1.104
  const std::string st = e.statusJson();
  assert(st.find("1.105") != std::string::npos);
  // Full replace: an empty push clears tracking.
  e.configure({});
  assert(e.tracked() == 0);
}

void testSymbolIdsDedupe() {
  TrailEngine e;
  TrailSpec a = longSpec();
  TrailSpec b = longSpec();
  b.symbolId = 7;
  e.configure({{ 1, a }, { 2, b }, { 3, a }});
  assert(e.symbolIds().size() == 2);
}

} // namespace

int main() {
  testLongRatchet();
  testShortRatchet();
  testNeverThroughMarket();
  testConfigureKeepsLocalProgress();
  testSymbolIdsDedupe();
  testConfigureDropsSpecsWithNoAccount();
  std::puts("test_trail_engine: OK");
  return 0;
}
