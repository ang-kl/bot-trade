// cpp-exec/src/main.cpp
//
// Sidecar entrypoint: one engine thread (connect + auth + heartbeat + 30s
// reconcile poll) and the HTTP server on the main thread. All env-driven —
// no config files, matching how the Node keeper is configured on Railway.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>

#include "backtest.hpp"
#include "engine.hpp"
#include "http_server.hpp"
#include "json.hpp"

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

  ExecEngine engine;
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

  HttpServer server(port, execSecret);

  server.route("GET", "/health", [&engine](const HttpRequest&) -> HttpResponse {
    jsn::Value v{jsn::Object{}};
    v.set("ok", true);
    v.set("connected", engine.isConnected());
    v.set("hasCredentials", engine.hasCredentials());
    long long at = engine.lastReconcileAtMs();
    v.set("lastReconcileAt", at > 0 ? jsn::Value(at) : jsn::Value(nullptr));
    return {200, jsn::dump(v)};
  });

  server.route("GET", "/positions", [&engine](const HttpRequest&) -> HttpResponse {
    std::string last = engine.lastReconcileJson();
    if (last.empty())
      return {503, "{\"error\":\"no reconcile data yet\"}"};
    return {200, last};
  });

  server.route("POST", "/connect", [&engine](const HttpRequest& req) -> HttpResponse {
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
    return {200, "{\"ok\":true}"};
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
