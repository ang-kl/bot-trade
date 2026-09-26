// cpp-exec/src/tests/test_term_seal.cpp — GW-1 (V3-SEQUENCE item 38, P8c
// item 1): the SIGTERM seal, in a FORKED child that runs the same shape as
// main.cpp — signals blocked before any thread, a recorder recording while a
// feed thread keeps delivering, and the watcher that seals and exits.
//
// What makes this test able to fail (V3-SEQUENCE risk 4, "tests that pass by
// construction"): the child really receives SIGTERM from another process,
// with the feed still pushing, and the parent judges only what is on disk and
// the exit status. Remove the mask or the watcher and the child dies by the
// signal (WIFSIGNALED, no 143) with its ".open" unsealed; remove the seal and
// the ".open" survives. The 2 s bound is runuser's SIGKILL delay, measured.
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <dirent.h>
#include <signal.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <thread>
#include <vector>

#include "../term_seal.hpp"
#include "../tick_recorder.hpp"

using namespace tick;

namespace {

std::string tmpSpool() {
  const char* t = std::getenv("TMPDIR");
  std::string tmpl = std::string(t && *t ? t : "/tmp") + "/term_seal_XXXXXX";
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

uint64_t nowMs() {
  using namespace std::chrono;
  return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

// The child: main.cpp's order of operations, then quotes until killed.
[[noreturn]] void child(const std::string& dir) {
  if (!term_seal::blockTermSignals()) std::_Exit(2);
  RecorderConfig c;
  c.spoolDir = dir;
  c.feedId = "demo.ctraderapi.com/test";
  c.queueRecords = 1u << 14;
  c.fsyncEveryMs = 50;
  c.budgetCheckEveryMs = 1000;
  static TickRecorder rec(c, [](const std::string&, uint64_t& a, uint64_t& t) { a = 40ull << 30; t = 50ull << 30; return true; });
  if (!rec.start()) std::_Exit(3);
  rec.setRecording(true);
  term_seal::startTermWatcher([](int) { rec.stop(); });
  std::thread feed([] {
    for (long long i = 0;; ++i) {
      rec.onQuote(41 + (i % 3), true, 100000 + (i % 17), true, 100010 + (i % 13), nowMs(), 1);
      if (i % 64 == 0) std::this_thread::sleep_for(std::chrono::microseconds(200));
    }
  });
  feed.detach();
  for (;;) std::this_thread::sleep_for(std::chrono::seconds(1));
}

} // namespace

static void test_sigterm_seals_the_spool_and_exits_143() {
  const std::string dir = tmpSpool();
  const pid_t pid = ::fork();
  assert(pid >= 0);
  if (pid == 0) child(dir);
  // Wait until the child is recording to an open segment.
  bool open = false;
  for (int i = 0; i < 400 && !open; ++i) { open = !listFiles(dir, ".tks.open").empty(); if (!open) std::this_thread::sleep_for(std::chrono::milliseconds(5)); }
  assert(open && "the child never opened a segment");
  std::this_thread::sleep_for(std::chrono::milliseconds(150)); // records in flight, some fsynced, some not
  const auto t0 = std::chrono::steady_clock::now();
  assert(::kill(pid, SIGTERM) == 0);
  int status = 0;
  pid_t got = 0;
  for (int i = 0; i < 1000 && got == 0; ++i) {
    got = ::waitpid(pid, &status, WNOHANG);
    if (got == 0) std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  if (got == 0) { ::kill(pid, SIGKILL); ::waitpid(pid, &status, 0); assert(false && "the child did not exit within 2 s of SIGTERM"); }
  const long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
  std::printf("SIGTERM → exit in %lld ms, status %s %d\n", ms, WIFEXITED(status) ? "exit" : "signal", WIFEXITED(status) ? WEXITSTATUS(status) : WTERMSIG(status));
  assert(WIFEXITED(status) && WEXITSTATUS(status) == 143);
  assert(ms < 2000); // runuser's SIGKILL came at 2 s; the seal must finish well inside it
  assert(listFiles(dir, ".tks.open").empty() && "no open segment survives the seal");
  assert(listFiles(dir, ".torn").empty());
  const auto sealed = listFiles(dir, ".tks");
  assert(!sealed.empty());
  const SegmentRead last = readSegment(sealed.back());
  assert(last.headerOk && !last.truncated && !last.records.empty()); // every record passes its CRC
  const SegmentRead first = readSegment(sealed.front());
  assert(first.records[0].kind == GAP && first.records[0].ask == GAP_RESTART && first.records[0].bid == 0);
  std::puts("SIGTERM seals the spool and exits 143: ok");
}

// Without the mask the same child dies by the signal with its segment open:
// the control case — it shows the test above can tell the difference.
static void test_without_the_watcher_sigterm_leaves_the_segment_open() {
  const std::string dir = tmpSpool();
  const pid_t pid = ::fork();
  assert(pid >= 0);
  if (pid == 0) {
    RecorderConfig c;
    c.spoolDir = dir;
    c.feedId = "demo.ctraderapi.com/test";
    c.queueRecords = 1u << 14;
    static TickRecorder rec(c, [](const std::string&, uint64_t& a, uint64_t& t) { a = 40ull << 30; t = 50ull << 30; return true; });
    if (!rec.start()) std::_Exit(3);
    rec.setRecording(true);
    for (long long i = 0;; ++i) {
      rec.onQuote(41, true, 100000 + (i % 17), true, 100010, nowMs(), 1);
      if (i % 64 == 0) std::this_thread::sleep_for(std::chrono::microseconds(200));
    }
  }
  bool open = false;
  for (int i = 0; i < 400 && !open; ++i) { open = !listFiles(dir, ".tks.open").empty(); if (!open) std::this_thread::sleep_for(std::chrono::milliseconds(5)); }
  assert(open);
  assert(::kill(pid, SIGTERM) == 0);
  int status = 0;
  ::waitpid(pid, &status, 0);
  assert(WIFSIGNALED(status) && WTERMSIG(status) == SIGTERM);
  assert(listFiles(dir, ".tks.open").size() == 1 && "the default action leaves the tail open");
  std::puts("control: default SIGTERM leaves the segment open: ok");
}

int main() {
  test_without_the_watcher_sigterm_leaves_the_segment_open();
  test_sigterm_seals_the_spool_and_exits_143();
  std::puts("test_term_seal: all passed");
  return 0;
}
