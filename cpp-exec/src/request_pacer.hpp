// cpp-exec/src/request_pacer.hpp — P2b-1 (register TM-25): request pacing
// against the broker's documented limit, with a reserved share for
// PROTECTION (amends, closes, cancels) that entries and reads may never
// draw down into.
//
// cTrader Open API, "Rate limiting" (help.ctrader.com/open-api, Getting
// started; read 11-09-2026): "a maximum of 50 requests per second per
// connection for any non-historical data requests" and "5 requests per
// second per connection for any historical data requests". This sidecar
// holds ONE connection, so the budget is per process. The default capacity
// sits below 50 for headroom (the heartbeat, clock skew) — configured, and
// reported in /health so the value in force is never a guess.
#pragma once

#include <cstdint>
#include <mutex>

enum class RequestClass { Protection, Entry, Read };

struct PacerConfig {
  int capacityPerSec = 40;        // < the documented 50/s
  int protectionReservePct = 25;  // share of the bucket only Protection may use
};

class RequestPacer {
public:
  explicit RequestPacer(PacerConfig cfg = {});

  // Take one token for `cls` at `nowMs`. Entry and Read are refused when
  // taking one would leave fewer tokens than the protection reserve;
  // Protection is refused only when the bucket is empty. Never blocks.
  bool tryAcquire(RequestClass cls, long long nowMs);
  // Milliseconds until `cls` could acquire (0 = now).
  long long waitMsFor(RequestClass cls, long long nowMs) const;

  struct Counters {
    uint64_t granted = 0;
    uint64_t refusedEntry = 0;
    uint64_t refusedRead = 0;
    uint64_t refusedProtection = 0;
    double tokens = 0;
  };
  Counters counters() const;
  const PacerConfig& config() const { return cfg_; }

private:
  double refilled(long long nowMs) const; // tokens after refill to nowMs (no mutation)
  double floorFor(RequestClass cls) const;

  PacerConfig cfg_;
  mutable std::mutex mtx_;
  double tokens_;
  long long lastMs_ = 0;
  Counters c_;
};
