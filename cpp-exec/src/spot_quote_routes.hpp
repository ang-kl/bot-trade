// cpp-exec/src/spot_quote_routes.hpp — GET /quotes: the spot feed's latest
// bid/ask per symbol, served to the keeper's fast monitor (19-09-2026).
//
// WHY. The fast monitor re-priced every due open position with its own
// broker round trip (wsGetSpotOnce, serially, 48 positions on 19-09) while
// this process already held a live spot subscription for the same symbols.
// Measured before this route: a tick with nothing due took 2 ms, the worst
// tick in ten minutes 51 s, and the share of 3 s ticks skipped because the
// previous pass was still running sat at 0.45–0.75 against the goal
// table's ≤ 10 %. One pull per side per tick replaces N round trips.
//
// Like tick_segment_routes, the registration is a FUNCTION so a test can
// drive it through a real HttpServer on a real socket: main.cpp is excluded
// from every test binary, and a route defined there is out of reach of the
// suite (checker M-3 on PR-I).
#pragma once

#include <functional>
#include <string>
#include <vector>

#include "http_server.hpp"
#include "spot_feed.hpp"

/** What the route reads from the process: the feed's presence and state
 *  plus a copy of its latest-quote table. `present` false = no SpotFeed
 *  object exists (the live sidecar without a recorder, a trail or a VPO
 *  strategy), reported as feed:"absent" so the keeper falls back to the
 *  broker rather than reading an empty table as a market with no quotes. */
struct QuoteFeedView {
  bool present = false;
  bool connected = false;
  long long generation = 0; // 1 on the first connection, +1 per reconnect
  std::vector<SpotQuote> quotes;
};
using QuoteFeedReader = std::function<QuoteFeedView()>;

/**
 * Registers `GET /quotes[?ids=1,2,3]`. Response:
 *   { feed: "up"|"down"|"absent", generation, nowMs, count,
 *     quotes: [{ symbolId, bid, ask, tsMs, recvMs }] }
 * A side never seen is null, never 0 (a Buy's `ask <= trigger` against 0
 * is a false touch — the same rule the feed's own tick callback keeps).
 * `ids` filters to those symbol ids; absent or empty = every symbol.
 * `nowMs` is this process's clock at answer time, so a caller ages a quote
 * as nowMs - recvMs on one clock (its own clock may differ by seconds).
 *
 * Bearer-REQUIRED like the segment routes: quotes are market data, so the
 * route refuses 401 both when the header does not match and when no
 * EXEC_SECRET is configured at all. Logs nothing per request — the keeper
 * asks every 3 s.
 */
void registerSpotQuoteRoutes(HttpServer& server, QuoteFeedReader reader, const std::string& execSecret);
