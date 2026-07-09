// cpp-exec/src/engine.hpp
//
// ExecEngine: request/response layer over CtraderWs for the cTrader Open API
// JSON protocol. Payload type constants mirror agent/lib/ctrader-ws.js — that
// file is the protocol source of truth for this repo.
#pragma once

#include <chrono>
#include <mutex>
#include <optional>
#include <string>

#include "json.hpp"
#include "ws_client.hpp"

namespace pt {
constexpr int HEARTBEAT               = 51;
constexpr int APP_AUTH_REQ            = 2100;
constexpr int APP_AUTH_RES            = 2101;
constexpr int ACCOUNT_AUTH_REQ        = 2102;
constexpr int ACCOUNT_AUTH_RES        = 2103;
constexpr int NEW_ORDER_REQ           = 2106;
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
  void setCredentials(std::string host, std::string clientId,
                      std::string clientSecret, std::string accessToken,
                      long long accountId);
  bool hasCredentials();

  // Connect + authApp + authAccount. Serialized with the request methods.
  bool connectAndAuth();

  EngineResult authApp();
  EngineResult authAccount();
  EngineResult placeOrder(const jsn::Value& payload);
  EngineResult amendPosition(const jsn::Value& payload);
  EngineResult closePosition(const jsn::Value& payload);
  EngineResult reconcile();

  bool isConnected();
  std::string lastReconcileJson();   // "" until first successful reconcile
  long long lastReconcileAtMs();     // 0 until first successful reconcile

  // Blocking loop: connect/auth with capped exponential backoff, reconcile
  // every 30s, heartbeat every 25s of idle. Runs until process exit.
  void runLoop();

private:
  // Sends `payload` under `reqType`, then drains frames until `expectType`
  // (or an error frame) arrives. Caller must hold mtx_.
  EngineResult request(int reqType, const jsn::Value& payload, int expectType,
                       int timeoutMs = 20000);
  void handleUnsolicited(const jsn::Value& msg);
  void maybeHeartbeatLocked();

  std::string host_, clientId_, clientSecret_, accessToken_;
  long long accountId_;

  std::mutex mtx_; // serializes all WS access; protocol is strictly req/res here
  CtraderWs ws_;
  bool authed_ = false;
  std::chrono::steady_clock::time_point lastSend_{};

  std::mutex stateMtx_;
  std::string lastReconcile_;
  long long lastReconcileAtMs_ = 0;
};
