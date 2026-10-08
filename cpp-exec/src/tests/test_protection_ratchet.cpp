#include "fake_broker.hpp"
#include "../engine.hpp"
#include "../trail_engine.hpp"
#include "../protection_ratchet.hpp"
#include "../decision_ring.hpp"
#include <cassert>
#include <future>

using namespace std::chrono_literals;

struct BrokerState {
  double sl = 92, tp = 120;
  // Codex · №12,072 · 2026-10-08; codex-footprint: confirmed-trail.
  double entryPrice = 100, afterEntryPrice = 0;
  long long afterSymbolId = 0;
  int afterDir = 0;
  int dir = 1;
  std::atomic<int> amends{0};
  std::atomic<int> mode{0}; // 1 no reconcile reply, 2 corrupt post-amend TP
  int delayAmendMs = 0;
  std::atomic<int> corruptAfterAmends{1};
  // 02-10-2026 stop-loss policy. What the broker REPORTS for the position
  // (rTrigger 0 / rTrailing -1 = absent from the read) and whether an amend
  // carrying policy actually changes it (applyPolicy false models the trailing
  // read-back bug, or a broker that accepts and ignores the fields).
  std::atomic<int> rTrigger{0}, rTrailing{-1};
  std::atomic<bool> applyPolicy{true}, refusePolicy{false}, refuseAll{false};
  std::atomic<int> refusals{0};
  std::mutex wiresMtx;
  std::vector<std::string> wires; // every AMEND payload as dumped (sorted keys)
  std::string wire(size_t i) { std::lock_guard<std::mutex> lk(wiresMtx); return wires.at(i); }
  size_t wireCount() { std::lock_guard<std::mutex> lk(wiresMtx); return wires.size(); }
  void handle(FakeBroker& b, const jsn::Value& f) {
    const int type = static_cast<int>(f.get("payloadType").asNumber());
    if (type == pt::APP_AUTH_REQ || type == pt::ACCOUNT_AUTH_REQ) {
      b.reply(f, type + 1, f.get("payload")); return;
    }
    if (type == pt::CANCEL_ORDER_REQ) {
      b.reply(f, pt::ERROR_RES, *jsn::parse(R"({"errorCode":"BLOCKED_PAYLOAD_TYPE","description":"test throttle","retryAfter":5})"));
      return;
    }
    if (type == pt::RECONCILE_REQ) {
      if (mode == 1) return;
      // cTrader encodes int64 identities as strings as well as numbers.
      auto p = *jsn::parse(R"({"ctidTraderAccountId":"4002","position":[{"positionId":"7","tradeData":{"symbolId":"41","tradeSide":"BUY"}}]})");
      jsn::Array rows = p.get("position").asArray();
      const int readDir = amends > 0 && afterDir != 0 ? afterDir : dir;
      auto td = rows[0].get("tradeData"); td.set("tradeSide", std::string(readDir == 1 ? "BUY" : "SELL"));
      if (amends > 0 && afterSymbolId > 0) td.set("symbolId", afterSymbolId);
      rows[0].set("tradeData", td);
      if (entryPrice > 0) rows[0].set("price", amends > 0 && afterEntryPrice > 0 ? afterEntryPrice : entryPrice);
      rows[0].set("stopLoss", sl);
      if (rTrigger > 0) rows[0].set("stopLossTriggerMethod", rTrigger.load());
      if (rTrailing >= 0) rows[0].set("trailingStopLoss", rTrailing == 1);
      if (tp > 0) rows[0].set("takeProfit", mode == 2 && amends >= corruptAfterAmends ? tp + 1 : tp);
      p.set("position", jsn::Value(std::move(rows)));
      b.reply(f, pt::RECONCILE_RES, p); return;
    }
    assert(type == pt::AMEND_POSITION_SLTP_REQ);
    const auto& p = f.get("payload");
    assert(p.get("takeProfit").asNumber() == tp); // Must use current broker TP.
    assert(p.get("ratchetOnly").isNull()); // Internal policy never goes on wire.
    assert(p.get("policyOnly").isNull());
    { std::lock_guard<std::mutex> lk(wiresMtx); wires.push_back(jsn::dump(p)); }
    const bool hasPolicy = !p.get("stopLossTriggerMethod").isNull() || !p.get("trailingStopLoss").isNull();
    if (refuseAll || (refusePolicy && hasPolicy)) {
      ++refusals;
      b.reply(f, pt::ERROR_RES, *jsn::parse(R"({"errorCode":"INVALID_REQUEST","description":"policy not supported"})"));
      return;
    }
    if (hasPolicy && applyPolicy) {
      if (!p.get("stopLossTriggerMethod").isNull()) {
        const auto& t = p.get("stopLossTriggerMethod");
        rTrigger = t.isNumber() ? static_cast<int>(t.asNumber()) : parseTriggerMethod(t);
      }
      if (p.get("trailingStopLoss").isBool()) rTrailing = p.get("trailingStopLoss").asBool() ? 1 : 0;
    }
    sl = p.get("stopLoss").asNumber();
    ++amends;
    b.replyAfter(delayAmendMs, f, pt::EXECUTION_EVENT, *jsn::parse(R"({"ctidTraderAccountId":4002,"executionType":"ORDER_REPLACED"})"));
  }
};

