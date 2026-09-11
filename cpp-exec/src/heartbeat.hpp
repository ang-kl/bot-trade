// cpp-exec/src/heartbeat.hpp — the one idle-heartbeat bound both sockets use.
//
// cTrader's connection guidance asks for a heartbeat every 10 seconds. Both
// the execution engine and the spot feed sent one after 25 seconds of idle
// (10-09-2026 investigation, finding 5) — a guidance mismatch, not a proven
// cause of any disconnect, but the cheapest possible thing to have right.
// The receive slices that drive the check are 1 s on BOTH sockets (the
// execution reader since P2b-2; the spot feed since the 11-09-2026 audit,
// which measured its 5 s slice as an effective 9–14 s bound — above the
// guidance the constant below claims to honour), so a heartbeat lands
// within a second past the bound.
#pragma once

constexpr int kHeartbeatIdleSeconds = 9;
constexpr int kHeartbeatSliceMs = 1000;
static_assert(kHeartbeatIdleSeconds <= 10, "cTrader asks for a heartbeat every 10 seconds");
static_assert(kHeartbeatIdleSeconds * 1000 + kHeartbeatSliceMs <= 10000, "the bound plus one receive slice must stay within the 10 s guidance");
