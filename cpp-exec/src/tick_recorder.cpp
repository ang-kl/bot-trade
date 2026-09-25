// cpp-exec/src/tick_recorder.cpp — see tick_recorder.hpp.
#include "tick_recorder.hpp"

#include <dirent.h>
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

#include <limits.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "json.hpp"
#include "log.hpp"

namespace tick {

namespace {

uint64_t nowMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

void logError(const std::string& msg) { sidecar_log::logError("[tick-recorder]", msg); }

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

// ---- PR-I: the sealed-segment read path (see tick_recorder.hpp) -----------

bool isSealedSegmentName(const std::string& name) {
  // Anchored full match on `seg-[0-9]{13}-[0-9]{6}\.tks`: 4 + 13 + 1 + 6 + 4.
  // The length check is what anchors the TAIL — it is why ".tks.open" and
  // "seg-…tks/../../etc/passwd" cannot match — so it is not redundant with
  // the prefix and suffix compares below.
  constexpr size_t kNameLen = 4 + 13 + 1 + 6 + 4;
  if (name.size() != kNameLen) return false;
  if (!startsWith(name, "seg-") || !endsWith(name, ".tks")) return false;
  for (size_t i = 4; i < 4 + 13; ++i) if (name[i] < '0' || name[i] > '9') return false;
  if (name[17] != '-') return false;
  for (size_t i = 18; i < 18 + 6; ++i) if (name[i] < '0' || name[i] > '9') return false;
  return true;
}

SegmentList listSealedSegments(const std::string& dir, size_t maxEntries) {
  SegmentList out;
  DIR* d = ::opendir(dir.c_str());
  if (!d) return out;
  while (dirent* e = ::readdir(d)) {
    const std::string name = e->d_name;
    const std::string path = dir + "/" + name;
    struct stat sb{};
    // lstat, NOT stat (checker m-2): stat FOLLOWS a symlink, so a link named
    // seg-<13>-<6>.tks pointing at /etc/passwd was listed with the TARGET's
    // size — telling an authenticated caller the size of a file outside the
    // spool, and giving every sync a permanently failing entry it can never
    // fetch (the read path refuses it). A link is not a regular file, so
    // S_ISREG on the lstat result drops it here instead.
    if (::lstat(path.c_str(), &sb) != 0 || !S_ISREG(sb.st_mode)) continue;
    if (startsWith(name, "seg-") && endsWith(name, ".tks.open")) {
      // Reported so the keeper can see the tail exists; NEVER listed as a
      // segment and never downloadable — isSealedSegmentName refuses it.
      out.openBytes += static_cast<uint64_t>(sb.st_size);
      continue;
    }
    if (!isSealedSegmentName(name)) continue;
    SegmentEntry se;
    se.name = name;
    se.bytes = static_cast<uint64_t>(sb.st_size);
    // Second resolution (st_mtime is portable; st_mtim/st_mtimespec are not).
    se.sealedAtMs = static_cast<uint64_t>(sb.st_mtime) * 1000ull;
    se.index = static_cast<uint32_t>(std::strtoul(name.substr(18, 6).c_str(), nullptr, 10));
    out.segments.push_back(std::move(se));
  }
  ::closedir(d);
  // The name's startMs is zero-padded to 13 digits and the index to 6, so a
  // plain name sort IS oldest-first (the same property retire() relies on).
  std::sort(out.segments.begin(), out.segments.end(),
            [](const SegmentEntry& a, const SegmentEntry& b) { return a.name < b.name; });
  if (out.segments.size() > maxEntries) {
    out.segments.resize(maxEntries);
    out.truncated = true;
  }
  return out;
}

SegmentChunk readSegmentChunk(const std::string& dir, const std::string& name, uint64_t offset, uint64_t len) {
  SegmentChunk c;
  c.offset = offset;
  if (!isSealedSegmentName(name)) { c.status = ChunkStatus::BAD_NAME; return c; }
  const std::string path = dir + "/" + name;
  // Open first, THEN resolve and stat through the fd we hold: a file retired
  // between the listing and this call fails the open and answers NOT_FOUND,
  // and one retired after it still reads its real bytes (the inode outlives
  // the unlink) rather than a short read presented as the whole file.
  const int fd = ::open(path.c_str(), O_RDONLY | O_CLOEXEC);
  if (fd < 0) { c.status = ChunkStatus::NOT_FOUND; return c; }
  // Belt on the name pattern: a SYMLINK inside the spool whose name matches
  // could still point outside it. The resolved path must be the spool's own
  // resolved directory plus this name.
  {
    char realDir[PATH_MAX], realFile[PATH_MAX];
    if (!::realpath(dir.c_str(), realDir) || !::realpath(path.c_str(), realFile) ||
        std::string(realFile) != std::string(realDir) + "/" + name) {
      ::close(fd);
      c.status = ChunkStatus::BAD_NAME;
      return c;
    }
  }
  struct stat sb{};
  if (::fstat(fd, &sb) != 0 || !S_ISREG(sb.st_mode)) { ::close(fd); c.status = ChunkStatus::NOT_FOUND; return c; }
  // A HARDLINK defeats realpath (checker m-1): a hardlink has no target to
  // resolve, so `realpath` returns the link's own path — inside the spool —
  // while the inode is a file from anywhere on the same filesystem. A
  // segment this recorder wrote always has exactly ONE link (it is created
  // by fopen and renamed once; nothing ever links it), so a link count above
  // one means the name was planted, not sealed here.
  if (sb.st_nlink != 1) { ::close(fd); c.status = ChunkStatus::BAD_NAME; return c; }
  c.totalBytes = static_cast<uint64_t>(sb.st_size);
  if (offset >= c.totalBytes) { ::close(fd); c.eof = true; return c; }
  uint64_t want = std::min<uint64_t>(len, kMaxChunkBytes);
  want = std::min<uint64_t>(want, c.totalBytes - offset);
  c.bytes.resize(static_cast<size_t>(want));
  uint64_t got = 0;
  while (got < want) {
    // pread: no shared file offset, so nothing here contends with anything —
    // and sealed files are immutable (see the header), so no lock is needed.
    const ssize_t n = ::pread(fd, &c.bytes[static_cast<size_t>(got)], static_cast<size_t>(want - got),
                              static_cast<off_t>(offset + got));
    if (n <= 0) break;
    got += static_cast<uint64_t>(n);
  }
  ::close(fd);
  c.bytes.resize(static_cast<size_t>(got));
  c.eof = offset + got >= c.totalBytes;
  return c;
}

std::string base64Encode(const std::string& raw) {
  static const char* kAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string out;
  out.reserve((raw.size() + 2) / 3 * 4);
  size_t i = 0;
  for (; i + 2 < raw.size(); i += 3) {
    const uint32_t v = (static_cast<uint8_t>(raw[i]) << 16) | (static_cast<uint8_t>(raw[i + 1]) << 8) |
                       static_cast<uint8_t>(raw[i + 2]);
    out += kAlphabet[(v >> 18) & 63];
    out += kAlphabet[(v >> 12) & 63];
    out += kAlphabet[(v >> 6) & 63];
    out += kAlphabet[v & 63];
  }
  if (i + 1 == raw.size()) {
    const uint32_t v = static_cast<uint8_t>(raw[i]) << 16;
    out += kAlphabet[(v >> 18) & 63];
    out += kAlphabet[(v >> 12) & 63];
    out += "==";
  } else if (i + 2 == raw.size()) {
    const uint32_t v = (static_cast<uint8_t>(raw[i]) << 16) | (static_cast<uint8_t>(raw[i + 1]) << 8);
    out += kAlphabet[(v >> 18) & 63];
    out += kAlphabet[(v >> 12) & 63];
    out += kAlphabet[(v >> 6) & 63];
    out += '=';
  }
  return out;
}

// ---------------------------------------------------------------------------

bool statvfsProbe(const std::string& dir, uint64_t& availBytes, uint64_t& totalBytes) {
  struct statvfs sv{};
  if (::statvfs(dir.c_str(), &sv) != 0) return false;
  availBytes = static_cast<uint64_t>(sv.f_bavail) * sv.f_frsize;
  totalBytes = static_cast<uint64_t>(sv.f_blocks) * sv.f_frsize;
  return true;
}

// ---------------------------------------------------------------------------
// GW-CAP: the spool limits from the environment (see the header).

namespace {

std::string trimmed(const std::string& s) {
  size_t b = 0, e = s.size();
  while (b < e && std::isspace(static_cast<unsigned char>(s[b]))) ++b;
  while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1]))) --e;
  return s.substr(b, e - b);
}

