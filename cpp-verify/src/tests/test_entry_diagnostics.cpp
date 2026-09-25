#include "../entry_diagnostics.hpp"
#include <cassert>
#include <iostream>
using jsn::Value; using jsn::Object; using jsn::Array;
namespace {
constexpr long long T = 1800000000000LL, GRACE = 60000;
Value nodeAccount(const std::string& id, const std::string& environment = "demo") {
  return Value(Object{{"accountId", id}, {"environment", environment},
    {"entryMode", Object{{"requested", "TIME_BASED"}, {"effective", "TIME_BASED"}, {"transitionState", "STABLE"}, {"policy", "manual"}}},
    {"admittedBases", Value()}, {"bases", Array{Value("bar")}},
    {"tick", Object{{"status", "not_evaluated"}, {"because", "basis_not_admitted"}, {"stoppedAt", Value()}, {"stoppedReason", Value()}, {"ready", false},
      {"checks", Object{{"profile_pinned", Object{{"ok", false}, {"observed", "no pin"}}}, {"profile_matches_sidecar", Object{{"ok", false}, {"observed", "x"}}},
        {"replay_evidence", Object{{"ok", false}, {"observed", "none"}}}, {"validation_stage", Object{{"ok", false}, {"observed", "UNVALIDATED"}}}}},
      {"blockedReasons", Array{Value("profile_pinned"), Value("replay_evidence")}}}},
    {"dominantRefusal", Object{{"stage", "stage_matrix"}, {"kind", "upstream_stop"}, {"records", 3}, {"lastAt", "2027-01-15T08:00:00.000Z"}, {"lastReason", "strategy OFF"}}},
    {"entryStopsInWindow", 3}});
}
Value diagnostics(Array accounts, bool complete = true) {
  return Value(Object{{"schemaVersion", 1}, {"source", "node_records"}, {"observedAtMs", T}, {"windowFromMs", T - 86400000}, {"windowToMs", T + 1},
    {"complete", complete}, {"accounts", std::move(accounts)}});
}
Value protection(const std::string& id, long long checkedAt, long long open = 2, bool ok = true) {
  return Value(Object{{"accounts", Array{Value(Object{{"accountId", id}, {"host", "demo.ctraderapi.com"}, {"ok", ok}, {"source", "broker_reconcile"},
    {"checkedAtMs", checkedAt}, {"openCount", open}, {"missingSl", 0}, {"missingTp", 0}, {"positions", Array{}}})}}});
}
}
int main() {
  {
    // (a) Provenance is labelled on the payload, and the one broker-read value
    // is cpp-verify's own reconcile count, not anything Node sent.
    const auto v = verify::entryDiagnosticsView(diagnostics({nodeAccount("11")}), T, protection("11", T - 1000, 2), T + 1000, GRACE);
    assert(v.get("evidence").asString() == "node_records_relayed" && v.get("brokerVerified").isBool() && !v.get("brokerVerified").asBool());
    assert(v.get("relayedBy").asString() == "cpp-verify" && !v.get("note").asString().empty());
    assert(v.get("available").asBool() && v.get("complete").asBool() && !v.get("stale").asBool());
    const auto& a = v.get("accounts").asArray().front();
    assert(a.get("accountId").asString() == "11" && a.get("tick").get("status").asString() == "not_evaluated");
    assert(a.get("tick").get("checks").get("validation_stage").get("observed").asString() == "UNVALIDATED");
    assert(a.get("dominantRefusal").get("stage").asString() == "stage_matrix" && a.get("dominantRefusal").get("records").asNumber() == 3);
    assert(a.get("independent").get("available").asBool() && a.get("independent").get("openCount").asNumber() == 2);
    assert(a.get("independent").get("source").asString() == "cpp-verify broker_reconcile");
  }
  {
    // (b) A Node contract older than the grace is stale — detected here, which
    // Node cannot do for its own outage.
    const auto v = verify::entryDiagnosticsView(diagnostics({nodeAccount("11")}), T, protection("11", T), T + GRACE, GRACE);
    assert(v.get("stale").asBool() && v.get("available").asBool());
  }
  {
    // (c) Absent is never a healthy empty list.
    const auto none = verify::entryDiagnosticsView(Value(), 0, Value(), T, GRACE);
    assert(!none.get("available").asBool() && none.get("accounts").isArray() && none.get("accounts").asArray().empty());
    assert(none.get("reason").asString() == "no_node_contract_since_start" && none.get("stale").asBool());
    const auto absent = verify::entryDiagnosticsView(Value(), T, Value(), T, GRACE);
    assert(!absent.get("available").asBool() && absent.get("reason").asString() == "node_contract_carries_no_entry_diagnostics");
    auto wrong = diagnostics({}); wrong.set("source", "broker");
    assert(verify::entryDiagnosticsView(wrong, T, Value(), T, GRACE).get("reason").asString() == "entry_diagnostics_invalid");
    // Node's own "unavailable" block is relayed as unavailable with its reason.
    auto failed = diagnostics({}, false); failed.set("reason", "entry_diagnostics_unavailable");
    const auto relayed = verify::entryDiagnosticsView(failed, T, Value(), T, GRACE);
    assert(!relayed.get("available").asBool() && relayed.get("reason").asString() == "entry_diagnostics_unavailable");
  }
  {
    // (d) 65 accounts: 64 relayed, marked incomplete.
    Array many; for (int i = 1; i <= 65; ++i) many.push_back(nodeAccount(std::to_string(1000 + i)));
    const auto v = verify::entryDiagnosticsView(diagnostics(many), T, Value(), T, GRACE);
    assert(v.get("accounts").asArray().size() == 64 && !v.get("complete").asBool() && v.get("accountsDropped").asNumber() == 1);
    // An account id that is not a broker id is dropped, not relayed.
    const auto bad = verify::entryDiagnosticsView(diagnostics({nodeAccount("0123"), nodeAccount("../x")}), T, Value(), T, GRACE);
    assert(bad.get("accounts").asArray().empty() && bad.get("accountsDropped").asNumber() == 2 && !bad.get("complete").asBool());
  }
  {
    // (e) Long text is cut to at most 200 bytes, on a character boundary.
    auto a = nodeAccount("11"); auto d = a.get("dominantRefusal").asObject();
    std::string reason(9999, 'x'); reason += "é"; reason = std::string(199, 'y') + "é" + reason; // 'é' straddles byte 200
    d["lastReason"] = Value(reason); a.set("dominantRefusal", Value(d));
    const auto v = verify::entryDiagnosticsView(diagnostics({a}), T, Value(), T, GRACE);
    const auto cut = v.get("accounts").asArray().front().get("dominantRefusal").get("lastReason").asString();
    assert(cut.size() <= 200 && cut == std::string(199, 'y'));
    Array reasons; for (int i = 0; i < 40; ++i) reasons.push_back(Value("r" + std::to_string(i)));
    auto tick = a.get("tick").asObject(); tick["blockedReasons"] = Value(reasons); a.set("tick", Value(tick));
    assert(verify::entryDiagnosticsView(diagnostics({a}), T, Value(), T, GRACE).get("accounts").asArray().front()
      .get("tick").get("blockedReasons").asArray().size() == 24);
  }
  {
    // (f) Unknown keys are not copied, at any level.
    auto a = nodeAccount("11"); a.set("accessToken", "secret-value");
    auto tick = a.get("tick").asObject(); auto checks = tick["checks"].asObject(); checks["clientSecret"] = Value(Object{{"ok", true}, {"observed", "secret-value"}});
    tick["checks"] = Value(checks); a.set("tick", Value(tick));
    auto body = diagnostics({a}); body.set("credentials", "secret-value");
    const auto text = jsn::dump(verify::entryDiagnosticsView(body, T, Value(), T, GRACE));
    assert(text.find("secret-value") == std::string::npos && text.find("accessToken") == std::string::npos);
  }
  {
    // (g) The broker read must be cpp-verify's own, ok and fresh (180 s).
    assert(!verify::entryDiagnosticsView(diagnostics({nodeAccount("11")}), T, protection("11", T - 180000), T, GRACE)
      .get("accounts").asArray().front().get("independent").get("available").asBool());
    assert(!verify::entryDiagnosticsView(diagnostics({nodeAccount("11")}), T, protection("11", T, 2, false), T, GRACE)
      .get("accounts").asArray().front().get("independent").get("available").asBool());
    const auto other = verify::entryDiagnosticsView(diagnostics({nodeAccount("11", "live")}), T, protection("11", T), T, GRACE);
    assert(other.get("accounts").asArray().front().get("independent").get("reason").asString() == "no_broker_reconcile_for_account"); // wrong host
    assert(verify::entryDiagnosticsView(diagnostics({nodeAccount("11")}), T, protection("11", T - 179999), T, GRACE)
      .get("accounts").asArray().front().get("independent").get("available").asBool());
  }
  std::cout << "entry diagnostics relay: labelled, bounded, whitelisted, stale-aware and broker-read only for open counts\n";
}
