// cpp-exec/src/tick_recorder.cpp — see tick_recorder.hpp.
#include "tick_recorder.hpp"

#include <dirent.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <cstring>

#include "json.hpp"

namespace tick {

namespace {

uint64_t nowMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

void logLine(const std::string& msg) { std::fprintf(stderr, "[tick-recorder] %s\n", msg.c_str()); }

inline void put16(uint8_t* p, uint16_t v) { p[0] = v & 0xFF; p[1] = (v >> 8) & 0xFF; }
inline void put32(uint8_t* p, uint32_t v) { for (int i = 0; i < 4; ++i) p[i] = (v >> (8 * i)) & 0xFF; }
inline void put64(uint8_t* p, uint64_t v) { for (int i = 0; i < 8; ++i) p[i] = (v >> (8 * i)) & 0xFF; }
inline uint16_t get16(const uint8_t* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }
inline uint32_t get32(const uint8_t* p) { uint32_t v = 0; for (int i = 3; i >= 0; --i) v = (v << 8) | p[i]; return v; }
inline uint64_t get64(const uint8_t* p) { uint64_t v = 0; for (int i = 7; i >= 0; --i) v = (v << 8) | p[i]; return v; }

const uint32_t* crcTable() {
  static uint32_t table[256];
  static bool built = false;
  if (!built) {
    for (uint32_t i = 0; i < 256; ++i) {
      uint32_t c = i;
      for (int k = 0; k < 8; ++k) c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
      table[i] = c;
    }
    built = true;
  }
  return table;
}

bool endsWith(const std::string& s, const std::string& suffix) {
  return s.size() >= suffix.size() && s.compare(s.size() - suffix.size(), suffix.size(), suffix) == 0;
}
bool startsWith(const std::string& s, const std::string& prefix) { return s.rfind(prefix, 0) == 0; }

uint64_t fileSize(const std::string& path) {
  struct stat sb{};
  return ::stat(path.c_str(), &sb) == 0 ? static_cast<uint64_t>(sb.st_size) : 0;
}

void fsyncDir(const std::string& dir) {
  int fd = ::open(dir.c_str(), O_RDONLY);
  if (fd >= 0) { ::fsync(fd); ::close(fd); }
}

} // namespace

uint32_t crc32(const uint8_t* data, size_t len, uint32_t seed) {
  const uint32_t* t = crcTable();
  uint32_t c = seed ^ 0xFFFFFFFFu;
  for (size_t i = 0; i < len; ++i) c = t[(c ^ data[i]) & 0xFF] ^ (c >> 8);
  return c ^ 0xFFFFFFFFu;
}

void encodeRecord(const Record& r, uint8_t out[kRecordBytes]) {
  std::memset(out, 0, kRecordBytes);
  put64(out + 0, r.recvMs);
  put32(out + 8, r.seq);
  put32(out + 12, r.symbolId);
  put64(out + 16, static_cast<uint64_t>(r.bid));
  put64(out + 24, static_cast<uint64_t>(r.ask));
  out[32] = r.flags;
  out[33] = r.kind;
  put16(out + 34, r.generation);
  put32(out + 36, crc32(out, 36));
}

bool decodeRecord(const uint8_t in[kRecordBytes], Record& out) {
  if (crc32(in, 36) != get32(in + 36)) return false;
  out.recvMs = get64(in + 0);
  out.seq = get32(in + 8);
  out.symbolId = get32(in + 12);
  out.bid = static_cast<int64_t>(get64(in + 16));
  out.ask = static_cast<int64_t>(get64(in + 24));
  out.flags = in[32];
  out.kind = in[33];
  out.generation = get16(in + 34);
  return true;
}

void encodeHeader(const SegmentHeader& h, uint8_t out[kHeaderBytes]) {
  std::memset(out, 0, kHeaderBytes);
  std::memcpy(out, "TKSG", 4);
  put16(out + 4, kFormatVersion);
  put16(out + 6, static_cast<uint16_t>(kHeaderBytes));
  out[8] = h.environment;
  put32(out + 12, h.generation);
  put64(out + 16, h.startedMs);
  std::memcpy(out + 24, h.feedId.data(), std::min<size_t>(h.feedId.size(), 36));
  put32(out + 60, crc32(out, 60));
}

bool decodeHeader(const uint8_t in[kHeaderBytes], SegmentHeader& out) {
  if (std::memcmp(in, "TKSG", 4) != 0) return false;
  if (get16(in + 4) != kFormatVersion || get16(in + 6) != kHeaderBytes) return false;
  if (crc32(in, 60) != get32(in + 60)) return false;
  out.environment = in[8];
  out.generation = get32(in + 12);
  out.startedMs = get64(in + 16);
  const char* f = reinterpret_cast<const char*>(in + 24);
  out.feedId.assign(f, strnlen(f, 36));
  return true;
}

SegmentRead readSegment(const std::string& path) {
  SegmentRead r;
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) { r.truncated = true; return r; }
  uint8_t hdr[kHeaderBytes];
  if (std::fread(hdr, 1, kHeaderBytes, f) != kHeaderBytes || !decodeHeader(hdr, r.header)) {
    r.truncated = true;
    std::fclose(f);
    return r;
  }
  r.headerOk = true;
  uint8_t rec[kRecordBytes];
  for (;;) {
    const size_t n = std::fread(rec, 1, kRecordBytes, f);
    if (n == 0) break;
    if (n != kRecordBytes) { r.truncated = true; break; }
    Record d;
    if (!decodeRecord(rec, d)) { r.truncated = true; break; }
    r.records.push_back(d);
  }
  std::fclose(f);
  return r;
}

