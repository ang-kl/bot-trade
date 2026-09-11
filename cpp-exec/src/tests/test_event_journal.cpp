// cpp-exec/src/tests/test_event_journal.cpp — P2b-1: every execution-event
// frame is recorded with the ids the keeper's ledger settles on.
#include <cassert>
#include <cstdio>
#include <string>

#include "../event_journal.hpp"

static jsn::Value executionEvent(const std::string& msgId, const std::string& type, long long orderId, long long positionId) {
  jsn::Value tradeData{jsn::Object{}};
  tradeData.set("symbolId", 41.0);
  tradeData.set("label", std::string("AU|v1|VWAP|H|LN|4h|TR|iabc123456789"));
  jsn::Value order{jsn::Object{}};
  order.set("orderId", static_cast<double>(orderId));
  order.set("tradeData", tradeData);
  jsn::Value payload{jsn::Object{}};
  payload.set("ctidTraderAccountId", 4002.0);
  payload.set("executionType", type);
  payload.set("order", order);
  if (positionId > 0) {
    jsn::Value position{jsn::Object{}};
    position.set("positionId", static_cast<double>(positionId));
    position.set("tradeData", tradeData);
    payload.set("position", position);
  }
  jsn::Value frame{jsn::Object{}};
  if (!msgId.empty()) frame.set("clientMsgId", msgId);
  frame.set("payloadType", 2126.0);
  frame.set("payload", payload);
  return frame;
}

static jsn::Value orderError(const std::string& msgId, const std::string& code, long long orderId) {
  jsn::Value payload{jsn::Object{}};
  payload.set("ctidTraderAccountId", 4002.0);
  payload.set("errorCode", code);
  payload.set("orderId", static_cast<double>(orderId));
  jsn::Value frame{jsn::Object{}};
  frame.set("clientMsgId", msgId);
  frame.set("payloadType", 2132.0);
  frame.set("payload", payload);
  return frame;
}

static void test_parse_reads_the_ids_the_ledger_settles_on() {
  const ExecutionEventRecord r = EventJournal::parse(executionEvent("cx7", "ORDER_FILLED", 555, 777));
  assert(r.clientMsgId == "cx7" && r.payloadType == 2126 && r.executionType == "ORDER_FILLED");
  assert(r.orderId == 555 && r.positionId == 777 && r.accountId == 4002 && r.symbolId == 41);
  assert(r.label == "AU|v1|VWAP|H|LN|4h|TR|iabc123456789" && r.errorCode.empty());
  const ExecutionEventRecord e = EventJournal::parse(orderError("cx8", "TRADING_BAD_VOLUME", 556));
  assert(e.payloadType == 2132 && e.errorCode == "TRADING_BAD_VOLUME" && e.orderId == 556 && e.positionId == 0);
}

static void test_records_only_event_frames_and_keeps_solicited_apart() {
  EventJournal j(8, "boot-a");
  assert(j.latestSeq() == 0 && j.since(0).empty());
  jsn::Value heartbeat{jsn::Object{}};
  heartbeat.set("payloadType", 51.0);
  assert(!j.record(heartbeat, false));
  assert(j.record(executionEvent("cx1", "ORDER_ACCEPTED", 1, 0), true));
  assert(j.record(executionEvent("", "ORDER_FILLED", 1, 9), false)); // a late, id-less frame
  assert(j.record(orderError("cx2", "MARKET_CLOSED", 2), true));
  const auto all = j.since(0);
  assert(all.size() == 3 && all[0].seq == 1 && all[2].seq == 3);
  assert(all[0].solicited && !all[1].solicited && all[2].solicited);
  assert(all[1].clientMsgId.empty() && all[1].positionId == 9);
  assert(j.since(2).size() == 1 && j.since(2)[0].errorCode == "MARKET_CLOSED");
}

static void test_ring_wraps_and_the_cursor_contract_matches_the_decision_ring() {
  EventJournal j(4, "boot-b");
  for (int i = 1; i <= 6; ++i) j.record(executionEvent("cx" + std::to_string(i), "ORDER_ACCEPTED", i, 0), true);
  assert(j.latestSeq() == 6);
  const auto tail = j.since(0);
  assert(tail.size() == 4 && tail.front().seq == 3 && tail.back().seq == 6); // the oldest two were overwritten
  const std::string own = j.dumpJson(5, "boot-b");
  assert(own.find("\"latestSeq\":6") != std::string::npos);
  assert(own.find("\"clientMsgId\":\"cx6\"") != std::string::npos && own.find("\"clientMsgId\":\"cx5\"") == std::string::npos);
  const std::string other = j.dumpJson(5, "boot-z"); // a cursor from another boot means nothing here
  assert(other.find("\"clientMsgId\":\"cx3\"") != std::string::npos);
  assert(other.find("\"bootId\":\"boot-b\"") != std::string::npos);
}

int main() {
  test_parse_reads_the_ids_the_ledger_settles_on();
  test_records_only_event_frames_and_keeps_solicited_apart();
  test_ring_wraps_and_the_cursor_contract_matches_the_decision_ring();
  std::puts("test_event_journal: all passed");
  return 0;
}
