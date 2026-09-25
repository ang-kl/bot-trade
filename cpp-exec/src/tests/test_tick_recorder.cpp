// cpp-exec/src/tests/test_tick_recorder.cpp — P3a: the bounded tick recorder
// against a temp spool and a scripted free-space probe. What it proves: the
// persistent format round-trips with checksums; the raw observation and the
// normalization flags land as specified; nothing is written while recording
// is off; a full queue drops and marks a gap on disk; a mount below its
// reserve pauses recording and the resume is a gap; segments seal by rename
// and the spool cap retires the oldest sealed one, never the open one; a
// second writer is refused; a torn tail is quarantined and reported.
#include <cassert>
#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

#include "../json.hpp"
#include "../tick_recorder.hpp"

using namespace tick;

namespace {

std::string tmpSpool() {
  // Under $TMPDIR when it is set (a gate's private directory, removed after
  // the run), /tmp otherwise — these dirs are left behind by design.
  const char* t = std::getenv("TMPDIR");
  std::string tmpl = std::string(t && *t ? t : "/tmp") + "/tick_spool_XXXXXX";
  std::vector<char> buf(tmpl.begin(), tmpl.end());
  buf.push_back('\0');
  const char* d = mkdtemp(buf.data());
  assert(d);
  return std::string(d) + "/spool";
}

std::vector<std::string> listFiles(const std::string& dir, const std::string& suffix) {
  std::vector<std::string> out;
  if (DIR* d = ::opendir(dir.c_str())) {
    while (dirent* e = ::readdir(d)) {
      const std::string n = e->d_name;
      if (n.size() >= suffix.size() && n.compare(n.size() - suffix.size(), suffix.size(), suffix) == 0) out.push_back(dir + "/" + n);
    }
    ::closedir(d);
  }
  std::sort(out.begin(), out.end());
  return out;
}

FreeSpaceProbe plenty() {
  return [](const std::string&, uint64_t& avail, uint64_t& total) { avail = 40ull << 30; total = 50ull << 30; return true; };
}

RecorderConfig smallConfig(const std::string& dir) {
  RecorderConfig c;
  c.spoolDir = dir;
  c.feedId = "demo.ctraderapi.com/…7342";
  c.environment = 0;
  c.queueRecords = 1024;
  c.segmentBytes = 64ull << 20;
  c.spoolCapBytes = 2ull << 30;
  c.reserveMinBytes = 2ull << 30;
  c.fsyncEveryMs = 50;
  c.budgetCheckEveryMs = 0; // probe every write — the scripted disk must bind immediately
  return c;
}

uint64_t now() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

} // namespace

static void test_format_round_trips_and_detects_corruption() {
  Record r;
  r.recvMs = 1757548800123ull; r.seq = 42; r.symbolId = 41; r.bid = 108123; r.ask = 108131;
  r.flags = BID_PRESENT | ASK_PRESENT | BID_CHANGED; r.kind = QUOTE; r.generation = 3;
  uint8_t bytes[kRecordBytes];
  encodeRecord(r, bytes);
  Record d;
  assert(decodeRecord(bytes, d));
  assert(d.recvMs == r.recvMs && d.seq == 42 && d.symbolId == 41 && d.bid == 108123 && d.ask == 108131);
  assert(d.flags == r.flags && d.kind == QUOTE && d.generation == 3);
  bytes[17] ^= 0x01; // one flipped bit in the bid
  assert(!decodeRecord(bytes, d));
  Record absent; absent.bid = kAbsent; absent.ask = 5; absent.flags = ASK_PRESENT;
  encodeRecord(absent, bytes);
  assert(decodeRecord(bytes, d) && d.bid == kAbsent && d.ask == 5);

  SegmentHeader h; h.environment = 1; h.generation = 7; h.startedMs = 1757548800000ull;
  h.feedId = "live.ctraderapi.com/…2148-a-very-long-feed-identity-that-is-truncated";
  uint8_t hb[kHeaderBytes];
  encodeHeader(h, hb);
  SegmentHeader hd;
  assert(decodeHeader(hb, hd));
  assert(hd.environment == 1 && hd.generation == 7 && hd.startedMs == h.startedMs);
  assert(hd.feedId == h.feedId.substr(0, 36));
  hb[9] = 0xFF; // reserved byte changed → checksum fails
  assert(!decodeHeader(hb, hd));
}

