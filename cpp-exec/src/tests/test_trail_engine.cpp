// Tests for the tick-level trail ratchet (owner option 4). Pure logic only
// — trailDecide and TrailEngine state, no WS/engine.
#include <cassert>
#include <cstdio>

#include "../protection_ratchet.hpp"
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
  s.currentTp = 1.20000;
  s.hasTp = true;
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

void testConfigureDropsSpecsWithNoTarget() {
  TrailSpec missing = longSpec();
  missing.currentTp = 0;
  missing.hasTp = false;
  TrailEngine te;
  te.configure({ { 55, missing } });
  assert(te.tracked() == 0);
  assert(te.statusJson().find("\"specsDroppedNoTarget\":1") != std::string::npos);
}

// SUPERSEDED CONVENTION (2026-08-01 audit #3): "no known SL → any target
// improves" let a stop already locked at breakeven be amended BACK below it
// whenever the keeper's push carried currentSl: null. An unknown SL now means
// DO NOT AMEND — the peak still advances, and the first push that supplies a
// real currentSl arms the ratchet.
void testUnknownSlNeverAmends() {
  TrailSpec s = longSpec();
  assert(!s.hasSl);
  double t = trailDecide(s, 1.10000, 1.10010);
  assert(t == 0);                      // no amend without a known floor
  assert(s.peakPrice == 1.10000);      // but the peak still tracks
  // Short side: same rule.
  TrailSpec sh = longSpec();
  sh.dir = -1;
  assert(trailDecide(sh, 1.09990, 1.10000) == 0);
}

