// cpp-exec/src/spsc_ring.hpp
//
// Lock-free single-producer / single-consumer ring buffer (item #1 of the
// four real low-latency items). One writer thread, one reader thread, no
// mutex on the hot path. Capacity is rounded up to a power of two so the
// wrap is a mask, not a modulo. The head/tail indices sit on separate
// cache lines (alignas(64)) so the producer's store to `head_` never
// invalidates the consumer's cache line holding `tail_` — the "false
// sharing" the nano-trading prompt asked to avoid, applied where it
// actually helps: a bounded queue between two threads inside this process.
//
// This is NOT the Node<->C++ transport swap (that needs native Node
// bindings and buys single-digit ms in front of a ~100ms broker hop — not
// worth the risk; see the PR notes). It's the internal primitive that backs
// the async telemetry logger, so the hot path never blocks on I/O.
#pragma once

#include <atomic>
#include <cstddef>
#include <new>
#include <optional>
#include <vector>

template <typename T>
class SpscRing {
public:
  explicit SpscRing(size_t capacity) {
    size_t cap = 1;
    while (cap < capacity) cap <<= 1;      // round up to a power of two
    if (cap < 2) cap = 2;
    mask_ = cap - 1;
    buf_.resize(cap);
  }

  // Producer thread only. Returns false when full (caller drops — a dropped
  // telemetry record must never stall the trade path).
  bool push(const T& item) {
    const size_t head = head_.load(std::memory_order_relaxed);
    const size_t next = (head + 1) & mask_;
    if (next == tail_.load(std::memory_order_acquire)) return false; // full
    buf_[head] = item;
    head_.store(next, std::memory_order_release);
    return true;
  }

  // Consumer thread only.
  std::optional<T> pop() {
    const size_t tail = tail_.load(std::memory_order_relaxed);
    if (tail == head_.load(std::memory_order_acquire)) return std::nullopt; // empty
    T item = buf_[tail];
    tail_.store((tail + 1) & mask_, std::memory_order_release);
    return item;
  }

  bool empty() const {
    return head_.load(std::memory_order_acquire) == tail_.load(std::memory_order_acquire);
  }
  size_t capacity() const { return mask_ + 1; }

private:
  // Separate cache lines: the producer writes head_, the consumer writes
  // tail_ — keeping them apart stops one thread's write from evicting the
  // other's read set.
  alignas(64) std::atomic<size_t> head_{0};
  alignas(64) std::atomic<size_t> tail_{0};
  alignas(64) std::vector<T> buf_;
  size_t mask_ = 0;
};
