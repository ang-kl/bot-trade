// cpp-exec/src/order_guard.cpp
#include "order_guard.hpp"

static bool hasPositiveNumber(const jsn::Value& payload, const std::string& key) {
  const jsn::Value& v = payload.get(key);
  return v.isNumber() && v.asNumber(0) > 0;
}

bool orderHasBracket(const jsn::Value& payload) {
  // Relative points (the app's normal market-order path) or an absolute stop.
  return hasPositiveNumber(payload, "relativeStopLoss") ||
         hasPositiveNumber(payload, "stopLoss");
}

bool orderHasTarget(const jsn::Value& payload) {
  return hasPositiveNumber(payload, "relativeTakeProfit") ||
         hasPositiveNumber(payload, "takeProfit");
}

OrderVerdict validateOrder(const jsn::Value& payload, const GuardSnapshot& g) {
  if (g.halt) {
    return { false, "guard_halt: execution halted by kill switch" };
  }
  if (!payload.isObject()) {
    return { false, "guard_bad_payload: order must be a JSON object" };
  }

  // PHASE 2, owner's decision 2026-07-30: "C++ sidecar refuse an unstamped
  // operation." This engine used to FILL IN a missing ctidTraderAccountId from
  // accountIds_.front() (engine.cpp's old withAccountId). That default is why
  // exits on non-primary accounts silently went to the wrong account for so
  // long: the primary is elected once per broker session and then frozen, so
  // every unstamped close and amend had exactly one destination regardless of
  // which account the caller meant. Refusing turns that from a silent mis-route
  // into a loud failure on the first attempt.
  //
  // Checked here rather than only at the call site so it is atomic with the rest
  // of the guard and lands in the same telemetry record as every other refusal.
  //
  // By the time this ships, Node stamps the account on every write
  // (agent/lib/exec-engine.js withAccount, merged first and deliberately
  // deployed first), so there should be nothing left to refuse — this is a
  // tripwire, not a behaviour change.
  const jsn::Value& acct = payload.get("ctidTraderAccountId");
  if (!acct.isNumber() || acct.asNumber(0) <= 0) {
    return { false, "guard_no_account: order does not name a ctidTraderAccountId — refusing to choose an account on the caller's behalf" };
  }

  // Per-account halt (Node's equity-stop mirror, 2026-08-31). Scoped to THIS
  // account only — see GuardSnapshot.haltAccounts for why it is not a global.
  if (g.haltAccounts.count(static_cast<long long>(acct.asNumber(0))) > 0) {
    return { false, "account_halted: this ctidTraderAccountId is halted by the keeper's guard sync (equity stop or owner halt)" };
  }

  // Order type: default MARKET when unspecified (matches the app's market path).
  const jsn::Value& ot = payload.get("orderType");
  const std::string type = ot.isString() ? ot.asString() : "MARKET";
  const bool isMarket = (type == "MARKET" || type == "MARKET_RANGE");

  // #4 bracket guarantee: a MARKET order with no attached stop is a naked
  // position — the one thing the execution core must never let through. A
  // caller that genuinely wants a stopless order must say so explicitly.
  if (isMarket) {
    const jsn::Value& allow = payload.get("allowNaked");
    const bool explicitlyAllowed = allow.isBool() && allow.asBool(false);
    if (g.requireBracket && !orderHasBracket(payload) && !explicitlyAllowed) {
      return { false, "guard_naked_order: market order has no stop loss attached (set allowNaked to override)" };
    }
    // Owner-approved 2026-07-22: an SL-only position isn't "managed" either —
    // several open positions had no Take Profit at all.
    if (g.requireTarget && !orderHasTarget(payload) && !explicitlyAllowed) {
      return { false, "guard_no_target: market order has no take profit attached (set allowNaked to override)" };
    }
  }

  // A volume the guard cannot read is a volume the cap cannot bound — reject
  // it rather than forward it verbatim for the broker to interpret (audit #7:
  // a string/absent volume used to skip the cap entirely, and Node's
  // withNumericIds deliberately leaves malformed values as-is).
  const jsn::Value& vol = payload.get("volume");
  if (!vol.isNumber() || !(vol.asNumber(0) > 0)) {
    return { false, "guard_bad_payload: order volume is missing or not a number" };
  }
  // #3 volume cap from the atomic block.
  if (g.maxOrderVolume > 0 && vol.asNumber(0) > g.maxOrderVolume) {
    return { false, "guard_volume_cap: order volume exceeds the configured max" };
  }

  return { true, "" };
}

