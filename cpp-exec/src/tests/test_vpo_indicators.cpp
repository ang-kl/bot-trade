// cpp-exec/src/tests/test_vpo_indicators.cpp — native C++ VWAP/VP/ATR math,
// parity-checked against hand-computed values (same style as
// agent/lib/indicators.test.js's hand-worked examples).
#include <cassert>
#include <cmath>
#include <cstdio>

#include "../vpo_indicators.hpp"

using vpo::Bar;

static bool near(double a, double b, double eps = 1e-9) { return std::fabs(a - b) < eps; }

static void test_atr_basic() {
  // 3 bars, constant true range of 2 each (high-low=2, no gaps) → atr==2.
  std::vector<Bar> bars = {
    {0, 10, 11, 9, 10, 100},
    {1, 10, 11, 9, 10, 100},
    {2, 10, 11, 9, 10, 100},
  };
  assert(near(vpo::atr(bars, 2), 2.0));
}

static void test_atr_too_few_bars() {
  std::vector<Bar> bars = {{0, 10, 11, 9, 10, 100}};
  assert(vpo::atr(bars, 14) == 0.0);
}

static void test_vwap_anchored_resets_at_period_boundary() {
  const double dayMs = 86'400'000.0;
  std::vector<Bar> bars = {
    {0,            10, 12, 8, 10, 100}, // day 0
    {dayMs * 0.5,  10, 12, 8, 10, 100}, // day 0
    {dayMs,        20, 22, 18, 20, 100}, // day 1 — anchor resets
  };
  auto vw = vpo::vwapAnchored(bars, dayMs);
  assert(vw.size() == 3);
  // Day 0: typical price = (12+8+10)/3 = 10 for both bars, constant → vwap stays 10.
  assert(near(vw[0], 10.0));
  assert(near(vw[1], 10.0));
  // Day 1 resets: single bar, vwap == its own typical price = (22+18+20)/3 = 20.
  assert(near(vw[2], 20.0));
}

static void test_volume_profile_finds_poc_at_heaviest_bucket() {
  // Two clusters of bars: most volume concentrated near price 100.
  std::vector<Bar> bars;
  for (int i = 0; i < 10; i++) bars.push_back({double(i), 99, 101, 99, 100, 1000}); // heavy cluster
  for (int i = 10; i < 12; i++) bars.push_back({double(i), 109, 111, 109, 110, 50}); // light cluster
  auto vp = vpo::volumeProfile(bars, 24);
  assert(vp.valid);
  // POC should sit within the heavy cluster's price range, not the light one.
  assert(vp.pocPrice >= 99 && vp.pocPrice <= 101);
  assert(vp.vahPrice >= vp.valPrice);
}

static void test_volume_profile_empty_is_invalid_not_fabricated() {
  std::vector<Bar> bars;
  auto vp = vpo::volumeProfile(bars, 24);
  assert(!vp.valid);
}

static void test_volume_profile_zero_volume_is_invalid() {
  std::vector<Bar> bars = { {0, 10, 11, 9, 10, 0}, {1, 10, 11, 9, 10, 0} };
  auto vp = vpo::volumeProfile(bars, 24);
  assert(!vp.valid);
}

int main() {
  test_atr_basic();
  test_atr_too_few_bars();
  test_vwap_anchored_resets_at_period_boundary();
  test_volume_profile_finds_poc_at_heaviest_bucket();
  test_volume_profile_empty_is_invalid_not_fabricated();
  test_volume_profile_zero_volume_is_invalid();
  std::puts("test_vpo_indicators: all assertions passed");
  return 0;
}
