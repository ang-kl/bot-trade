#pragma once
// cpp-verify/src/mae_chandelier_observe.hpp
//
// Independent observe-only check. No transport, no order, no amend.
// may_amend is a constant. A future edit that returns true fails the test.

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <vector>

struct MaeBar {
  double h;
  double l;
  double c;
};

struct MaeObserve {
  bool may_amend;
  double mae;
  double mfe;
  bool bars_ok;
};

inline double mae_wilder_atr(const std::vector<MaeBar>& bars, int period) {
  if (period < 1 || static_cast<int>(bars.size()) < period + 1) return 0;
  double seed = 0;
  for (int i = 1; i <= period; ++i) {
    const double tr = std::max(bars[i].h - bars[i].l,
      std::max(std::fabs(bars[i].h - bars[i - 1].c), std::fabs(bars[i].l - bars[i - 1].c)));
    seed += tr;
  }
  double atr = seed / period;
  for (int i = period + 1; i < static_cast<int>(bars.size()); ++i) {
    const double tr = std::max(bars[i].h - bars[i].l,
      std::max(std::fabs(bars[i].h - bars[i - 1].c), std::fabs(bars[i].l - bars[i - 1].c)));
    atr = (atr * (period - 1) + tr) / period;
  }
  return atr;
}

inline MaeObserve mae_chandelier_observe(double entry, double price, const std::vector<MaeBar>& bars) {
  MaeObserve out{false, 0, 0, false};
  if (!(entry > 0) || !(price > 0)) return out;
  out.mae = std::max(0.0, entry - price);
  out.mfe = std::max(0.0, price - entry);
  out.bars_ok = mae_wilder_atr(bars, 22) > 0;
  out.may_amend = false;
  return out;
}
