#include "entry_diagnostics.hpp"
#include <algorithm>

namespace verify {
namespace {
using jsn::Value; using jsn::Object; using jsn::Array;
constexpr size_t kAccounts = 64, kText = 200, kReasons = 24, kBases = 8;
constexpr long long kProtectionAgeMs = 180000;
// The four evidence checks Node relays by name; every other failing check is
// in blockedReasons. Unknown keys are never copied.
const char* const kChecks[] = {"profile_pinned", "profile_matches_sidecar", "replay_evidence", "validation_stage"};

long long number(const Value& v) {
  const double d = v.asNumber(-1);
  return std::isfinite(d) && d >= 0 && d <= 9007199254740991.0 && std::floor(d) == d ? static_cast<long long>(d) : 0;
}
bool fresh(long long at, long long now, long long age) { return at > 0 && at <= now && now - at < age; }
// At most n bytes, cut on a UTF-8 character boundary.
std::string clip(const std::string& s, size_t n) {
  if (s.size() <= n) return s;
  size_t end = n;
  while (end > 0 && (static_cast<unsigned char>(s[end]) & 0xC0) == 0x80) --end;
  return s.substr(0, end);
}
Value text(const Value& v, size_t n = kText) { return v.isString() ? Value(clip(v.asString(), n)) : Value(); }
Value count(const Value& v) {
  const double d = v.asNumber(-1);
  return v.isNumber() && std::isfinite(d) && d >= 0 && d <= 9007199254740991.0 && std::floor(d) == d ? Value(d) : Value();
}
Value strings(const Value& v, size_t max, size_t n) {
  if (!v.isArray()) return Value();
  Array out;
  for (const auto& s : v.asArray()) { if (out.size() >= max) break; if (s.isString()) out.push_back(Value(clip(s.asString(), n))); }
  return Value(std::move(out));
}
bool accountId(const std::string& s) {
  return !s.empty() && s.size() <= 19 && s.front() != '0' && std::all_of(s.begin(), s.end(), [](char c) { return c >= '0' && c <= '9'; });
}
// cpp-verify's own broker read for the account: the only broker-verified
// value in the relay. Absent, failed, stale or ambiguous is said so.
Value independent(const std::string& id, const std::string& environment, const Value& protection, long long now) {
  const Value* match = nullptr; int matches = 0;
  for (const auto& row : protection.get("accounts").asArray()) {
    if (row.get("accountId").asString() != id) continue;
    const auto& host = row.get("host").asString();
    if ((environment == "demo" && host != "demo.ctraderapi.com") || (environment == "live" && host != "live.ctraderapi.com")) continue;
    match = &row; ++matches;
  }
  const auto unavailable = [](const char* reason) {
    return Value(Object{{"available", false}, {"source", "cpp-verify broker_reconcile"}, {"reason", reason}});
  };
  if (matches == 0) return unavailable("no_broker_reconcile_for_account");
  if (matches > 1) return unavailable("account_on_more_than_one_host");
  const auto& r = *match;
  if (!r.get("ok").asBool() || r.get("source").asString() != "broker_reconcile" || count(r.get("openCount")).isNull())
    return unavailable("broker_reconcile_not_ok");
  const auto checked = number(r.get("checkedAtMs"));
  if (!fresh(checked, now, kProtectionAgeMs)) return unavailable("broker_reconcile_stale");
  return Value(Object{{"available", true}, {"source", "cpp-verify broker_reconcile"}, {"openCount", count(r.get("openCount"))}, {"checkedAtMs", checked}});
}
Value account(const Value& a, const Value& protection, long long now) {
  const auto id = a.get("accountId").asString(), environment = a.get("environment").asString();
  Value out(Object{{"accountId", id}, {"environment", environment == "demo" || environment == "live" ? Value(environment) : Value()}});
  const auto& m = a.get("entryMode");
  out.set("entryMode", m.isObject() ? Value(Object{{"requested", text(m.get("requested"), 32)}, {"effective", text(m.get("effective"), 32)},
    {"transitionState", text(m.get("transitionState"), 32)}, {"policy", text(m.get("policy"), 32)}}) : Value());
  out.set("admittedBases", strings(a.get("admittedBases"), kBases, 16));
  out.set("bases", strings(a.get("bases"), kBases, 16));
  const auto& t = a.get("tick");
  if (t.isObject()) {
    Value tick(Object{{"status", text(t.get("status"), 32)}, {"because", text(t.get("because"))}, {"stoppedAt", text(t.get("stoppedAt"), 64)},
      {"stoppedReason", text(t.get("stoppedReason"))}, {"ready", t.get("ready").isBool() ? t.get("ready") : Value()},
      {"blockedReasons", strings(t.get("blockedReasons"), kReasons, kText)}});
    if (t.get("checks").isObject()) {
      Value checks(Object{});
      for (const auto* name : kChecks) {
        const auto& c = t.get("checks").get(name);
        checks.set(name, c.isObject() ? Value(Object{{"ok", c.get("ok").isBool() ? c.get("ok") : Value()}, {"observed", text(c.get("observed"))}}) : Value());
      }
      tick.set("checks", checks);
    } else tick.set("checks", Value());
    if (t.get("readinessUnavailable").isString()) tick.set("readinessUnavailable", text(t.get("readinessUnavailable")));
    out.set("tick", tick);
  } else out.set("tick", Value());
  const auto& d = a.get("dominantRefusal");
  out.set("dominantRefusal", d.isObject() ? Value(Object{{"stage", text(d.get("stage"), 120)}, {"kind", text(d.get("kind"), 40)},
    {"records", count(d.get("records"))}, {"lastAt", text(d.get("lastAt"), 40)}, {"lastReason", text(d.get("lastReason"))}}) : Value());
  out.set("entryStopsInWindow", count(a.get("entryStopsInWindow")));
  out.set("independent", independent(id, environment, protection, now));
  return out;
}
}

Value entryDiagnosticsView(const Value& diagnostics, long long contractAtMs, const Value& protection, long long now, long long graceMs) {
  Value out(Object{{"evidence", "node_records_relayed"}, {"brokerVerified", false}, {"relayedBy", "cpp-verify"},
    {"note", "Pre-broker refusals are Node's own records relayed; cpp-verify did not observe them and cannot confirm them at the broker. "
             "Only independent.openCount is read at the broker, by cpp-verify."},
    {"nodeContractAtMs", contractAtMs > 0 ? Value(contractAtMs) : Value()}, {"stale", !fresh(contractAtMs, now, graceMs)}});
  // Absent or invalid is never a healthy empty list.
  const auto unavailable = [&](const std::string& reason) {
    out.set("available", false); out.set("complete", false); out.set("reason", reason); out.set("accounts", Array{}); return out;
  };
  if (contractAtMs <= 0) return unavailable("no_node_contract_since_start");
  if (diagnostics.isNull()) return unavailable("node_contract_carries_no_entry_diagnostics");
  if (!diagnostics.isObject() || number(diagnostics.get("schemaVersion")) != 1 || diagnostics.get("source").asString() != "node_records"
      || !diagnostics.get("accounts").isArray()) return unavailable("entry_diagnostics_invalid");
  out.set("nodeObservedAtMs", count(diagnostics.get("observedAtMs")));
  out.set("windowFromMs", count(diagnostics.get("windowFromMs"))); out.set("windowToMs", count(diagnostics.get("windowToMs")));
  const auto& accounts = diagnostics.get("accounts").asArray();
  const auto nodeReason = text(diagnostics.get("reason"), 64);
  if (accounts.empty() && !diagnostics.get("complete").asBool())
    return unavailable(nodeReason.isString() ? nodeReason.asString() : "node_reported_incomplete");
  Array rows; long long dropped = 0;
  for (const auto& a : accounts) {
    if (rows.size() >= kAccounts || !a.isObject() || !accountId(a.get("accountId").asString())) { ++dropped; continue; }
    rows.push_back(account(a, protection, now));
  }
  out.set("available", true);
  out.set("complete", diagnostics.get("complete").asBool() && dropped == 0);
  out.set("reason", nodeReason.isString() ? nodeReason : dropped ? Value("accounts_dropped_by_relay_bound_or_shape") : Value());
  out.set("accountsDropped", dropped);
  out.set("accounts", Value(std::move(rows)));
  return out;
}
}
