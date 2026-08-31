// cpp-exec/src/decision_ring.hpp
//
// DecisionRing — the sidecar's decision log (owner invariant 1, 31-08-2026:
// "every decision need to log down by the program").
//
// Before this, the binary's decisions — guard refusals, order results,
// reconnects, auth-error classifications, trail amends — existed only as
// unstructured stderr lines and process-lifetime counters that a restart
// zeroed silently. Nothing could inspect them, so nothing did (the JS
// decision-audit says outright that cpp-exec has "no read path to these
// tables").
//
// This is deliberately NOT a database and NOT a file: a fixed-size in-memory
// ring the Node keeper PULLS via POST /decisions on its existing ~2-minute
// health probe and persists into its own DB (cpp_decisions table). The
// sidecar keeps no durable state — same division of authority as everything
// else here: cpp holds facts briefly, Node owns memory.
//
// bootId is random per construction so the puller can detect a restart (its
// cursor's seq becomes meaningless) and take the whole ring again. seq is
// monotonic within one boot; the ring holds the newest kSlots records.
//
// Threading: one private mutex, never held across I/O — the C2 audit's
// health-timeout lesson. Writers are order/amend/reconnect paths (a handful
// of events per minute); ticks NEVER write the ring.
#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "json.hpp"

struct DecisionRecord {
  long long seq = 0;
  long long tsMs = 0;
  std::string component;  // 'order_guard' | 'engine' | 'trail' | 'spot_feed' | 'vpo' | 'guard' | 'peer'
  std::string kind;       // e.g. 'refused', 'order_submit', 'reconnect', 'amend_fail'
  long long accountId = 0; // 0 = not account-scoped
  long long symbolId = 0;  // 0 = not symbol-scoped
  std::string code;        // machine reason/result code, "" when n/a
  std::string detail;      // short human detail, "" when n/a
};

class DecisionRing {
public:
  explicit DecisionRing(size_t slots = 256);

  // Record one decision. Fields beyond component/kind are optional.
  void log(const std::string& component, const std::string& kind,
           long long accountId = 0, long long symbolId = 0,
           std::string code = "", std::string detail = "");

  // Entries with seq > after, oldest first (all retained entries when
  // after < oldest retained — the puller re-syncs after a gap or restart).
  std::vector<DecisionRecord> since(long long after) const;

  long long latestSeq() const;
  const std::string& bootId() const { return bootId_; }

  // {bootId, latestSeq, entries:[...]} for POST /decisions. When the
  // caller's bootId does not match, the full ring is returned (restart).
  std::string dumpJson(long long after, const std::string& callerBootId) const;

private:
  const size_t slots_;
  const std::string bootId_;
  mutable std::mutex mtx_;
  std::vector<DecisionRecord> ring_; // ring_[seq % slots_]
  long long seq_ = 0;                // last assigned seq (0 = none yet)
};
