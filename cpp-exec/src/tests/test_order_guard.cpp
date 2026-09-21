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

// Missing account is reported first; once routed, a pending LIMIT still needs
// its complete bracket because it can fill asynchronously.
static void test_pending_order_still_needs_an_account() {
  OrderGuard g;
  jsn::Value o{jsn::Object{}};
  o.set("orderType", std::string("LIMIT"));
  o.set("volume", 100.0);
  OrderVerdict v = validateOrder(o, g.snapshot());
  assert(!v.ok);
  assert(v.reason.find("guard_no_account") != std::string::npos);
  o.set("ctidTraderAccountId", 4001.0);
  assert(!validateOrder(o, g.snapshot()).ok);
  o.set("relativeStopLoss", 500.0);
  o.set("relativeTakeProfit", 500.0);
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
  OrderVerdict v = validateOrder(o, g.snapshot());
  assert(!v.ok); // the stop waiver must not waive mandatory TP1
  assert(v.reason.find("guard_no_target") != std::string::npos);
  o.set("relativeTakeProfit", 500.0);
  assert(validateOrder(o, g.snapshot()).ok); // explicit stop waiver, TP1 present
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
  o.set("orderType", std::string("LIMIT"));
  OrderVerdict v = validateOrder(o, g.snapshot());
  assert(!v.ok); // a resting entry can fill and must carry its protection
  o.set("relativeStopLoss", 500.0);
  o.set("relativeTakeProfit", 500.0);
  assert(validateOrder(o, g.snapshot()).ok);
}

static void test_stop_variants_and_numeric_enums_require_tp() {
  OrderGuard g;
  for (const char* type : {"STOP", "STOP_LIMIT"}) {
    jsn::Value o = marketOrder(true);
    o.set("orderType", std::string(type));
    o.set("relativeTakeProfit", jsn::Value(nullptr));
    OrderVerdict v = validateOrder(o, g.snapshot());
    assert(!v.ok && v.reason.find("guard_no_target") != std::string::npos);
  }
  for (double code : {2.0, 3.0, 6.0}) {
    jsn::Value o = marketOrder(true);
    o.set("orderType", code);
    o.set("relativeTakeProfit", jsn::Value(nullptr));
    OrderVerdict v = validateOrder(o, g.snapshot());
    assert(!v.ok && v.reason.find("guard_no_target") != std::string::npos);
  }
}

static void test_unsupported_order_types_fail_closed() {
  OrderGuard g;
  for (double code : {4.0, 999.0, 2.5}) {
    jsn::Value o = marketOrder(true);
    o.set("orderType", code);
    OrderVerdict v = validateOrder(o, g.snapshot());
    assert(!v.ok && v.reason.find("guard_bad_payload") != std::string::npos);
  }
  for (const char* type : {"2", "UNKNOWN"}) {
    jsn::Value o = marketOrder(true);
    o.set("orderType", std::string(type));
    OrderVerdict v = validateOrder(o, g.snapshot());
    assert(!v.ok && v.reason.find("guard_bad_payload") != std::string::npos);
  }
  jsn::Value booleanType = marketOrder(true);
  booleanType.set("orderType", true);
  assert(!validateOrder(booleanType, g.snapshot()).ok);
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
  g.setRequireTarget(false); // legacy knob cannot disable the invariant
  assert(g.snapshot().requireTarget);
  OrderVerdict v = validateOrder(marketOrder(true, 100, false), g.snapshot());
  assert(!v.ok && v.reason.find("guard_no_target") != std::string::npos);
}

// Per-account halts (2026-08-31 supervision plan). The set must bind ONLY the
// listed account — halting one tripped account on a shared sidecar must not
// touch its neighbours (owner 30-07: per-account is the whole point of the
// equity stop) — and an EMPTY set must leave behaviour byte-identical to the
// pre-haltAccounts guard.
static void test_halt_accounts_scoped() {
  OrderGuard g;
  // Empty set: today's behaviour, untouched.
  assert(validateOrder(marketOrder(true), g.snapshot()).ok);
  g.setHaltAccounts({4002});
  OrderVerdict v = validateOrder(marketOrder(true), g.snapshot()); // account 4002
  assert(!v.ok);
  assert(v.reason.find("account_halted") != std::string::npos);
  // A different account on the same process still trades.
  jsn::Value other = marketOrder(true);
  other.set("ctidTraderAccountId", 4003.0);
  assert(validateOrder(other, g.snapshot()).ok);
  // Full replace clears it — the declarative sync's un-halt path.
  g.setHaltAccounts({});
  assert(validateOrder(marketOrder(true), g.snapshot()).ok);
}

int main() {
  test_halt_accounts_scoped();
  test_naked_market_rejected();
  test_no_target_rejected();
  test_allow_naked_override();
  test_absolute_stop_and_target_count_as_bracket();
  test_pending_orders_exempt();
  test_stop_variants_and_numeric_enums_require_tp();
  test_unsupported_order_types_fail_closed();
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
