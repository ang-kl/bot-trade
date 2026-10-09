// Codex · №12,710 · 2026-10-09; codex-footprint: account-owned guard-to-storage integration.
// Actual guard, executor, exec-engine and SQLite. Only the final sidecar fetch,
// owned quote/list transport and notification delivery are controlled locally.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { getCtraderCreds, accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { invalidateSidecarSession } from '../lib/exec-engine.js'
import { _seedVolumeMetaForTests } from '../lib/lot-sizing.js'
import { runSessionOpenGuard, resetSessionOpenGuardMemory } from './session-open-guard.js'

const KEYS = ['CTRADER_CLIENT_ID', 'CTRADER_CLIENT_SECRET', 'EXEC_ENGINE', 'EXEC_URL', 'EXEC_URL_DEMO', 'EXEC_URL_LIVE', 'EXEC_SECRET', 'EXEC_FALLBACK']
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]))
const realFetch = globalThis.fetch
Object.assign(process.env, { CTRADER_CLIENT_ID: 'offline', CTRADER_CLIENT_SECRET: 'offline', EXEC_ENGINE: 'cpp',
  EXEC_URL: 'http://guard-demo.invalid', EXEC_URL_DEMO: 'http://guard-demo.invalid',
  EXEC_URL_LIVE: 'http://guard-live.invalid', EXEC_SECRET: 'offline', EXEC_FALLBACK: '0' })
// One DB deliberately: loop.prepareStatements caches the application's DB.
const db = initDB(':memory:')
const NOW = Date.UTC(2026, 9, 9, 8, 10)
const isShort = side => ['SELL', 'SHORT', 'sell', 'short'].includes(side)
let nextPosition = 91000
let active
after(() => {
  globalThis.fetch = realFetch
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  db.close()
})

