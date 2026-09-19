// cpp-exec/src/tests/test_log_streams.cpp — the stream IS the severity.
//
// Railway maps stdout → info and stderr → error for raw log streams, so a
// logInfo that lands on stderr is an "error" that can never be alerted on
// (audit 2026-09-19 §K item 17: every sidecar line was one). This test
// redirects both streams to files, writes one line of each kind and reads
// the files back: each line must be on its own stream, absent from the
// other, and the stdout line must be visible BEFORE any exit-time flush —
// stdout on a pipe is fully buffered, and a line that only appears when the
// process exits is a line a crash loses.
//
// Build: part of `make test` (every src/tests/*.cpp gets its own binary).
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <unistd.h>

#include "../log.hpp"

static std::string slurp(const std::string& path) {
  std::string out;
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (!f) return out;
  char buf[4096];
  size_t n;
  while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) out.append(buf, n);
  std::fclose(f);
  return out;
}

static bool has(const std::string& hay, const std::string& needle) {
  return hay.find(needle) != std::string::npos;
}

int main() {
  char outPath[] = "/tmp/test_log_streams_out_XXXXXX";
  char errPath[] = "/tmp/test_log_streams_err_XXXXXX";
  const int outFd = mkstemp(outPath);
  const int errFd = mkstemp(errPath);
  assert(outFd >= 0 && errFd >= 0);

  // Keep the real streams so the verdict can still be printed afterwards.
  const int savedOut = dup(STDOUT_FILENO);
  const int savedErr = dup(STDERR_FILENO);
  assert(savedOut >= 0 && savedErr >= 0);
  std::fflush(stdout);
  std::fflush(stderr);
  assert(dup2(outFd, STDOUT_FILENO) == STDOUT_FILENO);
  assert(dup2(errFd, STDERR_FILENO) == STDERR_FILENO);
  // Full buffering on stdout is the production condition on a pipe; force it
  // here so a missing fflush in the header shows up rather than hiding
  // behind a line-buffered terminal.
  setvbuf(stdout, nullptr, _IOFBF, 1 << 16);

  sidecar_log::logInfo("[test]", "info line one");
  sidecar_log::logError("[test]", "error line one");
  sidecar_log::logWarn("[test]", "warn line one");
  sidecar_log::logInfoF("[test]", "info line %d of %s", 2, "two");
  sidecar_log::logErrorF("[test]", "error line %d of %s", 2, "two");

  // READ BACK WITHOUT FLUSHING — the header must have flushed already. The
  // files are read through independent descriptors, so anything still in
  // this process's stdio buffer is invisible here, which is the point.
  const std::string outText = slurp(outPath);
  const std::string errText = slurp(errPath);

  // Restore before asserting so a failure is printed somewhere visible.
  dup2(savedOut, STDOUT_FILENO);
  dup2(savedErr, STDERR_FILENO);
  close(savedOut);
  close(savedErr);
  close(outFd);
  close(errFd);
  unlink(outPath);
  unlink(errPath);

  // stdout: exactly the info lines, flushed, prefixed.
  assert(has(outText, "[test] info line one\n"));
  assert(has(outText, "[test] info line 2 of two\n"));
  assert(!has(outText, "error line"));
  assert(!has(outText, "warn line"));
  // stderr: the error and warn lines, none of the info lines.
  assert(has(errText, "[test] error line one\n"));
  assert(has(errText, "[test] error line 2 of two\n"));
  assert(has(errText, "[test] warn line one\n"));
  assert(!has(errText, "info line"));
  // One line per call, no fragments: each line starts with its prefix.
  assert(outText.rfind("[test] ", 0) == 0);
  assert(errText.rfind("[test] ", 0) == 0);

  std::printf("test_log_streams: all passed\n");
  return 0;
}
