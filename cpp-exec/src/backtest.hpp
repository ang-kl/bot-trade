// cpp-exec/src/backtest.hpp
//
// C++ port of the fib 61.8% fade backtest. SOURCE OF TRUTH:
//   agent/services/fib-strategy.js   (computeFibSignal, findSwings, atr,
//                                     timeCapFor + constants)
//   agent/scripts/backtest-fib.js    (runBacktest, resolveExit,
//                                     resolvePending, walkForward,
//                                     computeStats subset)
// PARITY IS THE CONTRACT: arithmetic mirrors the JS expression order so
// doubles match bit-for-bit where possible. Comments cite JS line numbers.
#pragma once

#include <string>
#include <vector>

#include "json.hpp"

namespace bt {

struct Bar {
  double t = 0, o = 0, h = 0, l = 0, c = 0, v = 0;
};

// Constants — fib-strategy.js:17-31 + backtest-fib.js:67-70
constexpr int    kFractalWidth  = 2;      // FRACTAL_WIDTH
constexpr double kZoneTolerance = 0.05;   // ZONE_TOLERANCE
constexpr double kMinLegAtrMult = 3;      // MIN_LEG_ATR_MULT
constexpr int    kAtrPeriod     = 14;     // ATR_PERIOD
constexpr double kSlBuffer      = 0.02;   // SL_BUFFER
constexpr double kTp2Extension  = 0.272;  // TP2_EXTENSION
constexpr int    kWarmupBars    = 30;     // WARMUP_BARS
constexpr double kMinRR         = 1.5;    // MIN_RR

struct Options {
  std::string timeframe;          // label, e.g. "4h" (table lookup key)
  double tfMinutes = 0;           // bar duration in minutes, passed IN by caller
  double capMinutes = 0;          // <=0 -> compute via timeCapFor(timeframe, tfMinutes)
  std::string entryMode = "close";// "close" | "touch"
  double minConviction = 8;       // backtest-fib.js:148 (opts.minConviction ?? 8)
  double costPct = 0.02;          // DEFAULT_COST_PCT
  double cooldownMinutes = 240;   // DEFAULT_COOLDOWN_MIN
};

struct Trade {
  int dir = 0;
  double entry = 0, exit = 0;
  double entryT = 0, exitT = 0;
  double pnlPct = 0;
  std::string reason;
};

struct Signal {              // subset of computeFibSignal's return we use
  bool valid = false;
  int dir = 0;               // +1 long / -1 short (bias)
  double entry = 0, sl = 0, tp1 = 0, tp2 = 0;
  double conviction = 0;
  double rr = 0;             // rounded to 2dp like fib-strategy.js:301
  double timeCapMinutes = 0;
};

struct SwingPoint { int idx; double price; double t; };
struct Swings { std::vector<SwingPoint> highs, lows; };

struct Pending {             // backtest-fib.js:87,154-161
  int dir = 0;
  double level = 0, sl = 0, tp = 0;
  double capMs = 0, expireT = 0;
};

struct Position {            // backtest-fib.js:86,164-171
  int dir = 0;
  double entry = 0, sl = 0, tp = 0;
  double entryT = 0, capMs = 0;
};

struct Exit { bool hit = false; double price = 0; std::string reason; };

struct BacktestResult {
  std::vector<Trade> trades;
  jsn::Value stats;          // computeStats subset (JSON-shaped)
};

// fib-strategy.js:70-86 — mean true range over trailing `period` bars
double atr(const std::vector<Bar>& bars, size_t n, int period = kAtrPeriod);

// fib-strategy.js:171-186 — N-bar fractal swing highs/lows over bars[0..n)
Swings findSwings(const std::vector<Bar>& bars, size_t n,
                  int fractalWidth = kFractalWidth);

// fib-strategy.js:61-64 — table for classic TFs, clamped 24x bar duration
// for custom ones. Parameterised by tfMinutes (caller supplies tfMs/60000).
double timeCapFor(const std::string& timeframe, double tfMinutes);

// fib-strategy.js:193-310 — signal over bars[0..n) (== bars.slice(0, n)).
// Optional rsi/vwap/fvg confluence filters are NOT ported (off by default
// and absent from the pinned CLI/HTTP payload).
Signal computeFibSignal(const std::vector<Bar>& bars, size_t n,
                        const Options& opts, bool pendingSetup);

// backtest-fib.js:46-51
// returns +1 fill, -1 cancel, 0 no action
int resolvePending(const Pending& pending, const Bar& bar);

// backtest-fib.js:53-65
Exit resolveExit(const Position& pos, const Bar& bar);

// backtest-fib.js:79-180
BacktestResult runFibBacktest(const std::vector<Bar>& bars, const Options& opts);

// backtest-fib.js:258-277 — {segments,active,positive,worstMddPct}
jsn::Value walkForward(const std::vector<Bar>& bars, const Options& opts, int K = 4);

// Trades as a JSON array (dir/entry/exit/entryT/exitT/pnlPct/reason)
jsn::Value tradesToJson(const std::vector<Trade>& trades);

// Full CLI/HTTP payload handler: {bars:[[t,o,h,l,c,v],...], timeframe,
// tfMinutes, capMinutes|null, entryMode, minConviction} ->
// {trades, stats, wf}. Returns error message in `err` on bad payload.
jsn::Value runBacktestPayload(const jsn::Value& payload, std::string& err);

}  // namespace bt
