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
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "depth_book.hpp"
#include "ws_client.hpp"

// (symbolId, bid, ask) — bid/ask already descaled to real price units.
// Either side may be 0 if the event carried only one side; caller keeps its
// own last-known value the same way wsStreamSpots' callers do.
using SpotTickCallback = std::function<void(long long symbolId, double bid, double ask)>;

class SpotFeed {
public:
  // depthEnabled additionally subscribes the same symbol list to L2 depth
  // quotes (ProtoOASubscribeDepthQuotesReq, 2156 — verified against
  // spotware/openapi-proto-messages). Depth is best-effort: if the broker
  // rejects the subscription the feed logs it and carries on spots-only, so
  // enabling depth can never cost the VPO hot path its ticks.
  SpotFeed(std::string host, std::string clientId, std::string clientSecret,
           std::string accessToken, long long accountId,
           std::vector<long long> symbolIds, SpotTickCallback onTick,
           bool depthEnabled = false);

  // Blocking: connect -> auth -> subscribe -> read frames -> onTick(), with
  // capped exponential backoff across drops. Runs until stop() is called.
  // Call from its own dedicated thread.
  void runLoop();
  void stop();

  // True once the current connection's depth subscription was accepted.
  bool depthActive() const { return depthActive_.load(std::memory_order_relaxed); }

  // Add symbols to the live subscription (trail engine's open-position
  // symbols beyond VPO_SYMBOLS). Thread-safe: ids are queued here and the
  // subscribe frames are sent from the FEED thread on its next loop slice —
  // never from the caller's thread, since the WS is single-consumer.
  // Already-subscribed ids are ignored; queued ids survive reconnects
  // (they're folded into symbolIds_ before sending).
  void ensureSymbols(const std::vector<long long>& ids);

  // Snapshot of a symbol's current book as JSON ("null" when the symbol has
  // no book yet — depth off, subscription rejected, or no events seen).
  // Thread-safe; callable from the HTTP server thread.
  std::string depthSnapshotJson(long long symbolId, int maxLevels);

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

  // L2 depth state. Quote ids are per-subscription, so books are cleared on
  // every (re)connect; depthMtx_ guards books_ between the feed thread
  // (writes) and the HTTP thread (snapshot reads).
  bool depthEnabled_ = false;
  std::atomic<bool> depthActive_{false};
  std::mutex depthMtx_;
  std::map<long long, DepthBook> books_;

  // Dynamic subscription queue (see ensureSymbols).
  std::mutex symMtx_;
  std::vector<long long> pendingSubs_;
  void drainPendingSubs(); // feed thread only
};
