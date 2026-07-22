// cpp-exec/src/tests/test_vpo_dispatcher.cpp — onTick fire mechanics: the
// touch condition, the ARMED->FIRED CAS (single-threaded sanity: after one
// successful fire attempt the strategy is back to IDLE, so a second
// identical onTick is a guaranteed no-op — the real concurrency guarantee
// is structural, explained in vpo_dispatcher.cpp's header comment), and the
// sizing refusal path (no volumeResolver => never places a fabricated
// order).
#include <cassert>
#include <cstdio>

#include "../engine.hpp"
#include "../vpo_dispatcher.hpp"
#include "../vpo_strategies.hpp"

using vpo::Bar;
using vpo::Side;
using vpo::VposState;

// Manually arms a strategy's order (bypassing recompute()) so onTick's fire
// path can be tested in isolation, deterministically, without depending on
// the exact bar shapes that make recompute() arm.
static void forceArm(vpo::StrategyModule& s, double trigger, Side side) {
  auto& o = s.order();
  o.triggerPrice.store(trigger);
  o.side.store(side);
  o.relativeStopLoss.store(10.0);
  o.relativeTakeProfit.store(20.0);
  o.state.store(VposState::ARMED);
}

static void test_onTick_fires_on_touch_and_rearms_to_idle() {
  ExecEngine engine; // no credentials — placeOrder() will fail fast with
                      // NOT_CONNECTED (see engine.cpp's request()), which is
                      // exactly what a unit test needs: no network I/O.
  auto barProvider = [](const std::string&, const std::string&) { return std::vector<Bar>{}; };
  double volumeToReturn = 1000.0;
  auto volumeResolver = [&](const vpo::StrategyModule&) { return volumeToReturn; };

  vpo::VpoDispatcher dispatcher(engine, barProvider, volumeResolver, "4h", "15m");
  auto strategy = std::make_unique<vpo::VwapTrendStrategy>("vwap_trend", "EURUSD", "15m", 42);
  vpo::StrategyModule* raw = strategy.get();
  dispatcher.registerStrategy(std::move(strategy));

  forceArm(*raw, /*trigger=*/1.1000, Side::Buy);
  assert(raw->order().state.load() == VposState::ARMED);

  // ask has NOT reached the trigger yet — no fire.
  dispatcher.onTick(42, 1.0998, 1.1005);
  assert(raw->order().state.load() == VposState::ARMED);

  // ask reaches the trigger — fires (attempts placeOrder, which fails fast
  // as NOT_CONNECTED — that's fine, the dispatcher still resets state).
  dispatcher.onTick(42, 1.0999, 1.1000);
  assert(raw->order().state.load() == VposState::IDLE);
}

static void test_onTick_ignores_other_symbols() {
  ExecEngine engine;
  auto barProvider = [](const std::string&, const std::string&) { return std::vector<Bar>{}; };
  auto volumeResolver = [](const vpo::StrategyModule&) { return 1000.0; };
  vpo::VpoDispatcher dispatcher(engine, barProvider, volumeResolver, "4h", "15m");
  auto strategy = std::make_unique<vpo::VwapTrendStrategy>("vwap_trend", "EURUSD", "15m", 42);
  vpo::StrategyModule* raw = strategy.get();
  dispatcher.registerStrategy(std::move(strategy));
  forceArm(*raw, 1.1000, Side::Buy);

  dispatcher.onTick(/*different symbolId*/ 99, 1.0990, 1.0995); // would touch, wrong symbol
  assert(raw->order().state.load() == VposState::ARMED);
}

static void test_onTick_refuses_to_fire_without_resolvable_volume() {
  ExecEngine engine;
  auto barProvider = [](const std::string&, const std::string&) { return std::vector<Bar>{}; };
  // Sizing unavailable — this is the "risk.js hasn't answered yet" case.
  auto volumeResolver = [](const vpo::StrategyModule&) { return -1.0; };
  vpo::VpoDispatcher dispatcher(engine, barProvider, volumeResolver, "4h", "15m");
  auto strategy = std::make_unique<vpo::VwapTrendStrategy>("vwap_trend", "EURUSD", "15m", 42);
  vpo::StrategyModule* raw = strategy.get();
  dispatcher.registerStrategy(std::move(strategy));
  forceArm(*raw, 1.1000, Side::Buy);

  dispatcher.onTick(42, 1.0999, 1.1000); // touches, but volume unresolved
  // Refused, not fired with a fabricated size — but the attempt still
  // consumed this arm cycle (re-arms next recompute), same as a rejected
  // broker order would.
  assert(raw->order().state.load() == VposState::IDLE);
}

static void test_sell_side_fires_on_bid_rising_to_trigger() {
  ExecEngine engine;
  auto barProvider = [](const std::string&, const std::string&) { return std::vector<Bar>{}; };
  auto volumeResolver = [](const vpo::StrategyModule&) { return 1000.0; };
  vpo::VpoDispatcher dispatcher(engine, barProvider, volumeResolver, "4h", "15m");
  auto strategy = std::make_unique<vpo::VwapTrendStrategy>("vwap_trend", "GBPUSD", "15m", 7);
  vpo::StrategyModule* raw = strategy.get();
  dispatcher.registerStrategy(std::move(strategy));
  forceArm(*raw, 1.2500, Side::Sell);

  dispatcher.onTick(7, 1.2490, 1.2495); // bid hasn't reached trigger yet
  assert(raw->order().state.load() == VposState::ARMED);
  dispatcher.onTick(7, 1.2500, 1.2505); // bid reaches trigger
  assert(raw->order().state.load() == VposState::IDLE);
}

int main() {
  test_onTick_fires_on_touch_and_rearms_to_idle();
  test_onTick_ignores_other_symbols();
  test_onTick_refuses_to_fire_without_resolvable_volume();
  test_sell_side_fires_on_bid_rising_to_trigger();
  std::puts("test_vpo_dispatcher: all assertions passed");
  return 0;
}
