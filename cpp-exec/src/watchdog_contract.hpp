#pragma once
#include "http_server.hpp"
#include "json.hpp"
#include <functional>

struct GatewayWorkView {
  std::string service, host;
  long long now = 0, startedAt = 0, feedAccount = 0, quoteMaxAgeMs = 0;
  bool connected = false, credentials = false;
  std::vector<std::pair<long long, long long>> reconciles, quotes;
};
jsn::Value gatewayWorkContract(const GatewayWorkView& view);
void registerGatewayWatchdog(HttpServer& server, const std::string& secret, std::function<GatewayWorkView()> read);
