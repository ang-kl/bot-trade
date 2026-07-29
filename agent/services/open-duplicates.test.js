// findOpenDuplicates — the audit that would have caught the live 0003.HK pair.
//
// The existing detector only looks at CLOSED trades. On 2026-07-29 it happily
// reported two historical pairs while a duplicate sat OPEN in the book:
// 0003.HK trade ids 327/328, same side, entry 6.94, stop 6.994, and the same
// opened_at to the second. Detecting a duplicate once it closes is detecting
// it after the money is gone.
//
// Both directions matter here. A missed duplicate is double the intended
// exposure; a false one on a legitimate second entry would train the owner to
// ignore the alert, which is the same outcome by a slower route.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { initDB } from '../db.js'
import { findOpenDuplicates, normalisePositionId } from './trade-integrity.js'

const tmpDb = () => initDB(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'opendup-')), 'agent.db'))

function openPosition(db, {
  symbol = '0003.HK', side = 'long', entry = 6.94, sl = 6.994, tp = null,
  openedAt = '2026-07-28 06:53:23', posId = null, volume = 1, account = '47790949',
  source = 'autopilot', strategy = 'vp_value',
} = {}) {
  db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price,
              volume, opened_at, ctrader_position_id, source, label_strategy, account_id)
              VALUES (?,?,'open',?,?,?,?,?,?,?,?,?)`)
    .run(symbol, side === 'long' ? 'BUY' : 'SELL', entry, sl, tp, volume, openedAt, posId, source, strategy, account)
  const tradeId = db.prepare('SELECT last_insert_rowid() AS id').get().id
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl,
              current_tp, source, strategy, account_id, status)
              VALUES (?,?,?,?,?,?,?,?,?,'active')`)
    .run(symbol, tradeId, side, entry, sl, tp, source, strategy, account)
  return tradeId
}

test('THE LIVE CASE: two open rows, same entry and the same opened_at second', () => {
  const db = tmpDb()
  openPosition(db)
  openPosition(db)          // byte-identical, exactly as production had it

  const { groups, count } = findOpenDuplicates(db)
  assert.equal(count, 1, 'the live 0003.HK pair must be reported')
  assert.equal(groups[0].symbol, '0003.HK')
  assert.equal(groups[0].count, 2)
  assert.equal(groups[0].extraLegs, 1, 'one leg beyond the position that was presumably intended')
  assert.match(groups[0].note, /essentially never/)
})

test('one broker position recorded twice is the STRONGER signal and says so', () => {
  const db = tmpDb()
  // Different entry prices (a partial fill would do this), so the
  // same-second key misses it — but one broker position cannot be two rows.
  openPosition(db, { entry: 6.94, posId: 234049511, openedAt: '2026-07-28 06:53:23' })
  openPosition(db, { entry: 6.95, posId: 234049511, openedAt: '2026-07-28 06:53:41' })

  const { groups } = findOpenDuplicates(db)
  assert.equal(groups.length, 1)
  assert.equal(groups[0].kind, 'same_broker_position_id')
  assert.match(groups[0].note, /near-certain/)
  assert.deepEqual(groups[0].brokerPositionIds, ['234049511'],
    'reported as a clean string — see the normalisePositionId test below for why')
})

test('a row is not reported twice when both signals catch it', () => {
  const db = tmpDb()
  openPosition(db, { posId: 999 })
  openPosition(db, { posId: 999 })   // identical AND same broker id
  const { groups } = findOpenDuplicates(db)
  assert.equal(groups.length, 1, 'the stronger signal reports it once, not both')
  assert.equal(groups[0].kind, 'same_broker_position_id')
})

// -------------------------------------------------- the false alarms to avoid

test('two entries on the same symbol at DIFFERENT prices are not duplicates', () => {
  const db = tmpDb()
  openPosition(db, { entry: 6.94, posId: 1, openedAt: '2026-07-28 06:53:23' })
  openPosition(db, { entry: 7.10, posId: 2, openedAt: '2026-07-28 09:15:02' })
  // Scaling into a position is a legitimate thing this bot does. Calling it a
  // duplicate would train the owner to ignore the alert — the same outcome as
  // not having one.
  assert.equal(findOpenDuplicates(db).count, 0)
})

