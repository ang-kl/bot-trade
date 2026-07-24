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
  return s;
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
  std::puts("test_trail_engine: OK");
  return 0;
}
