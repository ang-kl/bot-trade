#include "../watchdog.hpp"
#include "../watchdog_http.hpp"
#include <cassert>
#include <fstream>
#include <iostream>
#include <sstream>
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
  {
    // The no_orders notice's blocker line, driven by the SAME Node item shape
    // that agent/services/scanner-integration.test.js pins on the Node side:
    // Node sends `blocker` as a string and the notice must print it.
    std::ifstream f("src/tests/fixtures/node-entry-activity.json"); assert(f);
    std::stringstream raw; raw << f.rdbuf(); const auto item = jsn::parse(raw.str()); assert(item && item->get("blocker").isString());
    verify::WatchState s; const long long now = item->get("lastCompletedAtMs").asNumber();
    healthy(s, {*item}, now);
    const auto id = "node:no_orders:11:" + item->get("sessionId").asString();
    assert(active(s, id));
    const auto next = s.nextDelivery(now); assert(next.get("incidentId").asString() == id);
    const auto text = verify::watchNotificationText(next, now);
    assert(text.find("blocker: " + item->get("blocker").asString()) != std::string::npos);
    assert(s.status(now).get("incidents").get(id).get("detail").get("blocker").asString() == item->get("blocker").asString());
  }
  {
    // Persist-strip: Node's entryDiagnostics rides every contract (up to
    // 32 KiB). The relay keeps it in memory; the fsynced state never holds it,
    // and a state written by an older build is stripped on restore.
    verify::WatchState s; auto body = contract();
    body.set("entryDiagnostics", Value(Object{{"schemaVersion", 1}, {"source", "node_records"}, {"complete", true}, {"accounts", Array{}}}));
    s.probe("node", true, body, T);
    assert(s.snapshot().get("services").get("node").get("contract").isObject());
    assert(s.snapshot().get("services").get("node").get("contract").get("entryDiagnostics").isNull());
    assert(s.nodeEntryDiagnostics().get("source").asString() == "node_records" && s.nodeEntryDiagnosticsAtMs() == T);
    assert(jsn::dump(s.snapshot()).find("entryDiagnostics") == std::string::npos);
    // A later contract without the block clears the relay's copy.
    s.probe("node", true, contract({}, T + 1000), T + 1000);
    assert(s.nodeEntryDiagnostics().isNull() && s.nodeEntryDiagnosticsAtMs() == T + 1000);
    // An invalid contract does not replace it.
    s.probe("node", true, body, T + 2000); auto bad = body; bad.set("workComplete", false); s.probe("node", true, bad, T + 3000);
    assert(s.nodeEntryDiagnosticsAtMs() == T + 2000);
    auto old = s.snapshot(); auto services = old.get("services").asObject(); auto node = services["node"].asObject();
    auto stored = node["contract"].asObject(); stored["entryDiagnostics"] = body.get("entryDiagnostics");
    node["contract"] = Value(stored); services["node"] = Value(node); old.set("services", Value(services));
    assert(jsn::dump(old).find("entryDiagnostics") != std::string::npos);
    verify::WatchState reboot; assert(reboot.restore(old));
    assert(jsn::dump(reboot.snapshot()).find("entryDiagnostics") == std::string::npos);
    assert(reboot.nodeEntryDiagnostics().isNull() && reboot.nodeEntryDiagnosticsAtMs() == 0); // never relayed from disk
  }
  {
    // Node's scanner collector is calendar-free liveness: a missing deadline
    // is a warning, a passed one (plus the service grace) a warning stall.
    verify::WatchState s; auto w = work("scanner-bridge:collector", "collector"); w.set("calendar", Value());
    w.set("lastCompletedAtMs", T); w.set("nextDueMs", T + 120000);
    healthy(s, {w}, T + 179999); assert(!active(s, "node:work:scanner-bridge:collector:stalled"));
    assert(!active(s, "node:work:scanner-bridge:collector:calendar")); // no calendar is not a calendar fault here
    healthy(s, {w}, T + 180000); assert(active(s, "node:work:scanner-bridge:collector:stalled"));
    assert(s.snapshot().get("incidents").get("node:work:scanner-bridge:collector:stalled").get("severity").asString() == "warning");
    w.set("lastCompletedAtMs", T + 180000); w.set("nextDueMs", T + 300000); healthy(s, {w}, T + 180000);
    assert(!active(s, "node:work:scanner-bridge:collector:stalled")); // recovers on a fresh round
    w.set("nextDueMs", Value()); healthy(s, {w}, T + 181000);
    assert(active(s, "node:work:scanner-bridge:collector:deadline_unknown"));
    // A gateway's stall stays urgent.
    auto g = work("reconcile", "gateway"); g.set("calendar", Value()); g.set("nextDueMs", T);
    healthy(s, {g}, T + 60000);
    assert(s.snapshot().get("incidents").get("node:work:reconcile:stalled").get("severity").asString() == "urgent");
  }
  {
    // V3 CV-2 (OD-10): delivery is MUTED by default through a 24 h soak.
    // The outbox still fills and the would-send counters count it; nothing
    // is releasable until the soak has ended AND the mute was lifted.
    verify::WatchState s; s.beginSoak(T);
    s.probe("node", false, {}, T); s.evaluate(T + 60000);
    assert(active(s, "node:unreachable"));
    assert(!s.nextDelivery(T + 60000).isNull()); // queued
    assert(s.releasable(T + 60000).isNull());    // CV-2 mute: nothing leaves
    assert(!s.deliveryOpen(T + 60000));
    const auto d = s.status(T + 60000).get("delivery");
    assert(d.get("muted").asBool() && d.get("soakActive").asBool() && !d.get("open").asBool());
    assert(d.get("soakStartedAtMs").asNumber() == T && d.get("soakEndsAtMs").asNumber() == T + 86400000);
    assert(d.get("reason").asString() == "soak_active");
    assert(d.get("wouldSend").get("urgent").asNumber() == 1 && d.get("wouldSend").get("total").asNumber() == 1);
    assert(d.get("wouldSend").get("urgentPerHour").asNumber() == 60); // one in the first minute
    // Unmuting is refused during the soak, and the soak's end alone never unmutes.
    assert(s.setMuted(false, T + 86399999) == "soak_active"); assert(s.releasable(T + 86399999).isNull());
    assert(s.releasable(T + 86400000).isNull());
    assert(s.status(T + 86400000).get("delivery").get("reason").asString() == "muted_after_soak_explicit_unmute_required");
    // A restart keeps the soak and the counters: beginSoak does not restart it.
    verify::WatchState reboot; assert(reboot.restore(s.snapshot())); reboot.beginSoak(T + 90000000);
    const auto r = reboot.status(T + 86400000).get("delivery");
    assert(r.get("soakEndsAtMs").asNumber() == T + 86400000 && r.get("muted").asBool());
    assert(r.get("wouldSend").get("urgent").asNumber() == 1);
    // After the soak, an explicit unmute opens delivery; a re-mute closes it at once.
    assert(reboot.setMuted(false, T + 86400000).empty()); assert(reboot.deliveryOpen(T + 86400000));
    assert(!reboot.releasable(T + 86400000).isNull());
    reboot.probe("cpp-exec", false, {}, T + 86400000); reboot.evaluate(T + 86460000);
    assert(active(reboot, "cpp-exec:unreachable"));
    assert(reboot.status(T + 86460000).get("delivery").get("wouldSend").get("urgent").asNumber() == 1); // open: not a would-send
    verify::WatchState open; assert(open.restore(reboot.snapshot())); assert(open.deliveryOpen(T + 86460000)); // unmute persists
    assert(reboot.setMuted(true, T + 86460001).empty()); assert(reboot.releasable(T + 86460001).isNull());
  }
  {
    // A pre-CV-2 file (no delivery key) restores MUTED with no soak; the soak
    // starts at this boot. A malformed delivery block restores muted too.
    verify::WatchState s; s.probe("node", false, {}, T); s.evaluate(T + 60000);
    auto old = s.snapshot(); auto fields = old.asObject(); fields.erase("delivery"); old = Value(fields);
    verify::WatchState r; assert(r.restore(old));
    assert(r.setMuted(false, T + 999999999) == "soak_active"); // no soak begun: cannot open
    assert(r.releasable(T + 999999999).isNull());
    r.beginSoak(T + 100000); assert(r.status(T + 100000).get("delivery").get("soakEndsAtMs").asNumber() == T + 100000 + 86400000);
    auto bad = s.snapshot(); bad.set("delivery", Value(Object{{"muted", "no"}, {"soakStartedAtMs", T}, {"soakEndsAtMs", T + 1}}));
    verify::WatchState b; assert(b.restore(bad)); assert(!b.deliveryOpen(T + 2));
    // An unmuted file whose soak window is not exactly soakMs from a real
    // start restores muted with no soak (fix-round nit 3).
    for (const auto& [start, end] : {std::pair{T, T + 1}, std::pair{0LL, 86400000LL}, std::pair{T, T + 2 * 86400000LL}}) {
      auto w = s.snapshot(); w.set("delivery", Value(Object{{"muted", false}, {"soakStartedAtMs", start}, {"soakEndsAtMs", end}}));
      verify::WatchState x; assert(x.restore(w)); assert(!x.deliveryOpen(T + 3 * 86400000LL));
      assert(x.status(T).get("delivery").get("reason").asString() == "soak_not_started");
    }
    { auto w = s.snapshot(); w.set("delivery", Value(Object{{"muted", false}, {"soakStartedAtMs", T}, {"soakEndsAtMs", T + 86400000}}));
      verify::WatchState x; assert(x.restore(w)); assert(x.deliveryOpen(T + 86400000)); } // the exact window is kept
    // Rollback: a CV-2 file still satisfies every check the pre-CV-2 restore()
    // makes (schema 1, the three objects, their bounds, 4 MiB); it ignores
    // the extra key.
    const auto snap = s.snapshot();
    assert(snap.get("schemaVersion").asNumber() == 1 && snap.get("services").isObject()
      && snap.get("incidents").isObject() && snap.get("outbox").isObject() && jsn::dump(snap).size() < 4 * 1024 * 1024);
  }
  std::cout << "watchdog failure, work, recovery and restart checks passed\n";
}
