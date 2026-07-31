// PHASE 6 GATE (cockpit live-wiring prompt): "positive, negative, stale,
// missing and two-account tests pass." Coefficients come from a seeded
// matrix payload — the same agent_state key the quant phase writes — and
// every derived number is checked by hand arithmetic.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert'
import { initDB, setState } from '../db.js'
import { buildCorrelation } from './cockpit-correlation.js'
import { cockpitSnapshot } from './cockpit-snapshot.js'

const NOW = Date.parse('2026-07-31T08:00:00Z')
const FRESH = new Date(NOW - 10 * 60_000).toISOString()   // 10 min old — inside the 90-min default
const OLD = new Date(NOW - 100 * 60_000).toISOString()    // 100 min old — stale

function seedMatrix(db, { builtAt = FRESH } = {}) {
  setState(db, 'correlation_matrix_data', JSON.stringify({
    builtAt,
    timeframe: '1h',
    lookback: 60,
    symbols: ['EURUSD', 'GBPUSD', 'USDJPY'],
    m: {
      EURUSD: { EURUSD: 1, GBPUSD: 0.85, USDJPY: -0.8 },
      GBPUSD: { EURUSD: 0.85, GBPUSD: 1, USDJPY: -0.6 },
      USDJPY: { EURUSD: -0.8, GBPUSD: -0.6, USDJPY: 1 },
    },
  }))
}

function freshDb() {
  const db = initDB(':memory:')
  const mp = db.prepare(`INSERT INTO monitored_positions
    (symbol, side, entry_price, account_id, status) VALUES (?, ?, ?, ?, 'active')`)
  const idMe = mp.run('EURUSD', 'long', 1.1, 'ACC_A').lastInsertRowid       // the cockpit position
  const idGbp = mp.run('GBPUSD', 'long', 1.27, 'ACC_A').lastInsertRowid
  const idJpy = mp.run('USDJPY', 'long', 155, 'ACC_A').lastInsertRowid
  const idB = mp.run('XAUUSD', 'short', 2400, 'ACC_B').lastInsertRowid     // ANOTHER account's book
  return { db, idMe, idGbp, idJpy, idB }
}

let ctx
beforeEach(() => { ctx = freshDb() })
const rowMe = () => ctx.db.prepare('SELECT id, symbol, side FROM monitored_positions WHERE id = ?').get(ctx.idMe)

test('GATE positive: a same-direction correlated position reads as STACKED, by the veto\'s own arithmetic', () => {
  seedMatrix(ctx.db)
  const out = buildCorrelation(ctx.db, rowMe(), 'ACC_A', NOW)
  assert.equal(out.status, 'live')
  assert.equal(out.timeframe, '1h')
  assert.equal(out.lookback, 60)
  assert.equal(out.builtAt, FRESH)
  const gbp = out.related.find(r => r.symbol === 'GBPUSD')
  // eff = 0.85 × (+1 long me) × (+1 long held) = 0.85 ≥ threshold 0.7
  assert.equal(gbp.coefficient, 0.85)
  assert.equal(gbp.effective, 0.85)
  assert.equal(gbp.relation, 'stacked')
  assert.equal(out.summary.stacked, 1)
})

test('GATE negative: a negatively-correlated same-direction position reads as HEDGED — and flipping its side flips the read', () => {
  seedMatrix(ctx.db)
  let out = buildCorrelation(ctx.db, rowMe(), 'ACC_A', NOW)
  const jpy = out.related.find(r => r.symbol === 'USDJPY')
  // eff = −0.8 × (+1) × (+1) = −0.8 ≤ −0.7 → the position hedges this one
  assert.equal(jpy.coefficient, -0.8)
  assert.equal(jpy.effective, -0.8)
  assert.equal(jpy.relation, 'hedged')
  // SHORT USDJPY moves WITH long EURUSD: eff = −0.8 × (+1) × (−1) = +0.8 → stacked
  ctx.db.prepare("UPDATE monitored_positions SET side = 'short' WHERE id = ?").run(ctx.idJpy)
  out = buildCorrelation(ctx.db, rowMe(), 'ACC_A', NOW)
  assert.equal(out.related.find(r => r.symbol === 'USDJPY').relation, 'stacked')
})

test('GATE stale: an old matrix says STALE and keeps its real coefficients — old data, not fabricated data', () => {
  seedMatrix(ctx.db, { builtAt: OLD })
  const out = buildCorrelation(ctx.db, rowMe(), 'ACC_A', NOW)
  assert.equal(out.status, 'stale')
  assert.match(out.detail, /older than the 90-minute/)
  assert.equal(out.ageMs, 100 * 60_000)
  // The measurements still show — they are real, just old.
  assert.equal(out.related.find(r => r.symbol === 'GBPUSD').coefficient, 0.85)
})

