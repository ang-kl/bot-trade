#include "watchdog.hpp"
#include "entry_diagnostics.hpp"
#include "log.hpp"
#include "watchdog_http.hpp"
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <future>
#include <sys/stat.h>
#include <sys/file.h>
#include <unistd.h>

namespace verify {
namespace {
std::string env(const char* name) { const auto p = std::getenv(name); return p ? p : ""; }
long long nowMs() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
bool syncDirectoryOf(const std::string& file) {
  const int dir = ::open(file.substr(0, file.find_last_of('/')).c_str(), O_RDONLY | O_DIRECTORY);
  const bool synced = dir >= 0 && ::fsync(dir) == 0;
  if (dir >= 0) ::close(dir);
  return synced;
}
}
Watchdog::Watchdog(std::function<jsn::Value()> protection) : protection_(std::move(protection)) {}
Watchdog::~Watchdog() { if (worker_.joinable()) { worker_.request_stop(); worker_.join(); } if (lockFd_ >= 0) ::close(lockFd_); }
void Watchdog::start() {
  enabled_ = env("WATCHDOG_ENABLED") == "1";
  if (!enabled_) return;
  if (!env("WATCHDOG_POLICY_JSON").empty()) {
    const auto config = jsn::parse(env("WATCHDOG_POLICY_JSON"));
    WatchPolicy policy;
    bool valid = config && config->isObject();
    if (valid) {
      std::map<std::string, long long*> fields{{"probeMs", &policy.probeMs}, {"serviceGraceMs", &policy.serviceGraceMs},
        {"managementGraceMs", &policy.managementGraceMs}, {"scannerGraceMs", &policy.scannerGraceMs}, {"noOrdersMs", &policy.noOrdersMs}, {"repeatMs", &policy.repeatMs}, {"streamQuoteSilenceMs", &policy.streamQuoteSilenceMs}};
      for (const auto& [key, value] : config->asObject()) {
        if (key == "accountGraceMs") {
          if (!value.isObject() || value.asObject().size() > 128) { valid = false; break; }
          for (const auto& [account, roles] : value.asObject()) {
            if (account.empty() || !std::all_of(account.begin(), account.end(), [](char c) { return c >= '0' && c <= '9'; }) || !roles.isObject()) valid = false;
            for (const auto& [role, grace] : roles.asObject()) if ((role != "management" && role != "scanner")
                || !grace.isNumber() || grace.asNumber() < 0 || grace.asNumber() > 3600000 || std::floor(grace.asNumber()) != grace.asNumber()) valid = false;
          }
          policy.accountGraceMs = value;
        } else if (!fields.contains(key) || !value.isNumber() || value.asNumber() < 1000 || value.asNumber() > 86400000 || std::floor(value.asNumber()) != value.asNumber()) valid = false;
        else *fields[key] = static_cast<long long>(value.asNumber());
      }
      if (policy.probeMs > 60000 || policy.serviceGraceMs < policy.probeMs || policy.repeatMs < 60000) valid = false;
    }
    if (!valid) { error_ = "watchdog_policy_invalid"; return; }
    state_ = WatchState(policy);
  }
  const auto dir = env("VERIFY_JOURNAL_DIR");
  if (dir.empty()) { error_ = "durable_directory_unconfigured"; return; }
  path_ = dir + "/watchdog-state.json";
  lockFd_ = ::open((path_ + ".lock").c_str(), O_WRONLY | O_CREAT | O_NOFOLLOW, 0600);
  if (lockFd_ < 0 || ::flock(lockFd_, LOCK_EX | LOCK_NB) != 0) { error_ = "watchdog_state_already_owned_or_lock_unavailable"; return; }
  struct stat info{};
  if (::lstat(path_.c_str(), &info) == 0) {
    if (!S_ISREG(info.st_mode)) { error_ = "watchdog_state_not_regular"; return; }
    if (info.st_size > 4 * 1024 * 1024) { error_ = "watchdog_state_oversized"; return; }
    std::ifstream input(path_); std::string raw((std::istreambuf_iterator<char>(input)), {});
    const auto parsed = jsn::parse(raw);
    if (!parsed || !state_.restore(*parsed)) { error_ = "watchdog_state_invalid_recovery_required"; return; }
  }
  // The delivery mute's marker file, left on the volume by the build before
  // the channel was removed (03-10-2026). It gated nothing any more; it is
  // unlinked once, said once, and never read. A marker that cannot be
  // unlinked (a directory there) is left where it is: nothing reads it.
  const auto marker = path_ + ".muted";
  struct stat markerInfo{};
  if (::lstat(marker.c_str(), &markerInfo) == 0) {
    if (::unlink(marker.c_str()) == 0) { syncDirectoryOf(marker); sidecar_log::logInfoF("[verify]", "watchdog: removed the stale delivery-mute marker %s (the delivery channel was removed 03-10-2026; incidents are a record)", marker.c_str()); }
    else sidecar_log::logInfoF("[verify]", "watchdog: a stale delivery-mute marker stands at %s and could not be unlinked (%s); it is ignored", marker.c_str(), std::strerror(errno));
  }
  writable_ = persist();
  worker_ = std::jthread([this](std::stop_token stop) {
    try { run(stop); }
    catch (...) { std::lock_guard lock(mutex_); error_ = "watchdog_worker_failed; independent broker audit continues"; }
  });
}
bool Watchdog::persist() {
  const auto body = jsn::dump(state_.snapshot());
  if (path_.empty() || body.size() > 4 * 1024 * 1024) { error_ = "watchdog_state_unavailable_or_oversized"; return writable_ = false; }
  const auto temp = path_ + ".tmp";
  const int fd = ::open(temp.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
  if (fd < 0) { error_ = "watchdog_state_open_failed"; return writable_ = false; }
  size_t done = 0;
  while (done < body.size()) { const auto n = ::write(fd, body.data() + done, body.size() - done); if (n <= 0) break; done += n; }
  const bool synced = done == body.size() && ::fsync(fd) == 0;
  const bool closed = ::close(fd) == 0;
  if (!synced || !closed || ::rename(temp.c_str(), path_.c_str()) != 0) { error_ = "watchdog_state_write_failed"; return writable_ = false; }
  const bool durable = syncDirectoryOf(path_);
  error_ = durable ? "" : "watchdog_directory_sync_failed";
  return writable_ = durable;
}
void Watchdog::run(std::stop_token stop) {
  struct Target { const char* name; const char* url; const char* key; };
  const Target targets[]{{"node", "WATCHDOG_NODE_URL", "WATCHDOG_NODE_SECRET"},
    {"cpp-exec", "WATCHDOG_EXEC_URL", "WATCHDOG_EXEC_SECRET"}, {"cpp-acct", "WATCHDOG_ACCT_URL", "WATCHDOG_ACCT_SECRET"},
    {"cpp-scan-tick", "WATCHDOG_TICK_URL", "WATCHDOG_TICK_SECRET"}, {"cpp-scan-timeframe", "WATCHDOG_TIMEFRAME_URL", "WATCHDOG_TIMEFRAME_SECRET"}};
  while (!stop.stop_requested()) {
    const auto start = std::chrono::steady_clock::now();
    std::vector<std::pair<std::string, std::future<WatchHttpResult>>> requests;
    for (const auto& t : targets) {
      const auto url = env(t.url), bearer = env(t.key);
      // Gateways + Node are required when supervision is enabled. Scanners
      // become expected only when their endpoints have been configured.
      if (url.empty() && std::string(t.name).starts_with("cpp-scan")) continue;
      requests.emplace_back(t.name, std::async(std::launch::async, [url, bearer] { return watchHttp(url, bearer); }));
    }
    for (auto& [name, pending] : requests) {
      const auto response = pending.get();
      std::lock_guard lock(mutex_); state_.probe(name, response.received, response.body, nowMs());
    }
    {
      std::lock_guard lock(mutex_);
      const auto now = nowMs(); state_.protection(protection_(), now); state_.evaluate(now);
      persist();
    }
    // The cycle ends here. Nothing is sent anywhere: the record above is the
    // whole output, read on GET /watchdog-status.
    while (!stop.stop_requested() && std::chrono::steady_clock::now() - start < std::chrono::milliseconds(state_.probeIntervalMs()))
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
}
jsn::Value Watchdog::status() {
  // Read before mutex_, never under it: ProtectionWatch's own lock is the one
  // /protection-status takes, and a broker read never holds it.
  const auto protection = protection_();
  // A slow volume must not hold the process health endpoint across fsync and
  // provoke a supervisor restart of a still-working broker audit. A busy
  // reply carries no entryDiagnostics; the website reads that as unavailable.
  std::unique_lock lock(mutex_, std::try_to_lock);
  if (!lock.owns_lock()) return jsn::Value(jsn::Object{{"schemaVersion", 1}, {"enabled", enabled_},
    {"error", "watchdog_status_busy"}, {"observedAtMs", nowMs()}});
  auto s = state_.status(nowMs());
  auto relay = entryDiagnosticsView(state_.nodeEntryDiagnostics(), state_.nodeEntryDiagnosticsAtMs(), protection, nowMs(), state_.serviceGraceMs());
  if (!enabled_) relay.set("reason", "watchdog_supervision_disabled"); // nothing probes Node, so nothing can be relayed
  s.set("entryDiagnostics", relay);
  s.set("enabled", enabled_); s.set("durable", writable_); s.set("error", error_);
  s.set("stateBytes", static_cast<long long>(jsn::dump(state_.snapshot()).size()));
  s.set("stateBytesCap", 4LL * 1024 * 1024);
  return s;
}
}