test('same price but a different second is not a duplicate', () => {
  const db = tmpDb()
  openPosition(db, { entry: 6.94, posId: 1, openedAt: '2026-07-28 06:53:23' })
  openPosition(db, { entry: 6.94, posId: 2, openedAt: '2026-07-28 06:53:24' })
  assert.equal(findOpenDuplicates(db).count, 0, 'one second apart is two decisions, not one recorded twice')
})

test('opposite sides on one symbol are a hedge, not a duplicate', () => {
  const db = tmpDb()
  openPosition(db, { side: 'long', posId: 1 })
  openPosition(db, { side: 'short', posId: 2 })
  assert.equal(findOpenDuplicates(db).count, 0)
})

test('CLOSED duplicates are not reported here — that is the other audit', () => {
  const db = tmpDb()
  const a = openPosition(db)
  openPosition(db)
  db.prepare("UPDATE monitored_positions SET status='closed' WHERE trade_id = ?").run(a)
  assert.equal(findOpenDuplicates(db).count, 0, 'only ACTIVE positions are in scope')
})

test('a single open position is never a duplicate', () => {
  const db = tmpDb()
  openPosition(db)
  assert.equal(findOpenDuplicates(db).count, 0)
})

test('an empty book returns a clean empty result, not a crash', () => {
  assert.deepEqual(findOpenDuplicates(tmpDb()), { groups: [], count: 0 })
})

test('rows with no opened_at or no entry are skipped rather than grouped as null', () => {
  const db = tmpDb()
  const t1 = openPosition(db)
  const t2 = openPosition(db)
  db.prepare('UPDATE trades SET opened_at = NULL WHERE id IN (?,?)').run(t1, t2)
  // Two nulls must not collide into one "null|null" key and be called a pair.
  assert.equal(findOpenDuplicates(db).count, 0)
})

test('the report carries what is needed to act, without acting', () => {
  const db = tmpDb()
  openPosition(db, { volume: 2 })
  openPosition(db, { volume: 3 })
  const g = findOpenDuplicates(db).groups[0]
  for (const k of ['positionIds', 'tradeIds', 'accountId', 'openedAt', 'extraLegs', 'extraVolume']) {
    assert.ok(g[k] !== undefined, `${k} missing — the owner cannot act on this report`)
  }
  assert.equal(g.extraVolume, 3, 'the exposure beyond the first leg')
  // Deciding WHICH leg to close is the owner's call; closing the wrong one
  // doubles the damage instead of fixing it. This audit never closes anything.
  const src = fs.readFileSync(new URL('./trade-integrity.js', import.meta.url), 'utf8')
  const fn = src.slice(src.indexOf('export function findOpenDuplicates'))
  assert.ok(!/UPDATE|DELETE|closePosition/.test(fn), 'the open-duplicate audit must be read-only')
})

// ---------------------------------------------------------------------------
// A REAL HAZARD this test suite surfaced on the way in.
//
// trades.ctrader_position_id is a TEXT column. Binding a JS NUMBER to it
// stores "234049511.0" — and "234049511.0" !== "234049511", so every later
// lookup against the broker's id silently misses. The bug is invisible: the
// row looks right to a human reading it.
// ---------------------------------------------------------------------------
test('a numeric position id stored as TEXT becomes "…​.0" and must be normalised', () => {
  const db = tmpDb()
  openPosition(db, { posId: 234049511, entry: 1.1, openedAt: '2026-07-28 01:00:00' })
  const raw = db.prepare('SELECT ctrader_position_id AS p FROM trades LIMIT 1').get().p
  // This is the corruption, demonstrated rather than asserted from memory.
  assert.equal(raw, '234049511.0', 'if this ever changes, the normaliser can be reconsidered')
  assert.equal(normalisePositionId(raw), '234049511')
})

test('normalisePositionId leaves correct values alone and refuses junk', () => {
  assert.equal(normalisePositionId('234049511'), '234049511')
  assert.equal(normalisePositionId(' 42 '), '42')
  assert.equal(normalisePositionId(null), null)
  assert.equal(normalisePositionId(''), null)
  // Not a trailing-zero decimal — leave it exactly as found rather than guess.
  assert.equal(normalisePositionId('12.34'), '12.34')
})
