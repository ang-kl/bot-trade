// cpp-exec/src/tests/test_order_guard.cpp — bracket guarantee + atomic block.
#include <cassert>
#include <cstdio>

#include "../order_guard.hpp"

static jsn::Value marketOrder(bool withStop, double volume = 100) {
  jsn::Value o{jsn::Object{}};
  o.set("orderType", std::string("MARKET"));
  o.set("tradeSide", std::string("BUY"));
  o.set("volume", volume);
  if (withStop) o.set("relativeStopLoss", 50000.0);
  return o;
}

static void test_naked_market_rejected() {
  OrderGuard g; // defaults: requireBracket=true, not halted, no cap
  auto snap = g.snapshot();
  assert(snap.requireBracket);
  // No stop → rejected as naked.
  OrderVerdict v = validateOrder(marketOrder(false), snap);
  assert(!v.ok);
  assert(v.reason.find("guard_naked_order") != std::string::npos);
  // With a stop → allowed.
  assert(validateOrder(marketOrder(true), snap).ok);
}

static void test_allow_naked_override() {
  OrderGuard g;
  jsn::Value o = marketOrder(false);
  o.set("allowNaked", true);
  assert(validateOrder(o, g.snapshot()).ok); // explicit override honoured
}

static void test_absolute_stop_counts_as_bracket() {
  OrderGuard g;
  jsn::Value o = marketOrder(false);
  o.set("stopLoss", 1.2345); // absolute SL, not relative
  assert(orderHasBracket(o));
  assert(validateOrder(o, g.snapshot()).ok);
}

static void test_pending_orders_exempt() {
  OrderGuard g;
  jsn::Value o = marketOrder(false);
  o.set("orderType", std::string("LIMIT")); // resting order — not a naked market fill
  assert(validateOrder(o, g.snapshot()).ok);
}

static void test_halt_kill_switch() {
  OrderGuard g;
  g.setHalt(true);
  OrderVerdict v = validateOrder(marketOrder(true), g.snapshot());
  assert(!v.ok);
  assert(v.reason.find("guard_halt") != std::string::npos);
  g.setHalt(false);
  assert(validateOrder(marketOrder(true), g.snapshot()).ok);
}

static void test_volume_cap() {
  OrderGuard g;
  g.setMaxOrderVolume(1000);
  assert(validateOrder(marketOrder(true, 999), g.snapshot()).ok);
  OrderVerdict v = validateOrder(marketOrder(true, 1001), g.snapshot());
  assert(!v.ok);
  assert(v.reason.find("guard_volume_cap") != std::string::npos);
}

static void test_require_bracket_toggle() {
  OrderGuard g;
  g.setRequireBracket(false); // strategy explicitly disables the guarantee
  assert(validateOrder(marketOrder(false), g.snapshot()).ok);
}

int main() {
  test_naked_market_rejected();
  test_allow_naked_override();
  test_absolute_stop_counts_as_bracket();
  test_pending_orders_exempt();
  test_halt_kill_switch();
  test_volume_cap();
  test_require_bracket_toggle();
  std::puts("test_order_guard: all assertions passed");
  return 0;
}