static void test_records_carry_the_raw_observation_and_its_flags() {
  const std::string dir = tmpSpool();
  {
    TickRecorder rec(smallConfig(dir), plenty());
    assert(rec.start());
    rec.setRecording(true);
    const uint64_t t = now();
    rec.onQuote(41, true, 100, true, 102, t, 1);        // first event: snapshot
    rec.onQuote(41, true, 100, true, 102, t + 1, 1);    // identical: repeat
    rec.onQuote(41, true, 101, true, 102, t + 2, 1);    // bid moved
    rec.onQuote(41, false, 0, true, 103, t + 3, 1);     // one-sided: ask only
    rec.onQuote(41, true, 105, false, 0, t + 4, 1);     // bid above the last ask: crossed
    rec.onQuote(42, true, 7, true, 8, t + 5, 1);        // another symbol's snapshot
    rec.onQuote(41, true, 105, true, 106, t + 6, 2);    // new generation: snapshot again + reconnect gap
    rec.flush();
    const RecorderStats s = rec.stats();
    assert(s.events == 7 && s.snapshots == 3 && s.repeats == 1 && s.changed == 3 && s.crossed == 1);
    assert(s.dropped == 0 && s.skippedOff == 0 && s.state == "RECORDING");
    assert(s.perSymbol.at(41).events == 6 && s.perSymbol.at(42).events == 1);
    assert(listFiles(dir, ".tks.open").size() == 1 && listFiles(dir, ".tks").empty());
    rec.stop();
  }
  const auto sealed = listFiles(dir, ".tks");
  assert(sealed.size() == 1 && listFiles(dir, ".tks.open").empty());
  const SegmentRead seg = readSegment(sealed[0]);
  assert(seg.headerOk && !seg.truncated);
  assert(seg.header.environment == 0 && seg.header.feedId == "demo.ctraderapi.com/…7342");
  // 7 quotes + 1 reconnect gap (the gap is written before the generation-2 quote)
  assert(seg.records.size() == 8);
  const Record& a = seg.records[0];
  assert(a.kind == QUOTE && a.symbolId == 41 && a.bid == 100 && a.ask == 102 && (a.flags & SNAPSHOT) && (a.flags & BID_PRESENT) && (a.flags & ASK_PRESENT) && !(a.flags & REPEAT));
  const Record& b = seg.records[1];
  assert((b.flags & REPEAT) && !(b.flags & BID_CHANGED) && !(b.flags & ASK_CHANGED) && !(b.flags & SNAPSHOT));
  const Record& c = seg.records[2];
  assert((c.flags & BID_CHANGED) && !(c.flags & ASK_CHANGED) && c.bid == 101);
  const Record& d = seg.records[3];
  assert(!(d.flags & BID_PRESENT) && d.bid == kAbsent && (d.flags & ASK_PRESENT) && (d.flags & ASK_CHANGED) && d.ask == 103);
  const Record& e = seg.records[4];
  assert((e.flags & CROSSED) && (e.flags & BID_PRESENT) && !(e.flags & ASK_PRESENT) && e.ask == kAbsent);
  const Record& f = seg.records[5];
  assert(f.symbolId == 42 && (f.flags & SNAPSHOT));
  const Record& g = seg.records[6];
  assert(g.kind == GAP && g.ask == GAP_RECONNECT && g.bid == 1);
  const Record& h = seg.records[7];
  assert(h.kind == QUOTE && h.generation == 2 && (h.flags & SNAPSHOT) && h.symbolId == 41);
  for (size_t i = 1; i < seg.records.size(); ++i) assert(seg.records[i].seq > seg.records[i - 1].seq);
}

static void test_off_by_default_counts_but_writes_nothing() {
  const std::string dir = tmpSpool();
  TickRecorder rec(smallConfig(dir), plenty());
  assert(rec.start());
  assert(!rec.recording());
  for (int i = 0; i < 50; ++i) rec.onQuote(41, true, 100 + i, true, 102 + i, now(), 1);
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  const RecorderStats s = rec.stats();
  assert(s.events == 50 && s.skippedOff == 50 && s.recordsWritten == 0 && s.state == "OFF");
  assert(listFiles(dir, ".tks.open").empty() && listFiles(dir, ".tks").empty());
  // parseable status with the keys the keeper reads
  auto j = jsn::parse(rec.statusJson());
  assert(j && j->get("enabled").asBool() && !j->get("recording").asBool() && j->get("state").asString() == "OFF");
  assert(j->get("events").get("total").asNumber(0) == 50 && j->get("perSymbol").asArray().size() == 1);
  rec.stop();
  assert(listFiles(dir, ".tks").empty()); // nothing was ever opened, so nothing is sealed
}

static void test_a_full_queue_drops_and_marks_a_gap_on_disk() {
  const std::string dir = tmpSpool();
  RecorderConfig c = smallConfig(dir);
  c.queueRecords = 4;
  {
    TickRecorder rec(c, plenty());
    assert(rec.start());
    rec.setRecording(true);
    // Far more events than the ring holds, faster than the writer wakes.
    for (int i = 0; i < 400; ++i) rec.onQuote(41, true, 100 + i, true, 200 + i, now(), 1);
    rec.flush();
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    rec.flush();
    const RecorderStats s = rec.stats();
    assert(s.dropped > 0 && s.dropped < 400);
    assert(s.gaps >= 1);
    rec.stop();
  }
  const auto sealed = listFiles(dir, ".tks");
  assert(sealed.size() == 1);
  const SegmentRead seg = readSegment(sealed[0]);
  uint64_t droppedOnDisk = 0;
  for (const auto& r : seg.records) if (r.kind == GAP && r.ask == GAP_QUEUE_OVERFLOW) droppedOnDisk += static_cast<uint64_t>(r.bid);
  assert(droppedOnDisk > 0);
}

