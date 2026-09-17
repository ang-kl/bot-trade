// cpp-exec/src/main.cpp
//
// Sidecar entrypoint: one engine thread (connect + auth + heartbeat + 30s
// reconcile poll) and the HTTP server on the main thread. All env-driven —
// no config files, matching how the Node keeper is configured on Railway.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "backtest.hpp"
#include "decision_ring.hpp"
#include "engine.hpp"
#include "heartbeat.hpp"
#include "tick_recorder.hpp"
#include "tick_segment_routes.hpp"
#include "tick_firer.hpp"
#include "tick_shadow.hpp"
#include "tick_strategy.hpp"
#include "tick_workers.hpp"
#include "event_journal.hpp"
#include "request_pacer.hpp"
#include "peer_probe.hpp"
#include "http_server.hpp"
#include "json.hpp"
#include "spot_feed.hpp"
#include "telemetry.hpp"
#include "trail_engine.hpp"
#include "vpo_config_store.hpp"
#include "vpo_dispatcher.hpp"
#include "vpo_strategies.hpp"

static void logLine(const std::string& msg) {
  std::fprintf(stderr, "[cpp-exec] %s\n", msg.c_str());
}

// Crash handler (2026-07-24 staging incident: the sidecar died repeatedly
// with ZERO log output — a naked SIGSEGV kills the process before anything
// prints, so every restart was unattributable). On fatal signals, write the
// signal name and a raw backtrace to stderr with async-signal-safe calls
// only, then re-raise so the exit code stays honest. Symbol names may be
// mangled/bare addresses in a stripped binary — addresses are still enough
// to map against the build with addr2line.
#include <csignal>
#include <execinfo.h>
#include <unistd.h>
extern "C" void fatalSignalHandler(int sig) {
  const char* name = sig == SIGSEGV ? "SIGSEGV" : sig == SIGABRT ? "SIGABRT"
                   : sig == SIGBUS ? "SIGBUS" : sig == SIGFPE ? "SIGFPE" : "FATAL";
  // write() is async-signal-safe; fprintf is not.
  (void)!write(STDERR_FILENO, "[cpp-exec] FATAL ", 17);
  (void)!write(STDERR_FILENO, name, std::strlen(name));
  (void)!write(STDERR_FILENO, " — backtrace:\n", 16);
  void* frames[48];
  const int n = backtrace(frames, 48);
  backtrace_symbols_fd(frames, n, STDERR_FILENO);
  signal(sig, SIG_DFL);
  raise(sig);
}
static void installCrashHandler() {
  for (int sig : { SIGSEGV, SIGABRT, SIGBUS, SIGFPE }) signal(sig, fatalSignalHandler);
  // SIGPIPE IS NOT A CRASH (11-09-2026, measured on the demo sidecar): a
  // write to a socket whose peer has hung up raises SIGPIPE, whose default
  // action is to terminate the process silently. The plain-TCP path sends
  // with MSG_NOSIGNAL, but the TLS path goes through OpenSSL's socket BIO,
  // which does not — and since the async session (P2b-2) the reader thread
  // heartbeats on a socket the keeper's next /connect may have just dropped.
  // The demo sidecar restarted every one to two minutes after the #886
  // deploy with "Broken pipe" as the last line each time (the live sidecar,
  // with one /connect at boot, did not). Ignored process-wide, the write
  // returns EPIPE and the existing error path closes the session honestly.
  signal(SIGPIPE, SIG_IGN);
}

static std::string envOr(const char* name, const std::string& dflt) {
  const char* v = std::getenv(name);
  return v && *v ? v : dflt;
}

static std::string requireEnv(const char* name, bool& ok) {
  const char* v = std::getenv(name);
  if (!v || !*v) {
    logLine(std::string("missing required env ") + name);
    ok = false;
    return "";
  }
  return v;
}

// Shared handler shape: parse body -> engine call -> JSON out. 502 carries
// the broker's errorCode/description so the keeper can branch on it.
static HttpResponse forward(const std::string& body,
                            EngineResult (ExecEngine::*fn)(const jsn::Value&),
                            ExecEngine& engine) {
  auto parsed = jsn::parse(body);
  if (!parsed || !parsed->isObject())
    return {400, "{\"error\":\"body must be a JSON object\"}"};
  EngineResult r = (engine.*fn)(*parsed);
  if (r.ok) return {200, jsn::dump(r.body)};
  return {502, jsn::dump(r.body)};
}

// Shared by CLI mode and POST /backtest: JSON payload in -> JSON result out.
static HttpResponse handleBacktest(const std::string& body) {
  if (body.size() > 5u * 1024 * 1024)
    return {413, "{\"error\":\"payload too large (max 5MB)\"}"};
  auto parsed = jsn::parse(body);
  if (!parsed || !parsed->isObject())
    return {400, "{\"error\":\"body must be a JSON object\"}"};
  std::string err;
  jsn::Value out = bt::runBacktestPayload(*parsed, err);
  if (!err.empty())
    return {400, "{\"error\":\"" + err + "\"}"};
  return {200, jsn::dump(out)};
}