std::string lowered(std::string s) {
  for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return s;
}

// What the operator typed, for a log line: bounded and printable only.
std::string quoted(const std::string& s) {
  std::string out = "\"";
  for (size_t i = 0; i < s.size() && i < 40; ++i) {
    const unsigned char c = static_cast<unsigned char>(s[i]);
    out += (c >= 0x20 && c < 0x7F && c != '"') ? static_cast<char>(c) : '?';
  }
  if (s.size() > 40) out += "...";
  return out + "\"";
}

uint64_t saturatingAdd(uint64_t a, uint64_t b) { return a > UINT64_MAX - b ? UINT64_MAX : a + b; }

// The largest `used` byte count whose integer usage percent stays BELOW
// `pct` on a mount of `total` — the same floor(used * 100 / total) the
// budget computes: floor(x) < pct  <=>  used * 100 < pct * total.
uint64_t roomBelowPct(uint64_t total, int pct) {
  const unsigned __int128 limit = static_cast<unsigned __int128>(total) * static_cast<unsigned __int128>(pct);
  if (limit == 0) return 0;
  return static_cast<uint64_t>((limit - 1) / 100);
}

} // namespace

std::string describeBytes(uint64_t bytes) {
  char buf[96];
  const double b = static_cast<double>(bytes);
  if (bytes >= (1ull << 30)) std::snprintf(buf, sizeof buf, "%llu B (%.2f GiB)", static_cast<unsigned long long>(bytes), b / 1073741824.0);
  else if (bytes >= (1ull << 20)) std::snprintf(buf, sizeof buf, "%llu B (%.2f MiB)", static_cast<unsigned long long>(bytes), b / 1048576.0);
  else std::snprintf(buf, sizeof buf, "%llu B", static_cast<unsigned long long>(bytes));
  return buf;
}

