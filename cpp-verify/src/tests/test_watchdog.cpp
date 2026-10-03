#include "../watchdog.hpp"
#include "../watchdog_http.hpp"
#include <cassert>
#include <fstream>
#include <iostream>
#include <sstream>
using jsn::Value; using jsn::Object; using jsn::Array;
namespace {
constexpr long long T = 1800000000000LL;
constexpr long long HOUR = 3600000, DAY = 86400000;
Value parse(const char* s) { return *jsn::parse(s); }
// A deep copy: a jsn::Value copy SHARES its object, so set() on a copy would
// edit the original snapshot too.
Value clone(const Value& v) { return *jsn::parse(jsn::dump(v)); }
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
double serial(const verify::WatchState& s, const std::string& id) { return s.snapshot().get("incidents").get(id).get("serial").asNumber(); }
std::string transition(const verify::WatchState& s, const std::string& id) { return s.snapshot().get("incidents").get(id).get("transition").asString(); }
void healthy(verify::WatchState& s, Array w, long long at) { s.probe("node", true, contract(std::move(w), at), at); s.evaluate(at); }
// One broker-verified account row — `missing` gives its one position no stop
// loss (the urgent :missing incident); `ok` false makes the read unknown (the
// :unknown warning) with no position.
Value row(long long now, const std::string& account, bool missing, bool ok = true) {
  Array positions; if (missing && ok) positions.push_back(Value(Object{{"positionId", "99"}, {"stopLoss", 0}, {"takeProfit", 2}}));
  return Value(Object{{"host", "demo.ctraderapi.com"}, {"accountId", account}, {"ok", ok}, {"source", "broker_reconcile"},
    {"checkedAtMs", now}, {"openCount", static_cast<long long>(positions.size())}, {"positions", positions},
    {"missingSl", static_cast<long long>(positions.size())}, {"missingTp", 0}});
}
Value accounts(Array rows) { return Value(Object{{"accounts", std::move(rows)}}); }
// THE OLD SHAPE, as the build before 03-10-2026 wrote it (taken from the
// seededState helper of the delivery-gate tests that build carried): Node's
// last contract WITH a notificationPolicy, one urgent incident with the
// outbox's per-incident bookkeeping, one outbox item, the dropped count and
// the whole delivery block — mute, soak, counters and the modelled sender's
// queue. restore() must take it and keep none of the channel.
Value oldShape(long long now) {
  const Value policy(Object{{"enabled", true}, {"owner", "cpp-verify"}, {"observedAtMs", now - 5000},
    {"expiresAtMs", now + 3600000}, {"urgentBypass", true}, {"quietIntervals", Array{}}});
  const Value contract(Object{{"schemaVersion", 1}, {"service", "node"}, {"observedAtMs", now - 5000},
    {"workComplete", true}, {"work", Array{}}, {"notificationPolicy", policy}});
  const Value node(Object{{"firstObservedAtMs", now - 5000}, {"attemptedAtMs", now - 5000}, {"reachable", true},
    {"lastReachableAtMs", now - 5000}, {"validContract", true}, {"lastContractAtMs", now - 5000}, {"contract", contract}});
  const Value item(Object{{"id", "fixture:gate:1"}, {"incidentId", "fixture:gate"}, {"transition", "opened"},
    {"severity", "urgent"}, {"detail", Object{{"service", "fixture"}, {"reason", "delivery_gate_test"}}},
    {"createdAtMs", now - 5000}, {"nextAtMs", now - 5000}, {"attempts", 0}, {"accepted", false}});
  Object outbox; outbox["fixture:gate:1"] = item;
  // Production's outbox of 25-09-2026 held 512 of these; a few stand for it.
  for (int i = 0; i < 8; ++i) { const auto id = "cpp-exec:work:quote:" + std::to_string(10000 + i) + ":quote:1"; outbox[id] = clone(item); outbox[id].set("id", id); }
  return Value(Object{{"schemaVersion", 1}, {"services", Object{{"node", node}}},
    {"incidents", Object{{"fixture:gate", Object{{"active", true}, {"serial", 1}, {"severity", "urgent"},
      {"detail", Object{{"service", "fixture"}, {"reason", "delivery_gate_test"}}},
      {"openedAtMs", now - 5000}, {"lastObservedAtMs", now - 5000}, {"lastQueuedAtMs", now - 5000}, {"wouldSendAtMs", now - 5000},
      {"refusedAtMs", now - 4000}, {"modelSerial", 1}, {"modelLastQueuedAtMs", now - 5000},
      {"telegramAcceptedAtMs", now - 4000}, {"telegramMessageId", "123"}}}}},
    {"outbox", outbox}, {"dropped", 1526163},
    {"delivery", Object{{"muted", true}, {"mutedAtMs", now - DAY}, {"unmutedAtMs", 0},
      {"soakStartedAtMs", now - 2 * DAY}, {"soakEndsAtMs", now - DAY},
      {"wouldSend", Object{{"urgent", 3600}, {"warning", 5}, {"info", 1}, {"sinceMs", now - DAY}}},
      {"refused", Object{{"urgent", 88}, {"warning", 0}, {"info", 0}}},
      {"wouldDeliver", Object{{"urgent", 2880}, {"warning", 4}, {"info", 1}}},
      {"model", Object{{"queue", Object{{"fixture:gate:1", Object{{"incidentId", "fixture:gate"}, {"severity", "urgent"}, {"createdAtMs", now - 5000}}}}}, {"dropped", 7}}}}}});
}
}
int main() {
  {
    verify::WatchState s; s.probe("node", false, {}, T); s.evaluate(T + 59999);
    assert(!active(s, "node:unreachable")); s.evaluate(T + 60000); assert(active(s, "node:unreachable"));
    assert(serial(s, "node:unreachable") == 1 && transition(s, "node:unreachable") == "opened");
    verify::WatchState reboot; assert(reboot.restore(s.snapshot())); reboot.probe("node", false, {}, T + 65000); reboot.evaluate(T + 65000);
    assert(serial(reboot, "node:unreachable") == 1); // still open inside repeatMs: no new mark
    healthy(reboot, {}, T + 70000); assert(!active(reboot, "node:unreachable"));
    assert(serial(reboot, "node:unreachable") == 2 && transition(reboot, "node:unreachable") == "recovered");
    healthy(reboot, {}, T + 75000);
    assert(serial(reboot, "node:unreachable") == 2); // one recovery
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
    // C·3: liveness is judged per FEED (account, host) against the role's grace, not per stream against the strategy's gap parameter
    assert(active(s, "node:feed:11:demo.ctraderapi.com:quote")); assert(!active(s, "node:work:one:quote"));
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
    assert(active(s, "cpp-exec:feed:11:demo.ctraderapi.com:quote")); assert(active(s, "cpp-exec:work:reconcile:stalled"));
    assert(!active(s, "cpp-exec:work:quote:calendar")); // original verified calendar survives Node loss
    c.set("observedAtMs", T + 86400001); s.probe("cpp-exec", true, c, T + 86400001); s.evaluate(T + 86400001);
    assert(active(s, "cpp-exec:work:quote:calendar")); assert(active(s, "cpp-exec:feed:11:demo.ctraderapi.com:quote")); // expiry cannot clear it
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
    assert(transition(s, key) == "recovered" && s.snapshot().get("incidents").get(key).get("resolvedAtMs").asNumber() == T + 2000);
    verify::WatchState reboot; assert(reboot.restore(s.snapshot()));
    assert(!active(reboot, key) && serial(reboot, key) == 2);
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
    // Node's contract may still carry a notificationPolicy (the Node side's
    // own shape); the verifier stores the contract and READS NOTHING from the
    // policy — there is no gate for it to feed. Nothing in the status names it.
    verify::WatchState s; auto body = contract();
    body.set("notificationPolicy", Value(Object{{"owner", "cpp-verify"}, {"enabled", true}, {"observedAtMs", T},
      {"expiresAtMs", T + 86400000}, {"urgentBypass", true}, {"quietIntervals", Array{}}}));
    s.probe("node", true, body, T); s.evaluate(T);
    assert(s.snapshot().get("services").get("node").get("validContract").asBool());
    assert(jsn::dump(s.status(T)).find("notificationPolicy") == std::string::npos);
    assert(jsn::dump(s.status(T)).find("masterEnabled") == std::string::npos);
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
    assert(active(s, "node:feed:11:demo.ctraderapi.com:quote")); assert(!active(s, "node:work:ticks:quote"));
    w.set("pending", 1); healthy(s, {w}, T + 125000);
    assert(active(s, "node:work:ticks:deadline_unknown"));
  }
  {
    // C·3 (03-10-2026): the feed-level quote rule. Two scanner streams on one
    // feed: one quiet symbol is not a fault while the other ticks; a stream
    // silent beyond streamQuoteSilenceMs is a warning on that stream; the
    // feed is urgent only when EVERY stream on it is silent beyond the grace.
    verify::WatchState s;
    auto a = work("a", "scanner"), b = work("b", "scanner");
    for (auto* w : {&a, &b}) { w->set("state", "waiting_for_quote"); w->set("pending", 0); w->set("nextDueMs", Value()); w->set("quoteMaxAgeMs", 60000); }
    a.set("lastQuoteAtMs", T); b.set("lastQuoteAtMs", T + 299000);
    healthy(s, {a, b}, T + 300000); // a silent 5 min, b ticked a second ago
    assert(!active(s, "node:feed:11:demo.ctraderapi.com:quote")); // RED if liveness is still per stream
    assert(!active(s, "node:work:a:quote")); // 5 min < streamQuoteSilenceMs (10 min): no warning yet
    b.set("lastQuoteAtMs", T + 600000); healthy(s, {a, b}, T + 601000); // a silent 10 min + 1 s, b fresh
    assert(active(s, "node:work:a:quote")); assert(!active(s, "node:work:b:quote"));
    assert(s.snapshot().get("incidents").get("node:work:a:quote").get("severity").asString() == "warning");
    assert(!active(s, "node:feed:11:demo.ctraderapi.com:quote"));
    // every stream silent 90 s: beyond the strategy's 60 s gap parameter but inside the scanner grace (120 s) — not a feed fault
    a.set("lastQuoteAtMs", T + 611000); b.set("lastQuoteAtMs", T + 611000); healthy(s, {a, b}, T + 701000);
    assert(!active(s, "node:feed:11:demo.ctraderapi.com:quote")); // RED if the feed grace is the gap parameter alone
    // every stream silent beyond the scanner grace (120 s): the feed is urgent, once, per feed
    auto c = work("c", "scanner"); c.set("accountId", "22"); c.set("state", "waiting_for_quote"); c.set("pending", 0); c.set("nextDueMs", Value());
    c.set("quoteMaxAgeMs", 60000); c.set("lastQuoteAtMs", T + 740000);
    healthy(s, {a, b, c}, T + 740000);
    assert(active(s, "node:feed:11:demo.ctraderapi.com:quote"));
    assert(s.snapshot().get("incidents").get("node:feed:11:demo.ctraderapi.com:quote").get("severity").asString() == "urgent");
    assert(s.snapshot().get("incidents").get("node:feed:11:demo.ctraderapi.com:quote").get("detail").get("streams").asNumber() == 2);
    assert(!active(s, "node:feed:22:demo.ctraderapi.com:quote")); // the other feed ticks
    // a feed that leaves the inventory resolves its own incident, like a retired work id
    healthy(s, {c}, T + 741000);
    assert(!active(s, "node:feed:11:demo.ctraderapi.com:quote")); // RED if the retirement pass is removed
    assert(!active(s, "node:work:a:quote"));
    // Codex review of #1198 (P1): a feed whose EVERY row reads CLOSED has no
    // open market to be silent in — its urgent incident resolves. A feed
    // with an UNKNOWN row keeps it (expiry cannot clear a fault).
    a.set("lastQuoteAtMs", T + 800000); b.set("lastQuoteAtMs", T + 800000); healthy(s, {a, b}, T + 940000);
    assert(active(s, "node:feed:11:demo.ctraderapi.com:quote"));
    auto closed = calendar(); closed.set("observedAtMs", T + 940000); closed.set("toMs", T + 2 * DAY); closed.set("expiresAtMs", T + 2 * DAY);
    closed.set("intervals", Array{Value(Object{{"fromMs", T + DAY}, {"toMs", T + 2 * DAY}})});
    auto ac = clone(a), bc = clone(b); ac.set("calendar", closed); bc.set("calendar", closed);
    healthy(s, {ac, bc}, T + 941000);
    assert(!active(s, "node:feed:11:demo.ctraderapi.com:quote")); // RED if a closed feed is kept in the inventory
    assert(!active(s, "node:work:a:calendar"));
    // Codex review of #1198 (P2): the feed evidence reaches GET /watchdog-status, not only the private snapshot
    healthy(s, {a, b}, T + 942000);
    assert(active(s, "node:feed:11:demo.ctraderapi.com:quote"));
    const auto shown = s.status(T + 942000).get("incidents").get("node:feed:11:demo.ctraderapi.com:quote").get("detail");
    assert(shown.get("streams").asNumber() == 2); assert(shown.get("newestQuoteAtMs").asNumber() == T + 800000); // RED if the status projection drops them
    // the silence threshold is policy
    verify::WatchPolicy p; p.streamQuoteSilenceMs = 30000;
    verify::WatchState t(p);
    // the threshold is max(the strategy's own quoteMaxAgeMs, streamQuoteSilenceMs): 60 s here, not the default 10 min
    a.set("lastQuoteAtMs", T); b.set("lastQuoteAtMs", T + 61000); healthy(t, {a, b}, T + 61000);
    assert(active(t, "node:work:a:quote")); assert(!active(t, "node:feed:11:demo.ctraderapi.com:quote"));
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
    // Node sends `blocker` as a string and the record must carry it.
    std::ifstream f("src/tests/fixtures/node-entry-activity.json"); assert(f);
    std::stringstream raw; raw << f.rdbuf(); const auto item = jsn::parse(raw.str()); assert(item && item->get("blocker").isString());
    verify::WatchState s; const long long now = item->get("lastCompletedAtMs").asNumber();
    healthy(s, {*item}, now);
    const auto id = "node:no_orders:11:" + item->get("sessionId").asString();
    assert(active(s, id)); assert(serial(s, id) == 1);
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
    // Transitions are the record's own serial: opened, escalated (warning to
    // urgent), one still_active mark per repeatMs while it stands, recovered.
    // A flap inside one repeat interval marks every transition. Nothing is
    // queued or sent for any of them.
    verify::WatchState s;
    s.protection(accounts({row(T, "11", false, false)}), T); s.evaluate(T);
    const auto unknown = "protection:demo.ctraderapi.com:11:unknown";
    assert(active(s, unknown) && serial(s, unknown) == 1 && transition(s, unknown) == "opened");
    s.protection(accounts({row(T + 15000, "11", false, false)}), T + 15000); s.evaluate(T + 15000);
    assert(serial(s, unknown) == 1); // inside repeatMs: no mark
    s.protection(accounts({row(T + HOUR, "11", false, false)}), T + HOUR); s.evaluate(T + HOUR);
    assert(serial(s, unknown) == 2 && transition(s, unknown) == "still_active");
    s.protection(accounts({row(T + HOUR + 15000, "11", true)}), T + HOUR + 15000); s.evaluate(T + HOUR + 15000);
    assert(!active(s, unknown) && serial(s, unknown) == 3 && transition(s, unknown) == "recovered");
    const auto missing = "protection:demo.ctraderapi.com:11:missing";
    assert(active(s, missing) && serial(s, missing) == 1);
    // Flap: recovered and reopened in consecutive cycles, each marked.
    s.protection(accounts({row(T + HOUR + 30000, "11", false)}), T + HOUR + 30000); s.evaluate(T + HOUR + 30000);
    s.protection(accounts({row(T + HOUR + 45000, "11", true)}), T + HOUR + 45000); s.evaluate(T + HOUR + 45000);
    assert(active(s, missing) && serial(s, missing) == 3 && transition(s, missing) == "opened");
    assert(jsn::dump(s.snapshot()).find("outbox") == std::string::npos);
    assert(jsn::dump(s.snapshot()).find("telegram") == std::string::npos);
  }
  {
    // The status shape: `delivery` names the REMOVED channel — distinct from
    // a verifier before CV-2 (no delivery block) and from the CV-2 builds
    // (muted, soak, counters) — and nothing of the channel is left in it.
    verify::WatchState s; s.probe("node", false, {}, T); s.evaluate(T + 60000);
    const auto st = s.status(T + 60000);
    const auto& d = st.get("delivery");
    assert(d.get("channel").asString() == "none");
    assert(d.get("removedOn").asString() == "2026-10-03");
    assert(d.get("note").asString() == "incidents are a record; nothing is sent");
    assert(d.get("muted").isNull() && d.get("open").isNull() && d.get("wouldSend").isNull());
    assert(st.get("outbox").isNull());
    assert(st.get("dropped").asNumber() == 0);
    assert(st.get("incidents").get("node:unreachable").get("active").asBool());
    const auto text = jsn::dump(st);
    for (const auto key : {"soakActive", "unmuteRefusal", "staleBacklog", "wouldDeliver", "muteNotDurable", "outboxPending", "sendCeilingPerHour"})
      assert(text.find(key) == std::string::npos);
  }
  {
    // THE OLD SHAPE restores (the state file on the production volume at the
    // time of the removal): the channel's keys are ignored, the incident's
    // delivery bookkeeping is dropped, and the next snapshot carries services
    // and incidents only — which is what disposes of the held backlog.
    const auto old = oldShape(T);
    assert(old.get("outbox").asObject().size() == 9 && old.get("delivery").get("muted").asBool());
    verify::WatchState s; assert(s.restore(old));
    const auto snap = s.snapshot();
    assert(snap.get("outbox").isNull());   // RED if restore() keeps the outbox
    assert(snap.get("delivery").isNull()); // RED if restore() keeps the delivery block
    assert(snap.get("dropped").isNull());
    assert(snap.get("services").get("node").get("validContract").asBool());
    const auto& inc = snap.get("incidents").get("fixture:gate");
    assert(inc.get("active").asBool() && inc.get("serial").asNumber() == 1 && inc.get("openedAtMs").asNumber() == T - 5000);
    assert(inc.get("detail").get("reason").asString() == "delivery_gate_test");
    for (const auto key : {"lastQueuedAtMs", "wouldSendAtMs", "refusedAtMs", "modelSerial", "modelLastQueuedAtMs", "telegramAcceptedAtMs", "telegramMessageId"})
      assert(inc.get(key).isNull());
    const auto text = jsn::dump(snap);
    assert(text.find("outbox") == std::string::npos && text.find("wouldSend") == std::string::npos && text.find("telegram") == std::string::npos);
    // The restored incident keeps running on this build's semantics.
    s.evaluate(T); assert(active(s, "fixture:gate")); // no probe of "fixture" — evaluate touches only probed services; the record stays
    // The NEW shape restores too, and round-trips.
    verify::WatchState again; assert(again.restore(snap)); assert(jsn::dump(again.snapshot()) == text);
    // What is still refused: a wrong schema, a missing object, too many services.
    assert(!s.restore(Value(Object{{"schemaVersion", 2}, {"services", Object{}}, {"incidents", Object{}}})));
    assert(!s.restore(Value(Object{{"schemaVersion", 1}, {"services", Object{}}})));
    // An old file is NOT refused for its outbox being over any bound: the key is not read.
    auto big = clone(old); Object huge; for (int i = 0; i < 600; ++i) huge["k" + std::to_string(i)] = Value(Object{{"id", "k"}});
    big.set("outbox", Value(huge)); assert(s.restore(big));
  }
  {
    // The 2,048 incident bound: the 2,049th is refused and counted in
    // `dropped` (incidents over the cap are all it counts now).
    verify::WatchState s; Array rows;
    for (int i = 0; i < 2100; ++i) rows.push_back(row(T, std::to_string(100000 + i), false, false));
    s.protection(accounts(rows), T);
    assert(s.snapshot().get("incidents").asObject().size() == 2048);
    assert(s.status(T).get("dropped").asNumber() == 52);
  }
  std::cout << "watchdog incident record passed\n";
  return 0;
}
