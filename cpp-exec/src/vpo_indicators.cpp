// cpp-exec/src/vpo_indicators.cpp — see vpo_indicators.hpp for provenance.
#include "vpo_indicators.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace vpo {

double atr(const std::vector<Bar>& bars, int period) {
  if (bars.size() < 2) return 0.0;
  const int wanted = period + 1;
  const int start = static_cast<int>(bars.size()) > wanted
      ? static_cast<int>(bars.size()) - wanted
      : 0;
  double sum = 0.0;
  int n = 0;
  for (int i = start + 1; i < static_cast<int>(bars.size()); i++) {
    const double prevClose = bars[i - 1].c;
    const double tr = std::max({
      bars[i].h - bars[i].l,
      std::fabs(bars[i].h - prevClose),
      std::fabs(bars[i].l - prevClose),
    });
    sum += tr;
    n++;
  }
  return n > 0 ? sum / n : 0.0;
}

std::vector<double> vwapAnchored(const std::vector<Bar>& bars, double periodMs) {
  std::vector<double> out(bars.size(), 0.0);
  double pv = 0.0, vol = 0.0;
  bool havePeriod = false;
  long long curPeriod = 0;
  for (size_t i = 0; i < bars.size(); i++) {
    const Bar& b = bars[i];
    const long long period = periodMs > 0
        ? static_cast<long long>(std::floor(b.t / periodMs))
        : 0;
    if (!havePeriod || period != curPeriod) { pv = 0.0; vol = 0.0; curPeriod = period; havePeriod = true; }
    const double tp = (b.h + b.l + b.c) / 3.0;
    const double v = b.v;
    pv += tp * v;
    vol += v;
    out[i] = vol > 0.0 ? pv / vol : tp;
  }
  return out;
}

VolumeProfileResult volumeProfile(const std::vector<Bar>& bars, int buckets) {
  VolumeProfileResult r;
  if (bars.empty()) return r;

  double lo = std::numeric_limits<double>::infinity();
  double hi = -std::numeric_limits<double>::infinity();
  for (const auto& b : bars) {
    if (b.l < lo) lo = b.l;
    if (b.h > hi) hi = b.h;
  }
  const int n = std::max(1, buckets);
  const double span = hi - lo;
  const double step = span > 0.0 ? span / n : 1.0;
  std::vector<double> vols(n, 0.0);

  for (const auto& b : bars) {
    const double v = b.v;
    if (v <= 0.0) continue;
    if (span == 0.0) { vols[0] += v; continue; }
    int b0 = static_cast<int>(std::floor((b.l - lo) / step));
    int b1 = static_cast<int>(std::floor((b.h - lo) / step));
    b0 = std::min(n - 1, std::max(0, b0));
    b1 = std::min(n - 1, std::max(0, b1));
    const double share = v / (b1 - b0 + 1);
    for (int k = b0; k <= b1; k++) vols[k] += share;
  }

  double total = 0.0;
  for (double v : vols) total += v;
  if (total <= 0.0) return r;

  auto priceOf = [&](int k) { return lo + (k + 0.5) * step; };

  int poc = 0;
  for (int k = 1; k < n; k++) if (vols[k] > vols[poc]) poc = k;

  const double target = total * 0.7;
  int loK = poc, hiK = poc;
  double acc = vols[poc];
  while (acc < target && (loK > 0 || hiK < n - 1)) {
    const double below = loK > 0 ? vols[loK - 1] : -1.0;
    const double above = hiK < n - 1 ? vols[hiK + 1] : -1.0;
    if (above >= below) { hiK += 1; acc += vols[hiK]; }
    else { loK -= 1; acc += vols[loK]; }
  }

  r.valid = true;
  r.pocPrice = priceOf(poc);
  r.vahPrice = priceOf(hiK);
  r.valPrice = priceOf(loK);
  return r;
}

} // namespace vpo
