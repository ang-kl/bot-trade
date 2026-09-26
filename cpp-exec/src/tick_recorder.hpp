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
// spoolCapBytes (2 GiB by default, TICK_SPOOL_CAP_BYTES) of sealed + open
// segments and retires the OLDEST
// sealed ones first, never the open one, never a file it did not write;
// before every write the mount's available bytes minus the write must stay
// above the reserve (the larger of 2 GiB and 20% of the mount by default —
// TICK_SPOOL_RESERVE_MIN_BYTES and TICK_SPOOL_RESERVE_PCT) — otherwise
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
#include <cstdio>
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

// ---------------------------------------------------------------------------
// PR-I: the sealed-segment READ path (docs/plan-execution-audit-2026-09-11.md
// §12.3 "segment locality"). The keeper cannot reach the spool — it is a
// volume on the sidecar — so research had no data at all. These helpers are
// the listing and the bounded range read the two HTTP routes in main.cpp are
// built from; they are free functions (not TickRecorder methods) because a
// READER holds no recorder state: a sealed segment is immutable, so nothing
// here touches the writer thread, its mutexes or its ring.
//
// WHY IMMUTABLE IS TRUE, not assumed: the writer only ever has the ".open"
// file open (`openSegment` opens `openPath_`, `writeRecord`/`sealSegment`
// write through that same FILE*), sealing is the atomic rename to ".tks",
// and the ONLY thing that ever touches a sealed file afterwards is
// `retire()`, which unlinks it. No code path rewrites or appends to a
// ".tks". So a reader needs no lock; it needs to survive the unlink, which
// `readSegmentChunk` does by holding an fd (POSIX keeps the inode alive) and
// by answering NOT_FOUND — never a short read presented as the whole file —
// when the open itself loses the race.
//
// A never-served ".open" is the other half: the rename exists precisely so a
// reader cannot see a torn tail, and `isSealedSegmentName` is what enforces
// it (its terminal ".tks" anchor is the ".open" exclusion).

/** One /tick-segment body, capped: bytes are base64 in JSON, so 1 MiB raw. */
constexpr size_t kMaxChunkBytes = 1u << 20;
/** At most this many entries in one /tick-segments listing. */
constexpr size_t kMaxListEntries = 500;

/**
 * THE SECURITY BOUNDARY. True only for exactly `seg-<13 digits>-<6
 * digits>.tks` — the recorder's own sealed naming (`openSegment`). No path
 * separator, no "..", no ".open", no other extension can match, because the
 * match is anchored at both ends and every byte between is fixed or a digit.
 */
bool isSealedSegmentName(const std::string& name);

struct SegmentEntry {
  std::string name;
  uint64_t bytes = 0;
  uint64_t sealedAtMs = 0;   // the file's mtime — the moment of the sealing rename
  uint32_t index = 0;        // the six-digit counter in the name
};

struct SegmentList {
  std::vector<SegmentEntry> segments;  // SEALED only, oldest first
  uint64_t openBytes = 0;              // the open segment's bytes, reported, never served
  bool truncated = false;              // more sealed segments than maxEntries
};
SegmentList listSealedSegments(const std::string& dir, size_t maxEntries = kMaxListEntries);

enum class ChunkStatus { OK, BAD_NAME, NOT_FOUND };
struct SegmentChunk {
  ChunkStatus status = ChunkStatus::OK;
  uint64_t totalBytes = 0;
  uint64_t offset = 0;
  bool eof = false;
  std::string bytes;   // raw; the route base64s it
};
/**
 * `len` bytes of a sealed segment at `offset`, clamped to kMaxChunkBytes. An
 * offset at or past EOF is not an error: zero bytes and eof=true.
 */
SegmentChunk readSegmentChunk(const std::string& dir, const std::string& name, uint64_t offset, uint64_t len);

/** Standard base64 (RFC 4648, padded) — the JSON transport for segment bytes. */
std::string base64Encode(const std::string& raw);

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
  // GW-CAP: where spoolCapBytes / reserveMinBytes / reservePct came from —
  // "default" (variable unset), "env" (set and accepted) or "refused" (set,
  // refused, the default above in force). Reported on /health and
  // /tick-status so a read-back can tell a variable that took effect from a
  // default that happens to match; the writer never reads them.
  std::string spoolCapSource = "default";
  std::string reserveMinSource = "default";
  std::string reservePctSource = "default";
  std::vector<std::string> limitRefusals;  // one line per refused variable
};

