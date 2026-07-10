// cpp-exec/src/tests/test_backtest.cpp
//
// Plain-assert coverage of the fib backtest port:
// - resolveExit: SL-before-TP + gap-fills-at-open
// - resolvePending: fill / cancel (close beyond SL) / expiry
// - end-to-end close-mode trade on a crafted swing/retrace series
// - touch mode parks a resting order and fills it at the level
//   (fixture ported from agent/services/fib-strategy-pending.test.js)
// - flat series -> zero trades
#include <cassert>
#include <cmath>
#include <cstdio>
#include <vector>

#include "../backtest.hpp"

using bt::Bar;

static const double HOUR = 3600000.0;
static const double T0 = 1767571200000.0;  // 2026-01-05 UTC (matches JS fixture)

static Bar mk(int i, double p) {
  return {T0 + i * HOUR, p + 0.1, p + 0.3, p - 0.4, p, 100};
}

// Ported from fib-strategy-pending.test.js:25-36 buildRetraceBars():
// decline to fractal LOW at idx 15 (l=90), rally to fractal HIGH at idx 30
// (h~110.3), then a shallow retrace ending well ABOVE the 61.8% zone.
static std::vector<Bar> buildRetraceBars(int lastIdx = 39) {
  std::vector<Bar> bars;
  for (int i = 0; i <= 15; i++) bars.push_back(mk(i, 96.4 - 0.4 * i + 0.4));
  bars[15].l = 90; bars[15].c = 90.4;                       // swing low anchor
  for (int i = 16; i <= 30; i++) bars.push_back(mk(i, 90 + (20.0 / 15.0) * (i - 15)));
  for (int i = 31; i <= lastIdx; i++) bars.push_back(mk(i, 110 - 0.5 * (i - 30)));
  return bars;
}

// Extend the retrace all the way into the 61.8% zone (~97.7546), then rally
// back to the swing high so a close-mode entry books a TP exit.
static std::vector<Bar> buildTradeBars() {
  std::vector<Bar> bars = buildRetraceBars(55);  // i=55 close 97.5, in zone
  for (int i = 56; i <= 70; i++) bars.push_back(mk(i, 98 + (i - 56)));
  return bars;
}

static void testResolveExit() {
  // SL before TP when both are inside one bar (long: sl 99, tp 105).
  bt::Position pos{1, 100, 99, 105, T0, 0};
  Bar both{T0 + HOUR, 100, 106, 98, 104, 1};
  bt::Exit e = bt::resolveExit(pos, both);
  assert(e.hit && e.reason == "sl" && e.price == 99);

  // Gap: bar OPENS below the long SL -> fills at the open, not the SL.
  Bar gap{T0 + HOUR, 97, 97.5, 96, 97, 1};
  e = bt::resolveExit(pos, gap);
  assert(e.hit && e.reason == "sl" && e.price == 97);

  // Short gap: opens above the SL -> open fill.
  bt::Position sh{-1, 100, 101, 95, T0, 0};
  Bar gapUp{T0 + HOUR, 103, 104, 102.5, 103, 1};
  e = bt::resolveExit(sh, gapUp);
  assert(e.hit && e.reason == "sl" && e.price == 103);

  // TP only: books exactly the TP even when the bar opens beyond it.
  Bar tpBar{T0 + HOUR, 106, 107, 104.5, 106, 1};
  e = bt::resolveExit(pos, tpBar);
  assert(e.hit && e.reason == "tp" && e.price == 105);

  // Time cap: neither level hit, cap elapsed -> exit at the close.
  bt::Position capped{1, 100, 90, 120, T0, 2 * HOUR};
  Bar quiet{T0 + 2 * HOUR, 100, 101, 99.5, 100.5, 1};
  e = bt::resolveExit(capped, quiet);
  assert(e.hit && e.reason == "time_cap" && e.price == 100.5);

  // No exit.
  e = bt::resolveExit(pos, Bar{T0 + HOUR, 100, 101, 99.5, 100.5, 1});
  assert(!e.hit);
  std::puts("ok resolveExit (SL-first, gap fill, tp, time_cap)");
}

