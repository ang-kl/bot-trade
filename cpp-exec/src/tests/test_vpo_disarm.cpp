// cpp-exec/src/tests/test_vpo_disarm.cpp — P2a (11-09-2026): the keeper's
// DISARM. The P1b arming fence only withheld the next push, so a strategy
// armed before a STOPPED switch could still fire until the store aged its
// bars out (5 min). Now the store is cleared and every strategy not mid-fire
// is idled at once, and the next recompute keeps them idle.
#include <cassert>
#include <cstdio>
#include <memory>
#include <string>
#include <vector>

#include "../engine.hpp"
#include "../vpo_config_store.hpp"
#include "../vpo_dispatcher.hpp"
#include "../vpo_strategy.hpp"

using vpo::Bar;
using vpo::VposState;

// Arms only when it has bars — the production strategies' shape (empty
// swings/levels → disarm), so a cleared store keeps it idle.
struct ArmWithBars : vpo::StrategyModule {
  using StrategyModule::StrategyModule;
  void recompute(const std::vector<Bar>&, const std::vector<Bar>& micro) override {
    if (micro.empty()) { vpo::idleUnlessFired(order()); return; }
    order().triggerPrice.store(1.2345);
    vpo::armUnlessFired(order());
  }
};

static void test_store_clear_forgets_bars_and_volumes() {
  vpo::VpoConfigStore store;
  store.setBars("EURUSD", "15m", {Bar{1, 1, 1, 1, 1, 1}});
  store.setVolume("raw:EURUSD", 1000);
  assert(!store.getBars("EURUSD", "15m").empty());
  assert(store.getVolume("raw:EURUSD") == 1000);
  store.clear();
  assert(store.getBars("EURUSD", "15m").empty());
  assert(store.getVolume("raw:EURUSD") == -1);
}

static void test_disarm_all_idles_armed_strategies_leaves_a_pending_fire_and_the_cleared_store_keeps_them_idle() {
  ExecEngine engine;
  vpo::VpoConfigStore store;
  auto barProvider = [&store](const std::string& symbol, const std::string& tf) { return store.getBars(symbol, tf); };
  auto volumeResolver = [&store](const vpo::StrategyModule& s) { return store.getVolume(s.key() + ":" + s.order().symbol); };
  vpo::VpoDispatcher d(engine, barProvider, volumeResolver, "4h", "15m");
  auto a = std::make_unique<ArmWithBars>("raw", "EURUSD", "15m", 42);
  auto b = std::make_unique<ArmWithBars>("raw", "GBPUSD", "15m", 43);
  auto c = std::make_unique<ArmWithBars>("raw", "USDJPY", "15m", 44);
  ArmWithBars* pa = a.get(); ArmWithBars* pb = b.get(); ArmWithBars* pc = c.get();
  d.registerStrategy(std::move(a));
  d.registerStrategy(std::move(b));
  d.registerStrategy(std::move(c));
  d.setAccountId(4002);
  for (const char* s : {"EURUSD", "GBPUSD", "USDJPY"}) store.setBars(s, "15m", {Bar{1, 1, 1, 1, 1, 1}});
  d.recomputeAll();
  assert(pa->order().state.load() == VposState::ARMED);
  assert(pb->order().state.load() == VposState::ARMED);
  assert(pc->order().state.load() == VposState::ARMED);
  pc->order().state.store(VposState::FIRED); // a fire in flight owns its setup

  assert(d.statusJson().find("\"lastDisarmAt\":null") != std::string::npos);
  store.clear();
  const size_t idled = d.disarmAll();
  assert(idled == 2);
  assert(pa->order().state.load() == VposState::IDLE);
  assert(pb->order().state.load() == VposState::IDLE);
  assert(pc->order().state.load() == VposState::FIRED);
  assert(d.disarmAll() == 0); // idempotent
  d.recomputeAll();            // no bars: stays idle
  assert(pa->order().state.load() == VposState::IDLE);
  assert(pb->order().state.load() == VposState::IDLE);
  const std::string st = d.statusJson();
  assert(st.find("\"lastDisarmAt\":") != std::string::npos && st.find("\"lastDisarmAt\":null") == std::string::npos);
  // the fire resolves and the store is fed again: arming resumes on evidence
  pc->resetAfterFire();
  store.setBars("EURUSD", "15m", {Bar{1, 1, 1, 1, 1, 1}});
  d.recomputeAll();
  assert(pa->order().state.load() == VposState::ARMED);
  assert(pb->order().state.load() == VposState::IDLE);
}


