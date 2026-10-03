// cpp-exec/src/http_server.cpp
#include "http_server.hpp"
#include "log.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <thread>

static void logInfo(const std::string& msg) { sidecar_log::logInfo("[cpp-exec]", msg); }
static void logError(const std::string& msg) { sidecar_log::logError("[cpp-exec]", msg); }

HttpServer::HttpServer(int port, std::string bearerSecret)
    : port_(port), secret_(std::move(bearerSecret)) {}

void HttpServer::route(const std::string& method, const std::string& path,
                       HttpHandler h) {
  routes_[method + " " + path] = std::move(h);
}

bool HttpServer::run() {
  // 03-10-2026 (§10,725·C·3, measured in Railway's flow logs): the private
  // network is IPv6 natively and a service name resolves to BOTH families,
  // so a gateway's curl tried IPv6 first on every delivery and this listener,
  // AF_INET only, refused it (NO_SOCKET at the scanner, 251 refused attempts
  // beside 249 answered IPv4 requests in 13 s). The listener is dual-stack
  // now: an AF_INET6 socket with V6ONLY off serves both families on the
  // INADDR_ANY equivalent, and a host without IPv6 falls back to AF_INET.
  int fd = ::socket(AF_INET6, SOCK_STREAM, 0);
  const bool dual = fd >= 0;
  if (!dual) fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { logError("http: socket failed"); return false; }
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  int bound = -1;
  if (dual) {
    int off = 0;
    setsockopt(fd, IPPROTO_IPV6, IPV6_V6ONLY, &off, sizeof off);
    sockaddr_in6 addr{};
    addr.sin6_family = AF_INET6;
    addr.sin6_addr = in6addr_any;
    addr.sin6_port = htons(static_cast<uint16_t>(port_));
    bound = ::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr);
  } else {
    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(static_cast<uint16_t>(port_));
    bound = ::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr);
  }
  if (bound < 0 || ::listen(fd, 16) < 0) {
    logError("http: bind/listen failed on port " + std::to_string(port_));
    ::close(fd);
    return false;
  }
  {
    // The kernel's choice when port_ is 0 (tests); the configured port otherwise.
    sockaddr_storage name{};
    socklen_t len = sizeof name;
    if (::getsockname(fd, reinterpret_cast<sockaddr*>(&name), &len) == 0)
      boundPort_.store(ntohs(name.ss_family == AF_INET6 ? reinterpret_cast<sockaddr_in6*>(&name)->sin6_port
                                                         : reinterpret_cast<sockaddr_in*>(&name)->sin_port));
    else boundPort_.store(port_);
    dualStack_.store(dual);
  }
  logInfo("http: listening on :" + std::to_string(boundPort_.load()) + (dual ? " (dual-stack)" : " (ipv4 only)"));
  for (;;) {
    int cfd = ::accept(fd, nullptr, nullptr);
    if (cfd < 0) continue;
    // Socket timeouts BEFORE any read: without them a peer that connects and
    // sends nothing (or declares a large Content-Length and stalls) pinned a
    // detached thread forever — unbounded thread + memory growth on an
    // INADDR_ANY listener (audit #9).
    timeval tv{};
    tv.tv_sec = 10;
    setsockopt(cfd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(cfd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    std::thread([this, cfd] { handleClient(cfd); }).detach();
  }
}

// PR-I: percent-decoding for query values. A '+' is a space only in form
// bodies, not in a path query, so it is left alone; a malformed escape is
// left literal rather than guessed at.
static std::string percentDecode(const std::string& s) {
  std::string out;
  out.reserve(s.size());
  auto hex = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  for (size_t i = 0; i < s.size(); ++i) {
    if (s[i] == '%' && i + 2 < s.size()) {
      const int hi = hex(s[i + 1]), lo = hex(s[i + 2]);
      if (hi >= 0 && lo >= 0) { out += static_cast<char>((hi << 4) | lo); i += 2; continue; }
    }
    out += s[i];
  }
  return out;
}

std::string queryParam(const std::string& query, const std::string& key, const std::string& dflt) {
  size_t pos = 0;
  while (pos <= query.size()) {
    size_t amp = query.find('&', pos);
    if (amp == std::string::npos) amp = query.size();
    const std::string pair = query.substr(pos, amp - pos);
    const size_t eq = pair.find('=');
    if (eq != std::string::npos && percentDecode(pair.substr(0, eq)) == key)
      return percentDecode(pair.substr(eq + 1));
    if (amp == query.size()) break;
    pos = amp + 1;
  }
  return dflt;
}

static bool readRequest(int fd, HttpRequest& req, bool& tooLarge) {
  std::string data;
  char tmp[8192];
  size_t headerEnd = std::string::npos;
  while (headerEnd == std::string::npos) {
    ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) return false;
    data.append(tmp, static_cast<size_t>(n));
    if (data.size() > 1 << 20) return false; // 1 MiB header cap
    headerEnd = data.find("\r\n\r\n");
  }

  // Request line
  size_t lineEnd = data.find("\r\n");
  std::string line = data.substr(0, lineEnd);
  size_t sp1 = line.find(' ');
  size_t sp2 = line.find(' ', sp1 + 1);
  if (sp1 == std::string::npos || sp2 == std::string::npos) return false;
  req.method = line.substr(0, sp1);
  req.path = line.substr(sp1 + 1, sp2 - sp1 - 1);
  size_t q = req.path.find('?');
  if (q != std::string::npos) {
    req.query = req.path.substr(q + 1);
    req.path.resize(q);
  }

  // Headers
  size_t pos = lineEnd + 2;
  while (pos < headerEnd) {
    size_t eol = data.find("\r\n", pos);
    std::string h = data.substr(pos, eol - pos);
    pos = eol + 2;
    size_t colon = h.find(':');
    if (colon == std::string::npos) continue;
    std::string key = h.substr(0, colon);
    for (auto& c : key) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    std::string val = h.substr(colon + 1);
    val.erase(0, val.find_first_not_of(" \t"));
    val.erase(val.find_last_not_of(" \t") + 1);
    req.headers[key] = val;
  }

  // Body per Content-Length
  size_t contentLen = 0;
  auto it = req.headers.find("content-length");
  if (it != req.headers.end()) contentLen = std::strtoul(it->second.c_str(), nullptr, 10);
  // 8 MiB reader cap: above the /backtest 5MB guard so oversize-but-sane
  // payloads reach the route's 413, while bombs (declared 100MB) are refused
  // here WITHOUT buffering — handleClient answers 413 instead of a silent
  // close so callers get a real 4xx.
  if (contentLen > 8u << 20) { tooLarge = true; return false; }
  std::string body = data.substr(headerEnd + 4);
  while (body.size() < contentLen) {
    ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) return false;
    body.append(tmp, static_cast<size_t>(n));
  }
  body.resize(contentLen);
  req.body = std::move(body);
  return true;
}

