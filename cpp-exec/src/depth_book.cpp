// cpp-exec/src/depth_book.cpp — see depth_book.hpp.
#include "depth_book.hpp"

#include <algorithm>
#include <vector>

namespace {
constexpr double kPointsPerPrice = 100000.0; // same wire scaling as spot events
}

void DepthBook::applyEvent(const jsn::Value& payload, long long nowMs) {
  for (const auto& q : payload.get("newQuotes").asArray()) {
    const jsn::Value& idV = q.get("id");
    if (!idV.isNumber()) continue;
    const auto id = static_cast<std::uint64_t>(idV.asNumber(0));
    const jsn::Value& bidV = q.get("bid");
    const jsn::Value& askV = q.get("ask");
    // Exactly one side names the quote's side; a quote with neither is
    // malformed and skipped rather than guessed at.
    if (!bidV.isNumber() && !askV.isNumber()) continue;
    Entry e;
    e.isBid = bidV.isNumber();
    e.price = (e.isBid ? bidV.asNumber(0) : askV.asNumber(0)) / kPointsPerPrice;
    e.sizeCents = q.get("size").asNumber(0);
    byId_[id] = e;
  }
  for (const auto& d : payload.get("deletedQuotes").asArray()) {
    if (!d.isNumber()) continue;
    byId_.erase(static_cast<std::uint64_t>(d.asNumber(0)));
  }
  lastAtMs_ = nowMs;
}

std::string DepthBook::snapshotJson(int maxLevels) const {
  std::vector<const Entry*> bids, asks;
  for (const auto& [id, e] : byId_) (e.isBid ? bids : asks).push_back(&e);
  std::sort(bids.begin(), bids.end(), [](const Entry* a, const Entry* b) { return a->price > b->price; });
  std::sort(asks.begin(), asks.end(), [](const Entry* a, const Entry* b) { return a->price < b->price; });
  if (maxLevels < 1) maxLevels = 1;
  const auto cap = static_cast<size_t>(maxLevels);
  if (bids.size() > cap) bids.resize(cap);
  if (asks.size() > cap) asks.resize(cap);

  // Built by hand rather than via jsn::dump: wire prices are integers scaled
  // by 100000, so the descaled price is exact to 5 decimal places — but the
  // shared dumper's %.17g would print the nearest binary double (e.g.
  // 1.0851999999999999 for 108520). %.5f with trailing zeros trimmed emits
  // the intended decimal exactly.
  auto priceStr = [](double p) {
    char buf[32];
    std::snprintf(buf, sizeof buf, "%.5f", p);
    std::string s(buf);
    while (s.size() > 1 && s.back() == '0') s.pop_back();
    if (!s.empty() && s.back() == '.') s.pop_back();
    return s;
  };
  auto side = [&priceStr](const std::vector<const Entry*>& v, std::string& out) {
    out += '[';
    bool first = true;
    for (const Entry* e : v) {
      if (!first) out += ',';
      first = false;
      out += "{\"price\":" + priceStr(e->price) +
             ",\"sizeCents\":" + std::to_string(static_cast<long long>(e->sizeCents)) + '}';
    }
    out += ']';
  };
  std::string out = "{\"at\":" + std::to_string(lastAtMs_) + ",\"bids\":";
  side(bids, out);
  out += ",\"asks\":";
  side(asks, out);
  out += '}';
  return out;
}
