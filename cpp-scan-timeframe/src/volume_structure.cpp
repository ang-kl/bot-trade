#include "volume_structure.hpp"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iterator>
#include <stdexcept>
namespace tfscan {
namespace {
class NewYorkTransitions {
  std::vector<int64_t> times;
  std::vector<unsigned char> types;
  std::vector<int32_t> offsets;
public:
  NewYorkTransitions() {
    // TZif's first (32-bit) section covers the Unix epoch through 2037 on
    // the deployed tzdata. Refuse outside that table: do not invent future
    // DST rules or silently depend on the process's TZ environment.
    std::ifstream f("/usr/share/zoneinfo/America/New_York",std::ios::binary);
    const std::vector<unsigned char> bytes{std::istreambuf_iterator<char>(f),{}};
    if (bytes.size() < 44 || std::string(bytes.begin(),bytes.begin()+4) != "TZif") throw std::runtime_error("new_york_timezone_unavailable");
    auto u32 = [&](size_t p) -> uint32_t {
      if (p+4 > bytes.size()) throw std::runtime_error("timezone_truncated");
      return (uint32_t(bytes[p])<<24)|(uint32_t(bytes[p+1])<<16)|(uint32_t(bytes[p+2])<<8)|bytes[p+3];
    };
    const size_t count = u32(32), typeCount = u32(36);
    if (count < 2 || count > 4096 || !typeCount || typeCount > 256 || 44+count*5+typeCount*6 > bytes.size()) throw std::runtime_error("timezone_table_invalid");
    for (size_t i = 0; i < count; ++i) { times.push_back(static_cast<int32_t>(u32(44+i*4))); types.push_back(bytes[44+count*4+i]); }
    for (size_t i = 0; i < typeCount; ++i) offsets.push_back(static_cast<int32_t>(u32(44+count*5+i*6)));
    if (!std::is_sorted(times.begin(),times.end()) || std::any_of(types.begin(),types.end(),[&](auto t) { return t >= offsets.size(); })) throw std::runtime_error("timezone_table_invalid");
  }
  int offset(int64_t seconds) const {
    if (seconds < times.front() || seconds >= times.back()) throw std::invalid_argument("new_york_timezone_date_outside_verified_table");
    const auto index = std::upper_bound(times.begin(),times.end(),seconds)-times.begin()-1;
    return offsets[types[index]];
  }
};
struct Session { long long open; std::vector<bt::Bar> bars; };
std::vector<std::pair<double,double>> lowVolumeNodes(const std::vector<bt::Bar>& bars) {
  if (bars.empty()) return {};
  double lo = INFINITY, hi = -INFINITY;
  for (const auto& b : bars) { lo = std::min(lo,b.l); hi = std::max(hi,b.h); }
  const double span = hi-lo, step = span > 0 ? span/24 : 1;
  std::vector<double> vols(24,0);
  for (const auto& b : bars) {
    if (b.v <= 0) continue;
    if (span == 0) { vols[0] += b.v; continue; }
    const int start = std::clamp(static_cast<int>(std::floor((b.l-lo)/step)),0,23), end = std::clamp(static_cast<int>(std::floor((b.h-lo)/step)),0,23);
    const double share = b.v/(end-start+1); for (int i = start; i <= end; ++i) vols[i] += share;
  }
  const double poc = *std::max_element(vols.begin(),vols.end()); if (!(poc > 0)) return {};
  // Compute the row spacing in the same order as the JS profile consumer.
  const double rowStep = (lo+1.5*step)-(lo+0.5*step);
  std::vector<std::pair<double,double>> nodes; int first = -1;
  for (int i = 0; i <= 24; ++i) {
    if (i < 24 && vols[i] <= poc*0.3) { if (first < 0) first = i; }
    else if (first >= 0) {
      if (first > 0 && i-1 < 23) nodes.emplace_back(lo+(first+0.5)*step-rowStep/2,lo+(i-0.5)*step+rowStep/2);
      first = -1;
    }
  }
  return nodes;
}
}
long long fxDayOpenMs(long long timeMs) {
  static const NewYorkTransitions zone;
  const auto second = timeMs/1000;
  const auto localSecond = second+zone.offset(second);
  const int minute = static_cast<int>((localSecond%86400+86400)%86400)/60;
  const int since = minute >= 17*60 ? minute-17*60 : minute+24*60-17*60;
  // Match fxDayOpenMs's wall-clock subtraction, including DST transition
  // days; this deliberately does not replace it with a different calendar.
  return timeMs-static_cast<long long>(since)*60000-((second%60+60)%60)*1000-(timeMs%1000);
}
VolumeStructure volumeStructure(const std::vector<bt::Bar>& bars) {
  VolumeStructure result; std::vector<Session> sessions;
  for (const auto& bar : bars) {
    const auto open = fxDayOpenMs(static_cast<long long>(bar.t));
    if (sessions.empty() || sessions.back().open != open) sessions.push_back({open,{}});
    sessions.back().bars.push_back(bar);
  }
  if (sessions.size() < 2) return result;
  const auto& prev = sessions[sessions.size()-2]; const auto& current = sessions.back();
  result.prev = vpo::volumeProfile(prev.bars);
  if (!result.prev.valid || !(result.prev.vahPrice > result.prev.valPrice)) return result;
  result.valid = true; result.openMs = current.open; result.sessionBars = static_cast<int>(current.bars.size());
  const double openPrice = current.bars.front().o;
  result.structure = openPrice > result.prev.vahPrice ? "bullish" : openPrice < result.prev.valPrice ? "bearish" : "ranging";
  result.lvns = lowVolumeNodes(prev.bars);
  std::vector<vpo::VolumeProfileResult> recent;
  for (size_t i = sessions.size() > 4 ? sessions.size()-4 : 0; i < sessions.size()-1; ++i) {
    auto p = vpo::volumeProfile(sessions[i].bars); if (p.valid && p.vahPrice > p.valPrice) recent.push_back(p);
  }
  if (recent.size() >= 2) {
    double height = 0; for (const auto& p : recent) height += p.vahPrice-p.valPrice;
    height /= recent.size();
    if (height > 0) { const double drift = (recent.back().pocPrice-recent.front().pocPrice)/height; result.migration = drift >= 0.1 ? "up" : drift <= -0.1 ? "down" : "flat"; }
  }
  return result;
}
bool inLowVolumeNode(double price, const std::vector<std::pair<double,double>>& nodes) {
  return std::any_of(nodes.begin(),nodes.end(),[&](const auto& n) { return price >= n.first && price <= n.second; });
}
}