void connect(ExecEngine& e, FakeBroker& b) {
  e.setLoopbackTransportForTests(b.port());
  e.setCredentials("127.0.0.1", "id", "secret", "token", 4002);
  assert(e.connectAndAuth());
}

jsn::Value intent(double sl = 95) {
  auto p = *jsn::parse(R"({"ctidTraderAccountId":4002,"positionId":7,"takeProfit":110,"ratchetOnly":true,"requireTakeProfit":true,"expectedDirection":1,"expectedSymbolId":41})");
  p.set("stopLoss", sl); return p;
}

void directTransactions() {
  BrokerState state;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto r = engine.amendPosition(intent());
  assert(r.ok && state.amends == 1);
  const auto& protection = r.body.get("protection");
  assert(protection.get("verified").asBool());
  assert(protection.get("takeProfit").asNumber() == 120);
  assert(protection.get("stopLoss").asNumber() == 95);
  assert(protection.get("checkedAtMs").asNumber() >= protection.get("readStartedAtMs").asNumber());
  assert(protection.get("confirmation").asString() == "amend_readback");
  auto noop = engine.amendPosition(intent(94));
  assert(noop.ok && noop.body.get("unchanged").asBool() && state.amends == 1);
  assert(noop.body.get("protection").get("confirmation").asString() == "already_tighter_snapshot");

  state.corruptAfterAmends = 2; state.mode = 2;
  auto badReadback = engine.amendPosition(intent(96));
  assert(!badReadback.ok && state.amends == 2);
  assert(badReadback.body.get("errorCode").asString() == "guard_ratchet_unconfirmed");
  state.mode = 1;
  engine.setRequestTimeoutMsForTests(50);
  assert(!engine.amendPosition(intent(97)).ok);
  assert(state.amends == 2); // No amendment after a failed pre-read.
}

void missingTargetAndWrongIdentity() {
  BrokerState state; state.tp = 0;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  assert(!engine.amendPosition(intent()).ok && state.amends == 0);
  auto wrong = intent(); wrong.set("expectedDirection", -1);
  assert(!engine.amendPosition(wrong).ok && state.amends == 0);
}

void readsForRatchetsRetainProtectionPriority() {
  BrokerState state;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  const auto cancel = *jsn::parse(R"({"ctidTraderAccountId":4002,"orderId":8})");
  assert(!engine.cancelOrder(cancel).ok); // Starts a five-second read/entry deferral.
  assert(!engine.reconcile().ok); // The ordinary read path is actually blocked.
  const auto ratchet = engine.amendPosition(intent());
  assert(ratchet.ok && state.amends == 1);
  assert(ratchet.body.get("protection").get("confirmation").asString() == "amend_readback");
  assert(!engine.reconcile().ok); // The deferral did not merely expire during the test.
}

