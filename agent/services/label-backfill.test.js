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

test('recovers the 6 strategies added 2026-07-22 (fib_618_fade, cup_handle, inv_cup_handle, ema_pullback, donchian_breakout, rsi_meanrev)', () => {
  const db = initDB(':memory:')
  insertTrade(db, { thesis: '61.8% Fib fade — swing up 1.1050 → 1.0980, reacting at 1.1023 on 4h. Targeting return to 1.1050.' })
  insertTrade(db, { thesis: 'Cup & Handle breakout on 1d — cup 100→75.7→100 (depth 21%, 31 bars), 4-bar handle, breakout vol 1.4× handle. Target 124.3 (measured move), SL 1.5×ATR.' })
  insertTrade(db, { thesis: 'Inverted Cup & Handle breakdown on 1d — dome 150→126→100 (depth 17%, 31 bars), 4-bar handle, breakdown vol 1.4× handle. Target 76 (measured move), SL 1.5×ATR.' })
  insertTrade(db, { thesis: 'Uptrend on 4h (EMA20 above EMA50). Price dipped to the EMA20 line and closed back above it — buying the pullback, stop below the dip and EMA50, targets at 2R and 3R.' })
  insertTrade(db, { thesis: 'Price closed above the 20-bar range on 2.3x volume. Target is one range height up; stop is 1.5 ATR behind entry.' })
  insertTrade(db, { thesis: 'RSI washed out below 30 and turned back up while price holds above the 50-bar average — buying the dip back to the 20-bar mean (RSI 24.10 → 32.50).' })
  const res = backfillLabelStrategy(db)
  assert.equal(res.updated, 6)
  assert.deepEqual(res.byStrategy, {
    fib_618_fade: 1, cup_handle: 1, inv_cup_handle: 1,
    ema_pullback: 1, donchian_breakout: 1, rsi_meanrev: 1,
  })
})

test('cup_handle and inv_cup_handle fingerprints never cross-match each other', () => {
  const db = initDB(':memory:')
  const cupId = insertTrade(db, { thesis: 'Cup & Handle breakout on 4h — cup 100→90→105 (depth 10%, 40 bars), 5-bar handle, breakout vol 1.6× handle. Target 115 (measured move), SL 1.5×ATR.' })
  const invId = insertTrade(db, { thesis: 'Inverted Cup & Handle breakdown on 4h — dome 105→115→100 (depth 10%, 40 bars), 5-bar handle, breakdown vol 1.6× handle. Target 90 (measured move), SL 1.5×ATR.' })
  backfillLabelStrategy(db)
  assert.equal(db.prepare('SELECT label_strategy FROM trades WHERE id = ?').get(cupId).label_strategy, 'cup_handle')
  assert.equal(db.prepare('SELECT label_strategy FROM trades WHERE id = ?').get(invId).label_strategy, 'inv_cup_handle')
})

test('ema_pullback fingerprint does not cross-match vwap_trend\'s near-identical "buying the pullback" wording', () => {
  const db = initDB(':memory:')
  const vwapId = insertTrade(db, { thesis: 'Uptrend on 1h above a rising VWAP. Price pulled back to the VWAP line and closed above it — buying the pullback, stop below the dip, targets 2R/3R.' })
  const emaId = insertTrade(db, { thesis: 'Uptrend on 1h (EMA20 above EMA50). Price dipped to the EMA20 line and closed back above it — buying the pullback, stop below the dip and EMA50, targets at 2R and 3R.' })
  backfillLabelStrategy(db)
  assert.equal(db.prepare('SELECT label_strategy FROM trades WHERE id = ?').get(vwapId).label_strategy, 'vwap_trend')
  assert.equal(db.prepare('SELECT label_strategy FROM trades WHERE id = ?').get(emaId).label_strategy, 'ema_pullback')
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
