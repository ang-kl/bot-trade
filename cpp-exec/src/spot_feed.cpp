// cpp-exec/src/spot_feed.cpp — see spot_feed.hpp.
#include "spot_feed.hpp"
#include "heartbeat.hpp"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <map>
#include <optional>
#include <thread>

#include "decision_ring.hpp"
#include "json.hpp"
#include "log.hpp"

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
// L2 depth — numbers verified against spotware/openapi-proto-messages'
// ProtoOAPayloadType enum (not present in ctrader-ws.js, which has no depth
// support yet; when Node grows depth these must stay in sync).
constexpr int kDepthEvent = 2155;
constexpr int kSubscribeDepthReq = 2156;
constexpr int kSubscribeDepthRes = 2157;
constexpr double kPointsPerPrice = 100000.0;

void logInfo(const std::string& msg) { sidecar_log::logInfo("[spot-feed]", msg); }
void logError(const std::string& msg) { sidecar_log::logError("[spot-feed]", msg); }

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
      logError("broker error during handshake: " + p.get("errorCode").asString() +
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
                   std::vector<long long> symbolIds, SpotTickCallback onTick,
                   bool depthEnabled)
    : host_(std::move(host)), accountId_(accountId),
      clientId_(std::move(clientId)), clientSecret_(std::move(clientSecret)),
      accessToken_(std::move(accessToken)),
      symbolIds_(std::move(symbolIds)), onTick_(std::move(onTick)),
      depthEnabled_(depthEnabled) {}

bool SpotFeed::updateCredentials(const std::string& clientId, const std::string& clientSecret,
                                 const std::string& accessToken) {
  std::lock_guard<std::mutex> lk(credsMtx_);
  // An EMPTY field is "not supplied", never "clear it". /connect validates
  // clientId and accessToken as required, but clientSecret is optional there,
  // and a blank arriving here must not silently un-authenticate the next
  // reconnect — that failure would surface minutes later as a feed that
  // cannot come back, with nothing pointing at this call.
  bool changed = false;
  if (!clientId.empty() && clientId != clientId_) { clientId_ = clientId; changed = true; }
  if (!clientSecret.empty() && clientSecret != clientSecret_) { clientSecret_ = clientSecret; changed = true; }
  if (!accessToken.empty() && accessToken != accessToken_) { accessToken_ = accessToken; changed = true; }
  return changed;
}

size_t SpotFeed::depthEntriesTotal() {
  std::lock_guard<std::mutex> lk(depthMtx_);
  size_t n = 0;
  for (const auto& [id, b] : books_) n += b.size();
  return n;
}

std::string SpotFeed::depthSnapshotJson(long long symbolId, int maxLevels) {
  std::lock_guard<std::mutex> lk(depthMtx_);
  auto it = books_.find(symbolId);
  if (it == books_.end() || it->second.empty()) return "null";
  return it->second.snapshotJson(maxLevels);
}

void SpotFeed::stop() {
  // Order matters. stopped_ first, so a feed thread that wakes for any other
  // reason sees the flag and exits rather than reconnecting; then the socket
  // half-close, which returns an in-flight recvText(); then the backoff CV,
  // in case the thread is between connections.
  //
  // Nothing here touches ssl_/ctx_/fd_ ownership — that is the whole point.
  // The feed thread performs its own ws_.close() when runLoop() unwinds.
  stopped_.store(true);
  ws_.wakeReader();
  {
    std::lock_guard<std::mutex> lk(stopMtx_);
  }
  stopCv_.notify_all();
}

void SpotFeed::ensureSymbols(const std::vector<long long>& ids) {
  std::lock_guard<std::mutex> lk(symMtx_);
  for (long long id : ids) {
    if (id <= 0) continue;
    bool known = false;
    for (long long s : symbolIds_) if (s == id) { known = true; break; }
    for (long long s : pendingSubs_) if (s == id) { known = true; break; }
    if (!known) pendingSubs_.push_back(id);
  }
}

