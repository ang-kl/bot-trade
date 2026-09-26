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

jsn::Value shadowSim(const jsn::Value& sim, bool trusted) {
  if (trusted || !sim.isObject()) return sim;
  // jsn::Value copies SHARE their object (a shared_ptr), so the open view is
  // rebuilt key by key — setting on a copy would edit the trusted original.
  jsn::Value out{jsn::Object{}};
  for (const auto& [k, val] : sim.asObject()) {
    if (k != "costs" || !val.isObject()) { out.set(k, val); continue; }
    jsn::Value costs{jsn::Object{}};
    for (const auto& [ck, cv] : val.asObject()) {
      if (ck == "symbolClass") costs.set("symbolClassCount", static_cast<double>(cv.isObject() ? cv.asObject().size() : 0));
      else costs.set(ck, cv);
    }
    out.set(k, std::move(costs));
  }
  return out;
}

} // namespace health_view