static void testResolvePending() {
  bt::Pending p{1, 97.75, 89.59, 110.3, 24 * HOUR, T0 + 24 * HOUR};

  // Fill: bar range touches the level.
  assert(bt::resolvePending(p, Bar{T0 + HOUR, 98, 98.3, 97.5, 97.9, 1}) == 1);
  // No action: bar stays above the level, before expiry, close above SL.
  assert(bt::resolvePending(p, Bar{T0 + HOUR, 99, 99.3, 98.5, 99, 1}) == 0);
  // Cancel: bar CLOSES beyond the stop.
  assert(bt::resolvePending(p, Bar{T0 + HOUR, 90, 90.3, 88, 89, 1}) == -1);
  // Cancel: expired (bar.t >= expireT) even if it would touch.
  assert(bt::resolvePending(p, Bar{T0 + 24 * HOUR, 98, 98.3, 97.5, 97.9, 1}) == -1);
  std::puts("ok resolvePending (fill, hold, cancel, expiry)");
}

static void testFlatSeries() {
  std::vector<Bar> flat;
  for (int i = 0; i < 60; i++) flat.push_back({T0 + i * HOUR, 100, 100, 100, 100, 1});
  bt::Options opts;
  opts.timeframe = "1h"; opts.tfMinutes = 60;
  bt::BacktestResult r = bt::runFibBacktest(flat, opts);
  assert(r.trades.empty());
  assert(r.stats.get("trades").asNumber() == 0);
  std::puts("ok flat series -> zero trades");
}

static void testCloseModeEndToEnd() {
  std::vector<Bar> bars = buildTradeBars();
  bt::Options opts;
  opts.timeframe = "1h"; opts.tfMinutes = 60;
  opts.entryMode = "close";
  opts.minConviction = 0;  // take every zone touch (backtest-fib.js:147 note)
  bt::BacktestResult r = bt::runFibBacktest(bars, opts);
  assert(r.trades.size() == 1);
  const bt::Trade& t = r.trades[0];
  assert(t.dir == 1);
  assert(t.entry == bars[56].o);          // next-open fill (js:166)
  assert(t.reason == "tp");
  assert(std::fabs(t.exit - 110.3) < 1e-9);  // tp1 = swingB
  assert(t.pnlPct > 0);
  assert(r.stats.get("trades").asNumber() == 1);
  assert(r.stats.get("wins").asNumber() == 1);
  assert(r.stats.get("winRatePct").asNumber() == 100);
  assert(r.stats.get("maxDrawdownPct").asNumber() == 0);
  std::puts("ok close mode end-to-end (1 trade, next-open entry, tp exit)");
}

static void testTouchModeParksAndFills() {
  // Normal (close) mode on the 40-bar retrace fixture: price never enters
  // the zone, so no signal fires — mirrors the JS pending test's null case.
  {
    std::vector<Bar> bars = buildRetraceBars(39);
    bt::Signal s = bt::computeFibSignal(bars, bars.size(),
                                        bt::Options{"1h", 60, 0, "close", 8, 0.02, 240}, false);
    assert(!s.valid);
    bt::Signal p = bt::computeFibSignal(bars, bars.size(),
                                        bt::Options{"1h", 60, 0, "touch", 8, 0.02, 240}, true);
    assert(p.valid);
    assert(p.dir == 1);
    assert(p.conviction == 8);              // fixed conviction for resting orders
    const double range = p.tp1 - 90;        // swingB - swingA
    const double expected618 = p.tp1 - 0.618 * range;
    assert(std::fabs(p.entry - expected618) < 1e-9);
    assert(p.sl < 90);                      // long SL sits below the swing origin
    assert(std::fabs(p.tp1 - 110.3) < 1e-9);
  }

  // Full touch-mode run: order parks off the confirmed swing, fills when
  // the retrace touches the 61.8% level, then rides to TP.
  std::vector<Bar> bars = buildTradeBars();
  bt::Options opts;
  opts.timeframe = "1h"; opts.tfMinutes = 60;
  opts.entryMode = "touch";  // minConviction default 8; pending conviction = 8
  bt::BacktestResult r = bt::runFibBacktest(bars, opts);
  assert(r.trades.size() == 1);
  const bt::Trade& t = r.trades[0];
  assert(t.dir == 1);
  const double range = 110.3 - 90;
  const double level618 = 110.3 - 0.618 * range;
  assert(std::fabs(t.entry - level618) < 1e-9);  // fills AT the level
  assert(t.reason == "tp");
  assert(std::fabs(t.exit - 110.3) < 1e-9);
  // Touch entry (at the level) beats the close-mode fill on the same move.
  std::puts("ok touch mode parks a resting order and fills at the 61.8% level");
}