static void test_a_mount_below_its_reserve_pauses_and_the_resume_is_a_gap() {
  const std::string dir = tmpSpool();
  RecorderConfig c = smallConfig(dir);
  // 50 GiB mount, 20% reserve = 10 GiB. Scripted available: 9 GiB (below).
  std::atomic<uint64_t> avail{9ull << 30};
  TickRecorder rec(c, [&avail](const std::string&, uint64_t& a, uint64_t& t) { a = avail.load(); t = 50ull << 30; return true; });
  assert(rec.start());
  rec.setRecording(true);
  for (int i = 0; i < 20; ++i) rec.onQuote(41, true, 100 + i, true, 200 + i, now(), 1);
  rec.flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  RecorderStats s = rec.stats();
  assert(s.state == "PAUSED_RESERVE");
  assert(s.pausedDrops == 20 && s.recordsWritten == 0);
  assert(s.reserveBytes == (10ull << 30) && s.usagePct == 82);
  assert(listFiles(dir, ".tks.open").empty()); // not even a header
  auto j = jsn::parse(rec.statusJson());
  assert(j && j->get("state").asString() == "PAUSED_RESERVE" && j->get("disk").get("reserveBytes").asNumber(0) == 10.0 * (1ull << 30));
  // Space returns.
  avail.store(30ull << 30);
  for (int i = 0; i < 5; ++i) rec.onQuote(41, true, 300 + i, true, 400 + i, now(), 1);
  rec.flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  s = rec.stats();
  assert(s.state == "RECORDING");
  assert(s.recordsWritten == 6 && s.gaps == 1); // the pause gap + 5 quotes
  rec.stop();
  const auto sealed = listFiles(dir, ".tks");
  assert(sealed.size() == 1);
  const SegmentRead seg = readSegment(sealed[0]);
  assert(seg.records.size() == 6);
  assert(seg.records[0].kind == GAP && seg.records[0].ask == GAP_RESERVE_PAUSE && seg.records[0].bid == 20);
  assert(seg.records[1].kind == QUOTE && seg.records[1].bid == 300);
}

static void test_warning_band_is_reported_but_keeps_recording() {
  const std::string dir = tmpSpool();
  RecorderConfig c = smallConfig(dir);
  c.reserveMinBytes = 1ull << 20; // a tiny reserve so 75% usage is allowed
  c.reservePct = 1;
  TickRecorder rec(c, [](const std::string&, uint64_t& a, uint64_t& t) { a = 12ull << 30; t = 50ull << 30; return true; }); // 76% used
  assert(rec.start());
  rec.setRecording(true);
  for (int i = 0; i < 5; ++i) rec.onQuote(41, true, 100 + i, true, 200 + i, now(), 1);
  rec.flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  const RecorderStats s = rec.stats();
  assert(s.recordsWritten == 5 && s.state == "WARN" && s.usagePct == 76);
  rec.stop();
}

static void test_segments_seal_by_rename_and_the_cap_retires_the_oldest_sealed_one() {
  const std::string dir = tmpSpool();
  RecorderConfig c = smallConfig(dir);
  c.segmentBytes = kHeaderBytes + 10 * kRecordBytes;   // 10 quotes per segment
  c.spoolCapBytes = 3 * c.segmentBytes + kHeaderBytes;  // room for three sealed + a fresh open one
  c.fsyncEveryMs = 1;
  TickRecorder rec(c, plenty());
  assert(rec.start());
  rec.setRecording(true);
  for (int i = 0; i < 65; ++i) {
    rec.onQuote(41, true, 100 + i, true, 200 + i, now(), 1);
    if (i % 10 == 9) { rec.flush(); std::this_thread::sleep_for(std::chrono::milliseconds(15)); }
  }
  rec.flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  const RecorderStats s = rec.stats();
  assert(s.segmentsSealed >= 6);
  assert(s.segmentsRetired >= 3);
  const auto sealed = listFiles(dir, ".tks");
  const auto open = listFiles(dir, ".tks.open");
  assert(open.size() == 1);
  uint64_t bytes = 0;
  for (const auto& p : sealed) { const SegmentRead seg = readSegment(p); assert(seg.headerOk && !seg.truncated); bytes += kHeaderBytes + seg.records.size() * kRecordBytes; }
  assert(bytes <= c.spoolCapBytes);
  assert(sealed.size() <= 3);
  // The newest sealed segment holds the newest complete decade of quotes.
  const SegmentRead newest = readSegment(sealed.back());
  assert(newest.records.size() == 10);
  rec.stop();
}

static void test_a_second_writer_on_the_same_spool_is_refused() {
  const std::string dir = tmpSpool();
  TickRecorder first(smallConfig(dir), plenty());
  assert(first.start());
  TickRecorder second(smallConfig(dir), plenty());
  assert(!second.start());
  assert(second.stats().state == "ERROR");
  assert(second.stats().reason.find("locked") != std::string::npos);
  assert(!second.setRecording(true) && !second.recording()); // a switch on a recorder that never started is refused
  second.onQuote(41, true, 1, true, 2, now(), 1);
  assert(second.stats().skippedOff == 1 && second.stats().dropped == 0);
  first.stop();
  TickRecorder third(smallConfig(dir), plenty()); // the lock is released with the first
  assert(third.start());
  third.stop();
}

