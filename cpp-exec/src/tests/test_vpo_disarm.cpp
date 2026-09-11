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

int main() {
  test_store_clear_forgets_bars_and_volumes();
  test_disarm_all_idles_armed_strategies_leaves_a_pending_fire_and_the_cleared_store_keeps_them_idle();
  std::puts("test_vpo_disarm: all passed");
  return 0;
}
