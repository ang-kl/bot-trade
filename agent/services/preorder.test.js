// Claude · № 12,955 10-Oct (ordered № 12,954; claude-builder)
// node --test agent/services/preorder.test.js
//
// The pre-order dry run (services/preorder.js, GET /state/preorder):
//   1. READ-ONLY, by behaviour: through the real route, the database's
//      total_changes() and the row counts of risk_events, trades,
//      entry_intents, action_log and decision_log do not move, no write
//      statement is even prepared, and the broker transports see only reads
//      (the fake broker socket records every request; the execution sidecar
//      is pointed at a recording fetch) — so no order, amend or close.
//   2. EQUIVALENCE with the gate: for approved, bad_rr, max_positions and
//      margin-share fixtures, the dry run's verdict is evaluateTrade's on the
//      same state, for an independently written proposal.
//   3. THE REAL PATHS: the proposal the dry run builds is the one the real
//      loop.js autoTrade, closed-market-limits placeClosedMarketLimit and
//      POST /actions/manual-order persist to risk_events on the same state.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import express from 'express'
import { initDB, setState } from '../db.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { recordMarketCalendar } from './market-calendar.js'
import { _resetEntryHoursRefresh } from './entry-hours.js'
import { evaluateTrade, loadRiskConfig } from './risk.js'
import { PT, _setWebSocketForTests } from '../lib/ctrader-ws.js'
import stateRouter from '../routes/state.js'
import actionsRouter from '../routes/actions.js'
import { preorderCheck, EXPECTED_R_NOT_COMPUTED, PREORDER_MANUAL_PARAMS } from './preorder.js'

const A = '4242', B = '4343'
const SYM = 'EURUSD', SYM_ID = 1
const HOST = 'demo.ctraderapi.com'
const WEEK = 7 * 86400

// ---- fixtures ---------------------------------------------------------------

function fresh({ accounts = [A] } = {}) {
  const db = initDB(':memory:')
  _resetEntryHoursRefresh()
  for (const id of accounts) {
    db.prepare("INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')").run(id, id)
    setState(db, `acct:${id}:account_balance_usd`, '10000')
    setState(db, accountSymbolMapKey(id), JSON.stringify({ builtAt: new Date().toISOString(), accountId: id, map: { [SYM]: SYM_ID } }))
    // Open every second of the week on the account's own calendar.
    recordMarketCalendar(db, { host: HOST, accountId: id, symbolId: String(SYM_ID) },
      { symbolId: SYM_ID, scheduleTimeZone: 'UTC', tradingMode: 0, schedule: [{ startSecond: 0, endSecond: WEEK }], holiday: [] }, { nowMs: Date.now() })
  }
  setState(db, 'ctrader_account_id', accounts[0])
  setState(db, 'ctrader_access_token', 't')
  setState(db, 'autotrade_enabled', 'true')
  setState(db, 'evidence_gate_json', JSON.stringify({ on: false }))
  setState(db, 'autopilot_symbols_json', JSON.stringify([{ symbol: SYM, enabled: true, maxVolume: 0.3 }]))
  return db
}