static void test_a_torn_tail_is_quarantined_and_reported_as_a_gap() {
  const std::string dir = tmpSpool();
  assert(::mkdir(dir.c_str(), 0755) == 0);
  {
    // A crashed writer left an open segment with one good record and a half one.
    std::FILE* f = std::fopen((dir + "/seg-0000000000001-000001.tks.open").c_str(), "wb");
    assert(f);
    SegmentHeader h; h.feedId = "x"; uint8_t hb[kHeaderBytes]; encodeHeader(h, hb); std::fwrite(hb, 1, kHeaderBytes, f);
    Record r; r.symbolId = 1; r.bid = 5; r.ask = 6; r.flags = BID_PRESENT | ASK_PRESENT; uint8_t rb[kRecordBytes]; encodeRecord(r, rb);
    std::fwrite(rb, 1, kRecordBytes, f);
    std::fwrite(rb, 1, 17, f); // torn
    std::fclose(f);
  }
  TickRecorder rec(smallConfig(dir), plenty());
  assert(rec.start());
  assert(rec.stats().tornAtStart == 1);
  assert(listFiles(dir, ".tks.open").empty());
  const auto torn = listFiles(dir, ".torn");
  assert(torn.size() == 1);
  const SegmentRead t = readSegment(torn[0]);
  assert(t.headerOk && t.truncated && t.records.size() == 1 && t.records[0].bid == 5); // the complete record survives
  rec.setRecording(true);
  rec.onQuote(41, true, 100, true, 101, now(), 1);
  rec.flush();
  rec.stop();
  const auto sealed = listFiles(dir, ".tks");
  assert(sealed.size() == 1);
  const SegmentRead seg = readSegment(sealed[0]);
  assert(seg.records.size() == 2 && seg.records[0].kind == GAP && seg.records[0].ask == GAP_RESTART && seg.records[0].bid == 1);
  assert(torn.size() == 1 && listFiles(dir, ".torn").size() == 1); // retention never touches a torn file
}

static void test_switching_off_seals_the_open_segment_with_a_gap() {
  const std::string dir = tmpSpool();
  TickRecorder rec(smallConfig(dir), plenty());
  assert(rec.start());
  rec.setRecording(true);
  rec.onQuote(41, true, 100, true, 101, now(), 1);
  rec.flush();
  rec.setRecording(false);
  std::this_thread::sleep_for(std::chrono::milliseconds(40));
  const auto sealed = listFiles(dir, ".tks");
  assert(sealed.size() == 1 && listFiles(dir, ".tks.open").empty());
  const SegmentRead seg = readSegment(sealed[0]);
  assert(seg.records.size() == 2 && seg.records[1].kind == GAP && seg.records[1].ask == GAP_SWITCHED_OFF);
  assert(rec.stats().state == "OFF");
  rec.stop();
}


// start() creates ONE level with ::mkdir — it is not `mkdir -p`, and that is
// why the container path depends on the entrypoint (20-09-2026).
//
// tick_recorder.cpp's start() calls ::mkdir(spoolDir) once and fails on
// anything but EEXIST. So a TICK_SPOOL_PATH whose PARENT does not exist —
// the ordinary case on a container with no volume mounted, e.g.
// /data/tick where /data itself is absent — does not get created here: the
// recorder reports ERROR with the errno text and stays off.
//
// What actually makes the no-volume path work is cpp-exec/entrypoint.sh,
// which runs `mkdir -p "$TICK_SPOOL_PATH"` (and chowns it to appuser) before
// exec'ing the binary. If that line is ever dropped, or the variable is set
// on a service whose entrypoint is bypassed, the recorder cannot recover on
// its own — this test is the record of that dependency.
//
// The second half matters as much as the first: after the failed start the
// object must stay usable, because main.cpp carries on with recording
// disabled and keeps serving /tick-status from stats().
static void test_start_creates_one_level_only_and_survives_a_missing_parent() {
  // (a) one level below an existing directory: created, start succeeds
  char base[] = "/tmp/tick_mkdir_XXXXXX";
  const char* root = mkdtemp(base);
  assert(root);
  const std::string good = std::string(root) + "/child";
  {
    TickRecorder rec(smallConfig(good), plenty());
    assert(rec.start());
    struct stat sb{};
    assert(::stat(good.c_str(), &sb) == 0 && S_ISDIR(sb.st_mode));
    assert(rec.started());
    rec.stop();
  }

  // (b) two levels — the parent does not exist — FAILS, and says mkdir + errno
  const std::string missingParent = std::string(root) + "/absent/child";
  TickRecorder bad(smallConfig(missingParent), plenty());
  assert(!bad.start());
  assert(!bad.started());
  const RecorderStats s = bad.stats();
  assert(s.state == "ERROR");
  assert(s.reason.find("mkdir") != std::string::npos);
  assert(s.reason.find(missingParent) != std::string::npos);
  assert(s.reason.find(std::strerror(ENOENT)) != std::string::npos);
  // nothing was created at either level
  struct stat sb{};
  assert(::stat((std::string(root) + "/absent").c_str(), &sb) != 0);

  // the object is still usable: stats() answers, the switch refuses rather
  // than filling a ring nobody drains, and a retry fails the same way.
  assert(bad.setRecording(true) == false);
  assert(bad.recording() == false);
  assert(!bad.start());
  assert(bad.stats().state == "ERROR");
  bad.stop();

  // and a fresh recorder on a good directory still starts — the failure was
  // the path, not a latched global.
  const std::string good2 = std::string(root) + "/child2";
  TickRecorder again(smallConfig(good2), plenty());
  assert(again.start());
  assert(again.stats().state != "ERROR");
  again.stop();

  // Tidy up this scenario's own tree. The rest of the file leaves its
  // mkdtemp dirs behind; no reason to add to that here.
  for (const std::string& d : {good, good2}) {
    for (const std::string& f : listFiles(d, "")) ::unlink(f.c_str());
    ::rmdir(d.c_str());
  }
  ::rmdir(root);
}

