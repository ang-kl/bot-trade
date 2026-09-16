// cpp-exec/src/tick_segment_routes.hpp — PR-I: the two sealed-segment READ
// routes, registered from ONE place.
//
// WHY THIS FILE EXISTS (checker M-3). The routes first lived as lambdas
// inside main.cpp. The Makefile excludes main.cpp from every test binary, so
// nothing in the C++ suite could reach them: the wire contract existed twice
// — once in main.cpp and once in the Node puller's fake sidecar — and the
// two copies were never joined. The proof was a mutation that shipped
// green: `req.query.clear()` in http_server.cpp killed the entire read path
// while all seven cases of test_tick_segments still passed (recurring
// failure modes #4, "a repair that nothing calls", and #3, "a guard whose
// trigger is out of reach of what it guards").
//
// So the registration is a function, main.cpp calls it, and
// test_tick_segments drives it through a REAL HttpServer on a real socket —
// the same code path the sidecar serves, including readRequest's query
// parsing, the bearer gate and the JSON field names the Node puller reads
// (`b64`, `len`, `eof`, `totalBytes`, `name`, `offset`).
#pragma once

#include <string>

#include "http_server.hpp"

/**
 * Registers `GET /tick-segments` (the sealed listing) and `GET
 * /tick-segment?name=&offset=&len=` (one bounded range, base64 in JSON).
 *
 * `spoolDir` is TICK_SPOOL_PATH. `recorderPresent` is whether this process
 * built a recorder at all — false answers `{"enabled":false,...}` with 200,
 * the same shape /tick-status uses, so the keeper can tell "no recorder"
 * from "did not answer".
 *
 * `execSecret` is EXEC_SECRET. These routes are bearer-REQUIRED, not merely
 * gated detail: segment bytes are market data. They refuse 401 when the
 * header does not match AND when no secret is configured at all — the
 * HttpServer's own gate would otherwise admit a literal "Bearer " on an
 * unauthenticated deployment.
 */
void registerTickSegmentRoutes(HttpServer& server, const std::string& spoolDir,
                               bool recorderPresent, const std::string& execSecret);
