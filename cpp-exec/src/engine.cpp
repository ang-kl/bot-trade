// cpp-exec/src/engine.cpp
#include "engine.hpp"

#include <cstdio>
#include <thread>

using namespace std::chrono;

static long long nowMs() {
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

static void logLine(const std::string& msg) {
  std::fprintf(stderr, "[cpp-exec] %s\n", msg.c_str());
}

// Maps a guard/transport reason to a small stable int for the binary
// telemetry record (TelemetryRecord.reason_code is a fixed-width field, not a
// string) — matched by prefix against the machine codes order_guard.cpp and
// this file's own errResult() calls actually produce. Unrecognised strings
// (any live broker errorCode, e.g. "TRADING_BAD_VOLUME") fall through to 0;
// the raw string still reaches the Node keeper's error/reasoning path, this
// is only a coarse bucket for the offline binary log.
static int32_t classifyReasonCode(const std::string& reason) {
  static const struct { const char* prefix; int32_t code; } kCodes[] = {
    { "guard_halt", 1 },
    { "guard_bad_payload", 2 },
    { "guard_naked_order", 3 },
    { "guard_no_target", 4 },
    { "guard_volume_cap", 5 },
    { "NOT_CONNECTED", 6 },
    { "SEND_FAILED", 7 },
    { "DISCONNECTED", 8 },
    { "TIMEOUT", 9 },
  };
  for (const auto& c : kCodes) {
    if (reason.rfind(c.prefix, 0) == 0) return c.code;
  }
  return 0;
}

static EngineResult errResult(const std::string& code, const std::string& desc,
                              bool brokerError) {
  jsn::Value body{jsn::Object{}};
  body.set("errorCode", code);
  body.set("description", desc);
  EngineResult r;
  r.ok = false;
  r.body = body;
  r.brokerError = brokerError;
  return r;
}

ExecEngine::ExecEngine(std::string host, std::string clientId,
                       std::string clientSecret, std::string accessToken,
                       long long accountId)
    : host_(std::move(host)),
      clientId_(std::move(clientId)),
      clientSecret_(std::move(clientSecret)),
      accessToken_(std::move(accessToken)),
      accountIds_{accountId} {}

void ExecEngine::setCredentials(std::string host, std::string clientId,
                                std::string clientSecret,
                                std::string accessToken, long long accountId,
                                std::vector<long long> extraAccountIds) {
  std::lock_guard lk(mtx_);
  const bool sameSession = host == host_ && clientId == clientId_ &&
                           accessToken == accessToken_ && authed_;
  if (sameSession) {
    // M2: same host+app+token — the live session stays up. Auth any account
    // ids we haven't authorized yet, incrementally, without disturbing the
    // accounts already trading on this connection.
    std::vector<long long> wanted{accountId};
    for (long long id : extraAccountIds) wanted.push_back(id);
    for (long long id : wanted) {
      if (id <= 0) continue;
      bool known = false;
      for (long long have : accountIds_) if (have == id) { known = true; break; }
      if (known) continue;
      EngineResult r = authAccountLocked(id);
      if (r.ok) {
        accountIds_.push_back(id);
        logLine("account " + std::to_string(id) + " authorized on existing session");
      } else {
        logLine("account " + std::to_string(id) + " auth FAILED on existing session: " + jsn::dump(r.body));
      }
    }
    return;
  }
  host_ = std::move(host);
  clientId_ = std::move(clientId);
  clientSecret_ = std::move(clientSecret);
  accessToken_ = std::move(accessToken);
  accountIds_.clear();
  if (accountId > 0) accountIds_.push_back(accountId);
  for (long long id : extraAccountIds) {
    if (id <= 0) continue;
    bool dup = false;
    for (long long have : accountIds_) if (have == id) { dup = true; break; }
    if (!dup) accountIds_.push_back(id);
  }
  // Force a clean reconnect+reauth on the next runLoop pass — the old
  // session (if any) may be authed against a different account/token.
  ws_.close();
  authed_ = false;
}

bool ExecEngine::hasCredentials() {
  std::lock_guard lk(mtx_);
  return !clientId_.empty() && !accessToken_.empty() && primaryAccountLocked() > 0;
}

std::vector<long long> ExecEngine::accountIds() {
  std::lock_guard lk(mtx_);
  return accountIds_;
}

bool ExecEngine::isConnected() {
  std::lock_guard lk(mtx_);
  return ws_.isOpen() && authed_;
}

std::string ExecEngine::lastReconcileJson() {
  long long primary;
  { std::lock_guard lk(mtx_); primary = primaryAccountLocked(); }
  return lastReconcileJson(primary);
}

long long ExecEngine::lastReconcileAtMs() {
  long long primary;
  { std::lock_guard lk(mtx_); primary = primaryAccountLocked(); }
  return lastReconcileAtMs(primary);
}

std::string ExecEngine::lastReconcileJson(long long accountId) {
  std::lock_guard lk(stateMtx_);
  auto it = reconcileByAccount_.find(accountId);
  return it == reconcileByAccount_.end() ? "" : it->second.json;
}

long long ExecEngine::lastReconcileAtMs(long long accountId) {
  std::lock_guard lk(stateMtx_);
  auto it = reconcileByAccount_.find(accountId);
  return it == reconcileByAccount_.end() ? 0 : it->second.atMs;
}

void ExecEngine::handleUnsolicited(const jsn::Value& msg) {
  int type = static_cast<int>(msg.get("payloadType").asNumber(-1));
  if (type == pt::HEARTBEAT) return;
  // Execution events arriving outside a pending request (e.g. SL hit) are
  // logged; the Node keeper owns state reconstruction via /positions.
  logLine("unsolicited payloadType=" + std::to_string(type));
}

void ExecEngine::maybeHeartbeatLocked() {
  auto now = steady_clock::now();
  if (ws_.isOpen() && now - lastSend_ >= seconds(25)) {
    ws_.sendText("{\"payloadType\":51}");
    lastSend_ = now;
  }
}

EngineResult ExecEngine::request(int reqType, const jsn::Value& payload,
                                 int expectType, int timeoutMs) {
  if (!ws_.isOpen())
    return errResult("NOT_CONNECTED", "websocket is not connected", false);

  jsn::Value frame{jsn::Object{}};
  frame.set("payloadType", reqType);
  frame.set("payload", payload);
  if (!ws_.sendText(jsn::dump(frame))) {
    authed_ = false;
    return errResult("SEND_FAILED", ws_.lastError(), false);
  }
  lastSend_ = steady_clock::now();

  auto deadline = steady_clock::now() + milliseconds(timeoutMs);
  while (steady_clock::now() < deadline) {
    int remain = static_cast<int>(
        duration_cast<milliseconds>(deadline - steady_clock::now()).count());
    if (remain <= 0) break;
    // Cap each wait so heartbeats keep flowing on long waits.
    auto text = ws_.recvText(remain > 5000 ? 5000 : remain);
    maybeHeartbeatLocked();
    if (!text) {
      if (!ws_.isOpen()) {
        authed_ = false;
        return errResult("DISCONNECTED", ws_.lastError(), false);
      }
      continue; // idle timeout slice
    }
    auto msg = jsn::parse(*text);
    if (!msg || !msg->isObject()) {
      logLine("unparseable frame dropped");
      continue;
    }
    int type = static_cast<int>(msg->get("payloadType").asNumber(-1));
    if (type == expectType) {
      EngineResult r;
      r.ok = true;
      r.body = msg->get("payload");
      return r;
    }
    if (type == pt::ERROR_RES || type == pt::ORDER_ERROR_EVENT) {
      const auto& p = msg->get("payload");
      return errResult(p.get("errorCode").asString(),
                       p.get("description").asString(), true);
    }
    handleUnsolicited(*msg);
  }
  return errResult("TIMEOUT",
                   "no payloadType " + std::to_string(expectType) + " within " +
                       std::to_string(timeoutMs) + "ms",
                   false);
}

EngineResult ExecEngine::authApp() {
  jsn::Value p{jsn::Object{}};
  p.set("clientId", clientId_);
  p.set("clientSecret", clientSecret_);
  return request(pt::APP_AUTH_REQ, p, pt::APP_AUTH_RES);
}

EngineResult ExecEngine::authAccountLocked(long long accountId) {
  jsn::Value p{jsn::Object{}};
  p.set("ctidTraderAccountId", accountId);
  p.set("accessToken", accessToken_);
  return request(pt::ACCOUNT_AUTH_REQ, p, pt::ACCOUNT_AUTH_RES);
}

EngineResult ExecEngine::authAccount() {
  return authAccountLocked(primaryAccountLocked());
}

bool ExecEngine::connectAndAuth() {
  std::lock_guard lk(mtx_);
  authed_ = false;
  if (!ws_.connect(host_)) {
    logLine("connect failed: " + ws_.lastError());
    return false;
  }
  lastSend_ = steady_clock::now();
  auto a = authApp();
  if (!a.ok) {
    logLine("app auth failed: " + jsn::dump(a.body));
    ws_.close();
    return false;
  }
  // M2: authorize EVERY account on the roster over this one connection
  // (ProtoOAAccountAuthReq per id — plan C1). The primary must succeed or
  // the session is useless; an extra that fails auth is dropped from the
  // roster with a loud log rather than poisoning the whole session.
  auto b = authAccountLocked(primaryAccountLocked());
  if (!b.ok) {
    logLine("account auth failed: " + jsn::dump(b.body));
    ws_.close();
    return false;
  }
  for (size_t i = 1; i < accountIds_.size();) {
    EngineResult r = authAccountLocked(accountIds_[i]);
    if (r.ok) {
      ++i;
    } else {
      logLine("extra account " + std::to_string(accountIds_[i]) +
              " auth failed — dropped from roster: " + jsn::dump(r.body));
      accountIds_.erase(accountIds_.begin() + static_cast<long>(i));
    }
  }
  authed_ = true;
  logLine("connected and authenticated to " + host_ + " (" +
          std::to_string(accountIds_.size()) + " account(s))");
  return true;
}

static jsn::Value withAccountId(const jsn::Value& payload, long long accountId) {
  jsn::Value p = payload.isObject() ? payload : jsn::Value{jsn::Object{}};
  if (p.get("ctidTraderAccountId").isNull()) p.set("ctidTraderAccountId", accountId);
  return p;
}

EngineResult ExecEngine::placeOrder(const jsn::Value& payload) {
  // Telemetry fields read once regardless of outcome — symbolId/volume are
  // whatever the caller sent (missing → 0/-1, never a crash); price is 0 for
  // a plain market order (no limitPrice/stopPrice attached).
  const int32_t symbolId = payload.isObject()
      ? static_cast<int32_t>(payload.get("symbolId").asNumber(-1)) : -1;
  const double volume = payload.isObject() ? payload.get("volume").asNumber(0) : 0;
  double price = 0;
  if (payload.isObject()) {
    const jsn::Value& lp = payload.get("limitPrice");
    const jsn::Value& sp = payload.get("stopPrice");
    if (lp.isNumber()) price = lp.asNumber(0);
    else if (sp.isNumber()) price = sp.asNumber(0);
  }

  // Bracket guarantee (#4) + atomic block (#3): validate BEFORE touching the
  // socket. A naked market order (no stop) or a halted/over-cap order is
  // refused here — the last line of defence, independent of anything the
  // Node strategy tier did or failed to do. Read is lock-free (snapshot of
  // atomics), so the HTTP thread can retune the guard without blocking this.
  const OrderVerdict v = validateOrder(payload, guard_.snapshot());
  if (!v.ok) {
    logLine("order REJECTED by guard: " + v.reason);
    if (telemetry_) {
      telemetry_->log({static_cast<uint64_t>(nowMs()), TK_ORDER_REJECT, symbolId,
                       volume, price, 0, classifyReasonCode(v.reason)});
    }
    return errResult(v.reason, v.reason, false);
  }
  if (telemetry_) {
    telemetry_->log({static_cast<uint64_t>(nowMs()), TK_ORDER_SUBMIT, symbolId,
                     volume, price, 1, 0});
  }
  std::lock_guard lk(mtx_);
  EngineResult r = request(pt::NEW_ORDER_REQ,
                          withAccountId(payload, primaryAccountLocked()),
                          pt::EXECUTION_EVENT);
  if (telemetry_) {
    const std::string reason = r.ok ? "" : r.body.get("errorCode").asString();
    telemetry_->log({static_cast<uint64_t>(nowMs()), TK_ORDER_RESULT, symbolId,
                     volume, price, r.ok ? 1 : 0, classifyReasonCode(reason)});
  }
  return r;
}

EngineResult ExecEngine::amendPosition(const jsn::Value& payload) {
  std::lock_guard lk(mtx_);
  return request(pt::AMEND_POSITION_SLTP_REQ,
                 withAccountId(payload, primaryAccountLocked()),
                 pt::EXECUTION_EVENT, 15000);
}

EngineResult ExecEngine::closePosition(const jsn::Value& payload) {
  std::lock_guard lk(mtx_);
  return request(pt::CLOSE_POSITION_REQ,
                 withAccountId(payload, primaryAccountLocked()),
                 pt::EXECUTION_EVENT);
}

EngineResult ExecEngine::cancelOrder(const jsn::Value& payload) {
  std::lock_guard lk(mtx_);
  return request(pt::CANCEL_ORDER_REQ,
                 withAccountId(payload, primaryAccountLocked()),
                 pt::EXECUTION_EVENT);
}

EngineResult ExecEngine::reconcileLocked(long long accountId) {
  jsn::Value p{jsn::Object{}};
  p.set("ctidTraderAccountId", accountId);
  auto r = request(pt::RECONCILE_REQ, p, pt::RECONCILE_RES, 25000);
  if (r.ok) {
    std::lock_guard sk(stateMtx_);
    reconcileByAccount_[accountId] = {jsn::dump(r.body), nowMs()};
  }
  return r;
}

EngineResult ExecEngine::reconcile() {
  std::lock_guard lk(mtx_);
  // M2: every authorized account reconciles each pass. The PRIMARY result is
  // returned (runLoop's transport-error handling keys off it), and a
  // transport failure aborts the sweep — the connection is gone for all of
  // them anyway.
  EngineResult primary = reconcileLocked(primaryAccountLocked());
  if (!primary.ok && !primary.brokerError) return primary;
  for (size_t i = 1; i < accountIds_.size(); ++i) {
    EngineResult r = reconcileLocked(accountIds_[i]);
    if (!r.ok && !r.brokerError) return r;
  }
  return primary;
}

void ExecEngine::runLoop() {
  int backoffMs = 1000;
  constexpr int kBackoffCapMs = 60000;
  for (;;) {
    if (!hasCredentials()) { // waiting for POST /connect from the keeper
      std::this_thread::sleep_for(milliseconds(1000));
      continue;
    }
    if (!isConnected()) {
      if (connectAndAuth()) {
        backoffMs = 1000;
      } else {
        logLine("reconnect in " + std::to_string(backoffMs) + "ms");
        std::this_thread::sleep_for(milliseconds(backoffMs));
        backoffMs = backoffMs * 2 > kBackoffCapMs ? kBackoffCapMs : backoffMs * 2;
        continue;
      }
    }
    auto r = reconcile();
    if (!r.ok && !r.brokerError)
      continue; // transport problem — loop back into reconnect path
    // Idle between reconcile polls; the slice keeps heartbeats within 25s.
    for (int slept = 0; slept < 30000 && isConnected(); slept += 5000) {
      std::this_thread::sleep_for(milliseconds(5000));
      std::lock_guard lk(mtx_);
      maybeHeartbeatLocked();
    }
  }
}
