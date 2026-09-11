// agent/services/entry-ledger.test.js — P2a: the durable intent ledger and
// its one-use permits.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { initDB } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { requestEntryMode, engineStatusFor, writeEngineStatus, _resetRefusalDedupe } from './entry-mode.js'
import {
  reserveEntry, redeemPermit, markSent, resolveIntent, releaseOldEpoch, expireStale, openIntents, intentCounts,
  pendingExposure, reconcileIntents, operatorResolve, ledgerView, newIntentId, OPEN_STATES,
} from './entry-ledger.js'
import { tagLabelWithIntent, labelIntentId, encodeLabel, parseLabel, MAX_LABEL_LEN } from '../lib/trade-labels.js'

const DEMO = '46130058', LIVE = '42993489'
function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  upsertAccount(db, { accountId: LIVE, isLive: true })
  _resetRefusalDedupe()
  return db
}
const base = { accountId: DEMO, producerId: 'scan_dispatch', symbolId: 1, symbol: 'EURUSD', side: 'BUY', volume: 1000, sl: 100, tp: 200 }
const row = (db, id) => db.prepare('SELECT * FROM entry_intents WHERE id = ?').get(id)

test('reserve issues a one-use permit; a second open intent on the same account/symbol/side is refused; other keys, accounts and manual producers are not', () => {
  const db = fresh()
  const r = reserveEntry(db, base)
  assert.equal(r.ok, true); assert.match(r.intentId, /^i[0-9a-z]{12}$/); assert.match(r.permit.id, /^p[0-9a-z]{12}$/)
  assert.equal(r.permit.epoch, 0); assert.equal(r.permit.environment, 'demo'); assert.equal(r.permit.side, 'BUY'); assert.equal(r.permit.volume, 1000)
  assert.equal(row(db, r.intentId).state, 'RESERVED')
  const dup = reserveEntry(db, base)
  assert.equal(dup.ok, false); assert.match(dup.reason, /^intent_open: RESERVED i/)
  assert.equal(reserveEntry(db, { ...base, side: 'SELL' }).ok, true, 'the other side is a different key')
  assert.equal(reserveEntry(db, { ...base, symbolId: 2, symbol: 'GBPUSD' }).ok, true, 'another symbol')
  assert.equal(reserveEntry(db, { ...base, accountId: LIVE }).ok, true, 'another account')
  assert.equal(reserveEntry(db, { ...base, symbolId: 3, symbol: 'USDJPY', producerId: 'route_manual_order' }).ok, true, 'manual producers reserve too')
  assert.equal(reserveEntry(db, { ...base, symbolId: 4, side: 'HOLD' }).ok, false)
  assert.equal(reserveEntry(db, { ...base, symbolId: null, symbol: null }).ok, false)
  assert.equal(reserveEntry(db, { ...base, symbolId: 5, producerId: 'nope' }).ok, false, 'an unknown producer is refused by the fence')
  assert.deepEqual(intentCounts(db, DEMO), { unsent: 4, inFlight: 0, unknown: 0 })
})

