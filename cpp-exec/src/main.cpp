// cpp-exec/src/main.cpp
//
// Sidecar entrypoint: one engine thread (connect + auth + heartbeat + 30s
// reconcile poll) and the HTTP server on the main thread. All env-driven —
// no config files, matching how the Node keeper is configured on Railway.
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>

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

int main() {
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

  logLine("starting on port " + std::to_string(port));
  if (!server.run()) return 1;
  return 0;
}
