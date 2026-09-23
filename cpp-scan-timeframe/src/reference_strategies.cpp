// Ports of the identically named agent/services functions. Keep expression
// order and strict comparison boundaries aligned with the JavaScript source.
#include "reference_strategies.hpp"
#include "extended_strategies.hpp"
#include "vpo_indicators.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
namespace tfscan {
using jsn::Value; using jsn::Object; using Bars = std::vector<bt::Bar>;
static double round2(double x) { return std::floor(x * 100 + 0.5) / 100; }
static Value signal(const std::string& strategy, const bt::Options& opts, int dir, const std::string& reason,
                    double entry, double sl, double tp1, double tp2, int conviction, double rr, Value cap = {}) {
  return Value(Object{{"strategy",strategy},{"bias",dir > 0 ? "long" : "short"},{"direction_reason",reason},
    {"entry",entry},{"sl",sl},{"tp1",tp1},{"tp2",tp2},{"conviction",conviction},{"rr",rr},
    {"timeframe",opts.timeframe},{"time_cap_minutes",cap}});
}
static Value donchian(const Bars& bars, const bt::Options& opts) {
  if (bars.size() < 40) return {};
  const auto last = bars.size() - 1; const auto& bar = bars.back();
  double hi = -INFINITY, lo = INFINITY, volSum = 0;
  for (auto i = last - 20; i < last; ++i) { hi = std::max(hi,bars[i].h); lo = std::min(lo,bars[i].l); volSum += bars[i].v; }
  const double range = hi - lo, a = vpo::atr(bars);
  if (!(a > 0) || range < 2 * a) return {};
  const int dir = bar.c > hi ? 1 : bar.c < lo ? -1 : 0;
  if (!dir || (dir > 0 ? bar.c - hi : lo - bar.c) > a) return {};
  const double avgVol = volSum / 20, volX = avgVol > 0 ? bar.v / avgVol : 0;
  if (volX < 1.2) return {};
  const double sl = bar.c - dir * 1.5 * a, tp1 = bar.c + dir * range, tp2 = bar.c + dir * 1.5 * range;
  const double rr = round2(std::fabs(tp1-bar.c) / std::fabs(bar.c-sl));
  if (rr < 1.5) return {};
  const int conviction = 8 + (volX >= 1.8) + (range >= 3 * a);
  return signal("donchian_breakout",opts,dir,dir > 0 ? "donchian:close>hi20" : "donchian:close<lo20",bar.c,sl,tp1,tp2,conviction,rr);
}
static Value rsi2(const Bars& bars, const bt::Options& opts) {
  if (bars.size() < 104 || opts.tfMinutes < 60) return {};
  const double r = vpo::rsi(bars,2), trend = vpo::sma(bars,100), a = vpo::atr(bars), entry = bars.back().c;
  if (!std::isfinite(r) || !std::isfinite(trend) || !(a > 0)) return {};
  const int dir = entry > trend && r < 10 ? 1 : entry < trend && r > 90 ? -1 : 0;
  if (!dir) return {};
  const double dist = 1.5 * a, sl = dir > 0 ? entry - dist : entry + dist;
  const double tp1 = dir > 0 ? entry + 1.2 * dist : entry - 1.2 * dist;
  const double tp2 = dir > 0 ? entry + 2.2 * dist : entry - 2.2 * dist;
  const int conviction = 8 + (dir > 0 ? r < 5 : r > 95) + (std::fabs(entry-trend) / a >= 1);
  return signal("rsi2_reversion",opts,dir,dir > 0 ? "rsi2:close>sma100,rsi2<10" : "rsi2:close<sma100,rsi2>90",
    entry,sl,tp1,tp2,conviction,round2(std::fabs(tp1-entry) / dist),5 * opts.tfMinutes);
}
static Value vwapTrend(const Bars& bars, const bt::Options& opts) {
  if (bars.size() < 30) return {};
  const double ms = opts.tfMinutes * 60000, period = ms >= 604800000 ? 2592000000 : ms >= 86400000 ? 604800000 : 86400000;
  const auto vw = vpo::vwapAnchored(bars,period); const auto& bar = bars.back();
  const double v = vw.back(), prev = vw[vw.size()-11], a = vpo::atr(bars);
  if (!std::isfinite(v) || !std::isfinite(prev) || !(a > 0)) return {};
  int dir = 0;
  if (bar.c > v && v > prev && bar.l <= v) { if (v-bar.l > 1.5*a) return {}; dir = 1; }
  else if (bar.c < v && v < prev && bar.h >= v) { if (bar.h-v > 1.5*a) return {}; dir = -1; }
  if (!dir) return {};
  const double sl = dir > 0 ? bar.l - 0.5*a : bar.h + 0.5*a, risk = std::fabs(bar.c-sl);
  if (!(risk > 0)) return {};
  const double tp1 = bar.c + dir*2*risk, tp2 = bar.c + dir*3*risk, rr = round2(std::fabs(tp1-bar.c)/risk);
  if (rr < 1.5) return {};
  const int conviction = 8 + (std::fabs(v-prev)/a > 0.5) + ((dir > 0 ? v-bar.l : bar.h-v) < 0.5*a);
  return signal("vwap_trend",opts,dir,dir > 0 ? "vwap:close>rising_vwap" : "vwap:close<falling_vwap",bar.c,sl,tp1,tp2,conviction,rr);
}
static Value fibConfluence(const Bars& bars, const bt::Options& opts) {
  if (bars.size() < 40) return {};
  const double a = vpo::atr(bars); if (!(a > 0)) return {};
  const auto swings = bt::findSwings(bars,bars.size());
  if (swings.highs.empty() || swings.lows.empty()) return {};
  std::vector<double> supports, resistances;
  const double price = bars.back().c, band = 0.5*a;
  for (size_t hi = swings.highs.size() > 4 ? swings.highs.size()-4 : 0; hi < swings.highs.size(); ++hi)
    for (size_t li = swings.lows.size() > 4 ? swings.lows.size()-4 : 0; li < swings.lows.size(); ++li) {
      const auto& h = swings.highs[hi]; const auto& l = swings.lows[li]; const double range = h.price-l.price;
      if (!(range > 0) || h.idx == l.idx) continue;
      for (const double r : {0.382,0.5,0.618,0.786}) {
        const double level = h.idx > l.idx ? h.price-r*range : l.price+r*range;
        if (std::fabs(level-price) <= band) (h.idx > l.idx ? supports : resistances).push_back(level);
      }
    }
  const int dir = supports.size() >= 3 && supports.size() >= resistances.size() ? 1
    : resistances.size() >= 3 && resistances.size() > supports.size() ? -1 : 0;
  if (!dir) return {};
  const auto& levels = dir > 0 ? supports : resistances;
  const double sl = dir > 0 ? *std::min_element(levels.begin(),levels.end())-0.5*a : *std::max_element(levels.begin(),levels.end())+0.5*a;
  const double risk = std::fabs(price-sl); if (!(risk > 0)) return {};
  const double tp1 = price+dir*2*risk, tp2 = price+dir*3*risk, rr = round2(std::fabs(tp1-price)/risk);
  if (rr < 1.5) return {};
  auto out = signal("fib_confluence",opts,dir,std::string(dir > 0 ? "fibconf:support_stack_" : "fibconf:resistance_stack_")+std::to_string(levels.size()),
    price,sl,tp1,tp2,std::max(6,std::min(10,6+static_cast<int>(levels.size())-3+1)),rr);
  out.set("confluenceCount",static_cast<int>(levels.size())); return out;
}
bool supports(const std::string& s) { return s == "donchian_breakout" || s == "rsi2_reversion" || s == "vwap_trend" || s == "fib_confluence" || supportsExtended(s); }
Value compute(const std::string& strategy, const Bars& bars, const bt::Options& opts) {
  if (strategy == "donchian_breakout") return donchian(bars,opts);
  if (strategy == "rsi2_reversion") return rsi2(bars,opts);
  if (strategy == "vwap_trend") return vwapTrend(bars,opts);
  if (strategy == "fib_confluence") return fibConfluence(bars,opts);
  return computeExtended(strategy,bars,opts);
}
}
