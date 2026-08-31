// cpp-exec/src/peer_probe.hpp
//
// PeerProbe — minimal mutual liveness between the two deployed instances of
// this binary (2026-08-31 supervision plan, PR-B; owner scope decision:
// "both layers", liveness-ONLY).
//
// The two sidecars (cpp-exec live / cpp-acct demo, same source) were
// mutually invisible: each is supervised solely by the Node keeper's
// ~2-minute poll, so "the keeper's path to a sidecar broke" and "the sidecar
// is dead" were indistinguishable, and while the keeper itself is down
// NOTHING observes either process. This probe closes both: each instance
// GETs its peer's /health every 60s over Railway private networking
// (http://<peer>.railway.internal:<port> — plain sockets, no TLS), records
// up/down transitions in the decision ring (readable after the keeper
// recovers), and reports peer state on its own /health so the keeper can
// triangulate.
//
// HARD LIMITS, by design: no retries-with-backoff sophistication, no
// peer-triggered behaviour EVER (a false "peer down" must never be able to
// halt trading), no TLS. PEER_URL unset = feature off = today's binary.
#pragma once

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>

class DecisionRing;

// Parse "http://host:port[/path]" → parts. Returns false (and leaves outputs
// untouched) for anything else — https is deliberately unsupported, the
// private network doesn't need it and a TLS client is what this slice avoids.
bool parsePeerUrl(const std::string& url, std::string& host, int& port, std::string& path);

// Extract the HTTP status code from a raw response buffer ("HTTP/1.1 200 …").
// Returns -1 when the buffer is not an HTTP response. Pure — unit-tested
// without sockets (test_frames.cpp idiom).
int parseHttpStatus(const std::string& raw);

class PeerProbe {
public:
  // Starts the probe thread when url parses; a bad url logs once and stays
  // off. `ring` may be null (transitions then go unrecorded but state still
  // serves /health).
  void start(const std::string& url, DecisionRing* ring, int intervalSec = 60);
  void stop();

  bool enabled() const { return enabled_.load(std::memory_order_relaxed); }
  bool peerOk() const { return peerOk_.load(std::memory_order_relaxed); }
  long long lastOkAtMs() const { return lastOkAtMs_.load(std::memory_order_relaxed); }
  long long consecutiveFails() const { return fails_.load(std::memory_order_relaxed); }
  std::string lastError();

private:
  void runLoop(int intervalSec);
  bool probeOnce(std::string& err); // one GET /health against the peer

  std::string host_, path_;
  int port_ = 0;
  DecisionRing* ring_ = nullptr;

  std::thread worker_;
  std::atomic<bool> running_{false};
  std::atomic<bool> enabled_{false};
  std::atomic<bool> peerOk_{false};
  std::atomic<long long> lastOkAtMs_{0};
  std::atomic<long long> fails_{0};
  std::mutex errMtx_;
  std::string lastError_;
  // Interruptible sleep so stop() never waits out a full interval (the
  // SpotFeed stoppable-sleep pattern, audit C2).
  std::mutex stopMtx_;
  std::condition_variable stopCv_;
  // Hysteresis: report DOWN only after this many consecutive failures — a
  // 60s blip must not spam the ring.
  static constexpr long long kDownAfter = 3;
  bool reportedDown_ = false; // worker thread only
};
