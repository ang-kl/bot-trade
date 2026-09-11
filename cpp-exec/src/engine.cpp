// cpp-exec/src/engine.cpp
#include "engine.hpp"

#include <algorithm>
#include "heartbeat.hpp"

#include <cctype>

#include <cstdio>
#include <thread>

using namespace std::chrono;

static long long nowMs() {
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

static long long steadyMs() {
  return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
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

// The reader's receive slice. Short, so a wake-up (setCredentials, shutdown)
// is honoured within a second and the heartbeat lands within a second of its
// idle bound; the slice is not a timeout on anything the broker does.
static constexpr int kReaderSliceMs = 1000;

void ExecEngine::Pending::settle(EngineResult r) {
  if (done.exchange(true)) return;
  promise.set_value(std::move(r));
}

ExecEngine::ExecEngine(std::string host, std::string clientId,
                       std::string clientSecret, std::string accessToken,
                       long long accountId)
    : host_(std::move(host)),
      clientId_(std::move(clientId)),
      clientSecret_(std::move(clientSecret)),
      accessToken_(std::move(accessToken)),
      requestedAccountIds_{accountId} {}

ExecEngine::~ExecEngine() {
  ws_.wakeReader();
  if (reader_.joinable()) reader_.join();
}

void ExecEngine::setCredentials(std::string host, std::string clientId,
                                std::string clientSecret,
                                std::string accessToken, long long accountId,
                                std::vector<long long> extraAccountIds) {
  std::lock_guard lk(mtx_);
  const bool sameSession = host == host_ && clientId == clientId_ &&
                           accessToken == accessToken_ && authed_.load();
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
      EngineResult r = authAccountLocked(id, /*extra=*/true);
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
  // session (if any) may be authed against a different account/token. The
  // reader owns the socket: wake it and let it tear the connection down.
  stopReaderLocked();
  authed_.store(false);
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
  return authed_.load() && !accountIds_.empty() ? accountIds_ : requestedAccountIds_;
}

bool ExecEngine::isConnected() {
  return ws_.isOpen() && authed_.load();
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

ExecEngine::SessionStats ExecEngine::sessionStats() {
  SessionStats s;
  s.readerRunning = readerRunning_.load();
  { std::lock_guard lk(pendingMtx_); s.pending = pending_.size(); }
  s.generation = generation_.load();
  s.framesIn = framesIn_.load();
  s.lateFrames = lateFrames_.load();
  s.unsolicited = unsolicited_.load();
  s.timeouts = timeouts_.load();
  s.heartbeatsSent = heartbeatsSent_.load();
  s.disconnects = disconnects_.load();
  s.inFlightRefused = inFlightRefused_.load();
  s.deferrals = deferrals_.load();
  const long long until = deferUntilMs_.load();
  s.deferredMsRemaining = until > 0 ? std::max<long long>(0, until - steadyMs()) : 0;
  s.maxInFlight = maxInFlight_.load();
  return s;
}

// ProtoOAErrorRes.retryAfter (help.ctrader.com/open-api/messages, read
// 11-09-2026): "When you hit rate limit with errorCode=BLOCKED_PAYLOAD_TYPE,
// this field will contain amount of seconds until related payload type will
// be unlocked." Honoured as a pause on every entry and read; capped at two
// minutes (the keeper's own cap) so a malformed value cannot park the
// session, and never applied to protection — a stop still has to move.
void ExecEngine::noteRetryAfter(const jsn::Value& p) {
  const double sec = p.get("retryAfter").asNumber(0);
  if (!(sec > 0)) return;
  const long long ms = std::min<long long>(120'000, static_cast<long long>(sec * 1000.0));
  const long long until = steadyMs() + ms;
  long long cur = deferUntilMs_.load();
  while (until > cur && !deferUntilMs_.compare_exchange_weak(cur, until)) {}
  deferrals_.fetch_add(1);
  if (ring_) ring_->log("engine", "retry_after", 0, 0, p.get("errorCode").asString(),
                        "broker asked for " + std::to_string(ms) + " ms; entries and reads deferred, protection not");
}

void ExecEngine::handleUnsolicited(const jsn::Value& msg) {
  int type = static_cast<int>(msg.get("payloadType").asNumber(-1));
  if (type == pt::HEARTBEAT) return;
  // SYMBOL_CHANGED_EVENT is the broker announcing a spec update (spreads,
  // swaps, session windows) — routine around rollover, one copy per
  // authorized account, and nothing here consumes symbol specs (Node fetches
  // them fresh per request). Logging it painted the owner's log with error
  // lines in threes every 30s while carrying no information a reader could
  // act on.
  if (type == pt::SYMBOL_CHANGED_EVENT) return;
  // Unsolicited EXECUTION_EVENTs (an order expiring, a broker-side SL/TP
  // fill, another account's activity, a LATE ANSWER to a request that gave
  // up) are real events. P2b-1: they are journaled for the keeper's ledger
  // (POST /events) instead of dropped; still not logged to stdout (owner
  // 2026-08-27: "silence the 2126 log noise", same call as 2120).
  if (type == pt::EXECUTION_EVENT || type == pt::ORDER_ERROR_EVENT) {
    if (journal_) journal_->record(msg, false);
    return;
  }
  logLine("unsolicited payloadType=" + std::to_string(type));
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

// --- host pin -------------------------------------------------------------
// Same shape and same reason as authErrorAction above: a rule that only exists
// as scattered ifs inside a request handler is a rule two handlers can come to
// disagree about.
namespace {
std::string normalizeHost(const std::string& h) {
  std::string out;
  out.reserve(h.size());
  for (char c : h) {
    if (c == ' ' || c == '\t' || c == '\r' || c == '\n') continue;
    out.push_back((char)std::tolower((unsigned char)c));
  }
  return out;
}
} // namespace

bool connectHostAllowed(const std::string& pinned, const std::string& requested) {
  const std::string p = normalizeHost(pinned);
  if (p.empty()) return true;               // unpinned — today's deployment
  const std::string r = normalizeHost(requested);
  if (r.empty()) return true;               // caller substitutes the pin
  return r == p;
}

std::string effectiveConnectHost(const std::string& pinned, const std::string& requested) {
  const std::string p = normalizeHost(pinned);
  const std::string r = normalizeHost(requested);
  if (!connectHostAllowed(pinned, requested)) return "";
  if (!p.empty()) return p;                 // a pinned process serves ONE host
  // Unpinned: the request decides, and an absent host keeps the historical
  // default rather than inventing a new one.
  return r.empty() ? "live.ctraderapi.com" : r;
}

void ExecEngine::noteBrokerError(const std::string& errorCode, bool extraAuth) {
  const AuthErrorAction act = authErrorAction(errorCode, extraAuth);
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
    if (ring_) ring_->log("engine", "auth_error", 0, 0, errorCode, "skip_account: session kept");
    return;
  }
  logLine("auth-family broker error '" + errorCode + "' — closing session for reauth");
  if (ring_) ring_->log("engine", "auth_error", 0, 0, errorCode, "kill_session: closing for reauth");
  // On the reader thread — the socket's owner — so closing here is the C1-safe
  // path; the reader loop then exits and fails everything still in flight.
  authed_.store(false);
  ws_.close();
}

// --- the async session ------------------------------------------------------

void ExecEngine::startReaderLocked() {
  if (reader_.joinable()) reader_.join(); // a finished reader from the last connection
  const long long gen = generation_.fetch_add(1) + 1;
  readerRunning_.store(true);
  reader_ = std::thread([this, gen] { readerLoop(gen); });
}

void ExecEngine::stopReaderLocked() {
  ws_.wakeReader();
  if (reader_.joinable()) reader_.join();
  readerRunning_.store(false);
}

void ExecEngine::failAllPending(const std::string& code, const std::string& desc) {
  std::map<std::string, std::shared_ptr<Pending>> gone;
  {
    std::lock_guard lk(pendingMtx_);
    gone.swap(pending_);
  }
  for (auto& kv : gone) kv.second->settle(errResult(code, desc, false));
}

void ExecEngine::readerLoop(long long generation) {
  if (ring_) ring_->log("engine", "reader_started", 0, 0, "", "connection " + std::to_string(generation));
  while (ws_.isOpen()) {
    auto text = ws_.recvText(kReaderSliceMs);
    // The heartbeat lives here because the reader is the one thread that is
    // always awake on the connection (cTrader asks for one every 10 s; the
    // bound is heartbeat.hpp's).
    const long long now = steadyMs();
    if (ws_.isOpen() && now - lastSendMs_.load() >= heartbeatIdleMs_.load()) {
      if (ws_.sendText("{\"payloadType\":51}")) {
        lastSendMs_.store(now);
        heartbeatsSent_.fetch_add(1);
      }
    }
    if (!text) continue; // idle slice, or the socket closed (the loop condition sees it)
    auto msg = jsn::parse(*text);
    if (!msg || !msg->isObject()) {
      logLine("unparseable frame dropped");
      continue;
    }
    framesIn_.fetch_add(1);
    dispatchFrame(*msg);
  }
  // The reader owns teardown (no-op when the peer already closed it).
  ws_.close();
  authed_.store(false);
  const std::string why = ws_.lastError();
  failAllPending("DISCONNECTED", why.empty() ? "connection closed" : why);
  disconnects_.fetch_add(1);
  if (ring_) ring_->log("engine", "disconnected", 0, 0, "", "connection " + std::to_string(generation) + (why.empty() ? "" : ": " + why));
  readerRunning_.store(false);
}

void ExecEngine::dispatchFrame(const jsn::Value& msg) {
  const int type = static_cast<int>(msg.get("payloadType").asNumber(-1));
  if (type == pt::HEARTBEAT) return;
  const std::string theirId = msg.get("clientMsgId").asString();
  const bool isError = type == pt::ERROR_RES || type == pt::ORDER_ERROR_EVENT;

  // Every request carries a fresh clientMsgId and ONLY a frame echoing it can
  // answer it. Pairing by payloadType alone returned buffered or unsolicited
  // EXECUTION_EVENTs (ORDER_ACCEPTED leftovers, another account's SL hit) as
  // the current call's success — Node then marked live positions closed or
  // counted stop ratchets that never happened (audit #1, critical).
  std::shared_ptr<Pending> mine;
  if (!theirId.empty()) {
    std::lock_guard lk(pendingMtx_);
    auto it = pending_.find(theirId);
    if (it != pending_.end() && (type == it->second->expectType || isError)) {
      mine = it->second;
      pending_.erase(it);
    }
  }
  if (mine) {
    if (journal_) journal_->record(msg, true); // an execution event a request waited for
    if (type == mine->expectType) {
      EngineResult r;
      r.ok = true;
      r.body = msg.get("payload");
      mine->settle(std::move(r));
      return;
    }
    const auto& p = msg.get("payload");
    const std::string code = p.get("errorCode").asString();
    // An auth-family error kills the session whether or not it answers this
    // request (and if it does, the request's own answer is that error).
    noteBrokerError(code, mine->extraAuth);
    noteRetryAfter(p);
    EngineResult er = errResult(code, p.get("description").asString(), true);
    if (p.get("retryAfter").asNumber(0) > 0) er.body.set("retryAfterMs", p.get("retryAfter").asNumber(0) * 1000.0);
    mine->settle(std::move(er));
    return;
  }

  if (isError) {
    const auto& p = msg.get("payload");
    const std::string code = p.get("errorCode").asString();
    // SUCCESS demands our echoed id; failure is accepted on an id-less error
    // frame too — misattributing an error fails safe (the caller retries or
    // reports), misattributing a success is the audit-#1 bug. But an id-less
    // error can only be attributed when there is exactly ONE request it
    // could belong to (the only case the synchronous session ever faced);
    // with several in flight it is nobody's answer — journaled, and each
    // request runs to its own echoed answer or its timeout, which the keeper
    // resolves as UNKNOWN from the journal, never as a definite REJECTED
    // that would license a resend.
    std::shared_ptr<Pending> sole;
    if (theirId.empty()) {
      std::lock_guard lk(pendingMtx_);
      if (pending_.size() == 1) {
        sole = pending_.begin()->second;
        pending_.clear();
      }
    }
    if (journal_) journal_->record(msg, sole != nullptr);
    noteBrokerError(code, sole ? sole->extraAuth : false);
    noteRetryAfter(p);
    if (sole) {
      EngineResult er = errResult(code, p.get("description").asString(), true);
      if (p.get("retryAfter").asNumber(0) > 0) er.body.set("retryAfterMs", p.get("retryAfter").asNumber(0) * 1000.0);
      sole->settle(std::move(er));
    } else if (!theirId.empty()) {
      lateFrames_.fetch_add(1); // an error for a request that already gave up
    } else {
      unsolicited_.fetch_add(1);
    }
    return;
  }

  // A frame with our id whose request already gave up (a LATE answer — the
  // keeper matches it in the journal by clientMsgId), or a second event for
  // a settled request (ORDER_FILLED after the ORDER_ACCEPTED that answered
  // it), or a frame with no id at all: journaled if it is an execution
  // event, otherwise noted.
  if (!theirId.empty()) lateFrames_.fetch_add(1);
  else unsolicited_.fetch_add(1);
  handleUnsolicited(msg);
}

ExecEngine::Ticket ExecEngine::beginRequest(int reqType, const jsn::Value& payload,
                                            int expectType, RequestClass cls, bool extraAuth) {
  Ticket t;
  if (!ws_.isOpen() || !readerRunning_.load()) {
    t.failed = true;
    t.early = errResult("NOT_CONNECTED", "websocket is not connected", false);
    return t;
  }

  if (cls != RequestClass::Protection) {
    // The broker's retryAfter pause (noteRetryAfter): provably not sent.
    const long long until = deferUntilMs_.load();
    const long long remain = until > 0 ? until - steadyMs() : 0;
    if (remain > 0) {
      if (ring_) ring_->log("engine", "deferred", 0, 0, cls == RequestClass::Entry ? "entry" : "read", std::to_string(remain) + " ms of the broker's retryAfter remain");
      t.failed = true;
      t.early = errResult("rate_limited", "the broker asked for a pause (retryAfter) — " + std::to_string(remain) + " ms remain; not sent", false);
      t.early.body.set("retryAfterMs", static_cast<double>(remain));
      return t;
    }
    // Bounded in-flight work: an entry or read that would be the (cap+1)th
    // request outstanding is refused before anything is written. Protection
    // is never capped — a close must not wait behind a burst of reads.
    size_t inFlight;
    { std::lock_guard lk(pendingMtx_); inFlight = pending_.size(); }
    const int cap = maxInFlight_.load();
    if (inFlight >= static_cast<size_t>(cap)) {
      inFlightRefused_.fetch_add(1);
      if (ring_) ring_->log("engine", "too_many_in_flight", 0, 0, cls == RequestClass::Entry ? "entry" : "read", std::to_string(inFlight) + " in flight, cap " + std::to_string(cap));
      t.failed = true;
      t.early = errResult("too_many_in_flight", std::to_string(inFlight) + " request(s) in flight (cap " + std::to_string(cap) + ") — not sent", false);
      return t;
    }
  }

  // P2b-1 PACING (TM-25): one token per request against the connection's
  // documented budget. An entry or read that would eat into the protection
  // reserve is refused before anything is written — provably not sent, so
  // the keeper's ledger releases its intent and the loop retries. A
  // protection request (amend / close / cancel) waits, bounded, for its
  // token: it is never the one that yields.
  if (pacer_ && !pacer_->tryAcquire(cls, nowMs())) {
    bool acquired = false;
    if (cls == RequestClass::Protection) {
      for (int waited = 0; waited < 1000 && !acquired; waited += 50) {
        std::this_thread::sleep_for(milliseconds(50));
        acquired = pacer_->tryAcquire(cls, nowMs());
      }
    }
    if (!acquired) {
      const auto& pc = pacer_->config();
      if (ring_) ring_->log("engine", "rate_limited", 0, 0, cls == RequestClass::Entry ? "entry" : (cls == RequestClass::Read ? "read" : "protection"),
                            std::to_string(pc.capacityPerSec) + "/s, " + std::to_string(pc.protectionReservePct) + "% reserved for protection");
      t.failed = true;
      t.early = errResult("rate_limited", "the connection's request budget is spent (" + std::to_string(pc.capacityPerSec) +
                          "/s, " + std::to_string(pc.protectionReservePct) + "% reserved for protection) — not sent", false);
      return t;
    }
  }

  auto p = std::make_shared<Pending>();
  p->expectType = expectType;
  p->extraAuth = extraAuth;
  {
    // Registered BEFORE the send, so the answer cannot arrive at a reader
    // that does not yet know the id.
    std::lock_guard lk(pendingMtx_);
    p->msgId = "cx" + std::to_string(++msgSeq_);
    pending_[p->msgId] = p;
  }
  t.p = p;
  t.fut = p->promise.get_future();
  jsn::Value frame{jsn::Object{}};
  frame.set("clientMsgId", p->msgId);
  frame.set("payloadType", reqType);
  frame.set("payload", payload);
  if (!ws_.sendText(jsn::dump(frame))) {
    { std::lock_guard lk(pendingMtx_); pending_.erase(p->msgId); }
    t.failed = true;
    t.early = errResult("SEND_FAILED", ws_.lastError(), false);
    return t;
  }
  lastSendMs_.store(steadyMs());
  return t;
}

EngineResult ExecEngine::awaitRequest(Ticket& t, int timeoutMs) {
  if (t.failed) return t.early;
  const int override = requestTimeoutOverrideMs_.load();
  if (override > 0) timeoutMs = override;
  if (t.fut.wait_for(milliseconds(timeoutMs)) == std::future_status::ready) return t.fut.get();
  bool withdrawn;
  {
    std::lock_guard lk(pendingMtx_);
    withdrawn = pending_.erase(t.p->msgId) > 0;
  }
  // The reader settled it between the wait and the erase — its answer stands.
  if (!withdrawn) return t.fut.get();
  timeouts_.fetch_add(1);
  // P2b-1: the id this request went out under, so the keeper can match a
  // late frame in the journal to the intent it marked UNKNOWN.
  EngineResult r = errResult("TIMEOUT",
                             "no payloadType " + std::to_string(t.p->expectType) + " within " +
                                 std::to_string(timeoutMs) + "ms",
                             false);
  r.body.set("clientMsgId", t.p->msgId);
  return r;
}

EngineResult ExecEngine::request(int reqType, const jsn::Value& payload,
                                 int expectType, int timeoutMs, RequestClass cls, bool extraAuth) {
  Ticket t = beginRequest(reqType, payload, expectType, cls, extraAuth);
  return awaitRequest(t, timeoutMs);
}

EngineResult ExecEngine::authApp() {
  jsn::Value p{jsn::Object{}};
  p.set("clientId", clientId_);
  p.set("clientSecret", clientSecret_);
  return request(pt::APP_AUTH_REQ, p, pt::APP_AUTH_RES);
}

EngineResult ExecEngine::authAccountLocked(long long accountId, bool extra) {
  jsn::Value p{jsn::Object{}};
  p.set("ctidTraderAccountId", accountId);
  p.set("accessToken", accessToken_);
  return request(pt::ACCOUNT_AUTH_REQ, p, pt::ACCOUNT_AUTH_RES, 20000, RequestClass::Read, extra);
}

EngineResult ExecEngine::authAccount() {
  std::lock_guard lk(mtx_);
  return authAccountLocked(primaryAccountLocked(), /*extra=*/false);
}

bool ExecEngine::connectAndAuth() {
  std::lock_guard lk(mtx_);
  authed_.store(false);
  // Whatever reader the last connection had is finished or being replaced;
  // it must be gone before connect() touches the socket state it owned.
  stopReaderLocked();
  const bool loopback = loopbackPort_ > 0;
  if (!ws_.connect(loopback ? "127.0.0.1" : host_, loopback ? loopbackPort_ : 5036, !loopback)) {
    logLine("connect failed: " + ws_.lastError());
    return false;
  }
  lastSendMs_.store(steadyMs());
  startReaderLocked();
  auto a = authApp();
  if (!a.ok) {
    logLine("app auth failed: " + jsn::dump(a.body));
    stopReaderLocked();
    return false;
  }
  // M2: authorize EVERY REQUESTED account over this one connection
  // (ProtoOAAccountAuthReq per id — plan C1). The primary must succeed or
  // the session is useless; an extra that fails auth is skipped FOR THIS
  // SESSION with a loud log — it stays requested, so the next reconnect
  // retries it instead of a transient failure erasing the account from
  // management forever (audit #5).
  auto b = authAccountLocked(primaryAccountLocked(), /*extra=*/false);
  if (!b.ok) {
    logLine("account auth failed: " + jsn::dump(b.body));
    stopReaderLocked();
    return false;
  }
  accountIds_.clear();
  accountIds_.push_back(primaryAccountLocked());
  for (size_t i = 1; i < requestedAccountIds_.size(); ++i) {
    const long long id = requestedAccountIds_[i];
    EngineResult r = authAccountLocked(id, /*extra=*/true);
    if (r.ok) {
      accountIds_.push_back(id);
    } else {
      logLine("extra account " + std::to_string(id) +
              " auth failed — skipped this session, retried on next reconnect: " +
              jsn::dump(r.body));
    }
  }
  if (!ws_.isOpen()) { // an auth-family error on the way killed the session
    stopReaderLocked();
    return false;
  }
  authed_.store(true);
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
// reconcileOne is unaffected — it always set the id explicitly.
static bool hasAccountId(const jsn::Value& payload) {
  if (!payload.isObject()) return false;
  const jsn::Value& v = payload.get("ctidTraderAccountId");
  return v.isNumber() && v.asNumber(0) > 0;
}

static const char* kNoAccountDesc =
    "operation does not name a ctidTraderAccountId — refusing to choose an "
    "account on the caller's behalf";

// P2a: what cTrader receives — the order without the keeper's ledger fields
// (the permit and the intent id). A stray field on
// ProtoOANewOrderReq is a broker-side refusal or, worse, a silent ignore that
// nobody would see; stripping is explicit and testable.
jsn::Value wireOrderPayload(const jsn::Value& payload) {
  jsn::Value wire{jsn::Object{}};
  for (const auto& kv : payload.asObject()) {
    if (kv.first == "permit" || kv.first == "intentId") continue;
    wire.set(kv.first, kv.second);
  }
  return wire;
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
  const long long ringAcct = payload.isObject()
      ? static_cast<long long>(payload.get("ctidTraderAccountId").asNumber(0)) : 0;
  const OrderVerdict v = validateOrder(payload, guard_.snapshot());
  if (!v.ok) {
    logLine("order REJECTED by guard: " + v.reason);
    if (telemetry_) {
      telemetry_->log({static_cast<uint64_t>(nowMs()), TK_ORDER_REJECT, symbolId,
                       volume, price, 0, classifyReasonCode(v.reason)});
    }
    if (ring_) ring_->log("order_guard", "refused", ringAcct, symbolId, v.reason);
    return errResult(v.reason, v.reason, false);
  }
  std::string intentTag;
  Ticket ticket;
  {
    // THE SEND BOUNDARY: the fence rechecks and the physical send share this
    // one critical section (plan §8: "mode fencing and physical sends share
    // the execution serialization boundary so an old queued order cannot
    // slip through after a fence acknowledgement"). The WAIT for the
    // broker's answer happens after it, outside the lock.
    std::lock_guard lk(mtx_);
    if (preSendHook_) preSendHook_();
    // SEND-BOUNDARY RECHECK (10-09-2026). The validation above ran BEFORE the
    // mutex: an order could validate, wait behind another order, and be sent
    // after /config had set a halt — the halt was checked against a state
    // that no longer held. The guard is re-read here, under the lock,
    // immediately before the send; nothing can change it in between that
    // this thread does not see.
    {
      const OrderVerdict again = validateOrder(payload, guard_.snapshot());
      if (!again.ok) {
        logLine("order REJECTED by guard at the send boundary (state changed while queued): " + again.reason);
        if (telemetry_) {
          telemetry_->log({static_cast<uint64_t>(nowMs()), TK_ORDER_REJECT, symbolId,
                           volume, price, 0, classifyReasonCode(again.reason)});
        }
        if (ring_) ring_->log("order_guard", "refused_at_send", ringAcct, symbolId, again.reason);
        return errResult(again.reason, again.reason + " (guard changed while the order was queued)", false);
      }
    }
    // P2a PERMIT CHECK (11-09-2026), under the same lock at the same boundary:
    // an entry for an account whose epoch the keeper has fenced must carry a
    // one-use permit from THAT epoch, unexpired, describing THIS order, never
    // seen before — a keeper-placed order and a VPO fire alike (P2a-2).
    {
      const GuardSnapshot gs = guard_.snapshot();
      const PermitVerdict pv = validatePermit(payload, gs, consumedPermits_, nowMs());
      if (!pv.ok) {
        logLine("order REFUSED at the send boundary: " + pv.reason);
        if (telemetry_) {
          telemetry_->log({static_cast<uint64_t>(nowMs()), TK_ORDER_REJECT, symbolId,
                           volume, price, 0, classifyReasonCode(pv.reason)});
        }
        if (ring_) ring_->log("order_guard", "refused_at_send", ringAcct, symbolId, pv.reason,
                              pv.intentId.empty() ? std::string() : "intent=" + pv.intentId);
        return errResult(pv.reason, pv.reason, false);
      }
      if (!pv.permitId.empty()) {
        constexpr size_t kConsumedPermitCap = 4096;
        consumedOrder_.push_back(pv.permitId);
        while (consumedOrder_.size() > kConsumedPermitCap) {
          consumedPermits_.erase(consumedOrder_.front());
          consumedOrder_.pop_front();
        }
      }
      if (!pv.intentId.empty()) intentTag = "intent=" + pv.intentId;
    }
    // The wire payload: the broker must never see the ledger's fields.
    const jsn::Value wire = wireOrderPayload(payload);
    // SUBMIT is logged after the lock is held — with it logged before, the
    // record timestamped a submission that could still be a minute away behind
    // a reconcile sweep (audit #2 note).
    if (telemetry_) {
      telemetry_->log({static_cast<uint64_t>(nowMs()), TK_ORDER_SUBMIT, symbolId,
                       volume, price, 1, 0});
    }
    if (ring_) ring_->log("engine", "order_submit", ringAcct, symbolId, "", intentTag);
    // The account is NOT filled in — validateOrder above has already refused a
    // payload that does not name one (guard_no_account).
    ticket = beginRequest(pt::NEW_ORDER_REQ, wire, pt::EXECUTION_EVENT, RequestClass::Entry);
  }
  EngineResult r = awaitRequest(ticket, 20000);
  if (telemetry_) {
    const std::string reason = r.ok ? "" : r.body.get("errorCode").asString();
    telemetry_->log({static_cast<uint64_t>(nowMs()), TK_ORDER_RESULT, symbolId,
                     volume, price, r.ok ? 1 : 0, classifyReasonCode(reason)});
  }
  if (ring_) {
    // P2a: the result names the intent and the broker's ids, so the keeper's
    // ledger can settle an intent from the ring even when the HTTP reply to
    // it was lost (the ambiguous case the ledger exists for).
    std::string detail = intentTag;
    if (r.ok) {
      const long long orderId = static_cast<long long>(r.body.get("order").get("orderId").asNumber(0));
      const long long positionId = static_cast<long long>(r.body.get("position").get("positionId").asNumber(0));
      if (orderId > 0) detail += (detail.empty() ? "" : " ") + std::string("order=") + std::to_string(orderId);
      if (positionId > 0) detail += (detail.empty() ? "" : " ") + std::string("pos=") + std::to_string(positionId);
    }
    ring_->log("engine", r.ok ? "order_result" : "order_reject", ringAcct, symbolId,
               r.ok ? "" : r.body.get("errorCode").asString(), detail);
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
    if (ring_) ring_->log("order_guard", "refused",
                          static_cast<long long>(payload.get("ctidTraderAccountId").asNumber(0)),
                          static_cast<long long>(payload.get("symbolId").asNumber(0)),
                          "guard_halt", "amend refused during halt");
    return errResult("guard_halt", "execution halted by kill switch — amends refused (closes still allowed)", false);
  }
  // No engine lock: the request is a future, and a protection request must
  // never queue behind an entry's wait for the broker.
  EngineResult r = request(pt::AMEND_POSITION_SLTP_REQ, payload, pt::EXECUTION_EVENT, 15000, RequestClass::Protection);
  // Amends never had telemetry (it covers placeOrder only, a measured gap) —
  // the ring is where amend outcomes become inspectable.
  if (ring_) ring_->log("engine", r.ok ? "amend_result" : "amend_reject",
                        static_cast<long long>(payload.get("ctidTraderAccountId").asNumber(0)),
                        static_cast<long long>(payload.get("symbolId").asNumber(0)),
                        r.ok ? "" : r.body.get("errorCode").asString());
  return r;
}

EngineResult ExecEngine::closePosition(const jsn::Value& payload) {
  if (!hasAccountId(payload)) return errResult("guard_no_account", kNoAccountDesc, false);
  return request(pt::CLOSE_POSITION_REQ, payload, pt::EXECUTION_EVENT, 20000, RequestClass::Protection);
}

EngineResult ExecEngine::cancelOrder(const jsn::Value& payload) {
  if (!hasAccountId(payload)) return errResult("guard_no_account", kNoAccountDesc, false);
  return request(pt::CANCEL_ORDER_REQ, payload, pt::EXECUTION_EVENT, 20000, RequestClass::Protection);
}

EngineResult ExecEngine::reconcileOne(long long accountId) {
  jsn::Value p{jsn::Object{}};
  p.set("ctidTraderAccountId", accountId);
  // 10s: a hung reconcile no longer holds the order path (the request is a
  // future), but the loop's own cadence still wants a tight bound.
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
  // P2b-2: no lock is held across any of it. Before, the mutex was taken per
  // account so a queued close ran after at most one reconcile (audit #2);
  // now a close never queues behind a reconcile at all.
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
    EngineResult r = reconcileOne(id);
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
        if (ring_) ring_->log("engine", "connected", 0, 0, "", std::to_string(accountIds().size()) + " account(s)");
        backoffMs = 1000;
      } else {
        logLine("reconnect in " + std::to_string(backoffMs) + "ms");
        if (ring_) ring_->log("engine", "backoff", 0, 0, "", "reconnect in " + std::to_string(backoffMs) + "ms");
        std::this_thread::sleep_for(milliseconds(backoffMs));
        backoffMs = backoffMs * 2 > kBackoffCapMs ? kBackoffCapMs : backoffMs * 2;
        continue;
      }
    }
    auto r = reconcile();
    if (!r.ok && !r.brokerError)
      continue; // transport problem — loop back into reconnect path
    // Idle between reconcile polls. The heartbeat is the reader's now, so a
    // 1 s slice here only bounds how fast a drop is noticed.
    for (int slept = 0; slept < 30000 && isConnected(); slept += 1000)
      std::this_thread::sleep_for(milliseconds(1000));
  }
}
