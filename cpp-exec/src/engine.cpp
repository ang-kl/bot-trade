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
    { "guard_no_account", 10 },
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
      requestedAccountIds_{accountId} {}

void ExecEngine::setCredentials(std::string host, std::string clientId,
                                std::string clientSecret,
                                std::string accessToken, long long accountId,
                                std::vector<long long> extraAccountIds) {
  std::lock_guard lk(mtx_);
  const bool sameSession = host == host_ && clientId == clientId_ &&
                           accessToken == accessToken_ && authed_;
  // The REQUESTED roster is authoritative either way — a failed auth keeps
  // the id requested so the next reconnect retries it (audit #5).
  std::vector<long long> wanted;
  if (accountId > 0) wanted.push_back(accountId);
  for (long long id : extraAccountIds) {
    if (id <= 0) continue;
    bool dup = false;
    for (long long have : wanted) if (have == id) { dup = true; break; }
    if (!dup) wanted.push_back(id);
  }
  if (sameSession) {
    // M2: same host+app+token — the live session stays up. Auth any account
    // ids we haven't authorized yet, incrementally, without disturbing the
    // accounts already trading on this connection.
    requestedAccountIds_ = wanted;
    for (long long id : wanted) {
      bool known = false;
      for (long long have : accountIds_) if (have == id) { known = true; break; }
      if (known) continue;
      // Same rule on the incremental path: a newly-requested account that the
      // token cannot authorize must not drop the session the others are
      // already trading on. This is the path the owner's registry change went
      // through — enabling one demo account should never be able to stop
      // execution for the rest.
      ExtraAuthScope guard(authorizingExtra_);
      EngineResult r = authAccountLocked(id);
      if (r.ok) {
        accountIds_.push_back(id);
        logLine("account " + std::to_string(id) + " authorized on existing session");
      } else {
        logLine("account " + std::to_string(id) + " auth FAILED on existing session (stays requested, retried on next reconnect): " + jsn::dump(r.body));
      }
    }
    return;
  }
  host_ = std::move(host);
  clientId_ = std::move(clientId);
  clientSecret_ = std::move(clientSecret);
  accessToken_ = std::move(accessToken);
  requestedAccountIds_ = wanted;
  accountIds_.clear();
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
  // With a live session: what THIS session actually authorized. Before one
  // exists: the requested roster (what the keeper asked for) — /health and
  // the pre-connection tests both want the meaningful answer for their
  // moment, and an empty list pre-auth would read as "no accounts at all".
  return authed_ && !accountIds_.empty() ? accountIds_ : requestedAccountIds_;
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

// Auth-family error codes mean the session (not this one request) is dead:
// the token expired or the account lost its authorization. Without this, an
// expired token left authed_ true forever — every order 502'd with a broker
// error while /health said connected:true, which also suppressed the JS
// fallback (audit #4).
bool isAuthFamilyError(const std::string& code) {
  return code == "CH_ACCESS_TOKEN_INVALID" || code == "ACCOUNT_NOT_AUTHORIZED" ||
         code == "NOT_AUTHENTICATED" || code == "CH_CLIENT_AUTH_FAILURE" ||
         code == "ALREADY_LOGGED_IN" || code == "CH_ACCESS_TOKEN_EXPIRED";
}

// The policy, as one pure function, so it can be tested without a broker
// socket — the incident it exists to prevent was a disagreement between two
// handlers, and a rule that only exists as scattered ifs is exactly how they
// came to disagree.
AuthErrorAction authErrorAction(const std::string& code, bool authorizingExtra) {
  if (!isAuthFamilyError(code)) return AuthErrorAction::Ignore;
  return authorizingExtra ? AuthErrorAction::SkipAccount : AuthErrorAction::KillSession;
}

void ExecEngine::noteBrokerErrorLocked(const std::string& errorCode) {
  const AuthErrorAction act = authErrorAction(errorCode, authorizingExtra_);
  if (act == AuthErrorAction::Ignore) return;
  // ONE ACCOUNT'S REJECTION IS NOT THE SESSION'S DEATH (production incident,
  // 2026-08-04, ~23:47Z onward).
  //
  // Authorizing an EXTRA account is per-account: CH_ACCESS_TOKEN_INVALID there
  // means "this token does not cover THAT account", not "the token is dead".
  // Tearing the socket down on it fought the skip-and-continue directly above
  // — the loop logged "skipped this session, retried on next reconnect", this
  // closed the connection anyway, and the sidecar reconnected roughly once a
  // second, forever:
  //
  //   connected and authenticated (2/4 account(s))
  //   auth-family broker error 'CH_ACCESS_TOKEN_INVALID' — closing session
  //   extra account 46979908 auth failed — skipped this session…
  //   extra account 47790949 auth failed — …NOT_CONNECTED   ← collateral
  //
  // The cost was not cosmetic: /health stopped answering inside its timeout,
  // so the roster read `unknown` on every account row, the cpp_exec heartbeat
  // went to error, and the execution engine had no stable session to place or
  // close an order on — because one demo account had been enabled.
  //
  // The primary still tears the session down, which is the case this guard was
  // written for: if the token cannot authorize the account we trade on, the
  // session really is dead and must be rebuilt.
  if (act == AuthErrorAction::SkipAccount) {
    logLine("auth-family error '" + errorCode +
            "' while authorizing an EXTRA account — session kept, that account skipped");
    return;
  }
  logLine("auth-family broker error '" + errorCode + "' — closing session for reauth");
  ws_.close();
  authed_ = false;
}

EngineResult ExecEngine::request(int reqType, const jsn::Value& payload,
                                 int expectType, int timeoutMs) {
  if (!ws_.isOpen())
    return errResult("NOT_CONNECTED", "websocket is not connected", false);

  // Every request carries a fresh clientMsgId and ONLY a frame echoing it can
  // answer it. Pairing by payloadType alone returned buffered or unsolicited
  // EXECUTION_EVENTs (ORDER_ACCEPTED leftovers, another account's SL hit) as
  // the current call's success — Node then marked live positions closed or
  // counted stop ratchets that never happened (audit #1, critical).
  const std::string msgId = "cx" + std::to_string(++msgSeq_);
  jsn::Value frame{jsn::Object{}};
  frame.set("clientMsgId", msgId);
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
    const std::string theirId = msg->get("clientMsgId").asString();
    const bool mine = theirId == msgId;
    // A frame echoing a DIFFERENT id answers some other (earlier) request —
    // it can never answer this one. Unsolicited events carry no id at all.
    const bool foreign = !theirId.empty() && !mine;
    int type = static_cast<int>(msg->get("payloadType").asNumber(-1));
    if (mine && type == expectType) {
      EngineResult r;
      r.ok = true;
      r.body = msg->get("payload");
      return r;
    }
    if (type == pt::ERROR_RES || type == pt::ORDER_ERROR_EVENT) {
      const auto& p = msg->get("payload");
      const std::string code = p.get("errorCode").asString();
      // An auth-family error kills the session whether or not it answers this
      // request.
      noteBrokerErrorLocked(code);
      // SUCCESS demands our echoed id; failure is accepted on an id-less
      // error frame too — misattributing an error fails safe (the caller
      // retries/reports), misattributing a success is the audit-#1 bug.
      if (!foreign || !ws_.isOpen())
        return errResult(code, p.get("description").asString(), true);
      handleUnsolicited(*msg);
      continue;
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
  // M2: authorize EVERY REQUESTED account over this one connection
  // (ProtoOAAccountAuthReq per id — plan C1). The primary must succeed or
  // the session is useless; an extra that fails auth is skipped FOR THIS
  // SESSION with a loud log — it stays requested, so the next reconnect
  // retries it instead of a transient failure erasing the account from
  // management forever (audit #5).
  auto b = authAccountLocked(primaryAccountLocked());
  if (!b.ok) {
    logLine("account auth failed: " + jsn::dump(b.body));
    ws_.close();
    return false;
  }
  accountIds_.clear();
  accountIds_.push_back(primaryAccountLocked());
  for (size_t i = 1; i < requestedAccountIds_.size(); ++i) {
    const long long id = requestedAccountIds_[i];
    ExtraAuthScope guard(authorizingExtra_);
    EngineResult r = authAccountLocked(id);
    if (r.ok) {
      accountIds_.push_back(id);
    } else {
      logLine("extra account " + std::to_string(id) +
              " auth failed — skipped this session, retried on next reconnect: " +
              jsn::dump(r.body));
    }
  }
  authed_ = true;
  logLine("connected and authenticated to " + host_ + " (" +
          std::to_string(accountIds_.size()) + "/" +
          std::to_string(requestedAccountIds_.size()) + " account(s))");
  return true;
}

// PHASE 2, owner's decision 2026-07-30: "C++ sidecar refuse an unstamped
// operation."
//
// THIS REPLACES withAccountId(), which used to fill a missing
// ctidTraderAccountId from primaryAccountLocked(). That default is the whole
// mechanism behind exits landing on the wrong account: setCredentials'
// sameSession branch never reorders accountIds_, so the primary is elected once
// per broker session and then frozen, and every unstamped close/amend therefore
// had ONE destination no matter which account the caller meant. On any
// non-primary account, positions opened and were then never managed —
// POSITION_NOT_FOUND on every stop ratchet, giveback close, loss cap, time cap
// and weekend bank, each logging and carrying on by design.
//
// Refusing converts that from silent mis-routing into an immediate, loud failure.
// Node now stamps the account on every write (agent/lib/exec-engine.js
// withAccount), merged and deployed BEFORE this, so in practice there is nothing
// left to refuse: this is a tripwire against regression, not a behaviour change.
//
// reconcileLocked is unaffected — it always set the id explicitly.
static bool hasAccountId(const jsn::Value& payload) {
  if (!payload.isObject()) return false;
  const jsn::Value& v = payload.get("ctidTraderAccountId");
  return v.isNumber() && v.asNumber(0) > 0;
}

static const char* kNoAccountDesc =
    "operation does not name a ctidTraderAccountId — refusing to choose an "
    "account on the caller's behalf";

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
  std::lock_guard lk(mtx_);
  // SUBMIT is logged after the lock is held — with it logged before, the
  // record timestamped a submission that could still be a minute away behind
  // a reconcile sweep (audit #2 note).
  if (telemetry_) {
    telemetry_->log({static_cast<uint64_t>(nowMs()), TK_ORDER_SUBMIT, symbolId,
                     volume, price, 1, 0});
  }
  // The account is NOT filled in — validateOrder above has already refused a
  // payload that does not name one (guard_no_account).
  EngineResult r = request(pt::NEW_ORDER_REQ, payload, pt::EXECUTION_EVENT);
  if (telemetry_) {
    const std::string reason = r.ok ? "" : r.body.get("errorCode").asString();
    telemetry_->log({static_cast<uint64_t>(nowMs()), TK_ORDER_RESULT, symbolId,
                     volume, price, r.ok ? 1 : 0, classifyReasonCode(reason)});
  }
  return r;
}

EngineResult ExecEngine::amendPosition(const jsn::Value& payload) {
  if (!hasAccountId(payload)) return errResult("guard_no_account", kNoAccountDesc, false);
  // The kill switch freezes everything except REDUCING risk: closes and
  // cancels stay allowed, but an amend can widen a stop — during a halt that
  // is new risk, so it is refused (audit #7). The trail engine's tighten-only
  // amends failing during a halt is visible (amendsFailed) and acceptable.
  if (guard_.snapshot().halt) {
    return errResult("guard_halt", "execution halted by kill switch — amends refused (closes still allowed)", false);
  }
  std::lock_guard lk(mtx_);
  return request(pt::AMEND_POSITION_SLTP_REQ, payload, pt::EXECUTION_EVENT, 15000);
}

EngineResult ExecEngine::closePosition(const jsn::Value& payload) {
  if (!hasAccountId(payload)) return errResult("guard_no_account", kNoAccountDesc, false);
  std::lock_guard lk(mtx_);
  return request(pt::CLOSE_POSITION_REQ, payload, pt::EXECUTION_EVENT);
}

EngineResult ExecEngine::cancelOrder(const jsn::Value& payload) {
  if (!hasAccountId(payload)) return errResult("guard_no_account", kNoAccountDesc, false);
  std::lock_guard lk(mtx_);
  return request(pt::CANCEL_ORDER_REQ, payload, pt::EXECUTION_EVENT);
}

EngineResult ExecEngine::reconcileLocked(long long accountId) {
  jsn::Value p{jsn::Object{}};
  p.set("ctidTraderAccountId", accountId);
  // 10s, not 25s: even with per-account lock scope, a hung reconcile still
  // holds the order path for its own timeout — keep that bound tight.
  auto r = request(pt::RECONCILE_REQ, p, pt::RECONCILE_RES, 10000);
  if (r.ok) {
    std::lock_guard sk(stateMtx_);
    reconcileByAccount_[accountId] = {jsn::dump(r.body), nowMs()};
  }
  return r;
}

EngineResult ExecEngine::reconcile() {
  // M2: every authorized account reconciles each pass. The PRIMARY result is
  // returned (runLoop's transport-error handling keys off it), and a
  // transport failure aborts the sweep — the connection is gone for all of
  // them anyway.
  //
  // The lock is taken PER ACCOUNT, not across the sweep (audit #2): holding
  // mtx_ for N × up-to-25s blocked every order/amend/close — including the
  // profit keeper's exits — behind a background poll. Between accounts the
  // mutex is free, so a queued close runs after at most one reconcile.
  std::vector<long long> ids;
  {
    std::lock_guard lk(mtx_);
    ids = accountIds_;
    if (ids.empty()) ids.push_back(primaryAccountLocked());
  }
  EngineResult primary;
  bool havePrimary = false;
  for (long long id : ids) {
    if (id <= 0) continue;
    EngineResult r;
    {
      std::lock_guard lk(mtx_);
      r = reconcileLocked(id);
    }
    if (!havePrimary) { primary = r; havePrimary = true; }
    if (!r.ok && !r.brokerError) return r;
  }
  if (!havePrimary) return errResult("NOT_CONNECTED", "no account to reconcile", false);
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