/** One scan row plus the retained batch the dispatcher reads (last_scan_results). */
function seedScan(db, { tf = '1h', bias = 'long', entry = 1.1, sl = 1.09, tp1 = 1.135, conviction = 9, strategy = 'ema_pullback' } = {}) {
  const at = new Date().toISOString()
  const sig = {
    symbol: SYM, strategy, timeframe: tf, bias, conviction, entry, sl, tp1, tp2: Number((tp1 + (tp1 - entry)).toFixed(5)),
    rr: Math.round((Math.abs(tp1 - entry) / Math.abs(entry - sl)) * 100) / 100,
    thesis: 'fixture', direction_reason: 'fixture:pullback', time_cap_minutes: 240, level618: entry, swingA: sl,
  }
  const id = Number(db.prepare('INSERT INTO scans (symbol, bias, confidence, thesis, timeframe, strategy, price, scanned_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(SYM, bias, conviction, 'fixture', tf, strategy, entry, at).lastInsertRowid)
  setState(db, 'last_scan_at', at)
  setState(db, 'last_scan_results', JSON.stringify({
    scans: [{ symbol: SYM, bias, confidence: conviction, strategy, timeframe: tf, price: entry }],
    signals: { [SYM]: sig }, signalsByStrategy: { [SYM]: { [strategy]: sig } },
  }))
  return { id, sig, at }
}

function fillBook(db, n, accountId = A) {
  for (let i = 0; i < n; i++) {
    db.prepare("INSERT INTO monitored_positions (symbol, side, entry_price, status, account_id) VALUES (?, 'long', 100, 'active', ?)").run(`FILL${i}`, accountId)
  }
}

async function withCreds(fn) {
  const saved = { id: process.env.CTRADER_CLIENT_ID, secret: process.env.CTRADER_CLIENT_SECRET }
  process.env.CTRADER_CLIENT_ID = 'c'; process.env.CTRADER_CLIENT_SECRET = 's'
  try { return await fn() } finally {
    if (saved.id === undefined) delete process.env.CTRADER_CLIENT_ID; else process.env.CTRADER_CLIENT_ID = saved.id
    if (saved.secret === undefined) delete process.env.CTRADER_CLIENT_SECRET; else process.env.CTRADER_CLIENT_SECRET = saved.secret
  }
}

/**
 * A broker socket that answers auth and trendbar reads, and RECORDS every
 * request type it is sent. Anything else (an order, an amend, a close) is
 * recorded and never answered.
 */
function fakeBroker(close = 1.1) {
  const sent = []
  class Socket extends EventEmitter {
    constructor() { super(); this.readyState = 1; setImmediate(() => this.emit('open')) }
    send(raw) {
      const m = JSON.parse(raw)
      if (m.payloadType === PT.HEARTBEAT) return
      sent.push(m.payloadType)
      const minute = Math.floor(Date.now() / 60_000)
      const answer = {
        [PT.APP_AUTH_REQ]: [PT.APP_AUTH_RES, {}],
        [PT.ACCOUNT_AUTH_REQ]: [PT.ACCOUNT_AUTH_RES, { ctidTraderAccountId: m.payload?.ctidTraderAccountId }],
        [PT.GET_TRENDBARS_REQ]: [PT.GET_TRENDBARS_RES, {
          ctidTraderAccountId: m.payload?.ctidTraderAccountId, symbolId: m.payload?.symbolId, period: m.payload?.period,
          trendbar: [{ low: Math.round(close * 100_000) - 50, deltaOpen: 0, deltaHigh: 60, deltaClose: 50, utcTimestampInMinutes: minute - 1, volume: 1 }],
        }],
        // № 13,172: the route reads the symbol's lot record BEFORE its gate
        // (an FX-shaped answer: 100,000 units a lot, 0.01-lot minimum and step)
        [PT.SYMBOL_BY_ID_REQ]: [PT.SYMBOL_BY_ID_RES, {
          ctidTraderAccountId: m.payload?.ctidTraderAccountId,
          symbol: [].concat(m.payload?.symbolId ?? []).map(id => ({ symbolId: id, lotSize: 10_000_000, minVolume: 100_000, maxVolume: 100_000_000_000, stepVolume: 100_000, digits: 5, pipPosition: 4 })),
        }],
      }[m.payloadType]
      if (!answer) return
      setImmediate(() => this.emit('message', Buffer.from(JSON.stringify({ payloadType: answer[0], payload: answer[1], clientMsgId: m.clientMsgId }))))
    }
    close() { this.readyState = 3 }
  }
  return { Socket, sent }
}

async function serve(db) {
  const app = express(); app.use(express.json()); app.use('/state', stateRouter(db)); app.use('/actions', actionsRouter(db))
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  return { base, close: () => new Promise(r => server.close(r)) }
}

const counts = (db) => Object.fromEntries(['risk_events', 'trades', 'entry_intents', 'action_log', 'decision_log']
  .map(t => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]))
const totalChanges = (db) => db.prepare('SELECT total_changes() AS n').get().n

/** Record every write statement prepared or executed on `db` while armed. */
function trapWrites(db) {
  const seen = []
  const prep = db.prepare.bind(db), exec = db.exec.bind(db)
  db.prepare = (sql) => { if (/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(String(sql))) seen.push(String(sql).trim().slice(0, 90)); return prep(sql) }
  db.exec = (sql) => { seen.push(`exec: ${String(sql).trim().slice(0, 90)}`); return exec(sql) }
  return { seen, restore: () => { delete db.prepare; delete db.exec } }
}

/** A recording fetch: the test's own server passes, anything else (the execution sidecar) is recorded and refused. */
function trapFetch(base) {
  const realFetch = globalThis.fetch
  const outbound = []
  globalThis.fetch = (url, init) => {
    if (String(url).startsWith(base)) return realFetch(url, init)
    outbound.push(String(url))
    return Promise.reject(new Error('outbound fetch refused by the read-only test'))
  }
  return { outbound, restore: () => { globalThis.fetch = realFetch } }
}

// ---- 1. read-only -------------------------------------------------------------

test('read-only: GET /state/preorder (scan and manual) writes nothing and sends no order, amend or close', async (t) => {
  const db = fresh(); t.after(() => db.close())
  const { id } = seedScan(db)
  fillBook(db, 2)
  const broker = fakeBroker(1.1)
  _setWebSocketForTests(broker.Socket); t.after(() => _setWebSocketForTests(null))
  const savedExec = process.env.EXEC_URL
  process.env.EXEC_URL = 'http://exec.invalid:9'
  t.after(() => { if (savedExec === undefined) delete process.env.EXEC_URL; else process.env.EXEC_URL = savedExec })
  const srv = await serve(db); t.after(srv.close)
  const net = trapFetch(srv.base); t.after(net.restore)

  const before = { changes: totalChanges(db), counts: counts(db) }
  const trap = trapWrites(db)
  let scan, manual
  try {
    scan = await withCreds(() => fetch(`${srv.base}/state/preorder?scanId=${id}&account=${A}`).then(r => r.json()))
    manual = await withCreds(() => fetch(`${srv.base}/state/preorder?account=${A}&symbol=${SYM}&side=BUY&lots=0.2&sl=1.09&tp=1.135`).then(r => r.json()))
  } finally { trap.restore() }

  assert.equal(scan.ok, true, JSON.stringify(scan).slice(0, 300))
  assert.equal(manual.ok, true, JSON.stringify(manual).slice(0, 300))
  assert.equal(scan.gate.approved, true, scan.gate.vetoReason)
  assert.equal(manual.gate.approved, true, manual.gate.vetoReason)
  assert.equal(manual.proposal.entry, 1.1, 'the entry is the broker 1m close, read through the same helper')
  assert.deepEqual(trap.seen, [], 'no write statement was prepared or executed')
  assert.equal(totalChanges(db), before.changes, 'total_changes() did not move')
  assert.deepEqual(counts(db), before.counts, 'risk_events, trades, entry_intents, action_log and decision_log are unchanged')
  const orderish = broker.sent.filter(p => ![PT.APP_AUTH_REQ, PT.ACCOUNT_AUTH_REQ, PT.GET_TRENDBARS_REQ].includes(p))
  assert.deepEqual(orderish, [], 'the broker socket saw reads only — no order, amend or close request')
  assert.ok(broker.sent.includes(PT.GET_TRENDBARS_REQ), 'the manual dry run did read the 1m close')
  assert.deepEqual(net.outbound, [], 'nothing reached the execution sidecar')
})

test('unknown or repeated query parameters are a 400, never ignored; scan-only and manual-only sets are separate', async (t) => {
  const db = fresh(); t.after(() => db.close())
  const { id } = seedScan(db)
  const srv = await serve(db); t.after(srv.close)
  const get = (q) => fetch(`${srv.base}/state/preorder${q}`).then(async r => ({ status: r.status, body: await r.json(), cache: r.headers.get('cache-control'), xcache: r.headers.get('x-cache') }))
  const bad1 = await get(`?scanId=${id}&accountId=${A}`)
  assert.equal(bad1.status, 400); assert.deepEqual(bad1.body.unsupported, ['accountId'])
  const bad2 = await get(`?scanId=${id}&symbol=${SYM}`)
  assert.equal(bad2.status, 400, 'a manual field on a scan check is refused'); assert.deepEqual(bad2.body.unsupported, ['symbol'])
  // № 13,137: `strategy` is a manual field now (the pad's key); a scan-only
  // field on a manual check is still refused
  const bad3 = await get(`?symbol=${SYM}&side=BUY&sl=1.09&conviction=9`)
  assert.equal(bad3.status, 400); assert.deepEqual(bad3.body.unsupported, ['conviction'])
  const bad4 = await get(`?scanId=${id}&scanId=${id}`)
  assert.equal(bad4.status, 400, 'a repeated parameter is refused')
  assert.equal((await get('?scanId=999999')).status, 404)
  assert.equal((await get('?scanId=abc')).status, 400)
  assert.equal((await get(`?symbol=${SYM}&side=HOLD&sl=1.09`)).status, 400, "the route's own side validation")
  assert.equal((await get(`?symbol=${SYM}&side=BUY`)).status, 400, 'no stop, no check — as the route refuses an order')
  assert.equal((await get(`?account=999&symbol=${SYM}&side=BUY&sl=1.09`)).status, 400, 'an unregistered account is refused, never routed to the primary')
  const ok = await withCreds(() => get(`?scanId=${id}&account=${A}`))
  assert.equal(ok.status, 200)
  assert.equal(ok.cache, 'no-store')
  assert.notEqual(ok.xcache, 'hit', 'the route cache never serves it')
  const again = await withCreds(() => get(`?scanId=${id}&account=${A}`))
  assert.notEqual(again.xcache, 'hit', 'never cached: a second identical request is computed again')
})

test('missing credentials and missing data say "cannot check" with the reason — never a guessed answer', async (t) => {
  const db = fresh(); t.after(() => db.close())
  // No client id/secret in the environment → not ready.
  const saved = { id: process.env.CTRADER_CLIENT_ID, secret: process.env.CTRADER_CLIENT_SECRET }
  delete process.env.CTRADER_CLIENT_ID; delete process.env.CTRADER_CLIENT_SECRET
  t.after(() => { if (saved.id !== undefined) process.env.CTRADER_CLIENT_ID = saved.id; if (saved.secret !== undefined) process.env.CTRADER_CLIENT_SECRET = saved.secret })
  let fetched = 0
  const r = await preorderCheck(db, { account: A, symbol: SYM, side: 'BUY', sl: 1.09, tp: 1.135 }, { fetchEntry: async () => { fetched++; return 1.1 } })
  assert.equal(r.ok, false)
  assert.equal(r.cannotCheck, 'cannot check: cTrader credentials not configured')
  assert.equal(fetched, 0, 'no broker read without credentials')
  await withCreds(async () => {
    const nobars = await preorderCheck(db, { account: A, symbol: SYM, side: 'BUY', sl: 1.09 }, { fetchEntry: async () => null })
    assert.equal(nobars.cannotCheck, `cannot check: could not fetch a current price for ${SYM}`)
    const thrown = await preorderCheck(db, { account: A, symbol: SYM, side: 'BUY', sl: 1.09 }, { fetchEntry: async () => { throw new Error('timeout') } })
    assert.match(thrown.cannotCheck, /^cannot check: could not fetch a current price for EURUSD \(timeout\)$/)
    const unknownSym = await preorderCheck(db, { account: A, symbol: 'NOPE', side: 'BUY', sl: 1.09 }, { fetchEntry: async () => 1 })
    assert.match(unknownSym.cannotCheck, /^cannot check: symbol_not_on_account: NOPE/)
  })
  // A scan row whose levels are not retained (not the current batch, no analysis).
  const old = Number(db.prepare("INSERT INTO scans (symbol, bias, confidence, timeframe, strategy, price, scanned_at) VALUES (?, 'long', 9, '1h', 'ema_pullback', 1.1, '2026-01-01T00:00:00.000Z')").run(SYM).lastInsertRowid)
  const gone = await preorderCheck(db, { scanId: old, account: A })
  assert.match(gone.cannotCheck, /levels of scan \d+ are not retained/)
  const flat = Number(db.prepare("INSERT INTO scans (symbol, bias, confidence, timeframe, strategy, price, scanned_at) VALUES (?, 'skip', 0, NULL, NULL, 1.1, '2026-01-01T00:00:00.000Z')").run(SYM).lastInsertRowid)
  assert.match((await preorderCheck(db, { scanId: flat, account: A })).cannotCheck, /not a directional signal/)
})

// Claude · № 13,172 11-Oct: the route records the broker's lot record before
// its gate; this read-only dry run cannot, so it says what is on file, whose
// it is, and whether the route will size the same. Codex P2s on #1318: the
// record is read from the registry (not from checks the gate never filled),
// and equivalence is claimed only for the selected account's own record.
test('manual: the dry run names the lot record on file, whose it is, and whether the route will size the same', async (t) => {
  const db = fresh({ accounts: [A, B] }); t.after(() => db.close())
  const input = { account: A, symbol: SYM, side: 'BUY', sl: 1.09, tp: 1.135 }
  const check = (i = input) => withCreds(() => preorderCheck(db, i, { fetchEntry: async () => 1.1 }))
  const bare = await check()
  assert.equal(bare.ok, true, bare.cannotCheck || bare.error)
  assert.equal(bare.lotRecord.stored, 'table')
  assert.equal(bare.lotRecord.sizedAsRoute, false)
  assert.equal(bare.lotRecord.brokerMinLots, null)
  assert.equal(bare.lotRecord.recordAccount, null)
  assert.equal(bare.lotRecord.consultedByGate, true, 'this proposal reached sizing')
  assert.match(bare.lotRecord.note, /no broker lot record on file for EURUSD/)
  assert.match(bare.lotRecord.note, new RegExp(`for account ${A} before its gate`))
  const { rememberVolumeMeta } = await import('../lib/lot-size-registry.js')
  // another account's record: on file, read by the gate, but not this account's provenance
  rememberVolumeMeta(db, SYM, { lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, accountId: B })
  const theirs = await check()
  // rounds 8 and 14: another account's lot is not this account's, and not the table either — unknown
  assert.equal(theirs.lotRecord.stored, 'foreign_unknown')
  assert.equal(theirs.lotRecord.unitsPerLot, null)
  assert.match(theirs.gate.vetoReason, /^lot_record_unknown: EURUSD/, 'the gate refuses by name rather than sizing on the table')
  assert.equal(theirs.lotRecord.brokerMinLots, null, 'another account\'s minimum is never this account\'s (Codex P2, round 7)')
  assert.equal(theirs.lotRecord.recordAccount, B)
  assert.equal(theirs.lotRecord.sizedAsRoute, false, 'another account wrote it')
  assert.match(theirs.lotRecord.note, new RegExp(`written by account ${B}; POST /actions/manual-order refreshes it from account ${A}`))
  // the same values written by this account: the route's own basis
  rememberVolumeMeta(db, SYM, { lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, accountId: A })
  const own = await check()
  assert.equal(own.lotRecord.recordAccount, A)
  assert.equal(own.lotRecord.sizedAsRoute, true)
  assert.match(own.lotRecord.note, new RegExp(`account ${A}'s own recorded units.*as the route will$`))
  // a record from before the stamp existed is provenance unknown, not this account's
  const { setState: set, getState: get } = await import('../db.js')
  const { LOT_SIZE_KEY, LOT_SIZE_BY_ACCOUNT_KEY } = await import('../lib/lot-size-registry.js')
  set(db, LOT_SIZE_BY_ACCOUNT_KEY, '{}') // no account's own record, only the shared legacy one
  set(db, LOT_SIZE_KEY, JSON.stringify({ [SYM]: { lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000 } }))
  const legacy = await check()
  assert.equal(legacy.lotRecord.stored, 'broker')
  assert.equal(legacy.lotRecord.recordAccount, null)
  assert.equal(legacy.lotRecord.sizedAsRoute, false)
  assert.match(legacy.lotRecord.note, /written before records carried an account/)
  assert.ok(get(db, LOT_SIZE_KEY), 'the dry run wrote nothing to the registry')
  // the gate refusing BEFORE it reads the lot record (max_positions) does not erase the record on file
  rememberVolumeMeta(db, SYM, { lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000, accountId: A })
  fillBook(db, 5)
  const early = await check()
  assert.equal(early.gate.approved, false)
  assert.match(early.gate.vetoReason, /max_positions/)
  assert.equal('units_per_lot' in early.checks, false, 'the gate never reached sizing')
  assert.equal(early.lotRecord.stored, 'broker')
  assert.equal(early.lotRecord.consultedByGate, false)
  assert.equal(early.lotRecord.sizedAsRoute, true)
  assert.match(early.lotRecord.note, /the gate refused before sizing; this is what it would have read/)
  // Codex P2 on #1318, round 11: scan checks carry the same disclosure — the
  // order path fetches the account's own record before its gate when it has none
  const { id } = seedScan(db)
  const scan = await withCreds(() => preorderCheck(db, { scanId: id, account: A }))
  assert.equal(scan.lotRecord.recordAccount, A)
  assert.equal(scan.lotRecord.sizedAsRoute, true)
  set(db, LOT_SIZE_BY_ACCOUNT_KEY, '{}'); set(db, LOT_SIZE_KEY, '{}') // no record of A's own anywhere
  const scanBare = await withCreds(() => preorderCheck(db, { scanId: id, account: A }))
  assert.equal(scanBare.lotRecord.sizedAsRoute, false)
  assert.match(scanBare.lotRecord.note, /the order path refreshes it from account 4242's own broker answer before its gate|the order path records the broker's lot size and minimum for account 4242 before its gate/)
  assert.ok(scanBare.notChecked.some(x => /lot-record fetch before the gate/.test(x)))
  assert.equal(scanBare.notChecked.some(x => /after approval/.test(x)), false)
})

// Codex P1 on #1318: recording the broker minimum before the gate must not
// turn a typed 0.001-lot request into a 0.01-lot order. The route refuses it
// before the gate; the dry run mirrors that from the record on file.
test('manual: a TYPED lots below the broker minimum is refused by the route before the gate, and the dry run says the same once the record is on file', async (t) => {
  const db = fresh(); t.after(() => db.close())
  const broker = fakeBroker(1.1)
  _setWebSocketForTests(broker.Socket); t.after(() => _setWebSocketForTests(null))
  const srv = await serve(db); t.after(srv.close)
  const post = (body) => withCreds(() => fetch(`${srv.base}/actions/manual-order`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(r => r.json()))
  const tiny = { account: A, symbol: SYM, side: 'BUY', lots: 0.001, sl: 1.09, tp: 1.135 }
  const res = await post(tiny)
  assert.equal(res.vetoed, true, JSON.stringify(res).slice(0, 300))
  assert.equal(res.reason, 'below_min_volume: 0.001 lots < broker minimum (0.01 lots)')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 0, 'no order was sent')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_events WHERE approved = 0').get().n, 1, 'the refusal is on the record')
  // the route's fetch put the broker record on file for account A
  const { lotRecordFor } = await import('../lib/lot-size-registry.js')
  assert.equal(lotRecordFor(db, SYM, A)?.accountId, A, 'the route recorded A\'s own record')
  assert.equal(lotRecordFor(db, SYM), null, 'and left the shared slot alone (Codex P1, round 11)')
  // the dry run now reads the same refusal as its first block
  const dry = await withCreds(() => preorderCheck(db, tiny, { fetchEntry: async () => 1.1 }))
  assert.equal(dry.ok, true, dry.cannotCheck || dry.error)
  assert.equal(dry.approved, false)
  assert.deepEqual({ stage: dry.firstBlock.stage, reason: dry.firstBlock.reason }, { stage: 'broker_min_lot', reason: res.reason })
  // lots OMITTED: the default is floored at the broker minimum, not refused
  const omitted = await withCreds(() => preorderCheck(db, { account: A, symbol: SYM, side: 'BUY', sl: 1.09, tp: 1.135 }, { fetchEntry: async () => 1.1 }))
  assert.equal(omitted.firstBlock?.stage === 'broker_min_lot', false)
  assert.equal(omitted.gate.approved, true, omitted.gate.vetoReason)
  assert.equal(omitted.gate.adjustedVolume >= 0.01, true)
  // a typed lots AT the minimum passes this check
  const atMin = await withCreds(() => preorderCheck(db, { ...tiny, lots: 0.01 }, { fetchEntry: async () => 1.1 }))
  assert.equal(atMin.firstBlock?.stage === 'broker_min_lot', false)
  // Codex P2 on #1318, round 5 / P1 round 6: another account's minimum is
  // not this account's block, and this account's own record outranks it
  const { rememberVolumeMeta, LOT_SIZE_BY_ACCOUNT_KEY } = await import('../lib/lot-size-registry.js')
  rememberVolumeMeta(db, SYM, { lotSize: 10_000_000, minVolume: 1_000_000, stepVolume: 100_000, accountId: 'OTHER' }) // their minimum: 0.1 lots
  const ownWins = await withCreds(() => preorderCheck(db, { ...tiny, lots: 0.05 }, { fetchEntry: async () => 1.1 }))
  assert.equal(ownWins.firstBlock?.stage === 'broker_min_lot', false, 'A\'s own 0.01 minimum governs, not OTHER\'s 0.1')
  assert.equal(ownWins.lotRecord.recordAccount, A)
  assert.equal(ownWins.lotRecord.brokerMinLots, 0.01)
  assert.equal(ownWins.lotRecord.sizedAsRoute, true)
  // with no record of A's own, OTHER's shared minimum is reported but never blocks
  const { setState: set } = await import('../db.js')
  set(db, LOT_SIZE_BY_ACCOUNT_KEY, JSON.stringify({ OTHER: { [SYM]: { lotSize: 10_000_000, minVolume: 1_000_000, stepVolume: 100_000 } } }))
  const theirs = await withCreds(() => preorderCheck(db, { ...tiny, lots: 0.05 }, { fetchEntry: async () => 1.1 }))
  assert.equal(theirs.firstBlock?.stage === 'broker_min_lot', false, 'the route refreshes this account\'s own minimum and may permit 0.05')
  assert.equal(theirs.lotRecord.sizedAsRoute, false)
  assert.equal(theirs.lotRecord.recordAccount, 'OTHER')
})

// ---- 2. equivalence with the gate --------------------------------------------

/** The manual route's proposal, written out independently of preorder.js (actions.js:6415-6427). */
// Codex P1 on #1328 — Claude · № 13,496 12-Oct (claude-builder).
test('lot fix: a lots that is SUPPLIED but not a positive number is a 400 at the route and in the dry run — only a blank lots means risk-based sizing', async (t) => {
  const db = fresh(); t.after(() => db.close())
  const broker = fakeBroker(1.1)
  _setWebSocketForTests(broker.Socket); t.after(() => _setWebSocketForTests(null))
  const srv = await serve(db); t.after(srv.close)
  const post = (body) => withCreds(() => fetch(`${srv.base}/actions/manual-order`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then(async r => ({ status: r.status, body: await r.json() })))
  const base = { account: A, symbol: SYM, side: 'BUY', sl: 1.09, tp: 1.135 }
  for (const lots of [0, -1, 'abc', '0', '-0.5', true, 'NaN', 'Infinity', [0.1]]) {
    const res = await post({ ...base, lots })
    assert.equal(res.status, 400, `route, lots ${JSON.stringify(lots)}: ${JSON.stringify(res.body).slice(0, 200)}`)
    assert.match(res.body.error, /lots must be a positive number/)
    const dry = await withCreds(() => preorderCheck(db, { ...base, lots }, { fetchEntry: async () => 1.1 }))
    assert.deepEqual([dry.ok, dry.status], [false, 400], `dry run, lots ${JSON.stringify(lots)}`)
    assert.match(dry.error, /lots must be a positive number/)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_events').get().n, 0, 'refused before the gate: nothing judged')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM trades').get().n, 0, 'nothing sent')
  // Blank — omitted, null, empty or spaces — is risk-based sizing, not a 400.
  for (const lots of [undefined, null, '', '  ']) {
    const dry = await withCreds(() => preorderCheck(db, { ...base, ...(lots === undefined ? {} : { lots }) }, { fetchEntry: async () => 1.1 }))
    assert.equal(dry.ok, true, `blank ${JSON.stringify(lots)}: ${dry.error || dry.cannotCheck}`)
    assert.equal(dry.proposal?.requestedVolume ?? null, null)
  }
})

const routeProposal = ({ entry, sl, tp, lots, side = 'BUY', accountId = A }) => ({
  symbol: SYM, side, entry, sl: Number(sl), tp1: tp != null ? Number(tp) : null,
  // Claude · № 13,128 11-Oct: the route sends the pad's validated registry
  // key; with none given it is manual_order (MANUAL_ORDER_STRATEGY), as here.
  // Lot fix (Claude · № 13,396 12-Oct; claude-builder): nothing typed sends no cap.
  requestedVolume: Number(lots) > 0 ? Number(lots) : null, strategy: 'manual_order',
  direction_reason: side === 'SELL' ? 'manual:operator_chose_short' : 'manual:operator_chose_long',
  conviction: null, source: 'manual', accountId,
})

// Claude · № 13,137 11-Oct (Codex P2 on #1317, round 3): the dry run judges
// the same proposal the route will — a registry key on the input is the
// proposal's strategy, anything else is manual_order, and the endpoint's
// parameter list admits the field (a 400 there made the precheck judge a
// strategy order as manual while the real order was not).
test('manual: a registry strategy on the input is the proposal\'s strategy, and the endpoint accepts the parameter', async (t) => {
  const db = fresh(); t.after(() => db.close())
  const base = { account: A, symbol: SYM, side: 'BUY', sl: 1.09, tp: 1.135, lots: 0.2 }
  const keyed = await withCreds(() => preorderCheck(db, { ...base, strategy: 'vwap_trend' }, { fetchEntry: async () => 1.1 }))
  assert.equal(keyed.ok, true, keyed.cannotCheck || keyed.error)
  assert.equal(keyed.proposal.strategy, 'vwap_trend')
  const unknown = await withCreds(() => preorderCheck(db, { ...base, strategy: 'Not A Key' }, { fetchEntry: async () => 1.1 }))
  assert.equal(unknown.proposal.strategy, 'manual_order')
  assert.ok(PREORDER_MANUAL_PARAMS.includes('strategy') && PREORDER_MANUAL_PARAMS.includes('directionReason'))
})

const FIXTURES = [
  { name: 'approved', setup: () => {}, input: { sl: 1.09, tp: 1.135, lots: 0.2 }, expect: { approved: true } },
  { name: 'bad_rr', setup: () => {}, input: { sl: 1.09, tp: 1.11, lots: 0.2 }, expect: { approved: false, head: /^bad_rr 1\.00<3/ } },
  { name: 'max_positions', setup: (db) => fillBook(db, 5), input: { sl: 1.09, tp: 1.135, lots: 0.2 }, expect: { approved: false, head: /^max_positions=5\/5/ } },
  {
    name: 'insufficient margin share',
    setup: (db) => setState(db, `acct:${A}:risk_config_json`, JSON.stringify({ maxMarginUsagePct: 0.0003 })),
    input: { sl: 1.09, tp: 1.135, lots: 0.2 }, expect: { approved: false, head: /^insufficient_margin share/ },
  },
  // Lot fix (owner "Go lot fix", № 13,396): blank lots is sized by the risk
  // budget, as the pad says — before the fix the route sent 0.01, which the
  // gate read as a ceiling and this fixture expected.
  { name: 'blank lots sizes by the risk budget (lot fix)', setup: () => {}, input: { sl: 1.09, tp: 1.135 }, expect: { approved: true, aboveLots: 0.01 } },
]

for (const f of FIXTURES) {
  test(`equivalence (${f.name}): the dry run's verdict is evaluateTrade's on the same state`, async (t) => {
    const db = fresh(); t.after(() => db.close())
    f.setup(db)
    const out = await withCreds(() => preorderCheck(db, { account: A, symbol: SYM, side: 'BUY', ...f.input }, { fetchEntry: async () => 1.1 }))
    assert.equal(out.ok, true, out.cannotCheck || out.error)
    const direct = evaluateTrade(db, routeProposal({ entry: 1.1, ...f.input }), loadRiskConfig(db, A))
    assert.deepEqual(out.proposal, routeProposal({ entry: 1.1, ...f.input }), 'the dry run built the route\'s proposal')
    assert.equal(out.gate.approved, direct.approved)
    assert.equal(out.gate.vetoReason, direct.veto_reason ?? null)
    assert.equal(out.approved, f.expect.approved)
    if (f.expect.head) assert.match(out.gate.vetoReason, f.expect.head)
    // The first block is the gate's veto, in the codebase's words.
    if (f.expect.approved) {
      assert.equal(out.firstBlock, null)
      assert.equal(out.numbers.volume, direct.adjusted_volume)
      assert.equal(out.numbers.volumeBasis, 'approved')
      if (f.expect.volume != null) assert.equal(out.numbers.volume, f.expect.volume)
      if (f.expect.aboveLots != null) {
        assert.ok(out.numbers.volume > f.expect.aboveLots, `volume ${out.numbers.volume} is the risk-based size, not the old 0.01 default`)
        assert.equal(out.numbers.volume, direct.checks.risk_based_volume, 'the risk-based size itself, uncapped')
      }
    } else {
      assert.deepEqual([out.firstBlock.stage, out.firstBlock.reason], ['risk_gate', direct.veto_reason])
      assert.ok(out.firstBlock.label && out.firstBlock.label !== out.firstBlock.reason, 'a human label, not the machine code')
    }
    assert.deepEqual(out.checks, direct.checks, 'the gate\'s own checks are passed through')
    assert.deepEqual(out.expectedR, EXPECTED_R_NOT_COMPUTED)
    assert.equal(out.strategy.allowedBy, 'not_consulted', 'the manual route does not ask the evidence gate')
  })
}

test('numbers: size, money at risk (USD), share of today\'s stop left, margin share and open/cap come from the gate', async (t) => {
  const db = fresh(); t.after(() => db.close())
  fillBook(db, 2)
  const out = await withCreds(() => preorderCheck(db, { account: A, symbol: SYM, side: 'BUY', sl: 1.09, tp: 1.135, lots: 0.5 }, { fetchEntry: async () => 1.1 }))
  const c = out.checks, n = out.numbers
  assert.equal(n.rr, c.rr); assert.equal(n.rr, 3.5)
  assert.equal(n.rrFloor >= 3, true)
  assert.equal(n.stopDistance, c.sl_distance)
  assert.equal(n.volume, out.gate.adjustedVolume)
  // EURUSD: 0.01 price × 100,000 units = USD 1,000 a lot on this stop.
  assert.equal(n.moneyAtRisk, Number((n.volume * 1000).toFixed(2)))
  assert.equal(n.currency, 'USD')
  assert.equal(n.dailyStopLeft, c.daily_budget_left_usd)
  assert.equal(n.shareOfStopLeft, Number(((n.moneyAtRisk / n.dailyStopLeft) * 100).toFixed(1)))
  assert.equal(n.marginShare.requiredUsd, c.margin_required_usd)
  assert.equal(n.marginShare.headroomUsd, Number((c.margin_cap_usd - c.margin_used_usd).toFixed(2)))
  assert.equal(n.openPositions, 2); assert.equal(n.maxPositions, 5)
})

test('strategy: last 20 closes on this account from the evidence gate\'s population, and what admits it', async (t) => {
  const db = fresh(); t.after(() => db.close())
  setState(db, 'evidence_gate_json', JSON.stringify({ on: true }))
  const { id } = seedScan(db)
  // 25 clean bot closes: the newest 20 are 15 wins of +20 and 5 losses of −10.
  const ins = db.prepare("INSERT INTO trades (symbol, side, status, net_pnl, origin, label_strategy, account_id, opened_at, closed_at) VALUES (?, 'BUY', 'closed', ?, 'bot_auto', 'ema_pullback', ?, datetime('now', '-2 days'), datetime('now', '-1 days'))")
  for (let i = 0; i < 5; i++) ins.run(SYM, -50, A)
  for (let i = 0; i < 20; i++) ins.run(SYM, i < 15 ? 20 : -10, A)
  const out = await withCreds(() => preorderCheck(db, { scanId: id, account: A }))
  assert.equal(out.ok, true, out.cannotCheck)
  assert.deepEqual(out.strategy.last20, { n: 20, winRatePct: 75, profitFactor: 6, windowDays: 90 })
  assert.equal(out.strategy.allowedBy, 'shadow', 'not pinned and under the 30-close bar')
  assert.equal(out.firstBlock.stage, 'evidence_gate', 'the evidence gate stops the dispatch before the risk gate')
  assert.match(out.firstBlock.reason, /^evidence_gate: ema_pullback on …4242: 25\/30 closes/)
  assert.equal(out.approved, false)
})

// ---- 3. the real paths ----------------------------------------------------------

const firstProposal = (db) => JSON.parse(db.prepare('SELECT proposal_json FROM risk_events ORDER BY id LIMIT 1').get().proposal_json)
const firstVerdict = (db) => db.prepare('SELECT approved, veto_reason FROM risk_events ORDER BY id LIMIT 1').get()

for (const kase of [
  { name: 'approved', scan: {}, approved: true },
  { name: 'bad_rr', scan: { tp1: 1.11 }, approved: false },
]) {
  test(`scan, market path (${kase.name}): the proposal and verdict are the ones the real loop.js autoTrade persists`, async (t) => {
    const db = fresh(); t.after(() => db.close())
    const { id, sig } = seedScan(db, kase.scan)
    const dry = await withCreds(() => preorderCheck(db, { scanId: id, account: A }))
    assert.equal(dry.ok, true, dry.cannotCheck || dry.error)
    assert.equal(dry.route, 'market')
    assert.equal(dry.proposal.sharedAccounts, 1, 'one account in the roster, not exhausted, admitted by the pre-gate')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM risk_events').get().n, 0, 'the dry run recorded nothing')
    const { autoTrade } = await import('../loop.js')
    const { synthesizeFibSignal } = await import('./fib-strategy.js')
    const synth = synthesizeFibSignal(SYM, sig, 8).synthesis
    // The fan-out's item for this account and the E·2 count, as loop.js:2038/2085 pass them.
    const acctItem = { symbol: SYM, enabled: true, maxVolume: 0.3 }
    let placed = false
    const out = await withCreds(() => autoTrade(db, SYM, synth, acctItem, { accountId: A, isLive: false }, {
      sharedAccounts: 1,
      // An approval stops at symbol resolution (a post-approval veto): no order.
      testTransport: { resolveSymbolId: async () => ({ id: null, reason: 'preorder_test_stop' }), execPlaceOrder: async () => { placed = true; throw new Error('no') } },
    }))
    assert.equal(out ?? null, null); assert.equal(placed, false)
    assert.deepEqual(firstProposal(db), JSON.parse(JSON.stringify(dry.proposal)), 'the dry run built the proposal the loop persisted')
    const v = firstVerdict(db)
    assert.equal(Number(v.approved) === 1, dry.gate.approved)
    assert.equal(v.veto_reason ?? null, dry.gate.vetoReason)
  })
}

test('scan, HTF resting-limit path: the proposal and verdict are the ones the real placeClosedMarketLimit persists', async (t) => {
  const db = fresh(); t.after(() => db.close())
  // A 4h signal with no freshness window: loop.js routes it to the resting limit.
  setState(db, 'risk_config_json', JSON.stringify({ htfLimitDispatch: { minTf: '4h', freshnessMin: 0 } }))
  const { id, sig } = seedScan(db, { tf: '4h', tp1: 1.11 })
  const dry = await withCreds(() => preorderCheck(db, { scanId: id, account: A }))
  assert.equal(dry.ok, true, dry.cannotCheck || dry.error)
  assert.equal(dry.route, 'htf_limit')
  assert.equal(dry.proposal.source, 'htf_limit')
  const { placeClosedMarketLimit } = await import('./closed-market-limits.js')
  const { synthesizeFibSignal } = await import('./fib-strategy.js')
  const synth = synthesizeFibSignal(SYM, sig, 8).synthesis
  const r = await placeClosedMarketLimit(db, { host: HOST, clientId: 'c', clientSecret: 's', accessToken: 't', accountId: A, ready: true }, SYM, synth,
    { producerId: 'scan_dispatch', requestedVolume: 0.3, reason: 'htf', expiresAtMs: Date.now() + 3_600_000 })
  assert.equal(r.skipped, 'risk_veto')
  assert.deepEqual(firstProposal(db), JSON.parse(JSON.stringify(dry.proposal)))
  assert.equal(firstVerdict(db).veto_reason, dry.gate.vetoReason)
})

test('scan, HTF with resting limits off: the first block says no order is placed', async (t) => {
  const db = fresh(); t.after(() => db.close())
  setState(db, 'risk_config_json', JSON.stringify({ htfLimitDispatch: { minTf: '4h', freshnessMin: 0 } }))
  setState(db, 'closed_market_limits_json', JSON.stringify({ on: false }))
  const { id } = seedScan(db, { tf: '4h' })
  const dry = await withCreds(() => preorderCheck(db, { scanId: id, account: A }))
  assert.equal(dry.firstBlock.stage, 'htf_limit')
  assert.equal(dry.approved, false)
  assert.equal(dry.gate.approved, true, 'the gate itself would approve — its numbers are still reported')
})

test('scan: two accounts in the roster split the signal (sharedAccounts 2), as the loop\'s E·2 pre-pass counts', async (t) => {
  const db = fresh({ accounts: [A, B] }); t.after(() => db.close())
  const { id } = seedScan(db)
  const dry = await withCreds(() => preorderCheck(db, { scanId: id, account: B }))
  assert.equal(dry.proposal.sharedAccounts, 2)
  assert.equal(dry.proposal.accountId, B)
  assert.deepEqual(dry.checks.shared_signal, { accounts: 2, scale: 0.5 })
})

test('manual: the proposal and veto are the ones the real POST /actions/manual-order persists (same broker read)', async (t) => {
  const db = fresh(); t.after(() => db.close())
  const broker = fakeBroker(1.1)
  _setWebSocketForTests(broker.Socket); t.after(() => _setWebSocketForTests(null))
  const srv = await serve(db); t.after(srv.close)
  const input = { account: A, symbol: SYM, side: 'BUY', lots: 0.2, sl: 1.09, tp: 1.11 }
  const dry = await withCreds(() => preorderCheck(db, input))
  assert.equal(dry.ok, true, dry.cannotCheck || dry.error)
  assert.equal(dry.gate.approved, false)
  const res = await withCreds(() => fetch(`${srv.base}/actions/manual-order`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input),
  }).then(r => r.json()))
  assert.equal(res.vetoed, true, JSON.stringify(res).slice(0, 300))
  assert.equal(res.reason, dry.gate.vetoReason)
  assert.deepEqual(firstProposal(db), JSON.parse(JSON.stringify(dry.proposal)), 'the dry run built the route\'s proposal from the same 1m close')
})
