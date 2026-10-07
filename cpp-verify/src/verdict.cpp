#include "verdict.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <set>
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

  // Codex · №11,920 · 2026-10-07; codex-footprint: executed-volume-contract.
  // Prove ONE closed lifecycle before publishing totals or findings. Sent
  // volume is not a fill; a mixed reversal closes one leg and opens another.
  std::sort(mine.begin(), mine.end(), [](const Deal* a, const Deal* b) {
    return a->executionTimestamp != b->executionTimestamp
      ? a->executionTimestamp < b->executionTimestamp : a->dealId < b->dealId;
  });
  long long openVol = 0, closeVol = 0;
  long long symbol = 0;
  int side = 0;
  bool fullyClosed = false;
  std::set<long long> ids;
  auto unsupported = [&](const std::string& reason) {
    v.state = State::Unverified;
    v.reason = reason;
    return v;
  };
  for (const Deal* d : mine) {
    if (d->dealId <= 0 || !ids.insert(d->dealId).second || d->symbolId <= 0
      || (d->tradeSide != 1 && d->tradeSide != 2) || d->executionTimestamp < 0
      || !std::isfinite(d->executionPrice) || d->executionPrice <= 0
      || !d->dealStatus || (*d->dealStatus != 2 && *d->dealStatus != 3)) {
      return unsupported("position deal identity, execution status or price unsupported");
    }
    if (fullyClosed) return unsupported("deals after the lifecycle closed");
    if (!d->filledVolume || *d->filledVolume <= 0 || *d->filledVolume > 9007199254740991LL) {
      return unsupported("actual filled volume unknown or outside exact numeric range");
    }
    if (d->hasClose) {
      v.sawClose = true; // observed closing detail, even if its opening is outside the window
      if (!d->closedVolume || *d->closedVolume <= 0 || *d->closedVolume != *d->filledVolume) {
        return unsupported("closing actual volume unsupported (mixed reversal or missing fill)");
      }
      if (!v.sawOpen) return unsupported("the opening deal is outside the requested window — widen it");
      if (d->symbolId != symbol || d->tradeSide == side) return unsupported("closing symbol or side contradicts opening");
      if (*d->closedVolume > openVol - closeVol) return unsupported("closing volume exceeds retained opening volume");
      closeVol += *d->closedVolume;
      fullyClosed = closeVol == openVol;
    } else {
      if (v.sawOpen && (d->symbolId != symbol || d->tradeSide != side)) {
        return unsupported("opening symbol or side changes within the lifecycle");
      }
      if (*d->filledVolume > 9007199254740991LL - openVol) {
        return unsupported("actual position volume overflow");
      }
      symbol = d->symbolId; side = d->tradeSide;
      v.sawOpen = true;
      openVol += *d->filledVolume;
    }
  }
  if (!v.sawClose || closeVol != openVol) {
    return unsupported("the position is still open at the broker (actual opened volume "
      + std::to_string(openVol) + ", closed volume " + std::to_string(closeVol) + ")");
  }

  double openNotional = 0, closeNotional = 0;
  double gross = 0, swap = 0, commission = 0;
  long long openedAt = std::numeric_limits<long long>::max(), closedAt = 0;
  bool moneyKnown = true;

  for (const Deal* d : mine) {
    moneyKnown = moneyKnown && d->commissionKnown && std::isfinite(d->commission);
    commission += d->commission;
    if (d->hasClose) {
      moneyKnown = moneyKnown && d->closingMoneyKnown && std::isfinite(d->grossProfit) && std::isfinite(d->swap);
      closeNotional += d->executionPrice * static_cast<double>(*d->closedVolume);
      gross += d->grossProfit;
      swap += d->swap;
      closedAt = std::max(closedAt, d->executionTimestamp);
    } else {
      openedAt = std::min(openedAt, d->executionTimestamp);
      openNotional += d->executionPrice * static_cast<double>(*d->filledVolume);
    }
  }
  if (!std::isfinite(openNotional) || !std::isfinite(closeNotional)) return unsupported("position price weighting overflow");
  moneyKnown = moneyKnown && std::isfinite(gross + swap + commission);
  const bool validMoneyScale = fetch.moneyDigits && *fetch.moneyDigits >= 0 && *fetch.moneyDigits <= 10;
  v.brokerSymbolId = symbol;
  v.brokerTradeSide = side;

  if (v.sawOpen && openVol > 0) {
    v.brokerEntryPrice = openNotional / static_cast<double>(openVol);
    // CENTS OF UNITS -> UNITS for the record, and -> LOTS for the comparison
    // through the symbol's own lotSize (contract 3). No lotSize, no lots:
    // a volume scaled by a guessed lot is the contract-2 defect again.
    v.brokerVolumeUnits = static_cast<double>(openVol) / kVolumeCentiUnits;
    if (rec.lotSize && std::isfinite(*rec.lotSize) && *rec.lotSize > 0) {
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
    if (validMoneyScale && moneyKnown) {
      v.brokerNetPnl = (gross + swap + commission) / std::pow(10.0, *fetch.moneyDigits);
    }
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
  if (v.brokerNetPnl) {
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
      v.reason += " (broker money scale/cost evidence or lot size unavailable)";
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
