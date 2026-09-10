// cpp-exec/src/heartbeat.hpp — the one idle-heartbeat bound both sockets use.
//
// cTrader's connection guidance asks for a heartbeat every 10 seconds. Both
// the execution engine and the spot feed sent one after 25 seconds of idle
// (10-09-2026 investigation, finding 5) — a guidance mismatch, not a proven
// cause of any disconnect, but the cheapest possible thing to have right.
// The receive slices that drive the check are 5 s, so 9 s here means a
// heartbeat lands between 9 and 14 s of idle.
#pragma once

constexpr int kHeartbeatIdleSeconds = 9;
static_assert(kHeartbeatIdleSeconds <= 10, "cTrader asks for a heartbeat every 10 seconds");
static_assert(kHeartbeatIdleSeconds > 5, "the 5 s receive slice must fit inside the bound");
