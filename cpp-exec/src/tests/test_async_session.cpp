// cpp-exec/src/tests/test_async_session.cpp — P2b-2 (11-09-2026): the async
// broker session against a scripted fake broker (fake_broker.hpp). Every
// scenario here is one the synchronous session could not pass or could not
// even express: two requests in flight at once, an answer that arrives after
// its request gave up, an event with nothing waiting, a hang-up with a
// request pending, an id-less error with two requests to choose from.
#include <cassert>
#include <chrono>
#include <cstdio>
#include <string>
#include <thread>

#include "../decision_ring.hpp"
#include "../engine.hpp"
#include "../event_journal.hpp"
#include "fake_broker.hpp"

using namespace std::chrono;

namespace {

long long msSince(steady_clock::time_point t0) {
  return duration_cast<milliseconds>(steady_clock::now() - t0).count();
}

int typeOf(const jsn::Value& frame) { return static_cast<int>(frame.get("payloadType").asNumber(-1)); }

// The auth handshake every scenario needs, plus a reconcile that answers empty.
void authAndReconcile(FakeBroker& b, const jsn::Value& f) {
  const int type = typeOf(f);
  if (type == pt::APP_AUTH_REQ) { b.reply(f, pt::APP_AUTH_RES, jsn::Value{jsn::Object{}}); return; }
  if (type == pt::ACCOUNT_AUTH_REQ) {
    jsn::Value p{jsn::Object{}};
    p.set("ctidTraderAccountId", f.get("payload").get("ctidTraderAccountId"));
    b.reply(f, pt::ACCOUNT_AUTH_RES, p);
    return;
  }
  if (type == pt::RECONCILE_REQ) {
    jsn::Value p{jsn::Object{}};
    p.set("ctidTraderAccountId", f.get("payload").get("ctidTraderAccountId"));
    p.set("position", jsn::Value(jsn::Array{}));
    p.set("order", jsn::Value(jsn::Array{}));
    b.reply(f, pt::RECONCILE_RES, p);
    return;
  }
}

jsn::Value executionEvent(const std::string& executionType, long long orderId, long long positionId, long long acct = 4002) {
  jsn::Value tradeData{jsn::Object{}};
  tradeData.set("symbolId", 41.0);
  tradeData.set("label", std::string("AU|v1|VWAP|H|LN|4h|TR|iabc123456789"));
  jsn::Value p{jsn::Object{}};
  p.set("ctidTraderAccountId", static_cast<double>(acct));
  p.set("executionType", executionType);
  if (orderId > 0) { jsn::Value o{jsn::Object{}}; o.set("orderId", static_cast<double>(orderId)); o.set("tradeData", tradeData); p.set("order", o); }
  if (positionId > 0) { jsn::Value pos{jsn::Object{}}; pos.set("positionId", static_cast<double>(positionId)); pos.set("tradeData", tradeData); p.set("position", pos); }
  return p;
}

jsn::Value errorPayload(const std::string& code, const std::string& desc = "scripted") {
  jsn::Value p{jsn::Object{}};
  p.set("errorCode", code);
  p.set("description", desc);
  return p;
}

jsn::Value closeReq(long long positionId, long long acct = 4002) {
  jsn::Value p{jsn::Object{}};
  p.set("ctidTraderAccountId", static_cast<double>(acct));
  p.set("positionId", static_cast<double>(positionId));
  p.set("volume", 1000.0);
  return p;
}

jsn::Value cancelReq(long long orderId, long long acct = 4002) {
  jsn::Value p{jsn::Object{}};
  p.set("ctidTraderAccountId", static_cast<double>(acct));
  p.set("orderId", static_cast<double>(orderId));
  return p;
}

jsn::Value marketOrder(long long acct = 4002) {
  jsn::Value o{jsn::Object{}};
  o.set("ctidTraderAccountId", static_cast<double>(acct));
  o.set("symbolId", 41.0);
  o.set("orderType", std::string("MARKET"));
  o.set("tradeSide", std::string("BUY"));
  o.set("volume", 1000.0);
  o.set("relativeStopLoss", 100.0);
  o.set("relativeTakeProfit", 200.0);
  o.set("label", std::string("AU|v1|VWAP|H|LN|4h|TR|iabc123456789"));
  return o;
}

void connectEngine(ExecEngine& e, FakeBroker& b, std::vector<long long> extras = {}) {
  e.setLoopbackTransportForTests(b.port());
  e.setCredentials("127.0.0.1", "ci", "cs", "tok", 4002, std::move(extras));
  assert(e.connectAndAuth());
  assert(e.isConnected());
}

} // namespace

