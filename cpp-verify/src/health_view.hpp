// cpp-verify/src/health_view.hpp — the part of GET /health that carries broker
// account ids, built in one testable place.
//
// NOT A VENDORED COPY. cpp-exec/src/health_view.* is the gateways' view of
// their own /health (guard, tick.shadowSim); this one is the verifier's, and
// it is not in sidecar-pins.test.js's byte-identity list.
//
// GET /health answers UNAUTHENTICATED (http_server.cpp exempts it; Railway
// probes bare) and the repository is public, so anything it prints is
// published. Until this view it printed `sessions[].accounts` — every
// ctidTraderAccountId the verifier's history sessions were authorized on.
// Account ids go only to a caller holding the bearer; everyone else gets the
// count, which is what monitoring needs to see a session that lost accounts.
#pragma once

#include <string>
#include <vector>

#include "json.hpp"

namespace health_view {

// One history session as main.cpp's maps hold it (g_sessions / g_accounts).
struct SessionRow {
  std::string host;                 // broker host, e.g. demo.ctraderapi.com
  bool open = false;
  std::vector<long long> accounts;  // authorized ctidTraderAccountIds
};

// The /health `sessions` array. AN ALLOWLIST: each row is built fresh from
// named fields — host, open, accountCount — and the account id list rides
// only when `trusted` (the caller sent `Bearer <EXEC_SECRET>`). A field added
// to SessionRow later stays off the open route until someone names it here.
jsn::Value sessions(const std::vector<SessionRow>& rows, bool trusted);

} // namespace health_view
