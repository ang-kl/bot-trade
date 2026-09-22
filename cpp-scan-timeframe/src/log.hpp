// cpp-exec/src/log.hpp — the one place a sidecar line picks its stream.
//
// WHY TWO STREAMS. Railway attaches a severity to each raw log line by the
// stream it arrived on: stdout → info, stderr → error. There is no warn level
// for raw streams and no way to tag a line otherwise. Until this header every
// sidecar line went to stderr, so "TELEMETRY_PATH not set — order telemetry
// disabled" carried severity error (measured in the uploaded logs, audit
// 2026-09-19 §K item 17) and an alert on severity error could never be set
// without paging on every boot line.
//
// So the split IS the classification: a line that reports a failure, a
// refusal, a disconnect, a dropped record, a stale or rejected state or a
// guard firing goes through logError (stderr); everything else — boot lines,
// config echoes, "not set — disabled" notices, connections established,
// subscription counts, periodic status — goes through logInfo (stdout).
// logWarn exists so the intent is readable at the call site, but it lands on
// stderr too: Railway has nowhere else to put it.
//
// stdout is FLUSHED after every line. Railway reads the stream through a pipe
// and glibc fully buffers stdout on a pipe (4 KiB), so without the flush an
// info line can sit in the process for minutes and a crash loses it outright
// — which would make stdout the stream that swallows the boot lines. stderr is
// unbuffered by the C standard, so it needs nothing.
//
// This header is VENDORED into cpp-verify/src/ byte-for-byte (see
// agent/services/sidecar-pins.test.js) because http_server.cpp includes it.
#pragma once

#include <cstdarg>
#include <cstdio>
#include <string>

namespace sidecar_log {

// The stream is the severity. Each line is written with one fprintf call, so
// concurrent writers interleave by whole line, never by fragment.
inline void writeLine(std::FILE* stream, const char* prefix, const std::string& msg) {
  std::fprintf(stream, "%s %s\n", prefix, msg.c_str());
  if (stream == stdout) std::fflush(stdout);
}

// Informational — stdout, Railway severity info.
inline void logInfo(const char* prefix, const std::string& msg) { writeLine(stdout, prefix, msg); }
// A failure, refusal, disconnect, dropped record, stale/rejected state or a
// guard firing — stderr, Railway severity error.
inline void logError(const char* prefix, const std::string& msg) { writeLine(stderr, prefix, msg); }
// Same stream as logError: raw streams carry no warn level.
inline void logWarn(const char* prefix, const std::string& msg) { writeLine(stderr, prefix, msg); }

// printf-style variants for call sites that already format with %d/%s.
inline std::string vformat(const char* fmt, va_list ap) {
  va_list copy;
  va_copy(copy, ap);
  const int n = std::vsnprintf(nullptr, 0, fmt, copy);
  va_end(copy);
  if (n < 0) return std::string(fmt);
  std::string out(static_cast<size_t>(n) + 1, '\0');
  std::vsnprintf(out.data(), out.size(), fmt, ap);
  out.resize(static_cast<size_t>(n));
  return out;
}

__attribute__((format(printf, 2, 3)))
inline void logInfoF(const char* prefix, const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  const std::string msg = vformat(fmt, ap);
  va_end(ap);
  logInfo(prefix, msg);
}

__attribute__((format(printf, 2, 3)))
inline void logErrorF(const char* prefix, const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  const std::string msg = vformat(fmt, ap);
  va_end(ap);
  logError(prefix, msg);
}

} // namespace sidecar_log