static void test_connect_auth_reconcile_and_the_roster() {
  FakeBroker broker(authAndReconcile);
  DecisionRing ring(64); // outlives the engine: the reader logs its exit into it
  ExecEngine e;
  e.setDecisionRing(&ring);
  connectEngine(e, broker, {4003});
  const auto ids = e.accountIds();
  assert(ids.size() == 2 && ids[0] == 4002 && ids[1] == 4003);
  assert(broker.connections() == 1);
  // app auth, two account auths — each under its own clientMsgId
  auto frames = broker.received();
  assert(frames.size() == 3);
  assert(typeOf(frames[0]) == pt::APP_AUTH_REQ && typeOf(frames[1]) == pt::ACCOUNT_AUTH_REQ && typeOf(frames[2]) == pt::ACCOUNT_AUTH_REQ);
  assert(frames[0].get("clientMsgId").asString() != frames[1].get("clientMsgId").asString());
  EngineResult r = e.reconcile();
  assert(r.ok);
  assert(!e.lastReconcileJson(4002).empty() && !e.lastReconcileJson(4003).empty());
  const ExecEngine::SessionStats s = e.sessionStats();
  assert(s.readerRunning && s.pending == 0 && s.generation == 1 && s.framesIn == 5 && s.disconnects == 0);
  bool started = false;
  for (const auto& rec : ring.since(0)) if (rec.component == "engine" && rec.kind == "reader_started") started = true;
  assert(started);
}

static void test_two_requests_in_flight_resolve_independently_and_out_of_order() {
  // The close is answered after 1500 ms; the cancel, sent 100 ms later, is
  // answered at once. Under the synchronous session the cancel waited behind
  // the close's lock for the whole 1500 ms; here it returns in milliseconds
  // with ITS payload, and the close still gets its own.
  FakeBroker broker([](FakeBroker& b, const jsn::Value& f) {
    authAndReconcile(b, f);
    const int type = typeOf(f);
    if (type == pt::CLOSE_POSITION_REQ)
      b.replyAfter(1500, f, pt::EXECUTION_EVENT, executionEvent("ORDER_FILLED", 0, static_cast<long long>(f.get("payload").get("positionId").asNumber(0))));
    if (type == pt::CANCEL_ORDER_REQ)
      b.reply(f, pt::EXECUTION_EVENT, executionEvent("ORDER_CANCELLED", static_cast<long long>(f.get("payload").get("orderId").asNumber(0)), 0));
  });
  ExecEngine e;
  connectEngine(e, broker);
  EngineResult closeResult;
  std::thread closer([&] { closeResult = e.closePosition(closeReq(7)); });
  std::this_thread::sleep_for(milliseconds(100));
  const auto t0 = steady_clock::now();
  EngineResult cancelResult = e.cancelOrder(cancelReq(9));
  const long long cancelMs = msSince(t0);
  assert(cancelResult.ok);
  assert(cancelResult.body.get("executionType").asString() == "ORDER_CANCELLED");
  assert(cancelResult.body.get("order").get("orderId").asNumber(0) == 9);
  assert(cancelMs < 700); // did not queue behind the close
  assert(e.sessionStats().pending == 1); // the close is still in flight
  closer.join();
  assert(closeResult.ok);
  assert(closeResult.body.get("executionType").asString() == "ORDER_FILLED");
  assert(closeResult.body.get("position").get("positionId").asNumber(0) == 7);
  assert(e.sessionStats().pending == 0);
}

static void test_late_frame_after_timeout_is_journaled_under_its_client_msg_id() {
  FakeBroker broker([](FakeBroker& b, const jsn::Value& f) {
    authAndReconcile(b, f);
    if (typeOf(f) == pt::NEW_ORDER_REQ)
      b.replyAfter(900, f, pt::EXECUTION_EVENT, executionEvent("ORDER_ACCEPTED", 55, 0));
  });
  EventJournal journal(64, "boot-test"); // outlives the engine
  ExecEngine e;
  e.setEventJournal(&journal);
  connectEngine(e, broker);
  e.setRequestTimeoutMsForTests(300);
  const auto t0 = steady_clock::now();
  EngineResult r = e.placeOrder(marketOrder());
  assert(!r.ok && r.body.get("errorCode").asString() == "TIMEOUT");
  const std::string id = r.body.get("clientMsgId").asString();
  assert(id.rfind("cx", 0) == 0);
  assert(msSince(t0) < 800);
  assert(journal.since(0).empty()); // nothing has arrived yet
  e.setRequestTimeoutMsForTests(0);
  std::this_thread::sleep_for(milliseconds(1200));
  const auto recs = journal.since(0);
  assert(recs.size() == 1);
  assert(recs[0].clientMsgId == id && !recs[0].solicited && recs[0].orderId == 55 && recs[0].executionType == "ORDER_ACCEPTED");
  assert(recs[0].label == "AU|v1|VWAP|H|LN|4h|TR|iabc123456789");
  const ExecEngine::SessionStats s = e.sessionStats();
  assert(s.timeouts == 1 && s.lateFrames == 1 && s.pending == 0 && s.readerRunning);
  // The session is intact: the next request round-trips.
  assert(e.reconcile().ok);
}