int main(int argc, char** argv) {
  installCrashHandler();
  // CLI mode: `cpp-exec --backtest` reads one JSON object from stdin and
  // writes {trades,stats,wf} to stdout. Checked BEFORE env validation —
  // this mode needs no EXEC_SECRET (tests / parity harness).
  if (argc > 1 && std::strcmp(argv[1], "--backtest") == 0) {
    std::string input((std::istreambuf_iterator<char>(std::cin)),
                      std::istreambuf_iterator<char>());
    HttpResponse res = handleBacktest(input);
    if (res.status != 200) {
      std::fprintf(stderr, "%s\n", res.body.c_str());
      return 1;
    }
    std::fwrite(res.body.data(), 1, res.body.size(), stdout);
    std::fputc('\n', stdout);
    return 0;
  }

  bool ok = true;
  // The ONLY required env var. Broker credentials are pushed at runtime by
  // the Node keeper via POST /connect — the access token and account id live
  // in the keeper's DB (Connect tab), not in anyone's env. CTRADER_* env
  // vars still work as an optional pre-seed for standalone runs.
  std::string execSecret = requireEnv("EXEC_SECRET", ok);
  int port = std::atoi(envOr("PORT", "8091").c_str());
  if (!ok) return 1;

  // Order telemetry: append-only binary log of every order submit/reject/
  // result, meant to live on the Railway volume mounted for this service
  // (owner 2026-07-22: the volume was provisioned but nothing wrote to it —
  // Telemetry existed and was tested but was never constructed here). Optional
  // by design: unset TELEMETRY_PATH (no volume configured, or a standalone
  // run) leaves the engine's telemetry_ pointer null and every log() call
  // site is a no-op, so this is safe to leave off in any environment.
  std::string telemetryPath = envOr("TELEMETRY_PATH", "");
  std::unique_ptr<Telemetry> telemetry;
  if (!telemetryPath.empty()) {
    telemetry = std::make_unique<Telemetry>(4096, telemetryPath);
    logLine("order telemetry -> " + telemetryPath);
  } else {
    logLine("TELEMETRY_PATH not set — order telemetry disabled");
  }

  // 4096 slots (was 256): the tick path rings a signal and a shadow close
  // per event per symbol plus a fire line per account, and the keeper pulls
  // every ~2 min — an evicted order_submit/order_result would leave an
  // intent nothing can settle (RACE CHECKER 11-09-2026).
  DecisionRing decisionRing(4096);
  const long long startedAtMs = static_cast<long long>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::system_clock::now().time_since_epoch()).count());
  // The engine is constructed before the tick block (P6b): the tick firer
  // places through it, so it must outlive the workers that queue fires.
  ExecEngine engine;
  if (telemetry) engine.setTelemetry(telemetry.get());
  engine.setDecisionRing(&decisionRing);
  // P3a: the bounded tick recorder (docs/tick-momentum/plan.md §10-§11).
  // Constructed only when TICK_SPOOL_PATH names a directory on this
  // service's volume, and even then it writes nothing until the keeper
  // switches recording on (POST /config tickRecord:true) — OFF by default at
  // both layers. The switch, the counters and the mount's free bytes are on
  // GET /tick-status and summarised in /health.
  const std::string tickSpoolPath = envOr("TICK_SPOOL_PATH", "");
  std::unique_ptr<tick::TickRecorder> tickRecorder;
  if (!tickSpoolPath.empty()) {
    tick::RecorderConfig rc;
    rc.spoolDir = tickSpoolPath;
    const std::string feedHost = envOr("CTRADER_HOST", "unpinned");
    rc.feedId = feedHost;
    rc.environment = feedHost.find("demo") != std::string::npos ? 0 : 1;
    tickRecorder = std::make_unique<tick::TickRecorder>(rc);
    if (tickRecorder->start()) {
      logLine("tick recorder: spool " + tickSpoolPath + " (" + std::to_string(rc.segmentBytes >> 20) + " MiB segments, " +
              std::to_string(rc.spoolCapBytes >> 30) + " GiB cap, reserve >= " + std::to_string(rc.reserveMinBytes >> 30) +
              " GiB or " + std::to_string(rc.reservePct) + "% of the mount) — OFF until the keeper switches recording on");
    } else {
      logLine("tick recorder: NOT started — " + tickRecorder->stats().reason + " (recording stays off)");
    }
  } else {
    logLine("TICK_SPOOL_PATH not set — tick recorder disabled");
  }
  // P3b: the symbol workers (plan §8, TM-22/TM-23) — TICK_WORKERS threads
  // (default 2), each owning a fixed shard of symbols, fed the same
  // classified observation the recorder saw. No strategy consumes them yet
  // (P4); until then the consumer counts, and /tick-status shows the shape.
  std::unique_ptr<tick::SymbolWorkers> tickWorkers;
  std::atomic<uint64_t> tickWorkerEvents{0};
  // P4: the strategy runs on the workers in SHADOW only — one
  // tick_momentum_breakout per symbol, per worker (a symbol lives on one
  // worker, so no lock is shared between workers), switched by /config
  // tickShadow from the keeper (an account in tick observation SHADOW).
  // Every signal is rung and counted; nothing is placed — the entry path
  // (P6) does not exist yet. Symbol price increments are unknown here, so
  // the buffer floor is 4 wire units (the reference's priceIncrement 1).
  std::atomic<bool> tickShadow{false};
  std::atomic<uint64_t> tickSignals{0}, tickSignalsBuy{0}, tickSignalsSell{0}, tickLastSignalMs{0};
  // Each worker OWNS its map; no other thread touches it. A shadow switch-off
  // asks for a reset by bumping tickStratReset, and each worker clears its
  // own bank when it next runs and sees a new value (11-09-2026 audit: the
  // HTTP thread used to clear the maps under a mutex the workers never
  // took — a data race on the very maps they were reading).
  std::atomic<uint64_t> tickStratReset{0};
  std::vector<uint64_t> tickStratSeen;
  std::vector<std::map<long long, tick::TickMomentumStrategy>> tickStrategies;
  const tick::StrategyParams tickParams; // v1 baseline (research-profile.json)
  // P6a: the shadow's OWN simulated portfolio (plan §2) — one ShadowBook per
  // symbol beside its strategy, on the same worker, filled and exited by the
  // reference replayer's rules event by event; closed trades go to the
  // process ledger the keeper pulls (POST /tick-shadow). Nothing is placed.
  // The sim parameters are the replayer's defaults; the keeper may set them
  // through /config tickShadowSim (declarative, applied to NEW books).
  std::vector<std::map<long long, tick::ShadowBook>> tickBooks;
  tick::ShadowLedger tickShadowLedger(4096);
  std::mutex tickSimMtx;
  tick::ShadowSim tickSim;
  std::atomic<uint64_t> tickShadowOpen{0}, tickShadowRejectedCost{0}, tickShadowRejectedNoFill{0}, tickShadowResets{0};
  // P6b: the tick entry path (plan §3, §9, §13; TM-09/10/11/40). The
  // shadow book's fill is handed to the firer, which places ONE real order
  // per account the keeper has put in TICK_MOMENTUM on this executor
  // (/config tickEntryAccounts, empty by default = nothing is placed),
  // with that account's pre-issued one-use permit (/config tickPermits),
  // sized from the permit's risk figures at the signal's stop distance,
  // and refused when the recorder is not RECORDING (TM-40). Declared before
  // the workers so it outlives them, after the engine so it dies first.
  tick::TickPermitStore tickPermits;
  tick::TickFirer tickFirer(engine, tickPermits);
  tickFirer.setDecisionRing(&decisionRing);
  if (tickRecorder) {
    tickFirer.setRecordingCheck([&tickRecorder] { return tickRecorder->stats().state == "RECORDING"; });
    tickFirer.start();
  }
  if (tickRecorder) {
    const int nWorkers = std::max(1, std::atoi(envOr("TICK_WORKERS", "2").c_str()));
    tickStrategies.resize(static_cast<size_t>(nWorkers));
    tickBooks.resize(static_cast<size_t>(nWorkers));
    tickStratSeen.assign(static_cast<size_t>(nWorkers), 0);
    tickWorkers = std::make_unique<tick::SymbolWorkers>(nWorkers, 1u << 14,
        [&tickWorkerEvents, &tickShadow, &tickStrategies, &tickBooks, &tickStratReset, &tickStratSeen, &tickParams, &tickSignals, &tickSignalsBuy, &tickSignalsSell, &tickLastSignalMs, &decisionRing,
         &tickShadowLedger, &tickSimMtx, &tickSim, &tickShadowOpen, &tickShadowRejectedCost, &tickShadowRejectedNoFill, &tickShadowResets, &tickFirer](int worker, const tick::WorkerEvent& ev) {
          tickWorkerEvents.fetch_add(1, std::memory_order_relaxed);
          auto& bank = tickStrategies[static_cast<size_t>(worker)];
          auto& books = tickBooks[static_cast<size_t>(worker)];
          const uint64_t reset = tickStratReset.load(std::memory_order_acquire);
          if (tickStratSeen[static_cast<size_t>(worker)] != reset) {
            // A fresh warm-up after a switch-off. Open shadow trades are
            // MARKED at the last executable side with reason 'reset', never
            // dropped (Statistics auditor, 11-09-2026: a dropped open trade is
            // survivorship that flatters a book whose losers run longer).
            for (auto& kv : books) {
              if (auto t = kv.second.markAtLast("reset")) {
                const long long seq = tickShadowLedger.record(*t);
                tickShadowResets.fetch_add(1, std::memory_order_relaxed);
                tickShadowOpen.fetch_sub(1, std::memory_order_relaxed);
                decisionRing.log("tick", "shadow_close", 0, kv.first, "reset", t->side + " netR=" + std::to_string(t->netR) + " hold=" + std::to_string(t->holdEvents) + " seq=" + std::to_string(seq) + " profile=" + t->profileHash);
              }
            }
            bank.clear(); books.clear(); tickStratSeen[static_cast<size_t>(worker)] = reset;
          }
          if (!tickShadow.load(std::memory_order_relaxed)) return;
          auto it = bank.find(ev.symbolId);
          if (it == bank.end()) it = bank.emplace(ev.symbolId, tick::TickMomentumStrategy(tickParams)).first;
          auto bk = books.find(ev.symbolId);
          if (bk == books.end()) {
            tick::ShadowSim sim;
            { std::lock_guard<std::mutex> lk(tickSimMtx); sim = tickSim; }
            bk = books.emplace(ev.symbolId, tick::ShadowBook(sim, tickParams.rangeEvents, static_cast<long long>(ev.symbolId), it->second.profileHash())).first;
          }
          tick::StrategyQuote q;
          q.seq = ev.seq; q.recvMs = ev.recvMs;
          q.hasBid = (ev.flags & tick::BID_PRESENT) != 0; q.hasAsk = (ev.flags & tick::ASK_PRESENT) != 0;
          q.bid = ev.bid; q.ask = ev.ask;
          q.snapshot = (ev.flags & tick::SNAPSHOT) != 0 || ev.gapBefore; // a continuity break warms, never counts
          q.crossed = (ev.flags & tick::CROSSED) != 0;
          q.changed = (ev.flags & tick::REPEAT) == 0;
          // The book manages its open trade and fills its pending signal on
          // THIS event before the strategy sees it (no lookahead on a fill).
          const bool hadOpen = bk->second.open().has_value();
          if (auto closed = bk->second.onQuote(q)) {
            const long long seq = tickShadowLedger.record(*closed);
            decisionRing.log("tick", "shadow_close", 0, static_cast<long long>(ev.symbolId), closed->reason,
                             closed->side + " netR=" + std::to_string(closed->netR) + " hold=" + std::to_string(closed->holdEvents) + " seq=" + std::to_string(seq) + " profile=" + closed->profileHash);
          }
          // P6b: the book's fill on THIS event is the entry moment for every
          // TICK_MOMENTUM account — taken once, refused or queued, never blocking.
          if (auto fill = bk->second.takeFill()) tickFirer.onFill(*fill, static_cast<long long>(ev.recvMs));
          const bool hasOpen = bk->second.open().has_value();
          if (hadOpen != hasOpen) { if (hasOpen) tickShadowOpen.fetch_add(1, std::memory_order_relaxed); else tickShadowOpen.fetch_sub(1, std::memory_order_relaxed); }
          if (auto sig = it->second.onQuote(q)) {
            tickSignals.fetch_add(1, std::memory_order_relaxed);
            (sig->side == "BUY" ? tickSignalsBuy : tickSignalsSell).fetch_add(1, std::memory_order_relaxed);
            tickLastSignalMs.store(sig->recvMs, std::memory_order_relaxed);
            const auto before = bk->second.rejected();
            const bool taken = bk->second.offer(*sig);
            const auto after = bk->second.rejected();
            if (after.cost != before.cost) tickShadowRejectedCost.fetch_add(1, std::memory_order_relaxed);
            if (after.noFill != before.noFill) tickShadowRejectedNoFill.fetch_add(1, std::memory_order_relaxed);
            // The signal's own quote travels with it (P6a): the keeper's
            // evidence needs the price the signal was made at, not only
            // that it happened.
            decisionRing.log("tick", "signal", 0, static_cast<long long>(ev.symbolId), sig->side,
                             std::string(taken ? "shadow" : (after.cost != before.cost ? "shadow_cost" : "shadow_busy")) +
                             " dir=" + sig->dirReason + " seq=" + std::to_string(sig->seq) + " recvMs=" + std::to_string(sig->recvMs) +
                             " bid=" + std::to_string(sig->bid) + " ask=" + std::to_string(sig->ask) +
                             " trigger2=" + std::to_string(sig->trigger2) + " stop=" + std::to_string(sig->stopDistance) +
                             " V=" + std::to_string(sig->V) + " E=" + std::to_string(sig->E) + " setup=" + std::to_string(sig->setupId) +
                             " profile=" + it->second.profileHash());
          }
        });
    tickWorkers->start();
    logLine("tick workers: " + std::to_string(nWorkers) + " (fixed symbol shards; strategy " + std::string("tick_momentum_breakout v1 profile ") + tickParams.profileHash() + " runs in SHADOW only when the keeper switches it on; the shadow portfolio fills by the replayer's rules, " + tickSim.json() + "; tick entries place only for accounts the keeper lists in tickEntryAccounts — none at boot)");
  }

  // The decision ring (owner invariant 1, 2026-08-31): every decision this
  // binary takes lands as a structured record the Node keeper pulls via
  // POST /decisions and persists. Always on — unlike telemetry it needs no
  // volume, costs a few KB of memory, and a supervision channel that can be
  // configured off is a guard whose trigger is out of reach.

  // THE PIN. Set CTRADER_HOST and this process serves that broker host and only
  // that one, for its whole life — /connect refuses anything else. Unset (the
  // default, and today's deployment) leaves the sidecar unpinned and every
  // /connect is honoured exactly as before.
  const std::string pinnedHost = envOr("CTRADER_HOST", "");
  if (!pinnedHost.empty())
    logLine("host PINNED to " + pinnedHost + " — /connect for any other host will be refused");
  {
    const std::string& host = pinnedHost;
    std::string clientId = envOr("CTRADER_CLIENT_ID", "");
    std::string clientSecret = envOr("CTRADER_CLIENT_SECRET", "");
    std::string accessToken = envOr("CTRADER_ACCESS_TOKEN", "");
    long long accountId = std::strtoll(envOr("CTRADER_ACCOUNT_ID", "0").c_str(), nullptr, 10);
    if (!clientId.empty() && !accessToken.empty() && accountId > 0) {
      engine.setCredentials(host.empty() ? "live.ctraderapi.com" : host,
                            clientId, clientSecret, accessToken, accountId);
      logLine("credentials pre-seeded from env");
    } else {
      logLine("waiting for credentials via POST /connect");
    }
  }

  std::thread engineThread([&engine] { engine.runLoop(); });
  engineThread.detach();

  // -------------------------------------------------------------------
  // Virtual Pending Order engine (owner-authorized 2026-07-22 build; this
  // is the wiring step flagged in doc_reference/cpp-virtual-pending-order-
  // engine.md as needing its own review pass before it can fire real
  // orders). Bars and per-strategy sizing are PUSHED IN by the Node keeper
  // via POST /vpo-config — this binary never fetches trendbars or computes
  // position size itself (see vpo_config_store.hpp for why: no parallel,
  // unaudited sizing source of truth). Off by default (VPO_ENABLED unset).
  // -------------------------------------------------------------------
  const bool vpoEnabled = envOr("VPO_ENABLED", "false") == "true";
  const std::string vpoSymbolsSpec = envOr("VPO_SYMBOLS", ""); // "EURUSD:1:vwap_trend,GBPUSD:2:vp_value"
  const std::string vpoMacroTf = envOr("VPO_MACRO_TF", "4h");
  const std::string vpoMicroTf = envOr("VPO_MICRO_TF", "15m");
  const int vpoRecomputeMs = std::atoi(envOr("VPO_RECOMPUTE_MS", "5000").c_str());
  // L2 depth rides the VPO spot feed's connection for the same symbol list.
  // Off by default: broker depth support per symbol/account is unverified,
  // and SpotFeed treats a rejected depth subscribe as spots-only anyway.
  const bool depthFeedEnabled = envOr("DEPTH_FEED_ENABLED", "false") == "true";
  // Tick-level SL trailing (owner option 4). Off by default; when on, the
  // spot feed starts even without VPO strategies (empty symbol list — the
  // trail engine's /trail-config pushes deliver symbols dynamically).
  const bool trailTickEnabled = envOr("TRAIL_TICK_ENABLED", "false") == "true";
  // Mutual liveness (PR-B): probe the OTHER instance of this binary over
  // Railway private networking. Liveness-only — peer state never changes
  // behaviour here; it is recorded (ring) and reported (/health) so the
  // keeper can triangulate "my path broke" vs "the sidecar died", and so
  // evidence accumulates even while the keeper itself is down.
  PeerProbe peerProbe;
  peerProbe.start(envOr("PEER_URL", ""), &decisionRing);

  TrailEngine trailEngine;
  trailEngine.setDecisionRing(&decisionRing);
  if (trailTickEnabled) {
    trailEngine.start(engine);
    logLine("tick-level trail engine started (TRAIL_TICK_ENABLED)");
  }

  vpo::VpoConfigStore vpoStore;
  std::unique_ptr<vpo::VpoDispatcher> vpoDispatcher;
  std::vector<long long> vpoSymbolIds;
  std::unique_ptr<SpotFeed> spotFeed;
  std::thread spotFeedThread;
  // The inputs the LIVE feed was constructed from. /connect compares against
  // these to decide whether a push actually requires a new feed, instead of
  // rebuilding on every push and charging the tick recorder a gap for it.
  // Only ever touched on the HTTP thread, under connectMtx.
  std::string liveFeedHost;
  long long liveFeedAccountId = 0;
  std::vector<long long> liveFeedVpoSymbolIds;
  bool liveFeedTrailEnabled = false;
  bool liveFeedDepthEnabled = false;
  bool liveFeedRecorderAttached = false;
  // vpoMtx guards the spotFeed/spotFeedThread HANDLES only — every holder must
  // release it in bounded time, because GET /health takes it too. It is NOT
  // the thing that serialises /connect: HttpServer runs a detached thread per
  // connection (http_server.cpp:45), so two /connects can race, and the
  // stop-join-recreate sequence needs mutual exclusion for far longer than
  // /health can be made to wait. connectMtx provides that; vpoMtx stays short.
  std::mutex vpoMtx;
  std::mutex connectMtx;

  if (vpoEnabled && !vpoSymbolsSpec.empty()) {
    vpo::BarProvider barProvider = [&vpoStore](const std::string& symbol, const std::string& timeframe) {
      return vpoStore.getBars(symbol, timeframe);
    };
    vpo::VolumeResolver volumeResolver = [&vpoStore](const vpo::StrategyModule& s) {
      return vpoStore.getVolume(s.key() + ":" + s.order().symbol);
    };
    vpoDispatcher = std::make_unique<vpo::VpoDispatcher>(engine, barProvider, volumeResolver, vpoMacroTf, vpoMicroTf);
    vpoDispatcher->setDecisionRing(&decisionRing);
    // P2a-2: a fire carries the keeper's permit for its strategy, symbol and side.
    vpoDispatcher->setPermitResolver([&vpoStore](const vpo::StrategyModule& s, vpo::Side side) {
      return vpoStore.getPermit(s.key() + ":" + s.order().symbol + ":" + (side == vpo::Side::Buy ? "BUY" : "SELL"));
    });

    // "SYMBOL:SYMBOLID:STRATEGYKEY[:DIGITS],..." — DIGITS (the symbol's
    // decimal price precision, e.g. 5 for EURUSD, 3 for USDJPY) is optional
    // and defaults to 5; it's needed to scale relativeStopLoss/
    // relativeTakeProfit into cTrader's wire units correctly (see
    // vpo_dispatcher.cpp's relativePoints() — a flat ×100000 is WRONG for
    // any symbol whose precision isn't 5 digits). All seven strategies are
    // real ports now (see vpo_strategies.hpp); any other/misspelled key is
    // logged and skipped rather than silently registering nothing.
    std::stringstream ss(vpoSymbolsSpec);
    std::string entry;
    while (std::getline(ss, entry, ',')) {
      std::vector<std::string> fields;
      std::stringstream es(entry);
      std::string field;
      while (std::getline(es, field, ':')) fields.push_back(field);
      if (fields.size() < 3) {
        logLine("VPO_SYMBOLS: skipping malformed entry '" + entry + "'");
        continue;
      }
      const std::string& symbol = fields[0];
      const long long symbolId = std::strtoll(fields[1].c_str(), nullptr, 10);
      const std::string& key = fields[2];
      const int digits = fields.size() >= 4 ? std::atoi(fields[3].c_str()) : 5;
      if (symbolId <= 0) {
        logLine("VPO_SYMBOLS: bad symbolId in '" + entry + "'");
        continue;
      }
      std::unique_ptr<vpo::StrategyModule> strat;
      if (key == "vwap_trend") strat = std::make_unique<vpo::VwapTrendStrategy>(key, symbol, vpoMicroTf, symbolId, digits);
      else if (key == "vp_value") strat = std::make_unique<vpo::VpValueStrategy>(key, symbol, vpoMicroTf, symbolId, digits);
      else if (key == "ema_pullback") strat = std::make_unique<vpo::EmaPullbackStrategy>(key, symbol, vpoMicroTf, symbolId, digits);
      else if (key == "donchian_breakout") strat = std::make_unique<vpo::DonchianBreakoutStrategy>(key, symbol, vpoMicroTf, symbolId, digits);
      else if (key == "cup_handle") strat = std::make_unique<vpo::CupHandleStrategy>(key, symbol, vpoMicroTf, symbolId, digits);
      else if (key == "inv_cup_handle") strat = std::make_unique<vpo::InvCupHandleStrategy>(key, symbol, vpoMicroTf, symbolId, digits);
      else if (key == "fib_confluence") strat = std::make_unique<vpo::FibConfluenceStrategy>(key, symbol, vpoMicroTf, symbolId, digits);
      else if (key == "rsi2_reversion") strat = std::make_unique<vpo::Rsi2ReversionStrategy>(key, symbol, vpoMicroTf, symbolId, digits);
      else {
        logLine("VPO_SYMBOLS: unknown strategy key '" + key + "' — skipping");
        continue;
      }
      vpoSymbolIds.push_back(symbolId);
      vpoDispatcher->registerStrategy(std::move(strat));
    }

    if (vpoDispatcher->strategyCount() > 0) {
      vpoDispatcher->start(vpoRecomputeMs);
      logLine("VPO dispatcher started with " + std::to_string(vpoDispatcher->strategyCount()) + " strategy/ies");
    } else {
      logLine("VPO_ENABLED but no valid strategies parsed from VPO_SYMBOLS — dispatcher not started");
      vpoDispatcher.reset();
    }
  }

  // P2b-1: the execution-event journal the keeper pulls (POST /events) and
  // the request pacer against the broker's documented per-connection budget.
  // Env: EXEC_RATE_LIMIT_PER_SEC (default 40; the docs say 50), and
  // EXEC_PROTECTION_RESERVE_PCT (default 25). Both reported in /health.
  EventJournal eventJournal(512, decisionRing.bootId());
  engine.setEventJournal(&eventJournal);
  PacerConfig pacerCfg;
  pacerCfg.capacityPerSec = std::atoi(envOr("EXEC_RATE_LIMIT_PER_SEC", "40").c_str());
  pacerCfg.protectionReservePct = std::atoi(envOr("EXEC_PROTECTION_RESERVE_PCT", "25").c_str());
  pacerCfg.burst = std::atoi(envOr("EXEC_RATE_BURST", "8").c_str());
  RequestPacer pacer(pacerCfg);
  engine.setPacer(&pacer);
  engine.setMaxInFlight(std::atoi(envOr("EXEC_MAX_IN_FLIGHT", "8").c_str()));
  logLine("request pacer: " + std::to_string(pacer.config().capacityPerSec) + "/s (docs: 50/s per connection), burst " +
          std::to_string(pacer.config().burst) + ", " + std::to_string(pacer.config().protectionReservePct) + "% reserved for protection");
  // P2b-2: the broker session is async — a reader thread per connection,
  // every request a future keyed by its clientMsgId, awaited outside the
  // execution mutex; the heartbeat is the reader's. Stated at boot so the
  // shape in force is never inferred from the version alone.
  logLine("broker session: async (reader thread + request futures; heartbeat idle bound " +
          std::to_string(kHeartbeatIdleSeconds) + " s)");

  HttpServer server(port, execSecret);

  server.route("GET", "/health", [&engine, &spotFeed, &vpoMtx, execSecret, &trailEngine, trailTickEnabled, &vpoDispatcher, &decisionRing, startedAtMs, &peerProbe, &pacer, &eventJournal, &tickRecorder, &tickShadow, &tickSignals, &tickSimMtx, &tickSim, &tickFirer](const HttpRequest& req) -> HttpResponse {
    jsn::Value v{jsn::Object{}};
    v.set("ok", true);
    v.set("connected", engine.isConnected());
    v.set("hasCredentials", engine.hasCredentials());
    long long at = engine.lastReconcileAtMs();
    v.set("lastReconcileAt", at > 0 ? jsn::Value(at) : jsn::Value(nullptr));
    // M2: /health is reachable UNAUTHENTICATED (Railway probes bare), and the
    // raw ctidTraderAccountIds were the one piece of broker-identifying data
    // on that open response (audit #12). Node's roster gates NEED the ids
    // (exec-engine sidecarRoster, heartbeat rosterDrift), so they are served
    // only when the caller authenticates — or when no EXEC_SECRET is
    // configured at all, where redaction would protect nothing. Everyone
    // always gets the count.
    v.set("accountCount", static_cast<double>(engine.accountIds().size()));
    auto authIt = req.headers.find("authorization");
    const bool trusted = execSecret.empty() ||
        (authIt != req.headers.end() && authIt->second == "Bearer " + execSecret);
    if (trusted) {
      jsn::Array ids;
      for (long long id : engine.accountIds()) ids.push_back(jsn::Value(id));
      v.set("accounts", jsn::Value(std::move(ids)));
    }
    // Telemetry counters — null when TELEMETRY_PATH isn't configured, so the
    // Node keeper can tell "disabled" apart from "configured, zero events".
    if (Telemetry* t = engine.telemetry()) {
      v.set("telemetryWritten", static_cast<double>(t->written()));
      v.set("telemetryDropped", static_cast<double>(t->dropped()));
    } else {
      v.set("telemetryWritten", jsn::Value(nullptr));
      v.set("telemetryDropped", jsn::Value(nullptr));
    }
    // OOM-leak telemetry (2026-07-24 silent-SIGKILL incident): total depth
    // book entries — watch this across uptime; unbounded growth names the
    // leak. Null when the spot feed isn't running.
    //
    // FEED TRUTH (2026-08-31 supervision plan): before these fields a wedged
    // SpotFeed silently froze the tick trail AND VPO firing with nothing
    // outside the process able to see it — /health said ok as long as the
    // HTTP thread answered. Facts only; Node (which knows market hours)
    // renders the staleness verdict. spotFeed: null means the feed OBJECT
    // does not exist (both consumers off, or no /connect yet) — Node must
    // distinguish "not running" from "running and silent".
    {
      std::lock_guard<std::mutex> lk(vpoMtx);
      v.set("depthBookEntries", spotFeed
          ? jsn::Value(static_cast<double>(spotFeed->depthEntriesTotal()))
          : jsn::Value(nullptr));
      if (spotFeed) {
        jsn::Value f{jsn::Object{}};
        f.set("connected", spotFeed->isConnected());
        long long lt = spotFeed->lastTickAtMs();
        f.set("lastTickAtMs", lt > 0 ? jsn::Value(lt) : jsn::Value(nullptr));
        f.set("tickCount", static_cast<double>(spotFeed->tickCount()));
        f.set("reconnects", static_cast<double>(spotFeed->reconnects()));
        // Per-symbol detail is bearer-gated like `accounts` above: symbol ids
        // identify what is traded, and /health answers unauthenticated.
        if (trusted) {
          jsn::Array syms;
          for (const auto& [id, at] : spotFeed->lastTickBySymbol()) {
            jsn::Value s{jsn::Object{}};
            s.set("id", static_cast<double>(id));
            s.set("lastTickAtMs", static_cast<double>(at));
            syms.push_back(std::move(s));
          }
          f.set("symbols", jsn::Value(std::move(syms)));
        }
        v.set("spotFeed", std::move(f));
      } else {
        v.set("spotFeed", jsn::Value(nullptr));
      }
    }
    if (trailTickEnabled) {
      jsn::Value t{jsn::Object{}};
      t.set("tracked", static_cast<double>(trailEngine.tracked()));
      t.set("amendsOk", static_cast<double>(trailEngine.amendsOk()));
      t.set("amendsFailed", static_cast<double>(trailEngine.amendsFailed()));
      v.set("trail", std::move(t));
    } else {
      v.set("trail", jsn::Value(nullptr));
    }
    if (vpoDispatcher) {
      const vpo::VpoDispatcher::Outcomes o = vpoDispatcher->outcomes();
      jsn::Value w{jsn::Object{}};
      w.set("triggered", static_cast<double>(o.triggered));
      w.set("placed", static_cast<double>(o.placed));
      w.set("rejected", static_cast<double>(o.rejected));
      w.set("failed", static_cast<double>(o.failed));
      w.set("noSizing", static_cast<double>(o.noSizing));
      w.set("noAccount", static_cast<double>(o.noAccount));
      v.set("vpo", std::move(w));
    } else {
      v.set("vpo", jsn::Value(nullptr));
    }
    {
      const GuardSnapshot g = engine.guard().snapshot();
      jsn::Value gj{jsn::Object{}};
      gj.set("halt", g.halt);
      gj.set("requireBracket", g.requireBracket);
      gj.set("requireTarget", g.requireTarget);
      gj.set("maxOrderVolume", g.maxOrderVolume);
      gj.set("haltAccountCount", static_cast<double>(g.haltAccounts.size()));
      // AUDIT 11-09-2026 (plan B05): the LIST, so the keeper's guard sync can
      // compare identity — two accounts swapped for two others read as "in
      // sync" by count alone. Bearer-gated like the account roster.
      if (trusted) {
        jsn::Array ha;
        for (long long id : g.haltAccounts) ha.push_back(jsn::Value(static_cast<double>(id)));
        gj.set("haltAccounts", jsn::Value(std::move(ha)));
      }
      // P2a: the fenced epochs, so the keeper's guard sync can see whether
      // its push bound (and an older keeper reads a plain object it ignores).
      jsn::Value eo{jsn::Object{}};
      for (const auto& kv : g.entryEpochs) eo.set(std::to_string(kv.first), static_cast<double>(kv.second));
      gj.set("entryEpochs", std::move(eo));
      gj.set("entryEpochCount", static_cast<double>(g.entryEpochs.size()));
      v.set("guard", std::move(gj));
    }
    {
      // P3a: the recorder's summary — null when TICK_SPOOL_PATH is unset,
      // so "disabled" and "configured, idle" never read the same. The
      // subscribed symbol ids ride only on the trusted branch (they say what
      // is traded, same reasoning as the accounts redaction).
      if (tickRecorder) {
        const tick::RecorderStats ts = tickRecorder->stats();
        jsn::Value tj{jsn::Object{}};
        tj.set("enabled", true);
        tj.set("recording", ts.recording);
        tj.set("state", ts.state);
        tj.set("events", static_cast<double>(ts.events));
        tj.set("dropped", static_cast<double>(ts.dropped));
        tj.set("gaps", static_cast<double>(ts.gaps));
        tj.set("segmentsSealed", static_cast<double>(ts.segmentsSealed));
        tj.set("sealedBytes", static_cast<double>(ts.sealedBytes));
        tj.set("openBytes", static_cast<double>(ts.openBytes));
        tj.set("diskAvailBytes", static_cast<double>(ts.diskAvailBytes));
        tj.set("usagePct", static_cast<double>(ts.usagePct));
        tj.set("symbols", static_cast<double>(ts.perSymbol.size()));
        tj.set("shadow", tickShadow.load());
        tj.set("signals", static_cast<double>(tickSignals.load()));
        { std::lock_guard<std::mutex> lk(tickSimMtx); if (auto sj = jsn::parse(tickSim.json())) tj.set("shadowSim", *sj); }
        // P6b: whether this executor PLACES tick entries and for how many
        // accounts — the TM-42 marker reads places:false until P6c.
        if (auto ej = jsn::parse(tickFirer.statusJson())) {
          jsn::Value e{jsn::Object{}};
          e.set("places", ej->get("places"));
          e.set("accounts", ej->get("accounts"));
          e.set("permitsHeld", ej->get("permitsHeld"));
          e.set("sent", ej->get("sent"));
          e.set("rejected", ej->get("rejected"));
          tj.set("entry", std::move(e));
        }
        if (trusted) {
          jsn::Array subs;
          std::lock_guard<std::mutex> lk(vpoMtx);
          if (spotFeed) for (long long id : spotFeed->subscribedSymbols()) subs.push_back(jsn::Value(static_cast<double>(id)));
          tj.set("subscribed", jsn::Value(std::move(subs)));
        }
        v.set("tick", std::move(tj));
      } else {
        v.set("tick", jsn::Value(nullptr));
      }
    }
    {
      // P2b-2: the async session's facts — whether the reader is up, what is
      // in flight, and the counters that tell a quiet path from a dead one.
      const ExecEngine::SessionStats ss = engine.sessionStats();
      jsn::Value sj{jsn::Object{}};
      sj.set("async", true);
      sj.set("readerRunning", ss.readerRunning);
      sj.set("pending", static_cast<double>(ss.pending));
      sj.set("generation", static_cast<double>(ss.generation));
      sj.set("framesIn", static_cast<double>(ss.framesIn));
      sj.set("lateFrames", static_cast<double>(ss.lateFrames));
      sj.set("unsolicited", static_cast<double>(ss.unsolicited));
      sj.set("timeouts", static_cast<double>(ss.timeouts));
      sj.set("heartbeatsSent", static_cast<double>(ss.heartbeatsSent));
      sj.set("disconnects", static_cast<double>(ss.disconnects));
      sj.set("maxInFlight", static_cast<double>(ss.maxInFlight));
      sj.set("inFlightRefused", static_cast<double>(ss.inFlightRefused));
      sj.set("deferrals", static_cast<double>(ss.deferrals));
      sj.set("deferredMsRemaining", static_cast<double>(ss.deferredMsRemaining));
      v.set("session", std::move(sj));
    }
    {
      // P2b-1: the pacer in force and the journal's cursor.
      const RequestPacer::Counters pc = pacer.counters();
      jsn::Value pj{jsn::Object{}};
      pj.set("capacityPerSec", static_cast<double>(pacer.config().capacityPerSec));
      pj.set("protectionReservePct", static_cast<double>(pacer.config().protectionReservePct));
      pj.set("burst", static_cast<double>(pacer.config().burst));
      pj.set("granted", static_cast<double>(pc.granted));
      pj.set("refusedEntry", static_cast<double>(pc.refusedEntry));
      pj.set("refusedRead", static_cast<double>(pc.refusedRead));
      pj.set("refusedProtection", static_cast<double>(pc.refusedProtection));
      pj.set("tokens", pc.tokens);
      v.set("pacer", std::move(pj));
      v.set("eventsSeq", static_cast<double>(eventJournal.latestSeq()));
    }
    v.set("decisionsSeq", static_cast<double>(decisionRing.latestSeq()));
    v.set("bootId", decisionRing.bootId());
    v.set("startedAtMs", static_cast<double>(startedAtMs));
    if (peerProbe.enabled()) {
      jsn::Value pj{jsn::Object{}};
      pj.set("ok", peerProbe.peerOk());
      long long at = peerProbe.lastOkAtMs();
      pj.set("lastOkAtMs", at > 0 ? jsn::Value(at) : jsn::Value(nullptr));
      pj.set("consecutiveFails", static_cast<double>(peerProbe.consecutiveFails()));
      const std::string e = peerProbe.lastError();
      pj.set("lastError", e.empty() ? jsn::Value(nullptr) : jsn::Value(e));
      v.set("peer", std::move(pj));
    } else {
      v.set("peer", jsn::Value(nullptr));
    }
    return {200, jsn::dump(v)};
  });

  // The decision ring pull (invariant 1's transport). POST because the route
  // table is exact-match with no query strings (same reason /depth is a
  // POST). Body: {after?, bootId?} — entries newer than `after` when the
  // caller's bootId matches this boot, the whole retained ring otherwise.
  // P3a: the recorder in full — state, counters, segments, the mount's free
  // bytes (statvfs on the spool path: the measurement TM-27 asks for),
  // events/sec per symbol. {enabled:false} when TICK_SPOOL_PATH is unset.
  server.route("GET", "/tick-status", [&tickRecorder, &tickWorkers, &tickWorkerEvents, &tickShadow, &tickSignals, &tickSignalsBuy, &tickSignalsSell, &tickLastSignalMs, &tickParams, &tickShadowLedger, &tickShadowOpen, &tickShadowRejectedCost, &tickShadowRejectedNoFill, &tickShadowResets, &tickSimMtx, &tickSim, &tickFirer](const HttpRequest&) -> HttpResponse {
    if (!tickRecorder) return {200, "{\"enabled\":false,\"reason\":\"TICK_SPOOL_PATH not set\"}"};
    auto parsed = jsn::parse(tickRecorder->statusJson());
    if (!parsed) return {200, tickRecorder->statusJson()};
    jsn::Value v = *parsed;
    if (tickWorkers) {
      const tick::WorkerStats ws = tickWorkers->stats();
      jsn::Value w{jsn::Object{}};
      w.set("workers", static_cast<double>(ws.workers));
      w.set("dispatched", static_cast<double>(ws.dispatched));
      w.set("processed", static_cast<double>(ws.processed));
      w.set("consumed", static_cast<double>(tickWorkerEvents.load()));
      w.set("dropped", static_cast<double>(ws.dropped));
      w.set("gapsMarked", static_cast<double>(ws.gapsMarked));
      jsn::Array per;
      for (size_t i = 0; i < ws.perWorkerProcessed.size(); ++i) {
        jsn::Value p{jsn::Object{}};
        p.set("processed", static_cast<double>(ws.perWorkerProcessed[i]));
        p.set("dropped", static_cast<double>(ws.perWorkerDropped[i]));
        per.push_back(std::move(p));
      }
      w.set("perWorker", jsn::Value(std::move(per)));
      v.set("workers", std::move(w));
    } else {
      v.set("workers", jsn::Value(nullptr));
    }
    {
      jsn::Value st{jsn::Object{}};
      st.set("id", std::string("tick_momentum_breakout"));
      st.set("version", std::string("v1"));
      st.set("profileHash", tickParams.profileHash());
      st.set("shadow", tickShadow.load());
      st.set("signals", static_cast<double>(tickSignals.load()));
      st.set("signalsBuy", static_cast<double>(tickSignalsBuy.load()));
      st.set("signalsSell", static_cast<double>(tickSignalsSell.load()));
      st.set("lastSignalMs", static_cast<double>(tickLastSignalMs.load()));
      st.set("places", !tickFirer.accounts().empty()); // P6b: true only while the keeper lists a TICK_MOMENTUM account here
      v.set("strategy", std::move(st));
    }
    {
      // P6b: the entry path's counters — accounts placing, permits held,
      // fires queued/sent/rejected and every refusal by kind.
      if (auto ej = jsn::parse(tickFirer.statusJson())) v.set("entry", *ej);
    }
    {
      // P6a: the shadow portfolio's shape — closed count, open positions,
      // the rejections, the sim parameters in force for new books.
      jsn::Value sp{jsn::Object{}};
      sp.set("bootId", tickShadowLedger.bootId());
      sp.set("closed", static_cast<double>(tickShadowLedger.total()));
      sp.set("latestSeq", static_cast<double>(tickShadowLedger.latestSeq()));
      sp.set("open", static_cast<double>(tickShadowOpen.load()));
      sp.set("rejectedCost", static_cast<double>(tickShadowRejectedCost.load()));
      sp.set("rejectedNoFill", static_cast<double>(tickShadowRejectedNoFill.load()));
      sp.set("resets", static_cast<double>(tickShadowResets.load()));
      { std::lock_guard<std::mutex> lk(tickSimMtx); if (auto sj = jsn::parse(tickSim.json())) sp.set("sim", *sj); }
      v.set("shadowPortfolio", std::move(sp));
    }
    return {200, jsn::dump(v)};
  });

  // -------------------------------------------------------------------------
  // PR-I: the sealed-segment READ path (docs/plan-execution-audit-2026-09-11.md
  // §12.3 "segment locality"). Until this, 4.59 M recorded tick events sat on
  // this service's volume with NO path to the keeper, so POST
  // /actions/tick-research could only answer 409 no_segments and
  // REPLAY_PASSED was unreachable.
  //
  // The two routes live in tick_segment_routes.cpp, NOT as lambdas here:
  // main.cpp is excluded from every test binary, so a route defined here is
  // out of reach of the C++ suite (checker M-3 proved it — a mutation that
  // emptied HttpRequest::query killed the whole read path with a green
  // suite). test_tick_segments now drives this same registration through a
  // real HttpServer on a real socket.
  //
  // BYTES AS BASE64 IN JSON, deliberately: HttpResponse is {int status;
  // std::string body} and writeResponse always sends Content-Type:
  // application/json — that response path also serves order acks on the live
  // trading socket, so it is not being reshaped for a research read. Base64
  // costs 33 % on the wire against a 1 MiB cap per call; the keeper pulls in
  // chunks.
  registerTickSegmentRoutes(server, tickSpoolPath, tickRecorder != nullptr, execSecret);

  // P6a: the shadow portfolio's closed trades, same cursor contract as
  // /decisions — {after, bootId}; a bootId mismatch hands over the whole ring.
  server.route("POST", "/tick-shadow", [&tickShadowLedger](const HttpRequest& req) -> HttpResponse {
    long long after = 0;
    std::string callerBootId;
    if (auto parsed = jsn::parse(req.body); parsed && parsed->isObject()) {
      after = static_cast<long long>(parsed->get("after").asNumber(0));
      callerBootId = parsed->get("bootId").asString();
    }
    return {200, tickShadowLedger.dumpJson(after, callerBootId)};
  });

  server.route("POST", "/decisions", [&decisionRing](const HttpRequest& req) -> HttpResponse {
    long long after = 0;
    std::string callerBootId;
    if (auto parsed = jsn::parse(req.body); parsed && parsed->isObject()) {
      after = static_cast<long long>(parsed->get("after").asNumber(0));
      callerBootId = parsed->get("bootId").asString();
    }
    return {200, decisionRing.dumpJson(after, callerBootId)};
  });

  // P2b-1: the execution-event journal, same cursor contract as /decisions.
  server.route("POST", "/events", [&eventJournal](const HttpRequest& req) -> HttpResponse {
    long long after = 0;
    std::string callerBootId;
    if (auto parsed = jsn::parse(req.body); parsed && parsed->isObject()) {
      after = static_cast<long long>(parsed->get("after").asNumber(0));
      callerBootId = parsed->get("bootId").asString();
    }
    return {200, eventJournal.dumpJson(after, callerBootId)};
  });

  server.route("GET", "/positions", [&engine](const HttpRequest&) -> HttpResponse {
    std::string last = engine.lastReconcileJson();
    if (last.empty())
      return {503, "{\"error\":\"no reconcile data yet\"}"};
    return {200, last};
  });

  // M2 per-account variant: POST /positions {ctidTraderAccountId} returns
  // that account's latest reconcile snapshot. GET /positions above stays the
  // primary account's view (byte-identical to the single-account era).
  server.route("POST", "/positions", [&engine](const HttpRequest& req) -> HttpResponse {
    auto parsed = jsn::parse(req.body);
    if (!parsed || !parsed->isObject())
      return {400, "{\"error\":\"body must be a JSON object\"}"};
    const jsn::Value& acct = parsed->get("ctidTraderAccountId");
    long long id = acct.isNumber() ? (long long)acct.asNumber()
                                   : std::strtoll(acct.asString().c_str(), nullptr, 10);
    if (id <= 0)
      return {400, "{\"error\":\"need ctidTraderAccountId\"}"};
    std::string last = engine.lastReconcileJson(id);
    if (last.empty())
      return {503, "{\"error\":\"no reconcile data yet\"}"};
    return {200, last};
  });

  server.route("POST", "/connect", [&engine, &vpoDispatcher, &vpoSymbolIds, &spotFeed, &spotFeedThread, &vpoMtx, &connectMtx, depthFeedEnabled, &trailEngine, trailTickEnabled, pinnedHost, &decisionRing, &tickRecorder, &tickWorkers, &liveFeedHost, &liveFeedAccountId, &liveFeedVpoSymbolIds, &liveFeedTrailEnabled, &liveFeedDepthEnabled, &liveFeedRecorderAttached](const HttpRequest& req) -> HttpResponse {
    auto parsed = jsn::parse(req.body);
    if (!parsed || !parsed->isObject())
      return {400, "{\"error\":\"body must be a JSON object\"}"};
    const jsn::Value& v = *parsed;
    std::string host = v.get("host").asString();
    std::string clientId = v.get("clientId").asString();
    std::string clientSecret = v.get("clientSecret").asString();
    std::string accessToken = v.get("accessToken").asString();
    const jsn::Value& acct = v.get("accountId");
    long long accountId = acct.isNumber()
        ? (long long)acct.asNumber()
        : std::strtoll(acct.asString().c_str(), nullptr, 10);
    if (clientId.empty() || accessToken.empty() || accountId <= 0)
      return {400, "{\"error\":\"need clientId, accessToken, accountId (host/clientSecret optional)\"}"};
    // M2: optional accountIds[] — additional ctidTraderAccountIds to
    // authorize on the SAME session (plan C1: one trade connection, many
    // AccountAuths). Numbers or numeric strings; the primary accountId is
    // implicit and needn't be repeated.
    std::vector<long long> extraIds;
    for (const auto& e : v.get("accountIds").asArray()) {
      long long id = e.isNumber() ? (long long)e.asNumber()
                                  : std::strtoll(e.asString().c_str(), nullptr, 10);
      if (id > 0 && id != accountId) extraIds.push_back(id);
    }
    // HOST PIN (Phase 3). A sidecar deployed to serve ONE broker host refuses a
    // /connect that names another. Node already routes by host, but routing is
    // a property of the caller being correct; this is the property that survives
    // a caller being wrong — a mis-set EXEC_URL_DEMO, a hand-rolled curl, a
    // future call site nobody has written yet. Without it the request would not
    // fail: setCredentials would SUCCEED, tear down the session every other
    // account is trading on, and reconnect to the wrong broker.
    //
    // Unset CTRADER_HOST = unpinned = today's deployment, byte-for-byte.
    if (!connectHostAllowed(pinnedHost, host)) {
      logLine("REFUSED /connect for host '" + host + "' — this sidecar is pinned to '" + pinnedHost + "'");
      return {400, "{\"error\":\"host mismatch: this sidecar serves '" + pinnedHost +
                   "' and cannot switch to '" + host + "'\"}"};
    }
    const std::string useHost = effectiveConnectHost(pinnedHost, host);
    engine.setCredentials(useHost, clientId, clientSecret, accessToken, accountId,
                          extraIds);
    logLine("credentials updated via /connect for " + useHost + " (" +
            std::to_string(1 + extraIds.size()) + " account(s) requested)");

    // (Re)start the VPO tick feed against the freshly pushed session — the
    // sidecar holds no credentials of its own until /connect delivers them,
    // same as ExecEngine above. Stop-then-join the old feed BEFORE
    // replacing the pointer: SpotFeed::runLoop() runs on a detached-less
    // thread against `*spotFeed`, so swapping the object out from under a
    // still-running thread would be a use-after-free.
    // P3a: a configured tick recorder needs the feed too, even with no VPO
    // strategy and no tick trail — it records whatever the feed carries.
    if ((vpoDispatcher && !vpoSymbolIds.empty()) || trailTickEnabled || tickRecorder) {
      // A RESTART ONLY WHEN SOMETHING THE FEED DEPENDS ON CHANGED.
      //
      // This teardown used to be unconditional on every /connect, and with a
      // tick recorder configured that is every single push. A fresh SpotFeed
      // starts at generation 1 and the recorder writes a GAP on any
      // generation change (tick_recorder.cpp), so a CREDENTIAL ROTATION —
      // which the feed's live, already-authenticated connection does not care
      // about — cost a hole in the tick record plus a full resubscribe.
      // Measured 17-09 on the demo sidecar: two restarts inside three
      // minutes, neither caused by an input this feed reads.
      //
      // That matters beyond tidiness: the shadow evidence P6c is gated on
      // (TM-40) refuses entries on a recorder gap, so self-inflicted gaps
      // degrade the very record the tick programme is waiting for.
      //
      // HOST and ACCOUNT ID are baked into a live subscription, so a change to
      // either is a real restart. Client id / secret / token are read only at
      // the NEXT connect, so they go in place.
      bool feedInputsChanged = !spotFeed
          || useHost != liveFeedHost
          || accountId != liveFeedAccountId
          || vpoSymbolIds != liveFeedVpoSymbolIds
          || trailTickEnabled != liveFeedTrailEnabled
          || depthFeedEnabled != liveFeedDepthEnabled
          || (tickRecorder != nullptr) != liveFeedRecorderAttached;
      if (!feedInputsChanged) {
        SpotFeed* live = nullptr;
        { std::lock_guard<std::mutex> lk(vpoMtx); live = spotFeed.get(); }
        if (live) {
          const bool rotated = live->updateCredentials(clientId, clientSecret, accessToken);
          if (trailTickEnabled) live->ensureSymbols(trailEngine.symbolIds());
          logLine(std::string("spot feed kept — ") +
                  (rotated ? "credentials refreshed in place for the next reconnect"
                           : "nothing the feed reads has changed") +
                  "; no resubscribe, no recorder gap");
          return {200, "{\"ok\":true}"};
        }
      }
      // Audit C2: the old shape held vpoMtx across stop() + join(), so
      // GET /health — which takes the same mutex for depthBookEntries — blocked
      // behind a thread join that could take as long as the feed's reconnect
      // backoff. Health timeouts read as a dead process and Railway restarts
      // it, with no crash to explain why. So: take the old feed OUT under the
      // lock, release, then stop and join it with nothing held.
      std::lock_guard<std::mutex> restart(connectMtx);
      std::unique_ptr<SpotFeed> retiring;
      std::thread retiringThread;
      {
        std::lock_guard<std::mutex> lk(vpoMtx);
        retiring = std::move(spotFeed);
        retiringThread = std::move(spotFeedThread);
      }
      if (retiring) {
        retiring->stop();
        if (retiringThread.joinable()) retiringThread.join();
      }
      retiring.reset(); // destroy only after its thread is provably gone

      std::lock_guard<std::mutex> lk(vpoMtx);
      vpo::VpoDispatcher* dispatcherPtr = vpoDispatcher.get();
      TrailEngine* trailPtr = trailTickEnabled ? &trailEngine : nullptr;
      spotFeed = std::make_unique<SpotFeed>(
          host.empty() ? "live.ctraderapi.com" : host, clientId, clientSecret, accessToken, accountId,
          vpoSymbolIds,
          [dispatcherPtr, trailPtr](long long symbolId, double bid, double ask) {
            if (dispatcherPtr) dispatcherPtr->onTick(symbolId, bid, ask);
            if (trailPtr) trailPtr->onTick(symbolId, bid, ask);
          },
          depthFeedEnabled);
      spotFeed->setDecisionRing(&decisionRing);
      if (tick::TickRecorder* rec = tickRecorder.get()) {
        tick::SymbolWorkers* workers = tickWorkers.get();
        spotFeed->setRawTap([rec, workers](long long symbolId, bool hasBid, long long bid, bool hasAsk, long long ask, long long generation) {
          const uint64_t recvMs = static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
              std::chrono::system_clock::now().time_since_epoch()).count());
          const tick::Record r = rec->onQuote(symbolId, hasBid, bid, hasAsk, ask, recvMs, static_cast<uint32_t>(generation));
          if (workers) {
            tick::WorkerEvent ev;
            ev.recvMs = r.recvMs; ev.seq = r.seq; ev.symbolId = r.symbolId; ev.bid = r.bid; ev.ask = r.ask; ev.flags = r.flags;
            workers->dispatch(ev);
          }
        });
      }
      if (trailPtr) spotFeed->ensureSymbols(trailEngine.symbolIds());
      SpotFeed* feedPtr = spotFeed.get();
      spotFeedThread = std::thread([feedPtr] { feedPtr->runLoop(); });
      liveFeedHost = useHost;
      liveFeedAccountId = accountId;
      liveFeedVpoSymbolIds = vpoSymbolIds;
      liveFeedTrailEnabled = trailTickEnabled;
      liveFeedDepthEnabled = depthFeedEnabled;
      liveFeedRecorderAttached = (tickRecorder != nullptr);
      logLine("spot feed (re)started: " + std::to_string(vpoSymbolIds.size()) + " VPO symbol(s)" +
              (trailPtr ? " + trail engine fan-out" : ""));
    }
    return {200, "{\"ok\":true}"};
  });

  // Tick-trailing spec push (owner option 4): Node's profit keeper is the
  // POLICY authority — it computes armed state + trail distance and pushes
  // the full tracked set here every pass; this engine only executes the
  // ratchet at tick speed between pushes. Body:
  //   {positions: [{positionId, ctidTraderAccountId, symbolId, dir,
  //                 trailDistance, peakPrice?, currentSl?, digits?}]}
  // Full replace: positions absent from the push stop tick-trailing.
  server.route("POST", "/trail-config", [&trailEngine, &spotFeed, &vpoMtx, trailTickEnabled](const HttpRequest& req) -> HttpResponse {
    if (!trailTickEnabled)
      return {503, "{\"error\":\"TRAIL_TICK_ENABLED not set\"}"};
    auto parsed = jsn::parse(req.body);
    if (!parsed || !parsed->isObject())
      return {400, "{\"error\":\"body must be a JSON object\"}"};
    std::vector<std::pair<long long, TrailSpec>> specs;
    long long rejected = 0;
    for (const auto& p : parsed->get("positions").asArray()) {
      const long long posId = static_cast<long long>(p.get("positionId").asNumber(0));
      TrailSpec s;
      s.accountId = static_cast<long long>(p.get("ctidTraderAccountId").asNumber(0));
      s.symbolId = static_cast<long long>(p.get("symbolId").asNumber(0));
      // dir must be EXPLICITLY ±1 (audit #10): an absent or malformed dir
      // used to default to LONG, which for a short position would ratchet the
      // stop in the wrong direction — reject the spec instead.
      const jsn::Value& dirV = p.get("dir");
      const double dirN = dirV.isNumber() ? dirV.asNumber(0) : 0;
      s.dir = dirN < 0 ? -1 : 1;
      s.trailDist = p.get("trailDistance").asNumber(0);
      s.peakPrice = p.get("peakPrice").asNumber(0);
      const jsn::Value& sl = p.get("currentSl");
      if (sl.isNumber()) { s.lastSl = sl.asNumber(0); s.hasSl = true; }
      s.digits = static_cast<int>(p.get("digits").asNumber(5));
      const bool valid = posId > 0 && s.symbolId > 0 && s.trailDist > 0 &&
                         (dirN == 1 || dirN == -1);
      if (valid) specs.emplace_back(posId, s);
      else ++rejected;
    }
    trailEngine.configure(specs);
    {
      std::lock_guard<std::mutex> lk(vpoMtx);
      if (spotFeed) spotFeed->ensureSymbols(trailEngine.symbolIds());
    }
    jsn::Value out{jsn::Object{}};
    out.set("ok", true);
    out.set("tracked", static_cast<double>(trailEngine.tracked()));
    // A silently dropped spec was an invisible coverage gap on BOTH sides
    // (audit #10): Node reported how many it SENT, this now reports how many
    // were refused — exec-engine surfaces it for the keeper's log.
    out.set("rejected", static_cast<double>(rejected));
    return {200, jsn::dump(out)};
  });

  // What the VPO tier has actually done since boot (audit F-L4-04). Before
  // this, the only externally visible trace of a C++-originated order was a
  // position appearing in a later reconcile — a rejection left none at all.
  server.route("GET", "/vpo-status", [&vpoDispatcher](const HttpRequest&) -> HttpResponse {
    if (!vpoDispatcher) return {200, "{\"enabled\":false}"};
    std::string body = vpoDispatcher->statusJson();
    body.insert(1, "\"enabled\":true,");
    return {200, body};
  });

  server.route("GET", "/trail-status", [&trailEngine, trailTickEnabled](const HttpRequest&) -> HttpResponse {
    if (!trailTickEnabled)
      return {200, "{\"enabled\":false}"};
    std::string body = trailEngine.statusJson();
    body.insert(1, "\"enabled\":true,");
    return {200, body};
  });

  // L2 depth snapshot for one symbol (POST mirrors the per-account
  // /positions precedent — the route table is exact-match, no query
  // strings). Body: {symbolId, levels?}. Response distinguishes "depth not
  // enabled/subscribed" from "subscribed but no book yet" so the Node
  // capture path (slice 2) can record honestly rather than treating every
  // null as market silence.
  server.route("POST", "/depth", [&spotFeed, &vpoMtx, depthFeedEnabled](const HttpRequest& req) -> HttpResponse {
    auto parsed = jsn::parse(req.body);
    if (!parsed || !parsed->isObject())
      return {400, "{\"error\":\"body must be a JSON object\"}"};
    const jsn::Value& sym = parsed->get("symbolId");
    long long symbolId = sym.isNumber() ? (long long)sym.asNumber()
                                        : std::strtoll(sym.asString().c_str(), nullptr, 10);
    if (symbolId <= 0)
      return {400, "{\"error\":\"need symbolId\"}"};
    int levels = static_cast<int>(parsed->get("levels").asNumber(10));
    if (levels < 1) levels = 1;
    if (levels > 50) levels = 50;

    jsn::Value out{jsn::Object{}};
    out.set("enabled", depthFeedEnabled);
    std::lock_guard<std::mutex> lk(vpoMtx); // spotFeed pointer swaps under vpoMtx
    const bool active = spotFeed && spotFeed->depthActive();
    out.set("active", active);
    std::string book = spotFeed ? spotFeed->depthSnapshotJson(symbolId, levels) : "null";
    // snapshotJson returns ready-made JSON; splice it in rather than
    // re-parsing (parse is only for validation-free trusted local output).
    std::string body = jsn::dump(out);
    body.insert(body.size() - 1, ",\"book\":" + book);
    return {200, body};
  });

  // Node pushes trendbars + real risk.js-resolved position sizes here on a
  // timer (see agent/services/vpo-feeder.js) — this binary never fetches
  // bars or computes sizing itself. Safe to call whether or not VPO is
  // enabled/running (a no-op store nobody reads yet).
  // PHASE 2: /vpo-config also carries the account this tier trades on. The
  // sidecar refuses an order that names no account, so the VPO tier has to be
  // TOLD which one — it must not inherit the engine's frozen primary. Absent or
  // non-positive leaves it unconfigured, and the dispatcher then refuses to fire
  // and counts it (see VpoDispatcher::tryFire / GET /vpo-status noAccount).
  server.route("POST", "/vpo-config", [&vpoStore, &vpoDispatcher](const HttpRequest& req) -> HttpResponse {
    auto parsed = jsn::parse(req.body);
    if (!parsed || !parsed->isObject())
      return {400, "{\"error\":\"body must be a JSON object\"}"};
    const jsn::Value& v = *parsed;
    // P2a: the keeper's DISARM for a STOPPED account. The fence that only
    // withheld the next push left the last one armed until the store aged it
    // out (5 min); this clears the store, idles every strategy not mid-fire
    // and forgets the account, at once.
    if (v.get("disarm").asBool(false)) {
      vpoStore.clear();
      long long prev = 0;
      size_t idled = 0;
      if (vpoDispatcher) {
        prev = vpoDispatcher->accountId();
        idled = vpoDispatcher->disarmAll();
        vpoDispatcher->setAccountId(0);
      }
      logLine("VPO tier DISARMED by the keeper (" + v.get("reason").asString() + "): store cleared, " +
              std::to_string(idled) + " strategy/ies idled, account " + std::to_string(prev) + " -> 0");
      jsn::Value out{jsn::Object{}};
      out.set("ok", true);
      out.set("disarmed", true);
      out.set("idled", static_cast<double>(idled));
      out.set("previousAccountId", static_cast<double>(prev));
      return {200, jsn::dump(out)};
    }
    int barsUpdated = 0, volsUpdated = 0;
    for (const auto& entry : v.get("bars").asArray()) {
      const std::string symbol = entry.get("symbol").asString();
      const std::string timeframe = entry.get("timeframe").asString();
      if (symbol.empty() || timeframe.empty()) continue;
      std::vector<vpo::Bar> bars;
      for (const auto& b : entry.get("bars").asArray()) {
        bars.push_back(vpo::Bar{b.get("t").asNumber(0), b.get("o").asNumber(0), b.get("h").asNumber(0),
                                b.get("l").asNumber(0), b.get("c").asNumber(0), b.get("v").asNumber(0)});
      }
      vpoStore.setBars(symbol, timeframe, std::move(bars));
      barsUpdated++;
    }
    for (const auto& entry : v.get("volumes").asArray()) {
      const std::string key = entry.get("key").asString();
      if (key.empty()) continue;
      vpoStore.setVolume(key, entry.get("volume").asNumber(-1));
      volsUpdated++;
    }
    // P2a-2: the keeper's pre-issued permits, one per strategy + symbol + side.
    int permitsUpdated = 0;
    for (const auto& entry : v.get("permits").asArray()) {
      const std::string key = entry.get("key").asString();
      const std::string symbol = entry.get("symbol").asString();
      const std::string side = entry.get("side").asString();
      if (key.empty() || symbol.empty() || side.empty() || !entry.get("permit").isObject()) continue;
      vpoStore.setPermit(key + ":" + symbol + ":" + side, entry.get("permit"));
      permitsUpdated++;
    }
    long long acctSet = 0;
    if (vpoDispatcher) {
      const jsn::Value& acct = v.get("ctidTraderAccountId");
      if (acct.isNumber() && acct.asNumber(0) > 0) {
        acctSet = static_cast<long long>(acct.asNumber(0));
        vpoDispatcher->setAccountId(acctSet);
      } else {
        acctSet = vpoDispatcher->accountId(); // unchanged; report what stands
      }
    }
    jsn::Value out{jsn::Object{}};
    out.set("ok", true);
    out.set("barsUpdated", barsUpdated);
    out.set("volumesUpdated", volsUpdated);
    out.set("permitsUpdated", permitsUpdated);
    out.set("accountId", static_cast<double>(acctSet));
    return {200, jsn::dump(out)};
  });

  server.route("POST", "/order", [&engine](const HttpRequest& req) {
    return forward(req.body, &ExecEngine::placeOrder, engine);
  });
  server.route("POST", "/amend", [&engine](const HttpRequest& req) {
    return forward(req.body, &ExecEngine::amendPosition, engine);
  });
  server.route("POST", "/close", [&engine](const HttpRequest& req) {
    return forward(req.body, &ExecEngine::closePosition, engine);
  });
  server.route("POST", "/cancel", [&engine](const HttpRequest& req) {
    return forward(req.body, &ExecEngine::cancelOrder, engine);
  });

  // Atomic hot-reconfig (#3): the Node strategy tier retunes the execution
  // guard live — halt (kill switch), require-bracket, max order volume —
  // without pausing or locking the order path. Each field is optional; only
  // the ones present are changed. Reads on the order path are lock-free.
  server.route("POST", "/config", [&engine, &decisionRing, &tickRecorder, &spotFeed, &vpoMtx, &tickWorkers, &tickShadow, &tickStratReset, &tickSimMtx, &tickSim, &tickFirer, &tickPermits](const HttpRequest& req) -> HttpResponse {
    auto parsed = jsn::parse(req.body);
    if (!parsed || !parsed->isObject())
      return {400, "{\"error\":\"body must be a JSON object\"}"};
    const jsn::Value& v = *parsed;
    const GuardSnapshot before = engine.guard().snapshot();
    if (v.get("halt").isBool()) engine.guard().setHalt(v.get("halt").asBool());
    // The keeper says WHY a push halts when its own derivation failed
    // (exec-guard-sync.js `degraded`): rung, so an operator can tell a
    // registry read error from an owner's halt.
    if (v.get("degraded").isString() && !v.get("degraded").asString().empty())
      decisionRing.log("guard", "degraded", 0, 0, v.get("halt").asBool(false) ? "halt" : "", v.get("degraded").asString());
    if (v.get("requireBracket").isBool()) engine.guard().setRequireBracket(v.get("requireBracket").asBool());
    if (v.get("requireTarget").isBool()) engine.guard().setRequireTarget(v.get("requireTarget").asBool());
    if (v.get("maxOrderVolume").isNumber()) engine.guard().setMaxOrderVolume(v.get("maxOrderVolume").asNumber());
    // Per-account halts (2026-08-31 supervision plan): FULL REPLACE, because
    // Node's guard sync derives the whole desired set declaratively on every
    // push — an incremental protocol would leave un-halts to be remembered,
    // which is how the FX-day rollover would get forgotten. A manual UI push
    // racing the sync is last-writer-wins; the sync re-converges within ~2min.
    if (v.get("haltAccounts").isArray()) {
      std::set<long long> ids;
      for (const auto& e : v.get("haltAccounts").asArray()) {
        long long id = e.isNumber() ? (long long)e.asNumber()
                                    : std::strtoll(e.asString().c_str(), nullptr, 10);
        if (id > 0) ids.insert(id);
      }
      engine.guard().setHaltAccounts(std::move(ids));
    }
    // P2a: per-account entry epochs — full replace, same declarative contract
    // as haltAccounts. { "<accountId>": epoch, ... }
    if (v.get("entryEpochs").isObject()) {
      std::map<long long, long long> m;
      for (const auto& kv : v.get("entryEpochs").asObject()) {
        const long long id = std::strtoll(kv.first.c_str(), nullptr, 10);
        if (id > 0 && kv.second.isNumber()) m[id] = static_cast<long long>(kv.second.asNumber(0));
      }
      engine.guard().setEntryEpochs(std::move(m));
    }
    // P3a: the keeper's recording switch and the symbols it wants carried.
    // Declarative like the rest of this body: pushed on every probe that
    // finds a difference, so a sidecar restart re-converges. Ignored (with
    // the fact stated in the reply) when no recorder is configured.
    if (v.get("tickRecord").isBool()) {
      if (tickRecorder) {
        const bool was = tickRecorder->recording();
        if (!tickRecorder->setRecording(v.get("tickRecord").asBool()))
          logLine("tick recorder: recording switch ignored — the recorder never started (" + tickRecorder->stats().reason + ")");
        if (was != tickRecorder->recording()) {
          logLine(std::string("tick recorder: recording ") + (tickRecorder->recording() ? "ON" : "OFF") + " (keeper's switch)");
          decisionRing.log("tick", "recording_changed", 0, 0, tickRecorder->recording() ? "on" : "off", "keeper's switch via /config");
        }
      }
    }
    if (v.get("tickShadow").isBool() && tickWorkers) {
      const bool want = v.get("tickShadow").asBool();
      const bool was = tickShadow.exchange(want);
      if (was != want) {
        if (!want) tickStratReset.fetch_add(1, std::memory_order_release); // each worker clears its own bank on its next event
        logLine(std::string("tick strategy shadow ") + (want ? "ON" : "OFF") + " (keeper's switch; signals are rung, nothing is placed)");
        decisionRing.log("tick", "shadow_changed", 0, 0, want ? "on" : "off", "keeper's switch via /config");
      }
    }
    // P6a: the shadow portfolio's sim parameters (the replayer's fields);
    // applied to books created after this push, so a change re-warms
    // through the shadow switch rather than rewriting an open trade's rule.
    if (v.get("tickShadowSim").isObject()) {
      const auto& sj = v.get("tickShadowSim");
      std::lock_guard<std::mutex> lk(tickSimMtx);
      tick::ShadowSim next = tickSim;
      if (sj.get("latencyMs").isNumber()) next.latencyMs = static_cast<long long>(sj.get("latencyMs").asNumber());
      if (sj.get("slippage").isNumber()) next.slippage = static_cast<long long>(sj.get("slippage").asNumber());
      if (sj.get("commissionPerSide").isNumber()) next.commissionPerSide = static_cast<long long>(sj.get("commissionPerSide").asNumber());
      if (sj.get("targetR").isNumber()) next.targetR = sj.get("targetR").asNumber();
      if (sj.get("minTargetToCost").isNumber()) next.minTargetToCost = sj.get("minTargetToCost").asNumber();
      if (sj.get("maxHoldEvents").isNumber()) next.maxHoldEvents = static_cast<int>(sj.get("maxHoldEvents").asNumber());
      if (sj.get("maxHoldMs").isNumber()) next.maxHoldMs = static_cast<long long>(sj.get("maxHoldMs").asNumber());
      // PR-L: the per-symbol-class cost schedule (agent/config/tick-shadow-sim.json
      // `costs`, agent/lib/tick-cost-schedule.js). FULL REPLACE, declarative
      // like haltAccounts: a class or a symbol the keeper stops sending is
      // gone, never a stale row left charging — including the whole schedule
      // (checker finding 6: without a clear path
      // a stale map stayed installed and /health went on echoing a
      // legitimate-looking hash onto the evidence record). A push that simply
      // omits `costs` leaves the schedule alone, which is what the keeper does
      // when it has no resolved symbol to price. An EMPTY object (`"costs":
      // {}`) is the clear: no classes, no symbol map, nothing charged.
      if (sj.get("costs").isObject()) {
        const auto& cj = sj.get("costs");
        tick::ShadowCostSchedule sch;
        sch.fallbackClass = cj.get("fallbackClass").asString();
        for (const auto& [name, val] : cj.get("classes").asObject()) {
          tick::ShadowCost c;
          c.commissionWirePerSide = val.get("commissionWirePerSide").asNumber(0);
          c.commissionBpsPerSide = val.get("commissionBpsPerSide").asNumber(0);
          c.slippageWirePerSide = val.get("slippageWirePerSide").asNumber(0);
          c.slippageBpsPerSide = val.get("slippageBpsPerSide").asNumber(0);
          sch.classes[name] = c;
        }
        for (const auto& [id, val] : cj.get("symbolClass").asObject()) {
          const long long sid = std::strtoll(id.c_str(), nullptr, 10);
          if (sid > 0 && val.isString()) sch.symbolClass[sid] = val.asString();
        }
        next.costs = sch;
      }
      if (next.json() != tickSim.json()) { tickSim = next; logLine("tick shadow sim: " + tickSim.json() + " (keeper's push; applies to new books)"); }
    }
    // P6b: the accounts in TICK_MOMENTUM on this executor — FULL REPLACE,
    // declarative like haltAccounts; an account that leaves the set has its
    // held permits dropped at once (a switch away must not leave a permit
    // that a fill a second later could still spend).
    if (v.get("tickEntryAccounts").isArray()) {
      std::set<long long> ids;
      for (const auto& e : v.get("tickEntryAccounts").asArray()) {
        long long id = e.isNumber() ? (long long)e.asNumber() : std::strtoll(e.asString().c_str(), nullptr, 10);
        if (id > 0) ids.insert(id);
      }
      const std::set<long long> was = tickFirer.accounts();
      if (was != ids) {
        for (long long id : was) if (!ids.count(id)) tickPermits.clearAccount(id);
        tickFirer.setAccounts(ids);
        logLine("tick entries: " + std::to_string(ids.size()) + " account(s) in TICK_MOMENTUM on this executor (keeper's push; " +
                (ids.empty() ? std::string("nothing is placed") : std::string("the shadow book's fills place with the keeper's permits")) + ")");
        decisionRing.log("tick", "entry_accounts_changed", 0, 0, ids.empty() ? "none" : std::to_string(ids.size()),
                         "was " + std::to_string(was.size()) + " account(s), keeper's push via /config");
      }
    }
    // P6b: the keeper's pre-issued one-use permits for the tick path —
    // [{accountId, symbolId, side, permit}], each replacing the one held
    // for that account/symbol/side; a permit for an account not in
    // tickEntryAccounts is dropped (nothing would spend it).
    if (v.get("tickPermits").isArray()) {
      const std::set<long long> placing = tickFirer.accounts();
      size_t set = 0, dropped = 0;
      for (const auto& e : v.get("tickPermits").asArray()) {
        const long long acct = static_cast<long long>(e.get("accountId").asNumber(0));
        const long long sym = static_cast<long long>(e.get("symbolId").asNumber(0));
        const std::string side = e.get("side").asString();
        if (acct <= 0 || sym <= 0 || (side != "BUY" && side != "SELL") || !e.get("permit").isObject() || !placing.count(acct)) { dropped++; continue; }
        tickPermits.set(acct, sym, side, e.get("permit"));
        set++;
      }
      if (dropped) decisionRing.log("tick", "permits_dropped", 0, 0, std::to_string(dropped), "malformed or for an account not in tickEntryAccounts");
      (void)set;
    }
    if (v.get("tickSymbolIds").isArray()) {
      std::vector<long long> ids;
      for (const auto& e : v.get("tickSymbolIds").asArray()) {
        long long id = e.isNumber() ? (long long)e.asNumber() : std::strtoll(e.asString().c_str(), nullptr, 10);
        if (id > 0) ids.push_back(id);
      }
      std::lock_guard<std::mutex> lk(vpoMtx);
      if (spotFeed && !ids.empty()) spotFeed->ensureSymbols(ids);
    }
    const GuardSnapshot g = engine.guard().snapshot();
    // A guard change is a declaration worth remembering — the ring is how the
    // keeper's inspector later asks "who changed the guard, and did it bind".
    if (before.halt != g.halt || before.haltAccounts != g.haltAccounts ||
        before.requireBracket != g.requireBracket || before.requireTarget != g.requireTarget ||
        before.maxOrderVolume != g.maxOrderVolume || before.entryEpochs != g.entryEpochs) {
      std::string epochs;
      for (const auto& kv : g.entryEpochs) epochs += (epochs.empty() ? "" : ",") + std::to_string(kv.first) + ":" + std::to_string(kv.second);
      decisionRing.log("guard", "config_changed", 0, 0, "",
                       std::string("halt=") + (g.halt ? "1" : "0") +
                       " haltAccounts=" + std::to_string(g.haltAccounts.size()) +
                       " bracket=" + (g.requireBracket ? "1" : "0") +
                       " target=" + (g.requireTarget ? "1" : "0") +
                       " entryEpochs=" + (epochs.empty() ? std::string("none") : epochs));
    }
    jsn::Value out{jsn::Object{}};
    out.set("ok", true);
    out.set("halt", g.halt);
    out.set("requireBracket", g.requireBracket);
    out.set("requireTarget", g.requireTarget);
    out.set("maxOrderVolume", g.maxOrderVolume);
    jsn::Array ha;
    for (long long id : g.haltAccounts) ha.push_back(jsn::Value(id));
    out.set("haltAccounts", jsn::Value(std::move(ha)));
    jsn::Value eo{jsn::Object{}};
    for (const auto& kv : g.entryEpochs) eo.set(std::to_string(kv.first), static_cast<double>(kv.second));
    out.set("entryEpochs", std::move(eo));
    return {200, jsn::dump(out)};
  });

  // Same payload/response as `cpp-exec --backtest` (Bearer-gated like every
  // other route). Payload guarded at 5MB in handleBacktest; note the socket
  // reader also enforces its own 4 MiB body cap.
  server.route("POST", "/backtest", [](const HttpRequest& req) {
    return handleBacktest(req.body);
  });

  logLine("starting on port " + std::to_string(port));
  const bool served = server.run();

  // Audit C3. server.run() returning is not the only way out of this process,
  // but it is the one we control, and on that path a joinable spotFeedThread
  // reaching its destructor is a std::terminate — an abort with no
  // explanation in the log, which is the worst kind of exit to debug.
  //
  // The engine thread stays detached deliberately: it captures `engine`, a
  // local of main, so joining it is the only correct thing to do and it has
  // no stop signal to join on. Leaving it detached while main returns is the
  // pre-existing shape and changing it needs an ExecEngine shutdown path,
  // which is not this fix. Recorded rather than silently half-done.
  {
    std::unique_ptr<SpotFeed> retiring;
    std::thread retiringThread;
    {
      std::lock_guard<std::mutex> lk(vpoMtx);
      retiring = std::move(spotFeed);
      retiringThread = std::move(spotFeedThread);
    }
    if (retiring) {
      retiring->stop();
      if (retiringThread.joinable()) retiringThread.join();
      logLine("spot feed stopped");
    }
  }
  // The trail worker was left running on this path (audit #12) — a joinable
  // std::thread member reaching its destructor is the same std::terminate
  // the spot-feed block above exists to avoid. Same rule for the peer probe.
  trailEngine.stop();
  peerProbe.stop();
  if (tickWorkers) tickWorkers->stop();
  tickFirer.stop();
  if (tickRecorder) { tickRecorder->stop(); logLine("tick recorder stopped (segment sealed)"); }
  return served ? 0 : 1;
}
