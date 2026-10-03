#include "scanner.hpp"
#include "http_server.hpp"
#include "log.hpp"
#include <chrono>
#include <mutex>
#include <csignal>
#include <cstdlib>
int main() {
  std::signal(SIGPIPE, SIG_IGN);
  const char* token = std::getenv("SCANNER_SECRET"); if (!token || !*token) return 2;
  const char* port = std::getenv("PORT");
  scan::TickScanner scanner; HttpServer server(port ? std::atoi(port) : 8080, token);
  server.route("GET", "/health", [](const auto&) { return HttpResponse{200, "{\"ok\":true,\"service\":\"cpp-scan-tick\",\"orderAuthority\":false,\"mode\":\"mirror\"}"}; });
  server.route("GET", "/watchdog", [&](const auto&) { return HttpResponse{200, jsn::dump(scanner.status())}; });
  // 03-10-2026 (§10,725·C·1): an ingest slower than kSlowIngestMs end to end
  // is logged with its phases, at most one line a second, so a gateway's
  // transport timeout can be read against what the scanner was doing.
  static std::mutex slowLogMutex; static std::chrono::steady_clock::time_point slowLogLast;
  server.route("POST", "/feed", [&](const HttpRequest& req) {
    if (req.body.size() > 256 * 1024) return HttpResponse{413, "{\"error\":\"batch_bound\"}"};
    const auto t0 = std::chrono::steady_clock::now(); long long jsonUs = 0, records = 0; scan::TickScanner::IngestTiming timing;
    const auto report = [&](std::string_view outcome) {
      const auto totalUs = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - t0).count();
      const auto inflight = scanner.status().get("ingest").get("inflight").asNumber();
      const auto line = scan::TickScanner::slowIngestLine(totalUs, jsonUs, timing, static_cast<long long>(inflight), records, outcome);
      if (line.empty()) return;
      std::lock_guard lock(slowLogMutex); const auto now = std::chrono::steady_clock::now();
      if (slowLogLast.time_since_epoch().count() && now - slowLogLast < std::chrono::seconds(1)) return;
      slowLogLast = now; sidecar_log::logWarn("[cpp-scan-tick]", line);
    };
    try {
      const auto body = jsn::parse(req.body); jsonUs = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now() - t0).count();
      if (!body) throw std::invalid_argument("invalid_json");
      if (body->get("records").isArray()) records = static_cast<long long>(body->get("records").asArray().size());
      const auto reply = jsn::dump(scanner.submit(*body, &timing)); report("accepted"); return HttpResponse{202, reply};
    }
    catch (const std::invalid_argument& e) { report("invalid"); return HttpResponse{400, jsn::dump(jsn::Value(jsn::Object{{"error", e.what()}}))}; }
    catch (const std::exception& e) { report("refused"); return HttpResponse{429, std::string("{\"error\":\"bounded_capacity_unavailable\",\"cause\":\"") + scan::capacityCause(e.what()) + "\"}"}; }
  });
  server.route("GET", "/candidates", [&](const HttpRequest& req) {
    try { const auto raw = queryParam(req.query, "after", "0"); size_t end; const auto after = std::stoll(raw, &end); if (after < 0 || end != raw.size()) throw std::invalid_argument("cursor"); return HttpResponse{200, jsn::dump(scanner.candidates(after))}; }
    catch (...) { return HttpResponse{400, "{\"error\":\"invalid_cursor\"}"}; }
  });
  server.route("GET", "/comparisons", [&](const HttpRequest& req) {
    try { const auto raw = queryParam(req.query, "after", "0"); size_t end; const auto after = std::stoll(raw, &end); if (after < 0 || end != raw.size()) throw std::invalid_argument("cursor"); return HttpResponse{200, jsn::dump(scanner.comparisons(after))}; }
    catch (...) { return HttpResponse{400, "{\"error\":\"invalid_cursor\"}"}; }
  });
  return server.run() ? 0 : 1;
}
