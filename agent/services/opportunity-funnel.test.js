// node --test agent/services/opportunity-funnel.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDB } from '../db.js'
import { opportunityFunnel, silentOpportunities, funnelLine, sinceIso } from './opportunity-funnel.js'
import { opportunityKey } from './opportunity-identity.js'

const NOW = Date.parse('2026-08-05T06:00:00.000Z')
const fresh = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'funnel-')), 'a.db'))

const P = (over = {}) => ({ symbol: 'TXT.US', side: 'SELL', strategy: 'vwap_trend', ...over })

function evaluation(db, { key, approved = 0, at = NOW, account = '46130058', symbol = 'TXT.US', side = 'SELL' }) {
  const info = db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, account_id, created_at, opportunity_key)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(symbol, side, approved ? 1 : 0, account, new Date(at).toISOString(), key)
  return info.lastInsertRowid
}

test('sinceIso accepts a fractional day so a 12-hour window is expressible', () => {
  assert.equal(sinceIso(0.5, NOW), new Date(NOW - 12 * 3600e3).toISOString())
  // A junk value falls back to one day rather than producing an empty window.
  assert.equal(sinceIso('nonsense', NOW), new Date(NOW - 24 * 3600e3).toISOString())
})

test('THE CORRECTION: 8 evaluations of ONE setup count as ONE opportunity', () => {
  const db = fresh()
  const key = opportunityKey(P(), '46130058', NOW - 3600e3)
  for (let i = 0; i < 8; i++) evaluation(db, { key, approved: i >= 6, at: NOW - 3600e3 + i * 60e3 })

  const f = opportunityFunnel(db, { days: 1, now: NOW })
  assert.equal(f.funnel.opportunities, 1)
  assert.equal(f.funnel.approved, 1, 'approved TWICE is still one approved opportunity')
  assert.equal(f.evaluations, 8)
  assert.equal(f.reevaluationRatio, 8)
})

test('a landed opportunity is ordered AND filled; the approvals do not multiply it', () => {
  const db = fresh()
  const key = opportunityKey(P(), '46130058', NOW - 3600e3)
  const ids = []
  for (let i = 0; i < 5; i++) ids.push(evaluation(db, { key, approved: 1, at: NOW - 3600e3 + i * 60e3 }))
  // One of the five approvals produced the position — which is exactly the
  // shape that used to read as "four approvals went nowhere".
  db.prepare(`INSERT INTO trades (symbol, side, status, risk_event_id, account_id) VALUES ('TXT.US','SELL','open',?, '46130058')`).run(ids[2])

  const f = opportunityFunnel(db, { days: 1, now: NOW })
  assert.deepEqual(f.funnel, { opportunities: 1, approved: 1, ordered: 1, filled: 1 })
  assert.equal(f.rates.filledPctOfApproved, 100)
  assert.equal(silentOpportunities(db, { days: 1, now: NOW }).length, 0,
    'four of the five approvals produced nothing, but the OPPORTUNITY landed')
})

test('an approval that produced nothing is NAMED, not subtracted', () => {
  const db = fresh()
  const landedKey = opportunityKey(P(), '46130058', NOW - 3600e3)
  const silentKey = opportunityKey(P({ symbol: 'GER40' }), '46130058', NOW - 1800e3)
  const landedId = evaluation(db, { key: landedKey, approved: 1 })
  evaluation(db, { key: silentKey, approved: 1, symbol: 'GER40' })
  db.prepare(`INSERT INTO trades (symbol, side, status, risk_event_id, account_id) VALUES ('TXT.US','SELL','open',?, '46130058')`).run(landedId)

  const silent = silentOpportunities(db, { days: 1, now: NOW })
  assert.equal(silent.length, 1)
  assert.equal(silent[0].symbol, 'GER40')
  assert.equal(silent[0].key, silentKey)
})