// Feed thread only: fold queued ids into the subscription. Fire-and-forget
// sends — the 2128/2157 acks land in the read loop as ignored types, and a
// broker error frame drops the connection, whose reconnect re-subscribes
// the full (now larger) list.
void SpotFeed::drainPendingSubs() {
  std::vector<long long> add;
  {
    std::lock_guard<std::mutex> lk(symMtx_);
    if (pendingSubs_.empty()) return;
    add.swap(pendingSubs_);
    for (long long id : add) symbolIds_.push_back(id);
  }
  jsn::Array ids;
  for (long long id : add) ids.push_back(jsn::Value(static_cast<double>(id)));
  jsn::Value sub{jsn::Object{}};
  sub.set("ctidTraderAccountId", accountId_);
  sub.set("symbolId", jsn::Value(ids));
  jsn::Value frame{jsn::Object{}};
  frame.set("payloadType", kSubscribeSpotsReq);
  frame.set("payload", sub);
  ws_.sendText(jsn::dump(frame));
  if (depthEnabled_) {
    jsn::Value dframe{jsn::Object{}};
    dframe.set("payloadType", kSubscribeDepthReq);
    dframe.set("payload", sub);
    ws_.sendText(jsn::dump(dframe));
  }
  logInfo("subscribed " + std::to_string(add.size()) + " additional symbol(s)");
}

bool SpotFeed::connectAuthSubscribe() {
  // The loopback seam (tests only): plain TCP to the fake broker; main.cpp
  // never sets it, so production is always TLS to the pinned host.
  const bool up = loopbackPort_ > 0 ? ws_.connect("127.0.0.1", loopbackPort_, false) : ws_.connect(host_);
  if (!up) {
    logError("connect failed: " + ws_.lastError());
    return false;
  }
  jsn::Value appAuth{jsn::Object{}};
  // Snapshot under the lock: updateCredentials() may be writing these from
  // the HTTP thread while this runs on the feed thread.
  std::string useClientId, useClientSecret, useAccessToken;
  {
    std::lock_guard<std::mutex> lk(credsMtx_);
    useClientId = clientId_; useClientSecret = clientSecret_; useAccessToken = accessToken_;
  }
  appAuth.set("clientId", useClientId);
  appAuth.set("clientSecret", useClientSecret);
  if (!sendAndWait(ws_, kAppAuthReq, appAuth, kAppAuthRes)) {
    logError("app auth failed");
    ws_.close();
    return false;
  }
  jsn::Value acctAuth{jsn::Object{}};
  acctAuth.set("ctidTraderAccountId", accountId_);
  acctAuth.set("accessToken", useAccessToken);
  if (!sendAndWait(ws_, kAccountAuthReq, acctAuth, kAccountAuthRes)) {
    logError("account auth failed");
    ws_.close();
    return false;
  }
  // Fold any queued dynamic symbols in BEFORE subscribing, so a reconnect
  // covers everything the trail engine asked for while we were down.
  {
    std::lock_guard<std::mutex> lk(symMtx_);
    for (long long id : pendingSubs_) symbolIds_.push_back(id);
    pendingSubs_.clear();
  }
  if (!symbolIds_.empty()) {
    jsn::Value sub{jsn::Object{}};
    sub.set("ctidTraderAccountId", accountId_);
    jsn::Array ids;
    for (long long id : symbolIds_) ids.push_back(jsn::Value(static_cast<double>(id)));
    sub.set("symbolId", jsn::Value(ids));
    if (!sendAndWait(ws_, kSubscribeSpotsReq, sub, kSubscribeSpotsRes)) {
      logError("subscribe spots failed");
      ws_.close();
      return false;
    }
    logInfo("subscribed to " + std::to_string(symbolIds_.size()) + " symbol(s) on " + host_);
  } else {
    logInfo("no symbols yet — feed idles until ensureSymbols() delivers some");
  }

  // L2 depth is best-effort on top of a healthy spot subscription: broker
  // support per symbol/account is not documented, so a rejection here is
  // logged and the feed carries on spots-only rather than dropping the
  // connection. Quote ids are per-subscription — clear any book state left
  // from a previous connection before new events arrive.
  depthActive_.store(false, std::memory_order_relaxed);
  if (depthEnabled_ && !symbolIds_.empty()) {
    {
      std::lock_guard<std::mutex> lk(depthMtx_);
      books_.clear();
    }
    jsn::Value dsub{jsn::Object{}};
    dsub.set("ctidTraderAccountId", accountId_);
    jsn::Array dids;
    for (long long id : symbolIds_) dids.push_back(jsn::Value(static_cast<double>(id)));
    dsub.set("symbolId", jsn::Value(dids));
    if (sendAndWait(ws_, kSubscribeDepthReq, dsub, kSubscribeDepthRes)) {
      depthActive_.store(true, std::memory_order_relaxed);
      logInfo("depth subscribed for " + std::to_string(symbolIds_.size()) + " symbol(s)");
    } else if (ws_.isOpen()) {
      logError("depth subscribe rejected — continuing spots-only");
    } else {
      logError("connection dropped during depth subscribe");
      return false;
    }
  }
  return true;
}