test('GATE missing: no matrix means UNKNOWN coefficients — never zero, never agreement', () => {
  const out = buildCorrelation(ctx.db, rowMe(), 'ACC_A', NOW)
  assert.equal(out.status, 'unknown')
  assert.match(out.detail, /unknown, not zero/)
  for (const r of out.related) {
    assert.equal(r.coefficient, null, r.symbol)
    assert.equal(r.relation, 'unknown', r.symbol)
  }
  // Curated clusters + currency legs are configuration + positions, not
  // measurements — still honest without a matrix.
  assert.ok(out.clusters.length >= 1)
  assert.ok(out.portfolioExposure.length >= 1)
})

test('a matrix that never measured THIS symbol is LIMITED, not silently independent', () => {
  setState(ctx.db, 'correlation_matrix_data', JSON.stringify({
    builtAt: FRESH, timeframe: '1h', lookback: 60,
    symbols: ['GBPUSD', 'USDJPY'],
    m: { GBPUSD: { USDJPY: -0.6 }, USDJPY: { GBPUSD: -0.6 } },
  }))
  const out = buildCorrelation(ctx.db, rowMe(), 'ACC_A', NOW)
  assert.equal(out.status, 'limited')
  assert.match(out.detail, /no measurements for EURUSD/)
  assert.equal(out.related.find(r => r.symbol === 'GBPUSD').coefficient, null)
})

test('GATE two-account: another account\'s book never paints this cockpit', () => {
  seedMatrix(ctx.db)
  const out = buildCorrelation(ctx.db, rowMe(), 'ACC_A', NOW)
  assert.ok(!out.related.some(r => r.symbol === 'XAUUSD'), 'ACC_B position must not appear')
  assert.ok(!JSON.stringify(out).includes('XAUUSD'))
  assert.equal(out.summary.held, 2)
})

test('curated clusters and currency legs use the gate\'s own maths and caps', () => {
  seedMatrix(ctx.db)
  const out = buildCorrelation(ctx.db, rowMe(), 'ACC_A', NOW)
  // usd_strength: held GBPUSD long (beta −1 → −1) + proposal EURUSD long
  // (beta −1 → −1) + held USDJPY long (beta +1 → +1) → net −1.
  const usd = out.clusters.find(c => c.key === 'usd_strength')
  assert.equal(usd.net, -1)
  assert.equal(usd.cap, 2)  // DEFAULT_RISK_CONFIG.maxClusterExposure
  // Currency legs: EURUSD long {EUR+1,USD−1} + GBPUSD long {GBP+1,USD−1}
  // + USDJPY long {USD+1,JPY−1} → USD −1, EUR +1, GBP +1, JPY −1.
  const byCcy = Object.fromEntries(out.portfolioExposure.map(e => [e.currency, e.net]))
  assert.deepEqual(byCcy, { EUR: 1, GBP: 1, JPY: -1, USD: -1 })
  assert.equal(out.portfolioExposure.find(e => e.currency === 'USD').cap, 2)
})

test('a second position on the SAME symbol is the stack itself, no matrix needed', () => {
  ctx.db.prepare("INSERT INTO monitored_positions (symbol, side, entry_price, account_id, status) VALUES ('EURUSD', 'long', 1.09, 'ACC_A', 'active')").run()
  const out = buildCorrelation(ctx.db, rowMe(), 'ACC_A', NOW)
  const dup = out.related.find(r => r.symbol === 'EURUSD')
  assert.equal(dup.relation, 'stacked')
  assert.equal(dup.sameSymbol, true)
  assert.equal(dup.coefficient, 1)
})

test('snapshot integration: the endpoint carries the block, scoped by the requested account', () => {
  seedMatrix(ctx.db)
  const t = ctx.db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, opened_at, ctrader_position_id, status)
    VALUES ('EURUSD', 'long', 1.1, 0.5, datetime('now'), '900009', 'open')`).run().lastInsertRowid
  ctx.db.prepare('UPDATE monitored_positions SET trade_id = ? WHERE id = ?').run(t, ctx.idMe)
  const out = cockpitSnapshot(ctx.db, ctx.idMe, { accountId: 'ACC_A', all: false, explicit: true }, NOW)
  assert.equal(out.status, 200)
  assert.equal(out.body.correlation.status, 'live')
  assert.ok(!JSON.stringify(out.body.correlation).includes('XAUUSD'))
})