// ---------------------------------------------------------------------------
// GW-CAP: the spool cap and the reserve from the environment.

namespace {

// These scenarios make their spools under $TMPDIR when it is set (the
// gate's private directory) and remove their own tree afterwards. Declared
// FIRST in a test so it is destroyed after the recorder has stopped.
struct Scratch {
  std::string root, spool;
  Scratch() {
    const char* t = std::getenv("TMPDIR");
    std::string tmpl = std::string(t && *t ? t : "/tmp") + "/tick_gwcap_XXXXXX";
    std::vector<char> buf(tmpl.begin(), tmpl.end());
    buf.push_back('\0');
    const char* d = mkdtemp(buf.data());
    assert(d);
    root = d;
    spool = root + "/spool";
  }
  ~Scratch() {
    if (DIR* dd = ::opendir(spool.c_str())) {
      while (dirent* e = ::readdir(dd)) {
        const std::string n = e->d_name;
        if (n != "." && n != "..") ::unlink((spool + "/" + n).c_str());
      }
      ::closedir(dd);
    }
    ::rmdir(spool.c_str());
    ::rmdir(root.c_str());
  }
};

bool contains(const std::string& hay, const std::string& needle) { return hay.find(needle) != std::string::npos; }

} // namespace

static void test_spool_limit_values_parse_exactly_and_refuse_ambiguity() {
  uint64_t b = 0;
  std::string why;
  assert(parseByteCount("2147483648", b, why) && b == (2ull << 30));
  assert(parseByteCount("20GiB", b, why) && b == (20ull << 30));
  assert(parseByteCount(" 20 gib ", b, why) && b == (20ull << 30));   // case and spaces
  assert(parseByteCount("512MiB", b, why) && b == (512ull << 20));
  assert(parseByteCount("64 KiB", b, why) && b == (64ull << 10));
  assert(parseByteCount("1TiB", b, why) && b == (1ull << 40));
  assert(parseByteCount("4096B", b, why) && b == 4096);
  assert(parseByteCount("0", b, why) && b == 0);                       // parses; the cap rule refuses it
  // Decimal or base-less units are refused, not guessed — and say so.
  for (const char* t : {"20GB", "20G", "20 gb", "5M", "10k", "1TB"}) {
    why.clear();
    b = 7;
    assert(!parseByteCount(t, b, why));
    assert(b == 7);                                                    // out untouched on refusal
    assert(contains(why, "ambiguous"));
  }
  for (const char* t : {"", "   ", "-1", "+5", "1.5GiB", "twenty", "20 GiB extra", "0x10"}) {
    why.clear();
    assert(!parseByteCount(t, b, why));
    assert(!why.empty());
  }
  // 64-bit overflow, in the digits and in the unit multiply.
  why.clear();
  assert(!parseByteCount("18446744073709551616", b, why) && contains(why, "64 bits"));
  why.clear();
  assert(!parseByteCount("16777216TiB", b, why) && contains(why, "64 bits"));
  assert(parseByteCount("18446744073709551615", b, why) && b == UINT64_MAX);

  int p = -1;
  assert(parsePercent("20", p, why) && p == 20);
  assert(parsePercent(" 25% ", p, why) && p == 25);
  assert(parsePercent("0", p, why) && p == 0);
  assert(parsePercent("100", p, why) && p == 100);
  for (const char* t : {"101", "-5", "20.5", "x", "", "%", "1000"}) {
    p = -1;
    why.clear();
    assert(!parsePercent(t, p, why));
    assert(p == -1 && !why.empty());
  }
}

