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
  // Codex · №12,072 · 2026-10-08; codex-footprint: confirmed-trail.
  // Native read-back identity; absent/malformed entry stays unknown.
  long long accountId = 0, positionId = 0;
  double entryPrice = 0;
  long long readStartedAtMs = 0, checkedAtMs = 0, readDurationMs = 0;
  // 02-10-2026 stop-loss policy read-back. trigger 0 = absent; hasTrailing
  // false = absent. ProtoOAPosition.trailingStopLoss has had a read-back bug
  // (reads absent/false when enabled), so ABSENT means "unknown", never
  // "false" and never a mismatch.
  int trigger = 0;
  bool hasTrailing = false, trailing = false;
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

// ProtoOAOrderTriggerMethod: TRADE=1, OPPOSITE=2, DOUBLE_TRADE=3,
// DOUBLE_OPPOSITE=4. The broker's JSON replies carry the number; this repo's
// builders write enum NAMES elsewhere (tradeSide "BUY"), so reading accepts
// both. 0 = absent or malformed (never an error on the read side).
inline int parseTriggerMethod(const jsn::Value& v) {
  if (v.isNumber()) {
    const double n = v.asNumber();
    return std::isfinite(n) && std::floor(n) == n && n >= 1 && n <= 4 ? static_cast<int>(n) : 0;
  }
  if (v.isString()) {
    const auto& s = v.asString();
    return s == "TRADE" ? 1 : s == "OPPOSITE" ? 2 : s == "DOUBLE_TRADE" ? 3 : s == "DOUBLE_OPPOSITE" ? 4 : 0;
  }
  return 0;
}

// The request side: what Node asked the amend to carry. triggerWire is the
// caller's own value (number or name) so the wire emits exactly what Node
// decided; trigger is the normalised number used for comparison and reports.
struct StopPolicyRequest {
  int trigger = 0;
  jsn::Value triggerWire;
  bool hasTrailing = false, trailing = false;
  std::string error;
  bool any() const { return trigger > 0 || hasTrailing; }
  // Fields that can be VERIFIED from a position read: the trigger, and trailing
  // only when it was asked for true (a false request cannot be told apart from
  // the broker's absent-field read-back bug).
  bool counted() const { return trigger > 0 || (hasTrailing && trailing); }
};

inline StopPolicyRequest parseStopPolicy(const jsn::Value& payload) {
  StopPolicyRequest r;
  const auto& t = payload.get("stopLossTriggerMethod");
  if (!t.isNull()) {
    r.trigger = parseTriggerMethod(t);
    if (r.trigger == 0) {
      r.error = "stopLossTriggerMethod must be 1..4 or TRADE|OPPOSITE|DOUBLE_TRADE|DOUBLE_OPPOSITE";
      return r;
    }
    r.triggerWire = t;
  }
  const auto& b = payload.get("trailingStopLoss");
  if (!b.isNull()) {
    if (!b.isBool()) { r.error = "trailingStopLoss must be a boolean"; return r; }
    r.hasTrailing = true;
    r.trailing = b.asBool();
  }
  return r;
}

// True when a stop already sits at or beyond breakeven: only then may the trail
// engine ask for a trailing stop (a trailing stop below entry would lock a loss
// in as a moving target).
inline bool stopLocksProfit(int dir, double entry, double sl) {
  if (!(entry > 0) || !(sl > 0)) return false;
  return dir == 1 ? sl >= entry : dir == -1 ? sl <= entry : false;
}

// Does the broker read show every verifiable requested field already applied?
inline bool policyAlreadyApplied(const StopPolicyRequest& r, const BrokerProtection& p) {
  if (r.trigger > 0 && p.trigger != r.trigger) return false;
  if (r.hasTrailing && r.trailing && !(p.hasTrailing && p.trailing)) return false;
  return true;
}

// "confirmed" | "mismatch" | "unreadable" | "none". Mismatch (present and
// different) outranks unreadable (absent), which outranks confirmed.
inline std::string policyReadback(const StopPolicyRequest& r, const BrokerProtection& p) {
  if (!r.counted()) return "none";
  bool mismatch = false, unreadable = false;
  if (r.trigger > 0) {
    if (p.trigger == 0) unreadable = true; else if (p.trigger != r.trigger) mismatch = true;
  }
  if (r.hasTrailing && r.trailing) {
    if (!p.hasTrailing) unreadable = true; else if (!p.trailing) mismatch = true;
  }
  return mismatch ? "mismatch" : unreadable ? "unreadable" : "confirmed";
}

inline jsn::Value policyBlock(const StopPolicyRequest& r, bool applied, const std::string& readback,
                              const jsn::Value& refused, const std::string& skipped) {
  jsn::Value req{jsn::Object{}}, out{jsn::Object{}};
  req.set("stopLossTriggerMethod", r.trigger > 0 ? jsn::Value(r.trigger) : jsn::Value(nullptr));
  req.set("trailingStopLoss", r.hasTrailing ? jsn::Value(r.trailing) : jsn::Value(nullptr));
  out.set("requested", req);
  out.set("applied", applied);
  out.set("readback", readback);
  out.set("refused", refused);
  out.set("skipped", skipped.empty() ? jsn::Value(nullptr) : jsn::Value(skipped));
  return out;
}

