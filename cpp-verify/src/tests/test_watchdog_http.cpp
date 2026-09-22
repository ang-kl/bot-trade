#include "../watchdog.hpp"
#include "../watchdog_http.hpp"
#include <arpa/inet.h>
#include <cassert>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <sys/socket.h>
#include <unistd.h>

namespace {
struct Server {
  int fd; unsigned short port; std::jthread worker;
  std::string request;
  Server(std::string body, int delay = 0, int status = 200) {
    fd = ::socket(AF_INET, SOCK_STREAM, 0); assert(fd >= 0);
    sockaddr_in addr{}; addr.sin_family = AF_INET; addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    assert(::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) == 0);
    socklen_t len = sizeof addr; assert(::getsockname(fd, reinterpret_cast<sockaddr*>(&addr), &len) == 0); port = ntohs(addr.sin_port);
    assert(::listen(fd, 1) == 0);
    worker = std::jthread([this, body, delay, status] {
      const int client = ::accept(fd, nullptr, nullptr); if (client < 0) return;
      char buf[4096]; const auto n = ::recv(client, buf, sizeof buf, 0); if (n > 0) request.assign(buf, n);
      std::this_thread::sleep_for(std::chrono::milliseconds(delay));
      const std::string response = "HTTP/1.1 " + std::to_string(status) + " Test\r\nContent-Type: application/json\r\nLocation: http://127.0.0.1:1/never\r\nContent-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
      size_t done = 0;
      while (done < response.size()) { const auto sent = ::send(client, response.data() + done, response.size() - done, MSG_NOSIGNAL); if (sent <= 0) break; done += sent; }
      ::close(client);
    });
  }
  ~Server() { ::shutdown(fd, SHUT_RDWR); ::close(fd); if (worker.joinable()) worker.join(); }
  std::string url() const { return "http://127.0.0.1:" + std::to_string(port) + "/probe"; }
};
}
int main() {
  std::signal(SIGPIPE, SIG_IGN);
  {
    Server s(R"({"ok":true,"result":{"message_id":123}})");
    const auto r = verify::watchHttp(s.url(), "fixture-token", R"({"text":"fixture"})");
    assert(r.received && r.body.get("result").get("message_id").asNumber() == 123);
    s.worker.join();
    assert(s.request.find("Authorization: Bearer fixture-token") != std::string::npos);
  }
  {
    Server s("{}", 250);
    const auto before = std::chrono::steady_clock::now();
    assert(!verify::watchHttp(s.url(), "", "", 50).received);
    assert(std::chrono::steady_clock::now() - before < std::chrono::seconds(1));
  }
  { Server s("{}", 0, 302); const auto r = verify::watchHttp(s.url(), ""); assert(!r.received && r.status == 302); }
  { Server s(std::string(300000, 'x')); assert(!verify::watchHttp(s.url(), "").received); }
  {
    char path[] = "/tmp/watchdog-persistence-XXXXXX"; assert(::mkdtemp(path));
    ::setenv("WATCHDOG_ENABLED", "1", 1); ::setenv("WATCHDOG_MASTER_ENABLED", "0", 1);
    ::setenv("VERIFY_JOURNAL_DIR", path, 1);
    for (const auto key : {"WATCHDOG_NODE_URL", "WATCHDOG_EXEC_URL", "WATCHDOG_ACCT_URL", "WATCHDOG_TICK_URL", "WATCHDOG_TIMEFRAME_URL", "WATCHDOG_POLICY_JSON"}) ::unsetenv(key);
    {
      verify::Watchdog first([] { return jsn::Value(jsn::Object{}); }); first.start();
      verify::Watchdog second([] { return jsn::Value(jsn::Object{}); }); second.start();
      assert(second.status().get("error").asString() == "watchdog_state_already_owned_or_lock_unavailable");
    }
    assert(std::filesystem::exists(std::string(path) + "/watchdog-state.json"));
    { verify::Watchdog restored([] { return jsn::Value(jsn::Object{}); }); restored.start(); assert(restored.status().get("enabled").asBool()); }
    std::filesystem::remove_all(path);
  }
  std::cout << "bounded HTTP and durable exclusive watchdog state passed\n";
}
