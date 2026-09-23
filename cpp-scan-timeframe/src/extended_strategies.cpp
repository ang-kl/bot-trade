// Closed-bar reference ports. Economic fields and gate order follow their
// agent/services owners; diagnostic prose stays with the reference owner.
#include "extended_strategies.hpp"
#include "volume_structure.hpp"
#include "vpo_indicators.hpp"
#include <algorithm>
#include <cmath>
#include <stdexcept>
namespace tfscan {
using jsn::Value; using jsn::Object; using Bars = std::vector<bt::Bar>;
static double rounded(double x, double scale = 100) { return std::floor(x * scale + 0.5) / scale; }
static Value signal(const std::string& strategy, const bt::Options& opts, int dir, const std::string& reason,
                    double entry, double sl, double tp1, double tp2, int conviction, double rr, Value cap = {}) {
  return Value(Object{{"strategy",strategy},{"bias",dir > 0 ? "long" : "short"},{"direction_reason",reason},
    {"entry",entry},{"sl",sl},{"tp1",tp1},{"tp2",tp2},{"conviction",conviction},{"rr",rr},
    {"timeframe",opts.timeframe},{"time_cap_minutes",cap}});
}
static Bars prefix(const Bars& b, size_t n) { return Bars(b.begin(),b.begin()+n); }
static Value emaPullback(const Bars& b, const bt::Options& o, const Value& settings) {
  if (b.size() < 450) return {};
  const bool configured = !settings.asObject().empty();
  const bool pending = configured && settings.get("pendingSetup").asBool(), stack = !configured || settings.get("requireStack").asBool();
  const double floor = configured ? settings.get("minSlAtr").asNumber() : 0.8, ceiling = configured ? settings.get("maxSlAtr").asNumber() : 3;
  const auto& bar = b.back(); const double e20 = vpo::ema(b,20), e50 = vpo::ema(b,50), e200 = vpo::ema(b,200), a = vpo::atr(b);
  if (!(a > 0)) return {};
  int dir = 0;
  const bool up = e20 > e50 && (!stack || e50 > e200), down = e20 < e50 && (!stack || e50 < e200);
  if (pending) {
    if (up && bar.c > e20) dir = 1;
    else if (down && bar.c < e20) dir = -1;
  } else if (up && bar.l <= e20 && bar.c > e20 && bar.c > e50) {
    if (e20-bar.l > 2*a) return {};
    dir = 1;
  } else if (down && bar.h >= e20 && bar.c < e20 && bar.c < e50) {
    if (bar.h-e20 > 2*a) return {};
    dir = -1;
  }
  if (!dir) return {};
  double lo = bar.l, hi = bar.h;
  if (pending) for (size_t i = b.size()-10; i < b.size(); ++i) { lo = std::min(lo,b[i].l); hi = std::max(hi,b[i].h); }
  const double entry = pending ? e20 : bar.c, rawSl = dir > 0 ? lo-0.25*a : hi+0.25*a, rawDist = std::fabs(entry-rawSl);
  if (!(rawDist > 0) || rawDist > ceiling*a) return {};
  const double risk = std::max(rawDist,floor*a), sl = entry-dir*risk, tp1 = entry+dir*2*risk, tp2 = entry+dir*3*risk;
  const double rr = rounded(std::fabs(tp1-entry)/risk); if (rr < 1.5) return {};
  const double ePrev = vpo::ema(prefix(b,b.size()-5),20), r = vpo::rsi(b);
  const int conviction = pending ? 8 : 8 + (dir*(e20-ePrev) > 0) + (std::isfinite(r) && r >= 40 && r <= 60);
  const std::string reason = pending ? (dir > 0 ? "ema:ema20>ema50,close>ema20" : "ema:ema20<ema50,close<ema20")
    : (dir > 0 ? "ema:uptrend_dip_held_ema20" : "ema:downtrend_pop_held_ema20");
  auto out = signal("ema_pullback",o,dir,reason,entry,sl,tp1,tp2,conviction,rr,configured ? settings.get("timeCapMinutes") : Value{});
  out.set("sl_atr_mult",rounded(risk/a)); out.set("sl_widened_to_floor",risk > rawDist); out.set("stack_confirmed",stack); return out;
}
static Value rsiMeanrev(const Bars& b, const bt::Options& o) {
  if (b.size() < 75) return {};
  const double now = vpo::rsi(b), prev = vpo::rsi(prefix(b,b.size()-1)), mean = vpo::sma(b,20);
  const auto prior = prefix(b,b.size()-15); const double trend = prior.back().c-vpo::sma(prior,50);
  const int dir = prev < 30 && now >= 30 && trend > 0 ? 1 : prev > 70 && now <= 70 && trend < 0 ? -1 : 0;
  if (!dir) return {};
  const auto& bar = b.back(); const double a = vpo::atr(b);
  double extremePrice = dir > 0 ? INFINITY : -INFINITY;
  for (size_t i = b.size()-5; i < b.size(); ++i) extremePrice = dir > 0 ? std::min(extremePrice,b[i].l) : std::max(extremePrice,b[i].h);
  const double sl = extremePrice-dir*0.25*a, risk = std::fabs(bar.c-sl);
  if (dir*(mean-bar.c) <= 0 || !(risk > 0)) return {};
  const double rr = rounded(std::fabs(mean-bar.c)/risk); if (rr < 1.5) return {};
  double extreme = prev;
  for (size_t i = 1; i <= 10; ++i) { const double r = vpo::rsi(prefix(b,b.size()-i)); if (!std::isfinite(r)) break; extreme = dir > 0 ? std::min(extreme,r) : std::max(extreme,r); }
  int conviction = 8 + (dir > 0 ? extreme < 25 : extreme > 75);
  if (bar.h-bar.l > 0) { const double pos = (bar.c-bar.l)/(bar.h-bar.l); conviction += dir > 0 ? pos >= 2.0/3 : pos <= 1.0/3; }
  return signal("rsi_meanrev",o,dir,dir > 0 ? "rsi:cross_up_30,trend_up" : "rsi:cross_down_70,trend_down",bar.c,sl,mean,
    bar.c+dir*1.5*std::fabs(mean-bar.c),conviction,rr,4*o.tfMinutes);
}
static Value fvg(const Bars& b, const bt::Options& o) {
  if (b.size() < 60) return {};
  const double a = vpo::atr(b); if (!(a > 0)) return {};
  int best = -1, dir = 0; double top = 0, bottom = 0;
  for (size_t i = 2; i < b.size(); ++i) {
    const int d = b[i-2].h < b[i].l ? 1 : b[i-2].l > b[i].h ? -1 : 0;
    if (!d) continue;
    const double t = d > 0 ? b[i].l : b[i-2].l, low = d > 0 ? b[i-2].h : b[i].h;
    bool filled = false;
    for (size_t j = i+1; j < b.size(); ++j) if (d > 0 ? b[j].l <= low : b[j].h >= t) { filled = true; break; }
    const auto age = b.size()-1-i; const double height = t-low;
    if (filled || age < 2 || age > 40 || !(height > 0) || height/a < 0.25 || height/a > 3) continue;
    best = static_cast<int>(i); dir = d; top = t; bottom = low;
  }
  if (best < 0) return {};
  const auto& bar = b.back(); const double entry = bar.c, height = top-bottom;
  if (entry > top || entry < bottom || dir*(bar.c-bar.o) <= 0) return {};
  const double sl = dir > 0 ? bottom-0.5*a : top+0.5*a, risk = std::fabs(entry-sl); if (!(risk > 0)) return {};
  double target = dir > 0 ? -INFINITY : INFINITY;
  for (int i = std::max(0,best-2); i <= best; ++i) target = dir > 0 ? std::max(target,b[i].h) : std::min(target,b[i].l);
  const double tp1 = dir > 0 ? std::max(target,entry+risk*1.5) : std::min(target,entry-risk*1.5), rr = std::fabs(tp1-entry)/risk;
  if (!(rr >= 1.5)) return {};
  const double fill = std::clamp((dir > 0 ? top-entry : entry-bottom)/height,0.0,1.0);
  const int age = static_cast<int>(b.size())-1-best, conviction = 4 + 2*(fill >= 0.5) + (age <= 10) + (height/a >= 0.75);
  auto out = signal("fvg_retrace",o,dir,dir > 0 ? "fvg:bull_gap_retrace" : "fvg:bear_gap_retrace",rounded(entry,1e5),rounded(sl,1e5),
    rounded(tp1,1e5),rounded(tp1+dir*risk,1e5),conviction,rounded(rr));
  out.set("fvg",Object{{"top",rounded(top,1e5)},{"bottom",rounded(bottom,1e5)},{"heightAtr",rounded(height/a)},
    {"fillFraction",rounded(fill)},{"originBarIdx",best},{"originBarTime",b[best].t},{"originAgeBars",age}}); return out;
}
static double avgVol(const Bars& b, int from, int to) { double sum = 0; for (int i = from; i <= to; ++i) sum += b[i].v; return to < from ? 0 : sum/(to-from+1); }
static int extremeIdx(const Bars& b, int from, int to, bool high) {
  int best = from; for (int i = from; i <= to; ++i) if (high ? b[i].h > b[best].h : b[i].l < b[best].l) best = i; return best;
}
static Value cupHandle(const Bars& b, const bt::Options& o, int dir) {
  if (b.size() < 210) return {};
  const int last = static_cast<int>(b.size())-1; const double close = b.back().c;
  for (const int p : {20,50,200}) if (dir*(close-vpo::sma(b,p)) <= 0) return {};
  for (int handleLen = 2; handleLen <= 15; ++handleLen) {
    const int right = last-handleLen; if (right < 25) break;
    const double handleExtreme = dir > 0 ? b[extremeIdx(b,right+1,last-1,true)].h : b[extremeIdx(b,right+1,last-1,false)].l;
    if (dir > 0 ? b[right].h <= handleExtreme : b[right].l >= handleExtreme) continue;
    int left = -1, ex = -1; double depthAbs = 0, depth = 0;
    for (int cand = right-15; cand >= std::max(right-120,0); --cand) {
      const double rimC = dir > 0 ? b[cand].h : b[cand].l, rimR = dir > 0 ? b[right].h : b[right].l;
      if (rimC < rimR*0.95 || rimC > rimR*1.15) continue;
      const int index = extremeIdx(b,cand+1,right-1,dir < 0);
      const double rim = dir > 0 ? std::min(rimC,rimR) : std::max(rimC,rimR), extreme = dir > 0 ? b[index].l : b[index].h;
      const double abs = dir > 0 ? rim-extreme : extreme-rim, d = abs/rim, pos = static_cast<double>(index-cand)/(right-cand);
      if (d < 0.15 || d > 0.33 || pos < 0.2 || pos > 0.8) continue;
      left = cand; ex = index; depthAbs = abs; depth = d; break;
    }
    if (left < 0) continue;
    const int cupLen = right-left; const double ratio = static_cast<double>(handleLen)/cupLen;
    if (ratio < 0.1 || ratio > 0.3) continue;
    const double extreme = dir > 0 ? b[ex].l : b[ex].h, near = extreme+dir*0.15*depthAbs;
    const double rim = dir > 0 ? std::min(b[left].h,b[right].h) : std::max(b[left].l,b[right].l);
    int roundBars = 0; for (int i = left; i <= right; ++i) roundBars += dir > 0 ? b[i].l <= near : b[i].h >= near;
    if (roundBars < 3) continue;
    const int third = std::max(1,cupLen/3);
    const double into = avgVol(b,left,left+third), at = avgVol(b,ex-third/2,ex+third/2), out = avgVol(b,right-third,right);
    const bool volumeShape = at > 0 && into > at && out > at;
    const double far = dir > 0 ? b[extremeIdx(b,right+1,last-1,false)].l : b[extremeIdx(b,right+1,last-1,true)].h;
    if (dir > 0 ? far < rim-depthAbs*0.5 : far > rim+depthAbs*0.5) continue;
    const double handleVolume = avgVol(b,right+1,last-1); if (!(out > 0) || !(handleVolume < out)) continue;
    const double prior2 = dir > 0 ? std::max(b[last-1].h,b[last-2].h) : std::min(b[last-1].l,b[last-2].l);
    const double breakout = dir > 0 ? std::max(prior2,handleExtreme) : std::min(prior2,handleExtreme);
    if (dir*(close-breakout) <= 0) continue;
    const double volX = handleVolume > 0 ? b.back().v/handleVolume : 0; if (volX < 1.3) continue;
    const double windowExtreme = dir > 0 ? b[extremeIdx(b,0,last,true)].h : b[extremeIdx(b,0,last,false)].l;
    const bool room = dir > 0 ? b[right].h >= 0.98*windowExtreme : b[right].l <= 1.02*windowExtreme;
    const double a = vpo::atr(b); if (!(a > 0)) return {};
    const double sl = close-dir*1.5*a, tp1 = dir > 0 ? std::max(b[right].h,handleExtreme)+depthAbs : std::min(b[right].l,handleExtreme)-depthAbs;
    const double risk = std::fabs(close-sl), rr = risk > 0 ? std::fabs(tp1-close)/risk : 0; if (rr < 1.5) continue;
    const int conviction = std::clamp(8-2*(!volumeShape)+room+(volX >= 1.8),0,10);
    auto result = signal(dir > 0 ? "cup_handle" : "inv_cup_handle",o,dir,
      dir > 0 ? "cup:breakout>rim,close>sma20/50/200" : "inv_cup:breakdown<rim,close<sma20/50/200",close,sl,tp1,tp1+dir*depthAbs*0.5,conviction,rounded(rr));
    result.set("cup",Object{{"leftRim",dir > 0 ? b[left].h : b[left].l},{"extreme",extreme},{"rightRim",dir > 0 ? b[right].h : b[right].l},
      {"depthPct",std::floor(depth*1000+0.5)/10},{"cupBars",cupLen},{"handleBars",handleLen},{"shape",dir > 0 ? "cup" : "inverted_cup"}}); return result;
  }
  return {};
}
static Value vpValue(const Bars& b, const bt::Options& o) {
  if (b.size() < 40) return {};
  const double a = vpo::atr(b); if (!(a > 0)) return {};
  const auto vp = vpo::volumeProfile(b); if (!vp.valid || !(vp.vahPrice > vp.valPrice)) return {};
  const auto vs = volumeStructure(b); if (vs.valid && vs.structure != "ranging") return {};
  const auto& bar = b.back(); const double tol = 0.5*a;
  const int dir = std::fabs(bar.l-vp.valPrice) <= tol && bar.c > vp.valPrice && bar.c < vp.pocPrice ? 1
    : std::fabs(bar.h-vp.vahPrice) <= tol && bar.c < vp.vahPrice && bar.c > vp.pocPrice ? -1 : 0;
  if (!dir) return {};
  const double edge = dir > 0 ? vp.valPrice : vp.vahPrice, sl = edge-dir*0.5*a, risk = std::fabs(bar.c-sl);
  if (!(risk > 0) || dir*(vp.pocPrice-bar.c) <= 0) return {};
  const double rr = rounded(std::fabs(vp.pocPrice-bar.c)/risk); if (rr < 1.5 || inLowVolumeNode(bar.c,vs.lvns)) return {};
  return signal("vp_value",o,dir,dir > 0 ? "vp:val_reclaim" : "vp:vah_reject",bar.c,sl,vp.pocPrice,dir > 0 ? vp.vahPrice : vp.valPrice,
    8+(std::fabs(bar.c-edge) > 0.3*a)+(std::fabs(vp.pocPrice-bar.c) > 1.5*a),rr);
}
static Value vaBreakout(const Bars& b, const bt::Options& o) {
  if (b.size() < 60) return {};
  const double a = vpo::atr(b); if (!(a > 0)) return {};
  const auto vs = volumeStructure(b); if (!vs.valid) return {};
  const int last = static_cast<int>(b.size())-1; const auto& bar = b.back();
  int dir = 0; double level = 0; std::string reason;
  if (vs.structure == "ranging") {
    for (int i = last-1; i >= std::max(static_cast<int>(b.size())-vs.sessionBars,last-12); --i) {
      if (b[i].t < vs.openMs) break;
      if (b[i].c > vs.prev.vahPrice) { dir = 1; level = vs.prev.vahPrice; reason = "va:close>vah"; break; }
      if (b[i].c < vs.prev.valPrice) { dir = -1; level = vs.prev.valPrice; reason = "va:close<val"; break; }
    }
  } else if (vs.structure == "bullish") { dir = 1; level = vs.prev.vahPrice; reason = "va:bullish_open>vah"; }
  else if (vs.structure == "bearish") { dir = -1; level = vs.prev.valPrice; reason = "va:bearish_open<val"; }
  if (!dir || std::fabs((dir > 0 ? bar.l : bar.h)-level) > 0.35*a || dir*(bar.c-level) <= 0 || inLowVolumeNode(bar.c,vs.lvns)) return {};
  double risk = dir*(bar.c-vs.prev.pocPrice)+0.5*a;
  risk = std::min(std::max(risk,std::fabs(bar.c-level)+0.5*a),2.5*a); if (!(risk > 0)) return {};
  const double height = vs.prev.vahPrice-vs.prev.valPrice, tp1 = level+dir*height, tp2 = level+dir*1.5*height;
  if (dir*(tp1-bar.c) <= 0) return {};
  const double rr = rounded(std::fabs(tp1-bar.c)/risk); if (rr < 1.5) return {};
  return signal("va_breakout",o,dir,reason,bar.c,bar.c-dir*risk,tp1,tp2,8+(vs.migration == (dir > 0 ? "up" : "down"))+(vs.structure != "ranging"),rr);
}
bool supportsExtended(const std::string& s) { return s == "cup_handle" || s == "inv_cup_handle" || s == "ema_pullback" || s == "rsi_meanrev" || s == "fvg_retrace" || s == "vp_value" || s == "va_breakout"; }
Value computeExtended(const std::string& s, const Bars& b, const bt::Options& o, const Value& settings) {
  if (s == "cup_handle") return cupHandle(b,o,1);
  if (s == "inv_cup_handle") return cupHandle(b,o,-1);
  if (s == "ema_pullback") return emaPullback(b,o,settings);
  if (s == "rsi_meanrev") return rsiMeanrev(b,o);
  if (s == "fvg_retrace") return fvg(b,o);
  if (s == "vp_value") return vpValue(b,o);
  if (s == "va_breakout") return vaBreakout(b,o);
  throw std::invalid_argument("native_strategy_unsupported");
}
}
