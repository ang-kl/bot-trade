// cpp-exec/src/tick_recorder.hpp — P3a (docs/tick-momentum/plan.md §4, §10,
// §11; register TM-02, TM-21, TM-23, TM-27, TM-28, TM-31). The bounded tick
// recorder: every raw spot event the feed thread sees becomes one fixed-size
// record in a bounded queue; a writer thread drains it into closed binary
// segments under a spool cap and a free-space reserve on the mount it is
// given. OFF unless the process is started with TICK_SPOOL_PATH, and even
// then it writes nothing until the keeper switches recording on — a record
// is an operator's declaration, never a side effect of deploying code.
//
// WHAT IS RECORDED. The raw observation, not a smoothed quote: which sides
// the frame carried, whether each side CHANGED against the last one seen for
// the symbol, whether this is the first event after a (re)subscribe (a
// snapshot, which warms and never counts), whether the book is crossed. The
// normalization decisions live here with the data, so a replayer can make
// them again and disagree (plan §4: "keep raw observations and
// normalization decisions in the recorder").
//
// PERSISTENT FORMAT (versioned, explicit little-endian, checksummed — native
// struct layout is NOT the format, plan §11):
//   segment  = header(64 B) + records(40 B each)
//   header   = "TKSG" | u16 version=1 | u16 headerLen=64 | u8 environment |
//              u8[3] pad | u32 generation | u64 startedMs | char[40] feedId |
//              u32 crc32(bytes 0..59)
//   record   = u64 recvMs | u32 seq | u32 symbolId | i64 bid | i64 ask |
//              u8 flags | u8 kind | u16 generation | u32 crc32(bytes 0..35)
//   flags    = 1 bidPresent | 2 askPresent | 4 bidChanged | 8 askChanged |
//              16 snapshot | 32 crossed | 64 repeat
//   kind     = 0 quote | 1 gap (bid = count, ask = GapReason)
// An absent side is INT64_MIN. Prices are cTrader wire units (1e-5).
//
// STORAGE POLICY (plan §10): segments seal at segmentBytes (64 MiB) by fsync
// + close + atomic rename from ".open" to ".tks"; the spool holds at most
// spoolCapBytes (2 GiB) of sealed + open segments and retires the OLDEST
// sealed ones first, never the open one, never a file it did not write;
// before every write the mount's available bytes minus the write must stay
// above the reserve (the larger of 2 GiB and 20% of the mount) — otherwise
// recording PAUSES with a gap, and resumes when space returns; a write is
// also refused past 85% usage, and 70% is a warning in the status. A single
// writer per spool is enforced with a lock file; a torn ".open" file from a
// crash is renamed ".torn" at start and reported, never appended to.
//
// The feed thread NEVER blocks here: a full queue drops the event and
// counts it, and the next drain writes a gap record so continuity is
// invalidated on disk, not just in a counter (TM-23).
#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "spsc_ring.hpp"

namespace tick {

constexpr uint16_t kFormatVersion = 1;
constexpr size_t kHeaderBytes = 64;
constexpr size_t kRecordBytes = 40;
constexpr int64_t kAbsent = INT64_MIN;

enum Flag : uint8_t {
  BID_PRESENT = 1, ASK_PRESENT = 2, BID_CHANGED = 4, ASK_CHANGED = 8,
  SNAPSHOT = 16, CROSSED = 32, REPEAT = 64,
};
enum Kind : uint8_t { QUOTE = 0, GAP = 1 };
enum GapReason : int64_t {
  GAP_QUEUE_OVERFLOW = 1, GAP_RESERVE_PAUSE = 2, GAP_RECONNECT = 3,
  GAP_RESTART = 4, GAP_SWITCHED_OFF = 5,
};

struct Record {
  uint64_t recvMs = 0;
  uint32_t seq = 0;
  uint32_t symbolId = 0;
  int64_t bid = kAbsent;
  int64_t ask = kAbsent;
  uint8_t flags = 0;
  uint8_t kind = QUOTE;
  uint16_t generation = 0;
};

struct SegmentHeader {
  uint8_t environment = 0;   // 0 demo, 1 live
  uint32_t generation = 0;
  uint64_t startedMs = 0;
  std::string feedId;        // truncated to 40 bytes on the wire
};

uint32_t crc32(const uint8_t* data, size_t len, uint32_t seed = 0);
void encodeRecord(const Record& r, uint8_t out[kRecordBytes]);
bool decodeRecord(const uint8_t in[kRecordBytes], Record& out); // false = checksum mismatch
void encodeHeader(const SegmentHeader& h, uint8_t out[kHeaderBytes]);
bool decodeHeader(const uint8_t in[kHeaderBytes], SegmentHeader& out);

// Reads a sealed (or torn) segment: every record whose checksum holds, in
// order, stopping at the first bad or short one (the torn tail). For tests
// and the replayer.
struct SegmentRead { SegmentHeader header; std::vector<Record> records; bool headerOk = false; bool truncated = false; };
SegmentRead readSegment(const std::string& path);

struct RecorderConfig {
  std::string spoolDir;
  std::string feedId;
  uint8_t environment = 0;
  size_t queueRecords = 1u << 18;          // 262,144 × 40 B ≈ 10 MiB in flight at most
  uint64_t segmentBytes = 64ull << 20;
  uint64_t spoolCapBytes = 2ull << 30;
  uint64_t reserveMinBytes = 2ull << 30;
  int reservePct = 20;
  int warnPct = 70;
  int stopPct = 85;
  int fsyncEveryMs = 5000;
  int budgetCheckEveryMs = 2000;
};

// Available and total bytes on the filesystem holding `dir`. Default is
// statvfs(3); tests inject a probe to script full disks.
using FreeSpaceProbe = std::function<bool(const std::string& dir, uint64_t& availBytes, uint64_t& totalBytes)>;
bool statvfsProbe(const std::string& dir, uint64_t& availBytes, uint64_t& totalBytes);

struct SymbolStat {
  uint64_t events = 0, changed = 0, repeats = 0, snapshots = 0;
  uint64_t lastRecvMs = 0;
  uint64_t windowEvents = 0;
  uint64_t windowStartMs = 0;
};

struct RecorderStats {
  bool enabled = true;
  bool recording = false;
  std::string state;             // OFF | RECORDING | PAUSED_RESERVE | WARN | ERROR | STOPPED
  std::string reason;
  uint32_t generation = 0;
  uint32_t seq = 0;
  uint64_t events = 0, changed = 0, repeats = 0, snapshots = 0, crossed = 0;
  uint64_t dropped = 0;          // queue full
  uint64_t pausedDrops = 0;      // refused by the budget
  uint64_t skippedOff = 0;       // seen while recording was off
  uint64_t gaps = 0;
  uint64_t recordsWritten = 0, bytesWritten = 0;
  uint64_t segmentsSealed = 0, segmentsRetired = 0, tornAtStart = 0;
  uint64_t openBytes = 0, sealedBytes = 0;
  uint64_t diskTotalBytes = 0, diskAvailBytes = 0, reserveBytes = 0;
  int usagePct = -1;
  uint64_t writeErrors = 0;
  std::map<long long, SymbolStat> perSymbol;
};

class TickRecorder {
public:
  explicit TickRecorder(RecorderConfig cfg, FreeSpaceProbe probe = {});
  ~TickRecorder();