// ---------------------------------------------------------------------------
// GW-CAP (owner, 25-09-2026 22:03 SGT: "ensure all cpp services passed"). The
// spool cap and the free-space reserve were compiled in — 2 GiB, about 12
// days of raw ticks, on a 50 GB volume 5 % used. They are now read from the
// environment next to TICK_SPOOL_PATH, with the compiled values above as the
// defaults, so NOTHING changes until a variable is set:
//
//   TICK_SPOOL_CAP_BYTES          spoolCapBytes    (>= one segment)
//   TICK_SPOOL_RESERVE_MIN_BYTES  reserveMinBytes
//   TICK_SPOOL_RESERVE_PCT        reservePct       (0..90)
//
// A byte count is a whole number, optionally with ONE binary unit — KiB, MiB,
// GiB or TiB (case-insensitive), or a bare B. Decimal units (GB, G, k) are
// REFUSED rather than guessed: "20GB" is 20e9 to a disk vendor and 20 GiB to
// most operators, and a cap is not a place to pick one silently. A refused
// value keeps the default and yields one line naming the variable, what was
// typed and why — logged at boot and reported on /tick-status — never a
// silent fallback.
struct SpoolLimitText {
  std::string capBytes;         // TICK_SPOOL_CAP_BYTES ("" = unset)
  std::string reserveMinBytes;  // TICK_SPOOL_RESERVE_MIN_BYTES
  std::string reservePct;       // TICK_SPOOL_RESERVE_PCT
};
constexpr int kMaxReservePct = 90;

/** A whole byte count with an optional binary unit. False with `why` otherwise. */
bool parseByteCount(const std::string& text, uint64_t& out, std::string& why);
/** A whole percent 0..100, optional trailing '%'. False with `why` otherwise. */
bool parsePercent(const std::string& text, int& out, std::string& why);

/**
 * Applies the three variables over `cfg`'s current values (the defaults).
 * Unset keeps the default. Refused: anything that does not parse, a cap below
 * one segment (`cfg.segmentBytes` — the spool could not keep a single sealed
 * segment), a reserve over kMaxReservePct. Sets the three *Source fields and
 * `limitRefusals`, and returns the refusal lines (empty = all accepted).
 * Call it after `segmentBytes` is final.
 */
std::vector<std::string> applySpoolLimits(RecorderConfig& cfg, const SpoolLimitText& text);

/** The reserve the budget holds back on a mount of `totalBytes`: the larger of the two. */
uint64_t effectiveReserveBytes(const RecorderConfig& cfg, uint64_t totalBytes);

/**
 * Whether the spool can grow to its cap on this mount without the mount
 * pausing or flagging it first. The spool peaks at the cap plus the one open
 * segment `retire()` lets past it — a segment, plus up to one queue's worth
 * (queueRecords × kRecordBytes) the writer drains before its seal check; at
 * that peak the mount must still keep
 * the reserve free and stay under warnPct (WARN is not RECORDING to the
 * keeper's tick readiness) and stopPct. Otherwise the cap never binds: the
 * recorder pauses with gaps on disk instead of retiring its oldest segment.
 * `spoolBytesNow` is the spool's own share of the used bytes (sealed + open),
 * so what OTHER files hold is `used - spoolBytesNow`. Empty = fits; each
 * line names the limit that is hit and the largest cap that would fit.
 * `totalBytes` 0 (never probed) is one line saying the mount is unknown.
 */
std::vector<std::string> spoolFitProblems(const RecorderConfig& cfg, uint64_t totalBytes, uint64_t availBytes,
                                          uint64_t spoolBytesNow);

/**
 * True when a spool full of whole segments at this cap holds more sealed
 * segments than one GET /tick-segments listing returns (kMaxListEntries,
 * OLDEST first) — the keeper's read path then cannot see the newest ones
 * until older ones retire. Not a refusal (the recorder is unaffected); a
 * boot line, so a cap past 500 × 64 MiB is chosen knowingly.
 */
bool capExceedsListing(const RecorderConfig& cfg);

/** "21474836480 B (20.00 GiB)" — exact bytes first, so a log line is never rounded into a false value. */
std::string describeBytes(uint64_t bytes);

// Available and total bytes on the filesystem holding `dir`. Default is
// statvfs(3); tests inject a probe to script full disks.
using FreeSpaceProbe = std::function<bool(const std::string& dir, uint64_t& availBytes, uint64_t& totalBytes)>;
bool statvfsProbe(const std::string& dir, uint64_t& availBytes, uint64_t& totalBytes);