void overlappingRatchets() {
  BrokerState state; state.delayAmendMs = 100;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto first = std::async(std::launch::async, [&] { return engine.amendPosition(intent(96)); });
  const auto deadline = std::chrono::steady_clock::now() + 2s;
  while (state.amends == 0 && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(5ms);
  assert(state.amends == 1);
  const auto lower = engine.amendPosition(intent(95));
  assert(first.get().ok && lower.ok && lower.body.get("unchanged").asBool());
  assert(state.amends == 1 && lower.body.get("protection").get("stopLoss").asNumber() == 96);
}

void shortRatchet() {
  BrokerState state; state.dir = -1; state.sl = 110; state.tp = 80;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto p = intent(105); p.set("expectedDirection", -1);
  assert(engine.amendPosition(p).ok && state.amends == 1);
  p.set("stopLoss", 106);
  const auto noop = engine.amendPosition(p);
  assert(noop.ok && noop.body.get("unchanged").asBool() && state.amends == 1);
}

void tickWorker(bool badReadback, bool replaceConfig = false) {
  BrokerState state; state.mode = badReadback ? 2 : 0;
  if (replaceConfig) state.delayAmendMs = 150;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  TrailEngine trail;
  TrailSpec s; s.accountId = 4002; s.symbolId = 41; s.dir = 1;
  s.trailDist = 5; s.lastSl = 90; s.hasSl = true; s.digits = 2;
  s.currentTp = 110; s.hasTp = true; // Stale Node target must never be sent.
  trail.configure({{7, s}}); trail.start(engine); trail.onTick(41, 100, 101);
  const auto deadline = std::chrono::steady_clock::now() + 3s;
  if (replaceConfig) {
    while (state.amends == 0 && std::chrono::steady_clock::now() < deadline)
      std::this_thread::sleep_for(5ms);
    assert(state.amends == 1);
    s.lastSl = 98;
    trail.configure({{7, s}});
  }
  while (trail.amendsOk() + trail.amendsFailed() == 0 && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(10ms);
  trail.stop();
  assert(state.amends == 1);
  assert(badReadback ? trail.amendsFailed() == 1 : trail.amendsOk() == 1);
  auto status = *jsn::parse(trail.statusJson());
  const auto& row = status.get("positions").asArray()[0];
  assert(row.get("lastSl").asNumber() == (replaceConfig ? 98 : badReadback ? 90 : 95));
  assert(row.get("protectionCheckedAtMs").isNull() == (badReadback || replaceConfig));
}

// ---- 02-10-2026 stop-loss policy -------------------------------------------

jsn::Value policyIntent(double sl, const char* policyJson) {
  auto p = intent(sl);
  const auto pol = *jsn::parse(policyJson);
  for (const auto& [k, v] : pol.asObject()) p.set(k, v);
  return p;
}

jsn::Value policyOnlyIntent(const char* policyJson, int dir = 1) {
  auto p = *jsn::parse(R"({"ctidTraderAccountId":4002,"positionId":7,"policyOnly":true,"expectedSymbolId":41})");
  p.set("expectedDirection", dir);
  const auto pol = *jsn::parse(policyJson);
  for (const auto& [k, v] : pol.asObject()) p.set(k, v);
  return p;
}

std::string dumpOf(const jsn::Value& v) { return jsn::dump(v); }

void ratchetRebuildCarriesPolicy() {
  BrokerState state;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto r = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":2,"trailingStopLoss":true})"));
  assert(r.ok && state.amends == 1);
  assert(state.wire(0) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":95,"stopLossTriggerMethod":2,"takeProfit":120,"trailingStopLoss":true})");
  assert(dumpOf(r.body.get("policy")) ==
         R"({"applied":true,"readback":"confirmed","refused":null,"requested":{"stopLossTriggerMethod":2,"trailingStopLoss":true},"skipped":null})");
  assert(r.body.get("protection").get("stopLossTriggerMethod").asNumber() == 2);
  assert(r.body.get("protection").get("trailingStopLoss").asBool());
  assert(!r.body.get("unchanged").asBool());
}

void policyNameEmittedVerbatimRequestedNormalised() {
  BrokerState state;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto r = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":"DOUBLE_OPPOSITE"})"));
  assert(r.ok);
  assert(state.wire(0) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":95,"stopLossTriggerMethod":"DOUBLE_OPPOSITE","takeProfit":120})");
  assert(r.body.get("policy").get("requested").get("stopLossTriggerMethod").asNumber() == 4);
  assert(r.body.get("policy").get("requested").get("trailingStopLoss").isNull());
  assert(r.body.get("policy").get("readback").asString() == "confirmed");
}

void noPolicyNoPolicyKeys() {
  BrokerState state;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto r = engine.amendPosition(intent(95));
  assert(r.ok && r.body.get("policy").isNull());
  assert(state.wire(0) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":95,"takeProfit":120})");
  state.rTrigger = 2; // even a broker that reports policy changes nothing without a request
  auto noop = engine.amendPosition(intent(94));
  assert(noop.ok && noop.body.get("unchanged").asBool() && noop.body.get("policy").isNull());
  assert(noop.body.get("protection").get("stopLossTriggerMethod").asNumber() == 2);
}

