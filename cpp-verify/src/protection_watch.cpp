#include "protection_watch.hpp"
#include <chrono>

namespace verify {
namespace {
long long nowMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()).count();
}
}
void ProtectionWatch::replace(const std::string& host, std::shared_ptr<VerifySession> session,
                              const std::vector<long long>& accounts) {
  std::lock_guard lock(mutex_);
  sources_[host] = {std::move(session), accounts};
  for (auto it = results_.begin(); it != results_.end();) {
    if (it->first.starts_with(host + ":")) it = results_.erase(it);
    else ++it;
  }
}
void ProtectionWatch::pollOnce() {
  std::map<std::string, Source> sources;
  { std::lock_guard lock(mutex_); sources = sources_; }
  for (const auto& [host, source] : sources) for (const auto account : source.accounts) {
    auto result = source.session->protection(account);
    result.set("checkedAtMs", static_cast<double>(nowMs()));
    std::lock_guard lock(mutex_);
    // An old session finishing after replacement cannot publish into the new one.
    if (sources_[host].session == source.session) results_[host + ":" + std::to_string(account)] = std::move(result);
  }
}
jsn::Value ProtectionWatch::status() {
  std::lock_guard lock(mutex_);
  jsn::Value out{jsn::Object{}};
  jsn::Array rows, sessions;
  for (const auto& [key, result] : results_) rows.push_back(result);
  for (const auto& [host, source] : sources_) {
    jsn::Value row{jsn::Object{}};
    row.set("host", host);
    row.set("open", source.session->isOpen());
    jsn::Array accounts;
    for (const auto id : source.accounts) accounts.push_back(jsn::Value(std::to_string(id)));
    row.set("accounts", jsn::Value(std::move(accounts)));
    sessions.push_back(std::move(row));
  }
  out.set("accounts", jsn::Value(std::move(rows)));
  out.set("sessions", jsn::Value(std::move(sessions)));
  out.set("intervalMs", 60000);
  out.set("source", std::string("cpp-verify"));
  return out;
}
void ProtectionWatch::start() {
  worker_ = std::jthread([this](std::stop_token stop) {
    while (!stop.stop_requested()) {
      pollOnce();
      for (int i = 0; i < 60 && !stop.stop_requested(); ++i)
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }
  });
}
}