static void test_unset_variables_keep_the_compiled_defaults() {
  // "Nothing changes until a variable is set": the compiled values ARE the
  // defaults, and an unset environment leaves every one of them — and says
  // where each came from.
  RecorderConfig c;
  assert(c.spoolCapBytes == (2ull << 30) && c.reserveMinBytes == (2ull << 30) && c.reservePct == 20);
  const auto refused = applySpoolLimits(c, SpoolLimitText{});
  assert(refused.empty() && c.limitRefusals.empty());
  assert(c.spoolCapBytes == (2ull << 30) && c.reserveMinBytes == (2ull << 30) && c.reservePct == 20);
  assert(c.spoolCapSource == "default" && c.reserveMinSource == "default" && c.reservePctSource == "default");

  // Set and accepted: every value lands, every source says env.
  RecorderConfig e;
  assert(applySpoolLimits(e, {"20GiB", "3GiB", "25"}).empty());
  assert(e.spoolCapBytes == (20ull << 30) && e.reserveMinBytes == (3ull << 30) && e.reservePct == 25);
  assert(e.spoolCapSource == "env" && e.reserveMinSource == "env" && e.reservePctSource == "env");
  // The boundaries are accepted: exactly one segment; exactly 90 %; a zero minimum.
  RecorderConfig edge;
  assert(applySpoolLimits(edge, {std::to_string(edge.segmentBytes), "0", "90"}).empty());
  assert(edge.spoolCapBytes == edge.segmentBytes && edge.reserveMinBytes == 0 && edge.reservePct == 90);
}

static void test_nonsense_values_are_refused_with_a_line_and_the_default_kept() {
  RecorderConfig c;
  const uint64_t below = c.segmentBytes - 1;   // one byte under one segment
  const auto refused = applySpoolLimits(c, {std::to_string(below), "lots", "91"});
  assert(refused.size() == 3 && c.limitRefusals == refused);
  // Every default stays in force...
  assert(c.spoolCapBytes == (2ull << 30) && c.reserveMinBytes == (2ull << 30) && c.reservePct == 20);
  assert(c.spoolCapSource == "refused" && c.reserveMinSource == "refused" && c.reservePctSource == "refused");
  // ...and each line names the variable, what was typed, why, and the default kept.
  assert(contains(refused[0], "TICK_SPOOL_CAP_BYTES=\"" + std::to_string(below) + "\""));
  assert(contains(refused[0], "below one segment") && contains(refused[0], "2147483648 B (2.00 GiB) stays in force"));
  assert(contains(refused[1], "TICK_SPOOL_RESERVE_MIN_BYTES=\"lots\"") && contains(refused[1], "whole number of bytes"));
  assert(contains(refused[2], "TICK_SPOOL_RESERVE_PCT=\"91\"") && contains(refused[2], "over 90%") &&
         contains(refused[2], "the default 20% stays in force"));

  // An ambiguous unit on the cap is refused the same way, never read as GiB.
  RecorderConfig g;
  const auto r2 = applySpoolLimits(g, {"20GB", "", ""});
  assert(r2.size() == 1 && contains(r2[0], "ambiguous") && g.spoolCapBytes == (2ull << 30) && g.spoolCapSource == "refused");
  assert(g.reserveMinSource == "default" && g.reservePctSource == "default");

  // What the operator typed is quoted bounded and printable — a log line
  // cannot be made to carry a control character or a wall of text.
  RecorderConfig q;
  const auto r3 = applySpoolLimits(q, {std::string("9\n9\"") + std::string(60, 'x'), "", ""});
  assert(r3.size() == 1 && contains(r3[0], "=\"9?9?xxx") && contains(r3[0], "...\" refused") && !contains(r3[0], "\n"));
}

static void test_a_cap_from_the_environment_retires_the_oldest_at_that_cap() {
  const Scratch sc;
  RecorderConfig c = smallConfig(sc.spool);
  c.segmentBytes = kHeaderBytes + 10 * kRecordBytes;   // 10 quotes per segment
  c.fsyncEveryMs = 1;
  // The compiled 2 GiB default would keep every one of these small segments;
  // two segments, set through the variable, is what must bind.
  assert(applySpoolLimits(c, {std::to_string(2 * c.segmentBytes), "", ""}).empty());
  assert(c.spoolCapBytes == 2 * c.segmentBytes && c.spoolCapSource == "env");
  TickRecorder rec(c, plenty());
  assert(rec.start());
  rec.setRecording(true);
  for (int i = 0; i < 65; ++i) {
    rec.onQuote(41, true, 100 + i, true, 200 + i, now(), 1);
    if (i % 10 == 9) { rec.flush(); std::this_thread::sleep_for(std::chrono::milliseconds(15)); }
  }
  rec.flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(30));
  const RecorderStats s = rec.stats();
  // Six decades sealed; the cap keeps two, so the four OLDEST were retired.
  assert(s.segmentsSealed == 6);
  assert(s.segmentsRetired == 4);
  const auto sealed = listFiles(sc.spool, ".tks");
  assert(sealed.size() == 2);
  const SegmentRead older = readSegment(sealed[0]);
  const SegmentRead newer = readSegment(sealed[1]);
  assert(older.headerOk && newer.headerOk && older.records.size() == 10 && newer.records.size() == 10);
  assert(older.records.front().bid == 140 && older.records.back().bid == 149);   // quotes 40-49
  assert(newer.records.front().bid == 150 && newer.records.back().bid == 159);   // quotes 50-59
  // Never the open one: it holds the newest five.
  const auto open = listFiles(sc.spool, ".tks.open");
  assert(open.size() == 1);
  const SegmentRead tail = readSegment(open[0]);
  assert(tail.records.size() == 5 && tail.records.front().bid == 160);
  // The status reports the cap that bound, and where it came from.
  auto j = jsn::parse(rec.statusJson());
  assert(j && j->get("segments").get("spoolCapBytes").asNumber(0) == static_cast<double>(2 * c.segmentBytes));
  assert(j->get("limits").get("spoolCapSource").asString() == "env");
  rec.stop();
}

