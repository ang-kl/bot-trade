#include "journal.hpp"

#include <cerrno>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <sys/stat.h>
#include <sys/types.h>

namespace verify {

namespace {

// One file per month, so a year of verdicts is twelve readable files — the
// same scheme the Node-side archive uses (services/position-capture.js), so
// both sides of the record can be read with one tool.
std::string monthStamp(long long epochMs) {
  std::time_t secs = static_cast<std::time_t>(epochMs / 1000);
  std::tm tm{};
  gmtime_r(&secs, &tm);
  char buf[16];
  std::snprintf(buf, sizeof(buf), "%04d-%02d", tm.tm_year + 1900, tm.tm_mon + 1);
  return std::string(buf);
}

long long nowMs() {
  struct timespec ts{};
  clock_gettime(CLOCK_REALTIME, &ts);
  return static_cast<long long>(ts.tv_sec) * 1000 + ts.tv_nsec / 1000000;
}

}  // namespace

std::string Journal::pathFor(long long epochMs) const {
  if (dir_.empty()) return {};
  return dir_ + "/verdicts-" + monthStamp(epochMs) + ".jsonl";
}

void Journal::open(const std::string& dir) {
  std::lock_guard<std::mutex> lk(mtx_);
  dir_ = dir;
  writable_ = false;
  lastError_.clear();
  if (dir_.empty()) return;

  // mkdir is allowed to fail with EEXIST; anything else is the real answer.
  if (::mkdir(dir_.c_str(), 0775) != 0 && errno != EEXIST) {
    lastError_ = std::string("mkdir: ") + std::strerror(errno);
    return;
  }

  // A REAL APPEND, not access(). A mounted volume can pass every stat and
  // still refuse the write — and a journal that reports healthy while
  // dropping every line is the failure this check exists to prevent.
  const std::string path = pathFor(nowMs());
  std::FILE* f = std::fopen(path.c_str(), "a");
  if (!f) {
    lastError_ = std::string("open ") + path + ": " + std::strerror(errno);
    return;
  }
  // The boot line is itself a journal entry: it dates the moment this service
  // started being able to write, which is the first thing anyone auditing the
  // trail will want to know.
  const std::string boot =
      "{\"kind\":\"journal_open\",\"atMs\":" + std::to_string(nowMs()) + "}\n";
  const bool ok = std::fwrite(boot.data(), 1, boot.size(), f) == boot.size();
  if (!ok) lastError_ = std::string("write: ") + std::strerror(errno);
  if (std::fclose(f) != 0 && ok) lastError_ = std::string("close: ") + std::strerror(errno);
  writable_ = ok && lastError_.empty();
  if (writable_) ++written_;
}

bool Journal::append(const std::string& line) {
  std::lock_guard<std::mutex> lk(mtx_);
  if (dir_.empty()) return false;

  const std::string path = pathFor(nowMs());
  std::FILE* f = std::fopen(path.c_str(), "a");
  if (!f) {
    lastError_ = std::string("open ") + path + ": " + std::strerror(errno);
    writable_ = false;
    return false;
  }
  std::string out = line;
  if (out.empty() || out.back() != '\n') out.push_back('\n');
  const bool ok = std::fwrite(out.data(), 1, out.size(), f) == out.size();
  if (!ok) lastError_ = std::string("write: ") + std::strerror(errno);
  std::fclose(f);
  if (ok) {
    ++written_;
    // A later success CLEARS a stale error: otherwise /health would report a
    // transient failure for ever and nobody would trust the field.
    lastError_.clear();
    writable_ = true;
  } else {
    writable_ = false;
  }
  return ok;
}

Journal& journal() {
  static Journal j;
  return j;
}

}  // namespace verify