void unchangedButNoncompliantStamps() {
  BrokerState state; state.sl = 96; // broker stop already tighter than the 95 asked
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto r = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":2})"));
  assert(r.ok && state.amends == 1 && state.sl == 96);
  // A stamp carries the BROKER's stop and TP, never the stale ratchet target.
  assert(state.wire(0) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":96,"stopLossTriggerMethod":2,"takeProfit":120})");
  assert(!r.body.get("unchanged").asBool());
  assert(r.body.get("policy").get("applied").asBool());
  assert(r.body.get("policy").get("readback").asString() == "confirmed");
  // Now compliant: nothing is sent.
  auto again = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":2})"));
  assert(again.ok && again.body.get("unchanged").asBool() && state.amends == 1);
  assert(!again.body.get("policy").get("applied").asBool());
  assert(again.body.get("policy").get("readback").asString() == "confirmed");
  // A different trigger is non-compliant again.
  auto other = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":3})"));
  assert(other.ok && state.amends == 2 && state.rTrigger == 3);
  // trailing requested true and not shown -> stamp; shown -> no-op.
  auto trailing = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":3,"trailingStopLoss":true})"));
  assert(trailing.ok && state.amends == 3 && state.rTrailing == 1);
  auto settled = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":3,"trailingStopLoss":true})"));
  assert(settled.ok && settled.body.get("unchanged").asBool() && state.amends == 3);
  // trailing:false is never counted: no stamp for it alone.
  auto off = engine.amendPosition(policyIntent(95, R"({"trailingStopLoss":false})"));
  assert(off.ok && off.body.get("unchanged").asBool() && state.amends == 3);
}

void policyOnlyModes() {
  BrokerState state;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  // Stamps at the broker's own stop and TP (the payload has no stop at all).
  auto r = engine.amendPosition(policyOnlyIntent(R"({"stopLossTriggerMethod":3})"));
  assert(r.ok && state.amends == 1 && state.sl == 92);
  assert(state.wire(0) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":92,"stopLossTriggerMethod":3,"takeProfit":120})");
  assert(!r.body.get("unchanged").asBool());
  assert(r.body.get("policy").get("readback").asString() == "confirmed");
  // Already applied: ok, unchanged, nothing sent.
  auto noop = engine.amendPosition(policyOnlyIntent(R"({"stopLossTriggerMethod":3})"));
  assert(noop.ok && noop.body.get("unchanged").asBool() && state.amends == 1);
  assert(noop.body.get("policy").get("applied").asBool() == false);
  // policyOnly wins over ratchetOnly: the stop comes from the broker read.
  auto both = policyOnlyIntent(R"({"stopLossTriggerMethod":4})");
  both.set("ratchetOnly", true); both.set("stopLoss", 99);
  auto br = engine.amendPosition(both);
  assert(br.ok && state.amends == 2 && state.sl == 92);
  assert(state.wire(1) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":92,"stopLossTriggerMethod":4,"takeProfit":120})");
  // Wrong direction: identity guard, nothing sent. Missing direction too.
  auto wrong = engine.amendPosition(policyOnlyIntent(R"({"stopLossTriggerMethod":2})", -1));
  assert(!wrong.ok && wrong.body.get("errorCode").asString() == "guard_ratchet_identity" && state.amends == 2);
  auto noDir = policyOnlyIntent(R"({"stopLossTriggerMethod":2})"); noDir.set("expectedDirection", nullptr);
  assert(!engine.amendPosition(noDir).ok && state.amends == 2);
  // No policy field at all.
  auto none = engine.amendPosition(policyOnlyIntent(R"({})"));
  assert(!none.ok && none.body.get("errorCode").asString() == "guard_policy_invalid");
}

void policyOnlyNeverInventsAStop() {
  BrokerState state; state.sl = 0;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto r = engine.amendPosition(policyOnlyIntent(R"({"stopLossTriggerMethod":2})"));
  assert(!r.ok && r.body.get("errorCode").asString() == "guard_policy_no_stop" && state.wireCount() == 0);
}