// ---------------------------------------------------------------------------
// P2a: the one-use permit at the send boundary. See order_guard.hpp.
// ---------------------------------------------------------------------------
PermitVerdict validatePermit(const jsn::Value& payload, const GuardSnapshot& g,
                             std::set<std::string>& consumed, long long nowMs) {
  PermitVerdict v;
  const long long acct = payload.isObject()
      ? static_cast<long long>(payload.get("ctidTraderAccountId").asNumber(0)) : 0;
  const jsn::Value& permit = payload.get("permit");
  const auto epochIt = g.entryEpochs.find(acct);
  const bool fenced = epochIt != g.entryEpochs.end();
  if (!permit.isObject()) {
    if (fenced) {
      v.ok = false;
      v.reason = "permit_missing: this account's entry epoch is fenced (" +
                 std::to_string(epochIt->second) + ") and the order carries no permit";
      return v;
    }
    // WHOLE-PLAN AUDIT 11-09-2026 (TM-10): once the keeper has fenced ANY
    // account on this sidecar, an account it never fenced is one it does not
    // know — its orders are refused, not waved through (fail closed).
    if (!g.entryEpochs.empty()) {
      v.ok = false;
      v.reason = "permit_missing: the keeper fences " + std::to_string(g.entryEpochs.size()) +
                 " account(s) on this executor and this account is not among them";
    }
    return v; // no fence pushed at all (an older keeper): nothing to check
  }
  v.intentId = permit.get("intentId").asString();
  const std::string id = permit.get("id").asString();
  if (id.empty() || v.intentId.empty()) {
    v.ok = false;
    v.reason = "permit_malformed: id and intentId are required";
    return v;
  }
  if (fenced) {
    const long long pe = static_cast<long long>(permit.get("epoch").asNumber(-1));
    if (pe != epochIt->second) {
      v.ok = false;
      v.reason = "permit_epoch_stale: permit epoch " + std::to_string(pe) +
                 ", account epoch " + std::to_string(epochIt->second);
      return v;
    }
  }
  const double exp = permit.get("expiresAtMs").asNumber(0);
  if (exp <= 0 || static_cast<long long>(exp) < nowMs) {
    v.ok = false;
    v.reason = "permit_expired";
    return v;
  }
  const long long pAcct = static_cast<long long>(permit.get("accountId").asNumber(0));
  const long long pSym = static_cast<long long>(permit.get("symbolId").asNumber(-1));
  const long long sym = static_cast<long long>(payload.get("symbolId").asNumber(-2));
  const std::string pSide = permit.get("side").asString();
  const std::string side = payload.get("tradeSide").asString();
  const double pVol = permit.get("volume").asNumber(-1);
  const double vol = payload.get("volume").asNumber(-2);
  if (pAcct != acct || (pSym >= 0 && pSym != sym) || (!pSide.empty() && pSide != side) ||
      (pVol >= 0 && pVol != vol)) {
    v.ok = false;
    v.reason = "permit_mismatch: the permit does not describe this order (account/symbol/side/volume)";
    return v;
  }
  // WHOLE-PLAN AUDIT 11-09-2026 (plan §9): the permit binds the BRACKET the
  // intent was reserved with. When the permit names a stop or target, the
  // order must carry exactly that one — a re-priced or stripped bracket is
  // not the order the keeper admitted.
  for (const char* k : {"relativeStopLoss", "relativeTakeProfit", "stopLoss", "takeProfit"}) {
    const jsn::Value& pv = permit.get(k);
    if (!pv.isNumber()) continue;
    const jsn::Value& ov = payload.get(k);
    if (!ov.isNumber() || ov.asNumber() != pv.asNumber()) {
      v.ok = false;
      v.reason = std::string("permit_bracket_mismatch: ") + k + " differs from the permit";
      return v;
    }
  }
  if (consumed.count(id) > 0) {
    v.ok = false;
    v.reason = "permit_consumed: " + id + " was already used";
    return v;
  }
  consumed.insert(id);
  v.permitId = id;
  return v;
}

bool priceWithinBound(long long refPrice, long long nowPrice, long long maxDeviation) {
  if (refPrice <= 0 || maxDeviation < 0) return false;
  const long long d = nowPrice > refPrice ? nowPrice - refPrice : refPrice - nowPrice;
  return d <= maxDeviation;
}
