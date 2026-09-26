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
#include <tuple>
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
// V3 CV-2 fix round: a state file with Node's last policy allowing delivery
// (owner cpp-verify, enabled, current, no quiet interval) and ONE urgent item
// queued `ageMs` ago, never attempted — everything a send needs but the gate.
std::string seededState(long long now, const jsn::Value& delivery, long long ageMs = 5000) {
  const jsn::Value policy(jsn::Object{{"enabled", true}, {"owner", "cpp-verify"}, {"observedAtMs", now - 5000},
    {"expiresAtMs", now + 3600000}, {"urgentBypass", true}, {"quietIntervals", jsn::Array{}}});
  const jsn::Value contract(jsn::Object{{"schemaVersion", 1}, {"service", "node"}, {"observedAtMs", now - 5000},
    {"workComplete", true}, {"work", jsn::Array{}}, {"notificationPolicy", policy}});
  const jsn::Value node(jsn::Object{{"firstObservedAtMs", now - 5000}, {"attemptedAtMs", now - 5000}, {"reachable", true},
    {"lastReachableAtMs", now - 5000}, {"validContract", true}, {"lastContractAtMs", now - 5000}, {"contract", contract}});
  const jsn::Value item(jsn::Object{{"id", "fixture:gate:1"}, {"incidentId", "fixture:gate"}, {"transition", "opened"},
    {"severity", "urgent"}, {"detail", jsn::Object{{"service", "fixture"}, {"reason", "delivery_gate_test"}}},
    {"createdAtMs", now - ageMs}, {"nextAtMs", now - ageMs}, {"attempts", 0}, {"accepted", false}});
  jsn::Value s(jsn::Object{{"schemaVersion", 1}, {"services", jsn::Object{{"node", node}}},
    {"incidents", jsn::Object{{"fixture:gate", jsn::Object{{"active", true}, {"serial", 1}, {"severity", "urgent"},
      {"openedAtMs", now - ageMs}, {"lastQueuedAtMs", now - ageMs}}}}},
    {"outbox", jsn::Object{{"fixture:gate:1", item}}}, {"dropped", 0}});
  if (!delivery.isNull()) s.set("delivery", delivery);
  return jsn::dump(s);
}
jsn::Value soakEnded(long long now, bool muted) {
  return jsn::Value(jsn::Object{{"muted", muted}, {"soakStartedAtMs", now - 2 * 86400000LL}, {"soakEndsAtMs", now - 86400000LL}});
}
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
    {
      verify::Watchdog restored([] { return jsn::Value(jsn::Object{}); }); restored.start();
      const auto st = restored.status(); assert(st.get("enabled").asBool());
      // V3 CV-1: the relay rides /watchdog-status itself. With no Node
      // contract yet it says so — labelled, unavailable, never an empty
      // clean list.
      const auto& relay = st.get("entryDiagnostics");
      assert(relay.get("evidence").asString() == "node_records_relayed" && relay.get("brokerVerified").isBool() && !relay.get("brokerVerified").asBool());
      assert(!relay.get("available").asBool() && relay.get("reason").asString() == "no_node_contract_since_start" && relay.get("accounts").isArray());
    }
    {
      verify::Watchdog off([] { return jsn::Value(jsn::Object{}); }); // never started: supervision off
      assert(off.status().get("entryDiagnostics").get("reason").asString() == "watchdog_supervision_disabled");
    }
    std::filesystem::remove_all(path);
  }
  {
    // V3 CV-2 fix round: POST /watchdog/mute never writes a state file this
    // process does not own. (a) a corrupt file (start refused recovery) and
    // (b) the lock held by another owner: a mute leaves the file byte-
    // identical and the start error unchanged, and answers durable:false.
    char path[] = "/tmp/watchdog-mute-owner-XXXXXX"; assert(::mkdtemp(path));
    ::setenv("WATCHDOG_ENABLED", "1", 1); ::setenv("WATCHDOG_MASTER_ENABLED", "0", 1);
    ::setenv("VERIFY_JOURNAL_DIR", path, 1);
    for (const auto key : {"WATCHDOG_NODE_URL", "WATCHDOG_EXEC_URL", "WATCHDOG_ACCT_URL", "WATCHDOG_TICK_URL", "WATCHDOG_TIMEFRAME_URL", "WATCHDOG_POLICY_JSON"}) ::unsetenv(key);
    const auto file = std::string(path) + "/watchdog-state.json";
    const auto read = [&] { std::ifstream in(file); std::stringstream b; b << in.rdbuf(); return b.str(); };
    const auto check = [&](const std::string& expectedError) {
      const auto before = read();
      verify::Watchdog w([] { return jsn::Value(jsn::Object{}); }); w.start();
      assert(w.status().get("error").asString() == expectedError);
      for (const bool muted : {true, false}) {
        const auto r = w.setMuted(muted);
        assert(!r.get("ok").asBool() && !r.get("durable").asBool() && r.get("error").asString() == "watchdog_not_started");
      }
      assert(read() == before); // byte-identical
      assert(w.status().get("error").asString() == expectedError); // error unchanged
    };
    { std::ofstream out(file); out << "{corrupt"; }
    check("watchdog_state_invalid_recovery_required");
    { std::ofstream out(file); out << R"({"owner":"another process"})"; }
    const int held = ::open((file + ".lock").c_str(), O_WRONLY | O_CREAT, 0600);
    assert(held >= 0 && ::flock(held, LOCK_EX | LOCK_NB) == 0);
    check("watchdog_state_already_owned_or_lock_unavailable");
    ::close(held);
    std::filesystem::remove(file);
    {
      // The owner, once started, does persist: mute applies durably, and an
      // unmute during the soak is refused.
      verify::Watchdog owner([] { return jsn::Value(jsn::Object{}); }); owner.start();
      const auto m = owner.setMuted(true); assert(m.get("ok").asBool() && m.get("durable").asBool());
      const auto u = owner.setMuted(false); assert(!u.get("ok").asBool() && u.get("error").asString() == "soak_active");
      assert(read().find("\"soakStartedAtMs\"") != std::string::npos);
    }
    std::filesystem::remove_all(path);
  }
  {
    // CV-2 fix round nit 4: the send path, BEHAVIOURALLY — the run loop itself
    // with every other gate open (deployment switch, incident owner,
    // credentials, Node's policy) and one urgent item queued. Telegram is
    // reached through a local proxy (HTTPS_PROXY), so a send is seen as a
    // CONNECT to api.telegram.org and nothing leaves the machine. The open
    // control proves the harness can see a send; the muted verifier then
    // sends nothing over several probe cycles. (Mutating the run loop's
    // state_.releasable(now) to state_.nextDelivery(now) turns this red; the
    // source pin in verify-watchdog-soak.test.js could not reach C++.)
    char path[] = "/tmp/watchdog-gate-XXXXXX"; assert(::mkdtemp(path));
    const auto file = std::string(path) + "/watchdog-state.json";
    ::setenv("WATCHDOG_ENABLED", "1", 1); ::setenv("WATCHDOG_MASTER_ENABLED", "1", 1); ::setenv("WATCHDOG_INCIDENT_OWNER", "cpp-verify", 1);
    ::setenv("WATCHDOG_TELEGRAM_TOKEN", "fixture-token", 1); ::setenv("WATCHDOG_TELEGRAM_CHAT_ID", "1", 1);
    ::setenv("WATCHDOG_POLICY_JSON", R"({"probeMs":1000,"serviceGraceMs":1000})", 1);
    ::setenv("VERIFY_JOURNAL_DIR", path, 1);
    for (const auto key : {"WATCHDOG_NODE_URL", "WATCHDOG_EXEC_URL", "WATCHDOG_ACCT_URL", "WATCHDOG_TICK_URL", "WATCHDOG_TIMEFRAME_URL",
                           "NO_PROXY", "no_proxy", "ALL_PROXY", "all_proxy"}) ::unsetenv(key);
    // Returns {attempts on the queued item, whether the proxy saw a CONNECT to Telegram, probe cycles seen}.
    const auto run = [&](const jsn::Value& delivery, bool expectSend) {
      Server proxy("{}", 0, 403);
      const auto via = "http://127.0.0.1:" + std::to_string(proxy.port);
      ::setenv("HTTPS_PROXY", via.c_str(), 1); ::setenv("https_proxy", via.c_str(), 1);
      { std::ofstream out(file); out << seededState(wallMs(), delivery); }
      double attempts = 0; std::set<double> cycles;
      {
        verify::Watchdog w([] { return jsn::Value(jsn::Object{}); }); w.start();
        const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(expectSend ? 10 : 6);
        while (std::chrono::steady_clock::now() < until) {
          const auto st = w.status();
          if (st.get("error").asString() != "watchdog_status_busy") {
            assert(st.get("error").asString().empty() && st.get("enabled").asBool());
            cycles.insert(st.get("services").get("node").get("attemptedAtMs").asNumber());
            attempts = 0;
            for (const auto& [id, item] : st.get("outbox").asObject()) attempts += item.get("attempts").asNumber();
            if (attempts > 0 || (!expectSend && cycles.size() >= 4)) break; // four readings: three cycles past the seed
          }
          std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
      } // the run loop stops here
      ::shutdown(proxy.fd, SHUT_RDWR); proxy.worker.join();
      return std::tuple{attempts, proxy.request.find("CONNECT api.telegram.org:443") != std::string::npos, cycles.size()};
    };
    const auto now = wallMs();
    const auto [openAttempts, openConnect, openCycles] = run(soakEnded(now, false), true);
    assert(openAttempts >= 1 && openConnect); // the harness sees a send
    const auto [mutedAttempts, mutedConnect, mutedCycles] = run(soakEnded(now, true), false);
    assert(mutedAttempts == 0 && !mutedConnect); // the mute alone held it ...
    assert(mutedCycles >= 4);                     // ... through three probe cycles with every other gate open
    const auto [soakAttempts, soakConnect, soakCycles] = run(jsn::Value(), false); // pre-CV-2 file: muted, soak begins at boot
    assert(soakAttempts == 0 && !soakConnect && soakCycles >= 4);
    (void)openCycles;
    for (const auto key : {"HTTPS_PROXY", "https_proxy", "WATCHDOG_TELEGRAM_TOKEN", "WATCHDOG_TELEGRAM_CHAT_ID", "WATCHDOG_POLICY_JSON", "WATCHDOG_INCIDENT_OWNER"}) ::unsetenv(key);
    ::setenv("WATCHDOG_MASTER_ENABLED", "0", 1);
    std::filesystem::remove_all(path);
  }
  {
    // CV-2 fix round nits 2 and 8 at the route's own call: an unmute over a
    // stale backlog is refused with nothing disposed of; a change that cannot
    // be persisted answers ok:false state_not_durable (503 at the route). A
    // mute stays applied in the process; an unmute is undone.
    char path[] = "/tmp/watchdog-durable-XXXXXX"; assert(::mkdtemp(path));
    const auto file = std::string(path) + "/watchdog-state.json";
    ::setenv("WATCHDOG_ENABLED", "1", 1); ::setenv("VERIFY_JOURNAL_DIR", path, 1);
    const auto read = [&] { std::ifstream in(file); std::stringstream b; b << in.rdbuf(); return b.str(); };
    {
      const auto now = wallMs();
      { std::ofstream out(file); out << seededState(now, soakEnded(now, true), 2 * 3600000LL); } // one item 2 h old
      verify::Watchdog w([] { return jsn::Value(jsn::Object{}); }); w.start();
      const auto r = w.setMuted(false);
      assert(!r.get("ok").asBool() && !r.get("applied").asBool() && r.get("error").asString() == "stale_backlog");
      assert(r.get("delivery").get("muted").asBool() && r.get("delivery").get("staleBacklog").get("count").asNumber() == 1);
      assert(r.get("delivery").get("unmuteRefusal").asString() == "stale_backlog");
      jsn::Value st; // status() answers busy while the run loop holds the lock
      for (int i = 0; i < 200 && (st = w.status()).get("error").asString() == "watchdog_status_busy"; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(25));
      assert(st.get("outbox").get("fixture:gate:1").isObject()); // nothing disposed of
    }
    {
      const auto now = wallMs();
      { std::ofstream out(file); out << seededState(now, soakEnded(now, true)); } // the item is 5 s old: not stale
      const auto before = read();
      // persist() cannot open its temp file while a directory stands there.
      // Blocked BEFORE start, so no write of the run loop's can race it.
      const auto blocked = file + ".tmp";
      const auto block = [&] { std::error_code ec; for (int i = 0; i < 500 && !std::filesystem::create_directory(blocked, ec); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10)); assert(std::filesystem::is_directory(blocked)); };
      block();
      verify::Watchdog w([] { return jsn::Value(jsn::Object{}); }); w.start();
      const auto u = w.setMuted(false);
      assert(!u.get("ok").asBool() && !u.get("applied").asBool() && !u.get("durable").asBool() && u.get("error").asString() == "state_not_durable");
      assert(u.get("delivery").get("muted").asBool() && !u.get("delivery").get("open").asBool()); // undone
      assert(read() == before);
      std::filesystem::remove(blocked);
      // (Read from the replies: status() answers busy while the run loop holds the lock.)
      const auto opened = w.setMuted(false);
      assert(opened.get("ok").asBool() && opened.get("durable").asBool() && opened.get("delivery").get("open").asBool());
      block();
      const auto m = w.setMuted(true);
      assert(!m.get("ok").asBool() && m.get("applied").asBool() && !m.get("durable").asBool() && m.get("error").asString() == "state_not_durable");
      assert(m.get("delivery").get("muted").asBool() && !m.get("delivery").get("open").asBool()); // applied in this process
      assert(read().find("\"muted\":false") != std::string::npos); // ... and not on disk: a restart would reopen it
      std::filesystem::remove(blocked);
      const auto ok = w.setMuted(true);
      assert(ok.get("ok").asBool() && ok.get("durable").asBool() && read().find("\"muted\":true") != std::string::npos);
    }
    std::filesystem::remove_all(path);
  }
  std::cout << "bounded HTTP and durable exclusive watchdog state passed\n";
}