bool statvfsProbe(const std::string& dir, uint64_t& availBytes, uint64_t& totalBytes) {
  struct statvfs sv{};
  if (::statvfs(dir.c_str(), &sv) != 0) return false;
  availBytes = static_cast<uint64_t>(sv.f_bavail) * sv.f_frsize;
  totalBytes = static_cast<uint64_t>(sv.f_blocks) * sv.f_frsize;
  return true;
}

// ---------------------------------------------------------------------------

TickRecorder::TickRecorder(RecorderConfig cfg, FreeSpaceProbe probe)
    : cfg_(std::move(cfg)), probe_(probe ? std::move(probe) : FreeSpaceProbe(statvfsProbe)),
      ring_(cfg_.queueRecords) {
  buf_.reserve(64 * 1024);
  st_.state = "OFF";
}

TickRecorder::~TickRecorder() { stop(); }

bool TickRecorder::start() {
  if (started_.load()) return true;
  auto fail = [this](const std::string& why) {
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.state = "ERROR";
    st_.reason = why;
    logLine("cannot start: " + why);
    return false;
  };
  if (cfg_.spoolDir.empty()) return fail("no spool directory");
  if (::mkdir(cfg_.spoolDir.c_str(), 0755) != 0 && errno != EEXIST)
    return fail("mkdir " + cfg_.spoolDir + " failed: " + std::strerror(errno));
  struct stat sb{};
  if (::stat(cfg_.spoolDir.c_str(), &sb) != 0 || !S_ISDIR(sb.st_mode))
    return fail(cfg_.spoolDir + " is not a directory");
  // One writer per spool (TM-31): a second process on the same mount would
  // interleave segments and race the retention.
  const std::string lockPath = cfg_.spoolDir + "/.recorder.lock";
  lockFd_ = ::open(lockPath.c_str(), O_CREAT | O_RDWR | O_CLOEXEC, 0644);
  if (lockFd_ < 0) return fail("cannot open lock file: " + std::string(std::strerror(errno)));
  if (::flock(lockFd_, LOCK_EX | LOCK_NB) != 0) {
    ::close(lockFd_);
    lockFd_ = -1;
    return fail("spool locked by another writer");
  }
  // A torn tail from a crash is quarantined, never appended to: its complete
  // records are still readable (readSegment stops at the first bad one) and
  // the gap is recorded in the first new segment.
  uint64_t torn = 0;
  if (DIR* d = ::opendir(cfg_.spoolDir.c_str())) {
    while (dirent* e = ::readdir(d)) {
      const std::string name = e->d_name;
      if (startsWith(name, "seg-") && endsWith(name, ".tks.open")) {
        const std::string from = cfg_.spoolDir + "/" + name;
        const std::string to = from.substr(0, from.size() - 5) + ".torn";
        if (::rename(from.c_str(), to.c_str()) == 0) ++torn;
      }
    }
    ::closedir(d);
  }
  {
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.tornAtStart = torn;
    st_.state = "OFF";
    st_.reason.clear();
  }
  if (torn > 0) noteGap(GAP_RESTART, torn);
  retire();
  stop_.store(false);
  started_.store(true);
  writer_ = std::thread([this] { writerLoop(); });
  return true;
}

