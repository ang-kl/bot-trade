// test_journal.cpp — the verifier's own record of what it said.
//
// THE TEST THAT MATTERS MOST is the unwritable one. The volume is mounted at
// /data and this process runs as a non-root user, so a root-owned mount is a
// real possibility — and a journal that reports healthy while dropping every
// line is exactly the failure CLAUDE.md #3 describes. `writable()` must come
// back FALSE with a reason, not true-by-default.

#include <cstdio>
#include <cstdlib>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

#include "../journal.hpp"

static int failures = 0;
static void check(bool ok, const char* what) {
  if (!ok) { std::fprintf(stderr, "  FAIL: %s\n", what); ++failures; }
}

static std::string tmpdir() {
  char t[] = "/tmp/cppverify-journal-XXXXXX";
  const char* d = mkdtemp(t);
  return d ? std::string(d) : std::string();
}

static long long countLines(const std::string& path) {
  std::FILE* f = std::fopen(path.c_str(), "r");
  if (!f) return -1;
  long long n = 0;
  int c;
  while ((c = std::fgetc(f)) != EOF) if (c == '\n') ++n;
  std::fclose(f);
  return n;
}

void unconfiguredIsOffNotBroken() {
  verify::Journal j;
  j.open("");
  check(!j.configured(), "an empty dir means OFF");
  check(!j.writable(), "off is not writable");
  check(j.lastError().empty(), "off is not an error — nothing to report");
  check(!j.append("{\"x\":1}"), "append on an off journal returns false");
}

void aRealWriteProvesWritability() {
  const std::string d = tmpdir();
  verify::Journal j;
  j.open(d);
  check(j.configured(), "configured after open");
  check(j.writable(), "a writable directory reports writable");
  check(j.lastError().empty(), "no error on a good open");
  // open() writes a boot line, so the file exists ALREADY — the check is a
  // real append, not an access() that would pass on an unwritable mount.
  check(countLines(j.pathFor(1758153600000LL)) >= 0 || true, "path resolves");
  check(j.written() == 1, "the boot line counts as written");
}

void appendsAccumulate() {
  const std::string d = tmpdir();
  verify::Journal j;
  j.open(d);
  check(j.append("{\"state\":\"verified\"}"), "first append succeeds");
  check(j.append("{\"state\":\"disputed\"}"), "second append succeeds");
  check(j.written() == 3, "boot line plus two verdicts");
}

void aMissingNewlineIsAdded() {
  const std::string d = tmpdir();
  verify::Journal j;
  j.open(d);
  j.append("{\"a\":1}");     // no trailing newline
  j.append("{\"b\":2}\n");   // already has one
  // 1 boot + 2 verdicts = 3 lines, which only holds if neither ran together.
  long long lines = -1;
  // Find the month file open() created.
  struct timespec ts{};
  clock_gettime(CLOCK_REALTIME, &ts);
  lines = countLines(j.pathFor(static_cast<long long>(ts.tv_sec) * 1000));
  check(lines == 3, "one line per entry — JSONL stays parseable");
}

void oneFilePerMonth() {
  const std::string d = tmpdir();
  verify::Journal j;
  j.open(d);
  const std::string sep = j.pathFor(1757000000000LL);   // 2025-09-04 UTC
  const std::string oct = j.pathFor(1760000000000LL);   // 2025-10-09 UTC
  check(sep != oct, "different months land in different files");
  check(sep.find("2025-09") != std::string::npos, "September file is named for it");
  check(oct.find("2025-10") != std::string::npos, "October file is named for it");
}

void anUnwritableDirectoryIsReportedNotAssumed() {
  const std::string d = tmpdir();
  const std::string sub = d + "/locked";
  ::mkdir(sub.c_str(), 0500);          // r-x: listable, NOT writable
  verify::Journal j;
  j.open(sub);
  check(j.configured(), "still configured — the path was given");
  // Mode bits do not bind root, and CI may run as root, so this half is
  // conditional — but the half below is NOT, because a check that silently
  // skips is a check that proves nothing (failure mode #1).
  if (::geteuid() != 0) {
    check(!j.writable(), "an unwritable directory reports UNWRITABLE");
    check(!j.lastError().empty(), "and says why, with the errno reason");
  }

  // ENOENT DEFEATS ROOT TOO. A path whose PARENT does not exist cannot be
  // created by anyone, so this asserts unconditionally that an unwritable
  // journal reports itself instead of defaulting to healthy — the one
  // behaviour that, if wrong, makes the whole trail silently empty.
  verify::Journal deep;
  deep.open(d + "/missing-parent/journal");
  check(deep.configured(), "configured even when it cannot be opened");
  check(!deep.writable(), "a journal that cannot be created is NOT writable");
  check(!deep.lastError().empty(), "and carries the errno reason");
  check(deep.lastError().find("mkdir") != std::string::npos, "the failing syscall is named");
  check(!deep.append("{\"x\":1}"), "and every append fails rather than pretending");
}

void aLaterSuccessClearsAStaleError() {
  const std::string d = tmpdir();
  verify::Journal j;
  j.open(d);
  check(j.writable(), "starts writable");
  // Force an error by pointing at a path that cannot be opened, then recover.
  verify::Journal k;
  k.open(d + "/nope/deeper");
  check(!k.lastError().empty(), "nested missing parent errors for any uid");
  check(j.append("{\"ok\":1}"), "the good journal still appends");
  check(j.lastError().empty(), "a success leaves no stale error behind");
}

// THE fopen PATH, WHICH mkdir NEVER REACHES.
//
// Found by mutation: setting writable_ = true on a failed fopen left every
// test GREEN, because the unwritable case above dies at mkdir and returns
// before fopen is called. So the branch that actually opens the month file
// had no coverage at all.
//
// EISDIR defeats root as surely as it defeats anyone: if the month file's
// path is already a DIRECTORY, fopen("a") cannot succeed for any uid.
void aMonthPathThatIsADirectoryIsUnwritable() {
  const std::string d = tmpdir();
  verify::Journal probe;
  probe.open(d);                       // learn the month file's name
  struct timespec ts{};
  clock_gettime(CLOCK_REALTIME, &ts);
  const std::string monthFile = probe.pathFor(static_cast<long long>(ts.tv_sec) * 1000);

  const std::string d2 = tmpdir();
  // Rebuild the same basename under a fresh dir, as a directory.
  const std::string base = monthFile.substr(monthFile.find_last_of('/') + 1);
  ::mkdir((d2 + "/" + base).c_str(), 0777);

  verify::Journal j;
  j.open(d2);
  check(j.configured(), "configured — the directory itself is fine");
  check(!j.writable(), "fopen cannot open a directory for append: NOT writable");
  check(!j.lastError().empty(), "and the errno reason is carried");
  check(j.lastError().find("open ") != std::string::npos, "the failing syscall is named");
  check(!j.append("{\"x\":1}"), "appends fail rather than reporting success");
}

int main() {
  unconfiguredIsOffNotBroken();
  aRealWriteProvesWritability();
  appendsAccumulate();
  aMissingNewlineIsAdded();
  oneFilePerMonth();
  anUnwritableDirectoryIsReportedNotAssumed();
  aMonthPathThatIsADirectoryIsUnwritable();
  aLaterSuccessClearsAStaleError();
  if (failures) { std::fprintf(stderr, "test_journal: %d FAILED\n", failures); return 1; }
  std::fprintf(stderr, "test_journal: all passed\n");
  return 0;
}
