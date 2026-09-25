// scripts/tick-recorder-soak-driver.cpp — V3 R2 (P8d, corrected): drives the
// gateway's tick recorder (cpp-exec/src/tick_recorder.cpp, compiled from HERE
// so no gateway watch pattern fires) at a scripted load with scripted faults,
// then reads the spool back and accounts for every event it offered.
//
// WHAT IT MEASURES (tick plan §16, :283): N symbols × R events/s with short
// bursts of F× for --duration seconds; the recorder's counters and state each
// sample; RSS, the spool's bytes against its cap, and an in-flight estimate;
// and at the end, every sealed segment read back record by record (checksums)
// so that
//
//     offered while recording  =  written + dropped (queue) + refused (reserve)
//     written                  =  quote records readable on disk
//
// hold, or the difference is named. A loss the recorder's counters do not
// account for makes the exit code nonzero. It GRADES nothing: the report goes
// to agent/services/final-acceptance.js soakVerdict (through
// scripts/tick-recorder-soak.mjs), which does.
//
// FAULTS (--faults "atS:kind[:arg],…", each lasting until the next entry):
//   probe_low / probe_full / probe_ok  the scripted free-space probe drops below
//                                      the reserve / past stopPct / recovers
//   eio_write short_write enospc_write eio_fsync rename_fail unlink_fail
//   unwritable slow / none             through the LD_PRELOAD shim
//                                      (scripts/tick-recorder-soak-faults.c)
//   chmod_ro / restore                 the spool directory 0555 / 0755 (root
//                                      ignores it: reported as not applied)
//   fill:<bytes> / unfill              a filler file beside the spool (seen by
//                                      the recorder only with --probe real)
//   exhaust_inodes / free_inodes       empty files beside the spool until the
//                                      mount runs out of inodes
//   reconnect                          the feed's generation moves (a gap)
// A fault that cannot be applied here is reported as not applied, with why.
//
// Build (scripts/tick-recorder-soak.mjs does this): g++ -std=c++20 -O2 -pthread
//   -I cpp-exec/src scripts/tick-recorder-soak-driver.cpp cpp-exec/src/tick_recorder.cpp -o soak-driver -ldl
#include <dirent.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <random>
#include <set>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "tick_recorder.hpp"

using namespace tick;
using Clock = std::chrono::steady_clock;

namespace {

struct Fault { double atS = 0; std::string kind; std::string arg; };

struct Opts {
  std::string spool;
  double durationS = 60;
  int symbols = 20;
  double ratePerSymbol = 100;
  double burstFactor = 10;
  double burstEveryS = 60;
  double burstLenS = 5;
  uint64_t segmentBytes = 64ull << 20;
  uint64_t capBytes = 2ull << 30;
  uint64_t reserveMinBytes = 2ull << 30;
  int reservePct = 20;
  size_t queueRecords = 1u << 18;
  int fsyncEveryMs = 5000;
  int budgetEveryMs = 2000;
  std::string probe = "scripted";
  double sampleEveryS = 1;
  std::string faultsText;
  std::string samplesOut;
  std::vector<Fault> faults;
};

uint64_t wallMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

std::string jstr(const std::string& s) {
  std::string o = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += c; }
    else if (static_cast<unsigned char>(c) < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += c;
  }
  return o + "\"";
}

long rssKiB() {
  std::FILE* f = std::fopen("/proc/self/status", "r");
  if (!f) return -1;
  char line[256];
  long v = -1;
  while (std::fgets(line, sizeof line, f)) if (std::strncmp(line, "VmRSS:", 6) == 0) { v = std::strtol(line + 6, nullptr, 10); break; }
  std::fclose(f);
  return v;
}

bool parseFaults(const std::string& text, std::vector<Fault>& out, std::string& why) {
  std::stringstream ss(text);
  std::string item;
  while (std::getline(ss, item, ',')) {
    if (item.empty()) continue;
    const auto c1 = item.find(':');
    if (c1 == std::string::npos) { why = "fault '" + item + "' is not atS:kind"; return false; }
    Fault f;
    char* end = nullptr;
    f.atS = std::strtod(item.substr(0, c1).c_str(), &end);
    if (!end || *end != 0 || f.atS < 0) { why = "fault '" + item + "' has no time"; return false; }
    const std::string rest = item.substr(c1 + 1);
    const auto c2 = rest.find(':');
    f.kind = c2 == std::string::npos ? rest : rest.substr(0, c2);
    f.arg = c2 == std::string::npos ? "" : rest.substr(c2 + 1);
    out.push_back(f);
  }
  std::sort(out.begin(), out.end(), [](const Fault& a, const Fault& b) { return a.atS < b.atS; });
  return true;
}

