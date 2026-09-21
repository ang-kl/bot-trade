#pragma once
#include "verify_session.hpp"
#include <memory>
#include <thread>

namespace verify {
// Separate sessions keep paged closed-deal verification off this clock.
// The clock lives here, so a blocked Node scan cannot stop broker checks.
class ProtectionWatch {
public:
  void replace(const std::string& host, std::shared_ptr<VerifySession> session,
               const std::vector<long long>& accounts);
  void pollOnce();
  jsn::Value status();
  void start();
private:
  struct Source { std::shared_ptr<VerifySession> session; std::vector<long long> accounts; };
  std::mutex mutex_;
  std::map<std::string, Source> sources_;
  std::map<std::string, jsn::Value> results_;
  std::jthread worker_;
};
}
