// cpp-exec/src/engine.hpp
//
// ExecEngine: request/response layer over CtraderWs for the cTrader Open API
// JSON protocol. Payload type constants mirror agent/lib/ctrader-ws.js — that
// file is the protocol source of truth for this repo.
#pragma once

#include <chrono>
#include <map>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

#include "json.hpp"
#include "ws_client.hpp"
#include "order_guard.hpp"
#include "telemetry.hpp"

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
constexpr int RECONCILE_REQ           = 2124;
constexpr int RECONCILE_RES           = 2125;
constexpr int EXECUTION_EVENT         = 2126;
constexpr int ORDER_ERROR_EVENT       = 2132;
constexpr int ERROR_RES               = 2142;
} // namespace pt

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

  // Connect + authApp + authAccount for every account. Serialized with the
  // request methods.
  bool connectAndAuth();

  EngineResult authApp();
  EngineResult authAccount();
  EngineResult placeOrder(const jsn::Value& payload);
  EngineResult amendPosition(const jsn::Value& payload);
  EngineResult closePosition(const jsn::Value& payload);
  EngineResult cancelOrder(const jsn::Value& payload);
  EngineResult reconcile();

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

  // Blocking loop: connect/auth with capped exponential backoff, reconcile
  // every 30s, heartbeat every 25s of idle. Runs until process exit.
  void runLoop();

private:
  // Sends `payload` under `reqType`, then drains frames until `expectType`
  // (or an error frame) arrives. Caller must hold mtx_.
  EngineResult request(int reqType, const jsn::Value& payload, int expectType,
                       int timeoutMs = 20000);
  // ACCOUNT_AUTH_REQ for one id. Caller must hold mtx_.
  EngineResult authAccountLocked(long long accountId);
  // Reconcile one id. Caller must hold mtx_.
  EngineResult reconcileLocked(long long accountId);
  void handleUnsolicited(const jsn::Value& msg);
  void maybeHeartbeatLocked();
  long long primaryAccountLocked() const {
    return accountIds_.empty() ? 0 : accountIds_.front();
  }

  std::string host_, clientId_, clientSecret_, accessToken_;
  std::vector<long long> accountIds_; // primary first, then extras

  std::mutex mtx_; // serializes all WS access; protocol is strictly req/res here
  CtraderWs ws_;
  bool authed_ = false;
  std::chrono::steady_clock::time_point lastSend_{};

  std::mutex stateMtx_;
  struct ReconcileSnap { std::string json; long long atMs = 0; };
  std::map<long long, ReconcileSnap> reconcileByAccount_;

  OrderGuard guard_; // atomic knobs read on the order hot path
  Telemetry* telemetry_ = nullptr; // non-owning; null = disabled
};