// The shim's modes (scripts/tick-recorder-soak-faults.c).
int shimMode(const std::string& k) {
  static const std::map<std::string, int> m = {
    {"none", 0}, {"eio_write", 1}, {"short_write", 2}, {"enospc_write", 3}, {"eio_fsync", 4},
    {"rename_fail", 5}, {"unlink_fail", 6}, {"unwritable", 7}, {"slow", 8}, {"restore", 0}, {"probe_ok", 0},
  };
  auto it = m.find(k);
  return it == m.end() ? -1 : it->second;
}

struct SegCount {
  uint64_t quotes = 0, gaps = 0, bytes = 0;
  bool headerOk = false, truncated = false;
  std::map<int64_t, uint64_t> gapBids;  // GapReason → sum of counts
  std::map<int64_t, uint64_t> gapRecords;
};

// Streams one segment: counts, never stores (the tailer must not add a
// segment's worth of records to the RSS being measured).
SegCount countSegment(const std::string& path) {
  SegCount c;
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) { c.truncated = true; return c; }
  uint8_t hdr[kHeaderBytes];
  SegmentHeader h;
  if (std::fread(hdr, 1, kHeaderBytes, f) != kHeaderBytes || !decodeHeader(hdr, h)) { c.truncated = true; std::fclose(f); return c; }
  c.headerOk = true;
  c.bytes = kHeaderBytes;
  uint8_t rec[kRecordBytes];
  for (;;) {
    const size_t n = std::fread(rec, 1, kRecordBytes, f);
    if (n == 0) break;
    if (n != kRecordBytes) { c.truncated = true; break; }
    Record r;
    if (!decodeRecord(rec, r)) { c.truncated = true; break; }
    c.bytes += kRecordBytes;
    if (r.kind == GAP) { c.gaps++; c.gapBids[r.ask] += static_cast<uint64_t>(r.bid); c.gapRecords[r.ask]++; }
    else c.quotes++;
  }
  std::fclose(f);
  return c;
}

std::vector<std::string> filesWithSuffix(const std::string& dir, const std::string& suffix) {
  std::vector<std::string> out;
  if (DIR* d = ::opendir(dir.c_str())) {
    while (dirent* e = ::readdir(d)) {
      const std::string n = e->d_name;
      if (n.rfind("seg-", 0) == 0 && n.size() >= suffix.size() && n.compare(n.size() - suffix.size(), suffix.size(), suffix) == 0) out.push_back(n);
    }
    ::closedir(d);
  }
  std::sort(out.begin(), out.end());
  return out;
}

struct Snap {
  double tS = 0;
  RecorderStats s;
  long rss = -1;
};

std::string statsJson(const RecorderStats& s) {
  std::ostringstream o;
  o << "{\"state\":" << jstr(s.state) << ",\"recording\":" << (s.recording ? "true" : "false")
    << ",\"events\":" << s.events << ",\"dropped\":" << s.dropped << ",\"pausedDrops\":" << s.pausedDrops
    << ",\"skippedOff\":" << s.skippedOff << ",\"gaps\":" << s.gaps << ",\"recordsWritten\":" << s.recordsWritten
    << ",\"bytesWritten\":" << s.bytesWritten << ",\"sealed\":" << s.segmentsSealed << ",\"retired\":" << s.segmentsRetired
    << ",\"sealedBytes\":" << s.sealedBytes << ",\"openBytes\":" << s.openBytes << ",\"writeErrors\":" << s.writeErrors
    << ",\"usagePct\":" << s.usagePct << ",\"generation\":" << s.generation << ",\"reason\":" << jstr(s.reason) << "}";
  return o.str();
}

uint64_t counterOf(const RecorderStats& s, const std::string& k) {
  if (k == "pausedDrops") return s.pausedDrops;
  if (k == "writeErrors") return s.writeErrors;
  if (k == "dropped") return s.dropped;
  if (k == "gaps") return s.gaps;
  if (k == "sealed") return s.segmentsSealed;
  if (k == "retired") return s.segmentsRetired;
  return 0;
}