test('the P1b fence is inside the reservation: a STOPPED account reserves nothing for an automatic producer', () => {
  const db = fresh()
  requestEntryMode(db, DEMO, 'STOPPED')
  const r = reserveEntry(db, base)
  assert.equal(r.ok, false); assert.equal(r.reason, 'entry_mode_stopped')
  assert.equal(reserveEntry(db, { ...base, producerId: 'route_manual_order' }).ok, true, 'manual is admitted under STOPPED')
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM entry_intents WHERE producer_id = 'scan_dispatch'`).get().n, 0)
})

test('redeem moves RESERVED → DISPATCHING exactly once; expired, consumed, unknown and stale-epoch permits are refused', () => {
  const db = fresh()
  const now = Date.now()
  const r = reserveEntry(db, { ...base, now })
  const first = redeemPermit(db, r.permit.id, { now: now + 1000 })
  assert.equal(first.ok, true); assert.equal(first.intent.state, 'DISPATCHING'); assert.equal(row(db, r.intentId).state, 'DISPATCHING')
  const second = redeemPermit(db, r.permit.id, { now: now + 1000 })
  assert.equal(second.ok, false); assert.match(second.reason, /^permit_consumed: DISPATCHING/)
  assert.equal(redeemPermit(db, 'pnope').reason, 'permit_unknown')
  // expired: reserved at t, redeemed after the TTL
  const e = reserveEntry(db, { ...base, symbolId: 2, symbol: 'GBPUSD', now, ttlMs: 5000 })
  const late = redeemPermit(db, e.permit.id, { now: now + 6000 })
  assert.equal(late.ok, false); assert.equal(late.reason, 'permit_expired'); assert.equal(row(db, e.intentId).state, 'EXPIRED')
  // the mode changed between reserve and redeem: the switch itself releases
  // the unsent reservation (plan §3 step 1), so the redeem finds it consumed
  const s = reserveEntry(db, { ...base, symbolId: 3, symbol: 'USDJPY', now })
  requestEntryMode(db, DEMO, 'TIME_BASED') // epoch 0 → 1, mode unchanged
  const released = redeemPermit(db, s.permit.id, { now: now + 1000 })
  assert.equal(released.ok, false); assert.equal(released.reason, 'permit_consumed: RELEASED')
  assert.equal(row(db, s.intentId).state, 'RELEASED'); assert.equal(row(db, s.intentId).error_code, 'epoch_stale')
  // the redeem's own epoch check, for a record that moved without the switch
  const t = reserveEntry(db, { ...base, symbolId: 4, symbol: 'AUDUSD', now })
  writeEngineStatus(db, { ...engineStatusFor(db, DEMO), modeEpoch: 7, fenceAckEpoch: 7 })
  const stale = redeemPermit(db, t.permit.id, { now: now + 1000 })
  assert.equal(stale.ok, false); assert.match(stale.reason, /^permit_epoch_stale: permit epoch 1, account epoch 7/)
  assert.equal(row(db, t.intentId).state, 'RELEASED')
})

test('lifecycle: DISPATCHING → SENT → FILLED with the broker ids; a resolved intent is immutable; counts follow', () => {
  const db = fresh()
  const r = reserveEntry(db, base)
  redeemPermit(db, r.permit.id)
  assert.equal(markSent(db, r.intentId, { sidecarBootId: 'boot1' }).ok, true)
  assert.deepEqual(intentCounts(db, DEMO), { unsent: 0, inFlight: 1, unknown: 0 })
  assert.equal(markSent(db, r.intentId).ok, false, 'SENT once')
  assert.equal(resolveIntent(db, r.intentId, { state: 'FILLED', positionId: 777, brokerOrderId: 555, source: 'response' }).ok, true)
  const it = row(db, r.intentId)
  assert.equal(it.state, 'FILLED'); assert.equal(it.broker_position_id, '777'); assert.equal(it.broker_order_id, '555'); assert.equal(it.resolution_source, 'response'); assert.ok(it.resolved_at)
  assert.equal(resolveIntent(db, r.intentId, { state: 'REJECTED', source: 'response' }).ok, false, 'terminal is terminal')
  assert.equal(resolveIntent(db, r.intentId, { state: 'RESERVED', source: 'x' }).ok, false)
  assert.deepEqual(intentCounts(db, DEMO), { unsent: 0, inFlight: 0, unknown: 0 })
  assert.equal(reserveEntry(db, base).ok, true, 'a filled intent no longer blocks the key')
})

test('an ambiguous send is UNKNOWN: it survives a reopen of the database and blocks a resend on the same key until evidence resolves it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'))
  const file = join(dir, 'agent.db')
  let db = initDB(file)
  upsertAccount(db, { accountId: DEMO, isLive: false })
  const r = reserveEntry(db, base)
  redeemPermit(db, r.permit.id); markSent(db, r.intentId)
  assert.equal(resolveIntent(db, r.intentId, { state: 'UNKNOWN', errorCode: 'TIMEOUT: no payloadType 2126 within 20000ms', source: 'response' }).ok, true)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE path = '/entry-intents/unknown'`).get().n, 1)
  db.close()
  db = initDB(file) // the process restarted; the in-memory lock would be gone
  const again = reserveEntry(db, base)
  assert.equal(again.ok, false); assert.match(again.reason, /^intent_open: UNKNOWN/)
  assert.deepEqual(intentCounts(db, DEMO), { unsent: 0, inFlight: 0, unknown: 1 })
  // the broker's evidence: a position whose label carries the tag
  const label = tagLabelWithIntent('AU|v1|SCAN|H|LN|4h|TR', r.intentId)
  const rec = reconcileIntents(db, { accountId: DEMO, positions: [{ positionId: 9001, tradeData: { label, symbolId: 1 } }] })
  assert.deepEqual(rec.resolved, [{ intentId: r.intentId, from: 'UNKNOWN', to: 'FILLED' }])
  assert.equal(row(db, r.intentId).broker_position_id, '9001'); assert.equal(row(db, r.intentId).resolution_source, 'reconcile')
  assert.equal(reserveEntry(db, base).ok, true, 'resolved → the key is free')
  db.close()
})

