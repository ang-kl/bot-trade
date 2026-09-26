// cpp-exec/src/health_view.hpp — GW-1 (checker B1b): the parts of GET
// /health that carry broker identifiers, built in one testable place.
//
// /health answers UNAUTHENTICATED (Railway's healthcheck probes bare;
// http_server.cpp exempts it), and main.cpp's own rule (M2, audit #12) is
// that ctidTraderAccountIds and symbol ids ride only on the trusted branch —
// a caller with the bearer, or a sidecar with no EXEC_SECRET at all. Two
// blocks broke that rule and are built here instead of inline in main.cpp:
//
//   - guard.entryEpochs, keyed by ctidTraderAccountId (P2a, since #881): the
//     keeper pushes an epoch for EVERY registry account (exec-guard-sync.js),
//     so the open /health listed the whole roster;
//   - tick.shadowSim.costs.symbolClass, keyed by symbol id (PR-L): what is
//     traded, the same fact the `subscribed` list is gated for.
//
// The open route keeps the counts (entryEpochCount, symbolClassCount); Node
// reads /health with the bearer (exec-engine.js pingSidecar), so its guard
// sync and cost-schedule comparison see the full objects unchanged.
#pragma once
#include "json.hpp"
#include "order_guard.hpp"

namespace health_view {

// The /health `guard` object. Open: halt, requireBracket, requireTarget,
// maxOrderVolume, haltAccountCount, entryEpochCount. Trusted adds
// haltAccounts (the list) and entryEpochs ({accountId: epoch}).
jsn::Value guard(const GuardSnapshot& g, bool trusted);

// The /health `tick.shadowSim` object from ShadowSim::json(). Trusted: as
// given. Open: every field except costs.symbolClass, which becomes
// costs.symbolClassCount.
jsn::Value shadowSim(const jsn::Value& sim, bool trusted);

} // namespace health_view