void usage() {
  std::fprintf(stderr,
    "usage: soak-driver --spool DIR [--duration S] [--symbols N] [--rate EV_PER_SYMBOL_S] [--burst-factor F]\n"
    "  [--burst-every S] [--burst-len S] [--segment-bytes B] [--cap-bytes B] [--reserve-min-bytes B] [--reserve-pct P]\n"
    "  [--queue-records N] [--fsync-every-ms MS] [--budget-every-ms MS] [--probe scripted|real] [--sample-every S]\n"
    "  [--faults \"atS:kind[:arg],...\"] [--samples-out FILE]\n");
}

} // namespace

int main(int argc, char** argv) {
  Opts o;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto next = [&]() -> std::string { if (i + 1 >= argc) { usage(); std::exit(2); } return argv[++i]; };
    if (a == "--spool") o.spool = next();
    else if (a == "--duration") o.durationS = std::atof(next().c_str());
    else if (a == "--symbols") o.symbols = std::atoi(next().c_str());
    else if (a == "--rate") o.ratePerSymbol = std::atof(next().c_str());
    else if (a == "--burst-factor") o.burstFactor = std::atof(next().c_str());
    else if (a == "--burst-every") o.burstEveryS = std::atof(next().c_str());
    else if (a == "--burst-len") o.burstLenS = std::atof(next().c_str());
    else if (a == "--segment-bytes") o.segmentBytes = std::strtoull(next().c_str(), nullptr, 10);
    else if (a == "--cap-bytes") o.capBytes = std::strtoull(next().c_str(), nullptr, 10);
    else if (a == "--reserve-min-bytes") o.reserveMinBytes = std::strtoull(next().c_str(), nullptr, 10);
    else if (a == "--reserve-pct") o.reservePct = std::atoi(next().c_str());
    else if (a == "--queue-records") o.queueRecords = std::strtoull(next().c_str(), nullptr, 10);
    else if (a == "--fsync-every-ms") o.fsyncEveryMs = std::atoi(next().c_str());
    else if (a == "--budget-every-ms") o.budgetEveryMs = std::atoi(next().c_str());
    else if (a == "--probe") o.probe = next();
    else if (a == "--sample-every") o.sampleEveryS = std::atof(next().c_str());
    else if (a == "--faults") o.faultsText = next();
    else if (a == "--samples-out") o.samplesOut = next();
    else { usage(); return 2; }
  }
  std::string why;
  if (o.spool.empty() || o.symbols < 1 || o.ratePerSymbol <= 0 || o.durationS <= 0 || (o.probe != "scripted" && o.probe != "real")
      || !parseFaults(o.faultsText, o.faults, why)) {
    if (!why.empty()) std::fprintf(stderr, "%s\n", why.c_str());
    usage();
    return 2;
  }
  const std::string parent = o.spool.substr(0, o.spool.find_last_of('/') == std::string::npos ? 0 : o.spool.find_last_of('/'));

  // The shim, when preloaded.
  using SetFn = void (*)(int, const char*);
  using HitsFn = unsigned long (*)();
  auto shimSet = reinterpret_cast<SetFn>(dlsym(RTLD_DEFAULT, "soak_fault_set"));
  auto shimHits = reinterpret_cast<HitsFn>(dlsym(RTLD_DEFAULT, "soak_fault_hits"));
  if (shimSet) shimSet(0, o.spool.c_str());

  // The scripted probe: a 64 GiB mount, 48 GiB free (25 % used) unless a fault moves it.
  constexpr uint64_t kTotal = 64ull << 30;
  std::atomic<uint64_t> scriptedAvail{48ull << 30};
  // Every probe the recorder makes is counted, so a probe fault whose window
  // held no probe is reported as never met, not as a recorder that ignored it.
  std::atomic<uint64_t> probeCalls{0};
  FreeSpaceProbe probe = o.probe == "real"
    ? FreeSpaceProbe([&probeCalls](const std::string& d, uint64_t& avail, uint64_t& total) { probeCalls.fetch_add(1); return statvfsProbe(d, avail, total); })
    : FreeSpaceProbe([&scriptedAvail, &probeCalls](const std::string&, uint64_t& avail, uint64_t& total) { probeCalls.fetch_add(1); avail = scriptedAvail.load(); total = kTotal; return true; });

  RecorderConfig cfg;
  cfg.spoolDir = o.spool;
  cfg.feedId = "soak.local";
  cfg.environment = 0;
  cfg.queueRecords = o.queueRecords;
  cfg.segmentBytes = o.segmentBytes;
  cfg.spoolCapBytes = o.capBytes;
  cfg.reserveMinBytes = o.reserveMinBytes;
  cfg.reservePct = o.reservePct;
  cfg.fsyncEveryMs = o.fsyncEveryMs;
  cfg.budgetCheckEveryMs = o.budgetEveryMs;
  const uint64_t scriptedReserve = std::max<uint64_t>(cfg.reserveMinBytes, kTotal / 100 * static_cast<uint64_t>(cfg.reservePct));

  TickRecorder rec(cfg, probe);
  if (!rec.start()) {
    std::fprintf(stderr, "recorder did not start: %s\n", rec.stats().reason.c_str());
    return 2;
  }
  rec.setRecording(true);

  // The tailer: reads every sealed segment soon after it seals, before a retire can take it.
  std::mutex segMtx;
  std::map<std::string, SegCount> seen;
  std::atomic<bool> stopTail{false};
  std::thread tailer([&] {
    while (!stopTail.load()) {
      const SegmentList l = listSealedSegments(o.spool);
      for (const auto& e : l.segments) {
        { std::lock_guard<std::mutex> lk(segMtx); if (seen.count(e.name)) continue; }
        SegCount c = countSegment(o.spool + "/" + e.name);
        std::lock_guard<std::mutex> lk(segMtx);
        seen.emplace(e.name, c);
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  });

  std::FILE* samplesFile = o.samplesOut.empty() ? nullptr : std::fopen(o.samplesOut.c_str(), "w");
  std::vector<std::string> faultJson;
  size_t nextFault = 0;
  RecorderStats faultStart;
  unsigned long faultShimHits = 0;
  uint64_t faultProbeCalls = 0;
  int activeFault = -1;
  std::vector<std::string> fillers;
  std::string fillerPath = parent.empty() ? o.spool + ".filler" : parent + "/soak-filler.bin";
  std::string inodeDir = parent.empty() ? o.spool + ".inodes" : parent + "/soak-inodes";
  uint64_t inodeFiles = 0;
  std::vector<std::string> faultNotes(o.faults.size());
  std::vector<bool> faultApplied(o.faults.size(), false);

  auto closeFault = [&](const RecorderStats& now) {
    if (activeFault < 0) return;
    const Fault& f = o.faults[activeFault];
    std::ostringstream j;
    j << "{\"atS\":" << f.atS << ",\"kind\":" << jstr(f.kind) << ",\"arg\":" << jstr(f.arg)
      << ",\"applied\":" << (faultApplied[activeFault] ? "true" : "false") << ",\"note\":" << jstr(faultNotes[activeFault])
      << ",\"moved\":{";
    const char* keys[] = {"pausedDrops", "writeErrors", "dropped", "gaps", "sealed", "retired"};
    for (int k = 0; k < 6; ++k) j << (k ? "," : "") << "\"" << keys[k] << "\":" << (counterOf(now, keys[k]) - counterOf(faultStart, keys[k]));
    j << "}";
    // hits: the calls this fault met inside its window — shim-failed calls
    // for a shim fault, recorder probes for a probe fault. 0 = never met.
    const int sm = shimMode(f.kind);
    if (f.kind == "probe_low" || f.kind == "probe_full") j << ",\"hits\":" << (probeCalls.load() - faultProbeCalls);
    else if (sm > 0) j << ",\"hits\":" << (shimHits ? shimHits() - faultShimHits : 0);
    j << ",\"stateAtEnd\":" << jstr(now.state) << "}";
    faultJson.push_back(j.str());
    activeFault = -1;
  };

  auto applyFault = [&](size_t idx) {
    const Fault& f = o.faults[idx];
    bool applied = false;
    std::string note;
    const int sm = shimMode(f.kind);
    if (f.kind == "probe_low" || f.kind == "probe_full") {
      if (o.probe != "scripted") note = "the probe is real; a scripted probe fault needs --probe scripted";
      else {
        scriptedAvail.store(f.kind == "probe_low" ? scriptedReserve - (1ull << 30) : kTotal / 10);
        applied = true;
        note = f.kind == "probe_low" ? "available bytes set 1 GiB below the reserve" : "usage set to 90 %, past stopPct";
      }
    } else if (f.kind == "chmod_ro" || f.kind == "restore") {
      if (f.kind == "chmod_ro" && ::geteuid() == 0) note = "running as root: directory permissions do not bind, so chmod cannot make the spool unwritable here (use 'unwritable' through the shim)";
      else if (::chmod(o.spool.c_str(), f.kind == "chmod_ro" ? 0555 : 0755) == 0) { applied = true; note = f.kind == "chmod_ro" ? "spool directory mode 0555" : "spool directory mode 0755"; }
      else note = std::string("chmod failed: ") + std::strerror(errno);
      if (f.kind == "restore") { scriptedAvail.store(48ull << 30); if (shimSet) shimSet(0, nullptr); }
    } else if (f.kind == "fill") {
      const uint64_t bytes = std::strtoull(f.arg.c_str(), nullptr, 10);
      int fd = ::open(fillerPath.c_str(), O_CREAT | O_WRONLY | O_TRUNC, 0644);
      if (fd < 0 || bytes == 0) note = "cannot create the filler (or no size given)";
      else {
        const int r = ::posix_fallocate(fd, 0, static_cast<off_t>(bytes));
        ::close(fd);
        if (r == 0) { applied = o.probe == "real"; fillers.push_back(fillerPath); note = o.probe == "real" ? "filler of " + f.arg + " B beside the spool" : "filler written, but the scripted probe does not see it: use --probe real"; }
        else note = std::string("posix_fallocate failed: ") + std::strerror(r);
      }
    } else if (f.kind == "unfill") {
      for (const auto& p : fillers) ::unlink(p.c_str());
      fillers.clear();
      applied = true;
      note = "filler removed";
    } else if (f.kind == "exhaust_inodes") {
      ::mkdir(inodeDir.c_str(), 0755);
      bool exhausted = false;
      for (; inodeFiles < 1000000; ++inodeFiles) {
        const std::string p = inodeDir + "/i" + std::to_string(inodeFiles);
        int fd = ::open(p.c_str(), O_CREAT | O_WRONLY, 0644);
        if (fd < 0) { exhausted = errno == ENOSPC; break; }
        ::close(fd);
      }
      applied = exhausted;
      note = exhausted ? std::to_string(inodeFiles) + " files created before the mount ran out of inodes" : "the mount did not run out of inodes within 1,000,000 files (not an inode-limited mount)";
    } else if (f.kind == "free_inodes") {
      for (uint64_t i = 0; i < inodeFiles; ++i) ::unlink((inodeDir + "/i" + std::to_string(i)).c_str());
      ::rmdir(inodeDir.c_str());
      inodeFiles = 0;
      applied = true;
      note = "inode files removed";
    } else if (f.kind == "reconnect") {
      applied = true;
      note = "the feed generation moves at this time";
    } else if (sm >= 0) {
      if (f.kind == "probe_ok") { scriptedAvail.store(48ull << 30); applied = true; note = "probe restored"; }
      if (sm > 0 && !shimSet) note = "the fault shim is not preloaded (LD_PRELOAD scripts/tick-recorder-soak-faults.c)";
      else if (shimSet) { shimSet(sm, nullptr); applied = true; if (note.empty()) note = sm == 0 ? "shim faults cleared" : "shim mode " + f.kind; }
    } else note = "unknown fault kind";
    faultApplied[idx] = applied;
    faultNotes[idx] = note;
  };

  // The feed.
  std::mt19937_64 rng(42);
  std::vector<long long> bid(o.symbols), ask(o.symbols);
  for (int s = 0; s < o.symbols; ++s) { bid[s] = 100000 + s * 1000; ask[s] = bid[s] + 5; }
  uint32_t generation = 1;
  uint64_t offered = 0, offeredBase = 0, offeredBurst = 0;
  double baseSeconds = 0, burstSeconds = 0, lastT = 0;
  uint64_t peakSpool = 0;
  long peakRss = 0;
  const double totalRate = o.symbols * o.ratePerSymbol;
  const auto t0 = Clock::now();
  double nextSample = 0;
  double carry = 0;
  int sym = 0;
  uint64_t samples = 0;
  for (;;) {
    const double t = std::chrono::duration<double>(Clock::now() - t0).count();
    if (t >= o.durationS) break;
    while (nextFault < o.faults.size() && o.faults[nextFault].atS <= t) {
      const RecorderStats now = rec.stats();
      closeFault(now);
      faultShimHits = shimHits ? shimHits() : 0;
      faultProbeCalls = probeCalls.load();
      applyFault(nextFault);
      faultStart = rec.stats();
      activeFault = static_cast<int>(nextFault);
      if (o.faults[nextFault].kind == "reconnect" && faultApplied[nextFault]) generation++;
      ++nextFault;
    }
    const bool burst = o.burstEveryS > 0 && o.burstLenS > 0 && std::fmod(t, o.burstEveryS) >= o.burstEveryS - o.burstLenS;
    const double rate = totalRate * (burst ? o.burstFactor : 1.0);
    (burst ? burstSeconds : baseSeconds) += t - lastT;
    lastT = t;
    // 10 ms slices: the events due in this slice, carried fractionally.
    carry += rate * 0.01;
    const uint64_t due = static_cast<uint64_t>(carry);
    carry -= static_cast<double>(due);
    for (uint64_t k = 0; k < due; ++k) {
      const int s = sym;
      sym = (sym + 1) % o.symbols;
      const int move = static_cast<int>(rng() % 3) - 1;
      bid[s] += move; ask[s] = bid[s] + 5 + static_cast<long long>(rng() % 3);
      rec.onQuote(10000 + s, true, bid[s], true, ask[s], wallMs(), generation);
      ++offered;
      if (burst) ++offeredBurst; else ++offeredBase;
    }
    if (t >= nextSample) {
      const RecorderStats s = rec.stats();
      const long rss = rssKiB();
      peakRss = std::max(peakRss, rss);
      peakSpool = std::max<uint64_t>(peakSpool, s.sealedBytes + s.openBytes);
      if (samplesFile) {
        std::fprintf(samplesFile, "{\"tS\":%.3f,\"rssKiB\":%ld,\"offered\":%llu,\"stats\":%s}\n", t, rss,
                     static_cast<unsigned long long>(offered), statsJson(s).c_str());
      }
      ++samples;
      nextSample += o.sampleEveryS;
    }
    const auto sliceEnd = t0 + std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(t + 0.01));
    std::this_thread::sleep_until(sliceEnd);
  }
  const double elapsed = std::chrono::duration<double>(Clock::now() - t0).count();
  // Clear every fault before the final seal, so the accounting reads a healthy spool.
  closeFault(rec.stats());
  if (shimSet) shimSet(0, nullptr);
  scriptedAvail.store(48ull << 30);
  for (const auto& p : fillers) ::unlink(p.c_str());
  if (inodeFiles) { for (uint64_t i = 0; i < inodeFiles; ++i) ::unlink((inodeDir + "/i" + std::to_string(i)).c_str()); ::rmdir(inodeDir.c_str()); }
  if (::geteuid() != 0) ::chmod(o.spool.c_str(), 0755);
  rec.flush();
  const RecorderStats before = rec.stats();
  rec.stop();
  const RecorderStats fin = rec.stats();
  stopTail.store(true);
  tailer.join();
  if (samplesFile) std::fclose(samplesFile);

  // The final read-back: every sealed segment (tailed or new), plus anything unsealed left behind.
  const std::vector<std::string> sealedNow = filesWithSuffix(o.spool, ".tks");
  for (const auto& n : sealedNow) if (!seen.count(n)) seen.emplace(n, countSegment(o.spool + "/" + n));
  std::set<std::string> present(sealedNow.begin(), sealedNow.end());
  uint64_t quotes = 0, gapsOnDisk = 0, truncated = 0, retiredRead = 0;
  std::map<int64_t, uint64_t> gapBids, gapRecords;
  for (const auto& [name, c] : seen) {
    quotes += c.quotes; gapsOnDisk += c.gaps;
    if (c.truncated) ++truncated;
    if (!present.count(name)) ++retiredRead;
    for (const auto& [k, v] : c.gapBids) gapBids[k] += v;
    for (const auto& [k, v] : c.gapRecords) gapRecords[k] += v;
  }
  // A segment the recorder retired before the tailer read it: its records are unknowable.
  const uint64_t unread = fin.segmentsRetired > retiredRead ? fin.segmentsRetired - retiredRead : 0;
  uint64_t unsealedQuotes = 0;
  const std::vector<std::string> leftovers = filesWithSuffix(o.spool, ".tks.open");
  for (const auto& n : leftovers) unsealedQuotes += countSegment(o.spool + "/" + n).quotes;
  const uint64_t quotesWritten = fin.recordsWritten - fin.gaps;
  const long long lost = static_cast<long long>(offered) - static_cast<long long>(quotes + fin.dropped + fin.pausedDrops);

  std::ostringstream out;
  out << "{\"driver\":\"tick-recorder-soak-driver\",\"config\":{\"spool\":" << jstr(o.spool) << ",\"durationS\":" << o.durationS
      << ",\"symbols\":" << o.symbols << ",\"ratePerSymbol\":" << o.ratePerSymbol << ",\"burstFactor\":" << o.burstFactor
      << ",\"burstEveryS\":" << o.burstEveryS << ",\"burstLenS\":" << o.burstLenS << ",\"segmentBytes\":" << o.segmentBytes
      << ",\"spoolCapBytes\":" << o.capBytes << ",\"reserveMinBytes\":" << o.reserveMinBytes << ",\"reservePct\":" << o.reservePct
      << ",\"queueRecords\":" << o.queueRecords << ",\"fsyncEveryMs\":" << o.fsyncEveryMs << ",\"budgetEveryMs\":" << o.budgetEveryMs
      << ",\"probe\":" << jstr(o.probe) << ",\"faults\":" << jstr(o.faultsText)
      << ",\"shimLoaded\":" << (shimSet ? "true" : "false") << ",\"euid\":" << ::geteuid() << "},";
  out << "\"faults\":[";
  for (size_t i = 0; i < faultJson.size(); ++i) out << (i ? "," : "") << faultJson[i];
  out << "],\"final\":{\"elapsedS\":" << elapsed << ",\"samples\":" << samples << ",\"offeredWhileOn\":" << offered
      << ",\"offeredPerSecBase\":" << (baseSeconds > 0 ? std::round(static_cast<double>(offeredBase) / baseSeconds) : 0)
      << ",\"offeredPerSecBurst\":" << (burstSeconds > 0 ? std::round(static_cast<double>(offeredBurst) / burstSeconds) : 0)
      << ",\"baseSeconds\":" << baseSeconds << ",\"burstSeconds\":" << burstSeconds << ",\"peakRssKiB\":" << peakRss << ",\"peakSpoolBytes\":" << peakSpool
      << ",\"shimHits\":" << (shimHits ? shimHits() : 0)
      << ",\"statsBeforeStop\":" << statsJson(before) << ",\"stats\":" << statsJson(fin)
      << ",\"disk\":{\"segmentsRead\":" << seen.size() << ",\"segmentsListedAtEnd\":" << sealedNow.size() << ",\"retiredAfterRead\":" << retiredRead
      << ",\"unreadSegments\":" << unread << ",\"quoteRecords\":" << quotes << ",\"gapRecords\":" << gapsOnDisk
      << ",\"truncatedSegments\":" << truncated << ",\"unsealedFiles\":" << leftovers.size() << ",\"unsealedQuoteRecords\":" << unsealedQuotes
      << ",\"gapBids\":{\"queueOverflow\":" << gapBids[GAP_QUEUE_OVERFLOW] << ",\"reservePause\":" << gapBids[GAP_RESERVE_PAUSE]
      << ",\"reconnect\":" << gapBids[GAP_RECONNECT] << ",\"restart\":" << gapBids[GAP_RESTART] << ",\"switchedOff\":" << gapBids[GAP_SWITCHED_OFF] << "}"
      << ",\"gapRecordsByReason\":{\"queueOverflow\":" << gapRecords[GAP_QUEUE_OVERFLOW] << ",\"reservePause\":" << gapRecords[GAP_RESERVE_PAUSE]
      << ",\"reconnect\":" << gapRecords[GAP_RECONNECT] << ",\"restart\":" << gapRecords[GAP_RESTART] << ",\"switchedOff\":" << gapRecords[GAP_SWITCHED_OFF] << "}}"
      << ",\"quotesWritten\":" << quotesWritten
      << ",\"unaccountedLoss\":";
  if (unread > 0) out << "null";
  else out << (lost > 0 ? lost : 0);
  out << ",\"surplus\":" << (lost < 0 ? -lost : 0) << "}}";
  std::printf("%s\n", out.str().c_str());
  if (unread > 0) return 1;
  return lost != 0 ? 1 : 0;
}