// GW-1 (P8c item 8): what the spool's mount IS — the container's own
// overlay (the host's disk, whatever TICK_SPOOL_PATH says: nothing survives
// a redeploy and the usage bands read the host's usage) or a mounted
// filesystem (a volume). `kind` is "host_overlay", "volume" or "unknown";
// `fsType` names the statfs magic ("overlay", "ext4", "xfs", "tmpfs", or the
// hex value). Reported only — the WARN band that stops the firer at 70 %
// host usage is unchanged (that gating changes only on the owner's word).
struct MountFacts { std::string kind = "unknown"; std::string fsType; };
MountFacts probeMount(const std::string& dir);

// GW-1 (P8c item 5): a torn segment's salvage. Keeps the header and every
// complete record whose checksum holds, truncates the torn tail, and seals
// the result under the recorder's own name (the ".open"/".torn" suffix
// dropped) by an fsync and an atomic rename. False — the file left as it is
// — when the header is unreadable, the sealed name already exists, or any
// step fails (`why` names it). `records` is how many survived.
bool salvageSegment(const std::string& path, const std::string& sealedPath, size_t& records, std::string& why);

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
  // GW-1 (P8c item 5): torn files found at start and sealed by salvage, the
  // records they kept, and the bytes of torn files that could NOT be
  // salvaged — counted under the cap (retention never deletes them).
  uint64_t salvaged = 0, salvagedRecords = 0, tornBytes = 0;
  // GW-1 (P8c item 6): a seal, retire or salvage step whose return code said
  // it failed. A failed seal stops the writer in ERROR (never RECORDING).
  uint64_t sealFailures = 0, retireFailures = 0;
  uint64_t openBytes = 0, sealedBytes = 0;
  uint64_t diskTotalBytes = 0, diskAvailBytes = 0, reserveBytes = 0;
  int usagePct = -1;
  uint64_t writeErrors = 0;
  MountFacts mount;              // GW-1 (P8c item 8)
  // GW-1 (P8c item 9): counters persisted on the spool itself
  // (.recorder-lifetime.json), so they survive the process: every boot that
  // started a writer on this spool, and every segment it sealed, retired or
  // salvaged. On an ephemeral spool they restart with the spool, which is
  // itself the evidence that the spool was lost.
  uint64_t lifetimeBoots = 0, lifetimeSealed = 0, lifetimeRetired = 0, lifetimeSalvaged = 0, lifetimeTornFound = 0;
  bool lifetimeLoaded = false;   // false: no counter file was found (a new or lost spool)
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
  // GW-CAP: the limits in force, where each came from, the reserve in bytes
  // on this mount (null until the writer's first probe) and whether the cap
  // fits the mount (null until then). `withText` adds the refusal and fit
  // lines — /tick-status (authenticated) has them; /health (open) carries
  // counts only, because a refusal line quotes what the operator typed.
  std::string limitsJson(bool withText) const;
  // Same, from stats the caller already holds (/health has them — no second
  // copy of the per-symbol map under its mutex).
  std::string limitsJson(const RecorderStats& s, bool withText) const;

  // Block until the queue is drained and flushed (tests). Not the hot path.
  void flush();

  // TEST SEAM (GW-1): the rename a seal uses, so a test can make it fail.
  void setRenameForTests(std::function<int(const char*, const char*)> r) { renameFn_ = std::move(r); }

private:
  struct SymbolState { int64_t bid = kAbsent, ask = kAbsent; bool snapshotPending = true; };

  void writerLoop();
  bool openSegment(uint64_t nowMs);
  void sealSegment(bool finalSeal);
  bool budgetAllows(uint64_t nextWriteBytes, uint64_t nowMs);
  void retire();
  void scanSpool(uint64_t& sealedBytes, std::vector<std::pair<std::string, uint64_t>>& sealed, uint64_t& tornBytes) const;
  bool writeRecord(const Record& r);
  void noteGap(GapReason reason, uint64_t count);
  void loadLifetime();
  void saveLifetime();
  int doRename(const char* from, const char* to) { return renameFn_ ? renameFn_(from, to) : ::rename(from, to); }

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
  bool sealFailed_ = false;      // a seal step failed: the writer stops writing (ERROR)
  std::function<int(const char*, const char*)> renameFn_;
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
