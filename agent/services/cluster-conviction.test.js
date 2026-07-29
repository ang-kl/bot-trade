import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_CLUSTER_CONVICTION,
  dirOfBias,
  matrixGroups,
  groupAgreement,
  clusterConviction,
} from './cluster-conviction.js'

const CLUSTER = {
  key: 'us_equity',
  label: 'US equity beta',
  members: { US30: 1, US500: 1, NAS100: 1, JPN225: 1 },
}

test('dirOfBias only commits on a clear long/short', () => {
  assert.equal(dirOfBias('long'), 1)
  assert.equal(dirOfBias('BUY'), 1)
  assert.equal(dirOfBias('short'), -1)
  assert.equal(dirOfBias('sell'), -1)
  // Anything unclear contributes NOTHING rather than defaulting to long.
  assert.equal(dirOfBias('skip'), 0)
  assert.equal(dirOfBias(null), 0)
  assert.equal(dirOfBias(''), 0)
})

test('a group that agrees names its best member and the ones it supersedes', () => {
  const a = groupAgreement(CLUSTER, [
    { symbol: 'US30', bias: 'long', conviction: 6 },
    { symbol: 'US500', bias: 'long', conviction: 9 },
    { symbol: 'NAS100', bias: 'long', conviction: 7 },
    { symbol: 'JPN225', bias: 'long', conviction: 5 },
  ])
  assert.equal(a.direction, 1)
  assert.equal(a.agree, 4)
  assert.equal(a.total, 4)
  assert.equal(a.ratio, 1)
  assert.equal(a.best.symbol, 'US500')
  assert.deepEqual(a.others.sort(), ['JPN225', 'NAS100', 'US30'])
})

test('a split group says nothing', () => {
  const a = groupAgreement(CLUSTER, [
    { symbol: 'US30', bias: 'long', conviction: 6 },
    { symbol: 'US500', bias: 'short', conviction: 9 },
    { symbol: 'NAS100', bias: 'long', conviction: 7 },
    { symbol: 'JPN225', bias: 'short', conviction: 5 },
  ])
  assert.equal(a, null)
})

test('too few members SIGNALLING means no read at all', () => {
  const a = groupAgreement(CLUSTER, [
    { symbol: 'US30', bias: 'long', conviction: 6 },
    { symbol: 'US500', bias: 'long', conviction: 9 },
    // NAS100 and JPN225 scanned to 'skip' — they are not votes.
    { symbol: 'NAS100', bias: 'skip', conviction: 0 },
  ])
  assert.equal(a, null)
})

test('a negative beta member agrees by pointing the OTHER way', () => {
  // In the curated map a short USDJPY and a long EURUSD are the same
  // "short USD" bet; the signed beta is what makes them count together.
  const usd = { key: 'usd', label: 'USD', members: { USDJPY: 1, USDCHF: 1, EURUSD: -1 } }
  const a = groupAgreement(usd, [
    { symbol: 'USDJPY', bias: 'long', conviction: 5 },
    { symbol: 'USDCHF', bias: 'long', conviction: 6 },
    { symbol: 'EURUSD', bias: 'short', conviction: 8 },
  ])
  assert.equal(a.agree, 3)
  assert.equal(a.total, 3)
  assert.equal(a.best.symbol, 'EURUSD')
})

test('matrixGroups chains correlated symbols and carries the sign', () => {
  // A~B +0.9, B~C −0.8 → C sits opposite A in the same group.
  const m = {
    symbols: ['A', 'B', 'C', 'Z'],
    matrix: [
      [1, 0.9, -0.1, 0.0],
      [0.9, 1, -0.8, 0.0],
      [-0.1, -0.8, 1, 0.0],
      [0.0, 0.0, 0.0, 1],
    ],
  }
  const [g, ...rest] = matrixGroups(m, 0.7)
  assert.equal(rest.length, 0, 'Z correlates with nothing and forms no group')
  assert.equal(g.members.A, 1)
  assert.equal(g.members.B, 1)
  assert.equal(g.members.C, -1)
  assert.equal(g.members.Z, undefined)
})

