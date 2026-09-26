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
  if (number(s.get("schemaVersion")) != 1 || !s.get("services").isObject()
      || !s.get("incidents").isObject() || !s.get("outbox").isObject()
      || s.get("services").asObject().size() > 5 || s.get("incidents").asObject().size() > 2048
      || s.get("outbox").asObject().size() > 512 || jsn::dump(s).size() > 4 * 1024 * 1024) return false;
  services_ = copy(s.get("services")).asObject();
  // A build before the relay persisted Node's entryDiagnostics with the
  // contract; drop it so the next persist is the stripped shape. Diagnostics
  // restored from disk would be relayed as if current.
  if (auto node = services_.find("node"); node != services_.end() && node->second.get("contract").isObject()) {
    auto contract = node->second.get("contract").asObject(); contract.erase("entryDiagnostics");
    node->second.set("contract", jsn::Value(std::move(contract)));
  }
  incidents_ = copy(s.get("incidents")).asObject();
  outbox_ = copy(s.get("outbox")).asObject();
  dropped_ = number(s.get("dropped"));
  // V3 CV-2: the delivery gate. Schema stays 1; a pre-CV-2 build's restore()
  // ignores this key, so a rollback still restores the file. A state without
  // it (written before CV-2) or with a malformed one restores MUTED with no
  // soak begun, and beginSoak() starts the 24 h soak at this boot. Only an
  // explicit boolean false restores unmuted.
  const auto& d = s.get("delivery");
  muted_ = !(d.isObject() && d.get("muted").isBool() && !d.get("muted").asBool());
  mutedAtMs_ = number(d.get("mutedAtMs")); unmutedAtMs_ = number(d.get("unmutedAtMs"));
  soakStartedAtMs_ = number(d.get("soakStartedAtMs")); soakEndsAtMs_ = number(d.get("soakEndsAtMs"));
  // A soak window that is not exactly this build's length from a real start
  // is not trusted: reset to muted with no soak, and beginSoak() starts one.
  if (soakStartedAtMs_ <= 0 || soakEndsAtMs_ != soakStartedAtMs_ + policy_.soakMs) { soakStartedAtMs_ = soakEndsAtMs_ = 0; muted_ = true; }
  const auto& w = d.get("wouldSend");
  wouldSendUrgent_ = number(w.get("urgent")); wouldSendWarning_ = number(w.get("warning"));
  wouldSendInfo_ = number(w.get("info")); wouldSendSinceMs_ = number(w.get("sinceMs"));
  return true;
}
jsn::Value WatchState::snapshot() const {
  return copy(jsn::Value(jsn::Object{{"schemaVersion", 1}, {"services", services_},
    {"incidents", incidents_}, {"outbox", outbox_}, {"dropped", dropped_},
    {"delivery", jsn::Object{{"muted", muted_}, {"mutedAtMs", mutedAtMs_}, {"unmutedAtMs", unmutedAtMs_},
      {"soakStartedAtMs", soakStartedAtMs_}, {"soakEndsAtMs", soakEndsAtMs_},
      {"wouldSend", jsn::Object{{"urgent", wouldSendUrgent_}, {"warning", wouldSendWarning_},
        {"info", wouldSendInfo_}, {"sinceMs", wouldSendSinceMs_}}}}}}));
}
void WatchState::beginSoak(long long now) {
  if (soakStartedAtMs_ > 0) return; // a restart never restarts the soak
  soakStartedAtMs_ = now; soakEndsAtMs_ = now + policy_.soakMs;
  muted_ = true; mutedAtMs_ = now;
  if (wouldSendSinceMs_ == 0) wouldSendSinceMs_ = now;
}
bool WatchState::deliveryOpen(long long now) const {
  return !muted_ && soakStartedAtMs_ > 0 && now >= soakEndsAtMs_;
}
jsn::Value WatchState::releasable(long long now) const {
  if (!deliveryOpen(now)) return jsn::Value();
  return nextDelivery(now);
}
std::string WatchState::setMuted(bool muted, long long now) {
  if (muted) { if (!muted_) mutedAtMs_ = now; muted_ = true; return ""; }
  if (soakStartedAtMs_ == 0 || now < soakEndsAtMs_) return "soak_active";
  if (muted_) unmutedAtMs_ = now;
  muted_ = false; return "";
}
jsn::Value WatchState::deliveryStatus(long long now) const {
  const bool soakActive = soakStartedAtMs_ == 0 || now < soakEndsAtMs_;
  const auto total = wouldSendUrgent_ + wouldSendWarning_ + wouldSendInfo_;
  const auto since = wouldSendSinceMs_ > 0 && wouldSendSinceMs_ <= now ? now - wouldSendSinceMs_ : 0;
  const auto perHour = [&](long long n) { return since >= 60000 ? jsn::Value(std::round(n * 3600000.0 / since * 100) / 100) : jsn::Value(); };
  return jsn::Value(jsn::Object{{"muted", muted_}, {"open", deliveryOpen(now)},
    {"reason", deliveryOpen(now) ? "open" : soakStartedAtMs_ == 0 ? "soak_not_started" : soakActive ? "soak_active" : "muted_after_soak_explicit_unmute_required"},
    {"mutedAtMs", mutedAtMs_ ? jsn::Value(mutedAtMs_) : jsn::Value()}, {"unmutedAtMs", unmutedAtMs_ ? jsn::Value(unmutedAtMs_) : jsn::Value()},
    {"soakMs", policy_.soakMs}, {"soakStartedAtMs", soakStartedAtMs_ ? jsn::Value(soakStartedAtMs_) : jsn::Value()},
    {"soakEndsAtMs", soakEndsAtMs_ ? jsn::Value(soakEndsAtMs_) : jsn::Value()}, {"soakActive", soakActive},
    {"soakRemainingMs", soakActive && soakEndsAtMs_ > now ? jsn::Value(soakEndsAtMs_ - now) : jsn::Value(0)},
    {"wouldSend", jsn::Object{{"urgent", wouldSendUrgent_}, {"warning", wouldSendWarning_}, {"info", wouldSendInfo_},
      {"total", total}, {"sinceMs", wouldSendSinceMs_ ? jsn::Value(wouldSendSinceMs_) : jsn::Value()},
      {"urgentPerHour", perHour(wouldSendUrgent_)}, {"totalPerHour", perHour(total)}}},
    {"outboxPending", static_cast<long long>(outbox_.size())}});
}
void WatchState::enqueue(const std::string& id, jsn::Value& rec, const std::string& transition, long long now) {
  // Counted before the 512 bound, so the soak's would-send rate is what would
  // have gone out, not what the outbox had room to keep.
  if (!deliveryOpen(now)) {
    const auto& severity = rec.get("severity").asString();
    ++(severity == "urgent" ? wouldSendUrgent_ : severity == "warning" ? wouldSendWarning_ : wouldSendInfo_);
    if (wouldSendSinceMs_ == 0) wouldSendSinceMs_ = now;
  }
  if (outbox_.size() >= 512 && rec.get("severity").asString() == "urgent") {
    auto old = std::find_if(outbox_.begin(), outbox_.end(), [](const auto& kv) { return kv.second.get("severity").asString() != "urgent"; });
    if (old != outbox_.end()) { outbox_.erase(old); ++dropped_; }
  }
  if (outbox_.size() >= 512) { ++dropped_; return; }
  const auto serial = number(rec.get("serial")) + 1;
  rec.set("serial", serial);
  const auto deliveryId = id + ":" + std::to_string(serial);
  outbox_[deliveryId] = jsn::Value(jsn::Object{{"id", deliveryId}, {"incidentId", id},
    {"transition", transition}, {"severity", rec.get("severity")}, {"detail", copy(rec.get("detail"))},
    {"createdAtMs", now}, {"nextAtMs", now}, {"attempts", 0}, {"accepted", false}});
  rec.set("lastQueuedAtMs", now);
}
void WatchState::incident(const std::string& id, bool bad, const std::string& severity,
                          const jsn::Value& evidence, long long now, bool once) {
  auto it = incidents_.find(id);
  if (it == incidents_.end()) {
    if (!bad) return;
    if (incidents_.size() >= 2048) { ++dropped_; return; }
    it = incidents_.emplace(id, jsn::Value(jsn::Object{{"active", false}, {"serial", 0}})).first;
  }
  auto& r = it->second;
  const bool was = r.get("active").asBool();
  const bool deteriorated = was && r.get("severity").asString() != "urgent" && severity == "urgent";
  r.set("detail", copy(evidence)); r.set("severity", severity); r.set("lastObservedAtMs", now);
  if (bad) {
    if (once && number(r.get("serial")) > 0) return;
    r.set("active", true);
    if (!was) r.set("openedAtMs", now);
    bool pending = false;
    for (const auto& [key, item] : outbox_) if (item.get("incidentId").asString() == id) pending = true;
    if (!was || (once && number(r.get("serial")) == 0) || deteriorated || (!once && !pending && now - number(r.get("lastQueuedAtMs")) >= policy_.repeatMs))
      enqueue(id, r, !was ? "opened" : deteriorated ? "escalated" : "still_active", now);
  } else if (was) {
    r.set("active", false); r.set("resolvedAtMs", now);
    if (!once) enqueue(id, r, "recovered", now);
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
      if (m == "OPEN" && quoteLimit > 0) incident(key + ":quote", !fresh(number(w.get("lastQuoteAtMs")), now, quoteLimit), "urgent", d, now);
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
  }
  // Retain resolved history for 30 days, bounded independently of the outbox.
  for (auto it = incidents_.begin(); it != incidents_.end();) {
    if ((!it->second.get("active").asBool() && now - number(it->second.get("resolvedAtMs"), now) > 30LL * 86400000)
        || (it->first.find(":no_orders:") != std::string::npos && now - number(it->second.get("openedAtMs"), now) > 30LL * 86400000)) it = incidents_.erase(it);
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
jsn::Value WatchState::nextDelivery(long long now) const {
  const jsn::Value* best = nullptr;
  for (const auto& [id, item] : outbox_) if (number(item.get("nextAtMs")) <= now && number(item.get("attempts")) < 20
      && (!best || (item.get("severity").asString() == "urgent" && best->get("severity").asString() != "urgent")
          || (item.get("severity").asString() == best->get("severity").asString() && number(item.get("createdAtMs")) < number(best->get("createdAtMs"))))) best = &item;
  return best ? copy(*best) : jsn::Value();
}
void WatchState::delivery(const std::string& id, bool accepted, const std::string& messageId, long long retryAfterMs, long long now) {
  auto it = outbox_.find(id); if (it == outbox_.end()) return;
  auto& item = it->second;
  if (accepted) {
    auto record = incidents_.find(item.get("incidentId").asString());
    if (record != incidents_.end()) { record->second.set("telegramAcceptedAtMs", now); record->second.set("telegramMessageId", messageId); }
    outbox_.erase(it); return;
  }
  const auto attempts = number(item.get("attempts")) + 1;
  item.set("attempts", attempts); item.set("lastError", "telegram_delivery_failed_or_uncertain");
  item.set("nextAtMs", now + std::max(std::clamp(retryAfterMs, 0LL, 86400000LL), std::min(3600000LL, 15000LL * (1LL << std::min(8LL, attempts)))));
}
jsn::Value WatchState::status(long long now) const {
  // Controllers need incident/work receipts, not repeated copies of every
  // persisted calendar and broker position payload on each UI refresh.
  jsn::Object services, incidents, outbox;
  for (const auto& [id, row] : services_) services[id] = jsn::Value(jsn::Object{
    {"attemptedAtMs", row.get("attemptedAtMs")},
    {"reachable", row.get("reachable")}, {"lastReachableAtMs", row.get("lastReachableAtMs")},
    {"lastContractAtMs", row.get("lastContractAtMs")}, {"validContract", row.get("validContract")},
    {"workCount", static_cast<long long>(row.get("contract").get("work").asArray().size())}});
  for (const auto& [id, row] : incidents_) {
    auto data = row.asObject(); jsn::Object summary;
    for (const auto field : {"service", "reason", "role", "accountId", "symbolId", "sessionId", "lastCompletedAtMs", "nextDueMs", "marketStatus", "blocker", "missingSl", "missingTp", "effectiveGraceMs", "knownWorkCount"})
      summary[field] = row.get("detail").get(field);
    data["detail"] = jsn::Value(std::move(summary)); incidents[id] = jsn::Value(std::move(data));
  }
  for (const auto& [id, row] : outbox_) { auto data = row.asObject(); data.erase("detail"); outbox[id] = jsn::Value(std::move(data)); }
  jsn::Value s(jsn::Object{{"schemaVersion", 1}, {"services", std::move(services)}, {"incidents", std::move(incidents)},
    {"outbox", std::move(outbox)}, {"dropped", dropped_}, {"observedAtMs", now}, {"delivery", deliveryStatus(now)}});
  s.set("policy", jsn::Value(jsn::Object{{"probeMs", policy_.probeMs}, {"serviceGraceMs", policy_.serviceGraceMs},
    {"managementGraceMs", policy_.managementGraceMs}, {"scannerGraceMs", policy_.scannerGraceMs}, {"noOrdersMs", policy_.noOrdersMs}, {"repeatMs", policy_.repeatMs}, {"accountGraceMs", policy_.accountGraceMs}}));
  return s;
}
}
