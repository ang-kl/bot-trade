// cpp-exec/src/tests/test_permit_check.cpp — P2a (11-09-2026): the one-use
// permit at the send boundary. validatePermit() is the pure rule; the engine
// applies it under the execution mutex immediately before the send, after
// the P1a guard recheck, and strips the ledger's fields from the wire.
#include <cassert>
#include <cstdio>
#include <set>
#include <string>

#include "../decision_ring.hpp"
#include "../engine.hpp"
#include "../order_guard.hpp"

static jsn::Value marketOrder(long long acct = 4002) {
  jsn::Value o{jsn::Object{}};
  o.set("ctidTraderAccountId", static_cast<double>(acct));
  o.set("symbolId", 1.0);
  o.set("orderType", std::string("MARKET"));
  o.set("tradeSide", std::string("BUY"));
  o.set("volume", 1000.0);
  o.set("relativeStopLoss", 100.0);
  o.set("relativeTakeProfit", 200.0);
  o.set("label", std::string("AU|v1|VWAP|H|LN|4h|TR|iabc123456789"));
  return o;
}

static jsn::Value permitFor(const jsn::Value& o, long long epoch, double expiresAtMs,
                            const std::string& id = "p1", const std::string& intent = "iabc123456789") {
  jsn::Value p{jsn::Object{}};
  p.set("id", id);
  p.set("intentId", intent);
  p.set("accountId", o.get("ctidTraderAccountId"));
  p.set("symbolId", o.get("symbolId"));
  p.set("side", o.get("tradeSide"));
  p.set("volume", o.get("volume"));
  p.set("epoch", static_cast<double>(epoch));
  p.set("expiresAtMs", expiresAtMs);
  return p;
}

static GuardSnapshot fenced(long long acct, long long epoch) {
  OrderGuard g;
  g.setEntryEpochs({{acct, epoch}});
  return g.snapshot();
}

static bool startsWith(const std::string& s, const std::string& p) { return s.rfind(p, 0) == 0; }

static void test_unfenced_account_needs_no_permit_but_a_bad_one_is_still_refused() {
  OrderGuard g;
  const GuardSnapshot snap = g.snapshot();
  std::set<std::string> used;
  PermitVerdict v = validatePermit(marketOrder(), snap, used, 1000);
  assert(v.ok && v.permitId.empty() && v.intentId.empty());
  jsn::Value o = marketOrder();
  o.set("permit", permitFor(o, 0, 500)); // expired
  v = validatePermit(o, snap, used, 1000);
  assert(!v.ok && v.reason == "permit_expired");
  o.set("permit", permitFor(o, 0, 5000));
  v = validatePermit(o, snap, used, 1000);
  assert(v.ok && v.permitId == "p1" && v.intentId == "iabc123456789");
  assert(used.count("p1") == 1);
}

static void test_fenced_account_refuses_missing_stale_expired_mismatch_malformed_and_reuse() {
  const GuardSnapshot snap = fenced(4002, 3);
  std::set<std::string> used;
  jsn::Value o = marketOrder();
  PermitVerdict v = validatePermit(o, snap, used, 1000);
  assert(!v.ok && startsWith(v.reason, "permit_missing"));
  assert(v.reason.find("(3)") != std::string::npos);

  o.set("permit", permitFor(o, 2, 5000));
  v = validatePermit(o, snap, used, 1000);
  assert(!v.ok && startsWith(v.reason, "permit_epoch_stale: permit epoch 2, account epoch 3"));

  o.set("permit", permitFor(o, 3, 500));
  v = validatePermit(o, snap, used, 1000);
  assert(!v.ok && v.reason == "permit_expired");

  { jsn::Value bad = permitFor(o, 3, 5000); bad.set("volume", 999.0); o.set("permit", bad);
    v = validatePermit(o, snap, used, 1000); assert(!v.ok && startsWith(v.reason, "permit_mismatch")); }
  { jsn::Value bad = permitFor(o, 3, 5000); bad.set("side", std::string("SELL")); o.set("permit", bad);
    v = validatePermit(o, snap, used, 1000); assert(!v.ok && startsWith(v.reason, "permit_mismatch")); }
  { jsn::Value bad = permitFor(o, 3, 5000); bad.set("accountId", 4003.0); o.set("permit", bad);
    v = validatePermit(o, snap, used, 1000); assert(!v.ok && startsWith(v.reason, "permit_mismatch")); }
  { jsn::Value bad = permitFor(o, 3, 5000); bad.set("symbolId", 2.0); o.set("permit", bad);
    v = validatePermit(o, snap, used, 1000); assert(!v.ok && startsWith(v.reason, "permit_mismatch")); }
  { jsn::Value bad = permitFor(o, 3, 5000, "", "iabc123456789"); o.set("permit", bad);
    v = validatePermit(o, snap, used, 1000); assert(!v.ok && startsWith(v.reason, "permit_malformed")); }
  assert(used.empty()); // nothing consumed by a refusal

  o.set("permit", permitFor(o, 3, 5000));
  v = validatePermit(o, snap, used, 1000);
  assert(v.ok && v.permitId == "p1" && v.intentId == "iabc123456789");
  assert(used.count("p1") == 1);
  v = validatePermit(o, snap, used, 1000);
  assert(!v.ok && startsWith(v.reason, "permit_consumed: p1"));
  // a symbol-less permit (the keeper reserved by symbol name) matches any symbol
  { jsn::Value p = permitFor(o, 3, 5000, "p2"); p.set("symbolId", jsn::Value(nullptr)); o.set("permit", p);
    v = validatePermit(o, snap, used, 1000); assert(v.ok && v.permitId == "p2"); }
}

