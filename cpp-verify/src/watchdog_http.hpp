#pragma once
#include "json.hpp"
#include <string>
namespace verify {
struct WatchHttpResult { bool received = false; long status = 0; jsn::Value body; };
// Explicit HTTP(S) GET targets only — the five service probes. No redirects;
// verified TLS; bounded bytes/time. The POST body this once took carried the
// Telegram sendMessage call; that channel was removed 03-10-2026 and nothing
// in cpp-verify posts anywhere.
WatchHttpResult watchHttp(const std::string& url, const std::string& bearer, long deadlineMs = 2000);
}
