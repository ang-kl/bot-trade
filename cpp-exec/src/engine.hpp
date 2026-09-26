// cpp-exec/src/engine.hpp
//
// ExecEngine: request/response layer over CtraderWs for the cTrader Open API
// JSON protocol. Payload type constants mirror agent/lib/ctrader-ws.js — that
// file is the protocol source of truth for this repo.
//
// P2b-2 (11-09-2026, docs/tick-momentum/plan.md §8 "one asynchronous
// broker-session owner ... with one serialized physical writer"; register
// TM-24): the session is ASYNC. A reader thread owns the socket's inbound
// side for the life of a connection; every request is a future keyed by its
// clientMsgId — registered, sent under the writer lock, then awaited OUTSIDE
// the execution mutex. Before this, request() read the socket inline under
// mtx_ until its own answer arrived, so a close waited behind a slow order
// or a reconcile for up to 20 s (head-of-line blocking), and a frame that
// arrived while nothing was waiting was only seen by whichever request came
// next. Now: requests resolve independently and in any order; a frame that
// answers a request which already gave up is journaled as a LATE frame under
// its clientMsgId (the keeper settles the UNKNOWN intent from it); a
// disconnect fails every request in flight at once; the heartbeat comes from
// the reader, which is always awake.
#pragma once

#include <atomic>
#include <chrono>
#include <deque>
#include <functional>
#include <future>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "decision_ring.hpp"
#include "event_journal.hpp"
#include "heartbeat.hpp"
#include "json.hpp"
#include "request_pacer.hpp"
#include "ws_client.hpp"
#include "order_guard.hpp"
#include "telemetry.hpp"

// What an auth-family broker error should cost.
//
// Production incident 2026-08-04: authorizing an EXTRA account that the token
// does not cover returned CH_ACCESS_TOKEN_INVALID, the session-level handler
// read that as "the token is dead", closed the socket — and the sidecar
// reconnected roughly once a second for as long as that account stayed in the
// roster. Two handlers, each right on its own, disagreeing about whose fact
// the error was.
//
// Pure and free-standing so the rule can be tested without a broker socket.
enum class AuthErrorAction { Ignore, SkipAccount, KillSession };
bool isAuthFamilyError(const std::string& code);
AuthErrorAction authErrorAction(const std::string& code, bool authorizingExtra);

// ---------------------------------------------------------------------------
// HOST PIN (two-sidecar plan, Phase 3).
//
// One ExecEngine holds one host_ for its whole life: setCredentials REPLACES it
// and tears the session down. So a live and a demo account cannot share a
// process, and on 05-08 they did not — all four demo accounts sat enabled in
// the registry and absent from the single sidecar's roster, and no trade opened
// for twelve hours.
//
// Node now routes by host (execBaseFor) and every roster consumer is
// side-aware. This is the other half: the sidecar REFUSES a /connect that
// disagrees with the host it was deployed to serve. Enforcement at the
// boundary, not trust in the caller — the same reasoning as withAccount()
// making the sidecar's default account unreachable from Node.
//
// `pinned` empty = UNPINNED = today's single-sidecar deployment, where anything
// is allowed and nothing changes. An empty `requested` is allowed too, and the
// caller substitutes the pin: a pinned sidecar must never fall back to the
// hardcoded "live.ctraderapi.com" default, which is how a demo process would
// quietly connect to the LIVE broker.
//
// Pure and free-standing so the rule can be tested without a broker socket.
bool connectHostAllowed(const std::string& pinned, const std::string& requested);
// The host to actually connect with. Empty result means refuse — callers must
// consult connectHostAllowed first.
std::string effectiveConnectHost(const std::string& pinned, const std::string& requested);

namespace pt {
constexpr int HEARTBEAT               = 51;
constexpr int APP_AUTH_REQ            = 2100;
constexpr int APP_AUTH_RES            = 2101;
constexpr int ACCOUNT_AUTH_REQ        = 2102;
constexpr int ACCOUNT_AUTH_RES        = 2103;
constexpr int NEW_ORDER_REQ           = 2106;
constexpr int CANCEL_ORDER_REQ        = 2108;
constexpr int AMEND_POSITION_SLTP_REQ = 2110;
constexpr int CLOSE_POSITION_REQ      = 2111;
constexpr int SYMBOL_CHANGED_EVENT    = 2120;
constexpr int RECONCILE_REQ           = 2124;
constexpr int RECONCILE_RES           = 2125;
constexpr int EXECUTION_EVENT         = 2126;
constexpr int ORDER_ERROR_EVENT       = 2132;
constexpr int ERROR_RES               = 2142;
} // namespace pt

// P2a: the order as the broker receives it — ledger fields stripped.
jsn::Value wireOrderPayload(const jsn::Value& payload);