bool parseByteCount(const std::string& text, uint64_t& out, std::string& why) {
  const std::string t = trimmed(text);
  size_t i = 0;
  uint64_t n = 0;
  while (i < t.size() && t[i] >= '0' && t[i] <= '9') {
    const uint64_t d = static_cast<uint64_t>(t[i] - '0');
    if (n > (UINT64_MAX - d) / 10) { why = "too large for 64 bits"; return false; }
    n = n * 10 + d;
    ++i;
  }
  if (i == 0) { why = "expected a whole number of bytes, optionally with KiB, MiB, GiB or TiB"; return false; }
  while (i < t.size() && t[i] == ' ') ++i;
  const std::string unit = lowered(t.substr(i));
  uint64_t mul = 0;
  if (unit.empty() || unit == "b") mul = 1;
  else if (unit == "kib") mul = 1ull << 10;
  else if (unit == "mib") mul = 1ull << 20;
  else if (unit == "gib") mul = 1ull << 30;
  else if (unit == "tib") mul = 1ull << 40;
  else if (unit == "k" || unit == "kb" || unit == "m" || unit == "mb" || unit == "g" || unit == "gb" || unit == "t" || unit == "tb") {
    why = "the unit '" + t.substr(i) + "' is ambiguous (decimal, or no base given): use KiB, MiB, GiB or TiB, or a plain byte count";
    return false;
  } else {
    why = "expected a whole number of bytes, optionally with KiB, MiB, GiB or TiB";
    return false;
  }
  if (n > UINT64_MAX / mul) { why = "too large for 64 bits"; return false; }
  out = n * mul;
  return true;
}

