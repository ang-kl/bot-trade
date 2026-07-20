// cpp-exec/src/tests/test_telemetry.cpp — async binary logger.
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include <unistd.h>

#include "../telemetry.hpp"

static std::string tmpPath() {
  char buf[] = "/tmp/cppexec_telemetry_XXXXXX";
  int fd = mkstemp(buf);
  if (fd >= 0) close(fd);
  return std::string(buf);
}

// Log N records, flush, read the binary file back into the struct array and
// confirm every field round-tripped in order — the whole point of a fixed
// POD binary format is that parsing is a straight read.
static void test_roundtrip() {
  const std::string path = tmpPath();
  const int N = 5000;
  {
    Telemetry t(1024, path);
    for (int i = 0; i < N; i++) {
      TelemetryRecord r{};
      r.ts_ms = 1000 + i;
      r.kind = TK_ORDER_SUBMIT;
      r.symbol_id = i;
      r.volume = i * 10.0;
      r.price = i * 0.5;
      r.verdict = 1;
      r.reason_code = 0;
      // Non-blocking; a full ring returns false (counted as a drop) — the
      // hot path would move on, but here we retry so every record lands, to
      // prove the binary round-trip. Each retry-on-full still bumps the drop
      // counter, which is the correct production semantic (one log() attempt
      // = drop-if-full); so we assert on WRITTEN, not dropped.
      while (!t.log(r)) { /* let the drain thread catch up */ }
    }
    t.flush();
    assert(t.written() == (uint64_t)N); // every record reached the file
  } // dtor joins the worker

  std::FILE* f = std::fopen(path.c_str(), "rb");
  assert(f);
  std::vector<TelemetryRecord> back(N);
  size_t got = std::fread(back.data(), sizeof(TelemetryRecord), N, f);
  std::fclose(f);
  assert((int)got == N);
  for (int i = 0; i < N; i++) {
    assert(back[i].ts_ms == (uint64_t)(1000 + i));
    assert(back[i].symbol_id == i);
    assert(back[i].volume == i * 10.0);
    assert(back[i].kind == TK_ORDER_SUBMIT);
  }
  std::remove(path.c_str());
}

// A dropped record must never block the producer — fill a tiny ring faster
// than it drains and confirm log() keeps returning (some false), never hangs.
static void test_drop_never_blocks() {
  const std::string path = tmpPath();
  Telemetry t(8, path);
  uint64_t ok = 0, dropped = 0;
  for (int i = 0; i < 100000; i++) {
    TelemetryRecord r{};
    r.ts_ms = i;
    if (t.log(r)) ok++; else dropped++;
  }
  // The producer never blocked; some landed, and the drop counter agrees.
  assert(ok + dropped == 100000);
  assert(t.dropped() == dropped);
  std::remove(path.c_str());
}

int main() {
  test_roundtrip();
  test_drop_never_blocks();
  std::puts("test_telemetry: all assertions passed");
  return 0;
}
