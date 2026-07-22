// src/lib/pivot-points.js
// MIRROR TWIN: agent/lib/pivot-points.js — the two files must stay
// byte-identical in logic (same convention as src/lib/indicators.js).
//
// Classic (floor trader) pivot points, computed from a single prior period's
// high/low/close. Pure function — no I/O.

/**
 * @returns {{p,r1,r2,r3,s1,s2,s3}}
 */
export function classicPivots({ high, low, close }) {
  const p = (high + low + close) / 3;
  const r1 = 2 * p - low;
  const s1 = 2 * p - high;
  const r2 = p + (high - low);
  const s2 = p - (high - low);
  const r3 = high + 2 * (p - low);
  const s3 = low - 2 * (high - p);
  return { p, r1, r2, r3, s1, s2, s3 };
}
