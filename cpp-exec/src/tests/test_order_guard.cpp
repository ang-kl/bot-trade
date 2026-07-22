// cpp-exec/src/tests/test_order_guard.cpp — bracket guarantee + atomic block.
#include <cassert>
#include <cstdio>

#include "../order_guard.hpp"

static jsn::Value marketOrder(bool withStop, double volume = 100, bool withTarget = true) {
  jsn::Value o{jsn::Object{}};
  o.set("orderType", std::string("MARKET"));
  o.set("tradeSide", std::string("BUY"));
  o.set("volume", volume);
  if (withStop) o.set("relativeStopLoss", 50000.0);
  if (withTarget) o.set("relativeTakeProfit", 50000.0);
  return o;
}

static void test_naked_market_rejected() {
  OrderGuard g; // defaults: requireBracket=true, requireTarget=true, not halted, no cap
  auto snap = g.snapshot();
  assert(snap.requireBracket);
  assert(snap.requireTarget);
  // No stop → rejected as naked.
  OrderVerdict v = validateOrder(marketOrder(false), snap);
  assert(!v.ok);
  assert(v.reason.find("guard_naked_order") != std::string::npos);
  // With a stop AND a target → allowed.
  assert(validateOrder(marketOrder(true), snap).ok);
}

static void test_no_target_rejected() {
  // Owner-approved 2026-07-22: "a few open trades didn't set T/P that is
  // dangerous" — an SL-only market order is refused just like a naked one.
  OrderGuard g;
  auto snap = g.snapshot();
  OrderVerdict v = validateOrder(marketOrder(true, 100, false), snap);
  assert(!v.ok);
  assert(v.reason.find("guard_no_target") != std::string::npos);
  assert(!orderHasTarget(marketOrder(true, 100, false)));
  assert(orderHasTarget(marketOrder(true, 100, true)));
}

static void test_allow_naked_override() {
  OrderGuard g;
  jsn::Value o = marketOrder(false, 100, false); // no stop, no target
  o.set("allowNaked", true);
  assert(validateOrder(o, g.snapshot()).ok); // explicit override honoured for both
}

static void test_absolute_stop_and_target_count_as_bracket() {
  OrderGuard g;
  jsn::Value o = marketOrder(false, 100, false);
  o.set("stopLoss", 1.2345);   // absolute SL, not relative
  o.set("takeProfit", 1.5000); // absolute TP, not relative
  assert(orderHasBracket(o));
  assert(orderHasTarget(o));
  assert(validateOrder(o, g.snapshot()).ok);
}

static void test_pending_orders_exempt() {
  OrderGuard g;
  jsn::Value o = marketOrder(false, 100, false);
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
  assert(validateOrder(marketOrder(false, 100, true), g.snapshot()).ok); // still has a target
}

static void test_require_target_toggle() {
  OrderGuard g;
  g.setRequireTarget(false); // strategy explicitly disables the target requirement
  assert(validateOrder(marketOrder(true, 100, false), g.snapshot()).ok);
}

int main() {
  test_naked_market_rejected();
  test_no_target_rejected();
  test_allow_naked_override();
  test_absolute_stop_and_target_count_as_bracket();
  test_pending_orders_exempt();
  test_halt_kill_switch();
  test_volume_cap();
  test_require_bracket_toggle();
  test_require_target_toggle();
  std::puts("test_order_guard: all assertions passed");
  return 0;
}
