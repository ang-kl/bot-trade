// Codex · №12,519 · 2026-10-09; codex-footprint: six-strategy-lifecycle.
// Offline fixture only. Links unchanged production native classes; never main.cpp.
// stdin is one JSON request, stdout one JSON result. All broker traffic is loopback.
#include "../../cpp-exec/src/tests/fake_broker.hpp"
#include "../../cpp-exec/src/engine.hpp"
#include "../../cpp-exec/src/trail_engine.hpp"
#include "../../cpp-exec/src/tick_firer.hpp"
#include "../../cpp-exec/src/hybrid_tick.hpp"
#include <cassert>
#include <cmath>
#include <iostream>
#include <mutex>
#include <sstream>

using namespace std::chrono_literals;
using jsn::Value;
static long long number(const Value& v) { return static_cast<long long>(v.asNumber()); }
static long long identity(const Value& v) { return v.isString() ? std::stoll(v.asString()) : number(v); }

struct Broker {
  std::mutex mutex;
  Value position{jsn::Object{}}, opening{jsn::Object{}}, response{jsn::Object{}};
  jsn::Array amends;
  long long account = 0, symbol = 0;
  double entry = 0;
  void handle(FakeBroker& socket, const Value& frame) {
    const int type = static_cast<int>(number(frame.get("payloadType")));
    const auto& p = frame.get("payload");
    if (type == pt::APP_AUTH_REQ || type == pt::ACCOUNT_AUTH_REQ) {
      socket.reply(frame, type + 1, p); return;
    }
    std::lock_guard<std::mutex> guard(mutex);
    assert(identity(p.get("ctidTraderAccountId")) == account);
    if (type == pt::NEW_ORDER_REQ) {
      assert(identity(p.get("symbolId")) == symbol);
      const auto side = p.get("tradeSide").asString();
      const int dir = side == "BUY" ? 1 : -1;
      auto td = p;
      td.set("positionId", 7001); td.set("openPrice", entry);
      position.set("positionId", 7001); position.set("positionStatus", "POSITION_STATUS_OPEN");
      position.set("ctidTraderAccountId", std::to_string(account));
      position.set("price", entry); position.set("symbolName", "EURUSD");
      position.set("label", p.get("label")); position.set("tradeData", td);
      position.set("stopLoss", entry - dir * p.get("relativeStopLoss").asNumber() / 100000);
      position.set("takeProfit", entry + dir * p.get("relativeTakeProfit").asNumber() / 100000);
      position.set("stopLossTriggerMethod", 2); position.set("trailingStopLoss", false);
      opening.set("dealId", "8001"); opening.set("orderId", "9001"); opening.set("positionId", "7001");
      opening.set("symbolId", std::to_string(symbol)); opening.set("tradeSide", side);
      opening.set("dealStatus", "FILLED"); opening.set("volume", p.get("volume"));
      opening.set("filledVolume", p.get("volume")); opening.set("executionPrice", entry);
      opening.set("executionTimestamp", hybrid::clockMs());
      Value order(jsn::Object{}); order.set("orderId", 9001);
      response.set("ctidTraderAccountId", std::to_string(account)); response.set("executionType", "ORDER_FILLED");
      response.set("position", position); response.set("order", order); response.set("deal", opening);
      socket.reply(frame, pt::EXECUTION_EVENT, response); return;
    }
    if (type == pt::RECONCILE_REQ) {
      Value reply(jsn::Object{}); reply.set("ctidTraderAccountId", std::to_string(account));
      reply.set("position", jsn::Array{position}); socket.reply(frame, pt::RECONCILE_RES, reply); return;
    }
    assert(type == pt::AMEND_POSITION_SLTP_REQ);
    assert(identity(p.get("positionId")) == identity(position.get("positionId")));
    assert(p.get("takeProfit").asNumber() == position.get("takeProfit").asNumber());
    assert(p.get("ratchetOnly").isNull() && p.get("expectedSymbolId").isNull());
    amends.push_back(p);
    position.set("stopLoss", p.get("stopLoss"));
    if (!p.get("stopLossTriggerMethod").isNull()) position.set("stopLossTriggerMethod", p.get("stopLossTriggerMethod"));
    if (!p.get("trailingStopLoss").isNull()) position.set("trailingStopLoss", p.get("trailingStopLoss"));
    Value reply(jsn::Object{}); reply.set("ctidTraderAccountId", std::to_string(account));
    reply.set("executionType", "ORDER_REPLACED"); socket.reply(frame, pt::EXECUTION_EVENT, reply);
  }
};

