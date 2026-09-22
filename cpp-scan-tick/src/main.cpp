#include "scanner.hpp"
#include "http_server.hpp"
#include <csignal>
#include <cstdlib>
int main() {
  std::signal(SIGPIPE, SIG_IGN);
  const char* token = std::getenv("SCANNER_SECRET"); if (!token || !*token) return 2;
  const char* port = std::getenv("PORT");
  scan::TickScanner scanner; HttpServer server(port ? std::atoi(port) : 8080, token);
  server.route("GET", "/health", [](const auto&) { return HttpResponse{200, "{\"ok\":true,\"service\":\"cpp-scan-tick\",\"orderAuthority\":false,\"mode\":\"mirror\"}"}; });
  server.route("GET", "/watchdog", [&](const auto&) { return HttpResponse{200, jsn::dump(scanner.status())}; });
  server.route("POST", "/feed", [&](const HttpRequest& req) {
    if (req.body.size() > 256 * 1024) return HttpResponse{413, "{\"error\":\"batch_bound\"}"};
    try { const auto body = jsn::parse(req.body); if (!body) throw std::invalid_argument("invalid_json"); return HttpResponse{202, jsn::dump(scanner.submit(*body))}; }
    catch (const std::invalid_argument& e) { return HttpResponse{400, jsn::dump(jsn::Value(jsn::Object{{"error", e.what()}}))}; }
    catch (const std::exception&) { return HttpResponse{429, "{\"error\":\"bounded_capacity_unavailable\"}"}; }
  });
  server.route("GET", "/candidates", [&](const HttpRequest& req) {
    try { const auto raw = queryParam(req.query, "after", "0"); size_t end; const auto after = std::stoll(raw, &end); if (after < 0 || end != raw.size()) throw std::invalid_argument("cursor"); return HttpResponse{200, jsn::dump(scanner.candidates(after))}; }
    catch (...) { return HttpResponse{400, "{\"error\":\"invalid_cursor\"}"}; }
  });
  return server.run() ? 0 : 1;
}