struct EngineResult {
  bool ok = false;
  // On success: the response payload JSON. On failure: {errorCode, description}.
  jsn::Value body;
  bool brokerError = false; // true when the broker answered with an error frame
};

class ExecEngine {
public:
  ExecEngine(std::string host, std::string clientId, std::string clientSecret,
             std::string accessToken, long long accountId);
  // Credentials arrive at runtime (POST /connect from the Node keeper —
  // access token + account id live in the keeper's DB, not env vars).
  ExecEngine() = default;
  // Stops the reader thread (wake + join) — a connection never outlives its
  // owner.
  ~ExecEngine();
  ExecEngine(const ExecEngine&) = delete;
  ExecEngine& operator=(const ExecEngine&) = delete;

  // M2 multi-account (plan C1): ONE trade connection can authorize several
  // ctidTraderAccountIds under the same cTID access token. `accountId` is
  // the primary (first) account; `extraAccountIds` join it on the same
  // session. Pushing the SAME host+clientId+token with a new account id is
  // an incremental ProtoOAAccountAuthReq on the live session — no reconnect,
  // no disruption to the other accounts' orders.
  void setCredentials(std::string host, std::string clientId,
                      std::string clientSecret, std::string accessToken,
                      long long accountId,
                      std::vector<long long> extraAccountIds = {});
  bool hasCredentials();

  // The full authorized-account roster (primary first). For /health.
  std::vector<long long> accountIds();
  // B2 (18-09-2026): the accounts the keeper REQUESTED that this session
  // could not authorize (the token does not cover them). Empty before a
  // session exists — nothing has been refused yet, only not tried. Node's
  // roster-drift check reads it so "requested, tried, refused" is not
  // re-pushed and logged as a correction every probe.
  std::vector<long long> refusedAccountIds();

  // Connect, start the reader, authApp + authAccount for every account.
  // Serialized with setCredentials by mtx_; the reader needs no lock, so the
  // auth round trips complete while it is held.
  bool connectAndAuth();

  EngineResult authApp();
  EngineResult authAccount();
  EngineResult placeOrder(const jsn::Value& payload);
  EngineResult amendPosition(const jsn::Value& payload);
  EngineResult closePosition(const jsn::Value& payload);
  EngineResult cancelOrder(const jsn::Value& payload);
  EngineResult reconcile();

  // Lock-free (two atomics): /health never waits behind a request.
  bool isConnected();
  std::string lastReconcileJson();   // primary account; "" until first success
  long long lastReconcileAtMs();     // primary account; 0 until first success
  // Per-account variants (M2): "" / 0 for an account never reconciled.
  std::string lastReconcileJson(long long accountId);
  long long lastReconcileAtMs(long long accountId);

  // Atomic hot-reconfig block (#3): the HTTP thread flips these WITHOUT
  // locking the execution thread; placeOrder reads a lock-free snapshot.
  OrderGuard& guard() { return guard_; }

  // Optional order telemetry sink (item #2 follow-up, owner-directed
  // 2026-07-22: "wire it into main.cpp so the mounted volume is actually
  // used"). Not owned — main.cpp constructs the Telemetry against the
  // deployment's volume mount and keeps it alive for the process lifetime.
  // Left null (default) when TELEMETRY_PATH isn't configured; every call
  // site below null-checks before logging, so telemetry is fully optional
  // and never on the hot path when disabled.
  void setTelemetry(Telemetry* t) { telemetry_ = t; }
  Telemetry* telemetry() const { return telemetry_; }

  // Optional decision ring (owner invariant 1, 2026-08-31): every decision
  // this engine takes — guard refusal, order result, reconnect, auth-error
  // classification — lands as a structured record the Node keeper pulls and
  // persists. Same plumbing contract as telemetry: non-owning, null =
  // disabled, every call site null-checks.
  void setDecisionRing(DecisionRing* r) { ring_ = r; }

  // TEST SEAM (10-09-2026): runs under mtx_ right before the send-boundary
  // guard recheck in placeOrder(), so a test can flip the halt while the
  // order is "queued" — the interleaving the recheck exists for.
  void setPreSendHookForTests(std::function<void()> h) { preSendHook_ = std::move(h); }
  // GW-1 (WP-D D3, gap 1c): called once per entry that passed the send
  // boundary WITH a permit, after the send, OUTSIDE mtx_ (no new lock-order
  // edge), with the account and the order's label — the tick firer spends
  // one of the account's slots for every non-tick entry between the
  // keeper's pushes. Set once at startup, before any order is placed.
  void setEntrySentHook(std::function<void(long long, const std::string&)> h) { entrySentHook_ = std::move(h); }
  // P2b-1: every execution-event frame is journaled for the keeper (non-owning;
  // null = off), and every request draws a token from the pacer first.
  void setEventJournal(EventJournal* j) { journal_ = j; }
  void setPacer(RequestPacer* p) { pacer_ = p; }

