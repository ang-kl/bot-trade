#include "watchdog.hpp"
#include "entry_diagnostics.hpp"
#include "watchdog_http.hpp"
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <ctime>
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
std::string stamp(long long now) {
  time_t seconds = now / 1000 + 8 * 3600; std::tm tm{}; gmtime_r(&seconds, &tm);
  char out[40]; std::strftime(out, sizeof out, "%Y-%m-%d %H:%M:%S SGT", &tm); return out;
}
std::string suffix(const std::string& id) { return id.empty() ? "unknown" : "…" + id.substr(id.size() > 4 ? id.size() - 4 : 0); }
}
std::string watchNotificationText(const jsn::Value& item, long long now) {
  const auto& d = item.get("detail");
  std::string out = "bot-trade " + item.get("severity").asString() + " / " + item.get("transition").asString()
    + "\nService: " + d.get("service").asString() + " · account " + suffix(d.get("accountId").asString())
    + "\nInstrument: " + d.get("symbolId").asString() + " · session " + d.get("sessionId").asString()
    + "\nExpected work: " + d.get("role").asString() + " · " + d.get("reason").asString()
    + "\nLast completion: " + jsn::dump(d.get("lastCompletedAtMs")) + " · next due: " + jsn::dump(d.get("nextDueMs"))
    + "\nMarket: " + d.get("marketStatus").asString() + " · blocker: " + d.get("blocker").asString()
    + "\nBroker missing SL/TP: " + jsn::dump(d.get("missingSl")) + "/" + jsn::dump(d.get("missingTp"))
    + "\n" + stamp(now);
  // No raw payload, full account ID, URL, credential or exception is forwarded.
  if (out.size() > 3000) out.resize(3000);
  return out;
}
bool watchAllowsNotification(const jsn::Value& snapshot, const jsn::Value& delivery, long long now) {
  const auto& p = snapshot.get("services").get("node").get("contract").get("notificationPolicy");
  const auto observed = p.get("observedAtMs").asNumber(), expiry = p.get("expiresAtMs").asNumber();
  if (!p.get("enabled").asBool() || p.get("owner").asString() != "cpp-verify" || observed <= 0
      || observed > now || now - observed >= 86400000 || expiry <= now || !p.get("quietIntervals").isArray()) return false;
  for (const auto& iv : p.get("quietIntervals").asArray()) {
    const auto from = iv.get("fromMs").asNumber(), to = iv.get("toMs").asNumber();
    if (from <= 0 || to <= from) return false;
    if (from <= now && now < to && !(delivery.get("severity").asString() == "urgent" && p.get("urgentBypass").asBool())) return false;
  }
  return true;
}
Watchdog::Watchdog(std::function<jsn::Value()> protection) : protection_(std::move(protection)) {}
Watchdog::~Watchdog() { if (worker_.joinable()) { worker_.request_stop(); worker_.join(); } if (lockFd_ >= 0) ::close(lockFd_); }
void Watchdog::start() {
  enabled_ = env("WATCHDOG_ENABLED") == "1";
  master_ = env("WATCHDOG_MASTER_ENABLED") == "1";
  owner_ = env("WATCHDOG_INCIDENT_OWNER") == "cpp-verify";
  if (!enabled_) return;
  if (!env("WATCHDOG_POLICY_JSON").empty()) {
    const auto config = jsn::parse(env("WATCHDOG_POLICY_JSON"));
    WatchPolicy policy;
    bool valid = config && config->isObject();
    if (valid) {
      std::map<std::string, long long*> fields{{"probeMs", &policy.probeMs}, {"serviceGraceMs", &policy.serviceGraceMs},
        {"managementGraceMs", &policy.managementGraceMs}, {"scannerGraceMs", &policy.scannerGraceMs}, {"noOrdersMs", &policy.noOrdersMs}, {"repeatMs", &policy.repeatMs}};
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
  const auto parent = path_.substr(0, path_.find_last_of('/'));
  const int dir = ::open(parent.c_str(), O_RDONLY | O_DIRECTORY);
  const bool durable = dir >= 0 && ::fsync(dir) == 0;
  if (dir >= 0) ::close(dir);
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
    jsn::Value delivery;
    {
      std::lock_guard lock(mutex_);
      const auto now = nowMs(); state_.protection(protection_(), now); state_.evaluate(now);
      if (persist() && master_ && owner_) {
        auto next = state_.nextDelivery(now);
        if (!next.isNull() && watchAllowsNotification(state_.snapshot(), next, now)) delivery = next;
      }
    }
    // Delivery is outside every state/protection lock. A blocked/failed
    // Telegram call cannot stop the independent ProtectionWatch thread.
    const auto token = env("WATCHDOG_TELEGRAM_TOKEN"), chat = env("WATCHDOG_TELEGRAM_CHAT_ID");
    if (!delivery.isNull() && !token.empty() && !chat.empty()) {
      const auto body = jsn::dump(jsn::Value(jsn::Object{{"chat_id", chat}, {"text", watchNotificationText(delivery, nowMs())}}));
      const auto r = watchHttp("https://api.telegram.org/bot" + token + "/sendMessage", "", body, 5000);
      const bool accepted = r.received && r.body.get("ok").asBool() && r.body.get("result").get("message_id").isNumber();
      const auto message = accepted ? jsn::dump(r.body.get("result").get("message_id")) : "";
      const auto retry = std::clamp(r.body.get("parameters").get("retry_after").asNumber(), 0.0, 86400.0);
      std::lock_guard lock(mutex_);
      state_.delivery(delivery.get("id").asString(), accepted, message, static_cast<long long>(retry * 1000), nowMs()); persist();
    }
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
  const auto snapshot = state_.snapshot();
  const auto& policy = snapshot.get("services").get("node").get("contract").get("notificationPolicy");
  const double observed = policy.get("observedAtMs").asNumber();
  const bool current = observed > 0 && observed <= nowMs() && nowMs() - observed < 86400000;
  s.set("masterEnabled", current ? policy.get("enabled") : jsn::Value());
  s.set("deploymentDeliveryEnabled", master_); s.set("incidentOwnerConfigured", owner_);
  s.set("deliveryCredentialsConfigured", !env("WATCHDOG_TELEGRAM_TOKEN").empty() && !env("WATCHDOG_TELEGRAM_CHAT_ID").empty());
  s.set("effectivePolicyAllowsUrgent", master_ && owner_ && writable_ && watchAllowsNotification(state_.snapshot(), jsn::Value(jsn::Object{{"severity", "urgent"}}), nowMs()));
  s.set("externalObserver", "unconfigured; requires independent provisioning and delivery evidence");
  return s;
}
}
