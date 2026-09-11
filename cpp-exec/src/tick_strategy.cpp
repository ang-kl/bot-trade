// cpp-exec/src/tick_strategy.cpp — see tick_strategy.hpp.
#include "tick_strategy.hpp"

#include <openssl/sha.h>

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace tick {

namespace {
long long roundHalfUp(double x) { return static_cast<long long>(std::floor(x + 0.5)); }
std::string num(double d) {
  // The reference's JSON.stringify for these numbers: integers without a
  // fraction, otherwise the shortest round-trip form (%.17g trimmed).
  if (d == std::floor(d) && std::fabs(d) < 1e15) { char b[32]; std::snprintf(b, sizeof b, "%lld", static_cast<long long>(d)); return b; }
  char b[40];
  for (int prec = 1; prec <= 17; ++prec) {
    std::snprintf(b, sizeof b, "%.*g", prec, d);
    if (std::strtod(b, nullptr) == d) break;
  }
  return b;
}
} // namespace

std::string StrategyParams::canonicalJson() const {
  // Keys in sorted order, as the reference's profileHash builds them.
  std::string s = "{\"id\":\"tick_momentum_breakout\",\"version\":\"v1\"";
  s += ",\"confirmations\":" + num(confirmations);
  s += ",\"expiryEvents\":" + num(expiryEvents);
  s += ",\"maxQuoteAgeMs\":" + num(static_cast<double>(maxQuoteAgeMs));
  s += ",\"maxSpread\":" + num(static_cast<double>(maxSpread));
  s += ",\"minEfficiency\":" + num(minEfficiency);
  s += ",\"minStopPrice\":" + num(static_cast<double>(minStopPrice));
  s += ",\"momentumEvents\":" + num(momentumEvents);
  s += ",\"priceIncrement\":" + num(static_cast<double>(priceIncrement));
  s += ",\"rangeEvents\":" + num(rangeEvents);
  s += ",\"rearmCooldownEvents\":" + num(rearmCooldownEvents);
  s += ",\"spreadBufferMult\":" + num(spreadBufferMult);
  s += ",\"stopVolMult\":" + num(stopVolMult);
  s += "}";
  return s;
}

std::string StrategyParams::profileHash() const {
  const std::string c = canonicalJson();
  unsigned char d[SHA256_DIGEST_LENGTH];
  SHA256(reinterpret_cast<const unsigned char*>(c.data()), c.size(), d);
  char hex[17];
  for (int i = 0; i < 8; ++i) std::snprintf(hex + 2 * i, 3, "%02x", d[i]);
  return std::string(hex, 16);
}

const char* setupStateName(SetupState s) {
  switch (s) {
    case SetupState::WARMING: return "WARMING";
    case SetupState::ARMED: return "ARMED";
    case SetupState::CONFIRMING: return "CONFIRMING";
    case SetupState::SIGNALLED: return "SIGNALLED";
    case SetupState::EXPIRED: return "EXPIRED";
  }
  return "?";
}

TickMomentumStrategy::TickMomentumStrategy(StrategyParams p) : p_(p), hash_(p.profileHash()) {}

void TickMomentumStrategy::invalidate() {
  mids_.clear(); bids_.clear(); asks_.clear(); spreads_.clear();
  diffsN_.clear(); sumSqN_ = 0; lo_.clear(); hi_.clear();
  setup_.reset();
  state_ = SetupState::WARMING;
}

long long TickMomentumStrategy::medianSpread() const {
  const size_t n = lo_.size() + hi_.size();
  if (n == 0) return 0;
  if (n % 2 == 1) return *lo_.rbegin();
  // floor((a + b) / 2) with a <= b, as the reference
  const long long a = *lo_.rbegin(), b = *hi_.begin();
  return static_cast<long long>(std::floor((static_cast<double>(a) + static_cast<double>(b)) / 2.0));
}

void TickMomentumStrategy::pushAccepted(long long mid2, long long bid, long long ask, long long spread) {
  const size_t N = static_cast<size_t>(p_.rangeEvents);
  if (!mids_.empty()) {
    const long long d = mid2 - mids_.back();
    diffsN_.push_back(d);
    sumSqN_ += static_cast<double>(d) * static_cast<double>(d);
    if (diffsN_.size() > N) { const long long old = diffsN_.front(); diffsN_.pop_front(); sumSqN_ -= static_cast<double>(old) * static_cast<double>(old); }
  }
  // spread median over the prior N spreads: insert, evict, rebalance
  if (lo_.empty() || spread <= *lo_.rbegin()) lo_.insert(spread); else hi_.insert(spread);
  spreads_.push_back(spread);
  if (spreads_.size() > N) {
    const long long old = spreads_.front(); spreads_.pop_front();
    auto it = lo_.find(old);
    if (it != lo_.end()) lo_.erase(it); else { auto jt = hi_.find(old); if (jt != hi_.end()) hi_.erase(jt); }
  }
  while (lo_.size() > hi_.size() + 1) { hi_.insert(*lo_.rbegin()); lo_.erase(std::prev(lo_.end())); }
  while (hi_.size() > lo_.size()) { lo_.insert(*hi_.begin()); hi_.erase(hi_.begin()); }
  mids_.push_back(mid2); bids_.push_back(bid); asks_.push_back(ask);
  const size_t keep = N + static_cast<size_t>(p_.momentumEvents) + 2;
  while (mids_.size() > keep) { mids_.pop_front(); bids_.pop_front(); asks_.pop_front(); }
}

std::optional<TickSignal> TickMomentumStrategy::onQuote(const StrategyQuote& q) {
  if (!q.hasBid || !q.hasAsk || q.snapshot || q.crossed) {
    rejected_.invalid++;
    // Plan §4/§5 (11-09-2026 audit): a snapshot — a (re)subscribe, or a
    // continuity break the worker folds into it (gapBefore) — a one-sided
    // update or a crossed quote invalidates the setup AND the warm-up. The
    // window must not carry on with the missed events absent: a fresh N+1
    // prior events are required before anything can arm again.
    invalidate();
    return std::nullopt;
  }
  if (!q.changed) { rejected_.repeat++; return std::nullopt; }
  if (q.ask - q.bid > p_.maxSpread) { rejected_.spread++; return std::nullopt; }
  if (haveLast_ && q.recvMs > lastRecvMs_ && q.recvMs - lastRecvMs_ > static_cast<uint64_t>(p_.maxQuoteAgeMs)) {
    rejected_.stale++;
    invalidate();
    lastRecvMs_ = q.recvMs;
    return std::nullopt;
  }
  haveLast_ = true;
  lastRecvMs_ = q.recvMs;

  const size_t N = static_cast<size_t>(p_.rangeEvents), M = static_cast<size_t>(p_.momentumEvents);
  const long long mid2 = q.bid + q.ask;
  const long long spread = q.ask - q.bid;
  const bool warm = mids_.size() >= N + 1 && mids_.size() >= M;
  std::optional<TickSignal> signal;
  if (warm) {
    // Prior-N range and V (the candidate excluded).
    long long H = mids_[mids_.size() - N], L = H;
    for (size_t i = mids_.size() - N; i < mids_.size(); ++i) { H = std::max(H, mids_[i]); L = std::min(L, mids_[i]); }
    const double V = std::sqrt(static_cast<double>(M) * (sumSqN_ / static_cast<double>(diffsN_.size())));
    const long long medSpread = medianSpread();
    const long long B = std::max<long long>(4 * p_.priceIncrement, roundHalfUp(p_.spreadBufferMult * 2.0 * static_cast<double>(medSpread)));
    // D and E over the last M events including the candidate.
    const long long D = mid2 - mids_[mids_.size() - M];
    long long sumAbs = 0;
    for (size_t i = mids_.size() - M + 1; i < mids_.size(); ++i) sumAbs += std::llabs(mids_[i] - mids_[i - 1]);
    sumAbs += std::llabs(mid2 - mids_.back());
    const double E = sumAbs > 0 ? static_cast<double>(std::llabs(D)) / static_cast<double>(sumAbs) : 0.0;
    accepted_++;
    const uint64_t ev = accepted_;

    if (state_ == SetupState::SIGNALLED) {
      const Setup& s = *setup_;
      if (mid2 >= s.L && mid2 <= s.H && ev - signalledAt_ >= static_cast<uint64_t>(p_.rearmCooldownEvents)) { setup_.reset(); state_ = SetupState::WARMING; }
    } else if (state_ == SetupState::EXPIRED) {
      if (ev - expiredAt_ >= static_cast<uint64_t>(std::max(1, p_.rangeEvents / 4))) { setup_.reset(); state_ = SetupState::WARMING; }
    }

    if (state_ == SetupState::WARMING && !setup_) {
      if (H > L && mid2 >= L && mid2 <= H && std::isfinite(V) && V > 0) {
        Setup s;
        s.H = H; s.L = L; s.B = B; s.armedAt = ev; s.id = ++setupSeq_;
        s.bidHigh = bids_[bids_.size() - N]; s.bidLow = s.bidHigh; s.askHigh = asks_[asks_.size() - N]; s.askLow = s.askHigh;
        for (size_t i = bids_.size() - N; i < bids_.size(); ++i) {
          s.bidHigh = std::max(s.bidHigh, bids_[i]); s.bidLow = std::min(s.bidLow, bids_[i]);
          s.askHigh = std::max(s.askHigh, asks_[i]); s.askLow = std::min(s.askLow, asks_[i]);
        }
        setup_ = s;
        state_ = SetupState::ARMED;
      }
    } else if (state_ == SetupState::ARMED || state_ == SetupState::CONFIRMING) {
      Setup& s = *setup_;
      if (ev - s.armedAt > static_cast<uint64_t>(p_.expiryEvents) && state_ == SetupState::ARMED) {
        state_ = SetupState::EXPIRED; expiredAt_ = ev;
      } else {
        const bool longOk = mid2 > s.H + s.B && D > 0 && E >= p_.minEfficiency && q.bid > s.bidHigh;
        const bool shortOk = mid2 < s.L - s.B && D < 0 && E >= p_.minEfficiency && q.ask < s.askLow;
        const std::string dir = longOk ? "BUY" : (shortOk ? "SELL" : "");
        if (!dir.empty() && (s.dir.empty() || s.dir == dir)) {
          s.dir = dir;
          s.confirmed += 1;
          state_ = SetupState::CONFIRMING;
          if (s.confirmed >= p_.confirmations) {
            TickSignal sig;
            sig.side = dir; sig.seq = q.seq; sig.recvMs = q.recvMs; sig.trigger2 = mid2; sig.bid = q.bid; sig.ask = q.ask;
            sig.stopDistance = std::max<long long>(p_.minStopPrice, roundHalfUp(p_.stopVolMult * V / 2.0));
            sig.spread = spread; sig.V = V; sig.D = D; sig.E = E; sig.H = s.H; sig.L = s.L; sig.B = s.B;
            sig.setupId = s.id; sig.confirmations = s.confirmed;
            signal = sig;
            state_ = SetupState::SIGNALLED; signalledAt_ = ev;
          }
        } else {
          s.confirmed = 0; s.dir.clear();
          if (state_ == SetupState::CONFIRMING) state_ = SetupState::ARMED;
          if (ev - s.armedAt > static_cast<uint64_t>(p_.expiryEvents)) { state_ = SetupState::EXPIRED; expiredAt_ = ev; }
        }
      }
    }
  } else {
    accepted_++;
  }
  pushAccepted(mid2, q.bid, q.ask, spread);
  return signal;
}

} // namespace tick
