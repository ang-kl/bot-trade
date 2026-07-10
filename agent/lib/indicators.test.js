// node:test coverage for agent/lib/indicators.js (pure functions, no I/O).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  smaSeries,
  emaSeries,
  vwapSeries,
  avwapSeries,
  findFvgZones,
  volumeProfile,
} from './indicators.js';

const MIN = 60_000;
// Synthetic bar helper: flat-ish OHLC around close.
function bar(i, c, v = 100, h = c + 1, l = c - 1) {
  return { t: i * MIN, o: c, h, l, c, v };
}
const closes = (arr) => arr.map((c, i) => bar(i, c));

test('smaSeries: warmup nulls + alignment', () => {
  const bars = closes([1, 2, 3, 4, 5]);
  const s = smaSeries(bars, 3);
  assert.equal(s.length, bars.length);
  assert.deepEqual(s.slice(0, 2), [null, null]);
  assert.deepEqual(s.slice(2), [2, 3, 4]);
});

test('emaSeries: SMA seed at period-1, recursive after, same warmup nulls', () => {
  const bars = closes([1, 2, 3, 4, 5]);
  const e = emaSeries(bars, 3);
  assert.equal(e.length, bars.length);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2); // seed = SMA(1,2,3)
  const k = 2 / 4;
  assert.ok(Math.abs(e[3] - (4 * k + 2 * (1 - k))) < 1e-12);
  assert.ok(Math.abs(e[4] - (5 * k + e[3] * (1 - k))) < 1e-12);
});

test('emaSeries/smaSeries: series shorter than period → all null', () => {
  const bars = closes([1, 2]);
  assert.deepEqual(smaSeries(bars, 5), [null, null]);
  assert.deepEqual(emaSeries(bars, 5), [null, null]);
});

test('vwapSeries: cumulative typical-price VWAP from anchor, nulls before', () => {
  const bars = [bar(0, 10, 100), bar(1, 20, 300), bar(2, 30, 100)];
  const w = vwapSeries(bars, 1);
  assert.equal(w[0], null);
  assert.equal(w[1], 20); // tp=20, only bar
  // (20*300 + 30*100) / 400 = 22.5
  assert.ok(Math.abs(w[2] - 22.5) < 1e-12);
});

test('avwapSeries: anchored by timestamp — first bar with t >= anchorT', () => {
  const bars = [bar(0, 10, 100), bar(1, 20, 300), bar(2, 30, 100)];
  // anchorT between bar0 and bar1 → anchor at index 1: identical to vwapSeries(bars,1)
  assert.deepEqual(avwapSeries(bars, 0.5 * MIN), vwapSeries(bars, 1));
  // anchor exactly on a bar t
  assert.deepEqual(avwapSeries(bars, 2 * MIN), vwapSeries(bars, 2));
  // anchor after all data → all null
  assert.deepEqual(avwapSeries(bars, 99 * MIN), [null, null, null]);
});

test('findFvgZones: detects bull + bear gaps, fill marking', () => {
  // Bull gap: bar0 h=11, bar2 l=15 → zone 11..15 from idx 2.
  const bull = [
    bar(0, 10, 100, 11, 9),
    bar(1, 13, 100, 14, 12),
    bar(2, 16, 100, 17, 15),
    bar(3, 14, 100, 14.5, 13.8), // does NOT fill (l=13.8 > bottom 11), no new gaps
    bar(4, 12, 100, 16, 10), // fills: l=10 <= 11 (h=16 avoids a bear gap vs bar2)
  ];
  const bz = findFvgZones(bull);
  assert.equal(bz.length, 1);
  assert.deepEqual(bz[0], { dir: 'bull', top: 15, bottom: 11, fromIdx: 2, filledIdx: 4 });

  // Bear gap: bar0 l=19, bar2 h=15 → zone 15..19, never revisited → filledIdx null.
  const bear = [
    bar(0, 20, 100, 21, 19),
    bar(1, 17, 100, 18, 16),
    bar(2, 14, 100, 15, 13),
    bar(3, 14, 100, 16.5, 12), // h=16.5 avoids a second bear gap vs bar1 (l=16), stays below top 19
  ];
  const sz = findFvgZones(bear);
  assert.equal(sz.length, 1);
  assert.deepEqual(sz[0], { dir: 'bear', top: 19, bottom: 15, fromIdx: 2, filledIdx: null });
});

// Volume-profile fixture: 48 one-minute bars; prices 100..110; volume heavily
// concentrated near price 105 in the last 24 bars.
function vpBars() {
  const bars = [];
  for (let i = 0; i < 48; i++) {
    const heavy = i >= 24 && i % 2 === 0;
    const c = heavy ? 105 : 100 + (i % 11);
    bars.push({
      t: i * MIN,
      o: c,
      h: c + 0.2,
      l: c - 0.2,
      c,
      v: heavy ? 5000 : 10,
    });
  }
  return bars;
}

function checkProfile(p, heavyPrice) {
  assert.ok(p.rows.length > 0);
  const pctSum = p.rows.reduce((s, r) => s + r.pct, 0);
  assert.ok(Math.abs(pctSum - 100) < 1e-9, `pct sums to ${pctSum}`);
  assert.ok(Math.abs(p.pocPrice - heavyPrice) < 0.5, `POC ${p.pocPrice} near ${heavyPrice}`);
  assert.ok(p.vahPrice >= p.pocPrice && p.pocPrice >= p.valPrice, 'VAH>=POC>=VAL');
  // rows ascending by price
  for (let i = 1; i < p.rows.length; i++) assert.ok(p.rows[i].price > p.rows[i - 1].price);
}

test('volumeProfile: composite — POC on heavy price, VA ordering, pct≈100', () => {
  checkProfile(volumeProfile(vpBars(), { type: 'composite' }), 105);
});

test('volumeProfile: visible + fixed are the same math over fromIdx..toIdx', () => {
  const bars = vpBars();
  const vis = volumeProfile(bars, { type: 'visible', fromIdx: 24, toIdx: 47 });
  const fix = volumeProfile(bars, { type: 'fixed', fromIdx: 24, toIdx: 47 });
  checkProfile(vis, 105);
  assert.deepEqual(fix, vis);
});

test('volumeProfile: session — only last sessionMs window used', () => {
  const bars = vpBars();
  // 24-minute session → only bars 25..47 (t > lastT - 24m); heavy 105 dominates.
  const p = volumeProfile(bars, { type: 'session', sessionMs: 24 * MIN });
  checkProfile(p, 105);
  // Window excludes early bars: profile range must not span below ~99.8
  // for the reduced set (heavy alternates with 100..110 rotation ≥ 101 here).
  const full = volumeProfile(bars, { type: 'composite' });
  assert.notDeepEqual(p.rows, full.rows);
});

test('volumeProfile: empty + flat-price edge cases', () => {
  const empty = volumeProfile([], { type: 'composite' });
  assert.deepEqual(empty, { rows: [], pocPrice: null, vahPrice: null, valPrice: null });
  const flat = [bar(0, 50, 100, 50, 50), bar(1, 50, 200, 50, 50)];
  const p = volumeProfile(flat, { type: 'composite', buckets: 8 });
  assert.equal(p.pocPrice, p.rows[0].price);
  assert.ok(Math.abs(p.rows.reduce((s, r) => s + r.pct, 0) - 100) < 1e-9);
});
