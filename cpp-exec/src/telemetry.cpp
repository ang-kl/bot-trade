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
  while (true) {
    bool didWork = false;
    if (f) {
      while (auto rec = ring_.pop()) {
        std::fwrite(&*rec, sizeof(TelemetryRecord), 1, f);
        written_.fetch_add(1, std::memory_order_relaxed);
        didWork = true;
      }
      if (didWork) std::fflush(f);
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