  // P2b-2 TEST SEAMS — the fake-broker harness (src/tests/fake_broker.hpp).
  // Plain TCP to 127.0.0.1:port instead of TLS to host:5036; main.cpp never
  // calls this, so production is always TLS to the pinned host.
  void setLoopbackTransportForTests(int port) { loopbackPort_ = port; }
  // The idle bound before the reader sends a heartbeat (default
  // kHeartbeatIdleSeconds) and the per-request timeout override (0 = each
  // call's own), so the late-frame and heartbeat paths can be exercised in
  // seconds rather than minutes.
  void setHeartbeatIdleMsForTests(int ms) { heartbeatIdleMs_.store(ms); }
  void setRequestTimeoutMsForTests(int ms) { requestTimeoutOverrideMs_.store(ms); }
  // The in-flight cap for entries and reads (default kMaxInFlightDefault);
  // protection is never capped. Configured from EXEC_MAX_IN_FLIGHT in main.
  void setMaxInFlight(int n) { maxInFlight_.store(n < 1 ? 1 : n); }

  // Session facts for /health (P2b-2): the reader's state and the counters
  // that tell "nothing happened" apart from "the path is dead".
  struct SessionStats {
    bool readerRunning = false;
    size_t pending = 0;          // requests in flight right now
    long long generation = 0;    // connections started this process
    uint64_t framesIn = 0;       // parsed frames the reader dispatched
    uint64_t lateFrames = 0;     // answers to requests that had given up (journaled)
    uint64_t unsolicited = 0;    // frames matching no request (journaled if execution events)
    uint64_t timeouts = 0;       // requests that gave up
    uint64_t heartbeatsSent = 0;
    uint64_t disconnects = 0;    // reader exits after a connection was up
    // 11-09-2026 audit (investigation F1c / F5b): the in-flight cap and the
    // broker's retryAfter, both honoured before anything is written.
    uint64_t inFlightRefused = 0; // entries/reads refused because the cap was reached
    uint64_t deferrals = 0;       // retryAfter pauses the broker asked for
    long long deferredMsRemaining = 0; // of the current pause (0 = none)
    int maxInFlight = 0;
  };
  SessionStats sessionStats();

  // Blocking loop: connect/auth with capped exponential backoff, reconcile
  // every 30s. Runs until process exit. The heartbeat is the reader's.
  void runLoop();

private:
  // All sidecar SL/TP writers share a position lock. Weak entries are pruned
  // so closed positions do not grow an unbounded lock registry.
  std::mutex protectionLocksMtx_;
  std::map<std::pair<long long, long long>, std::weak_ptr<std::mutex>> protectionLocks_;
  std::shared_ptr<std::mutex> protectionLock(long long accountId, long long positionId);
  // One request in flight: its id, what answers it, and the promise the
  // reader settles. `extraAuth` marks an EXTRA account's ACCOUNT_AUTH so an
  // auth-family rejection there is charged to that account, not the session
  // every other account is trading on (see authErrorAction) — a per-request
  // fact now, not an engine-wide flag, because several requests can be in
  // flight at once.
  struct Pending {
    std::string msgId;
    int expectType = 0;
    bool extraAuth = false;
    std::promise<EngineResult> promise;
    std::atomic<bool> done{false};
    void settle(EngineResult r);   // first caller wins; later calls are no-ops
  };
  struct Ticket {
    std::shared_ptr<Pending> p;
    std::future<EngineResult> fut;
    bool failed = false;           // refused before or at the send (early holds why)
    EngineResult early;
  };
  // Registers the request, sends the frame (the one serialized writer —
  // CtraderWs::sendText), returns the ticket to await. Refusals that
  // provably did not reach the wire (NOT_CONNECTED, rate_limited,
  // SEND_FAILED) come back in the ticket. Callers that must fence and send
  // atomically (placeOrder) call this under mtx_; nobody awaits under it.
  Ticket beginRequest(int reqType, const jsn::Value& payload, int expectType,
                      RequestClass cls, bool extraAuth = false);
  // Waits for the reader to settle the ticket. On timeout the pending entry
  // is withdrawn, so a late answer is journaled as unsolicited (with its
  // clientMsgId) instead of delivered to nobody; the TIMEOUT body carries
  // the clientMsgId for the keeper's ledger.
  EngineResult awaitRequest(Ticket& t, int timeoutMs);
  // beginRequest + awaitRequest, for callers holding no lock.
  EngineResult request(int reqType, const jsn::Value& payload, int expectType,
                       int timeoutMs = 20000, RequestClass cls = RequestClass::Read,
                       bool extraAuth = false);
  // ACCOUNT_AUTH_REQ for one id. Caller must hold mtx_.
  EngineResult authAccountLocked(long long accountId, bool extra);
  // Reconcile one id (no lock needed: the request is a future).
  EngineResult reconcileOne(long long accountId, int timeoutMs = 10000,
                            RequestClass cls = RequestClass::Read);

