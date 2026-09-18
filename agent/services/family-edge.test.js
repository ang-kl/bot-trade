import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { familyEdgeReport, TAIL_R } from './family-edge.js'

const T0 = Date.parse('2026-09-10T00:00:00Z')

function insertClose(db, { strategy, label = null, side = 'BUY', entry = 100, exit, sl = 99, pnl, at, acct = '47790949', realisedRr = null, brokerSl = null }) {
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, broker_sl_initial, net_pnl, status, closed_at, closed_at_ms, strategy, label_strategy, account_id, realised_rr)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, ?)`)
    .run('EURUSD', side, entry, exit, sl, brokerSl, pnl, new Date(at).toISOString().replace('T', ' ').slice(0, 19), at, strategy, label, acct, realisedRr)
}

test('familyEdgeReport: every family present, empty families report zero closes and null figures', () => {
  const db = initDB(':memory:')
  const r = familyEdgeReport(db, { now: T0 })
  assert.deepEqual(Object.keys(r.families).sort(), ['breakout', 'mean_reversion', 'momentum', 'trend'])
  for (const f of Object.values(r.families)) {
    assert.equal(f.closes, 0)
    assert.equal(f.profitFactor, null)
    assert.equal(f.tailSharePct, null)
    assert.equal(f.maxDrawdownR, null)
  }
  assert.equal(r.unattributed, 0)
  assert.equal(TAIL_R, 2)
})

test('familyEdgeReport: PF from money, tail share and drawdown from R, in close order', () => {
  const db = initDB(':memory:')
  // trend family (vwap_trend): +3R, -1R, -1R, +3R  → PF (600)/(200)=3, tail 2/4, maxDD 2R
  let t = T0 - 5 * 86400_000
  insertClose(db, { strategy: 'vwap_trend', exit: 103, pnl: 300, at: (t += 3600_000) })
  insertClose(db, { strategy: 'vwap_trend', exit: 99, pnl: -100, at: (t += 3600_000) })
  insertClose(db, { strategy: 'vwap_trend', exit: 99, pnl: -100, at: (t += 3600_000) })
  insertClose(db, { strategy: 'vwap_trend', exit: 103, pnl: 300, at: (t += 3600_000) })
  // a +1R winner is a winner, not a tail close
  insertClose(db, { strategy: 'vwap_trend', exit: 101, pnl: 100, at: (t += 3600_000) })
  const r = familyEdgeReport(db, { now: T0 })
  const f = r.families.trend
  assert.equal(f.closes, 5)
  assert.equal(f.decidable, 5)
  assert.equal(f.profitFactor, 3.5)
  assert.equal(f.tailCloses, 2)
  assert.equal(f.tailSharePct, 40)
  assert.equal(f.maxDrawdownR, 2)
  assert.equal(f.maxDrawdownUsd, 200)
  assert.equal(f.avgR, 1)
  assert.equal(r.families.breakout.closes, 0)
})

test('familyEdgeReport: the stamped realised_rr wins, an unreadable R is counted undecidable, and the label outranks the strategy column', () => {
  const db = initDB(':memory:')
  let t = T0 - 3 * 86400_000
  // stamped 2.5R even though the prices say 1R → tail counts it (the stamp is the broker's first stop)
  insertClose(db, { strategy: 'donchian_breakout', exit: 101, pnl: 50, at: (t += 3600_000), realisedRr: 2.5 })
  // no stop on record → undecidable, but the money still counts
  insertClose(db, { strategy: 'donchian_breakout', exit: 101, pnl: 50, at: (t += 3600_000), sl: null })
  // strategy column says mean reversion but the label says breakout → breakout
  insertClose(db, { strategy: 'rsi2_reversion', label: 'va_breakout', exit: 99, pnl: -20, at: (t += 3600_000) })
  // an 'other' label falls back to the strategy column
  insertClose(db, { strategy: 'rsi2_reversion', label: 'other', exit: 99, pnl: -20, at: (t += 3600_000) })
  // no attribution at all → unattributed
  insertClose(db, { strategy: null, exit: 99, pnl: -20, at: (t += 3600_000) })
  const r = familyEdgeReport(db, { now: T0 })
  const b = r.families.breakout
  assert.equal(b.closes, 3)
  assert.equal(b.decidable, 2)
  assert.equal(b.undecidable, 1)
  assert.equal(b.tailCloses, 1)
  assert.equal(b.tailSharePct, 50)
  assert.equal(b.netUsd, 80)
  assert.equal(b.profitFactor, 5)
  assert.equal(r.families.mean_reversion.closes, 1)
  assert.equal(r.unattributed, 1)
})

test('familyEdgeReport: window, since and account scope', () => {
  const db = initDB(':memory:')
  insertClose(db, { strategy: 'tsmom_long', exit: 103, pnl: 300, at: T0 - 100 * 86400_000, acct: '46130058' })
  insertClose(db, { strategy: 'tsmom_long', exit: 103, pnl: 300, at: T0 - 10 * 86400_000, acct: '46130058' })
  insertClose(db, { strategy: 'tsmom_long', exit: 99, pnl: -100, at: T0 - 9 * 86400_000, acct: '47790949' })
  assert.equal(familyEdgeReport(db, { now: T0, days: 90 }).families.momentum.closes, 2)
  assert.equal(familyEdgeReport(db, { now: T0, days: 0 }).families.momentum.closes, 3)
  assert.equal(familyEdgeReport(db, { now: T0, since: new Date(T0 - 9.5 * 86400_000).toISOString() }).families.momentum.closes, 1)
  const one = familyEdgeReport(db, { now: T0, days: 90, accountId: '46130058' })
  assert.equal(one.families.momentum.closes, 1)
  assert.equal(one.accountId, '46130058')
})

test('familyEdgeReport (checker F1): close order follows the timestamp each row carries, not the ms column alone', () => {
  const db = initDB(':memory:')
  const t0 = T0 - 3 * 86400_000
  const raw = db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, net_pnl, status, closed_at, closed_at_ms, strategy, account_id)
                          VALUES ('EURUSD', 'BUY', 100, ?, 99, ?, 'closed', ?, ?, 'vwap_trend', '47790949')`)
  // chronological: +3R, -1R, -1R (ms null), -1R, -1R (ms null), -1R (ms null) → curve +3,+2,+1,0,-1,-2 → maxDD 5R
  const seq = [[103, 300, false], [99, -100, false], [99, -100, true], [99, -100, false], [99, -100, true], [99, -100, true]]
  seq.forEach(([exit, pnl, nullMs], i) => {
    const at = t0 + i * 3600_000
    raw.run(exit, pnl, new Date(at).toISOString().replace('T', ' ').slice(0, 19), nullMs ? null : at)
  })
  const f = familyEdgeReport(db, { now: T0 }).families.trend
  assert.equal(f.closes, 6)
  assert.equal(f.maxDrawdownR, 5)
})