test('time is evidence of absence only: unredeemed permits expire, an unanswered send becomes UNKNOWN, never failed or filled', () => {
  const db = fresh()
  const now = Date.now()
  const a = reserveEntry(db, { ...base, now, ttlMs: 1000 })
  const b = reserveEntry(db, { ...base, symbolId: 2, symbol: 'GBPUSD', now })
  redeemPermit(db, b.permit.id, { now }); markSent(db, b.intentId, { now })
  const c = reserveEntry(db, { ...base, symbolId: 3, symbol: 'USDJPY', now })
  redeemPermit(db, c.permit.id, { now }) // DISPATCHING and then the process died
  const e1 = expireStale(db, { now: now + 2000 })
  assert.deepEqual(e1, { expired: 1, unknown: 0 }); assert.equal(row(db, a.intentId).state, 'EXPIRED')
  const e2 = expireStale(db, { now: now + 61_000 })
  assert.deepEqual(e2, { expired: 0, unknown: 2 })
  assert.equal(row(db, b.intentId).state, 'UNKNOWN'); assert.equal(row(db, c.intentId).state, 'UNKNOWN'); assert.equal(row(db, b.intentId).resolution_source, 'timeout')
  assert.equal(openIntents(db, DEMO).length, 2)
  assert.deepEqual(pendingExposure(db, DEMO).map(x => [x.symbolId, x.side, x.volume, x.state]), [[2, 'BUY', 1000, 'UNKNOWN'], [3, 'BUY', 1000, 'UNKNOWN']])
})

test('reconcile resolves from the sidecar ring too: order_reject → REJECTED, order_result with a position → FILLED; an intent nothing names stays open', () => {
  const db = fresh()
  const mk = (symbolId, symbol) => { const r = reserveEntry(db, { ...base, symbolId, symbol }); redeemPermit(db, r.permit.id); markSent(db, r.intentId); return r.intentId }
  const rej = mk(1, 'EURUSD'), fill = mk(2, 'GBPUSD'), acc = mk(3, 'USDJPY'), none = mk(4, 'AUDUSD')
  const ins = db.prepare(`INSERT INTO cpp_decisions (side, boot_id, seq, ts_ms, component, kind, account_id, symbol_id, code, detail) VALUES ('cpp_exec_demo', 'b1', ?, 1, 'engine', ?, ?, ?, ?, ?)`)
  ins.run(1, 'order_submit', DEMO, 1, '', `intent=${rej}`)
  ins.run(2, 'order_reject', DEMO, 1, 'TRADING_BAD_VOLUME', `intent=${rej}`)
  ins.run(3, 'order_result', DEMO, 2, '', `intent=${fill} order=41 pos=42`)
  ins.run(4, 'order_result', DEMO, 3, '', `intent=${acc} order=43`)
  const rec = reconcileIntents(db, { accountId: DEMO })
  assert.equal(rec.checked, 4); assert.equal(rec.stillOpen, 1)
  assert.equal(row(db, rej).state, 'REJECTED'); assert.equal(row(db, rej).error_code, 'TRADING_BAD_VOLUME'); assert.equal(row(db, rej).resolution_source, 'ring')
  assert.equal(row(db, fill).state, 'FILLED'); assert.equal(row(db, fill).broker_position_id, '42'); assert.equal(row(db, fill).broker_order_id, '41')
  assert.equal(row(db, acc).state, 'ACCEPTED'); assert.equal(row(db, acc).broker_order_id, '43')
  assert.equal(row(db, none).state, 'SENT')
  // a resting order in the snapshot carrying the tag → ACCEPTED
  const rec2 = reconcileIntents(db, { accountId: DEMO, orders: [{ orderId: 99, tradeData: { label: tagLabelWithIntent('AU|v1|FIB|M|LN|4h|RG', none) } }] })
  assert.equal(rec2.resolved.length, 1); assert.equal(row(db, none).state, 'ACCEPTED'); assert.equal(row(db, none).broker_order_id, '99')
})

