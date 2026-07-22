// node --test agent/services/label-backfill.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { backfillLabelStrategy } from './label-backfill.js'

function insertTrade(db, { thesis, source = 'autopilot', labelStrategy = null } = {}) {
  const { lastInsertRowid: id } = db.prepare(`
    INSERT INTO trades (symbol, side, entry_price, opened_at, status, source, thesis, label_strategy)
    VALUES ('EURUSD', 'BUY', 1.1, datetime('now'), 'closed', ?, ?, ?)
  `).run(source, thesis, labelStrategy)
  return id
}

test('recovers vp_value from its thesis fingerprint', () => {
  const db = initDB(':memory:')
  const id = insertTrade(db, { thesis: 'Price tested the value-area low (1.0950) on the 4h volume profile and closed back inside — fading the edge for a rotation up to the POC (1.1010), stop below the VAL.' })
  const res = backfillLabelStrategy(db)
  assert.equal(res.updated, 1)
  assert.equal(res.byStrategy.vp_value, 1)
  assert.equal(db.prepare('SELECT label_strategy FROM trades WHERE id = ?').get(id).label_strategy, 'vp_value')
})

test('recovers rsi2_reversion, vwap_trend, fib_confluence from their own fingerprints', () => {
  const db = initDB(':memory:')
  insertTrade(db, { thesis: 'RSI(2) washed out to 8.40 while price holds above its 200-bar trend — buying a high-probability bounce, 1.5R target, 1.2x ATR stop as tail insurance.' })
  insertTrade(db, { thesis: 'Uptrend on 1h above a rising VWAP. Price pulled back to the VWAP line and closed above it — buying the pullback, stop below the dip, targets 2R/3R.' })
  insertTrade(db, { thesis: '3-level Fibonacci confluence support on 4h at 1.0950 (ratios 61.8/78.6 across multiple swing-pair grids). Buying the bounce off the stacked zone, stop beyond it, targets 2R/3R.' })
  const res = backfillLabelStrategy(db)
  assert.equal(res.updated, 3)
  assert.deepEqual(res.byStrategy, { rsi2_reversion: 1, vwap_trend: 1, fib_confluence: 1 })
})

test('never overwrites an existing label_strategy', () => {
  const db = initDB(':memory:')
  const id = insertTrade(db, {
    thesis: 'RSI(2) spiked to 91.20 while price sits below its 200-bar trend — selling the blow-off back toward the mean.',
    labelStrategy: 'trend',
  })
  const res = backfillLabelStrategy(db)
  assert.equal(res.updated, 0)
  assert.equal(db.prepare('SELECT label_strategy FROM trades WHERE id = ?').get(id).label_strategy, 'trend')
})

test('leaves genuinely unrecoverable trades (no fingerprint match) alone — honest, not invented', () => {
  const db = initDB(':memory:')
  const id = insertTrade(db, { thesis: 'A vague setup with no strategy-specific wording at all.' })
  const res = backfillLabelStrategy(db)
  assert.equal(res.updated, 0)
  assert.equal(res.scanned, 1)
  assert.equal(db.prepare('SELECT label_strategy FROM trades WHERE id = ?').get(id).label_strategy, null)
})

test('skips manual/external trades — the fingerprint only proves an autopilot module ran it', () => {
  const db = initDB(':memory:')
  insertTrade(db, { thesis: 'RSI(2) washed out to 8.0 while price holds above its 200-bar trend.', source: 'external' })
  const res = backfillLabelStrategy(db)
  assert.equal(res.scanned, 0)
  assert.equal(res.updated, 0)
})

test('logs a LABEL_BACKFILL action_log row only when something actually changed', () => {
  const db = initDB(':memory:')
  insertTrade(db, { thesis: 'nothing recognisable here' })
  backfillLabelStrategy(db)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE method = 'LABEL_BACKFILL'`).get().n, 0)

  insertTrade(db, { thesis: 'RSI(2) washed out to 8.0 while price holds above its 200-bar trend.' })
  backfillLabelStrategy(db)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE method = 'LABEL_BACKFILL'`).get().n, 1)
})
