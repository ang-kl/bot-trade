// node --test agent/services/duplicate-watch.test.js
//
// #144. The detector was already right — it would have caught both real
// incidents. Nothing called it. So every test here is about the WATCH: does it
// speak the first time, does it stay quiet after, does it speak again when the
// problem gets worse, and does it say when the problem goes away.
//
// The flood is the failure mode that matters. On a five-minute loop, an alert
// per pass is 288 messages a day about one known fact — which is exactly how
// the targetless-position alert became the thing the owner complained about.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { duplicateWatchPass, clusterKey, ESCALATE_AFTER_MS, FORGET_AFTER_MS } from './duplicate-watch.js'

const T0 = 1_785_800_000_000

function dup(db, { n = 2, symbol = '0005.HK', account = '43097342', openedAt = '2026-08-04 01:40:40', entry = 168.39, startId = 234848341 } = {}) {
  for (let i = 0; i < n; i++) {
    const tradeId = db.prepare(`
      INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, volume,
                          opened_at, ctrader_position_id, source, account_id)
      VALUES (?, 'long', 'open', ?, 156.974, 191.221, 9, ?, ?, 'autopilot', ?)
    `).run(symbol, entry, openedAt, String(startId + i), account).lastInsertRowid
    db.prepare(`
      INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, status, account_id, source)
      VALUES (?, ?, 'long', ?, 156.974, 191.221, 'active', ?, 'autopilot')
    `).run(symbol, tradeId, entry, account)
  }
}

const closeAll = (db) => db.prepare("UPDATE monitored_positions SET status='closed'").run()

test('a new cluster is announced once, and the second pass is silent', () => {
  const db = initDB(':memory:')
  dup(db, { n: 6 })                       // the real 0005.HK shape

  const first = duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 })
  assert.equal(first.newClusters.length, 1)
  assert.equal(first.newClusters[0].size, 6)
  assert.equal(first.alerts.length, 1)
  assert.match(first.alerts[0], /NEW/)
  assert.match(first.alerts[0], /6 × 0005\.HK/)

  // A minute later, nothing has changed. 288 of these a day is how an alert
  // becomes noise the owner filters out.
  const second = duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + 60_000 })
  assert.deepEqual(second.alerts, [])
  assert.equal(second.open, 1, 'still detected — quiet is not the same as gone')
})

test('a GROWING cluster speaks again immediately, inside the quiet window', () => {
  // Nine positions is a different problem from two, and the 0066.HK cluster
  // grew over minutes. Waiting six hours to mention that would be useless.
  const db = initDB(':memory:')
  dup(db, { n: 2 })
  duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 })

  dup(db, { n: 4, startId: 234849000 })
  const grown = duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + 60_000 })
  assert.equal(grown.escalated.length, 1)
  assert.equal(grown.escalated[0].reason, 'grew')
  assert.equal(grown.escalated[0].from, 2)
  assert.equal(grown.escalated[0].size, 6)
  assert.match(grown.alerts[0], /GREW from 2/)
})

test('a still-open cluster is repeated only after the escalation window', () => {
  const db = initDB(':memory:')
  dup(db, { n: 3 })
  duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 })

  assert.deepEqual(duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + ESCALATE_AFTER_MS - 1 }).alerts, [])
  const late = duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + ESCALATE_AFTER_MS })
  assert.equal(late.escalated[0].reason, 'still_open')
  assert.match(late.alerts[0], /STILL OPEN/)
})

test('a cleared cluster is announced once, then stays quiet', () => {
  // The 0066.HK nine cleared themselves at the broker overnight. That was
  // worth knowing and nothing said it — and without a clear message an owner
  // cannot tell "fixed" from "the watch stopped working".
  const db = initDB(':memory:')
  dup(db, { n: 9, symbol: '0066.HK', entry: 32.69 })
  duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 })

  closeAll(db)
  const gone = duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + 60_000 })
  assert.equal(gone.cleared.length, 1)
  assert.equal(gone.cleared[0].size, 9)
  assert.match(gone.alerts[0], /CLEARED/)
  assert.match(gone.alerts[0], /0066\.HK/)

  assert.deepEqual(duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + 120_000 }).alerts, [])
})

test('a cluster that clears and RETURNS is news again', () => {
  const db = initDB(':memory:')
  dup(db, { n: 2 })
  duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 })
  closeAll(db)
  duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + 1000 })

  dup(db, { n: 2, startId: 234900000 })
  const back = duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + 2000 })
  assert.ok(back.escalated.length + back.newClusters.length > 0, 'a recurrence must not be swallowed by the old stamp')
  assert.ok(back.alerts.length > 0)
})

test('a forgotten cluster is pruned so the store cannot grow forever', () => {
  const db = initDB(':memory:')
  dup(db, { n: 2 })
  duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 })
  closeAll(db)
  duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + 1000 })
  const after = duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + 1000 + FORGET_AFTER_MS })
  assert.deepEqual(after.alerts, [], 'nothing more to say about a week-old cleared cluster')
})

test('the store is PER ACCOUNT — one account\'s pass cannot mute another\'s', () => {
  // PR #625 fixed exactly this in the naked-position guard: a global map has
  // each account's prune deleting the other's stamps, and the mute stops
  // working for everybody.
  const db = initDB(':memory:')
  dup(db, { n: 2, account: '43097342' })
  dup(db, { n: 2, account: '46130058', symbol: '0003.HK', entry: 40.1, startId: 235000000 })

  const a = duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 })
  const b = duplicateWatchPass(db, { accountId: '46130058', nowMs: T0 })
  assert.equal(a.newClusters.length, 1)
  assert.equal(b.newClusters.length, 1, 'the second account is not muted by the first')

  // and neither pass wiped the other's stamp
  assert.deepEqual(duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 + 1000 }).alerts, [])
  assert.deepEqual(duplicateWatchPass(db, { accountId: '46130058', nowMs: T0 + 1000 }).alerts, [])
})

test('the cluster key survives rows coming and going', () => {
  // The same real cluster gains and loses local rows as the reconciler adopts
  // and closes them. An id-based key would call every such change a brand-new
  // cluster and alert again.
  const g = (count) => ({ kind: 'same_second_same_price', count, accountId: 'A', symbol: 'X', side: 'long' })
  assert.equal(clusterKey(g(2)), clusterKey(g(4)), 'the key does not move when the cluster gains or loses rows')
  assert.notEqual(clusterKey(g(2)), clusterKey({ kind: 'same_broker_position_id', accountId: 'A', symbol: 'X', side: 'long' }))
})

test('no duplicates is a calm empty result, not a throw', () => {
  const db = initDB(':memory:')
  const out = duplicateWatchPass(db, { accountId: '43097342', nowMs: T0 })
  assert.deepEqual(out.alerts, [])
  assert.equal(out.open, 0)
  assert.deepEqual(out.newClusters, [])
})