  // Takes the spool lock, quarantines a torn tail, starts the writer. False
  // (with stats().reason) when the directory cannot be used or another
  // writer holds it — the process carries on with recording disabled.
  bool start();
  void stop();
  bool started() const { return started_.load(); }

  // The keeper's switch. Off (the default) counts events and writes nothing.
  // Returns false (and stays off) when the recorder never started — a
  // switch on a recorder with no spool would only fill a ring nobody drains.
  bool setRecording(bool on);
  bool recording() const { return recording_.load(); }

  // Feed thread only (single producer). `generation` is the feed's
  // connection generation — a change marks the next event per symbol as a
  // snapshot and writes a reconnect gap.
  // Returns the record as classified (flags, seq), whether or not it was
  // queued — the symbol workers (P3b) consume the same observation.
  Record onQuote(long long symbolId, bool hasBid, long long bid, bool hasAsk, long long ask,
                 uint64_t recvMs, uint32_t generation);

  RecorderStats stats() const;
  std::string statusJson() const;

  // Block until the queue is drained and flushed (tests). Not the hot path.
  void flush();

private:
  struct SymbolState { int64_t bid = kAbsent, ask = kAbsent; bool snapshotPending = true; };

  void writerLoop();
  bool openSegment(uint64_t nowMs);
  void sealSegment(bool finalSeal);
  bool budgetAllows(uint64_t nextWriteBytes, uint64_t nowMs);
  void retire();
  void scanSpool(uint64_t& sealedBytes, std::vector<std::pair<std::string, uint64_t>>& sealed) const;
  bool writeRecord(const Record& r);
  void noteGap(GapReason reason, uint64_t count);

  RecorderConfig cfg_;
  FreeSpaceProbe probe_;
  SpscRing<Record> ring_;
  std::thread writer_;
  std::atomic<bool> stop_{false};
  std::atomic<bool> started_{false};
  std::atomic<bool> recording_{false};
  std::atomic<bool> flushRequested_{false};
  int lockFd_ = -1;
  // A torn tail found at start is reported in the FIRST segment the writer
  // opens — set before the writer thread exists, consumed by it. (Pushing
  // the gap through the ring at start() lost it whenever the writer's
  // off-branch drained the ring before recording was switched on.)
  bool restartGapPending_ = false;
  uint64_t tornAtStart_ = 0;

  // Feed-thread state (no lock: one producer). generation_ and seq_ are
  // atomics only because the writer thread stamps gap records with the
  // generation and stats() reads both from any thread.
  std::map<long long, SymbolState> last_;
  std::atomic<uint32_t> generation_{0};
  std::atomic<uint32_t> seq_{0};
  uint32_t segIndex_ = 0;
  std::atomic<uint64_t> pendingOverflow_{0};   // dropped since the last overflow gap

  // Writer-thread state.
  FILE* out_ = nullptr;
  std::string openPath_, sealedPath_;
  uint64_t openBytes_ = 0;
  uint64_t lastFsyncMs_ = 0, lastBudgetMs_ = 0;
  bool paused_ = false;
  bool wasRecording_ = false;
  std::vector<uint8_t> buf_;

  // Shared counters (writer writes, status reads).
  mutable std::mutex statsMtx_;
  RecorderStats st_;
  // Per-symbol counters (feed writes, status reads).
  mutable std::mutex symMtx_;
  std::map<long long, SymbolStat> sym_;
  std::atomic<uint64_t> events_{0}, changed_{0}, repeats_{0}, snapshots_{0}, crossed_{0},
                        dropped_{0}, skippedOff_{0};
};

} // namespace tick
