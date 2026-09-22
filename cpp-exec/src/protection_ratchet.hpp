#pragma once
#include <cmath>
#include <string>
#include "json.hpp"

// A broker read, not a configured/cached stop, is the floor for an automatic
// amendment. The caller serializes the complete read/amend/read transaction.
struct BrokerProtection {
  double sl = 0, tp = 0;
  int dir = 0;
  long long symbolId = 0;
  long long readStartedAtMs = 0, checkedAtMs = 0, readDurationMs = 0;
};

inline long long protectionId(const jsn::Value& v) {
  if (v.isNumber()) {
    const double n = v.asNumber();
    return std::isfinite(n) && n > 0 && n <= 9007199254740991.0 && std::floor(n) == n
      ? static_cast<long long>(n) : 0;
  }
  if (v.isString()) {
    const auto s = v.asString();
    if (s.empty() || s.find_first_not_of("0123456789") != std::string::npos) return 0;
    try { const auto n = std::stoll(s); return n > 0 && n <= 9007199254740991LL ? n : 0; }
    catch (...) { return 0; }
  }
  return 0;
}

inline std::string readBrokerProtection(const jsn::Value& body, long long account,
                                       long long position, BrokerProtection& out) {
  if (protectionId(body.get("ctidTraderAccountId")) != account || !body.get("position").isArray())
    return "account or position-list mismatch";
  int matches = 0;
  for (const auto& p : body.get("position").asArray()) {
    if (protectionId(p.get("positionId")) != position) continue;
    ++matches;
    const auto& td = p.get("tradeData");
    const auto& side = td.get("tradeSide");
    out.dir = protectionId(side) == 1 || side.asString() == "BUY" ? 1
      : protectionId(side) == 2 || side.asString() == "SELL" ? -1 : 0;
    out.symbolId = protectionId(td.get("symbolId"));
    for (const auto* key : {"stopLoss", "takeProfit"}) {
      const auto& v = p.get(key);
      if (!v.isNull() && (!v.isNumber() || !std::isfinite(v.asNumber()) || v.asNumber() < 0))
        return "malformed broker protection";
    }
    out.sl = p.get("stopLoss").asNumber();
    out.tp = p.get("takeProfit").asNumber();
  }
  if (matches != 1 || !out.dir || out.symbolId <= 0) return "position absent, duplicated or malformed";
  return "";
}

inline bool stopAtLeastAsTight(double actual, double requested, int dir) {
  return actual > 0 && (dir == 1 ? actual >= requested : actual <= requested);
}

inline jsn::Value confirmedProtection(const BrokerProtection& p, bool unchanged) {
  jsn::Value protection{jsn::Object{}}, result{jsn::Object{}};
  protection.set("verified", true);
  protection.set("source", std::string("broker_reconcile"));
  protection.set("confirmation", std::string(unchanged ? "already_tighter_snapshot" : "amend_readback"));
  protection.set("readStartedAtMs", p.readStartedAtMs);
  protection.set("checkedAtMs", p.checkedAtMs);
  protection.set("readDurationMs", p.readDurationMs);
  protection.set("stopLoss", p.sl > 0 ? jsn::Value(p.sl) : jsn::Value(nullptr));
  protection.set("takeProfit", p.tp > 0 ? jsn::Value(p.tp) : jsn::Value(nullptr));
  result.set("protection", protection);
  result.set("unchanged", unchanged);
  return result;
}
