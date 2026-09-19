// cpp-verify/src/verify_session.cpp — see verify_session.hpp for why this
// class exists and why it implements only three broker messages.
#include "verify_session.hpp"
#include "log.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <set>

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

} // namespace

VerifySession::VerifySession(std::string host, std::string clientId,
                             std::string clientSecret, std::string accessToken)
    : host_(std::move(host)),
      clientId_(std::move(clientId)),
      clientSecret_(std::move(clientSecret)),
      accessToken_(std::move(accessToken)) {}

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
    int remain = static_cast<int>(duration_cast<milliseconds>(deadline - steady_clock::now()).count());
    if (remain <= 0) break;
    auto text = ws_.recvText(remain > 5000 ? 5000 : remain);
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
        if (md.isNumber()) moneyDigits_[accountId] = static_cast<int>(md.asNumber(2));
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
  auto it = moneyDigits_.find(accountId);
  if (it == moneyDigits_.end()) return std::nullopt;
  return it->second;
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
  // timestamp and the dealId set drops the overlap. Skipping is invisible;
  // duplicates are not.
  std::set<long long> seen;
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
      deal.tradeSide = static_cast<int>(asI64(d.get("tradeSide")));
      deal.executionPrice = asF64(d.get("executionPrice"));
      deal.executionTimestamp = asI64(d.get("executionTimestamp"));
      // COMMISSION IS A TOP-LEVEL DEAL FIELD and is charged on the opening
      // deal as well as the closing one. Reading it only out of
      // closePositionDetail — which also carries a commission — would drop
      // the entry side's charge and make every verified net P&L differ from
      // the broker's by exactly one leg's commission.
      deal.commission = asF64(d.get("commission"));

      const auto& close = d.get("closePositionDetail");
      if (close.isObject()) {
        deal.hasClose = true;
        deal.grossProfit = asF64(close.get("grossProfit"));
        deal.swap = asF64(close.get("swap"));
        deal.balance = asF64(close.get("balance"));
      }

      maxTs = std::max(maxTs, deal.executionTimestamp);
      if (seen.insert(deal.dealId).second) {
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