void TickRecorder::stop() {
  if (!started_.load()) return;
  stop_.store(true);
  if (writer_.joinable()) writer_.join();
  if (lockFd_ >= 0) { ::close(lockFd_); lockFd_ = -1; }
  started_.store(false);
  std::lock_guard<std::mutex> lk(statsMtx_);
  st_.state = "STOPPED";
}

void TickRecorder::setRecording(bool on) { recording_.store(on); }

void TickRecorder::noteGap(GapReason reason, uint64_t count) {
  // Gaps are queued through the same ring as quotes so they land in order;
  // a full ring here is itself an overflow, counted like any other drop.
  Record g;
  g.recvMs = nowMs();
  g.seq = ++seq_;
  g.kind = GAP;
  g.bid = static_cast<int64_t>(count);
  g.ask = static_cast<int64_t>(reason);
  g.generation = static_cast<uint16_t>(generation_ & 0xFFFF);
  if (!ring_.push(g)) { dropped_.fetch_add(1); pendingOverflow_.fetch_add(1); }
}

void TickRecorder::onQuote(long long symbolId, bool hasBid, long long bid, bool hasAsk, long long ask,
                           uint64_t recvMs, uint32_t generation) {
  events_.fetch_add(1, std::memory_order_relaxed);
  if (generation != generation_) {
    // A (re)subscribe: the first event per symbol after it is a snapshot, and
    // the discontinuity is on disk as a gap IN ORDER — pushed through the
    // same ring, ahead of the new generation's first quote.
    const bool reconnect = generation_ != 0;
    generation_ = generation;
    for (auto& kv : last_) kv.second.snapshotPending = true;
    if (reconnect && recording_.load(std::memory_order_relaxed)) noteGap(GAP_RECONNECT, 1);
  }
  SymbolState& s = last_[symbolId];
  Record r;
  r.recvMs = recvMs;
  r.seq = ++seq_;
  r.symbolId = static_cast<uint32_t>(symbolId);
  r.generation = static_cast<uint16_t>(generation & 0xFFFF);
  bool changed = false;
  if (hasBid) {
    r.flags |= BID_PRESENT;
    r.bid = bid;
    if (s.bid != bid) { r.flags |= BID_CHANGED; changed = true; }
    s.bid = bid;
  }
  if (hasAsk) {
    r.flags |= ASK_PRESENT;
    r.ask = ask;
    if (s.ask != ask) { r.flags |= ASK_CHANGED; changed = true; }
    s.ask = ask;
  }
  bool snapshot = false;
  if (s.snapshotPending) { r.flags |= SNAPSHOT; s.snapshotPending = false; snapshot = true; snapshots_.fetch_add(1); }
  if (!changed && !snapshot) { r.flags |= REPEAT; repeats_.fetch_add(1); }
  else if (changed && !snapshot) changed_.fetch_add(1);
  if (s.bid != kAbsent && s.ask != kAbsent && s.bid > s.ask) { r.flags |= CROSSED; crossed_.fetch_add(1); }
  {
    std::lock_guard<std::mutex> lk(symMtx_);
    SymbolStat& ss = sym_[symbolId];
    ss.events++;
    if (snapshot) ss.snapshots++;
    else if (changed) ss.changed++;
    else ss.repeats++;
    ss.lastRecvMs = recvMs;
    if (ss.windowStartMs == 0 || recvMs - ss.windowStartMs >= 10000) { ss.windowStartMs = recvMs; ss.windowEvents = 0; }
    ss.windowEvents++;
  }
  if (!recording_.load(std::memory_order_relaxed)) { skippedOff_.fetch_add(1); return; }
  if (!ring_.push(r)) { dropped_.fetch_add(1); pendingOverflow_.fetch_add(1); }
}