bool parsePercent(const std::string& text, int& out, std::string& why) {
  std::string t = trimmed(text);
  if (!t.empty() && t.back() == '%') { t.pop_back(); t = trimmed(t); }
  const bool digits = !t.empty() && t.size() <= 3 &&
      std::all_of(t.begin(), t.end(), [](char c) { return c >= '0' && c <= '9'; });
  if (!digits || std::atoi(t.c_str()) > 100) { why = "expected a whole percent 0..100"; return false; }
  out = std::atoi(t.c_str());
  return true;
}

std::vector<std::string> applySpoolLimits(RecorderConfig& cfg, const SpoolLimitText& text) {
  std::vector<std::string> refusals;
  auto refuse = [&refusals](const char* var, const std::string& raw, const std::string& why, const std::string& kept) {
    refusals.push_back(std::string(var) + "=" + quoted(raw) + " refused: " + why + " — the default " + kept + " stays in force");
  };

  cfg.spoolCapSource = "default";
  if (!text.capBytes.empty()) {
    uint64_t v = 0;
    std::string why;
    if (!parseByteCount(text.capBytes, v, why)) {
      refuse("TICK_SPOOL_CAP_BYTES", text.capBytes, why, describeBytes(cfg.spoolCapBytes));
      cfg.spoolCapSource = "refused";
    } else if (v < cfg.segmentBytes) {
      refuse("TICK_SPOOL_CAP_BYTES", text.capBytes,
             "below one segment (" + describeBytes(cfg.segmentBytes) + "): the spool could not keep a single sealed segment",
             describeBytes(cfg.spoolCapBytes));
      cfg.spoolCapSource = "refused";
    } else {
      cfg.spoolCapBytes = v;
      cfg.spoolCapSource = "env";
    }
  }

  cfg.reserveMinSource = "default";
  if (!text.reserveMinBytes.empty()) {
    uint64_t v = 0;
    std::string why;
    if (!parseByteCount(text.reserveMinBytes, v, why)) {
      refuse("TICK_SPOOL_RESERVE_MIN_BYTES", text.reserveMinBytes, why, describeBytes(cfg.reserveMinBytes));
      cfg.reserveMinSource = "refused";
    } else {
      cfg.reserveMinBytes = v;
      cfg.reserveMinSource = "env";
    }
  }

  cfg.reservePctSource = "default";
  if (!text.reservePct.empty()) {
    int v = 0;
    std::string why;
    if (!parsePercent(text.reservePct, v, why)) {
      refuse("TICK_SPOOL_RESERVE_PCT", text.reservePct, why, std::to_string(cfg.reservePct) + "%");
      cfg.reservePctSource = "refused";
    } else if (v > kMaxReservePct) {
      refuse("TICK_SPOOL_RESERVE_PCT", text.reservePct,
             "over " + std::to_string(kMaxReservePct) + "%: the reserve would leave the recorder almost no mount to write on",
             std::to_string(cfg.reservePct) + "%");
      cfg.reservePctSource = "refused";
    } else {
      cfg.reservePct = v;
      cfg.reservePctSource = "env";
    }
  }

  cfg.limitRefusals = refusals;
  return refusals;
}

bool capExceedsListing(const RecorderConfig& cfg) {
  return cfg.segmentBytes > 0 && cfg.spoolCapBytes / cfg.segmentBytes > kMaxListEntries;
}

uint64_t effectiveReserveBytes(const RecorderConfig& cfg, uint64_t totalBytes) {
  return std::max<uint64_t>(cfg.reserveMinBytes, totalBytes / 100 * static_cast<uint64_t>(cfg.reservePct));
}