// ---------------------------------------------------------------------------
// P2a-2: the keeper's pre-issued permits ride with every fire.
// ---------------------------------------------------------------------------
#include "../decision_ring.hpp"
#include "../order_guard.hpp"

static jsn::Value fakePermit(const std::string& id, long long epoch) {
  jsn::Value p{jsn::Object{}};
  p.set("id", id);
  p.set("intentId", std::string("i") + id);
  p.set("accountId", 4002.0);
  p.set("symbolId", 42.0);
  p.set("side", std::string("BUY"));
  p.set("volume", 1000.0);
  p.set("epoch", static_cast<double>(epoch));
  p.set("expiresAtMs", 4102444800000.0);
  return p;
}

static void test_store_permits_round_trip_age_out_and_clear() {
  vpo::VpoConfigStore store;
  assert(store.getPermit("raw:EURUSD:BUY").isNull());
  store.setPermit("raw:EURUSD:BUY", fakePermit("p1", 3));
  assert(store.getPermit("raw:EURUSD:BUY").get("id").asString() == "p1");
  store.clear();
  assert(store.getPermit("raw:EURUSD:BUY").isNull());
  vpo::VpoConfigStore stale(/*maxAgeMs=*/-1);
  stale.setPermit("raw:EURUSD:BUY", fakePermit("p2", 3));
  assert(stale.getPermit("raw:EURUSD:BUY").isNull()); // the keeper stopped refreshing it
}

static void test_a_fire_carries_the_stored_permit_and_is_refused_without_one_on_a_fenced_account() {
  int runPermitTest = 0;
  for (int withPermit = 1; withPermit >= 0; --withPermit) {
    ExecEngine engine;
    DecisionRing ring(64);
    engine.setDecisionRing(&ring);
    engine.guard().setEntryEpochs({{4002, 3}});
    vpo::VpoConfigStore store;
    auto barProvider = [&store](const std::string& symbol, const std::string& tf) { return store.getBars(symbol, tf); };
    auto volumeResolver = [](const vpo::StrategyModule&) { return 1000.0; };
    vpo::VpoDispatcher d(engine, barProvider, volumeResolver, "4h", "15m");
    d.setDecisionRing(&ring);
    d.setPermitResolver([&store](const vpo::StrategyModule& s, vpo::Side side) {
      return store.getPermit(s.key() + ":" + s.order().symbol + ":" + (side == vpo::Side::Buy ? "BUY" : "SELL"));
    });
    auto a = std::make_unique<ArmWithBars>("raw", "EURUSD", "15m", 42);
    ArmWithBars* pa = a.get();
    d.registerStrategy(std::move(a));
    d.setAccountId(4002);
    if (withPermit) store.setPermit("raw:EURUSD:BUY", fakePermit("p1", 3));
    pa->order().state.store(VposState::ARMED);
    pa->order().triggerPrice.store(1.1000);
    pa->order().side.store(vpo::Side::Buy);
    d.onTick(42, 1.0995, 1.0999); // ask <= trigger: fires synchronously (dispatcher not started)
    const auto o = d.outcomes();
    assert(o.triggered == 1);
    assert(o.permitMissing == (withPermit ? 0u : 1u));
    bool sawSubmit = false, sawMissing = false;
    for (const auto& rec : ring.since(0)) {
      if (rec.component == "engine" && rec.kind == "order_submit" && rec.detail == "intent=ip1") sawSubmit = true;
      if (rec.component == "order_guard" && rec.kind == "refused_at_send" && rec.code.rfind("permit_missing", 0) == 0) sawMissing = true;
    }
    if (withPermit) { assert(sawSubmit && !sawMissing); assert(o.failed == 1); /* NOT_CONNECTED past the boundary */ }
    else { assert(!sawSubmit && sawMissing); assert(o.failed == 1); }
    runPermitTest++;
  }
  assert(runPermitTest == 2);
}

int main() {
  test_store_clear_forgets_bars_and_volumes();
  test_disarm_all_idles_armed_strategies_leaves_a_pending_fire_and_the_cleared_store_keeps_them_idle();
  test_store_permits_round_trip_age_out_and_clear();
  test_a_fire_carries_the_stored_permit_and_is_refused_without_one_on_a_fenced_account();
  std::puts("test_vpo_disarm: all passed");
  return 0;
}
