// cpp-exec/src/peer_probe.cpp — see peer_probe.hpp.
#include "peer_probe.hpp"

#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <netdb.h>
#include <sys/socket.h>
#include <unistd.h>

#include "decision_ring.hpp"

using namespace std::chrono;

static void logLine(const std::string& msg) {
  std::fprintf(stderr, "[peer-probe] %s\n", msg.c_str());
}

static long long nowMsPeer() {
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

bool parsePeerUrl(const std::string& url, std::string& host, int& port, std::string& path) {
  const std::string prefix = "http://";
  if (url.rfind(prefix, 0) != 0) return false;
  const std::string rest = url.substr(prefix.size());
  const size_t slash = rest.find('/');
  const std::string hostport = slash == std::string::npos ? rest : rest.substr(0, slash);
  const std::string p = slash == std::string::npos ? "/health" : rest.substr(slash);
  const size_t colon = hostport.find(':');
  if (colon == std::string::npos || colon == 0) return false;
  const int prt = std::atoi(hostport.substr(colon + 1).c_str());
  if (prt <= 0 || prt > 65535) return false;
  host = hostport.substr(0, colon);
  port = prt;
  path = p;
  return true;
}

int parseHttpStatus(const std::string& raw) {
  // "HTTP/1.x SSS ..." — minimum viable, and pure so it is testable.
  if (raw.rfind("HTTP/", 0) != 0) return -1;
  const size_t sp = raw.find(' ');
  if (sp == std::string::npos || sp + 4 > raw.size()) return -1;
  const std::string code = raw.substr(sp + 1, 3);
  if (code.size() != 3 || !isdigit((unsigned char)code[0])) return -1;
  return std::atoi(code.c_str());
}

bool PeerProbe::probeOnce(std::string& err) {
  // Plain blocking TCP with an overall alarm via SO_RCVTIMEO/SO_SNDTIMEO —
  // this thread has nothing else to do, and stop() only needs the sleep to
  // be interruptible, not the (bounded) socket I/O.
  struct addrinfo hints {};
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  struct addrinfo* res = nullptr;
  const std::string portStr = std::to_string(port_);
  if (getaddrinfo(host_.c_str(), portStr.c_str(), &hints, &res) != 0 || !res) {
    err = "dns: cannot resolve " + host_;
    return false;
  }
  int fd = -1;
  for (struct addrinfo* p = res; p; p = p->ai_next) {
    fd = ::socket(p->ai_family, p->ai_socktype, p->ai_protocol);
    if (fd < 0) continue;
    struct timeval tv { 5, 0 };
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    if (::connect(fd, p->ai_addr, p->ai_addrlen) == 0) break;
    ::close(fd);
    fd = -1;
  }
  freeaddrinfo(res);
  if (fd < 0) { err = "tcp connect failed"; return false; }

  const std::string req =
      "GET " + path_ + " HTTP/1.1\r\nHost: " + host_ + "\r\nConnection: close\r\n\r\n";
  if (::send(fd, req.data(), req.size(), 0) < 0) {
    ::close(fd);
    err = "send failed";
    return false;
  }
  std::string raw;
  char buf[512];
  // The status line arrives in the first read in practice; loop a little for
  // slow starts but never past the socket timeout.
  for (int i = 0; i < 4 && raw.find("\r\n") == std::string::npos; i++) {
    const ssize_t n = ::recv(fd, buf, sizeof buf, 0);
    if (n <= 0) break;
    raw.append(buf, static_cast<size_t>(n));
  }
  ::close(fd);
  const int status = parseHttpStatus(raw);
  if (status != 200) {
    err = status < 0 ? "not an HTTP response" : ("http " + std::to_string(status));
    return false;
  }
  return true;
}

void PeerProbe::runLoop(int intervalSec) {
  while (running_.load(std::memory_order_relaxed)) {
    std::string err;
    const bool ok = probeOnce(err);
    if (ok) {
      lastOkAtMs_.store(nowMsPeer(), std::memory_order_relaxed);
      const bool wasDown = reportedDown_;
      fails_.store(0, std::memory_order_relaxed);
      peerOk_.store(true, std::memory_order_relaxed);
      if (wasDown) {
        reportedDown_ = false;
        logLine("peer is back");
        if (ring_) ring_->log("peer", "up", 0, 0, "", host_);
      }
    } else {
      const long long f = fails_.fetch_add(1, std::memory_order_relaxed) + 1;
      peerOk_.store(false, std::memory_order_relaxed);
      {
        std::lock_guard<std::mutex> lk(errMtx_);
        lastError_ = err;
      }
      // Hysteresis: one transition into DOWN per episode, at the threshold.
      if (f == kDownAfter && !reportedDown_) {
        reportedDown_ = true;
        logLine("peer DOWN after " + std::to_string(f) + " consecutive failures: " + err);
        if (ring_) ring_->log("peer", "down", 0, 0, err, host_ + " ×" + std::to_string(f));
      }
    }
    std::unique_lock<std::mutex> lk(stopMtx_);
    stopCv_.wait_for(lk, seconds(intervalSec),
                     [this] { return !running_.load(std::memory_order_relaxed); });
  }
}

void PeerProbe::start(const std::string& url, DecisionRing* ring, int intervalSec) {
  if (url.empty()) return;
  if (!parsePeerUrl(url, host_, port_, path_)) {
    logLine("PEER_URL not usable ('" + url + "') — expected http://host:port[/path]; probe stays off");
    return;
  }
  ring_ = ring;
  enabled_.store(true, std::memory_order_relaxed);
  running_.store(true, std::memory_order_relaxed);
  worker_ = std::thread([this, intervalSec] { runLoop(intervalSec < 5 ? 5 : intervalSec); });
  logLine("probing peer " + host_ + ":" + std::to_string(port_) + path_ + " every " + std::to_string(intervalSec) + "s");
}

void PeerProbe::stop() {
  if (!running_.exchange(false)) return;
  stopCv_.notify_all();
  if (worker_.joinable()) worker_.join();
}

std::string PeerProbe::lastError() {
  std::lock_guard<std::mutex> lk(errMtx_);
  return lastError_;
}
