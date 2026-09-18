#include "verdict.hpp"

#include <algorithm>
#include <cmath>
#include <sstream>

#include "json.hpp"

namespace verify {
namespace {

std::string num(double d) {
  std::ostringstream os;
  os.setf(std::ios::fixed);
  os.precision(5);
  os << d;
  std::string s = os.str();
  // Trim trailing zeros so 1.50000 reads 1.5 — a verdict is read by people.
  auto dot = s.find('.');
  if (dot != std::string::npos) {
    while (!s.empty() && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
  }
  return s;
}

// Every comparison funnels through here so that ABSENT is handled once, the
// same way, for every field: it is a dispute in its own right, because the
// owner's rule for this record is that no field may be null.
template <typename T>
void compare(std::vector<FieldDispute>& out, const std::string& field,
             const std::optional<T>& keeper, const std::optional<T>& broker,
             double tolerance) {
  if (!broker) return;  // nothing to compare against; the fetch reasons say why
  if (!keeper) {
    out.push_back({field, "absent", num(static_cast<double>(*broker)), 0});
    return;
  }
  double k = static_cast<double>(*keeper), b = static_cast<double>(*broker);
  if (std::fabs(b - k) > tolerance) {
    out.push_back({field, num(k), num(b), b - k});
  }
}

} // namespace

const char* stateName(State s) {
  switch (s) {
    case State::Verified: return "verified";
    case State::Disputed: return "disputed";
    case State::Absent: return "absent";
    case State::Unverified: break;
  }
  return "unverified";
}

Verdict judge(const KeeperRecord& rec, const DealFetch& fetch, Tolerance tol) {
  Verdict v;

  // I10 FIRST, BEFORE ANY COMPARISON. A fetch that stopped early cannot
  // support `verified` and must not produce `disputed` either: what we are
  // missing is our gap, not the keeper's error. Judging on a partial read is
  // how a verifier starts manufacturing findings.
  if (!fetch.ok || !fetch.complete) {
    v.state = State::Unverified;
    v.reason = fetch.error.empty() ? "deal fetch incomplete" : fetch.error;
    return v;
  }

  std::vector<const Deal*> mine;
  for (const auto& d : fetch.deals) {
    if (d.positionId == rec.positionId) mine.push_back(&d);
  }
  v.dealCount = static_cast<int>(mine.size());

  if (mine.empty()) {
    v.state = State::Absent;
    v.reason = "the broker reports no deal for position " +
               std::to_string(rec.positionId) + " in this window";
    return v;
  }

  // In cTrader an OPENING deal carries no closePositionDetail and a CLOSING
  // one does. That is the only signal needed here, and it is the broker's
  // own: nothing is inferred from our side of the trade.
  long long openVol = 0, closeVol = 0;
  double openNotional = 0, closeNotional = 0;
  double gross = 0, swap = 0, commission = 0;
  long long openedAt = 0, closedAt = 0;

  for (const Deal* d : mine) {
    commission += d->commission;
    if (d->hasClose) {
      v.sawClose = true;
      closeVol += d->volume;
      closeNotional += d->executionPrice * static_cast<double>(d->volume);
      gross += d->grossProfit;
      swap += d->swap;
      closedAt = std::max(closedAt, d->executionTimestamp);
    } else {
      if (!v.sawOpen || d->executionTimestamp < openedAt) openedAt = d->executionTimestamp;
      v.sawOpen = true;
      openVol += d->volume;
      openNotional += d->executionPrice * static_cast<double>(d->volume);
      v.brokerSymbolId = d->symbolId;
      v.brokerTradeSide = d->tradeSide;
    }
  }

  if (v.sawOpen && openVol > 0) {
    v.brokerEntryPrice = openNotional / static_cast<double>(openVol);
    // CENTS OF UNITS -> UNITS for the record, and -> LOTS for the comparison
    // through the symbol's own lotSize (contract 3). No lotSize, no lots:
    // a volume scaled by a guessed lot is the contract-2 defect again.
    v.brokerVolumeUnits = static_cast<double>(openVol) / kVolumeCentiUnits;
    if (rec.lotSize && *rec.lotSize > 0) {
      v.brokerVolume = static_cast<double>(openVol) / *rec.lotSize;
    }
    v.brokerOpenedAtMs = openedAt;
  }
  if (v.sawClose && closeVol > 0) {
    v.brokerExitPrice = closeNotional / static_cast<double>(closeVol);
    v.brokerClosedAtMs = closedAt;
    // Copied and summed, never recomputed from prices (I8). A P&L derived
    // from a price move is the thing this service exists to check, not a
    // thing it may assume.
    //
    // SCALED BY THE BROKER'S OWN moneyDigits. cTrader sends money as an
    // integer scaled by 10^moneyDigits; comparing that raw integer against
    // the keeper's dollars disputed every record by exactly that factor.
    // When the scale could not be read, the sum is NOT converted at a guessed
    // rate — net_pnl is left out of the comparison and named in `uncompared`.
    if (fetch.moneyDigits) {
      v.brokerNetPnl = (gross + swap + commission) / std::pow(10.0, *fetch.moneyDigits);
    }
  }

  if (!v.sawClose) {
    v.state = State::Unverified;
    v.reason = "the position is still open at the broker (" +
               std::to_string(v.dealCount) + " deal(s), none closing)";
    return v;
  }
  if (!v.sawOpen) {
    // Real, and not a dispute: the opening deal is older than the window.
    v.state = State::Unverified;
    v.reason = "the opening deal is outside the requested window — widen it";
    return v;
  }

  compare(v.disputes, "symbol_id", rec.symbolId, v.brokerSymbolId, 0);
  compare(v.disputes, "trade_side", rec.tradeSide, v.brokerTradeSide, 0);
  if (v.brokerVolume) {
    compare(v.disputes, "volume", rec.volume, v.brokerVolume, tol.volume);
  } else {
    v.uncompared.push_back("volume");
  }
  compare(v.disputes, "entry_price", rec.entryPrice, v.brokerEntryPrice, tol.price);
  compare(v.disputes, "exit_price", rec.exitPrice, v.brokerExitPrice, tol.price);
  if (fetch.moneyDigits) {
    compare(v.disputes, "net_pnl", rec.netPnl, v.brokerNetPnl, tol.money);
  } else {
    v.uncompared.push_back("net_pnl");
  }
  compare(v.disputes, "opened_at_ms", rec.openedAtMs, v.brokerOpenedAtMs, tol.timeMs);
  compare(v.disputes, "closed_at_ms", rec.closedAtMs, v.brokerClosedAtMs, tol.timeMs);

  if (v.disputes.empty()) {
    // AGREEMENT ON WHAT WAS CHECKED IS NOT AGREEMENT. A field that went
    // uncompared cannot be signed off, so the verdict stays Unverified and
    // says which one — rather than reporting `verified` for a record whose
    // money nobody looked at.
    if (!v.uncompared.empty()) {
      v.state = State::Unverified;
      v.reason = "every compared field agrees, but not compared: ";
      for (size_t i = 0; i < v.uncompared.size(); ++i) {
        if (i) v.reason += ", ";
        v.reason += v.uncompared[i];
      }
      v.reason += " (the broker's money scale could not be read)";
      return v;
    }
    v.state = State::Verified;
    return v;
  }
  v.state = State::Disputed;
  v.reason = std::to_string(v.disputes.size()) + " field(s) disagree: ";
  for (size_t i = 0; i < v.disputes.size(); ++i) {
    if (i) v.reason += ", ";
    v.reason += v.disputes[i].field;
  }
  return v;
}

std::string verdictJson(const Verdict& v) {
  jsn::Value o{jsn::Object{}};
  o.set("state", std::string(stateName(v.state)));
  if (!v.reason.empty()) o.set("reason", v.reason);
  // The contract that produced this verdict travels WITH it, so the keeper
  // can tell a finding from a verdict its verifier has since outgrown.
  o.set("contractVersion", static_cast<double>(kVerdictContractVersion));
  o.set("dealCount", static_cast<double>(v.dealCount));
  o.set("sawOpen", v.sawOpen);
  o.set("sawClose", v.sawClose);
  if (!v.uncompared.empty()) {
    jsn::Array uc;
    for (const auto& f : v.uncompared) uc.push_back(jsn::Value{f});
    o.set("uncompared", jsn::Value{uc});
  }

  jsn::Array ds;
  for (const auto& d : v.disputes) {
    jsn::Value e{jsn::Object{}};
    e.set("field", d.field);
    e.set("keeper", d.keeper);
    e.set("broker", d.broker);
    e.set("delta", d.delta);
    ds.push_back(e);
  }
  o.set("disputes", jsn::Value(std::move(ds)));

  jsn::Value b{jsn::Object{}};
  if (v.brokerSymbolId) b.set("symbolId", static_cast<double>(*v.brokerSymbolId));
  if (v.brokerTradeSide) b.set("tradeSide", static_cast<double>(*v.brokerTradeSide));
  if (v.brokerVolume) b.set("volume", static_cast<double>(*v.brokerVolume));
  if (v.brokerVolumeUnits) b.set("volumeUnits", static_cast<double>(*v.brokerVolumeUnits));
  if (v.brokerEntryPrice) b.set("entryPrice", *v.brokerEntryPrice);
  if (v.brokerExitPrice) b.set("exitPrice", *v.brokerExitPrice);
  if (v.brokerNetPnl) b.set("netPnl", *v.brokerNetPnl);
  if (v.brokerOpenedAtMs) b.set("openedAtMs", static_cast<double>(*v.brokerOpenedAtMs));
  if (v.brokerClosedAtMs) b.set("closedAtMs", static_cast<double>(*v.brokerClosedAtMs));
  o.set("broker", b);

  return jsn::dump(o);
}

} // namespace verify