test('familyEdgeReport (checker F2): a lossless family reports PF null with lossless:true, which survives JSON', () => {
  const db = initDB(':memory:')
  let t = T0 - 2 * 86400_000
  for (let i = 0; i < 3; i++) insertClose(db, { strategy: 'vwap_trend', exit: 103, pnl: 300, at: (t += 3600_000) })
  const f = JSON.parse(JSON.stringify(familyEdgeReport(db, { now: T0 }))).families.trend
  assert.equal(f.profitFactor, null)
  assert.equal(f.lossless, true)
  assert.equal(familyEdgeReport(db, { now: T0 }).families.breakout.lossless, false)
})

test('familyEdgeReport (checker F3): the window reads the ms stamp when set and the text stamp when not', () => {
  const db = initDB(':memory:')
  const raw = db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, net_pnl, status, closed_at, closed_at_ms, strategy, account_id)
                          VALUES ('EURUSD', 'BUY', 100, 103, 99, 300, 'closed', ?, ?, 'vwap_trend', '47790949')`)
  const inWin = T0 - 10 * 86400_000, outWin = T0 - 100 * 86400_000
  raw.run(null, inWin)                                                            // ms only, inside
  raw.run(new Date(inWin).toISOString().replace('T', ' ').slice(0, 19), null)  // text only, inside
  raw.run(new Date(outWin).toISOString(), null)                                  // ISO text, outside
  raw.run(null, outWin)                                                           // ms only, outside
  assert.equal(familyEdgeReport(db, { now: T0, days: 90 }).families.trend.closes, 2)
  assert.equal(familyEdgeReport(db, { now: T0, days: 0 }).families.trend.closes, 4)
})
