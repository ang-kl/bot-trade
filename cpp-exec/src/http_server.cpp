// cpp-exec/src/http_server.cpp
#include "http_server.hpp"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cctype>
#include <cstdio>
#include <cstring>
#include <thread>

static void logLine(const std::string& msg) {
  std::fprintf(stderr, "[cpp-exec] %s\n", msg.c_str());
}

HttpServer::HttpServer(int port, std::string bearerSecret)
    : port_(port), secret_(std::move(bearerSecret)) {}

void HttpServer::route(const std::string& method, const std::string& path,
                       HttpHandler h) {
  routes_[method + " " + path] = std::move(h);
}

bool HttpServer::run() {
  int fd = ::socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { logLine("http: socket failed"); return false; }
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = INADDR_ANY;
  addr.sin_port = htons(static_cast<uint16_t>(port_));
  if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0 ||
      ::listen(fd, 16) < 0) {
    logLine("http: bind/listen failed on port " + std::to_string(port_));
    ::close(fd);
    return false;
  }
  logLine("http: listening on :" + std::to_string(port_));
  for (;;) {
    int cfd = ::accept(fd, nullptr, nullptr);
    if (cfd < 0) continue;
    std::thread([this, cfd] { handleClient(cfd); }).detach();
  }
}

static bool readRequest(int fd, HttpRequest& req) {
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
  if (q != std::string::npos) req.path.resize(q);

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
  if (contentLen > 4u << 20) return false; // 4 MiB body cap
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

void HttpServer::handleClient(int fd) {
  HttpRequest req;
  if (!readRequest(fd, req)) {
    ::close(fd);
    return;
  }

  auto auth = req.headers.find("authorization");
  if (auth == req.headers.end() || auth->second != "Bearer " + secret_) {
    writeResponse(fd, 401, "{\"error\":\"unauthorized\"}");
    ::close(fd);
    return;
  }

  auto it = routes_.find(req.method + " " + req.path);
  if (it == routes_.end()) {
    writeResponse(fd, 404, "{\"error\":\"not found\"}");
    ::close(fd);
    return;
  }

  HttpResponse res = it->second(req);
  writeResponse(fd, res.status, res.body);
  ::close(fd);
}
