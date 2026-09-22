#include "fake_broker.hpp"
#include "../engine.hpp"
#include "../trail_engine.hpp"
#include "../protection_ratchet.hpp"
#include <cassert>
#include <future>

using namespace std::chrono_literals;

struct BrokerState {
  double sl = 92, tp = 120;
  int dir = 1;
  std::atomic<int> amends{0};
  std::atomic<int> mode{0}; // 1 no reconcile reply, 2 corrupt post-amend TP
  int delayAmendMs = 0;
  std::atomic<int> corruptAfterAmends{1};
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
      auto td = rows[0].get("tradeData"); td.set("tradeSide", std::string(dir == 1 ? "BUY" : "SELL"));
      rows[0].set("tradeData", td);
      rows[0].set("stopLoss", sl);
      if (tp > 0) rows[0].set("takeProfit", mode == 2 && amends >= corruptAfterAmends ? tp + 1 : tp);
      p.set("position", jsn::Value(std::move(rows)));
      b.reply(f, pt::RECONCILE_RES, p); return;
    }
    assert(type == pt::AMEND_POSITION_SLTP_REQ);
    const auto& p = f.get("payload");
    assert(p.get("takeProfit").asNumber() == tp); // Must use current broker TP.
    assert(p.get("ratchetOnly").isNull()); // Internal policy never goes on wire.
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

int main() {
  directTransactions();
  missingTargetAndWrongIdentity();
  readsForRatchetsRetainProtectionPriority();
  overlappingRatchets();
  shortRatchet();
  tickWorker(false); tickWorker(true);
  tickWorker(false, true);
  std::puts("test_protection_ratchet: broker TP, ratchet floor, read-back and worker passed");
}
