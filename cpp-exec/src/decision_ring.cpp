// cpp-exec/src/decision_ring.cpp
#include "decision_ring.hpp"

#include <chrono>
#include <random>

static long long nowMsRing() {
  using namespace std::chrono;
  return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

static std::string randomBootId() {
  // 16 hex chars from a real random source — collision across restarts is
  // what the puller keys restart detection on, so time alone is not enough
  // (two restarts inside one clock tick must still differ).
  std::random_device rd;
  std::mt19937_64 gen((static_cast<uint64_t>(rd()) << 32) ^ rd());
  static const char* hex = "0123456789abcdef";
  uint64_t v = gen();
  std::string out(16, '0');
  for (int i = 15; i >= 0; --i) { out[i] = hex[v & 0xf]; v >>= 4; }
  return out;
}

DecisionRing::DecisionRing(size_t slots)
    : slots_(slots == 0 ? 1 : slots), bootId_(randomBootId()), ring_(slots_) {}

void DecisionRing::log(const std::string& component, const std::string& kind,
                       long long accountId, long long symbolId,
                       std::string code, std::string detail) {
  std::lock_guard<std::mutex> lk(mtx_);
  const long long seq = ++seq_;
  DecisionRecord& r = ring_[static_cast<size_t>(seq % static_cast<long long>(slots_))];
  r.seq = seq;
  r.tsMs = nowMsRing();
  r.component = component;
  r.kind = kind;
  r.accountId = accountId;
  r.symbolId = symbolId;
  r.code = std::move(code);
  r.detail = std::move(detail);
}

std::vector<DecisionRecord> DecisionRing::since(long long after) const {
  std::lock_guard<std::mutex> lk(mtx_);
  std::vector<DecisionRecord> out;
  if (seq_ == 0) return out;
  const long long oldest = seq_ > static_cast<long long>(slots_)
      ? seq_ - static_cast<long long>(slots_) + 1 : 1;
  long long from = after + 1;
  if (from < oldest) from = oldest; // gap or restart — hand over what remains
  for (long long s = from; s <= seq_; ++s) {
    out.push_back(ring_[static_cast<size_t>(s % static_cast<long long>(slots_))]);
  }
  return out;
}

long long DecisionRing::latestSeq() const {
  std::lock_guard<std::mutex> lk(mtx_);
  return seq_;
}

std::string DecisionRing::dumpJson(long long after, const std::string& callerBootId) const {
  // A caller carrying a different bootId is cursoring against a previous
  // life of this process — its seq means nothing here, so it gets the full
  // retained ring (after = 0).
  const bool sameBoot = callerBootId == bootId_;
  const std::vector<DecisionRecord> entries = since(sameBoot ? after : 0);

  jsn::Value v{jsn::Object{}};
  v.set("bootId", bootId_);
  v.set("latestSeq", static_cast<double>(latestSeq()));
  jsn::Array arr;
  for (const DecisionRecord& r : entries) {
    jsn::Value e{jsn::Object{}};
    e.set("seq", static_cast<double>(r.seq));
    e.set("tsMs", static_cast<double>(r.tsMs));
    e.set("component", r.component);
    e.set("kind", r.kind);
    if (r.accountId > 0) e.set("accountId", static_cast<double>(r.accountId));
    if (r.symbolId > 0) e.set("symbolId", static_cast<double>(r.symbolId));
    if (!r.code.empty()) e.set("code", r.code);
    if (!r.detail.empty()) e.set("detail", r.detail);
    arr.push_back(std::move(e));
  }
  v.set("entries", jsn::Value(std::move(arr)));
  return jsn::dump(v);
}
