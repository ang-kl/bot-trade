// cpp-exec/src/tests/test_engine_send_boundary.cpp — the guard is re-read
// under the execution mutex immediately before the send (10-09-2026).
//
// Before: validateOrder ran BEFORE mtx_; an order could validate, wait behind
// a slow reconcile, and be sent after /config had set the halt. The test seam
// flips the halt while the order is "queued" (under the lock, before the
// recheck): the order must come back guard_halt, not travel on to the socket.
#include <cassert>
#include <cstdio>
#include <string>

#include "../engine.hpp"
#include "../order_guard.hpp"

static jsn::Value marketOrder() {
  jsn::Value o{jsn::Object{}};
  o.set("ctidTraderAccountId", 4002.0);
  o.set("symbolId", 1.0);
  o.set("orderType", std::string("MARKET"));
  o.set("tradeSide", std::string("BUY"));
  o.set("volume", 1000.0);
  o.set("relativeStopLoss", 100.0);
  o.set("relativeTakeProfit", 200.0);
  return o;
}

static void test_halt_set_while_queued_refuses_the_send() {
  ExecEngine e;
  const jsn::Value o = marketOrder();
  // Sanity: with no halt and no socket, the order reaches the transport.
  EngineResult before = e.placeOrder(o);
  assert(!before.ok);
  assert(before.body.get("errorCode").asString() == "NOT_CONNECTED");

  e.setPreSendHookForTests([&e] { e.guard().setHalt(true); });
  EngineResult r = e.placeOrder(o);
  assert(!r.ok);
  const std::string code = r.body.get("errorCode").asString();
  assert(code.find("guard_halt") != std::string::npos);
  assert(r.body.get("description").asString().find("queued") != std::string::npos);
  e.guard().setHalt(false);
}

static void test_account_halt_set_while_queued_refuses_the_send() {
  ExecEngine e;
  e.setPreSendHookForTests([&e] { e.guard().setHaltAccounts({4002}); });
  EngineResult r = e.placeOrder(marketOrder());
  assert(!r.ok);
  assert(r.body.get("errorCode").asString().find("account_halted") != std::string::npos);
}


// GW-1 (WP-D D3, gap 1c): a permitted entry that never reached the wire
// (NOT_CONNECTED — ticket.failed) spends no slot: the hook is not called.
static void test_an_entry_that_never_left_does_not_call_the_entry_hook() {
  ExecEngine e;
  int calls = 0;
  e.setEntrySentHook([&calls](long long, const std::string&) { ++calls; });
  e.guard().setEntryEpochs({{4002, 3}});
  jsn::Value o = marketOrder();
  jsn::Value permit{jsn::Object{}};
  permit.set("id", std::string("pnc1"));
  permit.set("intentId", std::string("inc1"));
  permit.set("accountId", 4002.0);
  permit.set("epoch", 3.0);
  permit.set("expiresAtMs", 9000000000000.0);
  o.set("permit", permit);
  EngineResult r = e.placeOrder(o);
  assert(!r.ok && r.body.get("errorCode").asString() == "NOT_CONNECTED");
  assert(calls == 0);
}

int main() {
  test_halt_set_while_queued_refuses_the_send();
  test_account_halt_set_while_queued_refuses_the_send();
  test_an_entry_that_never_left_does_not_call_the_entry_hook();
  std::puts("test_engine_send_boundary: all assertions passed");
  return 0;
}