void invalidPolicyRejectedBeforeAnything() {
  BrokerState state;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  const size_t framesBefore = broker.receivedCount();
  for (const char* bad : {R"({"stopLossTriggerMethod":5})", R"({"stopLossTriggerMethod":0})",
                          R"({"stopLossTriggerMethod":"BOGUS"})", R"({"stopLossTriggerMethod":2.5})",
                          R"({"stopLossTriggerMethod":true})", R"({"trailingStopLoss":"yes"})",
                          R"({"trailingStopLoss":1})"}) {
    auto r = engine.amendPosition(policyIntent(95, bad));
    assert(!r.ok && r.body.get("errorCode").asString() == "guard_policy_invalid");
    auto plain = *jsn::parse(R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":95,"takeProfit":120})");
    const auto badV = *jsn::parse(bad);
    for (const auto& [k, v] : badV.asObject()) plain.set(k, v);
    assert(!engine.amendPosition(plain).ok);
  }
  assert(broker.receivedCount() == framesBefore && state.wireCount() == 0); // not even a read
}

void refusalFallbackAndCooldown() {
  BrokerState state; state.refusePolicy = true;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto r = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":2,"trailingStopLoss":true})"));
  assert(r.ok && state.refusals == 1 && state.amends == 1 && state.sl == 95);
  assert(state.wireCount() == 2);
  assert(state.wire(0) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":95,"stopLossTriggerMethod":2,"takeProfit":120,"trailingStopLoss":true})");
  assert(state.wire(1) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":95,"takeProfit":120})");
  assert(dumpOf(r.body.get("policy")) ==
         R"({"applied":false,"readback":"unreadable","refused":{"description":"policy not supported","errorCode":"INVALID_REQUEST"},"requested":{"stopLossTriggerMethod":2,"trailingStopLoss":true},"skipped":null})");
  // 6h cooldown: the next amend strips the fields BEFORE sending, no refusal.
  auto next = engine.amendPosition(policyIntent(97, R"({"stopLossTriggerMethod":2})"));
  assert(next.ok && state.refusals == 1 && state.amends == 2 && state.wireCount() == 3);
  assert(state.wire(2) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":97,"takeProfit":120})");
  assert(next.body.get("policy").get("skipped").asString() == "cooldown");
  assert(!next.body.get("policy").get("applied").asBool() && next.body.get("policy").get("refused").isNull());
  // A stamp for a cooling symbol is no amend at all.
  auto po = engine.amendPosition(policyOnlyIntent(R"({"stopLossTriggerMethod":2})"));
  assert(po.ok && po.body.get("unchanged").asBool() && state.amends == 2);
  assert(po.body.get("policy").get("skipped").asString() == "cooldown");
  // Clearing the cooldown lets the fields be tried (and refused) again.
  engine.clearPolicyCooldownForTests();
  auto again = engine.amendPosition(policyIntent(98, R"({"stopLossTriggerMethod":2})"));
  assert(again.ok && state.refusals == 2 && state.amends == 3);
  assert(again.body.get("policy").get("refused").get("errorCode").asString() == "INVALID_REQUEST");
}

void refusalFallbackPlainPath() {
  BrokerState state; state.refusePolicy = true;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto plain = *jsn::parse(R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":90,"takeProfit":120,"stopLossTriggerMethod":1})");
  auto r = engine.amendPosition(plain);
  assert(r.ok && state.refusals == 1 && state.wireCount() == 2);
  assert(state.wire(0) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":90,"stopLossTriggerMethod":1,"takeProfit":120})");
  assert(state.wire(1) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":90,"takeProfit":120})");
  assert(r.body.get("executionType").asString() == "ORDER_REPLACED"); // the broker's own reply is kept
  assert(r.body.get("policy").get("refused").get("errorCode").asString() == "INVALID_REQUEST");
  assert(r.body.get("policy").get("readback").asString() == "none" && !r.body.get("policy").get("applied").asBool());
  auto cool = engine.amendPosition(plain);
  assert(cool.ok && state.wireCount() == 3 && cool.body.get("policy").get("skipped").asString() == "cooldown");
}

void plainPathPolicyVerbatim() {
  BrokerState state;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto plain = *jsn::parse(R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":90,"takeProfit":120,"stopLossTriggerMethod":"TRADE","trailingStopLoss":false})");
  auto r = engine.amendPosition(plain);
  assert(r.ok && state.wire(0) == R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":90,"stopLossTriggerMethod":"TRADE","takeProfit":120,"trailingStopLoss":false})");
  assert(dumpOf(r.body.get("policy")) ==
         R"({"applied":true,"readback":"unverified","refused":null,"requested":{"stopLossTriggerMethod":1,"trailingStopLoss":false},"skipped":null})");
}

