// cpp-exec/src/tests/test_health_view.cpp — GW-1 (checker B1b): GET /health
// answers unauthenticated, so the blocks that carry broker identifiers show
// ids only to a trusted caller. main.cpp has no harness; the builders it
// calls (health_view.hpp) are tested here with every identifier-bearing input
// set, and the OPEN output is searched for each id.
//
// The ids are chosen so they cannot occur by accident inside another number
// in the output (no count, byte figure or timestamp here is 7+ digits).
#include <cassert>
#include <cstdio>
#include <string>

#include "../health_view.hpp"
#include "../json.hpp"
#include "../order_guard.hpp"
#include "../tick_shadow.hpp"

namespace {

const char* kAccountIds[] = {"90000001", "90000002", "90000003"};
const char* kSymbolIds[] = {"7777771", "8888881"};

GuardSnapshot fencedGuard() {
  GuardSnapshot g;
  g.halt = false;
  g.requireBracket = true;
  g.requireTarget = true;
  g.maxOrderVolume = 0;
  g.haltAccounts = {90000003};
  g.entryEpochs = {{90000001, 3}, {90000002, 5}};
  return g;
}

jsn::Value simWithClasses() {
  tick::ShadowSim sim;
  sim.costs.classes["fx"] = tick::ShadowCost{0, 0.5, 0, 0.2};
  sim.costs.classes["us_stock"] = tick::ShadowCost{2000, 0, 100, 0};
  sim.costs.symbolClass = {{7777771, "fx"}, {8888881, "us_stock"}};
  sim.costs.fallbackClass = "fx";
  auto v = jsn::parse(sim.json());
  assert(v && v->get("costs").get("symbolClass").get("7777771").asString() == "fx");
  return *v;
}

bool containsAny(const std::string& text, const char* const* ids, size_t n) {
  for (size_t i = 0; i < n; ++i) if (text.find(ids[i]) != std::string::npos) return true;
  return false;
}

} // namespace

static void test_the_open_guard_carries_counts_not_account_ids() {
  const GuardSnapshot g = fencedGuard();
  const jsn::Value open = health_view::guard(g, false);
  const std::string text = jsn::dump(open);
  assert(!containsAny(text, kAccountIds, 3));
  assert(open.get("entryEpochs").isNull() && open.get("haltAccounts").isNull());
  assert(open.get("entryEpochCount").asNumber(-1) == 2 && open.get("haltAccountCount").asNumber(-1) == 1);
  assert(open.get("requireBracket").asBool(false) && !open.get("halt").asBool(true));
  // the trusted view is what Node's guard sync reads (exec-guard-sync.js)
  const jsn::Value trusted = health_view::guard(g, true);
  assert(trusted.get("entryEpochs").get("90000001").asNumber(-1) == 3 && trusted.get("entryEpochs").get("90000002").asNumber(-1) == 5);
  assert(trusted.get("haltAccounts").asArray().size() == 1 && trusted.get("haltAccounts").asArray()[0].asNumber(0) == 90000003);
  assert(trusted.get("entryEpochCount").asNumber(-1) == 2);
  std::puts("the open guard carries counts, not account ids: ok");
}

static void test_the_open_shadow_sim_carries_a_count_not_symbol_ids() {
  const jsn::Value sim = simWithClasses();
  const jsn::Value open = health_view::shadowSim(sim, false);
  const std::string text = jsn::dump(open);
  assert(!containsAny(text, kSymbolIds, 2));
  assert(open.get("costs").get("symbolClass").isNull());
  assert(open.get("costs").get("symbolClassCount").asNumber(-1) == 2);
  // every other field survives: the classes, the fallback, the sim scalars
  assert(open.get("costs").get("fallbackClass").asString() == "fx");
  assert(open.get("costs").get("classes").get("us_stock").get("commissionWirePerSide").asNumber(0) == 2000);
  assert(open.get("latencyMs").asNumber(0) == 250 && open.get("targetR").asNumber(0) == 3.0);
  // the trusted view is the whole object (Node's sameCosts compares symbolClass)
  const jsn::Value trusted = health_view::shadowSim(sim, true);
  assert(trusted.get("costs").get("symbolClass").get("8888881").asString() == "us_stock");
  // building the open view did not edit the original (jsn copies share objects)
  assert(sim.get("costs").get("symbolClass").get("7777771").asString() == "fx");
  assert(sim.get("costs").get("symbolClassCount").isNull());
  // the allowlist names every field ShadowSim::json() writes today: the open
  // view loses the id map and nothing else
  for (const auto& kv : sim.asObject())
    if (kv.first != "costs") assert(jsn::dump(open.get(kv.first)) == jsn::dump(kv.second));
  for (const auto& kv : sim.get("costs").asObject())
    if (kv.first != "symbolClass") assert(!open.get("costs").get(kv.first).isNull());
  for (const auto& cls : sim.get("costs").get("classes").asObject())
    for (const auto& term : cls.second.asObject())
      assert(jsn::dump(open.get("costs").get("classes").get(cls.first).get(term.first)) == jsn::dump(term.second));
  std::puts("the open shadow sim carries a count, not symbol ids: ok");
}