void SpotFeed::runOnce() {
  if (!connectAuthSubscribe()) return;
  connected_.store(true, std::memory_order_relaxed);
  if (ring_) ring_->log("spot_feed", "connected", accountId_, 0, "",
                        std::to_string(symbolIds_.size()) + " symbol(s)");

  // A SPOT_EVENT may carry only bid or only ask — the missing side is kept
  // at its last known value (mirrors wsStreamSpots' callers), and a side
  // that's NEVER been seen yet stays "unknown" rather than defaulting to 0,
  // which would otherwise read as a false touch (e.g. a Buy order's
  // `ask <= trigger` check is trivially true against an ask of 0).
  struct Quote { double bid = 0, ask = 0; bool haveBid = false, haveAsk = false; };
  std::map<long long, Quote> lastQuote;

  auto lastSend = steady_clock::now();
  while (!stopped_.load(std::memory_order_relaxed) && ws_.isOpen()) {
    drainPendingSubs(); // trail-engine symbols queued since the last slice
    // One-second slices (heartbeat.hpp): the heartbeat check below runs at
    // least once a second, so an idle socket is pinged within a second of
    // the bound — the 5 s slice this used to be put the effective bound at
    // 9–14 s (11-09-2026 audit), past the 10 s guidance.
    auto text = ws_.recvText(kHeartbeatSliceMs);
    auto now = steady_clock::now();
    if (ws_.isOpen() && now - lastSend >= milliseconds(heartbeatIdleMs_.load(std::memory_order_relaxed))) {
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
      logError("broker error: " + p.get("errorCode").asString() + " " + p.get("description").asString());
      break; // drop the connection; runLoop's backoff reconnects
    }
    if (type == kDepthEvent) {
      const auto& p = msg->get("payload");
      long long symbolId = static_cast<long long>(p.get("symbolId").asNumber(0));
      if (symbolId != 0) {
        const long long nowMs = duration_cast<milliseconds>(
            system_clock::now().time_since_epoch()).count();
        std::lock_guard<std::mutex> lk(depthMtx_);
        books_[symbolId].applyEvent(p, nowMs);
      }
      continue;
    }
    if (type != kSpotEvent) continue;

    const auto& p = msg->get("payload");
    long long symbolId = static_cast<long long>(p.get("symbolId").asNumber(0));
    if (symbolId == 0) continue;
    // P3a: the recorder sees the frame as it came — which sides it carried,
    // in wire units — before the last-known carry below.
    if (rawTap_) {
      const jsn::Value& rb = p.get("bid");
      const jsn::Value& ra = p.get("ask");
      rawTap_(symbolId, rb.isNumber(), static_cast<long long>(rb.asNumber(0)),
              ra.isNumber(), static_cast<long long>(ra.asNumber(0)),
              reconnects_.load(std::memory_order_relaxed) + 1);
    }
    Quote& q = lastQuote[symbolId];
    const jsn::Value& bidV = p.get("bid");
    const jsn::Value& askV = p.get("ask");
    if (bidV.isNumber()) { q.bid = bidV.asNumber(0) / kPointsPerPrice; q.haveBid = true; }
    if (askV.isNumber()) { q.ask = askV.asNumber(0) / kPointsPerPrice; q.haveAsk = true; }
    // Feed truth: two relaxed stores + one short-held map write per tick —
    // and, under the same lock, the latest-quote table GET /quotes serves
    // (the carried bid/ask, the event's timestamp when it has one, the
    // local receipt time). One map slot per symbol: no allocation once a
    // symbol has been seen.
    {
      const long long tickMs = duration_cast<milliseconds>(
          system_clock::now().time_since_epoch()).count();
      lastTickAtMs_.store(tickMs, std::memory_order_relaxed);
      tickCount_.fetch_add(1, std::memory_order_relaxed);
      const jsn::Value& tsV = p.get("timestamp");
      std::lock_guard<std::mutex> lk(tickMtx_);
      lastTickBySymbol_[symbolId] = tickMs;
      SpotQuote& lq = latestQuotes_[symbolId];
      lq.symbolId = symbolId;
      lq.bid = q.bid;
      lq.ask = q.ask;
      lq.tsMs = tsV.isNumber() && tsV.asNumber(0) > 0 ? static_cast<long long>(tsV.asNumber(0)) : tickMs;
      lq.recvMs = tickMs;
    }
    if (q.haveBid && q.haveAsk && onTick_) onTick_(symbolId, q.bid, q.ask);
  }
}

