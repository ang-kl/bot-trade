#include "watchdog_contract.hpp"
jsn::Value gatewayWorkContract(const GatewayWorkView& v) {
  jsn::Array work;
  const bool bounded = v.reconciles.size() + v.quotes.size() <= 2048;
  for (const auto& [account, completed] : v.reconciles) {
    if (work.size() >= 2048) break;
    // The existing engine waits 30s after its sequential reconcile sweep.
    // Each account request already has a 10s deadline; expose that maximum
    // scheduled sweep budget without changing the broker polling cadence.
    const auto budget = 30000 + static_cast<long long>(v.reconciles.size()) * 10000;
    work.push_back(jsn::Value(jsn::Object{{"id", "reconcile:" + std::to_string(account)}, {"role", "gateway"},
      {"accountId", std::to_string(account)}, {"host", v.host}, {"lastCompletedAtMs", completed},
      {"nextDueMs", (completed > 0 ? completed : v.startedAt) + budget},
      {"connected", v.connected}, {"reason", "broker_reconcile"}}));
  }
  if (v.reconciles.empty()) work.push_back(jsn::Value(jsn::Object{{"id", "broker_connection"}, {"role", "gateway"},
    {"lastCompletedAtMs", jsn::Value()}, {"nextDueMs", v.startedAt + 30000},
    {"reason", v.credentials ? "account_authorization_unavailable" : "credentials_unconfigured"}}));
  for (const auto& [symbol, received] : v.quotes) {
    if (work.size() >= 2048) break;
    work.push_back(jsn::Value(jsn::Object{{"id", "quote:" + std::to_string(v.feedAccount) + ":" + std::to_string(symbol)}, {"role", "quote_flow"},
      {"accountId", std::to_string(v.feedAccount)}, {"symbolId", std::to_string(symbol)}, {"host", v.host},
      {"lastCompletedAtMs", received}, {"lastQuoteAtMs", received}, {"quoteMaxAgeMs", v.quoteMaxAgeMs},
      {"calendar", jsn::Value()}, {"reason", "existing_spot_feed"}}));
  }
  jsn::Value out(jsn::Object{{"schemaVersion", 1}, {"service", v.service}, {"observedAtMs", v.now},
    {"workComplete", bounded && (v.service == "cpp-exec" || v.service == "cpp-acct")}, {"work", work}});
  if (jsn::dump(out).size() > 256 * 1024) { out.set("workComplete", false); out.set("work", jsn::Array{}); }
  return out;
}
void registerGatewayWatchdog(HttpServer& server, const std::string& secret, std::function<GatewayWorkView()> read) {
  server.route("GET", "/watchdog", [secret, read](const HttpRequest& req) {
    const auto auth = req.headers.find("authorization");
    if (secret.empty() || auth == req.headers.end() || auth->second != "Bearer " + secret) return HttpResponse{401, "{\"error\":\"read_authentication_required\"}"};
    return HttpResponse{200, jsn::dump(gatewayWorkContract(read()))};
  });
}
