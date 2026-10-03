#include "watchdog.hpp"
#include <algorithm>
#include <cmath>
#include <set>

namespace verify {
namespace {
long long number(const jsn::Value& v, long long fallback = 0) {
  const double d = v.asNumber(-1);
  return std::isfinite(d) && d >= 0 && d <= 9007199254740991.0 && std::floor(d) == d ? static_cast<long long>(d) : fallback;
}
jsn::Value copy(const jsn::Value& v) { return jsn::parse(jsn::dump(v)).value_or(jsn::Value()); }
bool fresh(long long at, long long now, long long age) { return at > 0 && at <= now && now - at < age; }
jsn::Value detail(const std::string& service, const std::string& reason) {
  return jsn::Value(jsn::Object{{"service", service}, {"reason", reason}});
}
// Calendar windows are compiled by the shared IANA calendar implementation.
// No fallback hours, name-only identity, crypto exception, or news calendar.
std::string market(const jsn::Value& work, long long now) {
  const auto& c = work.get("calendar");
  const auto positiveId = [](const jsn::Value& v) { const auto& s = v.asString(); return !s.empty() && s.size() <= 19 && s.front() != '0' && std::all_of(s.begin(), s.end(), [](char c) { return c >= '0' && c <= '9'; }); };
  if (!c.isObject() || !positiveId(work.get("accountId")) || !positiveId(work.get("symbolId"))
      || (work.get("host").asString() != "demo.ctraderapi.com" && work.get("host").asString() != "live.ctraderapi.com")
      || c.get("identity").get("provider").asString() != "ctrader"
      || c.get("identity").get("accountId").asString() != work.get("accountId").asString()
      || c.get("identity").get("host").asString() != work.get("host").asString()
      || c.get("identity").get("symbolId").asString() != work.get("symbolId").asString()
      || c.get("source").asString() != "ctrader:ProtoOASymbol" || c.get("version").asString().empty()
      || !fresh(number(c.get("observedAtMs")), now, 86400000)
      || number(c.get("fromMs")) > now || number(c.get("toMs")) <= now
      || number(c.get("expiresAtMs")) <= now || !c.get("intervals").isArray()
      || c.get("intervals").asArray().size() > 256) return "UNKNOWN";
  long long previous = number(c.get("fromMs"));
  bool open = false;
  for (const auto& iv : c.get("intervals").asArray()) {
    const auto a = number(iv.get("fromMs")), b = number(iv.get("toMs"));
    if (a < previous || b <= a || b > number(c.get("toMs"))) return "UNKNOWN";
    previous = b;
    if (a <= now && now < b) open = true;
  }
  return open ? "OPEN" : "CLOSED";
}
}

bool WatchState::restore(const jsn::Value& s) {
  // The shape written by the build before the channel was removed carried
  // `outbox`, `dropped` and `delivery` (mute, soak, counters, the modelled
  // sender's queue) beside these two. They are ignored here, never required:
  // the next snapshot() carries services and incidents only, which is what
  // retires the held backlog on the volume.
  if (number(s.get("schemaVersion")) != 1 || !s.get("services").isObject()
      || !s.get("incidents").isObject()
      || s.get("services").asObject().size() > 5 || s.get("incidents").asObject().size() > 2048
      || jsn::dump(s).size() > 4 * 1024 * 1024) return false;
  services_ = copy(s.get("services")).asObject();
  // A build before the relay persisted Node's entryDiagnostics with the
  // contract; drop it so the next persist is the stripped shape. Diagnostics
  // restored from disk would be relayed as if current.
  if (auto node = services_.find("node"); node != services_.end() && node->second.get("contract").isObject()) {
    auto contract = node->second.get("contract").asObject(); contract.erase("entryDiagnostics");
    node->second.set("contract", jsn::Value(std::move(contract)));
  }
  incidents_.clear();
  for (const auto& [id, record] : s.get("incidents").asObject()) {
    // The per-incident delivery bookkeeping of the old shape (the outbox
    // queue clock, the modelled sender's serial, Telegram receipts) is
    // dropped with the channel; the incident's own history stays.
    auto r = copy(record).asObject();
    for (const auto key : {"lastQueuedAtMs", "wouldSendAtMs", "refusedAtMs", "modelSerial", "modelLastQueuedAtMs", "telegramAcceptedAtMs", "telegramMessageId"}) r.erase(key);
    incidents_[id] = jsn::Value(std::move(r));
  }
  dropped_ = 0;
  return true;
}
jsn::Value WatchState::snapshot() const {
  return copy(jsn::Value(jsn::Object{{"schemaVersion", 1}, {"services", services_}, {"incidents", incidents_}}));
}
void WatchState::incident(const std::string& id, bool bad, const std::string& severity,
                          const jsn::Value& evidence, long long now, bool once) {
  auto it = incidents_.find(id);
  if (it == incidents_.end()) {
    if (!bad) return;
    if (incidents_.size() >= kIncidentCap) {
      // Full: a RESOLVED incident is history, an unrecorded new one is lost
      // evidence. Evict the oldest resolved record to make room; only when
      // every stored incident is still active is the new one refused.
      auto oldest = incidents_.end();
      for (auto at = incidents_.begin(); at != incidents_.end(); ++at) {
        if (at->second.get("active").asBool()) continue;
        if (oldest == incidents_.end() || number(at->second.get("resolvedAtMs")) < number(oldest->second.get("resolvedAtMs"))) oldest = at;
      }
      if (oldest == incidents_.end()) { ++dropped_; return; }
      incidents_.erase(oldest);
    }
    it = incidents_.emplace(id, jsn::Value(jsn::Object{{"active", false}, {"serial", 0}})).first;
  }
  auto& r = it->second;
  const bool was = r.get("active").asBool();
  const bool deteriorated = was && r.get("severity").asString() != "urgent" && severity == "urgent";
  r.set("detail", copy(evidence)); r.set("severity", severity); r.set("lastObservedAtMs", now);
  // `serial` counts the incident's transitions — opened, escalated,
  // recovered, and one still_active mark per repeatMs while it stands; a
  // once-notice (no_orders) is marked once per id. It is a record of what
  // the verifier saw, not a message count: nothing is sent.
  const auto mark = [&](const char* transition) {
    r.set("serial", number(r.get("serial")) + 1); r.set("transition", transition); r.set("transitionAtMs", now);
  };
  if (bad) {
    if (once && number(r.get("serial")) > 0) return;
    r.set("active", true);
    if (!was) r.set("openedAtMs", now);
    if (!was) mark("opened");
    else if (deteriorated) mark("escalated");
    else if (!once && now - number(r.get("transitionAtMs")) >= policy_.repeatMs) mark("still_active");
  } else if (was) {
    r.set("active", false); r.set("resolvedAtMs", now);
    if (!once) mark("recovered");
  }
}
void WatchState::probe(const std::string& service, bool reachable, const jsn::Value& contract, long long now) {
  static const std::set<std::string> allowed{"node", "cpp-exec", "cpp-acct", "cpp-scan-tick", "cpp-scan-timeframe"};
  if (!allowed.contains(service)) return;
  auto& s = services_[service];
  if (!s.isObject()) s = jsn::Value(jsn::Object{{"firstObservedAtMs", now}});
  s.set("attemptedAtMs", now); s.set("reachable", reachable);
  if (reachable) { s.set("lastReachableAtMs", now); s.set("unreachableSinceMs", jsn::Value()); }
  else if (!number(s.get("unreachableSinceMs"))) s.set("unreachableSinceMs", now);
  bool valid = reachable && number(contract.get("schemaVersion")) == 1
    && contract.get("service").asString() == service && fresh(number(contract.get("observedAtMs")), now, policy_.serviceGraceMs)
    && contract.get("workComplete").asBool() && contract.get("work").isArray() && contract.get("work").asArray().size() <= 2048
    && jsn::dump(contract).size() <= 256 * 1024;
  std::set<std::string> ids;
  for (const auto& w : contract.get("work").asArray()) {
    const auto id = w.get("id").asString();
    if (id.empty() || id.size() > 256 || !ids.insert(id).second) valid = false;
  }
  if (valid) {
    // Complete new inventory can retire a position/work item. A failed probe
    // or incomplete response cannot erase an outstanding incident.
    for (const auto& old : s.get("contract").get("work").asArray()) if (!ids.contains(old.get("id").asString())) {
      const auto prefix = service + ":work:" + old.get("id").asString() + ":";
      std::vector<std::string> resolved;
      for (const auto& [key, value] : incidents_) if (key.starts_with(prefix) && value.get("active").asBool()) resolved.push_back(key);
      for (const auto& key : resolved) incident(key, false, "info", detail(service, "work_no_longer_in_complete_inventory"), now);
    }
    auto stored = copy(contract);
    if (service == "node") {
      // Persist-strip: the relay keeps Node's entryDiagnostics in memory; the
      // durable state (fsynced every probe) keeps only what supervision needs.
      nodeEntryDiagnostics_ = copy(contract.get("entryDiagnostics")); nodeEntryDiagnosticsAtMs_ = now;
      auto fields = stored.asObject(); fields.erase("entryDiagnostics"); stored = jsn::Value(std::move(fields));
    }
    s.set("contract", stored); s.set("lastContractAtMs", now);
  }
  s.set("validContract", valid);
}
void WatchState::evaluate(long long now) {
  for (auto& [service, s] : services_) {
    const auto failure = number(s.get("unreachableSinceMs"));
    const bool lost = failure > 0 && now - failure >= policy_.serviceGraceMs;
    auto unavailable = detail(service, "process_unreachable");
    unavailable.set("knownWorkCount", static_cast<long long>(s.get("contract").get("work").asArray().size()));
    incident(service + ":unreachable", lost, "urgent", unavailable, now);
    const auto last = number(s.get("lastContractAtMs")), first = number(s.get("firstObservedAtMs"));
    if (!lost) incident(service + ":work_evidence", !fresh(last, now, policy_.serviceGraceMs) && now - first >= policy_.serviceGraceMs,
      "urgent", detail(service, "completed_work_contract_unavailable_or_stale"), now);
    // Retained deadlines/calendars continue through Node loss, without stamping
    // retained work fresh. Only an actual new receipt advances lastCompleted.
    const auto& contract = s.get("contract");
    struct Feed { long long newest = 0, grace = 0, streams = 0; jsn::Value detail; };
    std::map<std::string, Feed> feeds;
    // Every feed with a quote-bearing row, and how many of its rows read
    // CLOSED. An UNKNOWN calendar cannot clear a prior fault, so a feed with
    // an UNKNOWN or OPEN row stays in the inventory; a feed whose EVERY row
    // reads CLOSED has no open market to be silent in, and its incident
    // resolves (Codex review of #1198, P1).
    std::set<std::string> feedsInInventory;
    std::map<std::string, std::pair<long long, long long>> feedRows; // feed -> {rows, closed rows}
    for (const auto& raw : contract.get("work").asArray()) {
      auto w = copy(raw);
      // The actual owner supplies progress; Node supplies only the shared
      // broker calendar. Keep its original observation/expiry through Node
      // loss. A fresh probe never refreshes calendar evidence.
      const auto node = services_.find("node");
      if (node != services_.end()) for (const auto& c : node->second.get("contract").get("calendars").asArray()) {
        const auto& identity = c.get("identity");
        if (identity.get("accountId").asString() == w.get("accountId").asString()
            && identity.get("host").asString() == w.get("host").asString()
            && identity.get("symbolId").asString() == w.get("symbolId").asString()) { w.set("calendar", c.get("calendar")); break; }
      }
      const std::string id = w.get("id").asString(), role = w.get("role").asString();
      if (id.empty() || id.size() > 256) continue;
      const auto key = service + ":work:" + id;
      auto d = copy(w); d.set("service", service);
      const auto feedKeyOf = service + ":feed:" + w.get("accountId").asString() + ":" + w.get("host").asString();
      if (number(w.get("quoteMaxAgeMs")) > 0) { feedsInInventory.insert(feedKeyOf); ++feedRows[feedKeyOf].first; }
      // A lost owner produces one service incident. Keep existing work faults
      // open, but do not generate a new incident for every cached position on
      // each failed probe. Independent broker protection findings still run.
      if (lost && role != "intent") continue;
      const auto completed = number(w.get("lastCompletedAtMs"));
      incident(key + ":clock", completed > now, "warning", d, now);
      if (completed > now) continue;
      // Calendar-free liveness: a gateway's reconcile, and Node's scanner
      // observation collector (it polls around the clock, and it is the
      // liveness signal for the timeframe mirror, whose idle cells carry no
      // deadline). A stalled collector loses observations, not protection,
      // so its stall is a warning.
      if (role == "gateway" || role == "collector") {
        const auto due = number(w.get("nextDueMs"));
        incident(key + ":deadline_unknown", due == 0, "warning", d, now);
        if (due > 0) incident(key + ":stalled", now >= due + policy_.serviceGraceMs, role == "gateway" ? "urgent" : "warning", d, now);
        continue;
      }
      if (role == "intent") {
        const auto state = w.get("state").asString();
        const bool terminal = state == "ACCEPTED" || state == "FILLED" || state == "REJECTED" || state == "RELEASED" || state == "EXPIRED";
        const auto deadline = number(w.get("deadlineMs"));
        incident(key + ":intent_deadline_unknown", !terminal && deadline == 0, "warning", d, now);
        if (terminal || deadline > 0) incident(key + ":intent", !terminal && now >= deadline, "urgent", d, now);
        continue;
      }
      const auto m = market(w, now);
      d.set("marketStatus", m);
      if (m == "CLOSED" && number(w.get("quoteMaxAgeMs")) > 0) ++feedRows[feedKeyOf].second;
      incident(key + ":calendar", m == "UNKNOWN", "warning", d, now);
      if (m == "UNKNOWN") continue; // cannot clear a prior fault on unknown hours
      const auto due = number(w.get(m == "CLOSED" ? "closedAuditDueMs" : "nextDueMs"));
      if (role == "management" || role == "scanner") {
        // A quote-driven scanner has no computation due while its queue is
        // empty. This receipt does not attest to feed freshness: the separate
        // quote-age check below still applies during the open market.
        const bool waitingForQuote = role == "scanner" && w.get("state").asString() == "waiting_for_quote"
          && w.get("pending").isNumber() && w.get("pending").asNumber() == 0;
        incident(key + ":deadline_unknown", due == 0 && !waitingForQuote && (m == "OPEN" || role == "management"), "warning", d, now);
        const auto defaultGrace = role == "management" ? policy_.managementGraceMs : policy_.scannerGraceMs;
        const auto grace = number(policy_.accountGraceMs.get(w.get("accountId").asString()).get(role), defaultGrace);
        d.set("effectiveGraceMs", grace);
        if (due > 0) incident(key + ":stalled", now >= due + grace, "urgent", d, now);
        else if ((m == "CLOSED" && role == "scanner") || waitingForQuote) incident(key + ":stalled", false, "urgent", d, now);
      }
      const auto quoteLimit = number(w.get("quoteMaxAgeMs"));
      if (m == "OPEN" && quoteLimit > 0) {
        // C·3 (03-10-2026): liveness is a FEED question. A quiet symbol goes
        // a minute without a tick in an open market as a matter of course;
        // judged per stream against the strategy's own gap parameter this
        // raised 244 urgent incidents in a week, 90 open at once. So: the
        // feed (service, account, host) is urgent when NO stream on it has
        // ticked within the role's grace; one stream silent beyond
        // streamQuoteSilenceMs is a warning on that stream.
        const auto lastQuote = number(w.get("lastQuoteAtMs"));
        auto& feed = feeds[service + ":feed:" + w.get("accountId").asString() + ":" + w.get("host").asString()];
        feed.newest = std::max(feed.newest, lastQuote <= now ? lastQuote : 0LL);
        feed.grace = std::max({feed.grace, quoteLimit, role == "scanner" ? policy_.scannerGraceMs : policy_.serviceGraceMs});
        ++feed.streams; feed.detail = detail(service, "feed_silent"); feed.detail.set("accountId", w.get("accountId")); feed.detail.set("host", w.get("host")); feed.detail.set("role", role);
        incident(key + ":quote", !fresh(lastQuote, now, std::max(quoteLimit, policy_.streamQuoteSilenceMs)), "warning", d, now);
      }
      const auto opened = number(w.get("sessionOpenedAtMs"));
      const auto session = w.get("sessionId").asString();
      if (role == "entry_activity" && w.get("activityComplete").asBool() && completed >= opened
          && number(w.get("nextDueMs")) + policy_.scannerGraceMs > now
          && m == "OPEN" && opened > 0 && opened <= now && !session.empty()
          && now - opened >= policy_.noOrdersMs && w.get("ordersSinceOpen").isNumber() && w.get("ordersSinceOpen").asNumber() == 0)
        incident(service + ":no_orders:" + w.get("accountId").asString() + ":" + session, true, "info", d, now, true);
      if (role == "entry_activity" && w.get("activityComplete").asBool() && w.get("hasRecordedOrder").asBool() && !session.empty())
        incident(service + ":no_orders:" + w.get("accountId").asString() + ":" + session, false, "info", d, now, true);
    }
    // C·3: one urgent incident per feed with every stream silent beyond its
    // grace; a feed that left the inventory (or has no open-market stream)
    // resolves its own incident, the way a retired work id does.
    const auto feedPrefix = service + ":feed:";
    for (auto& [feedKey, feed] : feeds) {
      feed.detail.set("streams", feed.streams); feed.detail.set("newestQuoteAtMs", feed.newest ? jsn::Value(feed.newest) : jsn::Value()); feed.detail.set("effectiveGraceMs", feed.grace);
      incident(feedKey + ":quote", !fresh(feed.newest, now, feed.grace), "urgent", feed.detail, now);
    }
    for (const auto& [feedKey, rows] : feedRows) if (rows.first > 0 && rows.second == rows.first) feedsInInventory.erase(feedKey);
    if (!lost) {
      std::vector<std::string> gone;
      for (const auto& [key, value] : incidents_) if (key.starts_with(feedPrefix) && value.get("active").asBool() && !feedsInInventory.contains(key.substr(0, key.size() - 6))) gone.push_back(key);
      for (const auto& key : gone) incident(key, false, "info", detail(service, "feed_no_longer_in_complete_inventory"), now);
    }
  }
  // Retain resolved history for 30 days. A no_orders notice is one fact about
  // one trading session ("this session had placed nothing by hour N"); it has
  // no recovery transition, so it never resolved and 328 of them sat "active"
  // and filled the 2,048 bound. It is closed (no transition, no mark) once the
  // session is a day old, and its record kept 7 days, not 30.
  for (auto it = incidents_.begin(); it != incidents_.end();) {
    const bool noOrders = it->first.find(":no_orders:") != std::string::npos;
    if (noOrders && it->second.get("active").asBool() && now - number(it->second.get("openedAtMs"), now) > 86400000) {
      it->second.set("active", false); it->second.set("resolvedAtMs", now);
    }
    if ((!it->second.get("active").asBool() && now - number(it->second.get("resolvedAtMs"), now) > (noOrders ? 7LL : 30LL) * 86400000)) it = incidents_.erase(it);
    else ++it;
  }
}
void WatchState::protection(const jsn::Value& report, long long now) {
  std::set<std::string> observed;
  for (const auto& a : report.get("accounts").asArray()) {
    const auto key = "protection:" + a.get("host").asString() + ":" + a.get("accountId").asString();
    observed.insert(key);
    auto d = copy(a); d.set("service", "cpp-verify");
    const auto& positions = a.get("positions").asArray();
    const auto missingSl = std::count_if(positions.begin(), positions.end(), [](const auto& p) { return p.get("stopLoss").asNumber() <= 0; });
    const auto missingTp = std::count_if(positions.begin(), positions.end(), [](const auto& p) { return p.get("takeProfit").asNumber() <= 0; });
    const bool known = a.get("ok").asBool() && a.get("source").asString() == "broker_reconcile"
      && fresh(number(a.get("checkedAtMs")), now, 120000) && a.get("positions").isArray()
      && number(a.get("openCount"), -1) == static_cast<long long>(positions.size())
      && number(a.get("missingSl"), -1) == missingSl && number(a.get("missingTp"), -1) == missingTp;
    incident(key + ":unknown", !known, "warning", d, now);
    if (!known) continue;
    const bool missing = missingSl > 0 || missingTp > 0;
    incident(key + ":missing", missing, "urgent", d, now);
  }
  // A configured account that has never completed its first broker read is
  // unknown, not an empty protected account. Keep any prior missing-target
  // incident active when its account row disappears.
  for (const auto& session : report.get("sessions").asArray()) {
    for (const auto& account : session.get("accounts").asArray()) {
      const auto key = "protection:" + session.get("host").asString() + ":" + account.asString();
      if (observed.contains(key)) continue;
      auto d = detail("cpp-verify", "configured_account_read_unavailable");
      d.set("host", session.get("host")); d.set("accountId", account);
      incident(key + ":unknown", true, "warning", d, now);
    }
  }
}
jsn::Value WatchState::status(long long now, bool allIncidents) const {
  // Controllers need incident/work receipts, not repeated copies of every
  // persisted calendar and broker position payload on each UI refresh.
  jsn::Object services, incidents;
  for (const auto& [id, row] : services_) services[id] = jsn::Value(jsn::Object{
    {"attemptedAtMs", row.get("attemptedAtMs")},
    {"reachable", row.get("reachable")}, {"lastReachableAtMs", row.get("lastReachableAtMs")},
    {"lastContractAtMs", row.get("lastContractAtMs")}, {"validContract", row.get("validContract")},
    {"workCount", static_cast<long long>(row.get("contract").get("work").asArray().size())}});
  long long active = 0;
  for (const auto& [id, row] : incidents_) {
    if (row.get("active").asBool()) ++active;
    else if (!allIncidents) continue;
    auto data = row.asObject(); jsn::Object summary;
    for (const auto field : {"service", "reason", "role", "accountId", "symbolId", "sessionId", "lastCompletedAtMs", "nextDueMs", "marketStatus", "blocker", "missingSl", "missingTp", "effectiveGraceMs", "knownWorkCount", "streams", "newestQuoteAtMs"})
      summary[field] = row.get("detail").get(field);
    data["detail"] = jsn::Value(std::move(summary)); incidents[id] = jsn::Value(std::move(data));
  }
  // `delivery` names the REMOVED channel, so a reader can tell this build
  // from a verifier before CV-2 (which reported no delivery block at all)
  // and from the CV-2 builds (muted, soak, counters): nothing is sent.
  jsn::Value s(jsn::Object{{"schemaVersion", 1}, {"services", std::move(services)}, {"incidents", std::move(incidents)},
    {"dropped", dropped_}, {"observedAtMs", now},
    {"incidentsTotal", static_cast<long long>(incidents_.size())}, {"incidentsActive", active},
    {"incidentsCap", static_cast<long long>(kIncidentCap)}, {"incidentsListed", allIncidents ? std::string("all") : std::string("active")},
    {"delivery", jsn::Object{{"channel", "none"}, {"removedOn", "2026-10-03"}, {"note", "incidents are a record; nothing is sent"}}}});
  s.set("policy", jsn::Value(jsn::Object{{"probeMs", policy_.probeMs}, {"serviceGraceMs", policy_.serviceGraceMs},
    {"managementGraceMs", policy_.managementGraceMs}, {"scannerGraceMs", policy_.scannerGraceMs}, {"noOrdersMs", policy_.noOrdersMs}, {"repeatMs", policy_.repeatMs}, {"accountGraceMs", policy_.accountGraceMs}}));
  return s;
}
}
