// cpp-exec/src/spot_feed.cpp — see spot_feed.hpp.
#include "spot_feed.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <map>
#include <optional>
#include <thread>

#include "json.hpp"

using namespace std::chrono;

namespace {

// Protocol payload types — mirrors agent/lib/ctrader-ws.js (this protocol's
// source of truth) and engine.hpp's `pt` namespace. Duplicated (rather than
// including engine.hpp) so SpotFeed has no dependency on ExecEngine — it's a
// separate connection with a separate purpose (subscribe-only, never blocks
// on order/reconcile traffic).
constexpr int kHeartbeat = 51;
constexpr int kAppAuthReq = 2100;
constexpr int kAppAuthRes = 2101;
constexpr int kAccountAuthReq = 2102;
constexpr int kAccountAuthRes = 2103;
constexpr int kSubscribeSpotsReq = 2127;
constexpr int kSubscribeSpotsRes = 2128;
constexpr int kSpotEvent = 2131;
constexpr int kErrorRes = 2142;
constexpr double kPointsPerPrice = 100000.0;

void logLine(const std::string& msg) {
  std::fprintf(stderr, "[spot-feed] %s\n", msg.c_str());
}

// Sends `payload` under `reqType` and waits for `expectType`, treating a
// broker error frame or timeout as failure. Only used during the handshake
// (auth/subscribe) — the post-subscribe read loop has its own logic below.
std::optional<jsn::Value> sendAndWait(CtraderWs& ws, int reqType, const jsn::Value& payload,
                                      int expectType, int timeoutMs = 20000) {
  jsn::Value frame{jsn::Object{}};
  frame.set("payloadType", reqType);
  frame.set("payload", payload);
  if (!ws.sendText(jsn::dump(frame))) return std::nullopt;

  auto deadline = steady_clock::now() + milliseconds(timeoutMs);
  while (steady_clock::now() < deadline) {
    int remain = static_cast<int>(duration_cast<milliseconds>(deadline - steady_clock::now()).count());
    if (remain <= 0) break;
    auto text = ws.recvText(remain > 5000 ? 5000 : remain);
    if (!text) { if (!ws.isOpen()) return std::nullopt; continue; }
    auto msg = jsn::parse(*text);
    if (!msg || !msg->isObject()) continue;
    int type = static_cast<int>(msg->get("payloadType").asNumber(-1));
    if (type == kHeartbeat) continue;
    if (type == expectType) return msg->get("payload");
    if (type == kErrorRes) {
      const auto& p = msg->get("payload");
      logLine("broker error during handshake: " + p.get("errorCode").asString() +
              " " + p.get("description").asString());
      return std::nullopt;
    }
    // Anything else this early is unexpected but not fatal — keep waiting.
  }
  return std::nullopt;
}

} // namespace

SpotFeed::SpotFeed(std::string host, std::string clientId, std::string clientSecret,
                   std::string accessToken, long long accountId,
                   std::vector<long long> symbolIds, SpotTickCallback onTick)
    : host_(std::move(host)), clientId_(std::move(clientId)),
      clientSecret_(std::move(clientSecret)), accessToken_(std::move(accessToken)),
      accountId_(accountId), symbolIds_(std::move(symbolIds)), onTick_(std::move(onTick)) {}

void SpotFeed::stop() {
  stopped_.store(true);
  ws_.close();
}

bool SpotFeed::connectAuthSubscribe() {
  if (!ws_.connect(host_)) {
    logLine("connect failed: " + ws_.lastError());
    return false;
  }
  jsn::Value appAuth{jsn::Object{}};
  appAuth.set("clientId", clientId_);
  appAuth.set("clientSecret", clientSecret_);
  if (!sendAndWait(ws_, kAppAuthReq, appAuth, kAppAuthRes)) {
    logLine("app auth failed");
    ws_.close();
    return false;
  }
  jsn::Value acctAuth{jsn::Object{}};
  acctAuth.set("ctidTraderAccountId", accountId_);
  acctAuth.set("accessToken", accessToken_);
  if (!sendAndWait(ws_, kAccountAuthReq, acctAuth, kAccountAuthRes)) {
    logLine("account auth failed");
    ws_.close();
    return false;
  }
  jsn::Value sub{jsn::Object{}};
  sub.set("ctidTraderAccountId", accountId_);
  jsn::Array ids;
  for (long long id : symbolIds_) ids.push_back(jsn::Value(static_cast<double>(id)));
  sub.set("symbolId", jsn::Value(ids));
  if (!sendAndWait(ws_, kSubscribeSpotsReq, sub, kSubscribeSpotsRes)) {
    logLine("subscribe spots failed");
    ws_.close();
    return false;
  }
  logLine("subscribed to " + std::to_string(symbolIds_.size()) + " symbol(s) on " + host_);
  return true;
}

void SpotFeed::runOnce() {
  if (!connectAuthSubscribe()) return;

  // A SPOT_EVENT may carry only bid or only ask — the missing side is kept
  // at its last known value (mirrors wsStreamSpots' callers), and a side
  // that's NEVER been seen yet stays "unknown" rather than defaulting to 0,
  // which would otherwise read as a false touch (e.g. a Buy order's
  // `ask <= trigger` check is trivially true against an ask of 0).
  struct Quote { double bid = 0, ask = 0; bool haveBid = false, haveAsk = false; };
  std::map<long long, Quote> lastQuote;

  auto lastSend = steady_clock::now();
  while (!stopped_.load(std::memory_order_relaxed) && ws_.isOpen()) {
    auto text = ws_.recvText(5000);
    auto now = steady_clock::now();
    if (ws_.isOpen() && now - lastSend >= seconds(25)) {
      ws_.sendText("{\"payloadType\":51}");
      lastSend = now;
    }
    if (!text) continue; // idle timeout slice; loop re-checks isOpen()/stopped_
    auto msg = jsn::parse(*text);
    if (!msg || !msg->isObject()) continue;
    int type = static_cast<int>(msg->get("payloadType").asNumber(-1));
    if (type == kHeartbeat) continue;
    if (type == kErrorRes) {
      const auto& p = msg->get("payload");
      logLine("broker error: " + p.get("errorCode").asString() + " " + p.get("description").asString());
      break; // drop the connection; runLoop's backoff reconnects
    }
    if (type != kSpotEvent) continue;

    const auto& p = msg->get("payload");
    long long symbolId = static_cast<long long>(p.get("symbolId").asNumber(0));
    if (symbolId == 0) continue;
    Quote& q = lastQuote[symbolId];
    const jsn::Value& bidV = p.get("bid");
    const jsn::Value& askV = p.get("ask");
    if (bidV.isNumber()) { q.bid = bidV.asNumber(0) / kPointsPerPrice; q.haveBid = true; }
    if (askV.isNumber()) { q.ask = askV.asNumber(0) / kPointsPerPrice; q.haveAsk = true; }
    if (q.haveBid && q.haveAsk && onTick_) onTick_(symbolId, q.bid, q.ask);
  }
}

void SpotFeed::runLoop() {
  int backoffMs = 1000;
  constexpr int kBackoffCapMs = 60000;
  while (!stopped_.load(std::memory_order_relaxed)) {
    runOnce();
    ws_.close();
    if (stopped_.load(std::memory_order_relaxed)) break;
    logLine("disconnected, reconnecting in " + std::to_string(backoffMs) + "ms");
    std::this_thread::sleep_for(std::chrono::milliseconds(backoffMs));
    backoffMs = std::min(backoffMs * 2, kBackoffCapMs);
  }
}