test('a pending order counts as ORDERED but not FILLED', () => {
  const db = fresh()
  const key = opportunityKey(P(), '46130058', NOW - 600e3)
  const id = evaluation(db, { key, approved: 1 })
  // pending_orders names the direction `dir`, not `side` — the resting-order
  // table predates the trades schema and was never renamed.
  db.prepare(`INSERT INTO pending_orders (symbol, dir, status, risk_event_id, account_id) VALUES ('TXT.US','SELL','working',?, '46130058')`).run(id)

  const f = opportunityFunnel(db, { days: 1, now: NOW })
  assert.equal(f.funnel.ordered, 1)
  assert.equal(f.funnel.filled, 0)
  assert.equal(f.rates.orderedPctOfApproved, 100)
  assert.equal(f.rates.filledPctOfApproved, 0)
})

test('UNKEYED rows are reported separately and never move a rate', () => {
  const db = fresh()
  const key = opportunityKey(P(), '46130058', NOW - 600e3)
  evaluation(db, { key, approved: 1 })
  // Pre-migration rows: no opportunity_key.
  for (let i = 0; i < 40; i++) {
    db.prepare(`INSERT INTO risk_events (symbol, side, approved, account_id, created_at) VALUES ('TXT.US','SELL',1,'46130058',?)`)
      .run(new Date(NOW - 500e3 + i).toISOString())
  }
  const f = opportunityFunnel(db, { days: 1, now: NOW })
  assert.equal(f.unkeyed, 40)
  assert.equal(f.funnel.opportunities, 1, 'an unknown must not inflate the denominator')
  assert.equal(f.funnel.approved, 1, 'nor the numerator')
  assert.match(f.unkeyedNote, /predate opportunity_key/)
})

test('the window excludes older evaluations', () => {
  const db = fresh()
  evaluation(db, { key: opportunityKey(P(), '46130058', NOW - 40 * 3600e3), approved: 1, at: NOW - 40 * 3600e3 })
  evaluation(db, { key: opportunityKey(P({ symbol: 'GER40' }), '46130058', NOW - 3600e3), approved: 1, at: NOW - 3600e3, symbol: 'GER40' })
  const f = opportunityFunnel(db, { days: 1, now: NOW })
  assert.equal(f.funnel.opportunities, 1)
})

test('account scoping keeps two accounts apart', () => {
  const db = fresh()
  evaluation(db, { key: opportunityKey(P(), '46130058', NOW - 600e3), approved: 1, account: '46130058' })
  evaluation(db, { key: opportunityKey(P(), '47790949', NOW - 600e3), approved: 1, account: '47790949' })
  assert.equal(opportunityFunnel(db, { days: 1, now: NOW }).funnel.opportunities, 2)
  assert.equal(opportunityFunnel(db, { days: 1, now: NOW, account: '46130058' }).funnel.opportunities, 1)
  assert.equal(opportunityFunnel(db, { days: 1, now: NOW, account: 'all' }).funnel.opportunities, 2)
})

test('an empty window returns nulls, not NaN or a fake 0%', () => {
  const db = fresh()
  const f = opportunityFunnel(db, { days: 1, now: NOW })
  assert.deepEqual(f.funnel, { opportunities: 0, approved: 0, ordered: 0, filled: 0 })
  assert.equal(f.reevaluationRatio, null)
  assert.equal(f.rates.approvedPct, null)
  assert.equal(f.rates.filledPctOfApproved, null)
  assert.equal(f.unkeyedNote, null)
})

test('funnelLine reads as one sentence and survives an empty payload', () => {
  const db = fresh()
  const key = opportunityKey(P(), '46130058', NOW - 600e3)
  const id = evaluation(db, { key, approved: 1 })
  evaluation(db, { key, approved: 1, at: NOW - 500e3 })
  db.prepare(`INSERT INTO trades (symbol, side, status, risk_event_id, account_id) VALUES ('TXT.US','SELL','open',?, '46130058')`).run(id)
  assert.match(funnelLine(opportunityFunnel(db, { days: 1, now: NOW })),
    /opportunities 1 → approved 1 → ordered 1 → filled 1 \(2x re-evaluated\)/)
  assert.equal(funnelLine(null), null)
  assert.equal(funnelLine({}), null)
})
