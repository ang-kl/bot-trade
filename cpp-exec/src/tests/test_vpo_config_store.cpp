// cpp-exec/src/tests/test_vpo_config_store.cpp
#include <cassert>
#include <cmath>
#include <cstdio>

#include "../vpo_config_store.hpp"

using vpo::Bar;
using vpo::VpoConfigStore;

static void test_bars_round_trip() {
  VpoConfigStore store;
  assert(store.getBars("EURUSD", "4h").empty()); // never set -> empty
  std::vector<Bar> bars = {{0, 1, 2, 0.5, 1.5, 100}, {1, 1.5, 2.5, 1, 2, 100}};
  store.setBars("EURUSD", "4h", bars);
  auto got = store.getBars("EURUSD", "4h");
  assert(got.size() == 2);
  assert(got[1].c == 2);
  // A different (symbol,timeframe) key stays empty.
  assert(store.getBars("EURUSD", "15m").empty());
  assert(store.getBars("GBPUSD", "4h").empty());
}

static void test_bars_stale_treated_as_absent() {
  VpoConfigStore store(/*maxAgeMs=*/-1); // any elapsed time is "stale"
  store.setBars("EURUSD", "4h", {{0, 1, 2, 0.5, 1.5, 100}});
  assert(store.getBars("EURUSD", "4h").empty());
}

static void test_volume_round_trip() {
  VpoConfigStore store;
  assert(store.getVolume("vwap_trend:EURUSD") == -1); // never set
  store.setVolume("vwap_trend:EURUSD", 0.5);
  assert(std::fabs(store.getVolume("vwap_trend:EURUSD") - 0.5) < 1e-9);
  assert(store.getVolume("vp_value:GBPUSD") == -1); // different key stays unset
}

static void test_volume_stale_treated_as_unavailable() {
  VpoConfigStore store(/*maxAgeMs=*/-1);
  store.setVolume("vwap_trend:EURUSD", 0.5);
  assert(store.getVolume("vwap_trend:EURUSD") == -1);
}

int main() {
  test_bars_round_trip();
  test_bars_stale_treated_as_absent();
  test_volume_round_trip();
  test_volume_stale_treated_as_unavailable();
  std::printf("test_vpo_config_store: all assertions passed\n");
  return 0;
}
