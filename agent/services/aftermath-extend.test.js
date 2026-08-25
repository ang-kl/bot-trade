// node --test agent/services/aftermath-extend.test.js
//
// The preview must count HONESTLY before any apply is allowed to exist:
// a row already holding 96 aftermath bars is not "extendable", a fresh close
// whose history is still forming is not "extendable", and a row with no bars
// at all is a different bucket from all of them. The owner approved the DRY
// RUN only ("go, dry-run only", 25-08-2026) — so the other load-bearing fact
// pinned here is that the preview is a pure read: same DB state before and
// after.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { previewAftermathExtension } from './aftermath-extend.js'
import { AFTERMATH_BARS, REPLAY_AFTERMATH_BARS, classifyLoss } from './loss-postmortem.js'

const MIN = 60_000
const H = 3_600_000

function seedRow(db, { closedAgoMs, afterBars, tf = '15m', barsJson } = {}) {
  const tfm = tf === '15m' ? 15 * MIN : H
  const closedMs = Date.now() - closedAgoMs
  const closedAt = new Date(closedMs).toISOString()
  const openedAt = new Date(closedMs - 2 * H).toISOString()
  const bars = barsJson !== undefined ? barsJson : JSON.stringify(
    Array.from({ length: (afterBars ?? 0) + 3 }, (_, i) => {
      const t = closedMs + (i - 2) * tfm // 2 bars before the close, the rest after
      return [t, 100, 100.5, 99.5, 100, 0]
    })
  )
  const info = db.prepare(
    `INSERT INTO trades (symbol, side, status, entry_price, sl_price, opened_at, closed_at, net_pnl, account_id)
     VALUES ('ADAUSD', 'long', 'closed', 100, 99, ?, ?, -1, '43097342')`
  ).run(openedAt, closedAt)
  db.prepare(
    `INSERT INTO trade_postmortems (trade_id, symbol, timeframe, side, entry_price, sl_price, classification, bars_json)
     VALUES (?, 'ADAUSD', ?, 'long', 100, 99, 'time_cap', ?)`
  ).run(info.lastInsertRowid, tf, bars)
  return info.lastInsertRowid
}

test('an old short row is extendable; a full row and a fresh row are not', () => {
  const db = initDB(':memory:')
  // Old close (2 days ago), only 5 aftermath bars stored → extendable.
  seedRow(db, { closedAgoMs: 48 * H, afterBars: 5 })
  // Old close already carrying the full window → alreadyFull.
  seedRow(db, { closedAgoMs: 48 * H, afterBars: REPLAY_AFTERMATH_BARS + 2 })
  // Closed 10 minutes ago on 15m bars → its 96-bar aftermath has not traded yet.
  seedRow(db, { closedAgoMs: 10 * MIN, afterBars: 1 })
  // No bars stored at all → its own bucket, never "extendable".
  seedRow(db, { closedAgoMs: 48 * H, barsJson: null })

  const p = previewAftermathExtension(db)
  assert.equal(p.totalPostmortems, 4)
  assert.equal(p.extendable, 1)
  assert.equal(p.alreadyFull, 1)
  assert.equal(p.historyStillForming, 1)
  assert.equal(p.noBars, 1)
  assert.equal(p.brokerFetchesNeeded, 1, 'one candle fetch per extendable row')
  assert.deepEqual(p.byTimeframe, { '15m': 1 })
  assert.equal(p.sample.length, 1)
  assert.equal(p.sample[0].afterBars, 5)
})

test('the preview is a pure read — it writes nothing', () => {
  const db = initDB(':memory:')
  seedRow(db, { closedAgoMs: 48 * H, afterBars: 5 })
  const before = db.prepare('SELECT bars_json FROM trade_postmortems').all()
  previewAftermathExtension(db)
  const after = db.prepare('SELECT bars_json FROM trade_postmortems').all()
  assert.deepEqual(after, before, 'dry run must not touch a single row')
})

// ---------------------------------------------------------------------------
// The decoupling IS the design: the replay window grew 12 → 96, the VERDICT
// window did not. A loss that recovers at bar 50 must classify the same as it
// did before this change — only an explicit opts.aftermathBars widens the
// judgment. If someone later folds the two constants back together, this is
// the test that goes red.
// ---------------------------------------------------------------------------
test('classification still judges over 12 bars; only the replay window is 96', () => {
  assert.equal(AFTERMATH_BARS, 12)
  assert.equal(REPLAY_AFTERMATH_BARS, 96)

  const closedMs = Date.now() - 24 * H
  const trade = { side: 'long', entry_price: 100, sl_price: 99, exit_price: 99, close_reason: 'sl' }
  const bars = []
  // 12 bars after the close staying below the stop, then a recovery above
  // entry at bar ~50 — visible to a 96-bar judge, invisible to a 12-bar one.
  // classifyLoss reads bar OBJECTS ({t,o,h,l,c}) — the array form is the
  // STORED bars_json shape, a different consumer.
  for (let i = 1; i <= 60; i++) {
    const px = i < 40 ? 98.8 : 101
    bars.push({ t: closedMs + i * 15 * MIN, o: px, h: px + 0.1, l: px - 0.1, c: px })
  }
  const narrow = classifyLoss(trade, bars, closedMs)
  const wide = classifyLoss(trade, bars, closedMs, { aftermathBars: 96 })
  assert.notEqual(narrow.classification, 'stop_hunt',
    'the default judge must NOT see the bar-50 recovery — that would mean the verdict window silently widened')
  assert.equal(wide.classification, 'stop_hunt',
    'an explicit 96-bar judge DOES see the recovery — the knob works, it just is not the default')
})
