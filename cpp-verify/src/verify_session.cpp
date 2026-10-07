// cpp-verify/src/verify_session.cpp — see verify_session.hpp for why this
// class exists and why it implements only three broker messages.
#include "verify_session.hpp"
#include "log.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <set>
#include <cmath>

using std::chrono::steady_clock;
using std::chrono::milliseconds;
using std::chrono::duration_cast;

namespace verify {
namespace {

// Payload types. Duplicated from cpp-exec rather than included, for the same
// reason spot_feed.cpp duplicates them: this binary must not link the engine.
constexpr int kHeartbeat = 51;
constexpr int kAppAuthReq = 2100;
constexpr int kAppAuthRes = 2101;
constexpr int kAccountAuthReq = 2102;
constexpr int kAccountAuthRes = 2103;
constexpr int kTraderReq = 2121;
constexpr int kTraderRes = 2122;
constexpr int kDealListReq = 2133;
constexpr int kDealListRes = 2134;
constexpr int kErrorRes = 2142;
constexpr int kReconcileReq = 2124;
constexpr int kReconcileRes = 2125;

// cTrader caps a DealList response; 1000 is the documented maximum and the
// page walk below does not depend on the number being right.
constexpr int kMaxRowsPerPage = 1000;
// A walk that needs more pages than this is not a walk, it is a loop. The
// fetch stops and reports INCOMPLETE rather than returning a partial set that
// looks whole.
constexpr int kMaxPages = 500;

void logError(const std::string& msg) { sidecar_log::logError("[verify]", msg); }

// cTrader's JSON bridge sends some int64 fields as strings and some as
// numbers, depending on the field and the gateway build. Reading only one
// shape would silently yield 0 — and a 0 that came from a parse miss is
// indistinguishable, downstream, from a broker-reported 0. Both shapes are
// read here so that never happens.
long long asI64(const jsn::Value& v) {
  if (v.isNumber()) return static_cast<long long>(v.asNumber(0));
  if (v.isString()) {
    try { return std::stoll(v.asString()); } catch (...) { return 0; }
  }
  return 0;
}

double asF64(const jsn::Value& v) {
  if (v.isNumber()) return v.asNumber(0);
  if (v.isString()) {
    try { return std::stod(v.asString()); } catch (...) { return 0; }
  }
  return 0;
}

// Codex · №11,920 · 2026-10-07; codex-footprint: executed-volume-contract.
// Do not truncate fractions or accept stoll's numeric-prefix parsing. Numeric
// JSON is a double, so only its exact safe-integer range is authoritative.
std::optional<long long> strictInteger(const jsn::Value& v) {
  if (v.isNumber()) {
    const double n = v.asNumber();
    if (std::isfinite(n) && std::floor(n) == n && std::fabs(n) <= 9007199254740991.0) {
      return static_cast<long long>(n);
    }
  } else if (v.isString()) {
    const auto& text = v.asString();
    size_t first = !text.empty() && text[0] == '-' ? 1 : 0;
    if (first == text.size() || !std::all_of(text.begin() + first, text.end(), [](char c) { return c >= '0' && c <= '9'; })) {
      return std::nullopt;
    }
    try {
      const auto n = std::stoll(text);
      if (n >= -9007199254740991LL && n <= 9007199254740991LL) return n;
    } catch (...) { }
  }
  return std::nullopt;
}

std::optional<int> actualDealStatus(const jsn::Value& v) {
  if (auto n = strictInteger(v); n && *n >= 1 && *n <= 7) return static_cast<int>(*n);
  if (v.isString()) {
    const auto& text = v.asString();
    if (text == "FILLED") return 2;
    if (text == "PARTIALLY_FILLED") return 3;
    if (text == "REJECTED") return 4;
    if (text == "INTERNALLY_REJECTED") return 5;
    if (text == "ERROR") return 6;
    if (text == "MISSED") return 7;
  }
  return std::nullopt;
}

int actualTradeSide(const jsn::Value& v) {
  if (auto n = strictInteger(v); n && (*n == 1 || *n == 2)) return static_cast<int>(*n);
  if (v.isString()) return v.asString() == "BUY" ? 1 : v.asString() == "SELL" ? 2 : 0;
  return 0;
}

// Codex · №11,920 · 2026-10-07; codex-footprint: executed-volume-contract.
// Inclusive pages may repeat an identical deal. A changed same-ID receipt
// may be a legitimate live transition, but this walk is then inconsistent;
// choosing the first copy would certify a quantity the later page contradicts.
bool sameDealReceipt(const Deal& a, const Deal& b) {
  return a.positionId == b.positionId && a.symbolId == b.symbolId
    && a.volume == b.volume && a.filledVolume == b.filledVolume
    && a.closedVolume == b.closedVolume && a.dealStatus == b.dealStatus
    && a.tradeSide == b.tradeSide && a.executionPrice == b.executionPrice
    && a.executionTimestamp == b.executionTimestamp && a.hasClose == b.hasClose
    && a.commissionKnown == b.commissionKnown && a.commission == b.commission
    && a.closingMoneyKnown == b.closingMoneyKnown
    && a.grossProfit == b.grossProfit && a.swap == b.swap;
}

// 02-10-2026 stop-loss policy read-back: ProtoOAOrderTriggerMethod arrives as a
// number 1..4 (or an enum name). Absent or malformed is null, never an error
// and never "false": ProtoOAPosition.trailingStopLoss has had a read-back bug
// where an enabled trailing stop reads absent, so absence is "unknown".
jsn::Value triggerMethodOrNull(const jsn::Value& v) {
  int n = 0;
  if (v.isNumber()) {
    const double d = v.asNumber(0);
    if (std::isfinite(d) && std::floor(d) == d && d >= 1 && d <= 4) n = static_cast<int>(d);
  } else if (v.isString()) {
    const auto& t = v.asString();
    n = t == "TRADE" ? 1 : t == "OPPOSITE" ? 2 : t == "DOUBLE_TRADE" ? 3 : t == "DOUBLE_OPPOSITE" ? 4 : 0;
  }
  return n > 0 ? jsn::Value(n) : jsn::Value();
}

} // namespace

VerifySession::VerifySession(std::string host, std::string clientId,
                             std::string clientSecret, std::string accessToken)
    : host_(std::move(host)),
      clientId_(std::move(clientId)),
      clientSecret_(std::move(clientSecret)),
      accessToken_(std::move(accessToken)) {}

VerifySession::~VerifySession() {
  idleThread_.request_stop();
  if (idleThread_.joinable()) idleThread_.join();
}

bool VerifySession::heartbeatIfDue() {
  if (!appAuthed_ || !ws_.isOpen()) return true;
  const auto now = steady_clock::now();
  if (now - lastHeartbeat_ < milliseconds(heartbeatMs_)) return true;
  jsn::Value frame{jsn::Object{}};
  frame.set("payloadType", kHeartbeat);
  frame.set("payload", jsn::Value{jsn::Object{}});
  if (!ws_.sendText(jsn::dump(frame))) {
    lastError_ = "heartbeat failed: " + ws_.lastError();
    ws_.close();
    appAuthed_ = false;
    return false;
  }
  lastHeartbeat_ = now;
  return true;
}

void VerifySession::idleLoop(std::stop_token stop) {
  while (!stop.stop_requested()) {
    std::this_thread::sleep_for(milliseconds(25));
    std::unique_lock<std::mutex> lk(mtx_, std::try_to_lock);
    if (!lk.owns_lock() || !appAuthed_ || !ws_.isOpen()) continue;
    if (!heartbeatIfDue()) continue;
    // No request can be in flight while we own mtx_. Drain unsolicited
    // heartbeats and detect disconnects without racing a request's reader.
    ws_.recvText(1);
  }
}

std::optional<jsn::Value> VerifySession::sendAndWait(int reqType, const jsn::Value& payload,
                                                     int expectType, int timeoutMs) {
  jsn::Value frame{jsn::Object{}};
  frame.set("payloadType", reqType);
  frame.set("payload", payload);
  if (!ws_.sendText(jsn::dump(frame))) {
    lastError_ = "send failed: " + ws_.lastError();
    return std::nullopt;
  }

  auto deadline = steady_clock::now() + milliseconds(timeoutMs);
  while (steady_clock::now() < deadline) {
    if (!heartbeatIfDue()) return std::nullopt;
    int remain = static_cast<int>(duration_cast<milliseconds>(deadline - steady_clock::now()).count());
    if (remain <= 0) break;
    const int slice = appAuthed_ ? std::min(1000, heartbeatMs_) : 1000;
    auto text = ws_.recvText(std::min(remain, slice));
    if (!text) {
      if (!ws_.isOpen()) { lastError_ = "connection closed: " + ws_.lastError(); return std::nullopt; }
      continue;
    }
    auto msg = jsn::parse(*text);
    if (!msg || !msg->isObject()) continue;
    int type = static_cast<int>(msg->get("payloadType").asNumber(-1));
    if (type == kHeartbeat) continue;
    if (type == expectType) return msg->get("payload");
    if (type == kErrorRes) {
      const auto& p = msg->get("payload");
      lastError_ = "broker error " + p.get("errorCode").asString() + " " +
                   p.get("description").asString();
      return std::nullopt;
    }
    // Anything else is unsolicited on a read-only session — ignore and keep
    // waiting for the reply we asked for.
  }
  lastError_ = "timeout waiting for payloadType " + std::to_string(expectType);
  return std::nullopt;
}

bool VerifySession::connect(long long accountId) {
  std::lock_guard<std::mutex> lk(mtx_);
  if (!ws_.isOpen()) {
    appAuthed_ = false;
    bool ok = loopbackPort_ > 0 ? ws_.connect("127.0.0.1", loopbackPort_, false)
                                : ws_.connect(host_, 5036, true);
    if (!ok) { lastError_ = "connect failed: " + ws_.lastError(); return false; }

    jsn::Value appAuth{jsn::Object{}};
    appAuth.set("clientId", clientId_);
    appAuth.set("clientSecret", clientSecret_);
    if (!sendAndWait(kAppAuthReq, appAuth, kAppAuthRes, 20000)) {
      logError(host_ + ": app auth failed — " + lastError_);
      ws_.close();
      return false;
    }
    appAuthed_ = true;
    lastHeartbeat_ = steady_clock::now();
    if (!idleThread_.joinable()) {
      idleThread_ = std::jthread([this](std::stop_token stop) { idleLoop(stop); });
    }
  }

  jsn::Value acctAuth{jsn::Object{}};
  acctAuth.set("ctidTraderAccountId", static_cast<double>(accountId));
  acctAuth.set("accessToken", accessToken_);
  if (!sendAndWait(kAccountAuthReq, acctAuth, kAccountAuthRes, 20000)) {
    logError(host_ + ": account auth failed for " + std::to_string(accountId) +
            " — " + lastError_);
    // The socket stays open: another account on this host may still
    // authorize, and tearing the app-auth down would cost a reconnect.
    return false;
  }
  // THE MONEY SCALE, asked of the BROKER — not of the keeper, and not
  // assumed. A verifier that took the scale from the record it is checking
  // would be checking that record against itself; a verifier that hardcoded
  // one would be making the very assumption that produced ten false disputes
  // on 18-09-2026. Failing this read is not fatal: money is simply not
  // compared, and the verdict says which field went unchecked.
  {
    jsn::Value tReq{jsn::Object{}};
    tReq.set("ctidTraderAccountId", static_cast<double>(accountId));
    auto res = sendAndWait(kTraderReq, tReq, kTraderRes, 20000);
    if (res) {
      const jsn::Value& tr = res->get("trader");
      if (tr.isObject()) {
        const jsn::Value& md = tr.get("moneyDigits");
        if (auto n = strictInteger(md); n && *n >= 0 && *n <= 10) moneyDigits_[accountId] = static_cast<int>(*n);
      }
    }
    if (moneyDigits_.find(accountId) == moneyDigits_.end()) {
      logError(host_ + ": moneyDigits unreadable for " + std::to_string(accountId) +
              " — money will NOT be compared for this account");
    }
  }

  lastError_.clear();
  return true;
}

std::optional<int> VerifySession::moneyDigits(long long accountId) const {
  std::lock_guard<std::mutex> lk(mtx_);
  auto it = moneyDigits_.find(accountId);
  if (it == moneyDigits_.end()) return std::nullopt;
  return it->second;
}

jsn::Value VerifySession::protection(long long accountId) {
  std::lock_guard<std::mutex> lk(mtx_);
  jsn::Value out{jsn::Object{}};
  out.set("accountId", std::to_string(accountId));
  out.set("host", host_);
  out.set("ok", false);
  auto fail = [&](const std::string& error) {
    out.set("error", error);
    return out;
  };
  if (!ws_.isOpen()) return fail("not connected");
  jsn::Value req{jsn::Object{}};
  req.set("ctidTraderAccountId", static_cast<double>(accountId));
  auto res = sendAndWait(kReconcileReq, req, kReconcileRes, 10000);
  if (!res) {
    // A late reconcile reply must not satisfy the next account's request.
    if (lastError_.starts_with("timeout")) ws_.close();
    return fail(lastError_);
  }
  if (asI64(res->get("ctidTraderAccountId")) != accountId) return fail("broker account identity mismatch");
  const auto& positions = res->get("position");
  if (!positions.isNull() && !positions.isArray()) return fail("malformed broker positions");
  jsn::Array rows;
  std::set<long long> seen;
  int missingSl = 0, missingTp = 0;
  for (const auto& p : positions.asArray()) {
    const auto id = asI64(p.get("positionId"));
    if (id <= 0 || !seen.insert(id).second) return fail("invalid or duplicate broker position identity");
    const double sl = asF64(p.get("stopLoss")), tp = asF64(p.get("takeProfit"));
    const bool hasSl = std::isfinite(sl) && sl > 0, hasTp = std::isfinite(tp) && tp > 0;
    if (!hasSl) ++missingSl;
    if (!hasTp) ++missingTp;
    jsn::Value row{jsn::Object{}};
    row.set("positionId", std::to_string(id));
    row.set("symbolId", std::to_string(asI64(p.get("tradeData").get("symbolId"))));
    row.set("stopLoss", hasSl ? jsn::Value(sl) : jsn::Value());
    row.set("takeProfit", hasTp ? jsn::Value(tp) : jsn::Value());
    row.set("stopLossTriggerMethod", triggerMethodOrNull(p.get("stopLossTriggerMethod")));
    row.set("trailingStopLoss", p.get("trailingStopLoss").isBool() ? p.get("trailingStopLoss") : jsn::Value());
    rows.push_back(std::move(row));
  }
  out.set("ok", true);
  out.set("source", std::string("broker_reconcile"));
  out.set("positions", jsn::Value(std::move(rows)));
  out.set("openCount", static_cast<double>(seen.size()));
  out.set("missingSl", missingSl);
  out.set("missingTp", missingTp);
  return out;
}

DealFetch VerifySession::deals(long long accountId, long long fromMs, long long toMs) {
  DealFetch out;
  if (toMs <= fromMs) {
    out.error = "empty window";
    return out;
  }

  std::lock_guard<std::mutex> lk(mtx_);
  if (!ws_.isOpen()) {
    out.error = "not connected";
    return out;
  }

  // THE WALK. cTrader's DealList has no cursor token: a page is bounded by
  // timestamps, and `hasMore` says another page exists. Advancing the cursor
  // to lastExecutionTimestamp + 1 would SKIP every deal sharing that
  // millisecond with the last one on the page — so the cursor lands ON that
  // timestamp and the dealId map drops IDENTICAL overlap. Contradicting
  // duplicate receipts make the entire walk incomplete instead of choosing
  // whichever version arrived first.
  std::map<long long, size_t> seen;
  long long cursor = fromMs;

  for (int page = 0; page < kMaxPages; ++page) {
    jsn::Value req{jsn::Object{}};
    req.set("ctidTraderAccountId", static_cast<double>(accountId));
    req.set("fromTimestamp", static_cast<double>(cursor));
    req.set("toTimestamp", static_cast<double>(toMs));
    req.set("maxRows", static_cast<double>(kMaxRowsPerPage));

    auto res = sendAndWait(kDealListReq, req, kDealListRes, 30000);
    if (!res) {
      out.error = lastError_;
      return out;                      // ok=false, complete=false: UNKNOWN
    }
    out.pages = page + 1;

    const auto& rows = res->get("deal").asArray();
    long long maxTs = cursor;
    int added = 0;
    for (const auto& d : rows) {
      Deal deal;
      deal.dealId = asI64(d.get("dealId"));
      deal.positionId = asI64(d.get("positionId"));
      deal.symbolId = asI64(d.get("symbolId"));
      deal.volume = asI64(d.get("volume"));
      deal.filledVolume = strictInteger(d.get("filledVolume"));
      deal.dealStatus = actualDealStatus(d.get("dealStatus"));
      deal.tradeSide = actualTradeSide(d.get("tradeSide"));
      deal.executionPrice = asF64(d.get("executionPrice"));
      deal.executionTimestamp = asI64(d.get("executionTimestamp"));
      // COMMISSION IS A TOP-LEVEL DEAL FIELD and is charged on the opening
      // deal as well as the closing one. Reading it only out of
      // closePositionDetail — which also carries a commission — would drop
      // the entry side's charge and make every verified net P&L differ from
      // the broker's by exactly one leg's commission.
      const auto commission = strictInteger(d.get("commission"));
      deal.commissionKnown = commission.has_value();
      if (commission) deal.commission = static_cast<double>(*commission);

      const auto& close = d.get("closePositionDetail");
      deal.hasClose = !close.isNull();
      if (close.isObject()) {
        deal.closedVolume = strictInteger(close.get("closedVolume"));
        const auto gross = strictInteger(close.get("grossProfit"));
        const auto swap = strictInteger(close.get("swap"));
        deal.closingMoneyKnown = gross.has_value() && swap.has_value();
        if (gross) deal.grossProfit = static_cast<double>(*gross);
        if (swap) deal.swap = static_cast<double>(*swap);
        deal.balance = asF64(close.get("balance"));
      }

      maxTs = std::max(maxTs, deal.executionTimestamp);
      const auto prior = seen.find(deal.dealId);
      if (prior != seen.end()) {
        if (!sameDealReceipt(out.deals[prior->second], deal)) {
          out.error = "conflicting duplicate deal " + std::to_string(deal.dealId);
          return out; // ok/complete remain false; no money or volume verdict
        }
      } else {
        seen.emplace(deal.dealId, out.deals.size());
        out.deals.push_back(deal);
        ++added;
      }
    }

    bool hasMore = res->get("hasMore").asBool(false);
    if (!hasMore) {
      out.ok = true;
      out.complete = true;             // the ONLY path that sets complete
      lastError_.clear();
      break;
    }
    if (maxTs <= cursor || added == 0) {
      // hasMore is true but the window did not advance and nothing new
      // arrived. Continuing would page forever on the same rows; reporting
      // what we have as complete would be a lie. Neither.
      out.error = "paging stalled at " + std::to_string(cursor) +
                  " with hasMore set (" + std::to_string(out.deals.size()) + " deals so far)";
      return out;
    }
    cursor = maxTs;
  }

  if (!out.complete && out.error.empty()) {
    out.error = "page limit " + std::to_string(kMaxPages) + " reached before hasMore cleared";
  }
  std::sort(out.deals.begin(), out.deals.end(), [](const Deal& a, const Deal& b) {
    return a.executionTimestamp != b.executionTimestamp
               ? a.executionTimestamp < b.executionTimestamp
               : a.dealId < b.dealId;
  });
  return out;
}

} // namespace verify
