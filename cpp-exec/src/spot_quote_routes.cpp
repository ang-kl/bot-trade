// cpp-exec/src/spot_quote_routes.cpp — see spot_quote_routes.hpp.
#include "spot_quote_routes.hpp"

#include <chrono>
#include <cstdlib>
#include <set>

#include "json.hpp"

void registerSpotQuoteRoutes(HttpServer& server, QuoteFeedReader reader, const std::string& execSecret) {
  auto authorized = [execSecret](const HttpRequest& req) {
    if (execSecret.empty()) return false;
    auto it = req.headers.find("authorization");
    return it != req.headers.end() && it->second == "Bearer " + execSecret;
  };
  server.route("GET", "/quotes", [reader, authorized](const HttpRequest& req) -> HttpResponse {
    if (!authorized(req)) return {401, "{\"error\":\"unauthorized\"}"};
    // The filter is parsed before the feed is read so a malformed list
    // costs nothing under the feed's lock.
    std::set<long long> want;
    const std::string ids = queryParam(req.query, "ids", "");
    size_t pos = 0;
    while (pos <= ids.size() && !ids.empty()) {
      size_t comma = ids.find(',', pos);
      if (comma == std::string::npos) comma = ids.size();
      const long long id = std::strtoll(ids.substr(pos, comma - pos).c_str(), nullptr, 10);
      if (id > 0) want.insert(id);
      if (comma == ids.size()) break;
      pos = comma + 1;
    }
    const QuoteFeedView view = reader();
    jsn::Value v{jsn::Object{}};
    v.set("feed", std::string(!view.present ? "absent" : view.connected ? "up" : "down"));
    v.set("generation", static_cast<double>(view.present ? view.generation : 0));
    v.set("accountId", view.present && view.accountId > 0 ? jsn::Value(static_cast<double>(view.accountId)) : jsn::Value(nullptr));
    // The sidecar's OWN clock at answer time (checker SHOULD 4): recvMs is
    // stamped by this process's system_clock, so the keeper ages a quote as
    // nowMs - recvMs on ONE clock rather than against its own Date.now().
    v.set("nowMs", static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count()));
    jsn::Array arr;
    for (const SpotQuote& q : view.quotes) {
      if (!want.empty() && !want.count(q.symbolId)) continue;
      jsn::Value o{jsn::Object{}};
      o.set("symbolId", static_cast<double>(q.symbolId));
      o.set("bid", q.bid > 0 ? jsn::Value(q.bid) : jsn::Value(nullptr));
      o.set("ask", q.ask > 0 ? jsn::Value(q.ask) : jsn::Value(nullptr));
      o.set("tsMs", static_cast<double>(q.tsMs));
      o.set("recvMs", static_cast<double>(q.recvMs));
      arr.push_back(std::move(o));
    }
    v.set("count", static_cast<double>(arr.size()));
    v.set("quotes", jsn::Value(std::move(arr)));
    return {200, jsn::dump(v)};
  });
}