inline jsn::Value withoutPolicyFields(const jsn::Value& wire) {
  jsn::Object o = wire.asObject();
  o.erase("stopLossTriggerMethod");
  o.erase("trailingStopLoss");
  return jsn::Value(std::move(o));
}

inline std::string readBrokerProtection(const jsn::Value& body, long long account,
                                       long long position, BrokerProtection& out) {
  if (protectionId(body.get("ctidTraderAccountId")) != account || !body.get("position").isArray())
    return "account or position-list mismatch";
  int matches = 0;
  for (const auto& p : body.get("position").asArray()) {
    if (protectionId(p.get("positionId")) != position) continue;
    ++matches;
    out.accountId = protectionId(body.get("ctidTraderAccountId"));
    out.positionId = protectionId(p.get("positionId"));
    const auto& entry = p.get("price");
    out.entryPrice = entry.isNumber() && std::isfinite(entry.asNumber()) && entry.asNumber() > 0
      ? entry.asNumber() : 0;
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
    // Policy read-back is tolerant by design: a malformed or absent value
    // stays unset rather than failing the stop-level read (02-10-2026).
    out.trigger = parseTriggerMethod(p.get("stopLossTriggerMethod"));
    out.hasTrailing = p.get("trailingStopLoss").isBool();
    out.trailing = out.hasTrailing && p.get("trailingStopLoss").asBool();
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
  protection.set("stopLossTriggerMethod", p.trigger > 0 ? jsn::Value(p.trigger) : jsn::Value(nullptr));
  protection.set("trailingStopLoss", p.hasTrailing ? jsn::Value(p.trailing) : jsn::Value(nullptr));
  result.set("protection", protection);
  result.set("unchanged", unchanged);
  return result;
}

// Codex · №12,072 · 2026-10-08; codex-footprint: confirmed-trail.
// Evidence only: a policy stamp may succeed without moving the level. Neither
// a cached/configured stop nor an unknown position episode proves movement.
inline jsn::Value confirmedMovementProof(const BrokerProtection& before,
                                         const BrokerProtection& after,
                                         bool unchanged, bool levelAmend) {
  const auto knownPrice = [](double n) { return std::isfinite(n) && n > 0; };
  const bool sameIdentity = before.accountId > 0 && before.positionId > 0 && before.symbolId > 0 &&
    before.accountId == after.accountId && before.positionId == after.positionId &&
    before.symbolId == after.symbolId && (before.dir == 1 || before.dir == -1) && before.dir == after.dir &&
    knownPrice(before.entryPrice) && knownPrice(after.entryPrice) && before.entryPrice == after.entryPrice;
  const bool orderedReads = before.checkedAtMs > 0 && after.checkedAtMs >= before.checkedAtMs;
  const bool improved = knownPrice(before.sl) && knownPrice(after.sl) &&
    (before.dir == 1 ? after.sl > before.sl : before.dir == -1 ? after.sl < before.sl : false);
  jsn::Value proof{jsn::Object{}};
  proof.set("v", 1);
  proof.set("source", "broker_reconcile");
  proof.set("confirmation", unchanged ? "already_tighter_snapshot" : "amend_readback");
  proof.set("accountId", before.accountId > 0 ? jsn::Value(before.accountId) : jsn::Value(nullptr));
  proof.set("positionId", before.positionId > 0 ? jsn::Value(before.positionId) : jsn::Value(nullptr));
  proof.set("symbolId", before.symbolId > 0 ? jsn::Value(before.symbolId) : jsn::Value(nullptr));
  proof.set("direction", before.dir == 1 || before.dir == -1 ? jsn::Value(before.dir) : jsn::Value(nullptr));
  proof.set("entryPrice", knownPrice(before.entryPrice) ? jsn::Value(before.entryPrice) : jsn::Value(nullptr));
  proof.set("beforeStopLoss", knownPrice(before.sl) ? jsn::Value(before.sl) : jsn::Value(nullptr));
  proof.set("afterStopLoss", knownPrice(after.sl) ? jsn::Value(after.sl) : jsn::Value(nullptr));
  proof.set("stopMoved", levelAmend && !unchanged && sameIdentity && orderedReads && improved);
  proof.set("beforeCheckedAtMs", before.checkedAtMs > 0 ? jsn::Value(before.checkedAtMs) : jsn::Value(nullptr));
  proof.set("afterCheckedAtMs", after.checkedAtMs > 0 ? jsn::Value(after.checkedAtMs) : jsn::Value(nullptr));
  return proof;
}

inline jsn::Value confirmedProtection(const BrokerProtection& before,
                                      const BrokerProtection& after,
                                      bool unchanged, bool levelAmend) {
  auto result = confirmedProtection(after, unchanged);
  auto protection = result.get("protection");
  protection.set("movement", confirmedMovementProof(before, after, unchanged, levelAmend));
  result.set("protection", protection);
  return result;
}
