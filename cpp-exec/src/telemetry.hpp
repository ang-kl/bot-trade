// cpp-exec/src/telemetry.hpp
//
// Async binary telemetry logger (item #2). The order hot path calls log()
// with a fixed-size POD record; that only PUSHES to a lock-free SPSC ring and
// returns — no file I/O, no allocation, no lock on the trade path. A single
// background thread drains the ring and appends the raw records to a binary
// file. A dropped record (ring full) is counted, never blocks the producer.
//
// Fixed-size POD + raw binary append = cheap to write and trivial to parse
// back (the test reads the file straight into the struct array). No text
// formatting on the hot path.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <thread>

#include "spsc_ring.hpp"

#pragma pack(push, 1)
struct TelemetryRecord {
  uint64_t ts_ms;       // event time
  uint32_t kind;        // TelemetryKind
  int32_t  symbol_id;
  double   volume;
  double   price;       // limit/stop price or 0
  int32_t  verdict;     // 1 ok / 0 rejected
  int32_t  reason_code; // small enum for the rejection family
};
#pragma pack(pop)

enum TelemetryKind : uint32_t {
  TK_ORDER_SUBMIT = 1,
  TK_ORDER_REJECT = 2,
  TK_ORDER_RESULT = 3,
};

class Telemetry {
public:
  // capacity = ring size (records); path = binary output file.
  Telemetry(size_t capacity, std::string path);
  ~Telemetry();

  // Producer (hot path): non-blocking. Returns false if the ring was full
  // (record dropped + counted). Never allocates, never locks, never does I/O.
  bool log(const TelemetryRecord& rec);

  uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }
  uint64_t written() const { return written_.load(std::memory_order_relaxed); }

  // Block until the background thread has drained everything currently queued
  // (tests + graceful shutdown). Not for the hot path.
  void flush();

private:
  void run();

  SpscRing<TelemetryRecord> ring_;
  std::string path_;
  std::thread worker_;
  std::atomic<bool> stop_{false};
  std::atomic<uint64_t> dropped_{0};
  std::atomic<uint64_t> written_{0};
};
