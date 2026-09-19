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
#include <condition_variable>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "depth_book.hpp"
#include "heartbeat.hpp"
#include "ws_client.hpp"

// (symbolId, bid, ask) — bid/ask already descaled to real price units.
// Either side may be 0 if the event carried only one side; caller keeps its
// own last-known value the same way wsStreamSpots' callers do.
using SpotTickCallback = std::function<void(long long symbolId, double bid, double ask)>;

// P3a: the RAW spot event, before any side is carried forward — which sides
// the frame carried and their wire-unit prices, plus the connection
// generation (1 on the first connection, +1 per reconnect). The tick
// recorder taps this; the strategy/trail path keeps SpotTickCallback.
using SpotRawTap = std::function<void(long long symbolId, bool hasBid, long long bid,
                                      bool hasAsk, long long ask, long long generation)>;

// The feed's LATEST quote for one symbol (19-09-2026, fast-monitor quotes
// from the sidecar). bid/ask are descaled price units, carried forward the
// same way SpotTickCallback's callers carry them; a side never seen is 0.
// tsMs is the event's own timestamp when the frame carried one, else the
// local receipt time; recvMs is always the local receipt time — the keeper's
// age check reads recvMs, because it is the clock that says how long ago THIS
// process last heard the symbol, whatever the broker stamped.
struct SpotQuote {
  long long symbolId = 0;
  double bid = 0, ask = 0;
  long long tsMs = 0, recvMs = 0;
};

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

  // Ask the feed thread to finish. Safe from any thread, and it does NOT
  // touch the connection's OpenSSL state — it flags stopped_, half-closes the
  // socket so an in-flight read returns, and wakes the reconnect backoff.
  // The feed thread owns teardown; the caller must join() the thread to know
  // the feed is gone. (Audit C1: stop() used to call ws_.close() from the
  // HTTP thread, which is SSL_free + ::close under a live reader.)
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

  // Total depth-book entries across all symbols — the OOM-leak telemetry
  // (a real book is tens of entries; unbounded growth means quote-id churn
  // is outrunning deletes). Thread-safe.
  size_t depthEntriesTotal();

  // Feed truth for GET /health (2026-08-31 supervision plan): a wedged feed
  // silently freezes both the tick trail and VPO firing, and until these
  // existed nothing outside this object could see it. Facts only — the
  // STALENESS verdict is Node's, which knows market hours; this side cannot.
  bool isConnected() const { return connected_.load(std::memory_order_relaxed); }
  // The account this feed authenticates as — the space its quote table's
  // symbol ids live in (whichever account made the first /connect on this
  // side and stayed in the roster; NOT necessarily what Node calls primary).
  long long accountId() const { return accountId_; }
  long long lastTickAtMs() const { return lastTickAtMs_.load(std::memory_order_relaxed); }
  long long tickCount() const { return tickCount_.load(std::memory_order_relaxed); }
  long long reconnects() const { return reconnects_.load(std::memory_order_relaxed); }
  // (symbolId, lastTickAtMs) pairs — bearer-gated in /health (symbol ids
  // identify what is traded, same reasoning as the accounts redaction).
  std::vector<std::pair<long long, long long>> lastTickBySymbol();
  // Every symbol's latest quote (a copy; symbolId ascending). Thread-safe;
  // for GET /quotes so the keeper's fast monitor can price its open
  // positions from a feed this process already holds instead of one broker
  // round trip per position.
  std::vector<SpotQuote> latestQuotes();

  // Refresh the credentials the NEXT connect will use, without disturbing
  // the live one.
  //
  // WHY THIS EXISTS. Every POST /connect used to tear this feed down and
  // build a new one, and with the tick recorder enabled that teardown was
  // unconditional. A new SpotFeed starts at generation 1, and the recorder
  // writes a GAP on every generation change (tick_recorder.cpp) — so a
  // CREDENTIAL ROTATION, which this feed's live connection does not care
  // about at all, cost a hole in the tick record and a 53-symbol
  // resubscribe. Measured 17-09: two feed restarts inside three minutes,
  // neither of them caused by anything the feed depends on.
  //
  // An already-authenticated WS session stays authenticated when the token
  // behind it rotates; only the next connect needs the new one. So the new
  // credentials are stored and the socket is left alone.
  //
  // Host and accountId are deliberately NOT updatable: both are baked into a
  // live subscription, so changing either is a real restart and the caller
  // must rebuild the feed.
  //
  // @returns whether anything actually changed.
  bool updateCredentials(const std::string& clientId, const std::string& clientSecret,
                         const std::string& accessToken);

  // Optional decision ring (invariant 1): connect/drop transitions are
  // decisions worth persisting. Non-owning; null = disabled. Set before the
  // feed thread starts.
  void setDecisionRing(class DecisionRing* r) { ring_ = r; }
  // P3a: the recorder's tap on the raw event. Set before the feed thread starts.
  void setRawTap(SpotRawTap t) { rawTap_ = std::move(t); }
  // The symbols this feed subscribes to (current + queued). Thread-safe; for
  // /health so the keeper can see whether its tick symbols are carried.
  std::vector<long long> subscribedSymbols();

  // TEST SEAMS (11-09-2026 audit, feed heartbeat): plain TCP to
  // 127.0.0.1:port instead of TLS to the host, and the idle bound before a
  // heartbeat (default kHeartbeatIdleSeconds), so the heartbeat path can be
  // exercised against the fake broker in seconds.
  void setLoopbackTransportForTests(int port) { loopbackPort_ = port; }
  void setHeartbeatIdleMsForTests(int ms) { heartbeatIdleMs_.store(ms); }

private:
  // One connect+auth+subscribe+read cycle. Returns when the connection
  // drops or stop() fires; the caller (runLoop) decides whether to retry.
  void runOnce();
  bool connectAuthSubscribe();

  std::string host_;
  long long accountId_;
  // Guarded by credsMtx_: written by updateCredentials() on the HTTP thread,
  // read by connectAuthSubscribe() on the feed thread. host_ and accountId_
  // are const-after-construction and need no lock.
  mutable std::mutex credsMtx_;
  std::string clientId_, clientSecret_, accessToken_;
  std::vector<long long> symbolIds_;
  SpotTickCallback onTick_;
  CtraderWs ws_;
  std::atomic<bool> stopped_{false};
  int loopbackPort_ = 0;                                       // tests only
  std::atomic<int> heartbeatIdleMs_{kHeartbeatIdleSeconds * 1000};

  // The reconnect backoff sleeps up to 60s. Sleeping on this instead of
  // this_thread::sleep_for means stop() returns the thread promptly rather
  // than leaving /connect's join() blocked for up to a minute (audit C2).
  std::mutex stopMtx_;
  std::condition_variable stopCv_;

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

  // Feed truth (see accessors above). tickMtx_ guards only the per-symbol
  // map; the scalars are atomics stamped on the tick path — two relaxed
  // stores per tick, no lock.
  std::atomic<bool> connected_{false};
  std::atomic<long long> lastTickAtMs_{0};
  std::atomic<long long> tickCount_{0};
  std::atomic<long long> reconnects_{0};
  std::mutex tickMtx_;
  std::map<long long, long long> lastTickBySymbol_;
  std::map<long long, SpotQuote> latestQuotes_; // guarded by tickMtx_; survives reconnects (recvMs says how old)
  class DecisionRing* ring_ = nullptr;
  SpotRawTap rawTap_;
};
