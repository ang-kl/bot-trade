#pragma once
#include "json.hpp"
#include <string>
namespace verify {
struct WatchHttpResult { bool received = false; long status = 0; jsn::Value body; };
// Explicit HTTP(S) targets only. No redirects; verified TLS; bounded bytes/time.
WatchHttpResult watchHttp(const std::string& url, const std::string& bearer,
                          const std::string& post = "", long deadlineMs = 2000);
}
