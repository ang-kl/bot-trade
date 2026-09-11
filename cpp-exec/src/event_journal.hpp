// cpp-exec/src/event_journal.hpp — P2b-1 (docs/tick-momentum/plan.md §8, §9;
// register TM-24). Every execution-event frame this session sees — matched
// to a request or unsolicited — is recorded in a bounded ring the keeper
// pulls (POST /events), so an intent whose HTTP reply was lost, or whose
// answer arrived AFTER the request gave up (a late frame), is settled from
// the broker's own event rather than left UNKNOWN. Before this, an
// unsolicited EXECUTION_EVENT was dropped on the floor (handleUnsolicited).
#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

#include "json.hpp"

struct ExecutionEventRecord {
  long long seq = 0;
  long long tsMs = 0;
  std::string clientMsgId;    // "" for an unsolicited frame
  int payloadType = 0;        // 2126 EXECUTION_EVENT | 2132 ORDER_ERROR_EVENT | 2142 ERROR_RES
  std::string executionType;  // ORDER_ACCEPTED, ORDER_FILLED, ... ("" on error frames)
  long long orderId = 0;
  long long positionId = 0;
  long long accountId = 0;
  long long symbolId = 0;
  std::string errorCode;
  std::string label;          // the order's label — carries the keeper's intent tag
  bool solicited = false;     // matched to a request this process was waiting on
};

class EventJournal {
public:
  explicit EventJournal(size_t slots = 512, std::string bootId = "");

  // Records an EXECUTION_EVENT / ORDER_ERROR_EVENT / ERROR_RES frame (the
  // whole frame: clientMsgId + payloadType + payload). Returns false and
  // records nothing for any other frame.
  bool record(const jsn::Value& frame, bool solicited);

  std::vector<ExecutionEventRecord> since(long long after) const;
  long long latestSeq() const;
  const std::string& bootId() const { return bootId_; }
  // {bootId, latestSeq, entries:[...]} for POST /events. A caller holding a
  // cursor from another boot gets everything (its cursor means nothing here).
  std::string dumpJson(long long after, const std::string& callerBootId) const;

  static ExecutionEventRecord parse(const jsn::Value& frame); // exposed for tests

private:
  const size_t slots_;
  const std::string bootId_;
  mutable std::mutex mtx_;
  std::vector<ExecutionEventRecord> ring_; // ring_[seq % slots_]
  long long seq_ = 0;
};