// An allowlist, not a denylist (GW-1 re-check, nit 2): a field the sim grows
// later — here id-bearing at every level the open view builds — stays off the
// unauthenticated route until it is named in health_view.cpp.
static void test_an_unnamed_field_stays_off_the_open_shadow_sim() {
  auto v = jsn::parse(
      "{\"latencyMs\":250,\"targetR\":3,\"futureBySymbol\":{\"6666661\":1},\"maxHoldMs\":{\"7777772\":1},"
      "\"costs\":{\"fallbackClass\":\"fx\",\"symbolClass\":{\"7777771\":\"fx\"},\"futureAccounts\":[90000004],"
      "\"classes\":{\"fx\":{\"commissionWirePerSide\":0,\"commissionBpsPerSide\":0.5,\"slippageWirePerSide\":0,"
      "\"slippageBpsPerSide\":0.2,\"futureSymbol\":8888882}}}}");
  assert(v);
  const char* unnamed[] = {"futureBySymbol", "6666661", "7777772", "futureAccounts", "90000004", "futureSymbol", "8888882", "7777771"};
  const jsn::Value open = health_view::shadowSim(*v, false);
  const std::string text = jsn::dump(open);
  for (const char* s : unnamed) assert(text.find(s) == std::string::npos);
  // what IS named survives; a named key holding an object is not a scalar
  assert(open.get("latencyMs").asNumber(0) == 250 && open.get("targetR").asNumber(0) == 3);
  assert(open.get("maxHoldMs").isNull());
  assert(open.get("costs").get("classes").get("fx").get("commissionBpsPerSide").asNumber(0) == 0.5);
  assert(open.get("costs").get("fallbackClass").asString() == "fx");
  assert(open.get("costs").get("symbolClassCount").asNumber(-1) == 1);
  // a sim that is not an object has no named key to show
  assert(health_view::shadowSim(jsn::Value("7777771"), false).isNull());
  // Positive control: the trusted view carries every one of them, so the
  // search above can fail.
  const std::string all = jsn::dump(health_view::shadowSim(*v, true));
  for (const char* s : unnamed) assert(all.find(s) != std::string::npos);
  std::puts("an unnamed field stays off the open shadow sim: ok");
}

// The sweep, as main.cpp assembles the identifier-bearing blocks it builds
// through health_view on the open /health: guard and tick.shadowSim. (main's
// tick.entry copies counts only from TickFirer::statusJson, so it has no id
// to gate. That main.cpp passes the caller's trust, not a literal, is pinned
// from source in agent/services/sidecar-pins.test.js: main.cpp is outside
// every C++ test binary.)
static void test_the_open_blocks_together_carry_no_identifier() {
  jsn::Value open{jsn::Object{}};
  open.set("guard", health_view::guard(fencedGuard(), false));
  jsn::Value tj{jsn::Object{}};
  tj.set("shadowSim", health_view::shadowSim(simWithClasses(), false));
  open.set("tick", std::move(tj));
  const std::string text = jsn::dump(open);
  assert(!containsAny(text, kAccountIds, 3) && !containsAny(text, kSymbolIds, 2));
  // Positive control: the same assembly on the trusted branch DOES print
  // every id in this form, so the search above can fail (a dump that wrote
  // 9.0000001e+07 would make the absence meaningless).
  jsn::Value trusted{jsn::Object{}};
  trusted.set("guard", health_view::guard(fencedGuard(), true));
  jsn::Value tt{jsn::Object{}};
  tt.set("shadowSim", health_view::shadowSim(simWithClasses(), true));
  trusted.set("tick", std::move(tt));
  const std::string all = jsn::dump(trusted);
  for (const char* id : kAccountIds) assert(all.find(id) != std::string::npos);
  for (const char* id : kSymbolIds) assert(all.find(id) != std::string::npos);
  std::puts("the open blocks together carry no account or symbol id: ok");
}

int main() {
  test_the_open_guard_carries_counts_not_account_ids();
  test_the_open_shadow_sim_carries_a_count_not_symbol_ids();
  test_an_unnamed_field_stays_off_the_open_shadow_sim();
  test_the_open_blocks_together_carry_no_identifier();
  std::puts("test_health_view: all passed");
  return 0;
}
