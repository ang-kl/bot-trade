// cpp-exec/src/spot_feed.hpp
//
// SpotFeed — a DEDICATED live-tick WS connection, separate from ExecEngine's
// request/response connection. The VPO hot path needs every tick the
// instant it arrives; sharing ExecEngine's single mutex-serialized
// connection would mean a tick that arrives while that connection is
// blocked awaiting an EXECUTION_EVENT/RECONCILE_RES gets silently logged by
// handleUnsolicited() and dropped — never reaching the dispatcher. A second,
// subscribe-only connection avoids that entirely; it never sends order/
// reconcile traffic, so it's always free to read.
//
// Mirrors agent/lib/ctrader-ws.js's wsStreamSpots() handshake (app auth ->
// account auth -> subscribe spots) and its price scaling (bid/ask are wire
// units / 100000) — that file is this protocol's source of truth.
#pragma once

#include <atomic>
#include <functional>
#include <string>
#include <vector>

#include "ws_client.hpp"

// (symbolId, bid, ask) — bid/ask already descaled to real price units.
// Either side may be 0 if the event carried only one side; caller keeps its
// own last-known value the same way wsStreamSpots' callers do.
using SpotTickCallback = std::function<void(long long symbolId, double bid, double ask)>;

class SpotFeed {
public:
  SpotFeed(std::string host, std::string clientId, std::string clientSecret,
           std::string accessToken, long long accountId,
           std::vector<long long> symbolIds, SpotTickCallback onTick);

  // Blocking: connect -> auth -> subscribe -> read frames -> onTick(), with
  // capped exponential backoff across drops. Runs until stop() is called.
  // Call from its own dedicated thread.
  void runLoop();
  void stop();

private:
  // One connect+auth+subscribe+read cycle. Returns when the connection
  // drops or stop() fires; the caller (runLoop) decides whether to retry.
  void runOnce();
  bool connectAuthSubscribe();

  std::string host_, clientId_, clientSecret_, accessToken_;
  long long accountId_;
  std::vector<long long> symbolIds_;
  SpotTickCallback onTick_;
  CtraderWs ws_;
  std::atomic<bool> stopped_{false};
};
