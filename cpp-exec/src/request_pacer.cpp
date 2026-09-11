// cpp-exec/src/request_pacer.cpp — see request_pacer.hpp.
#include "request_pacer.hpp"

#include <algorithm>
#include <cmath>

RequestPacer::RequestPacer(PacerConfig cfg) : cfg_(cfg) {
  if (cfg_.capacityPerSec < 1) cfg_.capacityPerSec = 1;
  cfg_.protectionReservePct = std::clamp(cfg_.protectionReservePct, 0, 90);
  tokens_ = cfg_.capacityPerSec;
}

double RequestPacer::refilled(long long nowMs) const {
  if (lastMs_ == 0 || nowMs <= lastMs_) return tokens_;
  const double add = static_cast<double>(nowMs - lastMs_) * cfg_.capacityPerSec / 1000.0;
  return std::min<double>(cfg_.capacityPerSec, tokens_ + add);
}

double RequestPacer::floorFor(RequestClass cls) const {
  // Entry/Read must leave the reserve untouched; Protection may spend it.
  if (cls == RequestClass::Protection) return 0.0;
  return cfg_.capacityPerSec * cfg_.protectionReservePct / 100.0;
}

bool RequestPacer::tryAcquire(RequestClass cls, long long nowMs) {
  std::lock_guard<std::mutex> lk(mtx_);
  tokens_ = refilled(nowMs);
  lastMs_ = std::max(lastMs_, nowMs);
  if (tokens_ - 1.0 >= floorFor(cls) - 1e-9) {
    tokens_ -= 1.0;
    c_.granted++;
    c_.tokens = tokens_;
    return true;
  }
  if (cls == RequestClass::Entry) c_.refusedEntry++;
  else if (cls == RequestClass::Read) c_.refusedRead++;
  else c_.refusedProtection++;
  c_.tokens = tokens_;
  return false;
}

long long RequestPacer::waitMsFor(RequestClass cls, long long nowMs) const {
  std::lock_guard<std::mutex> lk(mtx_);
  const double have = refilled(nowMs);
  const double need = floorFor(cls) + 1.0 - have;
  if (need <= 0) return 0;
  return static_cast<long long>(std::ceil(need * 1000.0 / cfg_.capacityPerSec));
}

RequestPacer::Counters RequestPacer::counters() const {
  std::lock_guard<std::mutex> lk(mtx_);
  Counters c = c_;
  c.tokens = tokens_;
  return c;
}
