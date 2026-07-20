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

OrderVerdict validateOrder(const jsn::Value& payload, const GuardSnapshot& g) {
  if (g.halt) {
    return { false, "guard_halt: execution halted by kill switch" };
  }
  if (!payload.isObject()) {
    return { false, "guard_bad_payload: order must be a JSON object" };
  }

  // Order type: default MARKET when unspecified (matches the app's market path).
  const jsn::Value& ot = payload.get("orderType");
  const std::string type = ot.isString() ? ot.asString() : "MARKET";
  const bool isMarket = (type == "MARKET" || type == "MARKET_RANGE");

  // #4 bracket guarantee: a MARKET order with no attached stop is a naked
  // position — the one thing the execution core must never let through. A
  // caller that genuinely wants a stopless order must say so explicitly.
  if (g.requireBracket && isMarket && !orderHasBracket(payload)) {
    const jsn::Value& allow = payload.get("allowNaked");
    const bool explicitlyAllowed = allow.isBool() && allow.asBool(false);
    if (!explicitlyAllowed) {
      return { false, "guard_naked_order: market order has no stop loss attached (set allowNaked to override)" };
    }
  }

  // #3 volume cap from the atomic block.
  if (g.maxOrderVolume > 0) {
    const jsn::Value& vol = payload.get("volume");
    if (vol.isNumber() && vol.asNumber(0) > g.maxOrderVolume) {
      return { false, "guard_volume_cap: order volume exceeds the configured max" };
    }
  }

  return { true, "" };
}