function map(account, symbolId) {
  setState(db, accountSymbolMapKey(account), JSON.stringify({ accountId: account, builtAt: new Date().toISOString(), map: { EURUSD: symbolId } }))
  _seedVolumeMetaForTests(account, symbolId, { digits: 5 })
}
function fixture({ selected = '100', bothDemo = false } = {}) {
  db.prepare("UPDATE monitored_positions SET status='closed'").run()
  db.prepare("UPDATE trades SET status='closed'").run()
  for (const [account, live] of [['100', 0], ['200', bothDemo ? 0 : 1]]) {
    db.prepare('INSERT INTO accounts(account_id,is_live,enabled,mode) VALUES(?,?,1,?) ON CONFLICT(account_id) DO UPDATE SET is_live=excluded.is_live,enabled=1,mode=excluded.mode').run(account, live, 'active')
    map(account, account === '100' ? 11 : 22)
  }
  setState(db, 'ctrader_account_id', selected)
  setState(db, 'ctrader_is_live', selected === '200' && !bothDemo ? 'true' : 'false')
  setState(db, 'ctrader_access_token', 'offline-token')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: selected === '100' ? 11 : 22 }))
  setState(db, 'session_open_guard_json', JSON.stringify({ on: true, windowMin: 30, minR: .3 }))
  resetSessionOpenGuardMemory(); invalidateSidecarSession()
  const f = { rows: [], requests: [], quotes: [], notices: [], actions: [], snapshots: new Map(),
    mid: new Map([['100', 102], ['200', 100.5]]), now: NOW, quoteHook: null, snapshotHook: null, amendHook: null, reply: null }
  active = f
  f.ws = {
    wsGetSpotOnce: async (host, _id, _secret, _token, account, symbolId) => {
      f.quotes.push({ host, account: String(account), symbolId: Number(symbolId) })
      await f.quoteHook?.(String(account))
      const mid = f.mid.get(String(account))
      return mid == null ? null : { bid: mid - .01, ask: mid + .01 }
    },
    wsGetSymbolsList: async () => ({ symbol: [] }),
  }
  f.add = (account = '100', opts = {}) => {
    const side = opts.side ?? 'BUY', entry = 100, short = isShort(side)
    const sl = Object.hasOwn(opts, 'sl') ? opts.sl : short ? 105 : 95
    const tp = Object.hasOwn(opts, 'tp') ? opts.tp : short ? 90 : 110
    const positionId = Object.hasOwn(opts, 'positionId') ? opts.positionId : ++nextPosition
    const tradeId = Number(db.prepare(`INSERT INTO trades(symbol,side,entry_price,volume,status,account_id,ctrader_position_id,strategy,source)
      VALUES('EURUSD',?,100,.01,'open',?,?,'fib_618_fade',?)`).run(side, account, positionId == null ? null : String(positionId), opts.source ?? 'autopilot').lastInsertRowid)
    const id = Number(db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,current_sl,current_tp,initial_risk,be_moved,status,source,strategy,account_id,paused)
      VALUES('EURUSD',?,?,100,?,?,5,0,'active',?,'fib_618_fade',?,?)`).run(tradeId, side, sl, tp, opts.source ?? 'autopilot', account, opts.paused ?? 0).lastInsertRowid)
    const row = { id, tradeId, account, positionId, sl, tp, side }
    f.rows.push(row)
    const bp = { positionId, ctidTraderAccountId: Number(account), price: entry, stopLoss: sl, takeProfit: tp,
      tradeData: { symbolId: account === '100' ? 11 : 22, tradeSide: short ? 2 : 1, volume: 1000 }, positionStatus: 1 }
    if (!f.snapshots.has(account)) f.snapshots.set(account, { ctidTraderAccountId: Number(account), position: [] })
    f.snapshots.get(account).position.push(bp)
    row.broker = bp
    return row
  }
  f.run = () => runSessionOpenGuard(db, getCtraderCreds(db), { now: () => f.now, ws: f.ws, notify: text => f.notices.push(text) })
  return f
}
globalThis.fetch = async (rawUrl, options = {}) => {
  const url = new URL(rawUrl), f = active
  assert.ok(['guard-demo.invalid', 'guard-live.invalid'].includes(url.hostname), 'no external endpoint is permitted')
  const body = options.body ? JSON.parse(options.body) : null
  f.requests.push({ host: url.hostname, path: url.pathname, body })
  let value
  if (url.pathname === '/connect') value = { ok: true }
  else if (url.pathname === '/positions') {
    const account = String(body.ctidTraderAccountId)
    await f.snapshotHook?.(account)
    value = f.snapshots.get(account) ?? { ctidTraderAccountId: Number(account), position: [] }
  } else if (url.pathname === '/amend') {
    await f.amendHook?.(body)
    value = f.reply ? await f.reply(body) : moved(f, body)
    if (value?.transportError) return new Response(JSON.stringify({ errorCode: value.transportError }), { status: 502 })
    if (value?.emptyResponse) return new Response('', { status: 200 })
  } else throw new Error(`unexpected sidecar route ${url.pathname}`)
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}
function moved(f, body, patch = {}) {
  const row = f.rows.find(r => String(r.positionId) === String(body.positionId) && r.account === String(body.ctidTraderAccountId))
  assert.ok(row, 'amend belongs to an actual fixture position')
  const proof = { v: 1, source: 'broker_reconcile', confirmation: 'amend_readback', accountId: Number(row.account),
    positionId: row.positionId, symbolId: row.broker.tradeData.symbolId, direction: isShort(row.side) ? -1 : 1,
    entryPrice: 100, beforeStopLoss: row.broker.stopLoss, afterStopLoss: body.stopLoss, stopMoved: row.broker.stopLoss != null,
    beforeCheckedAtMs: Date.now() - 2, afterCheckedAtMs: Date.now(), ...patch }
  return { unchanged: false, protection: { verified: true, source: 'broker_reconcile', confirmation: 'amend_readback',
    stopLoss: proof.afterStopLoss, takeProfit: body.takeProfit, checkedAtMs: proof.afterCheckedAtMs,
    readStartedAtMs: proof.afterCheckedAtMs, readDurationMs: 0, movement: proof },
    policy: { applied: true, readback: 'confirmed', refused: null, skipped: null } }
}
const amends = f => f.requests.filter(r => r.path === '/amend')
const stored = row => db.prepare('SELECT * FROM monitored_positions WHERE id=?').get(row.id)
const events = row => db.prepare("SELECT * FROM position_events WHERE trade_id=? AND kind='sl_moved'").all(row.tradeId)
function untouched(f, row) {
  assert.equal(stored(row).current_sl, row.sl)
  assert.notEqual(stored(row).last_check_action, 'GUARD:BE')
  assert.deepEqual(events(row), [])
  assert.equal(f.notices.length, 0)
}

test('both selections and same-host accounts use each account quote, snapshot and ratchet transaction', async () => {
  for (const selected of ['100', '200']) for (const bothDemo of [false, true]) for (const side of ['BUY', 'SELL']) {
    const f = fixture({ selected, bothDemo }), a = f.add('100', { side }), b = f.add('200', { side })
    if (side === 'SELL') { f.mid.set('100', 98); f.mid.set('200', 99.5) }
    const out = await f.run()
    assert.equal(out.locked, 1, `only above-threshold owner A, selected=${selected} sameHost=${bothDemo} side=${side}`)
    assert.deepEqual(f.quotes.map(q => [q.account, q.symbolId]), [['100', 11], ['200', 22]])
    assert.equal(f.requests.filter(r => r.path === '/positions').length, 2)
    assert.equal(amends(f).length, 1)
    const request = amends(f)[0]
    assert.equal(request.host, 'guard-demo.invalid')
    assert.equal(request.body.ctidTraderAccountId, 100)
    assert.equal(request.body.positionId, a.positionId)
    assert.equal(request.body.ratchetOnly, true)
    assert.equal(request.body.expectedSymbolId, 11)
    assert.equal(request.body.expectedDirection, side === 'SELL' ? -1 : 1)
    assert.equal(request.body.takeProfit, a.tp)
    assert.equal(request.body.stopLossTriggerMethod, 2)
    assert.equal(stored(a).current_sl, 100); assert.equal(stored(a).last_check_action, 'GUARD:BE')
    assert.equal(events(a).length, 1); assert.equal(f.notices.length, 1)
    assert.equal(events(a)[0].account_id, '100'); assert.equal(events(a)[0].position_id, String(a.positionId))
    assert.equal(events(a)[0].source, 'session_open_guard')
    assert.equal(stored(b).current_sl, b.sl); assert.equal(events(b).length, 0)
    assert.equal((await f.run()).locked, 0); assert.equal(amends(f).length, 1, 'successful guard does not resend in the same session')
  }
})

test('stored side aliases use their verified broker direction for profit and tightening', async () => {
  for (const side of ['SHORT', 'sell', 'long', 'buy']) {
    const f = fixture(), r = f.add('100', { side })
    f.mid.set('100', isShort(side) ? 98 : 102)
    assert.equal((await f.run()).locked, 1, side)
    assert.equal(amends(f)[0].body.expectedDirection, isShort(side) ? -1 : 1)
    assert.equal(amends(f)[0].body.stopLoss, 100)
    assert.equal(stored(r).current_sl, 100); assert.equal(events(r).length, 1)
  }
})

test('one account snapshot serves multiple eligible rows, including genuine naked-stop installation', async () => {
  const f = fixture(), a = f.add(), b = f.add('100', { sl: null })
  const out = await f.run()
  assert.equal(out.locked, 2)
  assert.equal(f.requests.filter(r => r.path === '/positions').length, 1)
  assert.equal(events(a).length, 1); assert.equal(events(b).length, 1)
  assert.equal(events(b)[0].from_value, null)
  assert.equal(stored(b).current_sl, 100)
})

test('unknown account, unavailable owned map, missing position and contradictory stored identity refuse before amend', async () => {
  const changes = [
    (f, r) => db.prepare('DELETE FROM accounts WHERE account_id=?').run(r.account),
    () => setState(db, accountSymbolMapKey('100'), JSON.stringify({ accountId: '100', builtAt: new Date().toISOString(), map: {} })),
    (f, r) => db.prepare('UPDATE trades SET ctrader_position_id=NULL WHERE id=?').run(r.tradeId),
    (f, r) => db.prepare("UPDATE trades SET account_id='200' WHERE id=?").run(r.tradeId),
    (f, r) => db.prepare("UPDATE trades SET symbol='GBPUSD' WHERE id=?").run(r.tradeId),
    (f, r) => db.prepare("UPDATE trades SET side='SELL' WHERE id=?").run(r.tradeId),
    (f, r) => db.prepare('UPDATE trades SET entry_price=101 WHERE id=?').run(r.tradeId),
    (f, r) => db.prepare("UPDATE trades SET status='closed' WHERE id=?").run(r.tradeId),
  ]
  for (const change of changes) {
    const f = fixture(), r = f.add(); change(f, r)
    assert.equal((await f.run()).locked, 0)
    assert.equal(amends(f).length, 0); untouched(f, r)
  }
})

test('foreign, missing, duplicate and conflicting broker snapshots refuse; a later valid read may retry', async () => {
  const changes = [
    rec => { rec.ctidTraderAccountId = 200 },
    rec => { rec.position = [] },
    rec => { rec.position.push(structuredClone(rec.position[0])) },
    rec => { rec.position[0].ctidTraderAccountId = 200 },
    rec => { rec.position[0].tradeData.symbolId = 22 },
    rec => { rec.position[0].tradeData.tradeSide = 2 },
    rec => { rec.position[0].price = 101 },
    rec => { delete rec.position[0].tradeData.symbolId },
  ]
  for (const change of changes) {
    const f = fixture(), r = f.add(), original = structuredClone(f.snapshots.get('100'))
    change(f.snapshots.get('100'))
    assert.equal((await f.run()).locked, 0); assert.equal(amends(f).length, 0); untouched(f, r)
    f.snapshots.set('100', original)
    r.broker = original.position[0]
    assert.equal((await f.run()).locked, 1, 'refused evidence must not consume the session latch')
    assert.equal(events(r).length, 1)
  }
})

test('account ownership changes during quote await and execution reply are not misattributed or journalled', async () => {
  for (const boundary of ['quote', 'reply']) {
    const f = fixture(), r = f.add()
    const change = () => db.prepare("UPDATE trades SET account_id='200' WHERE id=?").run(r.tradeId)
    if (boundary === 'quote') f.quoteHook = change
    else f.amendHook = change
    assert.equal((await f.run()).locked, 0)
    if (boundary === 'quote') assert.equal(amends(f).length, 0)
    untouched(f, r)
  }
})

test('long and short intervening tighter stops are held without a movement journal, success count or notice', async () => {
  for (const side of ['BUY', 'SELL']) {
    const f = fixture(), r = f.add('100', { side }), held = side === 'SELL' ? 99 : 101
    if (side === 'SELL') f.mid.set('100', 98)
    f.reply = body => {
      const answer = moved(f, body, { beforeStopLoss: held, afterStopLoss: held, stopMoved: false,
        confirmation: 'already_tighter_snapshot' })
      answer.unchanged = true; answer.protection.confirmation = 'already_tighter_snapshot'
      return answer
    }
    assert.equal((await f.run()).locked, 0)
    assert.equal(amends(f)[0].body.ratchetOnly, true)
    assert.equal(stored(r).current_sl, held, 'owned verified held snapshot may correct the mirror')
    assert.notEqual(stored(r).last_check_action, 'GUARD:BE')
    assert.deepEqual(events(r), []); assert.deepEqual(f.notices, [])
  }
})

test('closed, error, empty, policy-only, malformed and foreign responses cannot manufacture a stop movement', async () => {
  const replies = [
    () => null,
    () => ({ emptyResponse: true }),
    () => ({ alreadyClosed: true }),
    () => ({ transportError: 'guard_ratchet_identity' }),
    () => ({}),
    (f, body) => ({ protection: { verified: true, stopLoss: body.stopLoss }, policy: { applied: true, readback: 'confirmed' } }),
    (f, body) => moved(f, body, { stopMoved: false }),
    (f, body) => moved(f, body, { accountId: 200 }),
    (f, body) => moved(f, body, { positionId: body.positionId + 1 }),
    (f, body) => moved(f, body, { symbolId: 22 }),
    (f, body) => moved(f, body, { direction: -1 }),
    (f, body) => moved(f, body, { entryPrice: 101 }),
    (f, body) => moved(f, body, { beforeCheckedAtMs: Date.now() + 5000, afterCheckedAtMs: Date.now() }),
    (f, body) => moved(f, body, { afterStopLoss: 99 }),
    (f, body) => { const result = moved(f, body); delete result.protection.movement; return result },
    () => ({ unchanged: true, protection: { stopLoss: 101 } }),
  ]
  for (const reply of replies) {
    const f = fixture(), r = f.add(); f.reply = body => reply(f, body)
    assert.equal((await f.run()).locked, 0)
    assert.equal(amends(f).length, 1); untouched(f, r)
    f.reply = null
    assert.equal((await f.run()).locked, 1, 'uncertain or skipped result must not consume the session latch')
    assert.equal(events(r).length, 1)
  }
})

test('a real SQLite journal failure rolls the stop mirror back and cannot announce a successful guard', async () => {
  const f = fixture(), r = f.add()
  db.exec(`CREATE TEMP TRIGGER session_guard_journal_failure BEFORE INSERT ON position_events
    WHEN NEW.source='session_open_guard' BEGIN SELECT RAISE(ABORT, 'controlled journal failure'); END`)
  try {
    assert.equal((await f.run()).locked, 0)
    assert.equal(amends(f).length, 1, 'the controlled broker boundary returned a genuine movement')
    untouched(f, r)
  } finally { db.exec('DROP TRIGGER session_guard_journal_failure') }
})

test('external, paused, disabled guard and outside-window controls preserve their prior exclusions', async () => {
  for (const mode of ['external', 'paused', 'off', 'outside']) {
    const f = fixture(), r = f.add('100', mode === 'external' ? { source: 'external' } : mode === 'paused' ? { paused: 1 } : {})
    if (mode === 'off') setState(db, 'session_open_guard_json', '{"on":false}')
    if (mode === 'outside') f.now = Date.UTC(2026, 9, 9, 18, 59)
    await f.run()
    assert.deepEqual(f.requests, []); assert.deepEqual(f.quotes, []); untouched(f, r)
  }
})