std::vector<long long> SpotFeed::subscribedSymbols() {
  std::lock_guard<std::mutex> lk(symMtx_);
  std::vector<long long> out = symbolIds_;
  out.insert(out.end(), pendingSubs_.begin(), pendingSubs_.end());
  return out;
}

std::vector<std::pair<long long, long long>> SpotFeed::lastTickBySymbol() {
  std::lock_guard<std::mutex> lk(tickMtx_);
  return { lastTickBySymbol_.begin(), lastTickBySymbol_.end() };
}

std::vector<SpotQuote> SpotFeed::latestQuotes() {
  std::lock_guard<std::mutex> lk(tickMtx_);
  std::vector<SpotQuote> out;
  out.reserve(latestQuotes_.size());
  for (const auto& [id, q] : latestQuotes_) out.push_back(q);
  return out;
}

void SpotFeed::runLoop() {
  int backoffMs = 1000;
  constexpr int kBackoffCapMs = 60000;
  while (!stopped_.load(std::memory_order_relaxed)) {
    const auto startedAt = steady_clock::now();
    runOnce();
    if (connected_.load(std::memory_order_relaxed)) {
      connected_.store(false, std::memory_order_relaxed);
      reconnects_.fetch_add(1, std::memory_order_relaxed);
      if (ring_ && !stopped_.load(std::memory_order_relaxed))
        ring_->log("spot_feed", "dropped", accountId_);
    }
    ws_.close();
    // A session that survived well past the handshake proves the path is
    // healthy — reset the ladder so the NEXT unrelated drop reconnects in 1s,
    // not the 60s cap accumulated over a day of routine drops (audit #8:
    // every capped reconnect is a minute with no tick-level SL ratchet).
    if (steady_clock::now() - startedAt >= seconds(60)) backoffMs = 1000;
    if (stopped_.load(std::memory_order_relaxed)) break;
    logError("disconnected, reconnecting in " + std::to_string(backoffMs) + "ms");
    {
      // Interruptible: stop() must not have to wait out a 60s backoff while
      // /connect's join() holds up every other request (audit C2).
      std::unique_lock<std::mutex> lk(stopMtx_);
      stopCv_.wait_for(lk, milliseconds(backoffMs),
                       [this] { return stopped_.load(std::memory_order_relaxed); });
    }
    if (stopped_.load(std::memory_order_relaxed)) break;
    backoffMs = std::min(backoffMs * 2, kBackoffCapMs);
  }
}