std::vector<std::string> spoolFitProblems(const RecorderConfig& cfg, uint64_t totalBytes, uint64_t availBytes,
                                          uint64_t spoolBytesNow) {
  std::vector<std::string> out;
  if (totalBytes == 0) {
    out.push_back("mount size unknown (no free-space probe yet): whether the cap fits cannot be judged");
    return out;
  }
  const uint64_t used = totalBytes - std::min(availBytes, totalBytes);
  const uint64_t others = used > spoolBytesNow ? used - spoolBytesNow : 0;
  const uint64_t reserve = effectiveReserveBytes(cfg, totalBytes);
  // retire() holds sealed <= cap each time a segment seals or opens; the open
  // one then grows to a segment — and past it by up to one queue's worth,
  // because the writer drains the whole ring before its seal check (measured
  // 25-09-2026: the live spool's four sealed segments were 40 B over 4 × 64 MiB).
  const uint64_t openMax = saturatingAdd(cfg.segmentBytes, static_cast<uint64_t>(cfg.queueRecords) * kRecordBytes);
  const uint64_t peak = saturatingAdd(cfg.spoolCapBytes, openMax);
  const uint64_t atPeak = saturatingAdd(others, peak);

  const uint64_t reserveRoom = reserve >= totalBytes ? 0 : totalBytes - reserve;
  const uint64_t warnRoom = roomBelowPct(totalBytes, cfg.warnPct);
  const uint64_t stopRoom = roomBelowPct(totalBytes, cfg.stopPct);
  const uint64_t room = std::min({reserveRoom, warnRoom, stopRoom});
  const uint64_t spoolRoom = room > others ? room - others : 0;
  const std::string largest = spoolRoom > openMax && spoolRoom - openMax >= cfg.segmentBytes
      ? "the largest cap that fits this mount now is " + describeBytes(spoolRoom - openMax)
      : "no cap of at least one segment fits this mount now";
  const std::string atCap = "at its cap the spool (" + describeBytes(cfg.spoolCapBytes) + " + one open segment of up to " +
      describeBytes(openMax) + ") plus " + describeBytes(others) + " of other files";

  if (reserve >= totalBytes) {
    out.push_back("the reserve " + describeBytes(reserve) + " is the whole mount " + describeBytes(totalBytes) +
                  ": the recorder can never write");
    return out;
  }
  if (atPeak > reserveRoom)
    out.push_back(atCap + " would leave less than the reserve " + describeBytes(reserve) + " free on a " +
                  describeBytes(totalBytes) + " mount: recording PAUSES with gaps before the cap retires anything; " + largest);
  if (atPeak > warnRoom)
    out.push_back(atCap + " would put the mount at " + std::to_string(cfg.warnPct) +
                  "% used or more: the recorder reports WARN, which the keeper's tick readiness does not count as RECORDING; " + largest);
  if (atPeak > stopRoom)
    out.push_back(atCap + " would put the mount at " + std::to_string(cfg.stopPct) +
                  "% used or more: writes are refused before the cap binds; " + largest);
  return out;
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
    logError("cannot start: " + why);
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
  tornAtStart_ = torn;
  restartGapPending_ = torn > 0;
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

bool TickRecorder::setRecording(bool on) {
  if (on && !started_.load()) return false;
  recording_.store(on);
  return true;
}

void TickRecorder::noteGap(GapReason reason, uint64_t count) {
  // Gaps are queued through the same ring as quotes so they land in order;
  // a full ring here is itself an overflow, counted like any other drop.
  Record g;
  g.recvMs = nowMs();
  g.seq = ++seq_;
  g.kind = GAP;
  g.bid = static_cast<int64_t>(count);
  g.ask = static_cast<int64_t>(reason);
  g.generation = static_cast<uint16_t>(generation_.load(std::memory_order_relaxed) & 0xFFFF);
  if (!ring_.push(g)) { dropped_.fetch_add(1); pendingOverflow_.fetch_add(1); }
}

Record TickRecorder::onQuote(long long symbolId, bool hasBid, long long bid, bool hasAsk, long long ask,
                             uint64_t recvMs, uint32_t generation) {
  events_.fetch_add(1, std::memory_order_relaxed);
  if (generation != generation_.load(std::memory_order_relaxed)) {
    // A (re)subscribe: the first event per symbol after it is a snapshot, and
    // the discontinuity is on disk as a gap IN ORDER — pushed through the
    // same ring, ahead of the new generation's first quote.
    const bool reconnect = generation_.load(std::memory_order_relaxed) != 0;
    generation_.store(generation, std::memory_order_relaxed);
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
  if (!recording_.load(std::memory_order_relaxed)) { skippedOff_.fetch_add(1); return r; }
  if (!ring_.push(r)) { dropped_.fetch_add(1); pendingOverflow_.fetch_add(1); }
  return r;
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
      st_.reserveBytes = effectiveReserveBytes(cfg_, total);
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
  std::snprintf(name, sizeof name, "/seg-%013llu-%06u.tks", static_cast<unsigned long long>(now), ++segIndex_);
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
  h.generation = generation_.load(std::memory_order_relaxed);
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
  if (restartGapPending_) {
    // The discontinuity a crash left behind, first thing in the first segment.
    restartGapPending_ = false;
    Record g;
    g.recvMs = now;
    g.seq = seq_.load(std::memory_order_relaxed);
    g.kind = GAP;
    g.bid = static_cast<int64_t>(tornAtStart_);
    g.ask = GAP_RESTART;
    g.generation = static_cast<uint16_t>(generation_.load(std::memory_order_relaxed) & 0xFFFF);
    uint8_t gb[kRecordBytes];
    encodeRecord(g, gb);
    buf_.insert(buf_.end(), gb, gb + kRecordBytes);
    openBytes_ += kRecordBytes;
    std::lock_guard<std::mutex> lk(statsMtx_);
    st_.gaps++;
    st_.recordsWritten++;
    st_.bytesWritten += kRecordBytes;
  }
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
        g.generation = static_cast<uint16_t>(generation_.load(std::memory_order_relaxed) & 0xFFFF);
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
        g.generation = static_cast<uint16_t>(generation_.load(std::memory_order_relaxed) & 0xFFFF);
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
  s.generation = generation_.load(std::memory_order_relaxed);
  s.seq = seq_.load(std::memory_order_relaxed);
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

namespace {

// GW-CAP: one builder for both routes, so /health and /tick-status cannot
// disagree about the limits in force.
jsn::Value limitsValue(const RecorderConfig& cfg, const RecorderStats& s, bool withText) {
  jsn::Value l{jsn::Object{}};
  l.set("spoolCapBytes", static_cast<double>(cfg.spoolCapBytes));
  l.set("spoolCapSource", cfg.spoolCapSource);
  l.set("reserveMinBytes", static_cast<double>(cfg.reserveMinBytes));
  l.set("reserveMinSource", cfg.reserveMinSource);
  l.set("reservePct", static_cast<double>(cfg.reservePct));
  l.set("reservePctSource", cfg.reservePctSource);
  l.set("segmentBytes", static_cast<double>(cfg.segmentBytes));
  // The reserve in bytes exists only against a measured mount: null until
  // the writer's first probe, never a 0 that reads as "no reserve".
  const bool probed = s.diskTotalBytes > 0;
  l.set("reserveBytes", probed ? jsn::Value(static_cast<double>(s.reserveBytes)) : jsn::Value(nullptr));
  l.set("refusedCount", static_cast<double>(cfg.limitRefusals.size()));
  // A failed probe zeroes the available bytes and sets usagePct -1
  // (budgetAllows); judging the fit from that 0 would read "the mount is
  // full". Unknown is null, not a verdict.
  const bool measured = probed && s.usagePct >= 0;
  const std::vector<std::string> fit =
      measured ? spoolFitProblems(cfg, s.diskTotalBytes, s.diskAvailBytes, s.sealedBytes + s.openBytes)
               : std::vector<std::string>{};
  l.set("fitsMount", measured ? jsn::Value(fit.empty()) : jsn::Value(nullptr));
  if (withText) {
    jsn::Array refused;
    for (const auto& line : cfg.limitRefusals) refused.push_back(jsn::Value(line));
    l.set("refusals", jsn::Value(std::move(refused)));
    jsn::Array problems;
    for (const auto& line : fit) problems.push_back(jsn::Value(line));
    l.set("fitProblems", jsn::Value(std::move(problems)));
  }
  return l;
}

} // namespace

std::string TickRecorder::limitsJson(bool withText) const {
  return jsn::dump(limitsValue(cfg_, stats(), withText));
}

std::string TickRecorder::limitsJson(const RecorderStats& s, bool withText) const {
  return jsn::dump(limitsValue(cfg_, s, withText));
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
  v.set("limits", limitsValue(cfg_, s, true));
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