bool TickRecorder::budgetAllows(uint64_t nextWriteBytes, uint64_t now) {
  uint64_t avail = 0, total = 0;
  bool probed = false;
  if (now - lastBudgetMs_ >= static_cast<uint64_t>(cfg_.budgetCheckEveryMs) || lastBudgetMs_ == 0) {
    probed = probe_(cfg_.spoolDir, avail, total);
    lastBudgetMs_ = now;
    std::lock_guard<std::mutex> lk(statsMtx_);
    if (probed) {
      st_.diskAvailBytes = avail;
      st_.diskTotalBytes = total;
      st_.reserveBytes = std::max<uint64_t>(cfg_.reserveMinBytes, total / 100 * static_cast<uint64_t>(cfg_.reservePct));
      st_.usagePct = total > 0 ? static_cast<int>(((total - std::min(avail, total)) * 100) / total) : -1;
    } else {
      st_.diskAvailBytes = 0;
      st_.usagePct = -1;
    }
  }
  uint64_t reserve, usagePct;
  {
    std::lock_guard<std::mutex> lk(statsMtx_);
    avail = st_.diskAvailBytes;
    reserve = st_.reserveBytes;
    usagePct = st_.usagePct < 0 ? 100 : static_cast<uint64_t>(st_.usagePct);
  }
  // The bytes written since the last probe are already gone from the mount;
  // charge them so a burst inside the probe interval cannot eat the reserve.
  const bool ok = avail >= reserve + nextWriteBytes && usagePct < static_cast<uint64_t>(cfg_.stopPct);
  if (ok) {
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.diskAvailBytes = avail - nextWriteBytes;
  }
  return ok;
}

void TickRecorder::scanSpool(uint64_t& sealedBytes, std::vector<std::pair<std::string, uint64_t>>& sealed) const {
  sealedBytes = 0;
  sealed.clear();
  DIR* d = ::opendir(cfg_.spoolDir.c_str());
  if (!d) return;
  while (dirent* e = ::readdir(d)) {
    const std::string name = e->d_name;
    if (!startsWith(name, "seg-") || !endsWith(name, ".tks")) continue;
    const std::string path = cfg_.spoolDir + "/" + name;
    const uint64_t size = fileSize(path);
    sealedBytes += size;
    sealed.emplace_back(path, size);
  }
  ::closedir(d);
  std::sort(sealed.begin(), sealed.end()); // seg-<zero-padded startMs>-<index>: oldest first
}

void TickRecorder::retire() {
  uint64_t sealedBytes = 0;
  std::vector<std::pair<std::string, uint64_t>> sealed;
  scanSpool(sealedBytes, sealed);
  uint64_t retired = 0;
  // Only sealed segments this recorder's naming pattern owns; never the open
  // one, never a torn one (an operator may still want it), never anything
  // else on the mount.
  for (const auto& [path, size] : sealed) {
    if (sealedBytes + openBytes_ <= cfg_.spoolCapBytes) break;
    if (::unlink(path.c_str()) == 0) { sealedBytes -= size; ++retired; }
  }
  std::lock_guard<std::mutex> lk(statsMtx_);
  st_.sealedBytes = sealedBytes;
  st_.segmentsRetired += retired;
}