test('a mode switch releases RESERVED intents of the old epoch and leaves in-flight ones alone; the operator resolves UNKNOWN with a reason', () => {
  const db = fresh()
  const a = reserveEntry(db, base)
  const b = reserveEntry(db, { ...base, symbolId: 2, symbol: 'GBPUSD' })
  redeemPermit(db, b.permit.id); markSent(db, b.intentId)
  const sw = requestEntryMode(db, DEMO, 'STOPPED')
  assert.equal(sw.ok, true)
  assert.equal(row(db, a.intentId).state, 'RELEASED', 'unsent old-epoch intent released by the switch (plan §3 step 1)')
  assert.equal(row(db, b.intentId).state, 'SENT', 'in flight stays in flight (step 2)')
  assert.deepEqual(sw.status.entryCounts, { unsent: 0, inFlight: 1, resting: 0, unknown: 0 })
  assert.equal(releaseOldEpoch(db, DEMO, 99).released, 0)
  resolveIntent(db, b.intentId, { state: 'UNKNOWN', source: 'response', errorCode: 'socket closed' })
  assert.equal(engineStatusFor(db, DEMO).effectiveEntryMode, 'STOPPED')
  assert.equal(operatorResolve(db, b.intentId, { state: 'REJECTED', reason: '' }).reason, 'reason_required')
  assert.equal(operatorResolve(db, b.intentId, { state: 'RESERVED', reason: 'x' }).ok, false)
  const op = operatorResolve(db, b.intentId, { state: 'REJECTED', reason: 'broker history shows no deal for this label' })
  assert.deepEqual(op, { ok: true, from: 'UNKNOWN', to: 'REJECTED' })
  assert.match(row(db, b.intentId).error_code, /^operator: broker history/)
  assert.equal(operatorResolve(db, b.intentId, { state: 'FILLED', reason: 'changed my mind' }).ok, false, 'terminal stays terminal')
  const v = ledgerView(db)
  assert.ok(!JSON.stringify(v).includes(DEMO), 'account ids are redacted')
  assert.equal(v.countsByAccount['…0058'].RELEASED, 1); assert.equal(v.countsByAccount['…0058'].REJECTED, 1)
  assert.equal(v.recent.length, 2)
})

test('the label tag: an 8th field parseLabel ignores and labelIntentId reads; never applied when it would overflow', () => {
  const id = newIntentId()
  const plain = encodeLabel({ source: 'autopilot', strategy: 'vwap_trend', conviction: 8, session: 'london', timeframe: '4h', regime: 'trending' })
  const tagged = tagLabelWithIntent(plain, id)
  assert.equal(tagged, `${plain}|${id}`); assert.equal(labelIntentId(tagged), id)
  assert.deepEqual(parseLabel(tagged), parseLabel(plain) && { ...parseLabel(plain), raw: tagged }, 'the seven fields decode exactly as before')
  assert.equal(labelIntentId(plain), null); assert.equal(labelIntentId(null), null); assert.equal(labelIntentId('a|b|c|d|e|f|g|notatag'), null)
  assert.equal(tagLabelWithIntent(tagged, 'i000000000000'), `${plain}|i000000000000`, 'a second tag replaces the first')
  assert.equal(tagLabelWithIntent(plain, 'bad id'), plain)
  const long = 'x'.repeat(MAX_LABEL_LEN - 3)
  assert.equal(tagLabelWithIntent(long, id), long, 'no room → no tag, never a truncated one')
  assert.equal(encodeLabel({ source: 'autopilot', strategy: 'vwap_trend', intentId: id }).endsWith(`|${id}`), true)
  assert.ok(OPEN_STATES.includes('UNKNOWN'))
})
