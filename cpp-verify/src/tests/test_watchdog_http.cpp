#include "../watchdog.hpp"
#include "../watchdog_http.hpp"
#include <arpa/inet.h>
#include <cassert>
#include <chrono>
#include <csignal>
#include <cstdlib>
#include <fcntl.h>
#include <filesystem>
#include <fstream>
#include <set>
#include <sstream>
#include <sys/file.h>
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
long long wallMs() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
// The state file the build before 03-10-2026 wrote: Node's last contract with
// a notificationPolicy, one urgent incident, one outbox item never attempted,
// and the delivery block of an ended soak, unmuted — everything the removed
// channel needed to send. This build must restore it and send nothing.
std::string oldShapeFile(long long now) {
  const jsn::Value policy(jsn::Object{{"enabled", true}, {"owner", "cpp-verify"}, {"observedAtMs", now - 5000},
    {"expiresAtMs", now + 3600000}, {"urgentBypass", true}, {"quietIntervals", jsn::Array{}}});
  const jsn::Value contract(jsn::Object{{"schemaVersion", 1}, {"service", "node"}, {"observedAtMs", now - 5000},
    {"workComplete", true}, {"work", jsn::Array{}}, {"notificationPolicy", policy}});
  const jsn::Value node(jsn::Object{{"firstObservedAtMs", now - 5000}, {"attemptedAtMs", now - 5000}, {"reachable", true},
    {"lastReachableAtMs", now - 5000}, {"validContract", true}, {"lastContractAtMs", now - 5000}, {"contract", contract}});
  const jsn::Value item(jsn::Object{{"id", "fixture:gate:1"}, {"incidentId", "fixture:gate"}, {"transition", "opened"},
    {"severity", "urgent"}, {"detail", jsn::Object{{"service", "fixture"}, {"reason", "delivery_gate_test"}}},
    {"createdAtMs", now - 5000}, {"nextAtMs", now - 5000}, {"attempts", 0}, {"accepted", false}});
  jsn::Value s(jsn::Object{{"schemaVersion", 1}, {"services", jsn::Object{{"node", node}}},
    {"incidents", jsn::Object{{"fixture:gate", jsn::Object{{"active", true}, {"serial", 1}, {"severity", "urgent"},
      {"openedAtMs", now - 5000}, {"lastQueuedAtMs", now - 5000}}}}},
    {"outbox", jsn::Object{{"fixture:gate:1", item}}}, {"dropped", 1526163},
    {"delivery", jsn::Object{{"muted", false}, {"soakStartedAtMs", now - 2 * 86400000LL}, {"soakEndsAtMs", now - 86400000LL}}}});
  return jsn::dump(s);
}
const char* const kProbeKeys[]{"WATCHDOG_NODE_URL", "WATCHDOG_EXEC_URL", "WATCHDOG_ACCT_URL", "WATCHDOG_TICK_URL", "WATCHDOG_TIMEFRAME_URL", "WATCHDOG_POLICY_JSON"};
}
int main() {
  std::signal(SIGPIPE, SIG_IGN);
  {
    // A probe: GET with the bearer, a JSON object back. No body is ever sent
    // — the one caller that posted (the Telegram call) is gone.
    Server s(R"({"ok":true,"schemaVersion":1})");
    const auto r = verify::watchHttp(s.url(), "fixture-token");
    assert(r.received && r.body.get("schemaVersion").asNumber() == 1);
    s.worker.join();
    assert(s.request.find("Authorization: Bearer fixture-token") != std::string::npos);
    assert(s.request.rfind("GET /probe", 0) == 0);
    assert(s.request.find("Content-Type") == std::string::npos);
  }
  {
    Server s("{}", 250);
    const auto before = std::chrono::steady_clock::now();
    assert(!verify::watchHttp(s.url(), "", 50).received);
    assert(std::chrono::steady_clock::now() - before < std::chrono::seconds(1));
  }
  { Server s("{}", 0, 302); const auto r = verify::watchHttp(s.url(), ""); assert(!r.received && r.status == 302); }
  { Server s(std::string(300000, 'x')); assert(!verify::watchHttp(s.url(), "").received); }
  {
    char path[] = "/tmp/watchdog-persistence-XXXXXX"; assert(::mkdtemp(path));
    ::setenv("WATCHDOG_ENABLED", "1", 1);
    ::setenv("VERIFY_JOURNAL_DIR", path, 1);
    for (const auto key : kProbeKeys) ::unsetenv(key);
    {
      verify::Watchdog first([] { return jsn::Value(jsn::Object{}); }); first.start();
      verify::Watchdog second([] { return jsn::Value(jsn::Object{}); }); second.start();
      assert(second.status().get("error").asString() == "watchdog_state_already_owned_or_lock_unavailable");
    }
    assert(std::filesystem::exists(std::string(path) + "/watchdog-state.json"));
    {
      verify::Watchdog restored([] { return jsn::Value(jsn::Object{}); }); restored.start();
      const auto st = restored.status(); assert(st.get("enabled").asBool());
      // V3 CV-1: the relay rides /watchdog-status itself. With no Node
      // contract yet it says so — labelled, unavailable, never an empty
      // clean list.
      const auto& relay = st.get("entryDiagnostics");
      assert(relay.get("evidence").asString() == "node_records_relayed" && relay.get("brokerVerified").isBool() && !relay.get("brokerVerified").asBool());
      assert(!relay.get("available").asBool() && relay.get("reason").asString() == "no_node_contract_since_start" && relay.get("accounts").isArray());
      // The removed channel is named on the process status too.
      assert(st.get("delivery").get("channel").asString() == "none");
    }
    {
      verify::Watchdog off([] { return jsn::Value(jsn::Object{}); }); // never started: supervision off
      assert(off.status().get("entryDiagnostics").get("reason").asString() == "watchdog_supervision_disabled");
    }
    std::filesystem::remove_all(path);
  }
  {
    // A corrupt state file: start refuses recovery and the file is left
    // byte-identical (nothing here writes a file this process did not restore).
    char path[] = "/tmp/watchdog-corrupt-XXXXXX"; assert(::mkdtemp(path));
    ::setenv("WATCHDOG_ENABLED", "1", 1); ::setenv("VERIFY_JOURNAL_DIR", path, 1);
    for (const auto key : kProbeKeys) ::unsetenv(key);
    const auto file = std::string(path) + "/watchdog-state.json";
    const auto read = [&] { std::ifstream in(file); std::stringstream b; b << in.rdbuf(); return b.str(); };
    { std::ofstream out(file); out << "{corrupt"; }
    const auto before = read();
    {
      verify::Watchdog w([] { return jsn::Value(jsn::Object{}); }); w.start();
      assert(w.status().get("error").asString() == "watchdog_state_invalid_recovery_required");
      std::this_thread::sleep_for(std::chrono::milliseconds(200));
    }
    assert(read() == before);
    std::filesystem::remove_all(path);
  }
  {
    // THE OLD SHAPE ON DISK, with every input the removed channel once needed
    // (the Telegram variables set, Node's policy allowing, the soak ended and
    // unmuted, an item queued) and a local proxy standing where
    // api.telegram.org would be reached (HTTPS_PROXY): the run loop restores
    // the file, rewrites it slim — no outbox, no delivery block — unlinks the
    // stale mute marker once, and over several probe cycles nothing reaches
    // the proxy. The build before this one sent here (its own test proved the
    // harness sees a CONNECT); this one cannot.
    char path[] = "/tmp/watchdog-record-XXXXXX"; assert(::mkdtemp(path));
    const auto file = std::string(path) + "/watchdog-state.json", marker = file + ".muted";
    ::setenv("WATCHDOG_ENABLED", "1", 1); ::setenv("WATCHDOG_MASTER_ENABLED", "1", 1); ::setenv("WATCHDOG_INCIDENT_OWNER", "cpp-verify", 1);
    ::setenv("WATCHDOG_TELEGRAM_TOKEN", "fixture-token", 1); ::setenv("WATCHDOG_TELEGRAM_CHAT_ID", "1", 1);
    ::setenv("WATCHDOG_POLICY_JSON", R"({"probeMs":1000,"serviceGraceMs":1000})", 1);
    ::setenv("VERIFY_JOURNAL_DIR", path, 1);
    for (const auto key : {"WATCHDOG_NODE_URL", "WATCHDOG_EXEC_URL", "WATCHDOG_ACCT_URL", "WATCHDOG_TICK_URL", "WATCHDOG_TIMEFRAME_URL",
                           "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"}) ::unsetenv(key);
    Server proxy("{}", 0, 403);
    const auto via = "http://127.0.0.1:" + std::to_string(proxy.port);
    ::setenv("HTTPS_PROXY", via.c_str(), 1); ::setenv("https_proxy", via.c_str(), 1);
    { std::ofstream out(file); out << oldShapeFile(wallMs()); }
    { std::ofstream out(marker); out << ""; }
    assert(std::filesystem::exists(marker));
    const auto read = [&] { std::ifstream in(file); std::stringstream b; b << in.rdbuf(); return b.str(); };
    assert(read().find("\"outbox\"") != std::string::npos && read().find("\"delivery\"") != std::string::npos);
    std::set<double> cycles; jsn::Value last;
    {
      verify::Watchdog w([] { return jsn::Value(jsn::Object{}); }); w.start();
      assert(!std::filesystem::exists(marker)); // unlinked once at start
      const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(8);
      while (std::chrono::steady_clock::now() < until && cycles.size() < 4) {
        const auto st = w.status();
        if (st.get("error").asString() != "watchdog_status_busy") {
          assert(st.get("error").asString().empty() && st.get("enabled").asBool());
          cycles.insert(st.get("services").get("node").get("attemptedAtMs").asNumber());
          last = st;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
      }
    } // the run loop stops here
    ::shutdown(proxy.fd, SHUT_RDWR); proxy.worker.join();
    assert(cycles.size() >= 4); // three probe cycles past the restore
    assert(proxy.request.empty()); // nothing left the process: no CONNECT, no request of any kind
    assert(last.get("delivery").get("channel").asString() == "none" && last.get("outbox").isNull());
    assert(last.get("incidents").get("fixture:gate").get("active").asBool()); // the record survived the restore
    const auto slim = read();
    assert(slim.find("\"outbox\"") == std::string::npos && slim.find("\"delivery\"") == std::string::npos); // the backlog is gone from the volume
    assert(slim.find("\"wouldSend\"") == std::string::npos && slim.find("telegram") == std::string::npos);
    assert(slim.find("\"fixture:gate\"") != std::string::npos);
    for (const auto key : {"HTTPS_PROXY", "https_proxy", "WATCHDOG_TELEGRAM_TOKEN", "WATCHDOG_TELEGRAM_CHAT_ID", "WATCHDOG_POLICY_JSON", "WATCHDOG_INCIDENT_OWNER", "WATCHDOG_MASTER_ENABLED"}) ::unsetenv(key);
    std::filesystem::remove_all(path);
  }
  std::cout << "bounded HTTP probes and the durable incident record passed\n";
}