  // The reader thread: recvText slices, heartbeat, dispatch. Owns teardown.
  void readerLoop(long long generation);
  void dispatchFrame(const jsn::Value& msg);
  void handleUnsolicited(const jsn::Value& msg);
  void failAllPending(const std::string& code, const std::string& desc);
  // Caller must hold mtx_ (connect / drop are serialized with setCredentials).
  void startReaderLocked();
  void stopReaderLocked();   // wake + join; the reader tears the socket down
  long long primaryAccountLocked() const {
    // The requested roster answers "who should we be" (hasCredentials runs
    // before any auth); the authorized roster is a per-session subset of it.
    if (!requestedAccountIds_.empty()) return requestedAccountIds_.front();
    return accountIds_.empty() ? 0 : accountIds_.front();
  }

  // Auth-family broker errors mean the session is dead no matter what
  // /health's socket state says — force a reconnect+reauth. Runs on the
  // READER thread (the socket's owner), which is why it may close the
  // socket directly.
  void noteBrokerError(const std::string& errorCode, bool extraAuth);

  std::string host_, clientId_, clientSecret_, accessToken_;
  // requestedAccountIds_ is what the keeper ASKED for (primary first);
  // accountIds_ is what THIS session actually authorized. Kept separate so a
  // transient auth failure on an extra account is retried on the next
  // reconnect instead of silently shrinking the roster forever (audit #5).
  std::vector<long long> requestedAccountIds_;
  std::vector<long long> accountIds_; // authorized this session, primary first

  // mtx_ serializes the engine's STATE (credentials, roster, connect/drop,
  // the send-boundary section of placeOrder) — never a wait for the broker.
  std::mutex mtx_;
  CtraderWs ws_;
  std::atomic<bool> authed_{false};

  // The requests in flight, keyed by clientMsgId. Monotonic msgSeq_ so every
  // response is matched to ITS request — pairing by payloadType alone
  // returned buffered/unsolicited execution events as the current call's
  // success (audit #1).
  std::mutex pendingMtx_;
  std::map<std::string, std::shared_ptr<Pending>> pending_;
  long long msgSeq_ = 0;             // under pendingMtx_

  std::thread reader_;
  std::atomic<bool> readerRunning_{false};
  std::atomic<long long> generation_{0};
  std::atomic<long long> lastSendMs_{0};   // steady-clock ms of the last frame written
  std::atomic<int> heartbeatIdleMs_{kHeartbeatIdleSeconds * 1000};
  std::atomic<int> requestTimeoutOverrideMs_{0};
  // 11-09-2026: bounded in-flight work (the investigation's "up to eight
  // requests in flight") and the broker's retryAfter (ProtoOAErrorRes,
  // seconds until the blocked payload type is unlocked), which defers every
  // entry and read — never protection — until it has elapsed.
  static constexpr int kMaxInFlightDefault = 8;
  std::atomic<int> maxInFlight_{kMaxInFlightDefault};
  std::atomic<long long> deferUntilMs_{0};   // steady-clock ms; 0 = no pause
  std::atomic<uint64_t> inFlightRefused_{0}, deferrals_{0};
  void noteRetryAfter(const jsn::Value& errorPayload); // reader thread
  int loopbackPort_ = 0;                   // tests only: plain TCP to 127.0.0.1:port
  std::atomic<uint64_t> framesIn_{0}, lateFrames_{0}, unsolicited_{0}, timeouts_{0},
                        heartbeatsSent_{0}, disconnects_{0};

  std::mutex stateMtx_;
  struct ReconcileSnap { std::string json; long long atMs = 0; };
  std::map<long long, ReconcileSnap> reconcileByAccount_;

  OrderGuard guard_; // atomic knobs read on the order hot path
  Telemetry* telemetry_ = nullptr; // non-owning; null = disabled
  std::function<void()> preSendHook_;
  std::function<void(long long, const std::string&)> entrySentHook_;
  DecisionRing* ring_ = nullptr;   // non-owning; null = disabled
  EventJournal* journal_ = nullptr; // P2b-1; non-owning; null = off
  RequestPacer* pacer_ = nullptr;   // P2b-1; non-owning; null = unpaced
  // P2a: redeemed permit ids, bounded (the deque keeps insertion order so the
  // oldest are forgotten first). Read and written under mtx_ only.
  std::set<std::string> consumedPermits_;
  std::deque<std::string> consumedOrder_;
};