test('the live matrix covers symbols the curated map is blind to', () => {
  // USDCNH is in no curated cluster — it was one of the 2026-07-29 losses.
  const signals = [
    { symbol: 'USDCNH', bias: 'short', conviction: 7 },
    { symbol: 'USDSGD', bias: 'short', conviction: 5 },
    { symbol: 'USDTHB', bias: 'short', conviction: 4 },
  ]
  const liveMatrix = {
    symbols: ['USDCNH', 'USDSGD', 'USDTHB'],
    matrix: [[1, 0.85, 0.8], [0.85, 1, 0.82], [0.8, 0.82, 1]],
  }
  const r = clusterConviction(signals, { liveMatrix })
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0].best.symbol, 'USDCNH')
  assert.deepEqual(Object.keys(r.supersededBy).sort(), ['USDSGD', 'USDTHB'])
})

test('ships log-only: enforce is false by default', () => {
  assert.equal(DEFAULT_CLUSTER_CONVICTION.enforce, false)
  const r = clusterConviction([
    { symbol: 'US30', bias: 'long', conviction: 4 },
    { symbol: 'US500', bias: 'long', conviction: 6 },
    { symbol: 'NAS100', bias: 'long', conviction: 5 },
  ])
  assert.equal(r.enforce, false)
  // The READ still happens — the owner can see what it would have done.
  assert.equal(r.groups.length, 1)
  assert.equal(r.bonusBySymbol.US500, 2) // 6 + 2 = 8, well under the ceiling
})

test('the bonus respects the conviction ceiling', () => {
  const r = clusterConviction([
    { symbol: 'US30', bias: 'long', conviction: 9 },
    { symbol: 'US500', bias: 'long', conviction: 9.5 },
    { symbol: 'NAS100', bias: 'long', conviction: 9 },
  ])
  // 9.5 + 2 would be 11.5; the ceiling is 10, so the bonus is 0.5.
  assert.equal(r.bonusBySymbol.US500, 0.5)
})

test('a symbol that is best somewhere is never superseded', () => {
  // US500 leads the equity cluster; a live group also pairs it with US30.
  // The two must not cancel and suppress the very trade they both argue for.
  const signals = [
    { symbol: 'US30', bias: 'long', conviction: 6 },
    { symbol: 'US500', bias: 'long', conviction: 9 },
    { symbol: 'NAS100', bias: 'long', conviction: 7 },
  ]
  const liveMatrix = {
    symbols: ['US500', 'US30', 'NAS100'],
    matrix: [[1, 0.95, 0.93], [0.95, 1, 0.9], [0.93, 0.9, 1]],
  }
  const r = clusterConviction(signals, { liveMatrix })
  assert.equal(r.supersededBy.US500, undefined)
  assert.ok(r.bonusBySymbol.US500 > 0)
})

test('off means off — no groups, no bonuses', () => {
  const r = clusterConviction([
    { symbol: 'US30', bias: 'long', conviction: 6 },
    { symbol: 'US500', bias: 'long', conviction: 9 },
    { symbol: 'NAS100', bias: 'long', conviction: 7 },
  ], { config: { ...DEFAULT_CLUSTER_CONVICTION, on: false } })
  assert.deepEqual(r.groups, [])
  assert.deepEqual(r.bonusBySymbol, {})
  assert.deepEqual(r.supersededBy, {})
})

test('the 2026-07-29 shape: four correlated longs collapse to one', () => {
  // Not the real symbols of that day (the curated map was blind to most of
  // them) — the point is the SHAPE: N agreeing members, one survivor.
  const signals = [
    { symbol: 'US30', bias: 'long', conviction: 8 },
    { symbol: 'US500', bias: 'long', conviction: 8 },
    { symbol: 'NAS100', bias: 'long', conviction: 9 },
    { symbol: 'JPN225', bias: 'long', conviction: 7 },
  ]
  const r = clusterConviction(signals, { config: { ...DEFAULT_CLUSTER_CONVICTION, enforce: true } })
  assert.equal(r.enforce, true)
  assert.equal(Object.keys(r.bonusBySymbol).length, 1)
  assert.equal(r.bonusBySymbol.NAS100, 1) // 9 + 2 → capped at 10
  assert.equal(Object.keys(r.supersededBy).length, 3)
})
