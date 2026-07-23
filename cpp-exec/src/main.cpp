// cpp-exec/src/main.cpp
//
// Sidecar entrypoint: one engine thread (connect + auth + heartbeat + 30s
// reconcile poll) and the HTTP server on the main thread. All env-driven —
// no config files, matching how the Node keeper is configured on Railway.
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
#include "engine.hpp"
#include "http_server.hpp"
#include "json.hpp"
#include "spot_feed.hpp"
#include "telemetry.hpp"
#include "vpo_config_store.hpp"
#include "vpo_dispatcher.hpp"
#include "vpo_strategies.hpp"

static void logLine(const std::string& msg) {
  std::fprintf(stderr, "[cpp-exec] %s\n", msg.c_str());
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

  ExecEngine engine;
  if (telemetry) engine.setTelemetry(telemetry.get());
  {
    std::string host = envOr("CTRADER_HOST", "");
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

  vpo::VpoConfigStore vpoStore;
  std::unique_ptr<vpo::VpoDispatcher> vpoDispatcher;
  std::vector<long long> vpoSymbolIds;
  std::unique_ptr<SpotFeed> spotFeed;
  std::thread spotFeedThread;
  std::mutex vpoMtx; // guards spotFeed/spotFeedThread across concurrent /connect calls

  if (vpoEnabled && !vpoSymbolsSpec.empty()) {
    vpo::BarProvider barProvider = [&vpoStore](const std::string& symbol, const std::string& timeframe) {
      return vpoStore.getBars(symbol, timeframe);
    };
    vpo::VolumeResolver volumeResolver = [&vpoStore](const vpo::StrategyModule& s) {
      return vpoStore.getVolume(s.key() + ":" + s.order().symbol);
    };
    vpoDispatcher = std::make_unique<vpo::VpoDispatcher>(engine, barProvider, volumeResolver, vpoMacroTf, vpoMicroTf);

    // "SYMBOL:SYMBOLID:STRATEGYKEY[:DIGITS],..." — DIGITS (the symbol's
    // decimal price precision, e.g. 5 for EURUSD, 3 for USDJPY) is optional
    // and defaults to 5; it's needed to scale relativeStopLoss/
    // relativeTakeProfit into cTrader's wire units correctly (see
    // vpo_dispatcher.cpp's relativePoints() — a flat ×100000 is WRONG for
    // any symbol whose precision isn't 5 digits). Only vwap_trend/vp_value
    // are real ports; any other key is logged and skipped rather than
    // silently registering a stub that never arms.
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
      else {
        logLine("VPO_SYMBOLS: unknown/unported strategy key '" + key + "' — skipping (only vwap_trend, vp_value are real ports)");
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

  HttpServer server(port, execSecret);

  server.route("GET", "/health", [&engine](const HttpRequest&) -> HttpResponse {
    jsn::Value v{jsn::Object{}};
    v.set("ok", true);
    v.set("connected", engine.isConnected());
    v.set("hasCredentials", engine.hasCredentials());
    long long at = engine.lastReconcileAtMs();
    v.set("lastReconcileAt", at > 0 ? jsn::Value(at) : jsn::Value(nullptr));
    // Telemetry counters — null when TELEMETRY_PATH isn't configured, so the
    // Node keeper can tell "disabled" apart from "configured, zero events".
    if (Telemetry* t = engine.telemetry()) {
      v.set("telemetryWritten", static_cast<double>(t->written()));
      v.set("telemetryDropped", static_cast<double>(t->dropped()));
    } else {
      v.set("telemetryWritten", jsn::Value(nullptr));
      v.set("telemetryDropped", jsn::Value(nullptr));
    }
    return {200, jsn::dump(v)};
  });

  server.route("GET", "/positions", [&engine](const HttpRequest&) -> HttpResponse {
    std::string last = engine.lastReconcileJson();
    if (last.empty())
      return {503, "{\"error\":\"no reconcile data yet\"}"};
    return {200, last};
  });

  server.route("POST", "/connect", [&engine, &vpoDispatcher, &vpoSymbolIds, &spotFeed, &spotFeedThread, &vpoMtx](const HttpRequest& req) -> HttpResponse {
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
    engine.setCredentials(host.empty() ? "live.ctraderapi.com" : host,
                          clientId, clientSecret, accessToken, accountId);
    logLine("credentials updated via /connect");

    // (Re)start the VPO tick feed against the freshly pushed session — the
    // sidecar holds no credentials of its own until /connect delivers them,
    // same as ExecEngine above. Stop-then-join the old feed BEFORE
    // replacing the pointer: SpotFeed::runLoop() runs on a detached-less
    // thread against `*spotFeed`, so swapping the object out from under a
    // still-running thread would be a use-after-free.
    if (vpoDispatcher && !vpoSymbolIds.empty()) {
      std::lock_guard<std::mutex> lk(vpoMtx);
      if (spotFeed) {
        spotFeed->stop();
        if (spotFeedThread.joinable()) spotFeedThread.join();
      }
      vpo::VpoDispatcher* dispatcherPtr = vpoDispatcher.get();
      spotFeed = std::make_unique<SpotFeed>(
          host.empty() ? "live.ctraderapi.com" : host, clientId, clientSecret, accessToken, accountId,
          vpoSymbolIds,
          [dispatcherPtr](long long symbolId, double bid, double ask) { dispatcherPtr->onTick(symbolId, bid, ask); });
      SpotFeed* feedPtr = spotFeed.get();
      spotFeedThread = std::thread([feedPtr] { feedPtr->runLoop(); });
      logLine("VPO spot feed (re)started for " + std::to_string(vpoSymbolIds.size()) + " symbol(s)");
    }
    return {200, "{\"ok\":true}"};
  });

  // Node pushes trendbars + real risk.js-resolved position sizes here on a
  // timer (see agent/services/vpo-feeder.js) — this binary never fetches
  // bars or computes sizing itself. Safe to call whether or not VPO is
  // enabled/running (a no-op store nobody reads yet).
  server.route("POST", "/vpo-config", [&vpoStore](const HttpRequest& req) -> HttpResponse {
    auto parsed = jsn::parse(req.body);
    if (!parsed || !parsed->isObject())
      return {400, "{\"error\":\"body must be a JSON object\"}"};
    const jsn::Value& v = *parsed;
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
    jsn::Value out{jsn::Object{}};
    out.set("ok", true);
    out.set("barsUpdated", barsUpdated);
    out.set("volumesUpdated", volsUpdated);
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
  server.route("POST", "/config", [&engine](const HttpRequest& req) -> HttpResponse {
    auto parsed = jsn::parse(req.body);
    if (!parsed || !parsed->isObject())
      return {400, "{\"error\":\"body must be a JSON object\"}"};
    const jsn::Value& v = *parsed;
    if (v.get("halt").isBool()) engine.guard().setHalt(v.get("halt").asBool());
    if (v.get("requireBracket").isBool()) engine.guard().setRequireBracket(v.get("requireBracket").asBool());
    if (v.get("requireTarget").isBool()) engine.guard().setRequireTarget(v.get("requireTarget").asBool());
    if (v.get("maxOrderVolume").isNumber()) engine.guard().setMaxOrderVolume(v.get("maxOrderVolume").asNumber());
    const GuardSnapshot g = engine.guard().snapshot();
    jsn::Value out{jsn::Object{}};
    out.set("ok", true);
    out.set("halt", g.halt);
    out.set("requireBracket", g.requireBracket);
    out.set("requireTarget", g.requireTarget);
    out.set("maxOrderVolume", g.maxOrderVolume);
    return {200, jsn::dump(out)};
  });

  // Same payload/response as `cpp-exec --backtest` (Bearer-gated like every
  // other route). Payload guarded at 5MB in handleBacktest; note the socket
  // reader also enforces its own 4 MiB body cap.
  server.route("POST", "/backtest", [](const HttpRequest& req) {
    return handleBacktest(req.body);
  });

  logLine("starting on port " + std::to_string(port));
  if (!server.run()) return 1;
  return 0;
}
