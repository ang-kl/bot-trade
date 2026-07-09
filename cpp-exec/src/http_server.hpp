// cpp-exec/src/http_server.hpp
//
// Minimal single-purpose HTTP/1.1 server: bearer-token gate in front of the
// ExecEngine. One thread per connection, Connection: close semantics —
// traffic is a handful of keeper calls per minute, not a web workload.
#pragma once

#include <functional>
#include <map>
#include <string>

struct HttpRequest {
  std::string method;
  std::string path;
  std::map<std::string, std::string> headers; // keys lower-cased
  std::string body;
};

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

private:
  void handleClient(int fd);

  int port_;
  std::string secret_;
  std::map<std::string, HttpHandler> routes_; // key: "METHOD path"
};
