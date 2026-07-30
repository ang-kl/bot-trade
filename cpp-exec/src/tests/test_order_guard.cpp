// cpp-exec/src/tests/test_order_guard.cpp — bracket guarantee + atomic block.
#include <cassert>
#include <cstdio>

#include "../order_guard.hpp"

// Every order names its account. PHASE 2 (owner, 2026-07-30) made an unstamped
// operation a REFUSAL rather than a silent default to the session primary, so a
// helper that omitted it would make every other assertion here test the wrong
// rejection.
static jsn::Value marketOrder(bool withStop, double volume = 100, bool withTarget = true) {
  jsn::Value o{jsn::Object{}};
  o.set("orderType", std::string("MARKET"));
  o.set("tradeSide", std::string("BUY"));
  o.set("volume", volume);
  o.set("ctidTraderAccountId", 4002.0);
  if (withStop) o.set("relativeStopLoss", 50000.0);
  if (withTarget) o.set("relativeTakeProfit", 50000.0);
  return o;
}

// PHASE 2 — an order that does not name an account is refused, not routed to the
// session primary. The primary is elected once per broker session and then
// frozen (engine.cpp setCredentials' sameSession branch never reorders
// accountIds_), so the old default gave every unstamped operation ONE
// destination regardless of which account the caller meant: on any non-primary
// account, positions opened and were then never managed.
static void test_missing_account_rejected() {
  OrderGuard g;
  auto snap = g.snapshot();
  jsn::Value o = marketOrder(true);
  // A fully valid order minus the account.
  jsn::Value noAcct{jsn::Object{}};
  noAcct.set("orderType", std::string("MARKET"));
  noAcct.set("tradeSide", std::string("BUY"));
  noAcct.set("volume", 100.0);
  noAcct.set("relativeStopLoss", 50000.0);
  noAcct.set("relativeTakeProfit", 50000.0);
  OrderVerdict v = validateOrder(noAcct, snap);
  assert(!v.ok);
  assert(v.reason.find("guard_no_account") != std::string::npos);
  // The same order WITH an account passes, so the account is the only difference.
  assert(validateOrder(o, snap).ok);
}

static void test_unusable_account_values_rejected() {
  OrderGuard g;
  auto snap = g.snapshot();
  // Zero, negative and non-numeric all mean "no account", never account 0.
  for (double bad : {0.0, -1.0, -4002.0}) {
    jsn::Value o = marketOrder(true);
    o.set("ctidTraderAccountId", bad);
    OrderVerdict v = validateOrder(o, snap);
    assert(!v.ok);
    assert(v.reason.find("guard_no_account") != std::string::npos);
  }
  // A STRING account id is not a number — refused rather than coerced.
  jsn::Value str = marketOrder(true);
  str.set("ctidTraderAccountId", std::string("4002"));
  assert(!validateOrder(str, snap).ok);
}

static void test_halt_outranks_missing_account() {
  // The kill switch is checked first, so a halted desk reports the halt rather
  // than a routing complaint — the more urgent fact for whoever is reading.
  OrderGuard g;
  g.setHalt(true);
  jsn::Value noAcct{jsn::Object{}};
  noAcct.set("orderType", std::string("MARKET"));
  OrderVerdict v = validateOrder(noAcct, g.snapshot());
  assert(!v.ok);
  assert(v.reason.find("guard_halt") != std::string::npos);
}

// A pending LIMIT order is exempt from the bracket rules but NOT from naming its
// account — routing is not a risk policy that a pending order gets to skip.
static void test_pending_order_still_needs_an_account() {
  OrderGuard g;
  jsn::Value o{jsn::Object{}};
  o.set("orderType", std::string("LIMIT"));
  o.set("volume", 100.0);
  OrderVerdict v = validateOrder(o, g.snapshot());
  assert(!v.ok);
  assert(v.reason.find("guard_no_account") != std::string::npos);
  o.set("ctidTraderAccountId", 4001.0);
  assert(validateOrder(o, g.snapshot()).ok);
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
  test_missing_account_rejected();
  test_unusable_account_values_rejected();
  test_halt_outranks_missing_account();
  test_pending_order_still_needs_an_account();
  std::puts("test_order_guard: all assertions passed");
  return 0;
}