static void testWalkForwardAndPayload() {
  std::vector<Bar> bars = buildTradeBars();
  bt::Options opts;
  opts.timeframe = "1h"; opts.tfMinutes = 60;
  opts.entryMode = "touch";
  jsn::Value wf = bt::walkForward(bars, opts);
  assert(wf.get("segments").asArray().size() == 4);
  assert(wf.get("active").asNumber() >= 0);
  assert(wf.get("worstMddPct").asNumber() >= 0);

  // Payload round trip — same shape the CLI/HTTP surface consumes.
  jsn::Array rows;
  for (const Bar& b : bars) {
    jsn::Array row;
    row.push_back(jsn::Value(b.t)); row.push_back(jsn::Value(b.o));
    row.push_back(jsn::Value(b.h)); row.push_back(jsn::Value(b.l));
    row.push_back(jsn::Value(b.c)); row.push_back(jsn::Value(b.v));
    rows.push_back(jsn::Value(std::move(row)));
  }
  jsn::Value payload{jsn::Object{}};
  payload.set("bars", jsn::Value(std::move(rows)));
  payload.set("timeframe", std::string("1h"));
  payload.set("tfMinutes", 60.0);
  payload.set("capMinutes", jsn::Value(nullptr));
  payload.set("entryMode", std::string("touch"));
  payload.set("minConviction", 8.0);
  std::string err;
  jsn::Value out = bt::runBacktestPayload(payload, err);
  assert(err.empty());
  assert(out.get("trades").asArray().size() == 1);
  assert(out.get("stats").get("trades").asNumber() == 1);
  assert(out.get("wf").get("segments").asArray().size() == 4);
  const jsn::Value& tr = out.get("trades").asArray()[0];
  assert(tr.get("reason").asString() == "tp");
  assert(tr.get("dir").asNumber() == 1);

  // Bad payload -> error, no crash.
  jsn::Value bad{jsn::Object{}};
  bad.set("bars", std::string("nope"));
  bt::runBacktestPayload(bad, err);
  assert(!err.empty());
  std::puts("ok walkForward K=4 + CLI payload round trip");
}

static void testTimeCapFor() {
  assert(bt::timeCapFor("4h", 240) == 4320);       // table hit
  assert(bt::timeCapFor("1mo", 43200) == 259200);  // table hit
  assert(bt::timeCapFor("1.5h", 90) == 2160);      // 90*24 clamp passthrough
  assert(bt::timeCapFor("1m", 1) == 240);          // clamped low
  assert(bt::timeCapFor("2w", 20160) == 259200);   // clamped high
  std::puts("ok timeCapFor (table + 24x clamp)");
}

int main() {
  testResolveExit();
  testResolvePending();
  testFlatSeries();
  testCloseModeEndToEnd();
  testTouchModeParksAndFills();
  testWalkForwardAndPayload();
  testTimeCapFor();
  std::puts("test_backtest: all assertions passed");
  return 0;
}
