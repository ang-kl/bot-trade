// cpp-exec/src/telemetry.cpp
#include "telemetry.hpp"

#include <chrono>
#include <cstdio>

Telemetry::Telemetry(size_t capacity, std::string path)
    : ring_(capacity), path_(std::move(path)) {
  worker_ = std::thread([this] { run(); });
}

Telemetry::~Telemetry() {
  stop_.store(true, std::memory_order_release);
  if (worker_.joinable()) worker_.join();
}

bool Telemetry::log(const TelemetryRecord& rec) {
  if (ring_.push(rec)) return true;
  dropped_.fetch_add(1, std::memory_order_relaxed);
  return false;
}

void Telemetry::run() {
  // Open in append-binary; buffered writes flushed each drain pass.
  std::FILE* f = std::fopen(path_.c_str(), "ab");
  // An unopenable path used to fail in complete silence AND leave the ring
  // permanently full (audit #11) — say it once, then drain-and-drop so the
  // dropped_ counter on /health tells the story instead of a wedged ring.
  if (!f) std::fprintf(stderr, "[telemetry] cannot open %s — records will be dropped\n", path_.c_str());
  // Rotate at 64 MiB (~1.7M records): the volume this file lives on is the
  // same fixed Railway mount the agent DB uses; unbounded growth there is
  // how bot-trade-vol alerts happen. One .1 generation is kept.
  constexpr long kRotateBytes = 64L << 20;
  while (true) {
    bool didWork = false;
    while (auto rec = ring_.pop()) {
      didWork = true;
      if (!f) { dropped_.fetch_add(1, std::memory_order_relaxed); continue; }
      std::fwrite(&*rec, sizeof(TelemetryRecord), 1, f);
      written_.fetch_add(1, std::memory_order_relaxed);
    }
    if (f && didWork) {
      std::fflush(f);
      if (std::ftell(f) > kRotateBytes) {
        std::fclose(f);
        const std::string old = path_ + ".1";
        std::remove(old.c_str());
        std::rename(path_.c_str(), old.c_str());
        f = std::fopen(path_.c_str(), "ab");
        if (!f) std::fprintf(stderr, "[telemetry] reopen after rotation failed — records will be dropped\n");
      }
    }
    // Exit only once the producer has stopped AND the ring is drained, so no
    // record queued before shutdown is lost.
    if (stop_.load(std::memory_order_acquire) && ring_.empty()) break;
    if (!didWork) std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  if (f) std::fclose(f);
}

void Telemetry::flush() {
  // Spin until the ring is drained by the worker. Cheap: only used by tests
  // and shutdown, never the hot path.
  while (!ring_.empty()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
  std::this_thread::sleep_for(std::chrono::milliseconds(5)); // let the last fwrite/fflush land
}