static void test_fit_problems_on_the_owner_volumes() {
  // The owner's numbers (25-09 22:03 SGT): 20 GiB on cpp-exec's 50 GB volume,
  // 5 % used today with the 2 GiB spool on it; 5 GiB on cpp-acct's new 10 GB
  // volume, with order telemetry beside it.
  RecorderConfig exec;
  assert(applySpoolLimits(exec, {"20GiB", "", ""}).empty());
  const uint64_t execTotal = 50'000'000'000ull, execUsed = 2'500'000'000ull;
  assert(spoolFitProblems(exec, execTotal, execTotal - execUsed, 2ull << 30).empty());
  // And on the demo gateway's mount as it was MEASURED (GET /state/tick-recorder,
  // 25-09-2026 14:40 UTC): 48,891,670,528 B, 47,363,852,272 B free, the spool
  // 603,979,856 B sealed + 54,471,584 B open.
  assert(spoolFitProblems(exec, 48'891'670'528ull, 47'363'852'272ull, 603'979'856ull + 54'471'584ull).empty());

  RecorderConfig acct;
  assert(applySpoolLimits(acct, {"5GiB", "", ""}).empty());
  const uint64_t acctTotal = 10'000'000'000ull, telemetry = 50'000'000ull;
  assert(spoolFitProblems(acct, acctTotal, acctTotal - telemetry, 0).empty());

  // 8 GiB on the same 10 GB volume reaches the reserve, the 70 % warning
  // band and the 85 % stop before it could ever retire a segment.
  RecorderConfig big;
  assert(applySpoolLimits(big, {"8GiB", "", ""}).empty());
  const auto p = spoolFitProblems(big, acctTotal, acctTotal - telemetry, 0);
  assert(p.size() == 3);
  assert(contains(p[0], "less than the reserve 2147483648 B") && contains(p[0], "PAUSES"));
  assert(contains(p[1], "70% used") && contains(p[1], "WARN"));
  assert(contains(p[2], "85% used"));
  // The largest cap that fits: the 70 % band binds first — 6,999,999,999 B
  // of room, less 50,000,000 B of telemetry and the open segment at its
  // largest: 64 MiB plus one queue's worth (262,144 records × 40 B), since
  // the writer drains the ring before it checks for a seal.
  const uint64_t openMax = (64ull << 20) + (1ull << 18) * kRecordBytes;
  const uint64_t largest = 6'999'999'999ull - telemetry - openMax;
  assert(largest == 6'872'405'375ull);
  for (const auto& line : p) assert(contains(line, "largest cap that fits this mount now is " + std::to_string(largest) + " B"));
  // ...and it is exact: that cap fits, one byte more does not.
  RecorderConfig atLargest, overLargest;
  assert(applySpoolLimits(atLargest, {std::to_string(largest), "", ""}).empty());
  assert(applySpoolLimits(overLargest, {std::to_string(largest + 1), "", ""}).empty());
  assert(spoolFitProblems(atLargest, acctTotal, acctTotal - telemetry, 0).empty());
  const auto one = spoolFitProblems(overLargest, acctTotal, acctTotal - telemetry, 0);
  assert(one.size() == 1 && contains(one[0], "70% used"));

  // The spool's own bytes are not "other files": the same mount, the same
  // cap, whether today's 2 GiB spool is on it or not.
  assert(spoolFitProblems(exec, execTotal, execTotal - execUsed, 2ull << 30).empty());
  assert(!spoolFitProblems(acct, acctTotal, acctTotal - 5'000'000'000ull, 0).empty());   // 5 GB of OTHER files
  assert(spoolFitProblems(acct, acctTotal, acctTotal - 5'000'000'000ull, 5'000'000'000ull).empty()); // 5 GB of spool

  // A reserve that is the whole mount: the recorder can never write.
  RecorderConfig huge;
  assert(applySpoolLimits(huge, {"", "20GiB", ""}).empty());
  const auto never = spoolFitProblems(huge, acctTotal, acctTotal, 0);
  assert(never.size() == 1 && contains(never[0], "can never write"));
  // An unmeasured mount is unknown, not "fits".
  const auto unknown = spoolFitProblems(exec, 0, 0, 0);
  assert(unknown.size() == 1 && contains(unknown[0], "unknown"));

  // Past 500 whole segments the keeper's listing cannot reach the newest.
  RecorderConfig list;
  assert(!capExceedsListing(list));                                          // 2 GiB = 32 segments
  assert(applySpoolLimits(list, {std::to_string(500 * list.segmentBytes), "", ""}).empty());
  assert(!capExceedsListing(list));                                          // exactly 500: all listed
  assert(applySpoolLimits(list, {std::to_string(501 * list.segmentBytes), "", ""}).empty());
  assert(capExceedsListing(list));
  RecorderConfig twenty;
  assert(applySpoolLimits(twenty, {"20GiB", "", ""}).empty() && !capExceedsListing(twenty));  // 320 segments
}

static void test_status_reports_limits_their_sources_and_the_fit() {
  const Scratch sc;
  RecorderConfig c = smallConfig(sc.spool);
  c.reserveMinBytes = 2ull << 30;
  assert(applySpoolLimits(c, {"20GiB", "", "95"}).size() == 1);
  std::atomic<bool> probeOk{true};
  TickRecorder rec(c, [&probeOk](const std::string&, uint64_t& a, uint64_t& t) {
    if (!probeOk.load()) return false;
    a = 40ull << 30; t = 50ull << 30; return true;
  });
  assert(rec.start());

  // Before the writer has probed the mount: the reserve in bytes and the fit
  // are unknown — null, never a 0 that reads as "no reserve" or a verdict.
  auto j = jsn::parse(rec.statusJson());
  assert(j);
  const jsn::Value& l0 = j->get("limits");
  assert(l0.get("spoolCapBytes").asNumber(0) == static_cast<double>(20ull << 30) && l0.get("spoolCapSource").asString() == "env");
  assert(l0.get("reservePct").asNumber(0) == 20 && l0.get("reservePctSource").asString() == "refused");
  assert(l0.get("reserveMinBytes").asNumber(0) == static_cast<double>(2ull << 30) && l0.get("reserveMinSource").asString() == "default");
  assert(l0.get("reserveBytes").isNull() && l0.get("fitsMount").isNull());
  assert(l0.get("refusedCount").asNumber(-1) == 1);
  assert(l0.get("refusals").asArray().size() == 1 && contains(l0.get("refusals").asArray()[0].asString(), "TICK_SPOOL_RESERVE_PCT=\"95\""));
  assert(l0.get("fitProblems").asArray().empty());
  // The open-route form carries the numbers and the count, not the typed text.
  auto open = jsn::parse(rec.limitsJson(false));
  assert(open && open->get("refusedCount").asNumber(-1) == 1 && open->get("refusals").isNull() && open->get("fitProblems").isNull());
  assert(open->get("spoolCapSource").asString() == "env");

  // After the first write the mount is measured: 20 % of 50 GiB is the reserve,
  // and 20 GiB + one segment on a mount with 10 GiB used fits.
  rec.setRecording(true);
  for (int i = 0; i < 3; ++i) rec.onQuote(41, true, 100 + i, true, 200 + i, now(), 1);
  rec.flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  j = jsn::parse(rec.statusJson());
  const jsn::Value& l1 = j->get("limits");
  assert(l1.get("reserveBytes").asNumber(0) == static_cast<double>(10ull << 30));
  assert(l1.get("fitsMount").isBool() && l1.get("fitsMount").asBool() == true);
  assert(jsn::parse(rec.limitsJson(false))->get("fitsMount").asBool() == true);

  // A failed probe zeroes the free bytes; that is "unknown", not "full".
  probeOk.store(false);
  for (int i = 0; i < 3; ++i) rec.onQuote(41, true, 110 + i, true, 210 + i, now(), 1);
  rec.flush();
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  j = jsn::parse(rec.statusJson());
  assert(j->get("limits").get("fitsMount").isNull());
  assert(j->get("limits").get("reserveBytes").asNumber(0) == static_cast<double>(10ull << 30));   // from the last good probe
  rec.stop();
}

int main() {
  test_format_round_trips_and_detects_corruption();
  test_records_carry_the_raw_observation_and_its_flags();
  test_off_by_default_counts_but_writes_nothing();
  test_a_full_queue_drops_and_marks_a_gap_on_disk();
  test_a_mount_below_its_reserve_pauses_and_the_resume_is_a_gap();
  test_warning_band_is_reported_but_keeps_recording();
  test_segments_seal_by_rename_and_the_cap_retires_the_oldest_sealed_one();
  test_a_second_writer_on_the_same_spool_is_refused();
  test_a_torn_tail_is_quarantined_and_reported_as_a_gap();
  test_switching_off_seals_the_open_segment_with_a_gap();
  test_start_creates_one_level_only_and_survives_a_missing_parent();
  test_spool_limit_values_parse_exactly_and_refuse_ambiguity();
  test_unset_variables_keep_the_compiled_defaults();
  test_nonsense_values_are_refused_with_a_line_and_the_default_kept();
  test_a_cap_from_the_environment_retires_the_oldest_at_that_cap();
  test_fit_problems_on_the_owner_volumes();
  test_status_reports_limits_their_sources_and_the_fit();
  std::puts("test_tick_recorder: all passed");
  return 0;
}