void failedRetryReturnsRetryFailure() {
  BrokerState state; state.refuseAll = true;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  auto r = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":2})"));
  assert(!r.ok && r.brokerError && state.wireCount() == 2 && state.amends == 0);
  // No cooldown was recorded: the next amend tries the fields again.
  auto next = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":2})"));
  assert(!next.ok && state.wireCount() == 4);
  // A transport failure is not a refusal: no retry.
  state.refuseAll = false; state.mode = 1;
  engine.setRequestTimeoutMsForTests(50);
  assert(!engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":2})")).ok);
  assert(state.wireCount() == 4);
}

void readbackStatesAndTrailingAbsentTolerated() {
  // mismatch: the broker accepts the amend but reports a different trigger.
  { BrokerState state; state.applyPolicy = false; state.rTrigger = 1;
    FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
    ExecEngine engine; connect(engine, broker);
    auto r = engine.amendPosition(policyIntent(95, R"({"stopLossTriggerMethod":2})"));
    assert(r.ok && r.body.get("policy").get("applied").asBool());
    assert(r.body.get("policy").get("readback").asString() == "mismatch");
    assert(r.body.get("protection").get("stopLoss").asNumber() == 95); }
  // unreadable: trailing requested true, the read shows no trailing field.
  { BrokerState state; state.applyPolicy = false;
    FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
    ExecEngine engine; connect(engine, broker);
    auto r = engine.amendPosition(policyIntent(95, R"({"trailingStopLoss":true})"));
    assert(r.ok && r.body.get("policy").get("readback").asString() == "unreadable");
    assert(r.body.get("protection").get("trailingStopLoss").isNull()); }
  // present-and-false read-back (the known broker bug) is reported, never fatal.
  { BrokerState state; state.applyPolicy = false; state.rTrailing = 0;
    FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
    ExecEngine engine; connect(engine, broker);
    auto r = engine.amendPosition(policyIntent(95, R"({"trailingStopLoss":true})"));
    assert(r.ok && r.body.get("policy").get("readback").asString() == "mismatch");
    assert(r.body.get("protection").get("trailingStopLoss").isBool()); }
  // only trailing:false requested: nothing verifiable, readback "none".
  { BrokerState state;
    FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
    ExecEngine engine; connect(engine, broker);
    auto r = engine.amendPosition(policyIntent(95, R"({"trailingStopLoss":false})"));
    assert(r.ok && r.body.get("policy").get("readback").asString() == "none" && r.body.get("policy").get("applied").asBool()); }
}

void brokerReadParsesPolicyTolerantly() {
  BrokerProtection p;
  auto body = *jsn::parse(R"({"ctidTraderAccountId":4002,"position":[{"positionId":7,"tradeData":{"symbolId":41,"tradeSide":"BUY"},"stopLoss":9,"stopLossTriggerMethod":"DOUBLE_TRADE","trailingStopLoss":true}]})");
  assert(readBrokerProtection(body, 4002, 7, p).empty() && p.trigger == 3 && p.hasTrailing && p.trailing);
  BrokerProtection q;
  auto bad = *jsn::parse(R"({"ctidTraderAccountId":4002,"position":[{"positionId":7,"tradeData":{"symbolId":41,"tradeSide":"BUY"},"stopLoss":9,"stopLossTriggerMethod":"x","trailingStopLoss":"true"}]})");
  assert(readBrokerProtection(bad, 4002, 7, q).empty() && q.trigger == 0 && !q.hasTrailing);
  BrokerProtection z;
  auto num = *jsn::parse(R"({"ctidTraderAccountId":4002,"position":[{"positionId":7,"tradeData":{"symbolId":41,"tradeSide":"BUY"},"stopLoss":9,"stopLossTriggerMethod":7}]})");
  assert(readBrokerProtection(num, 4002, 7, z).empty() && z.trigger == 0);
}