static void test_unsolicited_event_with_nothing_in_flight_is_journaled() {
  FakeBroker broker(authAndReconcile);
  EventJournal journal(64, "boot-test"); // outlives the engine
  ExecEngine e;
  e.setEventJournal(&journal);
  connectEngine(e, broker);
  assert(broker.send(FakeBroker::pushFrame(pt::EXECUTION_EVENT, executionEvent("ORDER_FILLED", 0, 77))));
  std::this_thread::sleep_for(milliseconds(300));
  const auto recs = journal.since(0);
  assert(recs.size() == 1);
  assert(recs[0].clientMsgId.empty() && !recs[0].solicited && recs[0].positionId == 77 && recs[0].accountId == 4002);
  assert(e.sessionStats().unsolicited == 1);
  assert(e.isConnected());
}

static void test_idless_error_answers_the_sole_request_but_never_one_of_two() {
  FakeBroker broker([](FakeBroker& b, const jsn::Value& f) {
    authAndReconcile(b, f);
    const int type = typeOf(f);
    // A close is never answered by its id; a cancel is answered after 800 ms.
    if (type == pt::CANCEL_ORDER_REQ)
      b.replyAfter(800, f, pt::EXECUTION_EVENT, executionEvent("ORDER_CANCELLED", static_cast<long long>(f.get("payload").get("orderId").asNumber(0)), 0));
  });
  EventJournal journal(64, "boot-test"); // outlives the engine
  ExecEngine e;
  e.setEventJournal(&journal);
  connectEngine(e, broker);

  // (a) exactly one request in flight: the id-less error is its answer (the
  // synchronous session's rule, kept).
  EngineResult sole;
  const size_t seen = broker.receivedCount(); // the auth frames
  std::thread t1([&] { sole = e.closePosition(closeReq(7)); });
  assert(broker.waitForFrames(seen + 1, 2000)); // the close is on the wire
  broker.send(FakeBroker::pushFrame(pt::ERROR_RES, errorPayload("POSITION_NOT_FOUND")));
  t1.join();
  assert(!sole.ok && sole.brokerError && sole.body.get("errorCode").asString() == "POSITION_NOT_FOUND");
  assert(e.isConnected());
  {
    const auto recs = journal.since(0);
    assert(recs.size() == 1 && recs[0].solicited && recs[0].errorCode == "POSITION_NOT_FOUND");
  }

  // (b) two in flight: the id-less error is nobody's answer. The cancel gets
  // its own echoed answer; the close runs to its (shortened) timeout.
  e.setRequestTimeoutMsForTests(1500);
  EngineResult closeR, cancelR;
  std::thread t2([&] { closeR = e.closePosition(closeReq(8)); });
  std::thread t3([&] { cancelR = e.cancelOrder(cancelReq(9)); });
  assert(broker.waitForFrames(seen + 3, 2000)); // both are on the wire
  std::this_thread::sleep_for(milliseconds(100));
  assert(e.sessionStats().pending == 2);
  broker.send(FakeBroker::pushFrame(pt::ERROR_RES, errorPayload("TRADING_DISABLED")));
  t3.join();
  assert(cancelR.ok && cancelR.body.get("order").get("orderId").asNumber(0) == 9);
  t2.join();
  assert(!closeR.ok && closeR.body.get("errorCode").asString() == "TIMEOUT");
  e.setRequestTimeoutMsForTests(0);
  {
    const auto recs = journal.since(1);
    bool unattributed = false;
    for (const auto& rec : recs) if (rec.errorCode == "TRADING_DISABLED" && !rec.solicited && rec.clientMsgId.empty()) unattributed = true;
    assert(unattributed);
  }
  assert(e.isConnected());
}

