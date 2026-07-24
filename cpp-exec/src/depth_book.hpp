// cpp-exec/src/depth_book.hpp
//
// DepthBook — per-symbol L2 order-book state built from ProtoOADepthEvent
// (payloadType 2155) frames. Payload-type numbers and field semantics are
// verified against spotware/openapi-proto-messages (OpenApiModelMessages
// .proto): a ProtoOADepthQuote carries {id, size, bid?, ask?} where exactly
// one of bid/ask is present and names the side; `size` is in cents
// (volume x 100, the protocol's usual volume unit); prices use the same
// x100000 wire scaling as spot events (mirrors agent/lib/ctrader-ws.js's
// kPointsPerPrice, this protocol's source of truth in this repo).
// deletedQuotes lists quote ids to remove.
//
// Pure state machine, no I/O and no locking — the owner (SpotFeed) guards
// it with its own mutex. Kept separate from spot_feed.cpp so the update /
// snapshot logic is unit-testable without a WebSocket.
#pragma once

#include <cstdint>
#include <map>
#include <string>

#include "json.hpp"

class DepthBook {
public:
  // Applies one ProtoOADepthEvent payload (the "payload" object, not the
  // whole frame). `nowMs` is stamped as the book's last-update time —
  // passed in rather than read from a clock so tests are deterministic.
  void applyEvent(const jsn::Value& payload, long long nowMs);

  // {"at":…,"bids":[{"price":…,"sizeCents":…},…],"asks":[…]} — bids sorted
  // best (highest) first, asks best (lowest) first, each side capped at
  // maxLevels. sizeCents is the raw wire size (volume cents): converting to
  // lots needs the symbol's lotSize, which lives Node-side — this binary
  // reports what the broker sent rather than guessing a conversion.
  std::string snapshotJson(int maxLevels) const;

  bool empty() const { return byId_.empty(); }
  long long lastAtMs() const { return lastAtMs_; }
  void clear() { byId_.clear(); lastAtMs_ = 0; }

private:
  struct Entry {
    bool isBid = false;
    double price = 0;      // descaled (wire / 100000)
    double sizeCents = 0;  // raw wire size
  };
  std::map<std::uint64_t, Entry> byId_;
  long long lastAtMs_ = 0;
};