void testLongRatchet() {
  TrailSpec s = longSpec();
  // The ratchet only arms once the current SL is KNOWN (see above).
  s.lastSl = 1.09000; s.hasSl = true;
  double t = trailDecide(s, 1.10000, 1.10010);
  assert(t == 1.09900);
  s.lastSl = t;
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
  s.lastSl = 1.10500; s.hasSl = true; // known floor arms the ratchet
  // Short trails above on the ASK.
  double t = trailDecide(s, 1.09990, 1.10000);
  assert(t == 1.10100);
  s.lastSl = t;
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
  s.lastSl = 1.00000; s.hasSl = true;
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

// 02-10-2026 stop-loss policy. stopLocksProfit: trailing is only requested for a
// stop at or beyond breakeven; equality counts (a breakeven stop locks zero loss);
// unknown entry/stop or direction never does.
void testStopLocksProfitTruthTable() {
  assert(stopLocksProfit(1, 100, 101));
  assert(stopLocksProfit(1, 100, 100));
  assert(!stopLocksProfit(1, 100, 99.99));
  assert(stopLocksProfit(-1, 100, 99));
  assert(stopLocksProfit(-1, 100, 100));
  assert(!stopLocksProfit(-1, 100, 100.01));
  assert(!stopLocksProfit(1, 0, 101) && !stopLocksProfit(1, -5, 101));
  assert(!stopLocksProfit(1, 100, 0) && !stopLocksProfit(-1, 100, -1));
  assert(!stopLocksProfit(0, 100, 101));
}

jsn::Value cfgWire(const char* raw) { return *jsn::parse(raw); }

void testTrailAmendPayloadPolicy() {
  TrailSpec s = longSpec();
  s.pendingSl = 101; s.entryPrice = 100; s.hasEntry = true;
  // No policy: today's payload, no policy keys at all.
  auto none = buildTrailAmend(7, s, StopPolicyCfg{});
  assert(none.get("stopLossTriggerMethod").isNull() && none.get("trailingStopLoss").isNull());
  assert(none.get("ratchetOnly").asBool() && none.get("stopLoss").asNumber() == 101);
  // Trigger configured, trailing off: trigger always, trailing never.
  StopPolicyCfg trig; trig.triggerWire = jsn::Value(2);
  auto t = buildTrailAmend(7, s, trig);
  assert(t.get("stopLossTriggerMethod").asNumber() == 2 && t.get("trailingStopLoss").isNull());
  // Name form is emitted verbatim.
  StopPolicyCfg named; named.triggerWire = jsn::Value(std::string("DOUBLE_TRADE")); named.trailingOnLock = true;
  auto n = buildTrailAmend(7, s, named);
  assert(n.get("stopLossTriggerMethod").asString() == "DOUBLE_TRADE");
  assert(n.get("trailingStopLoss").isBool() && n.get("trailingStopLoss").asBool());
  // on_lock but the stop does not lock profit: no trailing key (never false).
  s.pendingSl = 99;
  auto below = buildTrailAmend(7, s, named);
  assert(below.get("stopLossTriggerMethod").asString() == "DOUBLE_TRADE" && below.get("trailingStopLoss").isNull());
  // on_lock without an entry price: no trailing.
  s.pendingSl = 101; s.hasEntry = false;
  assert(buildTrailAmend(7, s, named).get("trailingStopLoss").isNull());
  // Short: stop below entry locks profit.
  TrailSpec sh = longSpec(); sh.dir = -1; sh.pendingSl = 99; sh.entryPrice = 100; sh.hasEntry = true;
  assert(buildTrailAmend(7, sh, named).get("trailingStopLoss").asBool());
  sh.pendingSl = 101;
  assert(buildTrailAmend(7, sh, named).get("trailingStopLoss").isNull());
  // Trailing on lock with no trigger: only the trailing flag.
  StopPolicyCfg onlyTrail; onlyTrail.trailingOnLock = true;
  s.hasEntry = true;
  auto ot = buildTrailAmend(7, s, onlyTrail);
  assert(ot.get("stopLossTriggerMethod").isNull() && ot.get("trailingStopLoss").asBool());
}

void testParseTrailStopPolicy() {
  auto a = parseTrailStopPolicy(cfgWire(R"({"stopLossTriggerMethod":2,"trailing":"on_lock"})"));
  assert(a.triggerWire.asNumber() == 2 && a.trailingOnLock);
  auto b = parseTrailStopPolicy(cfgWire(R"({"stopLossTriggerMethod":"OPPOSITE","trailing":"off"})"));
  assert(b.triggerWire.asString() == "OPPOSITE" && !b.trailingOnLock);
  auto c = parseTrailStopPolicy(cfgWire(R"({"stopLossTriggerMethod":1})"));
  assert(c.triggerWire.asNumber() == 1 && !c.trailingOnLock);
  // Absent or invalid anywhere clears the whole policy.
  for (const char* bad : {R"({"stopLossTriggerMethod":9,"trailing":"on_lock"})",
                          R"({"stopLossTriggerMethod":2,"trailing":"always"})",
                          R"({"trailing":"on_lock"})", R"([])", R"("x")"}) {
    auto d = parseTrailStopPolicy(cfgWire(bad));
    assert(d.triggerWire.isNull() && !d.trailingOnLock);
  }
  assert(parseTrailStopPolicy(jsn::Value()).triggerWire.isNull());
}

void testPolicyReportedInStatus() {
  TrailEngine e;
  StopPolicyCfg cfg; cfg.triggerWire = jsn::Value(3); cfg.trailingOnLock = true;
  e.configurePolicy(cfg);
  auto st = *jsn::parse(e.statusJson());
  assert(st.get("stopPolicy").get("stopLossTriggerMethod").asNumber() == 3);
  assert(st.get("stopPolicy").get("trailingOnLock").asBool());
  e.configurePolicy(StopPolicyCfg{});
  st = *jsn::parse(e.statusJson());
  assert(st.get("stopPolicy").get("stopLossTriggerMethod").isNull());
  assert(!st.get("stopPolicy").get("trailingOnLock").asBool());
}

} // namespace

int main() {
  testUnknownSlNeverAmends();
  testLongRatchet();
  testShortRatchet();
  testNeverThroughMarket();
  testConfigureKeepsLocalProgress();
  testSymbolIdsDedupe();
  testConfigureDropsSpecsWithNoAccount();
  testConfigureDropsSpecsWithNoTarget();
  testStopLocksProfitTruthTable();
  testTrailAmendPayloadPolicy();
  testParseTrailStopPolicy();
  testPolicyReportedInStatus();
  std::puts("test_trail_engine: OK");
  return 0;
}
