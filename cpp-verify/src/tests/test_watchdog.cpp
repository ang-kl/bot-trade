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

// ---- V3 CV-2 fix round: the would-send counter against ground truth ----
constexpr long long HOUR = 3600000, DAY = 86400000, CYCLE = 15000;
// A deep copy: a jsn::Value copy SHARES its object, so set() on a copy would
// edit the original snapshot too.
Value clone(const Value& v) { return *jsn::parse(jsn::dump(v)); }
// The owner's dispose step (a route still to come): the same state, outbox empty.
Value disposed(const Value& snap) { auto s = clone(snap); s.set("outbox", Value(Object{})); return s; }
// A delivery block whose soak ended a day before T, muted or not.
Value afterSoak(const Value& snap, bool muted) {
  auto s = clone(snap);
  s.set("delivery", Value(Object{{"muted", muted}, {"soakStartedAtMs", T - 2 * DAY}, {"soakEndsAtMs", T - DAY}}));
  return s;
}
bool pendingFor(const verify::WatchState& s, const std::string& id) {
  const auto snap = s.snapshot(); // held: a range-for over a temporary's member dangles
  for (const auto& [key, item] : snap.get("outbox").asObject()) if (item.get("incidentId").asString() == id) return true;
  return false;
}
// Production's outbox of 25-09-2026: 512 urgent items of RESOLVED incidents,
// none attempted, the oldest `oldest` (2026-09-23T09:51Z there), one a minute.
Value backlog(long long oldest, Object incidents = {}) {
  Object outbox;
  for (int i = 0; i < 512; ++i) {
    const auto incident = "cpp-exec:work:quote:" + std::to_string(10000 + i) + ":quote";
    const auto id = incident + ":1";
    const long long at = oldest + i * 60000LL;
    outbox[id] = Value(Object{{"id", id}, {"incidentId", incident}, {"transition", "opened"}, {"severity", "urgent"},
      {"detail", Object{{"service", "cpp-exec"}, {"reason", "fixture_backlog"}}}, {"createdAtMs", at}, {"nextAtMs", at},
      {"attempts", 0}, {"accepted", false}});
    incidents[incident] = Value(Object{{"active", false}, {"serial", 1}, {"severity", "urgent"}, {"openedAtMs", at},
      {"lastQueuedAtMs", at}, {"resolvedAtMs", T - HOUR}});
  }
  return Value(Object{{"schemaVersion", 1}, {"services", Object{}}, {"incidents", incidents}, {"outbox", outbox}, {"dropped", 1284925}});
}
// One broker-verified account whose one position has no stop loss (urgent), or none.
Value missingSl(long long now, bool missing) {
  Array positions; if (missing) positions.push_back(Value(Object{{"positionId", "99"}, {"stopLoss", 0}, {"takeProfit", 2}}));
  return Value(Object{{"accounts", Array{Value(Object{{"host", "demo.ctraderapi.com"}, {"accountId", "11"}, {"ok", true},
    {"source", "broker_reconcile"}, {"checkedAtMs", now}, {"openCount", static_cast<long long>(positions.size())},
    {"positions", positions}, {"missingSl", missing ? 1 : 0}, {"missingTp", 0}})}}});
}
// Round 3: one broker-verified account row — `missing` gives its one position
// no stop loss (the urgent :missing incident); `ok` false makes the read
// unknown (the :unknown warning) with no position.
Value row(long long now, const std::string& account, bool missing, bool ok = true) {
  Array positions; if (missing && ok) positions.push_back(Value(Object{{"positionId", "99"}, {"stopLoss", 0}, {"takeProfit", 2}}));
  return Value(Object{{"host", "demo.ctraderapi.com"}, {"accountId", account}, {"ok", ok}, {"source", "broker_reconcile"},
    {"checkedAtMs", now}, {"openCount", static_cast<long long>(positions.size())}, {"positions", positions},
    {"missingSl", static_cast<long long>(positions.size())}, {"missingTp", 0}});
}
Value accounts(Array rows) { return Value(Object{{"accounts", std::move(rows)}}); }
Value emptyAfterSoak() { return afterSoak(Value(Object{{"schemaVersion", 1}, {"services", Object{}}, {"incidents", Object{}}, {"outbox", Object{}}}), false); }
// GROUND TRUTH: the same inputs, each probe cycle, to a muted verifier and to
// an OPEN one that releases one item per cycle, accepted by Telegram. The
// counter is right when the muted twin's wouldSend equals what the open twin
// sent. The open twin starts with the held backlog disposed of: an always-open
// verifier would have sent it when it was created (and counted it then).
struct Twin {
  verify::WatchState muted, open;
  long long sent = 0, urgent = 0, warning = 0, info = 0;
  bool released = false; // the last cycle sent something (false once the open outbox is drained)
  explicit Twin(verify::WatchPolicy p = {}) : muted(p), open(p) {}
  template <class Drive> void cycle(long long now, Drive drive) {
    drive(muted, now); drive(open, now);
    const auto next = open.releasable(now);
    released = !next.isNull();
    if (next.isNull()) return;
    ++sent; const auto& sev = next.get("severity").asString();
    ++(sev == "urgent" ? urgent : sev == "warning" ? warning : info);
    open.delivery(next.get("id").asString(), true, "1", 0, now);
  }
  Value would(long long now) const { return muted.status(now).get("delivery"); }
  // The equality the blockers ask for, severity by severity. `wouldDeliver`
  // (the modelled sender) must equal what the open verifier SENT, and its
  // queue must hold what the open verifier's outbox holds, always.
  // `wouldSend` (demand) equals it only while no more than one message a
  // cycle is due, so `demandEqual` is asked of unsaturated scenarios only. A
  // mismatch names its scenario and both readings before the assert stops.
  void matches(long long now, const char* scenario, bool demandEqual = true) const {
    const auto d = would(now);
    const auto check = [&](const char* name, const Value& c) {
      const bool equal = c.get("total").asNumber() == sent && c.get("urgent").asNumber() == urgent
        && c.get("warning").asNumber() == warning && c.get("info").asNumber() == info;
      if (!equal) std::cerr << scenario << ": " << name << " " << jsn::dump(c) << " but the open verifier sent " << sent
        << " (urgent " << urgent << ", warning " << warning << ", info " << info << ")\n";
      assert(equal);
    };
    check("wouldDeliver", d.get("wouldDeliver"));
    // One release a cycle can never read above the ceiling (round 4: the rate
    // once divided by one cycle too few, 245.11 against 240).
    const auto& rate = d.get("wouldDeliver").get("totalPerHour");
    if (rate.isNumber() && rate.asNumber() > d.get("sendCeilingPerHour").asNumber())
      std::cerr << scenario << ": wouldDeliver.totalPerHour " << rate.asNumber() << " above the ceiling " << d.get("sendCeilingPerHour").asNumber() << "\n";
    assert(!rate.isNumber() || rate.asNumber() <= d.get("sendCeilingPerHour").asNumber());
    const auto queued = static_cast<double>(open.snapshot().get("outbox").asObject().size());
    if (d.get("wouldDeliver").get("pending").asNumber() != queued)
      std::cerr << scenario << ": model queue " << d.get("wouldDeliver").get("pending").asNumber() << " but the open outbox holds " << queued << "\n";
    assert(d.get("wouldDeliver").get("pending").asNumber() == queued);
    if (demandEqual) {
      check("wouldSend", d.get("wouldSend"));
      assert(queued == 0); // everything it would send, it has sent
      assert(!d.get("saturated").asBool());
    }
  }
};
// The Node contract behind production's 149 active non-pending incidents:
// 129 work items on UNKNOWN calendars (warning) and 20 entry_activity
// sessions with no order (the once-only no_orders notice, info).
Value productionContract(long long now) {
  Array items;
  for (int i = 0; i < 129; ++i) items.push_back(Value(Object{{"id", "c" + std::to_string(i)}, {"role", "management"}, {"accountId", "11"},
    {"symbolId", "7"}, {"host", "demo.ctraderapi.com"}, {"calendar", Value()}, {"lastCompletedAtMs", now}, {"nextDueMs", now + 60000}}));
  for (int i = 0; i < 20; ++i) items.push_back(Value(Object{{"id", "a" + std::to_string(i)}, {"role", "entry_activity"}, {"accountId", "11"},
    {"symbolId", "7"}, {"host", "demo.ctraderapi.com"}, {"calendar", calendar()}, {"lastCompletedAtMs", now}, {"nextDueMs", now + 60000},
    {"activityComplete", true}, {"sessionOpenedAtMs", T - 30 * HOUR}, {"sessionId", "s" + std::to_string(i)}, {"ordersSinceOpen", 0}}));
  return contract(items, now);
}
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
    assert(d.get("wouldSend").get("urgentPerHour").asNumber() == 48); // one in the first minute: five cycles, 75 s of probing
    // Unmuting is refused during the soak, and the soak's end alone never unmutes.
    assert(s.setMuted(false, T + 86399999) == "soak_active"); assert(s.releasable(T + 86399999).isNull());
    assert(s.releasable(T + 86400000).isNull());
    assert(s.status(T + 86400000).get("delivery").get("reason").asString() == "muted_after_soak_explicit_unmute_required");
    // A restart keeps the soak and the counters: beginSoak does not restart it.
    verify::WatchState reboot; assert(reboot.restore(s.snapshot())); reboot.beginSoak(T + 90000000);
    const auto r = reboot.status(T + 86400000).get("delivery");
    assert(r.get("soakEndsAtMs").asNumber() == T + 86400000 && r.get("muted").asBool());
    assert(r.get("wouldSend").get("urgent").asNumber() == 1);
    // After the soak, the item the mute held for a day is a stale backlog: the
    // unmute is refused (fix-round nit 2) and nothing is disposed of.
    assert(reboot.setMuted(false, T + 86400000) == "stale_backlog"); assert(!reboot.deliveryOpen(T + 86400000));
    assert(reboot.snapshot().get("outbox").asObject().size() == 1);
    // Once the owner has disposed of it, an explicit unmute opens delivery; a re-mute closes it at once.
    verify::WatchState clean; assert(clean.restore(disposed(reboot.snapshot()))); clean.beginSoak(T + 90000000);
    assert(clean.setMuted(false, T + 86400000).empty()); assert(clean.deliveryOpen(T + 86400000));
    clean.probe("cpp-exec", false, {}, T + 86400000); clean.evaluate(T + 86460000);
    assert(active(clean, "cpp-exec:unreachable")); assert(!clean.releasable(T + 86460000).isNull());
    assert(clean.status(T + 86460000).get("delivery").get("wouldSend").get("urgent").asNumber() == 1); // open: not a would-send
    assert(clean.status(T + 86460000).get("delivery").get("wouldDeliver").get("urgent").asNumber() == 1); // nor a would-deliver (round 3)
    verify::WatchState open; assert(open.restore(clean.snapshot())); assert(open.deliveryOpen(T + 86460000)); // unmute persists
    assert(clean.setMuted(true, T + 86460001).empty()); assert(clean.releasable(T + 86460001).isNull());
    // Unmuting an already open verifier is not refused by what it has queued since.
    verify::WatchState again; assert(again.restore(open.snapshot()));
    assert(again.status(T + 90100000).get("delivery").get("staleBacklog").get("count").asNumber() > 0);
    assert(again.setMuted(false, T + 90100000).empty() && again.deliveryOpen(T + 90100000));
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
  {
    // CV-2 fix round, reproduction (A): ONE persistent urgent incident over the
    // bound. All 512 held items are urgent, so every offer is refused and the
    // incident is offered again each cycle. The pre-fix counter rose by one a
    // cycle (239 over 239 cycles); an open verifier sends it once in the hour.
    const auto snap = backlog(T - 71 * HOUR);
    Twin t; assert(t.muted.restore(snap)); t.muted.beginSoak(T);
    assert(t.open.restore(afterSoak(disposed(snap), false))); t.open.beginSoak(T);
    const auto dropped = t.muted.snapshot().get("dropped").asNumber();
    // (A cycle ends in evaluate(), as the run loop's does: the modelled sender releases there.)
    for (long long k = 0; k < 239; ++k) t.cycle(T + k * CYCLE, [](verify::WatchState& s, long long now) { s.protection(missingSl(now, true), now); s.evaluate(now); });
    const long long last = T + 238 * CYCLE;
    assert(t.sent == 1 && t.urgent == 1); t.matches(last, "(A) one persistent urgent incident over the bound");
    // Refused every cycle, counted once; `dropped` still counts every offer —
    // 239 of them, one a cycle: the retry was never delayed.
    const auto refused = t.would(last).get("refused");
    assert(refused.get("urgent").asNumber() == 1 && refused.get("total").asNumber() == 1);
    assert(t.muted.snapshot().get("dropped").asNumber() - dropped == 239);
    // One slot frees (the owner disposes of one item): the very next cycle stores it, counted by neither counter.
    const std::string key = "protection:demo.ctraderapi.com:11:missing";
    assert(!pendingFor(t.muted, key));
    t.muted.delivery(t.muted.snapshot().get("outbox").asObject().begin()->first, true, "disposed", 0, last + CYCLE);
    t.muted.protection(missingSl(last + CYCLE, true), last + CYCLE);
    assert(pendingFor(t.muted, key));
    assert(t.would(last + CYCLE).get("wouldSend").get("total").asNumber() == 1 && t.would(last + CYCLE).get("refused").get("total").asNumber() == 1);
  }
  {
    // Reproductions (C) and (F): production's restore of 25-09-2026 — the 512
    // urgent backlog of resolved incidents, never attempted, the oldest 71 h
    // old; 129 calendar warnings queued once long ago, 18 no_orders notices
    // never queued and 2 queued; every one active and none pending. After an
    // hour muted the pre-fix counter read 35,760 (149 x 240 cycles).
    Object incidents;
    for (int i = 0; i < 129; ++i) incidents["node:work:c" + std::to_string(i) + ":calendar"] = Value(Object{{"active", true},
      {"serial", 1 + i % 3}, {"severity", "warning"}, {"openedAtMs", T - 60 * HOUR}, {"lastQueuedAtMs", T - 60 * HOUR}, {"lastObservedAtMs", T - CYCLE}});
    for (int i = 0; i < 20; ++i) {
      Value r(Object{{"active", true}, {"serial", i < 18 ? 0 : 1}, {"severity", "info"}, {"openedAtMs", T - 30 * HOUR}, {"lastObservedAtMs", T - CYCLE}});
      if (i >= 18) r.set("lastQueuedAtMs", T - 30 * HOUR);
      incidents["node:no_orders:11:s" + std::to_string(i)] = r;
    }
    const auto snap = backlog(T - 71 * HOUR, incidents);
    const auto drive = [](verify::WatchState& s, long long now) { s.probe("node", true, productionContract(now), now); s.evaluate(now); };
    Twin t; assert(t.muted.restore(snap)); t.muted.beginSoak(T);
    assert(t.open.restore(afterSoak(disposed(snap), false))); t.open.beginSoak(T);
    const auto dropped = t.muted.snapshot().get("dropped").asNumber();
    for (long long k = 0; k < 240; ++k) t.cycle(T + k * CYCLE, drive);
    const long long last = T + 239 * CYCLE;
    // Ground truth: 129 warnings and the 18 never-queued notices, once each in
    // the hour (the repeats fall due at T + 1 h, the window's next cycle).
    assert(t.sent == 147 && t.warning == 129 && t.info == 18 && t.urgent == 0);
    t.matches(last, "(C) the production-shaped restore, 1 h");
    // Refused at the full bound every cycle (dropped: 147 x 240), counted once each.
    assert(t.would(last).get("refused").get("total").asNumber() == 147);
    assert(t.muted.snapshot().get("dropped").asNumber() - dropped == 147 * 240);
    // (F) the same restore OPEN with the backlog KEPT: one a cycle, all 240
    // messages are the stale backlog and none of the 147 current ones leaves
    // — what an unmute over a stale backlog would do (fix-round nit 2).
    // (The muted twin above already counted 147 with that backlog present.)
    verify::WatchState kept; assert(kept.restore(afterSoak(snap, false))); kept.beginSoak(T);
    long long keptSent = 0, keptStale = 0;
    for (long long k = 0; k < 240; ++k) {
      const long long now = T + k * CYCLE; drive(kept, now);
      const auto next = kept.releasable(now); if (next.isNull()) continue;
      ++keptSent; if (next.get("severity").asString() == "urgent" && next.get("createdAtMs").asNumber() < T) ++keptStale;
      kept.delivery(next.get("id").asString(), true, "1", 0, now);
    }
    assert(keptSent == 240 && keptStale == 240);
  }
  {
    // Reproduction (F), second half: one incident, an empty outbox, 3 h. The
    // open verifier sends it three times (opened, still_active at +1 h and
    // +2 h); the pre-fix counter read 1, because the muted item stays pending
    // and hid the repeats.
    Twin t; t.muted.beginSoak(T);
    assert(t.open.restore(afterSoak(Value(Object{{"schemaVersion", 1}, {"services", Object{}}, {"incidents", Object{}}, {"outbox", Object{}}}), false)));
    for (long long k = 0; k < 720; ++k) t.cycle(T + k * CYCLE, [](verify::WatchState& s, long long now) { s.protection(missingSl(now, true), now); s.evaluate(now); });
    const long long last = T + 719 * CYCLE;
    assert(t.sent == 3 && t.urgent == 3); t.matches(last, "(F) one incident, an empty outbox, 3 h");
    assert(t.would(last).get("refused").get("total").asNumber() == 0);
    assert(t.muted.snapshot().get("outbox").asObject().size() == 1); // counted, not queued: the opened item is still pending
    assert(t.would(last).get("wouldSend").get("urgentPerHour").asNumber() == 1.0);
  }
  {
    // Transitions: each opened, escalated and recovered message counts once,
    // as the open verifier sends it — a flap inside one repeat interval sends
    // every transition, not one per repeatMs.
    Twin t; t.muted.beginSoak(T);
    assert(t.open.restore(afterSoak(Value(Object{{"schemaVersion", 1}, {"services", Object{}}, {"incidents", Object{}}, {"outbox", Object{}}}), false)));
    for (long long k = 0; k < 240; ++k) t.cycle(T + k * CYCLE, [k](verify::WatchState& s, long long now) {
      s.protection(missingSl(now, k < 10 || (k >= 20 && k < 30)), now); // opened, recovered, opened, recovered
      auto g = work("g", k < 50 ? "collector" : "gateway"); g.set("calendar", Value()); g.set("lastCompletedAtMs", now);
      g.set("nextDueMs", k < 100 ? T - 2 * 60000 : now + 60000); // a warning stall, escalated at k=50, recovered at k=100
      healthy(s, {g}, now);
    });
    const long long last = T + 239 * CYCLE;
    assert(t.sent == 7 && t.urgent == 6 && t.warning == 1); t.matches(last, "transitions: flaps, an escalation, recoveries");
  }
  {
    // Round 3, B1 reproduction S5 — demand above the send ceiling. The run loop
    // releases ONE item a probe cycle (240 an hour at 15 s); 300 persistent
    // urgent incidents an hour are 1.25 due a cycle. Here at 1:10 scale — 30
    // incidents, repeatMs 6 min (24 cycles), the same 1.25 a cycle — for 12
    // repeat periods, then all recover and the open outbox drains. At full
    // scale (12 h) demand read 3,600 against 2,880 sent, and 3,900 against
    // 3,392 drained. wouldDeliver must equal the open verifier's sends at every
    // checkpoint; demand exceeds them, and the reading says so (saturated).
    verify::WatchPolicy p; p.repeatMs = 24 * CYCLE;
    Twin t(p); t.muted.beginSoak(T); assert(t.open.restore(emptyAfterSoak())); t.open.beginSoak(T);
    const auto fleet = [](bool missing) { return [missing](verify::WatchState& s, long long now) {
      Array rows; for (int i = 1; i <= 30; ++i) rows.push_back(row(now, std::to_string(i), missing));
      s.protection(accounts(rows), now); s.evaluate(now); }; };
    long long k = 0;
    for (; k < 24; ++k) t.cycle(T + k * CYCLE, fleet(true));
    t.matches(T + (k - 1) * CYCLE, "(S5) one repeat period", false);
    assert(t.sent == 24 && t.would(T + (k - 1) * CYCLE).get("wouldSend").get("total").asNumber() == 30);
    assert(t.would(T + (k - 1) * CYCLE).get("saturated").asBool());
    assert(t.would(T + (k - 1) * CYCLE).get("sendCeilingPerHour").asNumber() == 240);
    for (; k < 12 * 24; ++k) t.cycle(T + k * CYCLE, fleet(true));
    t.matches(T + (k - 1) * CYCLE, "(S5) twelve repeat periods", false);
    assert(t.sent == 288 && t.would(T + (k - 1) * CYCLE).get("wouldSend").get("total").asNumber() == 360);
    do { t.cycle(T + k * CYCLE, fleet(false)); ++k; } while (t.released && k < 12 * 24 + 1000);
    t.matches(T + (k - 1) * CYCLE, "(S5) recovered and drained", false);
    const auto d = t.would(T + (k - 1) * CYCLE);
    assert(d.get("wouldSend").get("total").asNumber() == 390 && d.get("wouldDeliver").get("total").asNumber() == t.sent && t.sent < 390);
    assert(d.get("saturated").asBool()); // repeats folded into items still pending were never delivered
  }
  {
    // Round 3, B1 reproduction S6 — two urgent incidents flapping every cycle:
    // two transitions due a cycle against one sent, so the open outbox fills
    // to its 512 bound and drops. Demand read 480 against 240 sent after 1 h,
    // and 2,880 against 1,951 drained after 6 h (the gap is what the open
    // outbox itself dropped). The muted verifier RESTARTS every hour, as a
    // deploy would: the modelled sender's queue and counters persist.
    Twin t; t.muted.beginSoak(T); assert(t.open.restore(emptyAfterSoak())); t.open.beginSoak(T);
    long long k = 0;
    const auto flap = [&k](verify::WatchState& s, long long now) {
      s.protection(accounts(Array{row(now, "1", k % 2 == 0), row(now, "2", k % 2 == 0)}), now); s.evaluate(now); };
    const auto openDropped0 = t.open.snapshot().get("dropped").asNumber();
    for (; k < 240; ++k) t.cycle(T + k * CYCLE, flap);
    t.matches(T + (k - 1) * CYCLE, "(S6) 1 h", false);
    assert(t.sent == 240 && t.would(T + (k - 1) * CYCLE).get("wouldSend").get("total").asNumber() == 480);
    for (int restart = 0; restart < 5; ++restart) {
      verify::WatchState reboot; assert(reboot.restore(t.muted.snapshot())); reboot.beginSoak(T + k * CYCLE);
      t.muted = std::move(reboot);
      for (const long long end = k + 240; k < end; ++k) t.cycle(T + k * CYCLE, flap);
      t.matches(T + (k - 1) * CYCLE, "(S6) after a restart", false);
    }
    assert(t.sent == 1440 && t.would(T + (k - 1) * CYCLE).get("wouldSend").get("total").asNumber() == 2880);
    const auto steady = [](verify::WatchState& s, long long now) {
      s.protection(accounts(Array{row(now, "1", false), row(now, "2", false)}), now); s.evaluate(now); };
    do { t.cycle(T + k * CYCLE, steady); ++k; } while (t.released && k < 1440 + 1000);
    t.matches(T + (k - 1) * CYCLE, "(S6) drained", false);
    const auto d = t.would(T + (k - 1) * CYCLE);
    assert(t.sent == 1951 && d.get("wouldSend").get("total").asNumber() == 2880 && d.get("saturated").asBool());
    // The model dropped at the bound exactly what the open outbox dropped.
    assert(d.get("wouldDeliver").get("dropped").asNumber() == t.open.snapshot().get("dropped").asNumber() - openDropped0);
  }
  {
    // Round 4: a RE-MUTE of an open verifier starts a new counting window,
    // but it must not discard the modelled sender's queue: the open verifier's
    // real outbox keeps what it had not yet sent, so the model must too, or
    // modelPending() reads false, repeats are re-offered early and the queue
    // under-reads. At S5's load (30 persistent urgent incidents, repeatMs 24
    // cycles): both twins open for 48 cycles, then the first is re-muted and
    // counted from there. Round 3 cleared the queue here: pending 12 against
    // the outbox's 24, and 90 delivered against 102 sent after the drain.
    verify::WatchPolicy p; p.repeatMs = 24 * CYCLE;
    Twin t(p); assert(t.muted.restore(emptyAfterSoak())); t.muted.beginSoak(T);
    assert(t.open.restore(emptyAfterSoak())); t.open.beginSoak(T);
    const auto fleet = [](bool missing) { return [missing](verify::WatchState& s, long long now) {
      Array rows; for (int i = 1; i <= 30; ++i) rows.push_back(row(now, std::to_string(i), missing));
      s.protection(accounts(rows), now); s.evaluate(now); }; };
    long long k = 0;
    for (; k < 48; ++k) t.cycle(T + k * CYCLE, fleet(true));
    assert(t.muted.setMuted(true, T + k * CYCLE).empty());
    t.sent = t.urgent = t.warning = t.info = 0; // the window starts at the re-mute
    for (const long long end = k + 48; k < end; ++k) t.cycle(T + k * CYCLE, fleet(true));
    t.matches(T + (k - 1) * CYCLE, "(re-mute) 48 cycles muted", false);
    assert(t.would(T + (k - 1) * CYCLE).get("wouldDeliver").get("pending").asNumber() == 24);
    const long long muteEnd = k;
    do { t.cycle(T + k * CYCLE, fleet(false)); ++k; } while (t.released && k < muteEnd + 1000);
    t.matches(T + (k - 1) * CYCLE, "(re-mute) recovered and drained", false);
    assert(t.sent == 102 && t.would(T + (k - 1) * CYCLE).get("wouldDeliver").get("total").asNumber() == 102);
  }
  {
    // Mixed severities at the bound: two urgent flappers around a warning one.
    // When the queue is full an urgent offer EVICTS the first warning in id
    // order and a warning offer is refused; release stays urgent first, so the
    // warnings wait for the drain. Severity by severity, the modelled sender
    // matches the open verifier through fill, eviction and drain.
    Twin t; t.muted.beginSoak(T); assert(t.open.restore(emptyAfterSoak())); t.open.beginSoak(T);
    long long k = 0;
    const auto flap = [&k](verify::WatchState& s, long long now) {
      const bool on = k % 2 == 0;
      s.protection(accounts(Array{row(now, "1", on), row(now, "2", false, !on), row(now, "3", on)}), now); s.evaluate(now); };
    const auto openDropped0 = t.open.snapshot().get("dropped").asNumber();
    // The queue fills near cycle 256; from then one warning a cycle is
    // evicted, so stopping at 400 leaves some for the drain to deliver last.
    for (; k < 400; ++k) t.cycle(T + k * CYCLE, flap);
    t.matches(T + (k - 1) * CYCLE, "(mixed) 100 min", false);
    const auto steady = [](verify::WatchState& s, long long now) {
      s.protection(accounts(Array{row(now, "1", false), row(now, "2", false), row(now, "3", false)}), now); s.evaluate(now); };
    do { t.cycle(T + k * CYCLE, steady); ++k; } while (t.released && k < 400 + 1000);
    t.matches(T + (k - 1) * CYCLE, "(mixed) drained", false);
    assert(t.warning > 0 && t.urgent > 0);
    assert(t.would(T + (k - 1) * CYCLE).get("wouldDeliver").get("dropped").asNumber() == t.open.snapshot().get("dropped").asNumber() - openDropped0);
  }
  {
    // Round 3, B1: the modelled sender releases URGENT FIRST, as the run loop
    // does, not simply the oldest. Two warnings open in the first cycle (one
    // is sent, one waits); an urgent opens in the second — younger than the
    // waiting warning, and released before it. Checked cycle by cycle. The
    // urgent's account sorts AFTER the warnings', so neither id order nor
    // arrival order can pick it: only the severity rule does.
    Twin t; t.muted.beginSoak(T); assert(t.open.restore(emptyAfterSoak())); t.open.beginSoak(T);
    t.cycle(T, [](verify::WatchState& s, long long now) {
      s.protection(accounts(Array{row(now, "2", false, false), row(now, "4", false, false)}), now); s.evaluate(now); });
    t.matches(T, "(urgent first) two warnings", false);
    assert(t.sent == 1 && t.warning == 1);
    t.cycle(T + CYCLE, [](verify::WatchState& s, long long now) {
      s.protection(accounts(Array{row(now, "9", true), row(now, "2", false, false), row(now, "4", false, false)}), now); s.evaluate(now); });
    t.matches(T + CYCLE, "(urgent first) a younger urgent", false);
    assert(t.sent == 2 && t.urgent == 1 && t.warning == 1);
    const auto d = t.would(T + CYCLE).get("wouldDeliver");
    assert(d.get("urgent").asNumber() == 1 && d.get("warning").asNumber() == 1 && d.get("pending").asNumber() == 1);
  }
  {
    // Round 3, S-3: a soak started on a clock 5 days ahead, and its 120 urgent
    // would-sends, are not the corrected boot's reading. The new soak starts a
    // new window: counters zero, rate base now, so the rate is a number again.
    auto w = Value(Object{{"schemaVersion", 1}, {"services", Object{}}, {"incidents", Object{}}, {"outbox", Object{}},
      {"delivery", Object{{"muted", true}, {"soakStartedAtMs", T + 5 * DAY}, {"soakEndsAtMs", T + 6 * DAY},
        {"wouldSend", Object{{"urgent", 120}, {"sinceMs", T + 5 * DAY}}}, {"wouldDeliver", Object{{"urgent", 120}}},
        {"model", Object{{"queue", Object{{"held:1", Object{{"incidentId", "held"}, {"severity", "urgent"}, {"createdAtMs", T - 1000}}}}}}}}}});
    verify::WatchState r; assert(r.restore(w)); r.beginSoak(T);
    auto d = r.status(T).get("delivery");
    // The counters reset; the model's queue does not (round 4): it is what the
    // open verifier restoring the same file still holds.
    assert(d.get("wouldDeliver").get("pending").asNumber() == 1);
    assert(d.get("wouldSend").get("urgent").asNumber() == 0 && d.get("wouldDeliver").get("urgent").asNumber() == 0 && d.get("wouldSend").get("sinceMs").asNumber() == T);
    r.protection(missingSl(T, true), T); r.evaluate(T);
    d = r.status(T + 60000).get("delivery");
    assert(d.get("wouldSend").get("urgent").asNumber() == 1 && d.get("wouldSend").get("urgentPerHour").asNumber() == 48); // 1 over 5 cycles
    // A re-mute of an open verifier starts a new window too: an hour open, then muted.
    verify::WatchState o; assert(o.restore(emptyAfterSoak())); o.beginSoak(T);
    o.protection(missingSl(T, true), T); o.evaluate(T); // open: sent, not counted
    assert(o.setMuted(true, T + HOUR).empty());
    d = o.status(T + HOUR).get("delivery");
    assert(d.get("wouldSend").get("total").asNumber() == 0 && d.get("wouldSend").get("sinceMs").asNumber() == T + HOUR);
    o.protection(missingSl(T + HOUR, true), T + HOUR); o.evaluate(T + HOUR); // the hourly repeat, now a would-send
    d = o.status(T + HOUR + 60000).get("delivery");
    assert(d.get("wouldSend").get("urgent").asNumber() == 1 && d.get("wouldSend").get("urgentPerHour").asNumber() == 48); // 1 over 5 cycles
    assert(d.get("wouldDeliver").get("urgent").asNumber() == 1);
    // Muting an already muted verifier keeps its window.
    assert(o.setMuted(true, T + 2 * HOUR).empty() && o.status(T + 2 * HOUR).get("delivery").get("wouldSend").get("urgent").asNumber() == 1);
  }
  {
    // Fix-round nit 2: after the soak an unmute is refused while any held item
    // is older than repeatMs, and the refusal disposes of nothing. A mute
    // always applies.
    const long long after = T + DAY;
    const auto snap = backlog(after - 71 * HOUR);
    verify::WatchState s; assert(s.restore(snap)); s.beginSoak(T);
    assert(s.setMuted(false, after) == "stale_backlog");
    assert(!s.deliveryOpen(after) && s.releasable(after).isNull());
    assert(s.snapshot().get("outbox").asObject().size() == 512);
    const auto d = s.status(after).get("delivery");
    assert(d.get("unmuteRefusal").asString() == "stale_backlog" && d.get("reason").asString() == "muted_after_soak_explicit_unmute_required");
    assert(d.get("staleBacklog").get("count").asNumber() == 512 && d.get("staleBacklog").get("olderThanMs").asNumber() == HOUR);
    assert(d.get("staleBacklog").get("oldestCreatedAtMs").asNumber() == after - 71 * HOUR);
    assert(s.setMuted(true, after).empty());
    // What the refusal prevents. The same state OPEN: the next releasable item
    // is the 71 h old one, and a fresh urgent missing-SL incident is refused
    // at the bound (all 512 are urgent).
    verify::WatchState open; assert(open.restore(afterSoak(snap, false))); open.beginSoak(after);
    open.protection(missingSl(after, true), after);
    assert(open.releasable(after).get("createdAtMs").asNumber() == after - 71 * HOUR);
    assert(!pendingFor(open, "protection:demo.ctraderapi.com:11:missing"));
    // Disposed of (the owner's step, after a /data backup): the unmute applies
    // and the fresh incident is the next message.
    verify::WatchState clean; assert(clean.restore(disposed(s.snapshot()))); clean.beginSoak(after);
    assert(clean.status(after).get("delivery").get("unmuteRefusal").isNull());
    assert(clean.setMuted(false, after).empty());
    clean.protection(missingSl(after, true), after);
    assert(clean.releasable(after).get("incidentId").asString() == "protection:demo.ctraderapi.com:11:missing");
    // An item younger than repeatMs is not a stale backlog.
    verify::WatchState young; assert(young.restore(disposed(s.snapshot()))); young.beginSoak(after);
    young.protection(missingSl(after - HOUR, true), after - HOUR);
    assert(young.setMuted(false, after) == "" && young.deliveryOpen(after));
    verify::WatchState old; assert(old.restore(disposed(s.snapshot()))); old.beginSoak(after);
    old.protection(missingSl(after - HOUR - 1, true), after - HOUR - 1);
    assert(old.setMuted(false, after) == "stale_backlog");
  }
  {
    // Fix-round nit 5: a restored soak dated after this boot's clock is
    // rejected and clamped to begin now, muted, for its full length.
    for (const long long ahead : {1LL, 5 * DAY}) {
      auto w = Value(Object{{"schemaVersion", 1}, {"services", Object{}}, {"incidents", Object{}}, {"outbox", Object{}}});
      w.set("delivery", Value(Object{{"muted", false}, {"soakStartedAtMs", T + ahead}, {"soakEndsAtMs", T + ahead + DAY}}));
      verify::WatchState r; assert(r.restore(w)); r.beginSoak(T);
      const auto d = r.status(T).get("delivery");
      assert(d.get("muted").asBool() && d.get("soakStartedAtMs").asNumber() == T && d.get("soakEndsAtMs").asNumber() == T + DAY);
      assert(d.get("reason").asString() == "soak_active" && d.get("soakRemainingMs").asNumber() == DAY);
      assert(r.setMuted(false, T + DAY - 1) == "soak_active");
    }
    // A start AT the clock is kept, as is one before it.
    auto w = Value(Object{{"schemaVersion", 1}, {"services", Object{}}, {"incidents", Object{}}, {"outbox", Object{}},
      {"delivery", Object{{"muted", true}, {"soakStartedAtMs", T}, {"soakEndsAtMs", T + DAY}}}});
    verify::WatchState r; assert(r.restore(w)); r.beginSoak(T);
    assert(r.status(T).get("delivery").get("soakStartedAtMs").asNumber() == T);
  }
  std::cout << "watchdog failure, work, recovery and restart checks passed\n";
}