static tick::StrategyParams params(const Value& p) {
  tick::StrategyParams s;
  s.rangeEvents = static_cast<int>(number(p.get("rangeEvents")));
  s.momentumEvents = static_cast<int>(number(p.get("momentumEvents")));
  s.minEfficiency = p.get("minEfficiency").asNumber(); s.spreadBufferMult = p.get("spreadBufferMult").asNumber();
  s.confirmations = static_cast<int>(number(p.get("confirmations"))); s.stopVolMult = p.get("stopVolMult").asNumber();
  s.minStopPrice = number(p.get("minStopPrice")); s.priceIncrement = number(p.get("priceIncrement"));
  s.maxSpread = number(p.get("maxSpread")); s.maxQuoteAgeMs = number(p.get("maxQuoteAgeMs"));
  s.expiryEvents = static_cast<int>(number(p.get("expiryEvents")));
  s.rearmCooldownEvents = static_cast<int>(number(p.get("rearmCooldownEvents")));
  return s;
}

static Value enter(const Value& input) {
  const auto permit = input.get("permit");
  Broker state; state.account = identity(permit.get("accountId")); state.symbol = identity(permit.get("symbolId"));
  FakeBroker broker([&](auto& socket, const auto& frame) { state.handle(socket, frame); });
  assert(broker.port() > 0);
  DecisionRing ring(128);
  ExecEngine engine; engine.setDecisionRing(&ring); engine.setLoopbackTransportForTests(broker.port());
  engine.setCredentials(input.get("host").asString(), "fixture", "fixture", "fixture", state.account);
  engine.guard().setEntryEpochs({{state.account, number(permit.get("epoch"))}});
  assert(engine.connectAndAuth());
  tick::TickPermitStore permits; permits.set(state.account, state.symbol, permit.get("side").asString(), permit);
  tick::TickFirer firer(engine, permits); firer.setDecisionRing(&ring); firer.setAccounts({state.account});
  firer.setRecordingCheck([] { return true; }); firer.start();
  const auto fixture = input.get("fixture");
  tick::TickMomentumStrategy strategy(params(fixture.get("params")));
  tick::ShadowSim sim; // unchanged native latency, target and cost-screen defaults
  tick::ShadowBook book(sim, strategy.params().rangeEvents, state.symbol, strategy.profileHash());
  bool fired = false;
  for (const auto& event : fixture.get("events").asArray()) {
    tick::StrategyQuote q;
    q.seq = static_cast<uint32_t>(number(event.get("seq"))); q.recvMs = number(event.get("recvMs"));
    q.hasBid = event.get("bid").isNumber(); q.hasAsk = event.get("ask").isNumber();
    q.bid = number(event.get("bid")); q.ask = number(event.get("ask"));
    q.snapshot = event.get("snapshot").asBool(); q.crossed = event.get("crossed").asBool();
    q.changed = event.get("changed").asBool(true);
    book.onQuote(q);
    if (auto fill = book.takeFill()) {
      // Market data are fixture-relative; execution admission uses the actual current clock.
      fill->recvMs = hybrid::clockMs();
      { std::lock_guard<std::mutex> guard(state.mutex); state.entry = fill->entry / 100000.0; }
      assert(firer.onFill(*fill, fill->recvMs) == 1); fired = true; break;
    }
    if (auto signal = strategy.onQuote(q); signal && signal->side == permit.get("side").asString()) book.offer(*signal);
  }
  assert(fired);
  const auto deadline = std::chrono::steady_clock::now() + 4s;
  while (firer.counters().sent + firer.counters().rejected == 0 && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(5ms);
  firer.stop(); assert(firer.counters().sent == 1 && firer.counters().rejected == 0);
  Value out(jsn::Object{});
  { std::lock_guard<std::mutex> guard(state.mutex);
    out.set("position", state.position); out.set("opening", state.opening); out.set("response", state.response); }
  out.set("ring", *jsn::parse(ring.dumpJson(0, ""))); out.set("profileHash", strategy.profileHash());
  return out;
}

static Value protectAndTrigger(const Value& input) {
  const auto spec = input.get("spec");
  Broker state; state.position = input.get("position");
  state.account = identity(spec.get("accountId")); state.symbol = identity(spec.get("symbolId"));
  const double priorSl = state.position.get("stopLoss").asNumber();
  if (input.get("raceSl").isNumber()) {
    state.position.set("stopLoss", input.get("raceSl"));
    // The competing writer already installed the same on-lock policy.
    state.position.set("trailingStopLoss", true);
  }
  FakeBroker broker([&](auto& socket, const auto& frame) { state.handle(socket, frame); });
  assert(broker.port() > 0);
  DecisionRing ring;
  ExecEngine engine; engine.setLoopbackTransportForTests(broker.port());
  engine.setCredentials(spec.get("host").asString(), "fixture", "fixture", "fixture", state.account);
  assert(engine.connectAndAuth());
  TrailSpec trailSpec; trailSpec.accountId = state.account; trailSpec.symbolId = state.symbol;
  trailSpec.dir = spec.get("side").asString() == "BUY" ? 1 : -1;
  trailSpec.lastSl = priorSl; trailSpec.hasSl = true; trailSpec.digits = 5;
  trailSpec.entryPrice = state.position.get("price").asNumber(); trailSpec.hasEntry = true;
  trailSpec.trailDist = input.get("trailDistance").asNumber();
  trailSpec.currentTp = input.get("staleTp").asNumber(); trailSpec.hasTp = true;
  TrailEngine trail; trail.setDecisionRing(&ring);
  trail.configure({{identity(spec.get("positionId")), trailSpec}});
  trail.configurePolicy(parseTrailStopPolicy(*jsn::parse(R"({"stopLossTriggerMethod":2,"trailing":"on_lock"})")));
  trail.start(engine);
  const double bid = input.get("bid").asNumber(), ask = input.get("ask").asNumber();
  trail.onTick(state.symbol, bid, ask);
  const auto deadline = std::chrono::steady_clock::now() + 4s;
  while (ring.latestSeq() == 0 && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(5ms);
  trail.stop(); assert(ring.latestSeq() > 0 && trail.amendsFailed() == 0);
  const auto now = number(input.get("now"));
  Value out(jsn::Object{});
  if (!input.get("protectionOnly").asBool()) {
    hybrid::TickEngine profit(input.get("journal").asString(), [now] { return now; });
    assert(profit.configure(jsn::Array{spec}, spec.get("host").asString()));
    profit.onTick(spec.get("host").asString(), state.account, state.symbol, true,
      static_cast<long long>(std::llround(bid * 100000)), true,
      static_cast<long long>(std::llround(ask * 100000)), 1, now, now);
    assert(profit.events().get("events").asArray().empty()); // queued is not durable
    assert(profit.flushOne());
    out.set("trigger", profit.events().get("events").asArray().at(0));
  }
  if (!input.get("protectionOnly").asBool()) {
    hybrid::TickEngine reopened(input.get("journal").asString(), [now] { return now; });
    assert(jsn::dump(reopened.events().get("events").asArray().at(0)) == jsn::dump(out.get("trigger")));
  }
  { std::lock_guard<std::mutex> guard(state.mutex); out.set("position", state.position); out.set("amends", state.amends); }
  out.set("trail", *jsn::parse(trail.statusJson())); out.set("ring", *jsn::parse(ring.dumpJson(0, "")));
  return out;
}

int main() {
  std::ostringstream raw; raw << std::cin.rdbuf(); const auto input = jsn::parse(raw.str());
  assert(input && input->isObject());
  const auto mode = input->get("mode").asString(); assert(mode == "entry" || mode == "exit");
  const auto result = mode == "entry" ? enter(*input) : protectAndTrigger(*input);
  std::cout << jsn::dump(result) << '\n';
}
