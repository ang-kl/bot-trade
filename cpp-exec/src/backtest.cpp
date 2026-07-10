// cpp-exec/src/backtest.cpp — see backtest.hpp for the parity contract.
// Every function cites the JS lines it mirrors; expression order is kept
// identical to the JS so IEEE-754 doubles match bit-for-bit where possible.
#include "backtest.hpp"

#include <algorithm>
#include <cmath>
#include <map>

namespace bt {

// JS Math.round: half-away-from-zero is WRONG — JS rounds half toward +inf.
static double jsRound(double x) { return std::floor(x + 0.5); }
// backtest-fib.js:199 — const round2 = x => Math.round(x * 100) / 100
static double round2(double x) { return jsRound(x * 100) / 100; }

// fib-strategy.js:70-86
double atr(const std::vector<Bar>& bars, size_t n, int period) {
  if (n < 2) return 0;                                    // js:71
  // js:72 — bars.slice(-(period + 1))
  size_t start = n > static_cast<size_t>(period + 1) ? n - (period + 1) : 0;
  double sum = 0;                                         // js:73
  int cnt = 0;                                            // js:74
  for (size_t i = start + 1; i < n; i++) {                // js:75
    const double prevClose = bars[i - 1].c;               // js:76
    const double tr = std::max(bars[i].h - bars[i].l,     // js:77-81
                               std::max(std::fabs(bars[i].h - prevClose),
                                        std::fabs(bars[i].l - prevClose)));
    sum += tr;
    cnt++;
  }
  return cnt > 0 ? sum / cnt : 0;                         // js:85
}

// fib-strategy.js:171-186
Swings findSwings(const std::vector<Bar>& bars, size_t n, int fractalWidth) {
  Swings out;
  const long long len = static_cast<long long>(n);
  for (long long i = fractalWidth; i < len - fractalWidth; i++) {  // js:174
    bool isHigh = true, isLow = true;                              // js:175-176
    for (long long j = i - fractalWidth; j <= i + fractalWidth; j++) {  // js:177
      if (bars[j].h > bars[i].h) isHigh = false;                   // js:178
      if (bars[j].l < bars[i].l) isLow = false;                    // js:179
      if (!isHigh && !isLow) break;                                // js:180
    }
    if (isHigh) out.highs.push_back({static_cast<int>(i), bars[i].h, bars[i].t});  // js:182
    if (isLow)  out.lows.push_back({static_cast<int>(i), bars[i].l, bars[i].t});   // js:183
  }
  return out;
}

// fib-strategy.js:39-43 TIME_CAP_MINUTES + js:61-64 timeCapFor
double timeCapFor(const std::string& timeframe, double tfMinutes) {
  static const std::map<std::string, double> kTable = {
      {"5m", 240},   {"15m", 480},   {"30m", 720},  {"1h", 1440},
      {"4h", 4320},  {"1d", 20160},  {"1w", 60480}, {"1mo", 259200},
  };
  auto it = kTable.find(timeframe);
  if (it != kTable.end()) return it->second;
  // js:63 — Math.min(Math.max(Math.round((tfMs / 60_000) * 24), 240), 259_200)
  // caller passes tfMinutes = tfMs / 60000, so round(tfMinutes * 24).
  return std::min(std::max(jsRound(tfMinutes * 24), 240.0), 259200.0);
}

// fib-strategy.js:193-310 (optional rsi/vwap/fvg filters not ported — off
// by default and absent from the pinned payload)
Signal computeFibSignal(const std::vector<Bar>& bars, size_t n,
                        const Options& opts, bool pendingSetup) {
  Signal sig;
  if (n < static_cast<size_t>(kFractalWidth * 2 + 10)) return sig;  // js:194

  const Swings sw = findSwings(bars, n);                            // js:196
  if (sw.highs.empty() || sw.lows.empty()) return sig;              // js:197

  const SwingPoint& lastHigh = sw.highs.back();                     // js:199
  const SwingPoint& lastLow = sw.lows.back();                       // js:200
  if (lastHigh.idx == lastLow.idx) return sig;                      // js:201

  const bool upLeg = lastHigh.idx > lastLow.idx;                    // js:203
  const SwingPoint& swingA = upLeg ? lastLow : lastHigh;            // js:204
  const SwingPoint& swingB = upLeg ? lastHigh : lastLow;            // js:205
  const double range = std::fabs(swingB.price - swingA.price);      // js:206
  if (range <= 0) return sig;                                       // js:207

  if (range < kMinLegAtrMult * atr(bars, n)) return sig;            // js:211

  const double level618 = upLeg ? swingB.price - 0.618 * range      // js:213-215
                                : swingB.price + 0.618 * range;

  const double tolerance = kZoneTolerance * range;                  // js:217
  const double lastClose = bars[n - 1].c;                           // js:218
  const double distFromLevel = std::fabs(lastClose - level618);     // js:219
  if (!pendingSetup && distFromLevel > tolerance) return sig;       // js:225

  const double buffer = kSlBuffer * range;                          // js:229
  const bool invalidated = upLeg ? lastClose < swingA.price - buffer  // js:230-232
                                 : lastClose > swingA.price + buffer;
  if (invalidated) return sig;                                      // js:233

  const double entry = pendingSetup ? level618 : lastClose;         // js:271
  const double sl = upLeg ? swingA.price - buffer : swingA.price + buffer;  // js:272
  const double tp1 = swingB.price;                                  // js:273
  const double tp2 = upLeg ? swingB.price + kTp2Extension * range   // js:274
                           : swingB.price - kTp2Extension * range;

  const double slDistance = std::fabs(entry - sl);                  // js:276
  const double tp1Distance = std::fabs(tp1 - entry);                // js:277
  const double rr = slDistance > 0 ? tp1Distance / slDistance : 0;  // js:278

  // js:287-290
  const double proximity = 1 - std::min(1.0, distFromLevel / tolerance);
  const double conviction = pendingSetup ? 8 : jsRound(proximity * 10);

  sig.valid = true;
  sig.dir = upLeg ? 1 : -1;                                         // js:235 bias
  sig.entry = entry;
  sig.sl = sl;
  sig.tp1 = tp1;
  sig.tp2 = tp2;
  sig.conviction = conviction;
  sig.rr = jsRound(rr * 100) / 100;                                 // js:301
  // js:306 — time_cap_minutes: timeCapFor(timeframe) || null (always >0
  // here); opts.capMinutes>0 lets the caller pin the JS engine's cap.
  sig.timeCapMinutes = opts.capMinutes > 0
                           ? opts.capMinutes
                           : timeCapFor(opts.timeframe, opts.tfMinutes);
  return sig;
}

// backtest-fib.js:46-51
int resolvePending(const Pending& pending, const Bar& bar) {
  if (bar.t >= pending.expireT) return -1;                          // js:47 cancel
  if (pending.dir > 0 ? bar.c <= pending.sl : bar.c >= pending.sl)  // js:48
    return -1;
  if (bar.l <= pending.level && pending.level <= bar.h) return 1;   // js:49 fill
  return 0;                                                         // js:50
}

// backtest-fib.js:53-65
Exit resolveExit(const Position& pos, const Bar& bar) {
  if (pos.dir > 0 ? bar.l <= pos.sl : bar.h >= pos.sl) {            // js:54
    const double price = pos.dir > 0 ? std::min(pos.sl, bar.o)      // js:55
                                     : std::max(pos.sl, bar.o);
    return {true, price, "sl"};
  }
  if (pos.dir > 0 ? bar.h >= pos.tp : bar.l <= pos.tp)              // js:58
    return {true, pos.tp, "tp"};
  if (pos.capMs > 0 && bar.t - pos.entryT >= pos.capMs)             // js:61
    return {true, bar.c, "time_cap"};
  return {};
}

// backtest-fib.js:182-247 — ONLY the fields the verdict gates use.
static jsn::Value computeStats(const std::vector<Trade>& trades) {
  jsn::Value stats{jsn::Object{}};
  const size_t n = trades.size();                                   // js:183
  if (n == 0) { stats.set("trades", 0.0); return stats; }           // js:184

  double grossWin = 0, grossLoss = 0;                               // js:187-188
  int wins = 0, losses = 0;
  for (const Trade& t : trades) {
    if (t.pnlPct > 0) { wins++; grossWin += t.pnlPct; }             // js:185,187
    else { losses++; grossLoss += t.pnlPct; }                       // js:186,188
  }
  grossLoss = std::fabs(grossLoss);                                 // js:188

  double equity = 0, peak = 0, maxDrawdown = 0;                     // js:190-192
  for (const Trade& t : trades) {                                   // js:193-197
    equity += t.pnlPct;
    if (equity > peak) peak = equity;
    if (peak - equity > maxDrawdown) maxDrawdown = peak - equity;
  }

  stats.set("trades", static_cast<double>(n));                      // js:221
  stats.set("wins", static_cast<double>(wins));                     // js:222
  stats.set("losses", static_cast<double>(losses));                 // js:223
  stats.set("winRatePct", round2((static_cast<double>(wins) / n) * 100));  // js:224
  stats.set("totalProfitPct", round2(equity));                      // js:228
  stats.set("profitFactor", grossLoss > 0 ? jsn::Value(round2(grossWin / grossLoss))
                                          : jsn::Value(nullptr));   // js:229
  stats.set("maxDrawdownPct", round2(maxDrawdown));                 // js:231
  return stats;
}

// backtest-fib.js:79-180
BacktestResult runFibBacktest(const std::vector<Bar>& bars, const Options& opts) {
  const double costPct = opts.costPct;                              // js:81
  const double cooldownMs = opts.cooldownMinutes * 60000.0;         // js:82
  const bool touchMode = opts.entryMode == "touch";                 // js:84

  std::vector<Trade> trades;
  bool hasPos = false, hasPending = false;
  Position pos;
  Pending pending;
  double cooldownUntil = -1;                                        // js:88

  // js:90-103
  auto closeTrade = [&](double exitPrice, double exitT, const char* reason) {
    const double gross = pos.dir * ((exitPrice - pos.entry) / pos.entry) * 100;  // js:91
    trades.push_back({pos.dir, pos.entry, exitPrice, pos.entryT, exitT,
                      gross - costPct, reason});                    // js:92-100
    cooldownUntil = exitT + cooldownMs;                             // js:101
    hasPos = false;                                                 // js:102
  };

  const long long len = static_cast<long long>(bars.size());
  for (long long i = kWarmupBars; i < len - 1; i++) {               // js:105
    const Bar& next = bars[i + 1];                                  // js:106

    if (hasPos) {                                                   // js:108
      const Exit exit = resolveExit(pos, next);                     // js:109
      if (exit.hit) closeTrade(exit.price, next.t, exit.reason.c_str());
      continue;
    }

    if (hasPending) {                                               // js:114
      const int r = resolvePending(pending, next);                  // js:115
      if (r == -1) { hasPending = false; }                          // js:116 cancel
      else if (r == 1) {                                            // js:117 fill
        pos = {pending.dir, pending.level, pending.sl, pending.tp,
               next.t, pending.capMs};                              // js:118
        hasPos = true;
        hasPending = false;                                         // js:119
        const Exit sameBar = resolveExit(pos, next);                // js:120
        if (sameBar.hit) closeTrade(sameBar.price, next.t, sameBar.reason.c_str());
        continue;                                                   // js:122
      }
      continue;                                                     // js:125 (one order at a time)
    }

    if (next.t < cooldownUntil) continue;                           // js:128
    // js:131 session filter not ported (off by default, not in payload)

    // js:136-143 — fib is the only strategy in this port; touch mode
    // implies pendingSetup (fib is pendingCapable).
    const Signal signal = computeFibSignal(bars, static_cast<size_t>(i + 1),
                                           opts, touchMode);
    if (!signal.valid || signal.rr < kMinRR) continue;              // js:144
    if (signal.conviction < opts.minConviction) continue;           // js:148

    if (touchMode) {                                                // js:150
      // js:153 — TTL = the signal's own time cap
      const double capMs = signal.timeCapMinutes > 0
                               ? signal.timeCapMinutes * 60000.0
                               : 86400000.0;
      pending = {signal.dir, signal.entry, signal.sl, signal.tp1,
                 capMs, next.t + capMs};                            // js:154-161
      hasPending = true;
      continue;                                                     // js:162
    }
    pos = {signal.dir, next.o, signal.sl, signal.tp1, next.t,       // js:164-171
           signal.timeCapMinutes > 0 ? signal.timeCapMinutes * 60000.0 : 0};
    hasPos = true;
    const Exit sameBar = resolveExit(pos, next);                    // js:174
    if (sameBar.hit) closeTrade(sameBar.price, next.t, sameBar.reason.c_str());
  }
  if (hasPos) closeTrade(bars.back().c, bars.back().t, "end_of_data");  // js:177

  jsn::Value stats = computeStats(trades);
  return {std::move(trades), std::move(stats)};
}

// backtest-fib.js:258-277
jsn::Value walkForward(const std::vector<Bar>& bars, const Options& opts, int K) {
  const size_t segLen = bars.size() / K;                            // js:259 floor
  jsn::Array segments;
  int active = 0, positive = 0;
  double worstMdd = 0;                                              // js:275 Math.max(0, ...)
  for (int k = 0; k < K; k++) {                                     // js:261
    const size_t from = static_cast<size_t>(k) * segLen;            // js:262
    const size_t to = k == K - 1 ? bars.size() : (static_cast<size_t>(k) + 1) * segLen;
    std::vector<Bar> slice(bars.begin() + std::min(from, bars.size()),
                           bars.begin() + std::min(to, bars.size()));
    const BacktestResult r = runFibBacktest(slice, opts);           // js:263
    const double nTrades = r.stats.get("trades").asNumber(0);       // js:265 (||0)
    const double total = r.stats.get("totalProfitPct").asNumber(0); // js:266 (?? 0)
    const double mdd = r.stats.get("maxDrawdownPct").asNumber(0);   // js:267 (?? 0)
    jsn::Value seg{jsn::Object{}};
    seg.set("trades", nTrades);
    seg.set("totalProfitPct", total);
    seg.set("maxDrawdownPct", mdd);
    segments.push_back(seg);
    if (nTrades > 0) {                                              // js:270 active
      active++;
      if (total > 0) positive++;                                    // js:274
    }
    if (mdd > worstMdd) worstMdd = mdd;                             // js:275
  }
  jsn::Value out{jsn::Object{}};
  out.set("segments", jsn::Value(std::move(segments)));
  out.set("active", static_cast<double>(active));
  out.set("positive", static_cast<double>(positive));
  out.set("worstMddPct", worstMdd);
  return out;
}

jsn::Value tradesToJson(const std::vector<Trade>& trades) {
  jsn::Array arr;
  for (const Trade& t : trades) {
    jsn::Value v{jsn::Object{}};
    v.set("dir", static_cast<double>(t.dir));
    v.set("entry", t.entry);
    v.set("exit", t.exit);
    v.set("entryT", t.entryT);
    v.set("exitT", t.exitT);
    v.set("pnlPct", t.pnlPct);
    v.set("reason", t.reason);
    arr.push_back(v);
  }
  return jsn::Value(std::move(arr));
}

jsn::Value runBacktestPayload(const jsn::Value& payload, std::string& err) {
  if (!payload.isObject()) { err = "body must be a JSON object"; return jsn::Value(nullptr); }
  const jsn::Value& jb = payload.get("bars");
  if (!jb.isArray()) { err = "bars must be an array of [t,o,h,l,c,v] arrays"; return jsn::Value(nullptr); }

  std::vector<Bar> bars;
  bars.reserve(jb.asArray().size());
  for (const jsn::Value& row : jb.asArray()) {
    if (!row.isArray() || row.asArray().size() < 5) {
      err = "each bar must be [t,o,h,l,c,v]";
      return jsn::Value(nullptr);
    }
    const jsn::Array& a = row.asArray();
    Bar b;
    b.t = a[0].asNumber();
    b.o = a[1].asNumber();
    b.h = a[2].asNumber();
    b.l = a[3].asNumber();
    b.c = a[4].asNumber();
    b.v = a.size() > 5 ? a[5].asNumber() : 0;
    bars.push_back(b);
  }

  Options opts;
  opts.timeframe = payload.get("timeframe").asString();
  opts.tfMinutes = payload.get("tfMinutes").asNumber(0);
  opts.capMinutes = payload.get("capMinutes").asNumber(0);  // null -> 0 -> computed
  const std::string mode = payload.get("entryMode").asString();
  opts.entryMode = mode.empty() ? "close" : mode;
  const jsn::Value& mc = payload.get("minConviction");
  opts.minConviction = mc.isNumber() ? mc.asNumber() : 8;   // js:148 ?? 8
  const jsn::Value& cost = payload.get("costPct");
  if (cost.isNumber()) opts.costPct = cost.asNumber();
  const jsn::Value& cd = payload.get("cooldownMinutes");
  if (cd.isNumber()) opts.cooldownMinutes = cd.asNumber();

  const BacktestResult r = runFibBacktest(bars, opts);
  jsn::Value out{jsn::Object{}};
  out.set("trades", tradesToJson(r.trades));
  out.set("stats", r.stats);
  out.set("wf", walkForward(bars, opts));
  return out;
}

}  // namespace bt
