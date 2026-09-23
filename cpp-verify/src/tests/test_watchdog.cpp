#include "../watchdog.hpp"
#include "../watchdog_http.hpp"
#include <cassert>
#include <iostream>
using jsn::Value; using jsn::Object; using jsn::Array;
namespace {
constexpr long long T = 1800000000000LL;
Value parse(const char* s) { return *jsn::parse(s); }
Value calendar() {
  return Value(Object{{"identity", Object{{"provider", "ctrader"}, {"accountId", "11"}, {"host", "demo.ctraderapi.com"}, {"symbolId", "7"}}},
    {"source", "ctrader:ProtoOASymbol"}, {"version", "frozen"}, {"observedAtMs", T}, {"expiresAtMs", T + 86400000},
    {"fromMs", T}, {"toMs", T + 86400000}, {"intervals", Array{Value(Object{{"fromMs", T}, {"toMs", T + 86400000}})}}});
}
Value work(const std::string& id = "one", const std::string& role = "management") {
  return Value(Object{{"id", id}, {"role", role}, {"accountId", "11"}, {"symbolId", "7"}, {"host", "demo.ctraderapi.com"},
    {"calendar", calendar()}, {"lastCompletedAtMs", T}, {"nextDueMs", T + 3000}, {"closedAuditDueMs", T + 60000}});
}
Value contract(Array work = {}, long long at = T) { return Value(Object{{"schemaVersion", 1}, {"service", "node"}, {"observedAtMs", at}, {"workComplete", true}, {"work", work}}); }
bool active(const verify::WatchState& s, const std::string& id) { return s.snapshot().get("incidents").get(id).get("active").asBool(); }
void healthy(verify::WatchState& s, Array w, long long at) { s.probe("node", true, contract(std::move(w), at), at); s.evaluate(at); }
}
int main() {
  {
    verify::WatchState s; s.probe("node", false, {}, T); s.evaluate(T + 59999);
    assert(!active(s, "node:unreachable")); s.evaluate(T + 60000); assert(active(s, "node:unreachable"));
    verify::WatchState reboot; assert(reboot.restore(s.snapshot())); reboot.probe("node", false, {}, T + 65000); reboot.evaluate(T + 65000);
    assert(reboot.snapshot().get("outbox").asObject().size() == s.snapshot().get("outbox").asObject().size());
    healthy(reboot, {}, T + 70000); assert(!active(reboot, "node:unreachable"));
    const auto count = reboot.snapshot().get("outbox").asObject().size(); healthy(reboot, {}, T + 75000);
    assert(reboot.snapshot().get("outbox").asObject().size() == count); // one recovery
  }
  {
    verify::WatchState s; auto a = work(), b = work("healthy");
    b.set("nextDueMs", T + 999999); healthy(s, {a, b}, T);
    healthy(s, {a, b}, T + 64000); // fresh HTTP/contract, stale one-position work
    assert(active(s, "node:work:one:stalled")); assert(!active(s, "node:work:healthy:stalled"));
    assert(!active(s, "node:unreachable"));
    a.set("lastCompletedAtMs", T + 65000); a.set("nextDueMs", T + 68000); healthy(s, {a, b}, T + 65000);
    assert(!active(s, "node:work:one:stalled"));
    a.set("quoteMaxAgeMs", 10000); a.set("lastQuoteAtMs", T); healthy(s, {a, b}, T + 66000);
    assert(active(s, "node:work:one:quote"));
  }
  {
    verify::WatchState s; auto w = work("scan", "scanner"); w.set("outcome", "no_signal");
    healthy(s, {w}, T + 120000); assert(!active(s, "node:work:scan:stalled"));
    healthy(s, {w}, T + 123000); assert(active(s, "node:work:scan:stalled"));
    w.set("calendar", Value()); healthy(s, {w}, T + 124000);
    assert(active(s, "node:work:scan:calendar")); assert(active(s, "node:work:scan:stalled")); // unknown cannot recover
    healthy(s, {}, T + 125000); assert(!active(s, "node:work:scan:stalled")); // complete inventory retirement
  }
  {
    verify::WatchState s; auto w = work("orders", "entry_activity"); w.set("ordersSinceOpen", 0); w.set("sessionOpenedAtMs", T); w.set("sessionId", "actual-broker-open");
    healthy(s, {w}, T + 300000); assert(!active(s, "node:no_orders:11:actual-broker-open"));
    w.set("activityComplete", true); w.set("nextDueMs", T + 600000);
    healthy(s, {w}, T + 300000);
    const auto id = "node:no_orders:11:actual-broker-open";
    assert(s.snapshot().get("incidents").get(id).get("severity").asString() == "info");
    const auto serial = s.snapshot().get("incidents").get(id).get("serial").asNumber();
    verify::WatchState reboot; assert(reboot.restore(s.snapshot())); healthy(reboot, {w}, T + 3600000);
    assert(reboot.snapshot().get("incidents").get(id).get("serial").asNumber() == serial);
    w.set("hasRecordedOrder", true); w.set("ordersSinceOpen", Value());
    w.set("lastCompletedAtMs", T + 3600000); w.set("nextDueMs", T + 3900000);
    healthy(reboot, {w}, T + 3600000); assert(!active(reboot, id));
    assert(reboot.snapshot().get("incidents").get(id).get("serial").asNumber() == serial); // informational resolution sends no recovery alert
    w.set("hasRecordedOrder", false); w.set("ordersSinceOpen", 0);
    healthy(reboot, {w}, T + 3600001); assert(!active(reboot, id)); // one notice per account/session
  }
  {
    verify::WatchState s;
    auto quote = work("quote", "quote_flow"); quote.set("calendar", Value()); quote.set("lastQuoteAtMs", T); quote.set("quoteMaxAgeMs", 60000);
    auto gateway = work("reconcile", "gateway"); gateway.set("calendar", Value()); gateway.set("nextDueMs", T + 30000);
    auto node = contract(); node.set("calendars", Array{Value(Object{{"identity", calendar().get("identity")}, {"calendar", calendar()}})});
    s.probe("node", true, node, T);
    auto c = contract({quote, gateway}); c.set("service", "cpp-exec"); s.probe("cpp-exec", true, c, T); s.evaluate(T);
    assert(!active(s, "cpp-exec:work:quote:calendar"));
    s.probe("node", false, {}, T + 1);
    c.set("observedAtMs", T + 90000); s.probe("cpp-exec", true, c, T + 90000); s.evaluate(T + 90000);
    assert(active(s, "cpp-exec:work:quote:quote")); assert(active(s, "cpp-exec:work:reconcile:stalled"));
    assert(!active(s, "cpp-exec:work:quote:calendar")); // original verified calendar survives Node loss
    c.set("observedAtMs", T + 86400001); s.probe("cpp-exec", true, c, T + 86400001); s.evaluate(T + 86400001);
    assert(active(s, "cpp-exec:work:quote:calendar")); assert(active(s, "cpp-exec:work:quote:quote")); // expiry cannot clear it
  }
  {
    verify::WatchState s; auto accepted = work("limit", "intent"), missing = work("lost", "intent");
    accepted.set("state", "ACCEPTED"); accepted.set("deadlineMs", T);
    missing.set("state", "SENT"); missing.set("deadlineMs", T + 60000);
    healthy(s, {accepted, missing}, T + 60000);
    assert(!active(s, "node:work:limit:intent")); assert(active(s, "node:work:lost:intent"));
  }
  {
    verify::WatchState s;
    auto a = parse(R"({"accountId":"11","host":"demo.ctraderapi.com","ok":true,"source":"broker_reconcile","positions":[{"positionId":"99","stopLoss":1,"takeProfit":null}],"missingSl":0,"missingTp":1})");
    a.set("checkedAtMs", T); a.set("openCount", 1);
    s.protection(Value(Object{{"accounts", Array{a}}}), T);
    const auto key = "protection:demo.ctraderapi.com:11:missing"; assert(active(s, key));
    a.set("ok", false); s.protection(Value(Object{{"accounts", Array{a}}}), T + 1000); assert(active(s, key));
    a.set("ok", true); a.set("positions", Array{}); a.set("openCount", 0); a.set("missingTp", 0);
    s.protection(Value(Object{{"accounts", Array{a}}}), T + 2000); assert(!active(s, key));
    auto next = s.nextDelivery(T + 2000); assert(!next.isNull());
    const auto id = next.get("id").asString(); s.delivery(id, false, "", 90000, T + 2000);
    assert(s.snapshot().get("outbox").get(id).get("nextAtMs").asNumber() == T + 92000);
    verify::WatchState reboot; assert(reboot.restore(s.snapshot())); assert(reboot.snapshot().get("outbox").get(id).get("attempts").asNumber() == 1);
    reboot.delivery(id, true, "123", T + 92000, T + 92000); assert(reboot.snapshot().get("outbox").get(id).isNull());
    assert(reboot.snapshot().get("incidents").get(next.get("incidentId").asString()).get("telegramMessageId").asString() == "123");
  }
  {
    verify::WatchState s; auto w = work(); auto cal = calendar(); cal.set("observedAtMs", T + 1); w.set("calendar", cal);
    healthy(s, {w}, T); assert(active(s, "node:work:one:calendar"));
    auto body = contract(); body.set("workComplete", false); s.probe("node", true, body, T + 1000); s.evaluate(T + 61000);
    assert(active(s, "node:work_evidence")); // HTTP 200 and timer do not confer completed-work evidence
    assert(!s.restore(Value(Object{})));
    assert(!verify::watchHttp("file:///etc/hosts", "").received);
  }
  {
    verify::WatchState s; auto body = contract();
    body.set("notificationPolicy", Value(Object{{"owner", "cpp-verify"}, {"enabled", true}, {"observedAtMs", T},
      {"expiresAtMs", T + 86400000}, {"urgentBypass", false}, {"quietIntervals", Array{Value(Object{{"fromMs", T}, {"toMs", T + 3600000}})}}}));
    s.probe("node", true, body, T);
    Value urgent(Object{{"severity", "urgent"}});
    assert(!verify::watchAllowsNotification(s.snapshot(), urgent, T));
    auto policy = body.get("notificationPolicy"); policy.set("urgentBypass", true); body.set("notificationPolicy", policy);
    s.probe("node", true, body, T); s.probe("node", false, {}, T + 60000);
    verify::WatchState reboot; assert(reboot.restore(s.snapshot()));
    assert(verify::watchAllowsNotification(reboot.snapshot(), urgent, T + 60000)); // independent Node-down delivery policy
    assert(!verify::watchAllowsNotification(reboot.snapshot(), urgent, T + 86400000));
    policy.set("enabled", false); body.set("notificationPolicy", policy); s.probe("node", true, body, T);
    assert(!verify::watchAllowsNotification(s.snapshot(), urgent, T)); // master OFF overrides urgent bypass
  }
  {
    verify::WatchPolicy p; p.accountGraceMs = Value(Object{{"11", Object{{"management", 1000}}}});
    verify::WatchState s(p); healthy(s, {work()}, T + 4000); assert(active(s, "node:work:one:stalled"));
    auto future = work(); future.set("lastCompletedAtMs", T + 999999);
    healthy(s, {future}, T + 5000); assert(active(s, "node:work:one:clock")); assert(active(s, "node:work:one:stalled"));
  }
  {
    verify::WatchState s; auto w = work("ticks", "scanner");
    healthy(s, {w}, T + 123000); assert(active(s, "node:work:ticks:stalled"));
    w.set("state", "waiting_for_quote"); w.set("pending", 0); w.set("nextDueMs", Value());
    w.set("quoteMaxAgeMs", 10000); w.set("lastQuoteAtMs", T);
    healthy(s, {w}, T + 124000);
    assert(!active(s, "node:work:ticks:stalled"));
    assert(!active(s, "node:work:ticks:deadline_unknown"));
    assert(active(s, "node:work:ticks:quote"));
    w.set("pending", 1); healthy(s, {w}, T + 125000);
    assert(active(s, "node:work:ticks:deadline_unknown"));
  }
  {
    verify::WatchState s;
    Value session(Object{{"host", "demo.ctraderapi.com"}, {"accounts", Array{Value("11")}}});
    s.protection(Value(Object{{"accounts", Array{}}, {"sessions", Array{session}}}), T);
    assert(active(s, "protection:demo.ctraderapi.com:11:unknown"));
    Value a(Object{{"host", "demo.ctraderapi.com"}, {"accountId", "11"}, {"ok", true},
      {"source", "broker_reconcile"}, {"checkedAtMs", T}, {"openCount", 0},
      {"positions", Array{}}, {"missingSl", 0}, {"missingTp", 0}});
    s.protection(Value(Object{{"accounts", Array{a}}, {"sessions", Array{session}}}), T);
    assert(!active(s, "protection:demo.ctraderapi.com:11:unknown"));
  }
  std::cout << "watchdog failure, work, recovery and restart checks passed\n";
}