static void test_no_waiver_a_vpo_fire_on_a_fenced_account_needs_its_permit_too() {
  // P2a-2: the tier's fires carry the keeper's pre-issued permits, so the
  // marker an earlier draft waived on is just another field the boundary
  // ignores — a fenced account's order without a permit is refused.
  const GuardSnapshot snap = fenced(4002, 3);
  std::set<std::string> used;
  jsn::Value o = marketOrder();
  o.set("label", std::string("vpo:vwap_trend"));
  PermitVerdict v = validatePermit(o, snap, used, 1000);
  assert(!v.ok && startsWith(v.reason, "permit_missing"));
  o.set("permit", permitFor(o, 3, 5000));
  v = validatePermit(o, snap, used, 1000);
  assert(v.ok && v.permitId == "p1");
}

static void test_wire_payload_carries_no_ledger_fields() {
  jsn::Value o = marketOrder();
  o.set("permit", permitFor(o, 3, 5000));
  o.set("intentId", std::string("iabc123456789"));
  const jsn::Value w = wireOrderPayload(o);
  assert(w.isObject());
  assert(w.get("permit").isNull() && w.get("intentId").isNull());
  assert(w.get("ctidTraderAccountId").asNumber(0) == 4002);
  assert(w.get("label").asString() == "AU|v1|VWAP|H|LN|4h|TR|iabc123456789"); // the tag stays: it is the broker's own record of the intent
  assert(w.get("volume").asNumber(0) == 1000.0);
  assert(w.asObject().size() == o.asObject().size() - 2);
}

static void test_engine_boundary_refuses_without_a_permit_once_fenced_and_passes_one_use_with_one() {
  ExecEngine e;
  DecisionRing ring(64);
  e.setDecisionRing(&ring);
  const jsn::Value o = marketOrder();
  // Sanity: unfenced and no socket → the order reaches the transport.
  EngineResult before = e.placeOrder(o);
  assert(!before.ok && before.body.get("errorCode").asString() == "NOT_CONNECTED");

  e.guard().setEntryEpochs({{4002, 3}});
  EngineResult r = e.placeOrder(o);
  assert(!r.ok && startsWith(r.body.get("errorCode").asString(), "permit_missing"));

  const double far = 4102444800000.0; // 2100-01-01
  jsn::Value withPermit = marketOrder();
  withPermit.set("permit", permitFor(withPermit, 3, far));
  withPermit.set("intentId", std::string("iabc123456789"));
  EngineResult r2 = e.placeOrder(withPermit);
  assert(!r2.ok && r2.body.get("errorCode").asString() == "NOT_CONNECTED"); // past the boundary, at the transport
  EngineResult r3 = e.placeOrder(withPermit);
  assert(!r3.ok && startsWith(r3.body.get("errorCode").asString(), "permit_consumed")); // one use

  // the epoch moves while the order is queued: refused at the boundary, not sent
  jsn::Value queued = marketOrder();
  queued.set("permit", permitFor(queued, 3, far, "p9", "ixyz123456789"));
  e.setPreSendHookForTests([&e] { e.guard().setEntryEpochs({{4002, 4}}); });
  EngineResult r4 = e.placeOrder(queued);
  assert(!r4.ok && startsWith(r4.body.get("errorCode").asString(), "permit_epoch_stale"));
  e.setPreSendHookForTests(std::function<void()>{});

  // a VPO-labelled fire without a permit is refused like any other (no waiver)
  jsn::Value fire = marketOrder();
  fire.set("label", std::string("vpo:vwap_trend"));
  EngineResult r5 = e.placeOrder(fire);
  assert(!r5.ok && startsWith(r5.body.get("errorCode").asString(), "permit_missing"));
  bool waived = false, refusedWithIntent = false, submitWithIntent = false;
  for (const auto& rec : ring.since(0)) {
    if (rec.kind == "permit_waived") waived = true;
    if (rec.component == "order_guard" && rec.kind == "refused_at_send" && rec.detail == "intent=ixyz123456789") refusedWithIntent = true;
    if (rec.component == "engine" && rec.kind == "order_submit" && rec.detail == "intent=iabc123456789") submitWithIntent = true;
  }
  assert(!waived && refusedWithIntent && submitWithIntent);
}

int main() {
  test_unfenced_account_needs_no_permit_but_a_bad_one_is_still_refused();
  test_fenced_account_refuses_missing_stale_expired_mismatch_malformed_and_reuse();
  test_no_waiver_a_vpo_fire_on_a_fenced_account_needs_its_permit_too();
  test_wire_payload_carries_no_ledger_fields();
  test_engine_boundary_refuses_without_a_permit_once_fenced_and_passes_one_use_with_one();
  std::puts("test_permit_check: all passed");
  return 0;
}
