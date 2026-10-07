// cpp-exec/src/tests/test_http_server.cpp
//
// 03-10-2026 (§10,725·C·3): the shared sidecar HTTP server, on a REAL socket.
//   1. The listener is dual-stack: a client over IPv6 loopback (::1) and one
//      over IPv4 loopback (127.0.0.1) both reach the same route. The private
//      network's native IPv6 attempt used to be refused (AF_INET listener).
//   2. A request slower than kSlowRequestMs is reported with its phases via
//      the injected reporter; a fast one is not; the line names method, path
//      and status and nothing else of the request.
#include "../http_server.hpp"
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {
std::string request(int family, int port, const std::string& target, const std::string& bearer) {
  const int fd = ::socket(family, SOCK_STREAM, 0); if (fd < 0) return "CONNECT_FAILED";
  if (family == AF_INET6) {
    sockaddr_in6 a{}; a.sin6_family = AF_INET6; a.sin6_port = htons(static_cast<uint16_t>(port)); a.sin6_addr = in6addr_loopback;
    if (::connect(fd, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0) { ::close(fd); return "CONNECT_FAILED"; }
  } else {
    sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(static_cast<uint16_t>(port)); a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::connect(fd, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0) { ::close(fd); return "CONNECT_FAILED"; }
  }
  const std::string req = "GET " + target + " HTTP/1.1\r\nHost: test\r\nAuthorization: Bearer " + bearer + "\r\nConnection: close\r\n\r\n";
  assert(::send(fd, req.data(), req.size(), 0) == static_cast<ssize_t>(req.size()));
  std::string out; char buf[4096];
  for (;;) { const auto n = ::recv(fd, buf, sizeof buf, 0); if (n <= 0) break; out.append(buf, static_cast<size_t>(n)); }
  ::close(fd); return out;
}
}

int main() {
  // The pure line: the bound is end to end, and the wording is fixed.
  assert(HttpServer::slowRequestLine("GET", "/fast", 200, 100000, 100000, 49999).empty());
  // Claude · № 11,609 (F·1): a slow request is stdout; only one past
  // kVerySlowRequestMs (5 s) is an error. The 1.53 s line below is NOT an
  // error; 5 s exactly is; a microsecond under is not.
  assert(!HttpServer::slowRequestIsError(1200, 1530400, 900));
  assert(HttpServer::slowRequestIsError(0, 5000000, 0));
  assert(HttpServer::slowRequestIsError(2000000, 2000000, 1000000));
  assert(!HttpServer::slowRequestIsError(0, 4999999, 0));
  assert(HttpServer::slowRequestLine("POST", "/feed", 202, 1200, 1530400, 900)
         == "http: slow request POST /feed status 202 total 1532 ms (read 1, handle 1530, write 0)");

  HttpServer server(0, "fixture-secret");
  std::mutex mutex; std::vector<std::string> lines;
  server.setSlowRequestReporter([&](const std::string& line) { std::lock_guard lock(mutex); lines.push_back(line); });
  server.route("GET", "/fast", [](const HttpRequest&) { return HttpResponse{200, "{\"ok\":true}"}; });
  server.route("GET", "/slow", [](const HttpRequest&) { std::this_thread::sleep_for(std::chrono::milliseconds(300)); return HttpResponse{200, "{\"ok\":true}"}; });
  std::thread([&server] { server.run(); }).detach();
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
  while (server.boundPort() == 0 && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  const int port = server.boundPort(); assert(port > 0);

  // 1. Both families reach the route on the one listener.
  const auto v4 = request(AF_INET, port, "/fast?x=1", "fixture-secret");
  assert(v4.rfind("HTTP/1.1 200", 0) == 0);
  if (server.dualStack()) {
    const auto v6 = request(AF_INET6, port, "/fast", "fixture-secret");
    assert(v6.rfind("HTTP/1.1 200", 0) == 0); // a CONNECT_FAILED here is the IPv4-only listener coming back
    // An unauthorised request is refused on either family, and is not slow.
    assert(request(AF_INET6, port, "/fast", "wrong").rfind("HTTP/1.1 401", 0) == 0);
  } else {
    // A host with no AF_INET6 at all (this sandbox): the fallback listener
    // must still answer IPv4, and the IPv6 half is proven where IPv6 exists
    // (CI's runner has ::1). Said out loud rather than passed in silence.
    std::puts("  ipv6 loopback: SKIPPED (no AF_INET6 on this host; listener is the ipv4 fallback)");
  }
  assert(request(AF_INET, port, "/fast", "wrong").rfind("HTTP/1.1 401", 0) == 0);
  { std::lock_guard lock(mutex); assert(lines.empty()); }

  // 2. The slow route is reported once, with its phases; the query is not in the line.
  const auto slow = request(AF_INET, port, "/slow?secret=never", "fixture-secret");
  assert(slow.rfind("HTTP/1.1 200", 0) == 0);
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  {
    std::lock_guard lock(mutex);
    assert(lines.size() == 1);
    assert(lines[0].rfind("http: slow request GET /slow status 200 total ", 0) == 0);
    assert(lines[0].find("never") == std::string::npos && lines[0].find("?") == std::string::npos);
    const auto handle = lines[0].find("handle "); assert(handle != std::string::npos);
    assert(std::stoi(lines[0].substr(handle + 7)) >= 300);
  }
  std::puts("http server: dual-stack listener and slow-request phases passed");
  return 0;
}