bool TickRecorder::openSegment(uint64_t now) {
  retire(); // make room under the cap before adding to it
  if (!budgetAllows(cfg_.segmentBytes, now)) return false;
  char name[96];
  static uint32_t index = 0;
  std::snprintf(name, sizeof name, "/seg-%013llu-%06u.tks", static_cast<unsigned long long>(now), ++index);
  sealedPath_ = cfg_.spoolDir + name;
  openPath_ = sealedPath_ + ".open";
  out_ = std::fopen(openPath_.c_str(), "wb");
  if (!out_) {
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.writeErrors++;
    st_.reason = "cannot open segment: " + std::string(std::strerror(errno));
    return false;
  }
  SegmentHeader h;
  h.environment = cfg_.environment;
  h.generation = generation_;
  h.startedMs = now;
  h.feedId = cfg_.feedId;
  uint8_t hdr[kHeaderBytes];
  encodeHeader(h, hdr);
  if (std::fwrite(hdr, 1, kHeaderBytes, out_) != kHeaderBytes) {
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.writeErrors++;
  }
  openBytes_ = kHeaderBytes;
  lastFsyncMs_ = now;
  return true;
}

void TickRecorder::sealSegment(bool finalSeal) {
  if (!out_) return;
  if (!buf_.empty()) {
    if (std::fwrite(buf_.data(), 1, buf_.size(), out_) != buf_.size()) { std::lock_guard<std::mutex> lk(statsMtx_); st_.writeErrors++; }
    buf_.clear();
  }
  std::fflush(out_);
  ::fsync(fileno(out_));
  std::fclose(out_);
  out_ = nullptr;
  // The atomic rename is what makes a segment "sealed": a reader never sees
  // a half-written .tks, and a crash leaves a .open that start() quarantines.
  if (::rename(openPath_.c_str(), sealedPath_.c_str()) == 0) fsyncDir(cfg_.spoolDir);
  {
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.segmentsSealed++;
    st_.openBytes = 0;
  }
  openBytes_ = 0;
  retire();
  (void)finalSeal;
}

bool TickRecorder::writeRecord(const Record& r) {
  const uint64_t now = nowMs();
  if (!out_ && !openSegment(now)) {
    if (!paused_) { paused_ = true; std::lock_guard<std::mutex> lk(statsMtx_); st_.state = "PAUSED_RESERVE"; }
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.pausedDrops++;
    return false;
  }
  if (!budgetAllows(kRecordBytes, now)) {
    if (!paused_) { paused_ = true; std::lock_guard<std::mutex> lk(statsMtx_); st_.state = "PAUSED_RESERVE"; }
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.pausedDrops++;
    return false;
  }
  if (paused_) {
    // Space came back: the records refused meanwhile are a gap on disk.
    paused_ = false;
    uint64_t refused;
    { std::lock_guard<std::mutex> lk(statsMtx_); refused = st_.pausedDrops; st_.state = "RECORDING"; }
    Record g;
    g.recvMs = now;
    g.seq = r.seq;
    g.kind = GAP;
    g.bid = static_cast<int64_t>(refused);
    g.ask = GAP_RESERVE_PAUSE;
    g.generation = r.generation;
    uint8_t gb[kRecordBytes];
    encodeRecord(g, gb);
    buf_.insert(buf_.end(), gb, gb + kRecordBytes);
    openBytes_ += kRecordBytes;
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.gaps++;
    st_.recordsWritten++;
    st_.bytesWritten += kRecordBytes;
  }
  uint8_t bytes[kRecordBytes];
  encodeRecord(r, bytes);
  buf_.insert(buf_.end(), bytes, bytes + kRecordBytes);
  openBytes_ += kRecordBytes;
  {
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.recordsWritten++;
    st_.bytesWritten += kRecordBytes;
    st_.openBytes = openBytes_;
    if (r.kind == GAP) st_.gaps++;
  }
  if (buf_.size() >= 32 * 1024) {
    if (std::fwrite(buf_.data(), 1, buf_.size(), out_) != buf_.size()) { std::lock_guard<std::mutex> lk(statsMtx_); st_.writeErrors++; }
    buf_.clear();
  }
  return true;
}

