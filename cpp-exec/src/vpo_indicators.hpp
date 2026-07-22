// cpp-exec/src/vpo_indicators.hpp
//
// Native C++ indicator math for the Virtual Pending Order engine (owner
// directive 2026-07-22: "You must implement the VWAP and Volume Profile
// (POC) mathematical calculations natively in C++. Do not use Node.js
// callbacks or inter-process communication for indicator math, as this
// introduces unacceptable latency.").
//
// SOURCE OF TRUTH (parity is the contract, same convention as backtest.hpp):
//   agent/lib/indicators.js   (vwapAnchored, volumeProfile)
//   agent/services/fib-strategy.js (atr)
// Reuses bt::Bar (backtest.hpp) instead of inventing a second bar type.
#pragma once

#include <vector>

#include "backtest.hpp"

namespace vpo {

using Bar = bt::Bar;

// Simple average true range over the trailing `period` bars — mirrors
// fib-strategy.js's atr() exactly (NOT Wilder-smoothed).
double atr(const std::vector<Bar>& bars, int period = 14);

// Anchored VWAP series: cumulative sums reset every time the bar's timestamp
// crosses into a new `periodMs` bucket. Mirrors agent/lib/indicators.js's
// vwapAnchored() bar-for-bar. Returns one value per input bar (never empty —
// a bar with zero cumulative volume falls back to its own typical price,
// same as the JS).
std::vector<double> vwapAnchored(const std::vector<Bar>& bars, double periodMs);

struct VolumeProfileResult {
  bool valid = false; // false when the slice is empty or carries zero volume
  double pocPrice = 0.0;
  double vahPrice = 0.0;
  double valPrice = 0.0;
};

// Volume profile over the given bar slice: `buckets` equal-price buckets
// spanning [min low, max high], each bar's volume spread uniformly across
// the buckets its high/low range overlaps. POC is the heaviest bucket; the
// value area expands from POC to 70% of total volume, adding whichever
// neighbouring bucket carries more volume at each step. Mirrors
// agent/lib/indicators.js's volumeProfile() (composite/full-range mode —
// the only mode the C++ strategies need for a single evaluation window).
VolumeProfileResult volumeProfile(const std::vector<Bar>& bars, int buckets = 24);

} // namespace vpo