void tickWorkerCarriesPolicy(double entry, bool expectTrailing) {
  BrokerState state;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  TrailEngine trail;
  StopPolicyCfg cfg; cfg.triggerWire = jsn::Value(2); cfg.trailingOnLock = true;
  trail.configurePolicy(cfg);
  TrailSpec s; s.accountId = 4002; s.symbolId = 41; s.dir = 1;
  s.trailDist = 5; s.lastSl = 90; s.hasSl = true; s.digits = 2;
  s.currentTp = 110; s.hasTp = true;
  if (entry > 0) { s.entryPrice = entry; s.hasEntry = true; }
  trail.configure({{7, s}}); trail.start(engine); trail.onTick(41, 100, 101);
  const auto deadline = std::chrono::steady_clock::now() + 3s;
  while (trail.amendsOk() + trail.amendsFailed() == 0 && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(10ms);
  trail.stop();
  assert(trail.amendsOk() == 1 && state.wireCount() == 1);
  assert(state.wire(0) == (expectTrailing
    ? R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":95,"stopLossTriggerMethod":2,"takeProfit":120,"trailingStopLoss":true})"
    : R"({"ctidTraderAccountId":4002,"positionId":7,"stopLoss":95,"stopLossTriggerMethod":2,"takeProfit":120})"));
}

// Real read/amend/read and worker receipts, not a reconstruction of lastSl.
void confirmedMovementTransactions() {
  BrokerState state;
  state.sl = 1.092345678912345; state.tp = 1.2; state.entryPrice = 1.100123456789012;
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  const double before = state.sl, after = 1.095678912345678;
  const auto moved = engine.amendPosition(intent(after));
  assert(moved.ok && state.amends == 1);
  const auto& proof = moved.body.get("protection").get("movement");
  assert(proof.isObject() && proof.get("v").asNumber() == 1);
  assert(proof.get("source").asString() == "broker_reconcile");
  assert(proof.get("confirmation").asString() == "amend_readback");
  assert(proof.get("stopMoved").isBool() && proof.get("stopMoved").asBool());
  assert(proof.get("accountId").asNumber() == 4002 && proof.get("positionId").asNumber() == 7);
  assert(proof.get("symbolId").asNumber() == 41 && proof.get("direction").asNumber() == 1);
  assert(proof.get("entryPrice").asNumber() == state.entryPrice);
  assert(proof.get("beforeStopLoss").asNumber() == before && proof.get("afterStopLoss").asNumber() == after);
  assert(proof.get("beforeCheckedAtMs").asNumber() > 0);
  assert(proof.get("afterCheckedAtMs").asNumber() >= proof.get("beforeCheckedAtMs").asNumber());
  const auto roundTrip = *jsn::parse(jsn::dump(proof));
  assert(roundTrip.get("beforeStopLoss").asNumber() == before && roundTrip.get("afterStopLoss").asNumber() == after);
  auto noop = engine.amendPosition(intent(after));
  assert(noop.ok && noop.body.get("unchanged").asBool());
  assert(noop.body.get("protection").get("movement").get("stopMoved").isBool());
  assert(!noop.body.get("protection").get("movement").get("stopMoved").asBool());
  // A stale ratchet target may cause a policy stamp at the broker's own SL.
  auto stamp = engine.amendPosition(policyIntent(before, R"({"stopLossTriggerMethod":2})"));
  assert(stamp.ok && !stamp.body.get("unchanged").asBool());
  assert(!stamp.body.get("protection").get("movement").get("stopMoved").asBool());
  auto only = engine.amendPosition(policyOnlyIntent(R"({"stopLossTriggerMethod":3})"));
  assert(only.ok && !only.body.get("protection").get("movement").get("stopMoved").asBool());
  // Missing native entry cannot certify an episode, but does not block trading.
  state.entryPrice = 0;
  const auto unknown = engine.amendPosition(intent(after + .001));
  assert(unknown.ok && unknown.body.get("protection").get("movement").get("entryPrice").isNull());
  assert(!unknown.body.get("protection").get("movement").get("stopMoved").asBool());
}

void confirmedMovementIdentityBoundaries() {
  for (int mode : {0, 1, 2}) {
    BrokerState state;
    if (mode == 0) state.afterEntryPrice = 101;
    if (mode == 1) state.afterSymbolId = 42;
    if (mode == 2) state.afterDir = -1;
    FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
    ExecEngine engine; connect(engine, broker);
    const auto r = engine.amendPosition(intent());
    if (mode == 0) {
      assert(r.ok); // provenance does not change existing ratchet acceptance
      assert(!r.body.get("protection").get("movement").get("stopMoved").asBool());
    } else {
      assert(!r.ok && r.body.get("errorCode").asString() == "guard_ratchet_unconfirmed");
      assert(r.body.get("protection").get("movement").isNull());
    }
  }
}

void confirmedTrailRingReceipt(int mode = 0) {
  BrokerState state;
  state.sl = 1.092345678912345; state.tp = 1.2; state.entryPrice = 1.100123456789012;
  if (mode != 0) state.sl = 1.102; // actual broker stop already exceeds target
  FakeBroker broker([&](auto& b, const auto& f) { state.handle(b, f); });
  ExecEngine engine; connect(engine, broker);
  DecisionRing ring;
  TrailEngine trail; trail.setDecisionRing(&ring);
  if (mode == 1) { StopPolicyCfg cfg; cfg.triggerWire = 2; trail.configurePolicy(cfg); }
  TrailSpec s; s.accountId = 4002; s.symbolId = 41; s.dir = 1;
  s.trailDist = .001; s.lastSl = 1.092345678912345; s.hasSl = true; s.digits = 9;
  s.currentTp = state.tp; s.hasTp = true;
  trail.configure({{7, s}}); trail.start(engine); trail.onTick(41, 1.101234567, 1.101334567);
  const auto deadline = std::chrono::steady_clock::now() + 3s;
  while (ring.latestSeq() == 0 && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(10ms);
  trail.stop();
  assert(trail.amendsOk() == (mode == 2 ? 0 : 1));
  const auto rows = ring.since(0);
  assert(rows.size() == 1 && rows[0].component == "trail");
  assert(rows[0].kind == (mode == 2 ? "already_tighter" : "amend_ok"));
  assert(rows[0].detail.find("pos=7 sl=") == 0 && rows[0].detail.size() <= 500);
  const std::string marker = mode == 2 ? " already_tighter_snapshot proof=" : " amend_readback proof=";
  const auto start = rows[0].detail.find(marker);
  assert(start != std::string::npos);
  const auto proof = jsn::parse(rows[0].detail.substr(start + marker.size()));
  assert(proof && proof->get("stopMoved").isBool() && proof->get("stopMoved").asBool() == (mode == 0));
  assert(proof->get("beforeStopLoss").asNumber() == (mode == 0 ? 1.092345678912345 : 1.102));
  assert(proof->get("afterStopLoss").asNumber() == state.sl);
  assert(proof->get("entryPrice").asNumber() == state.entryPrice);
}

int main(int argc, char** argv) {
  if (argc == 2 && std::string(argv[1]) == "confirmed-movement") { confirmedMovementTransactions(); return 0; }
  if (argc == 2 && std::string(argv[1]) == "confirmed-ring") { confirmedTrailRingReceipt(); return 0; }
  confirmedMovementTransactions();
  confirmedMovementIdentityBoundaries();
  confirmedTrailRingReceipt();
  confirmedTrailRingReceipt(1); // successful policy stamp is no level move
  confirmedTrailRingReceipt(2); // unchanged broker snapshot is no move
  ratchetRebuildCarriesPolicy();
  policyNameEmittedVerbatimRequestedNormalised();
  noPolicyNoPolicyKeys();
  unchangedButNoncompliantStamps();
  policyOnlyModes();
  policyOnlyNeverInventsAStop();
  invalidPolicyRejectedBeforeAnything();
  refusalFallbackAndCooldown();
  refusalFallbackPlainPath();
  plainPathPolicyVerbatim();
  failedRetryReturnsRetryFailure();
  readbackStatesAndTrailingAbsentTolerated();
  brokerReadParsesPolicyTolerantly();
  tickWorkerCarriesPolicy(90, true);   // stop 95 >= entry 90: locks profit -> trailing asked
  tickWorkerCarriesPolicy(98, false);  // stop 95 < entry 98: trigger only
  tickWorkerCarriesPolicy(0, false);   // no entry known: trigger only
  directTransactions();
  missingTargetAndWrongIdentity();
  readsForRatchetsRetainProtectionPriority();
  overlappingRatchets();
  shortRatchet();
  tickWorker(false); tickWorker(true);
  tickWorker(false, true);
  std::puts("test_protection_ratchet: broker TP, ratchet floor, read-back and worker passed");
}