void TickRecorder::writerLoop() {
  for (;;) {
    bool didWork = false;
    // A process stop is not the keeper's switch: the loop below drains,
    // seals and exits with no gap record; only the switch writes one.
    const bool rec = recording_.load();
    if (rec != wasRecording_) {
      if (!rec && out_) {
        Record g;
        g.recvMs = nowMs();
        g.kind = GAP;
        g.bid = 0;
        g.ask = GAP_SWITCHED_OFF;
        g.generation = static_cast<uint16_t>(generation_ & 0xFFFF);
        writeRecord(g);
        sealSegment(true);
      }
      wasRecording_ = rec;
      std::lock_guard<std::mutex> lk(statsMtx_);
      if (rec && !paused_) st_.state = "RECORDING";
      if (!rec && !stop_.load()) st_.state = "OFF";
    }
    if (rec) {
      if (const uint64_t n = pendingOverflow_.exchange(0)) {
        Record g; g.recvMs = nowMs(); g.kind = GAP; g.bid = static_cast<int64_t>(n); g.ask = GAP_QUEUE_OVERFLOW;
        g.generation = static_cast<uint16_t>(generation_ & 0xFFFF);
        writeRecord(g);
      }
      while (auto r = ring_.pop()) { didWork = true; writeRecord(*r); }
    } else {
      // Switched off with records in flight: they were seen, not recorded.
      while (ring_.pop()) { didWork = true; skippedOff_.fetch_add(1); }
    }
    if (out_) {
      const uint64_t now = nowMs();
      if (!buf_.empty()) {
        if (std::fwrite(buf_.data(), 1, buf_.size(), out_) != buf_.size()) { std::lock_guard<std::mutex> lk(statsMtx_); st_.writeErrors++; }
        buf_.clear();
        if (std::fflush(out_) != 0) { std::lock_guard<std::mutex> lk(statsMtx_); st_.writeErrors++; }
      }
      if (now - lastFsyncMs_ >= static_cast<uint64_t>(cfg_.fsyncEveryMs)) { ::fsync(fileno(out_)); lastFsyncMs_ = now; }
      if (openBytes_ >= cfg_.segmentBytes) sealSegment(false);
    }
    {
      std::lock_guard<std::mutex> lk(statsMtx_);
      if (rec && !paused_ && st_.usagePct >= cfg_.warnPct && st_.usagePct >= 0) st_.state = "WARN";
      else if (rec && !paused_ && st_.state == "WARN") st_.state = "RECORDING";
    }
    if (flushRequested_.load() && ring_.empty()) flushRequested_.store(false);
    if (stop_.load() && ring_.empty()) break;
    if (!didWork) std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  sealSegment(true);
}

void TickRecorder::flush() {
  flushRequested_.store(true);
  while (flushRequested_.load() && started_.load()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
}

RecorderStats TickRecorder::stats() const {
  RecorderStats s;
  { std::lock_guard<std::mutex> lk(statsMtx_); s = st_; }
  s.enabled = true;
  s.recording = recording_.load();
  s.generation = generation_;
  s.seq = seq_;
  s.events = events_.load();
  s.changed = changed_.load();
  s.repeats = repeats_.load();
  s.snapshots = snapshots_.load();
  s.crossed = crossed_.load();
  s.dropped = dropped_.load();
  s.skippedOff = skippedOff_.load();
  if (!started_.load() && s.state != "ERROR") s.state = "STOPPED";
  { std::lock_guard<std::mutex> lk(symMtx_); s.perSymbol = sym_; }
  return s;
}

std::string TickRecorder::statusJson() const {
  const RecorderStats s = stats();
  const uint64_t now = nowMs();
  jsn::Value v{jsn::Object{}};
  v.set("enabled", true);
  v.set("recording", s.recording);
  v.set("state", s.state);
  v.set("reason", s.reason);
  v.set("spoolDir", cfg_.spoolDir);
  v.set("feedId", cfg_.feedId);
  v.set("generation", static_cast<double>(s.generation));
  v.set("seq", static_cast<double>(s.seq));
  jsn::Value ev{jsn::Object{}};
  ev.set("total", static_cast<double>(s.events));
  ev.set("changed", static_cast<double>(s.changed));
  ev.set("repeats", static_cast<double>(s.repeats));
  ev.set("snapshots", static_cast<double>(s.snapshots));
  ev.set("crossed", static_cast<double>(s.crossed));
  ev.set("dropped", static_cast<double>(s.dropped));
  ev.set("pausedDrops", static_cast<double>(s.pausedDrops));
  ev.set("skippedOff", static_cast<double>(s.skippedOff));
  ev.set("gaps", static_cast<double>(s.gaps));
  v.set("events", std::move(ev));
  jsn::Value seg{jsn::Object{}};
  seg.set("recordsWritten", static_cast<double>(s.recordsWritten));
  seg.set("bytesWritten", static_cast<double>(s.bytesWritten));
  seg.set("sealed", static_cast<double>(s.segmentsSealed));
  seg.set("sealedBytes", static_cast<double>(s.sealedBytes));
  seg.set("openBytes", static_cast<double>(s.openBytes));
  seg.set("retired", static_cast<double>(s.segmentsRetired));
  seg.set("tornAtStart", static_cast<double>(s.tornAtStart));
  seg.set("segmentBytes", static_cast<double>(cfg_.segmentBytes));
  seg.set("spoolCapBytes", static_cast<double>(cfg_.spoolCapBytes));
  seg.set("writeErrors", static_cast<double>(s.writeErrors));
  v.set("segments", std::move(seg));
  jsn::Value disk{jsn::Object{}};
  disk.set("totalBytes", static_cast<double>(s.diskTotalBytes));
  disk.set("availBytes", static_cast<double>(s.diskAvailBytes));
  disk.set("reserveBytes", static_cast<double>(s.reserveBytes));
  disk.set("usagePct", static_cast<double>(s.usagePct));
  disk.set("warnPct", static_cast<double>(cfg_.warnPct));
  disk.set("stopPct", static_cast<double>(cfg_.stopPct));
  v.set("disk", std::move(disk));
  jsn::Value q{jsn::Object{}};
  q.set("capacityRecords", static_cast<double>(ring_.capacity()));
  q.set("recordBytes", static_cast<double>(kRecordBytes));
  v.set("queue", std::move(q));
  jsn::Array per;
  for (const auto& kv : s.perSymbol) {
    jsn::Value p{jsn::Object{}};
    p.set("symbolId", static_cast<double>(kv.first));
    p.set("events", static_cast<double>(kv.second.events));
    p.set("changed", static_cast<double>(kv.second.changed));
    p.set("repeats", static_cast<double>(kv.second.repeats));
    p.set("lastRecvMs", static_cast<double>(kv.second.lastRecvMs));
    const uint64_t span = kv.second.windowStartMs > 0 && now > kv.second.windowStartMs ? now - kv.second.windowStartMs : 0;
    p.set("eventsPerSec", span >= 1000 ? static_cast<double>(kv.second.windowEvents) * 1000.0 / static_cast<double>(span)
                                       : static_cast<double>(kv.second.windowEvents));
    per.push_back(std::move(p));
  }
  v.set("perSymbol", jsn::Value(std::move(per)));
  return jsn::dump(v);
}

} // namespace tick