static void writeResponse(int fd, int status, const std::string& body) {
  const char* reason = status == 200 ? "OK"
                     : status == 401 ? "Unauthorized"
                     : status == 404 ? "Not Found"
                     : status == 400 ? "Bad Request"
                     : status == 413 ? "Payload Too Large"
                     : status == 502 ? "Bad Gateway"
                     : "Error";
  std::string resp = "HTTP/1.1 " + std::to_string(status) + " " + reason +
                     "\r\nContent-Type: application/json\r\nContent-Length: " +
                     std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" +
                     body;
  size_t off = 0;
  while (off < resp.size()) {
    ssize_t n = ::send(fd, resp.data() + off, resp.size() - off, 0);
    if (n <= 0) break;
    off += static_cast<size_t>(n);
  }
}

std::string HttpServer::slowRequestLine(const std::string& method, const std::string& path, int status,
                                        long long readUs, long long handleUs, long long writeUs) {
  const auto total = readUs + handleUs + writeUs;
  if (total < kSlowRequestMs * 1000) return {};
  const auto ms = [](long long us) { return std::to_string(us / 1000); };
  return "http: slow request " + method + " " + path + " status " + std::to_string(status) + " total " + ms(total)
       + " ms (read " + ms(readUs) + ", handle " + ms(handleUs) + ", write " + ms(writeUs) + ")";
}

static long long elapsedUs(std::chrono::steady_clock::time_point a, std::chrono::steady_clock::time_point b) {
  return std::chrono::duration_cast<std::chrono::microseconds>(b - a).count();
}

void HttpServer::handleClient(int fd) {
  using Clock = std::chrono::steady_clock;
  // Every exit of this function settles the request's timing: a request that
  // was slow to READ (a stalled peer) is reported the same as a slow handler.
  struct Timing {
    explicit Timing(HttpServer& s) : server(s) {}
    HttpServer& server; std::string method, path; int status = 0;
    Clock::time_point t0 = Clock::now(), read = Clock::time_point{}, handled = Clock::time_point{};
    ~Timing() {
      const auto end = Clock::now();
      const auto readEnd = read == Clock::time_point{} ? end : read;
      const auto handleEnd = handled == Clock::time_point{} ? readEnd : handled;
      const auto line = slowRequestLine(method, path, status, elapsedUs(t0, readEnd), elapsedUs(readEnd, handleEnd), elapsedUs(handleEnd, end));
      if (line.empty()) return;
      // At most one line a second: a stalled scanner must not flood the log
      // with one line per queued request.
      static std::mutex gate; static Clock::time_point last;
      { std::lock_guard lock(gate); if (last != Clock::time_point{} && end - last < std::chrono::seconds(1)) return; last = end; }
      if (server.slowReporter_) server.slowReporter_(line); else logError(line);
    }
  } timing(*this);
  HttpRequest req;
  bool tooLarge = false;
  if (!readRequest(fd, req, tooLarge)) {
    // Best-effort 413 for oversized Content-Length (body not drained).
    if (tooLarge) writeResponse(fd, 413, "{\"error\":\"payload too large\"}");
    ::close(fd);
    return;
  }

  timing.read = Clock::now(); timing.method = req.method; timing.path = req.path;
  // GET /health stays open: Railway's healthcheck probes without headers,
  // and the response carries no credentials or broker data.
  const bool isHealth = req.method == "GET" && req.path == "/health";
  auto auth = req.headers.find("authorization");
  if (!isHealth &&
      (auth == req.headers.end() || auth->second != "Bearer " + secret_)) {
    timing.handled = Clock::now(); timing.status = 401;
    writeResponse(fd, 401, "{\"error\":\"unauthorized\"}");
    ::close(fd);
    return;
  }

  auto it = routes_.find(req.method + " " + req.path);
  if (it == routes_.end()) {
    timing.handled = Clock::now(); timing.status = 404;
    writeResponse(fd, 404, "{\"error\":\"not found\"}");
    ::close(fd);
    return;
  }

  HttpResponse res = it->second(req);
  timing.handled = Clock::now(); timing.status = res.status;
  writeResponse(fd, res.status, res.body);
  ::close(fd);
}
