// cpp-exec/src/health_view.cpp — see health_view.hpp.
#include "health_view.hpp"

#include <string>

namespace health_view {

jsn::Value guard(const GuardSnapshot& g, bool trusted) {
  jsn::Value gj{jsn::Object{}};
  gj.set("halt", g.halt);
  gj.set("requireBracket", g.requireBracket);
  gj.set("requireTarget", g.requireTarget);
  gj.set("maxOrderVolume", g.maxOrderVolume);
  gj.set("haltAccountCount", static_cast<double>(g.haltAccounts.size()));
  gj.set("entryEpochCount", static_cast<double>(g.entryEpochs.size()));
  if (trusted) {
    // AUDIT 11-09-2026 (plan B05): the LIST, so the keeper's guard sync can
    // compare identity — two accounts swapped for two others read as "in
    // sync" by count alone.
    jsn::Array ha;
    for (long long id : g.haltAccounts) ha.push_back(jsn::Value(static_cast<double>(id)));
    gj.set("haltAccounts", jsn::Value(std::move(ha)));
    // P2a: the fenced epochs, so the keeper's guard sync can see whether its
    // push bound. Keyed by ctidTraderAccountId, so trusted only (GW-1, B1b).
    jsn::Value eo{jsn::Object{}};
    for (const auto& kv : g.entryEpochs) eo.set(std::to_string(kv.first), static_cast<double>(kv.second));
    gj.set("entryEpochs", std::move(eo));
  }
  return gj;
}

namespace {

// The open view's allowlist: ShadowSim::json()'s scalars, by name.
const char* const kSimScalars[] = {"latencyMs", "slippage", "commissionPerSide", "targetR",
                                   "minTargetToCost", "maxHoldEvents", "maxHoldMs"};
// ShadowCostSchedule::json()'s four terms per class row, by name.
const char* const kCostTerms[] = {"commissionWirePerSide", "commissionBpsPerSide",
                                  "slippageWirePerSide", "slippageBpsPerSide"};

// A named key reaches the open view only with a SCALAR value: an object or an
// array under an allowlisted name would carry whatever keys it grows.
void copyScalar(jsn::Value& out, const jsn::Value& in, const char* key) {
  const jsn::Value& v = in.get(key);
  if (v.isNumber() || v.isString() || v.isBool()) out.set(key, v);
}

} // namespace

jsn::Value shadowSim(const jsn::Value& sim, bool trusted) {
  if (trusted) return sim;
  if (!sim.isObject()) return jsn::Value(nullptr);
  // AN ALLOWLIST (GW-1 re-check, nit 2): the open view is built from NAMED
  // keys, as Node's own /health builds its public subset — a field the sim
  // grows later stays on the trusted branch until someone names it here.
  // Removing only costs.symbolClass would have published the next id map by
  // default. Every level is built fresh, never by editing a copy: jsn::Value
  // copies share their object, so a set on one would edit the trusted view.
  jsn::Value out{jsn::Object{}};
  for (const char* k : kSimScalars) copyScalar(out, sim, k);
  const jsn::Value& costs = sim.get("costs");
  if (costs.isObject()) {
    jsn::Value oc{jsn::Object{}};
    copyScalar(oc, costs, "fallbackClass");
    // Class names come from the repo's cost schedule (tick-shadow-sim.json:
    // fx, us_stock, ...), not from the broker; each row keeps its four terms.
    jsn::Value classes{jsn::Object{}};
    for (const auto& [name, row] : costs.get("classes").asObject()) {
      jsn::Value r{jsn::Object{}};
      for (const char* t : kCostTerms) copyScalar(r, row, t);
      classes.set(name, std::move(r));
    }
    oc.set("classes", std::move(classes));
    // symbolClass is keyed by symbol id: the open route gets its size only.
    const jsn::Value& sc = costs.get("symbolClass");
    oc.set("symbolClassCount", static_cast<double>(sc.isObject() ? sc.asObject().size() : 0));
    out.set("costs", std::move(oc));
  }
  return out;
}

} // namespace health_view