static void test_disconnect_fails_the_pending_request_at_once_and_reconnect_works() {
  FakeBroker broker(authAndReconcile); // a close is never answered
  DecisionRing ring(64); // outlives the engine
  ExecEngine e;
  e.setDecisionRing(&ring);
  connectEngine(e, broker);
  EngineResult closeR;
  const auto t0 = steady_clock::now();
  const size_t seen = broker.receivedCount();
  std::thread t([&] { closeR = e.closePosition(closeReq(7)); });
  assert(broker.waitForFrames(seen + 1, 2000)); // the close is on the wire, unanswered
  broker.dropClient();
  t.join();
  assert(!closeR.ok && closeR.body.get("errorCode").asString() == "DISCONNECTED");
  assert(msSince(t0) < 3000); // not the 20 s request timeout
  std::this_thread::sleep_for(milliseconds(200));
  assert(!e.isConnected());
  ExecEngine::SessionStats s = e.sessionStats();
  assert(s.disconnects == 1 && s.pending == 0 && !s.readerRunning);
  // A fresh connection: a new reader, the auth handshake again, requests flow.
  assert(e.connectAndAuth());
  assert(e.isConnected());
  assert(broker.connections() == 2);
  s = e.sessionStats();
  assert(s.generation == 2 && s.readerRunning);
  assert(e.reconcile().ok);
  bool dropped = false;
  for (const auto& rec : ring.since(0)) if (rec.component == "engine" && rec.kind == "disconnected") dropped = true;
  assert(dropped);
}

static void test_auth_family_errors_skip_an_extra_account_but_kill_the_session_otherwise() {
  FakeBroker broker([](FakeBroker& b, const jsn::Value& f) {
    if (typeOf(f) == pt::ACCOUNT_AUTH_REQ && f.get("payload").get("ctidTraderAccountId").asNumber(0) == 4003) {
      b.reply(f, pt::ERROR_RES, errorPayload("CH_ACCESS_TOKEN_INVALID"));
      return;
    }
    authAndReconcile(b, f);
  });
  ExecEngine e;
  e.setLoopbackTransportForTests(broker.port());
  e.setCredentials("127.0.0.1", "ci", "cs", "tok", 4002, {4003});
  // (a) the extra account's rejection is charged to that account only.
  assert(e.connectAndAuth());
  assert(e.isConnected());
  const auto ids = e.accountIds();
  assert(ids.size() == 1 && ids[0] == 4002);
  // (b) a session-level auth error with nothing in flight kills the session —
  // the reader closes its own socket; nothing else has to notice first.
  broker.send(FakeBroker::pushFrame(pt::ERROR_RES, errorPayload("CH_ACCESS_TOKEN_EXPIRED")));
  for (int i = 0; i < 30 && e.isConnected(); ++i) std::this_thread::sleep_for(milliseconds(100));
  assert(!e.isConnected());
  std::this_thread::sleep_for(milliseconds(200));
  assert(!e.sessionStats().readerRunning);
  assert(!broker.clientConnected());
}

static void test_the_reader_heartbeats_while_idle() {
  FakeBroker broker(authAndReconcile);
  ExecEngine e;
  e.setHeartbeatIdleMsForTests(200);
  connectEngine(e, broker);
  std::this_thread::sleep_for(milliseconds(2600));
  assert(broker.heartbeats() >= 2); // one per reader slice once idle past the bound
  assert(e.sessionStats().heartbeatsSent >= 2);
  assert(e.isConnected());
}

static void test_new_credentials_drop_the_session_without_touching_the_reader_s_socket() {
  FakeBroker broker(authAndReconcile);
  ExecEngine e;
  connectEngine(e, broker);
  e.setCredentials("127.0.0.1", "ci", "cs", "tok2", 4002); // a different token: a new session
  assert(!e.isConnected());
  assert(!e.sessionStats().readerRunning);
  assert(e.connectAndAuth());
  assert(broker.connections() == 2);
}

static void test_unconnected_engine_paths_are_unchanged() {
  ExecEngine e;
  EngineResult r = e.placeOrder(marketOrder());
  assert(!r.ok && r.body.get("errorCode").asString() == "NOT_CONNECTED");
  assert(!e.closePosition(closeReq(1)).ok);
  assert(!e.sessionStats().readerRunning && e.sessionStats().generation == 0);
}

int main() {
  test_unconnected_engine_paths_are_unchanged();
  test_connect_auth_reconcile_and_the_roster();
  test_two_requests_in_flight_resolve_independently_and_out_of_order();
  test_late_frame_after_timeout_is_journaled_under_its_client_msg_id();
  test_unsolicited_event_with_nothing_in_flight_is_journaled();
  test_idless_error_answers_the_sole_request_but_never_one_of_two();
  test_disconnect_fails_the_pending_request_at_once_and_reconnect_works();
  test_auth_family_errors_skip_an_extra_account_but_kill_the_session_otherwise();
  test_the_reader_heartbeats_while_idle();
  test_new_credentials_drop_the_session_without_touching_the_reader_s_socket();
  std::puts("test_async_session: all passed");
  return 0;
}
