// cpp-exec/src/http_server.hpp
//
// Minimal single-purpose HTTP/1.1 server: bearer-token gate in front of the
// ExecEngine. One thread per connection, Connection: close semantics —
// traffic is a handful of keeper calls per minute, not a web workload.
#pragma once

#include <atomic>
#include <functional>
#include <map>
#include <string>

struct HttpRequest {
  std::string method;
  std::string path;
  // PR-I: the raw query string (no leading '?'), empty when there is none.
  // The route table is still keyed on the PATH alone — the query is data for
  // the handler, never part of the dispatch key.
  std::string query;
  std::map<std::string, std::string> headers; // keys lower-cased
  std::string body;
};

/**
 * One parameter out of a raw `a=1&b=2` query string, percent-decoded.
 * Returns `dflt` when the key is absent. Repeats: the FIRST occurrence wins,
 * so a second `?name=` cannot smuggle a different value past a check made on
 * the first.
 */
std::string queryParam(const std::string& query, const std::string& key, const std::string& dflt = "");

struct HttpResponse {
  int status = 200;
  std::string body;          // JSON
};

using HttpHandler = std::function<HttpResponse(const HttpRequest&)>;

class HttpServer {
public:
  HttpServer(int port, std::string bearerSecret);

  // method+path -> handler. Auth is enforced before dispatch.
  void route(const std::string& method, const std::string& path, HttpHandler h);

  // Blocking accept loop. Returns false only if bind/listen failed.
  bool run();

  // 03-10-2026 (§10,725·C): the port the listener bound, 0 until it has.
  // A test passes port 0 and reads the kernel's choice here.
  int boundPort() const { return boundPort_.load(); }
  // True once a dual-stack (AF_INET6, V6ONLY off) listener is bound; false
  // on a host without IPv6, where the listener is the AF_INET fallback.
  bool dualStack() const { return dualStack_.load(); }

  // A request slower than this end to end (read, handler, write) is reported
  // with its phases: the gateways' scanner transport timeouts were requests
  // the scanner held for 1.5 s with nothing inside it saying where.
  static constexpr long long kSlowRequestMs = 250;
  // 07-10-2026 (Claude · № 11,609, F·1 of № 11,573; claude-builder): a slow
  // request is information about the PEER as often as about this server —
  // measured 06-10 on all three sidecars, the write phase was time blocked in
  // send() on Node's read side and the read phase was Node's event loop
  // stalling mid-request — so the line goes to stdout at kSlowRequestMs and
  // reaches stderr, the Railway error panel, only past kVerySlowRequestMs
  // (half of Node's 10 s abort). Before this every slow request was logged as
  // an error and the panel was red for nothing, which hid the real ones.
  static constexpr long long kVerySlowRequestMs = 5000;
  static bool slowRequestIsError(long long readUs, long long handleUs, long long writeUs) {
    return readUs + handleUs + writeUs >= kVerySlowRequestMs * 1000;
  }
  using SlowRequestReporter = std::function<void(const std::string&)>;
  // Default: the shared stream header (stderr). Tests capture the line.
  void setSlowRequestReporter(SlowRequestReporter reporter) { slowReporter_ = std::move(reporter); }
  // The line for a slow request, or "" for one inside the bound. Method and
  // path only: never the query, headers or body.
  static std::string slowRequestLine(const std::string& method, const std::string& path, int status,
                                     long long readUs, long long handleUs, long long writeUs);

private:
  void handleClient(int fd);

  int port_;
  std::string secret_;
  std::map<std::string, HttpHandler> routes_; // key: "METHOD path"
  std::atomic<int> boundPort_{0};
  std::atomic<bool> dualStack_{false};
  SlowRequestReporter slowReporter_;
};
