#pragma once
#include "json.hpp"
#include <algorithm>
#include <chrono>
#include <deque>
#include <mutex>
#include <openssl/sha.h>
#include <openssl/rand.h>
#include <stdexcept>

namespace scan {
inline long long nowMs() { return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count(); }
inline long long integer(const jsn::Value& v, long long low, long long high) {
  const double n = v.asNumber(-1);
  if (!std::isfinite(n) || n < low || n > high || std::floor(n) != n) throw std::invalid_argument("invalid_integer");
  return static_cast<long long>(n);
}
inline std::string id(const jsn::Value& v) {
  const auto s = v.asString();
  if (s.empty() || s.size() > 19 || s.front() == '0' || !std::all_of(s.begin(), s.end(), [](char c) { return c >= '0' && c <= '9'; })) throw std::invalid_argument("invalid_identity");
  return s;
}
inline std::string version(const jsn::Value& v) {
  const auto s = v.asString();
  if (s.empty() || s.size() > 128 || !std::all_of(s.begin(), s.end(), [](char c) { return std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.'; })) throw std::invalid_argument("invalid_version");
  return s;
}
inline std::string hash(const std::string& text) {
  unsigned char digest[SHA256_DIGEST_LENGTH]; SHA256(reinterpret_cast<const unsigned char*>(text.data()), text.size(), digest);
  const char* hex = "0123456789abcdef"; std::string out;
  for (unsigned char c : digest) { out += hex[c >> 4]; out += hex[c & 15]; } return out;
}
struct Identity {
  jsn::Value feed;
  std::string epoch, config, profile, key;
  long long ttl = 0;
};
inline Identity identity(const jsn::Value& body) {
  if (integer(body.get("schemaVersion"), 1, 1) != 1 || body.get("purpose").asString() != "mirror") throw std::invalid_argument("mirror_contract_required");
  const auto& f = body.get("feed"); const auto host = f.get("host").asString();
  if (f.get("provider").asString() != "ctrader" || (host != "demo.ctraderapi.com" && host != "live.ctraderapi.com")) throw std::invalid_argument("unknown_feed");
  Identity out;
  out.feed = jsn::Value(jsn::Object{{"provider", "ctrader"}, {"host", host}, {"accountId", id(f.get("accountId"))}, {"symbolId", id(f.get("symbolId"))}});
  out.epoch = version(body.get("feedEpoch")); out.config = version(body.get("configVersion")); out.profile = version(body.get("profileHash"));
  // Explicit comparison-run policy, never a silently chosen admission limit.
  out.ttl = integer(body.get("candidateTtlMs"), 1, 3600000);
  out.key = jsn::dump(jsn::Value(jsn::Array{out.feed, out.epoch, out.config, out.profile}));
  return out;
}
inline jsn::Value candidate(const Identity& identity, const std::string& strategy, long long sourceSequence,
                           long long receivedAt, const jsn::Value& sourceTimestamp, long long evaluatedAt, jsn::Value signal, const std::string& evaluationKey = "") {
  const auto stable = hash(jsn::dump(jsn::Value(jsn::Array{identity.feed, identity.epoch, identity.config, identity.profile, strategy, sourceSequence, evaluationKey})));
  return jsn::Value(jsn::Object{{"schemaVersion", 1}, {"purpose", "mirror"}, {"orderAuthority", false}, {"candidateId", stable},
    {"feed", identity.feed}, {"feedEpoch", identity.epoch}, {"configVersion", identity.config}, {"profileHash", identity.profile},
    {"strategy", strategy}, {"sourceSequence", sourceSequence}, {"sourceTimestampMs", sourceTimestamp},
    {"receivedAtMs", receivedAt}, {"evaluatedAtMs", evaluatedAt}, {"expiresAtMs", receivedAt + identity.ttl}, {"signal", std::move(signal)}});
}
class CandidateRing {
public:
  CandidateRing() {
    unsigned char bytes[32];
    if (RAND_bytes(bytes, sizeof bytes) != 1) throw std::runtime_error("scanner_instance_identity_unavailable");
    instance_ = hash(std::string(reinterpret_cast<char*>(bytes), sizeof bytes));
  }
  void push(jsn::Value value) {
    std::lock_guard lock(mutex_); value.set("cursor", ++cursor_); rows_.push_back(std::move(value));
    if (rows_.size() > 4096) { rows_.pop_front(); ++dropped_; }
  }
  jsn::Value read(long long after, size_t limit = 256) {
    std::lock_guard lock(mutex_); jsn::Array rows;
    const auto oldest = rows_.empty() ? cursor_ + 1 : static_cast<long long>(rows_.front().get("cursor").asNumber());
    for (const auto& r : rows_) if (r.get("cursor").asNumber() > after && rows.size() < limit) rows.push_back(r);
    return jsn::Value(jsn::Object{{"instanceId", instance_}, {"candidates", rows}, {"latestCursor", cursor_}, {"oldestCursor", oldest},
      {"gap", after < oldest - 1 || after > cursor_}, {"overwritten", dropped_}, {"orderAuthority", false}});
  }
private:
  std::string instance_; std::mutex mutex_; std::deque<jsn::Value> rows_; long long cursor_ = 0, dropped_ = 0;
};
}
