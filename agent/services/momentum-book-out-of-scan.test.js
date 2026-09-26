// node --test agent/services/momentum-book-out-of-scan.test.js
//
// Wave 2 row 2.1 — S-2 + F2 + F6 (OD-2 answered yes by the owner,
// 26-09-2026 18:05 SGT; docs/v3-integrated-plan-2026-09-26.md §5, §6).
//
//   S-2  The momentum book and its daily pass leave the scan branch, so the
//        trail and the exits run with Scan disabled, with Scan off on every
//        account, and in weekend quiet with no crypto on the watchlist. On
//        those cycles the book takes NO entries (`entriesHeld`) — entries
//        behave as they did when the whole book was skipped with the scan.
//   F2   The daily-path rank exit asks the broker's hours first. A market
//        the broker's schedule says is closed gets no broker call: the row
//        is marked `exit_pending:` and sent on the first pass it is open.
//        (…0058, KO.US `close failed — MARKET_CLOSED`, Fri 25-09 21:05:40Z.)
//   F6   A `momentum_book` heartbeat, beaten by the loop, with the pass's
//        own record as its effect; dormant while the book is switched off.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parse } from 'acorn'
import { initDB, getState, setState } from '../db.js'
import { MOMENTUM_ACCOUNT_KEY, MOMENTUM_UNIVERSE_KEY, ACCOUNT_TERMINAL_TRADE_STATES, nextBrokerOpenMs } from './momentum-account.js'
import { runMomentumBook, MOMENTUM_BOOK_CONFIG_KEY, MOMENTUM_BOOK_PASS_KEY, TSMOM_STRATEGY, BOOK_TERMINAL_TRADE_STATES } from './momentum-book.js'
import { MOMENTUM_SHADOW_STATE_KEY } from './momentum-shadow.js'
import { setStage } from './stage-matrix.js'
import { CONTROLLERS, beat, heartbeatView } from './heartbeat.js'
import { CONTROLLER_GROUPS } from '../shared/controller-groups.js'

const ACC = '46130058'
const DUE = Date.UTC(2026, 8, 25, 21, 5, 40)           // Fri 25-09 21:05:40Z — the KO.US pass
const LATER = DUE + 16 * 3600_000                        // Sat 13:05Z: not due again, market still shut
const MON_OPEN = Date.UTC(2026, 8, 28, 13, 35)           // Mon 28-09 13:35Z: NY open, same book day as no pass
const OLD = new Date(DUE - 10 * 86_400_000).toISOString()

const CLOSED = () => ({ open: false, source: 'broker', reason: 'closed per broker trading schedule' })
const OPEN = () => ({ open: true, source: 'broker' })

function fresh({ holdings = {} } = {}) {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${ACC}','1',0,1,'active')`).run()
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: '_all', volTargetPct: 10, maxPositions: 8 }))
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['KO.US', 'BTCUSD'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: ACC }, { getState, setState })
  return db
}

function bookRow(db, symbol = 'KO.US') {
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, label_strategy, strategy, account_id, origin, ctrader_position_id, volume, opened_at) VALUES (?,'BUY','open',60,55,?,?,?,'bot_market_dispatch',?,1,'2026-09-10 14:00:00')`)
    .run(symbol, TSMOM_STRATEGY, TSMOM_STRATEGY, ACC, `pos-${symbol}`).lastInsertRowid
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note) VALUES (?, ?, ?, ?, 'long', 60, 55, 1, 0.9, ?, 'open', 'test row')`)
    .run(tradeId, ACC, symbol, `pos-${symbol}`, OLD)
}

function fakes({ hours = OPEN } = {}) {
  const calls = { close: [], autoTrade: [] }
  return {
    calls,
    deps: {
      symbolMap: { 'KO.US': 1, BTCUSD: 2 },
      symbolIdFor: async (_c, s) => ({ 'KO.US': 1, BTCUSD: 2 })[s] ?? null,
      volumeMeta: async () => ({ lotSize: 100, minVolume: 1, stepVolume: 1, digits: 2 }),
      bars: async () => Array.from({ length: 30 }, (_, i) => ({ t: i, o: 60, h: 60.5, l: 59.5, c: 60 })),
      spot: async () => ({ bid: 59.99, ask: 60 }),
      equity: () => 100_000,
      rates: () => null,
      atrOf: () => 1,
      mayTrade: () => ({ ok: true, item: null }),
      close: async (_c, args) => { calls.close.push(args); return {} },
      positionVolume: async () => 100,
      amend: async () => ({}),
      phasesOn: () => true,
      autoTrade: async (_db, symbol) => { calls.autoTrade.push(symbol); return null },
      isSymbolOpen: (_db, symbol, at) => hours(symbol, at),
    },
  }
}
const run = (db, f, now, extra = {}) => runMomentumBook(db, { accounts: [{ accountId: ACC, isLive: false }], credsFor: (a) => ({ accountId: a.accountId }), deps: f.deps, now, ...extra })
const row = (db, symbol = 'KO.US') => db.prepare(`SELECT status, note FROM momentum_book WHERE symbol = ?`).get(symbol)

// ---------------------------------------------------------------------------
// S-2 behaviour: with the scan skipped for each of its three reasons, the
// book's rank exit still goes out; no entry is taken.
// ---------------------------------------------------------------------------
for (const why of ['Scan disabled', 'Scan off on every trading account', 'weekend quiet with nothing to scan']) {
  test(`S-2: ${why} — the daily pass still exits a dropped holding, and takes no entry`, async () => {
    // The ranking holds BTCUSD (an entry the pass would take) and not KO.US (an exit).
    const db = fresh({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 } } })
    bookRow(db)
    const f = fakes()
    const r = await run(db, f, DUE, { entriesHeld: why })
    assert.equal(f.calls.close.length, 1, `the exit went out: ${JSON.stringify(r.skipped)}`)
    assert.equal(r.exits, 1)
    assert.equal(row(db).status, 'exit_sent')
    assert.deepEqual(f.calls.autoTrade, [], 'no entry on a cycle whose scan was skipped')
    assert.equal(r.entries, 0)
    assert.equal(r.entriesHeld, why)
    assert.ok(r.skipped.some(s => s.includes(`entries held — ${why}`)), JSON.stringify(r.skipped))
  })
}

test('S-2: with the scan running (entriesHeld null) the same pass is unchanged — the exit goes and the entry is offered', async () => {
  const db = fresh({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 } } })
  bookRow(db)
  const f = fakes()
  const r = await run(db, f, DUE)
  assert.equal(f.calls.close.length, 1)
  assert.deepEqual(f.calls.autoTrade, ['BTCUSD'], `the entry is offered to autoTrade: ${JSON.stringify(r.skipped)}`)
  assert.equal(r.entriesHeld, undefined)
})

// ---------------------------------------------------------------------------
// F2: the daily exit checks the broker's hours.
// ---------------------------------------------------------------------------
test('F2: a closed market (broker schedule) sends nothing and marks exit_pending; the first open pass sends it, off-cadence', async () => {
  const db = fresh()
  bookRow(db)
  let hours = CLOSED
  const f = fakes({ hours: (s, at) => hours(s, at) })
  let r = await run(db, f, DUE)
  assert.equal(f.calls.close.length, 0, 'no close into a closed market')
  assert.equal(r.exits, 0)
  assert.equal(r.deferredClosed, 1, 'counted in the book summary')
  assert.equal(row(db).status, 'open')
  assert.match(row(db).note, /^exit_pending: market closed/)
  // Not due again (the cursor advanced), market still shut: still nothing.
  r = await run(db, f, LATER)
  assert.equal(f.calls.close.length, 0)
  assert.equal(r.deferredClosed, 1)
  // The market opens: the owed exit goes on this pass, whatever the cadence.
  hours = OPEN
  r = await run(db, f, MON_OPEN)
  assert.equal(f.calls.close.length, 1, `sent at the open: ${JSON.stringify(r.skipped)}`)
  assert.equal(r.exits, 1)
  assert.equal(row(db).status, 'exit_sent')
  assert.equal(row(db).note, 'rank exit (daily pass)')
})

test('F2: a pending exit is withdrawn, not sent, when the ranking holds the name again before its market opens', async () => {
  const db = fresh()
  bookRow(db)
  let hours = CLOSED
  const f = fakes({ hours: (s, at) => hours(s, at) })
  await run(db, f, DUE)
  assert.match(row(db).note, /^exit_pending:/)
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { 'KO.US': { side: 'long', entryRank: 0.9 } }, refused: {}, lastRunMs: 2, lastUniverse: 20 }))
  hours = OPEN
  await run(db, f, MON_OPEN)
  assert.equal(f.calls.close.length, 0)
  assert.equal(row(db).status, 'open')
  assert.doesNotMatch(row(db).note, /^exit_pending:/)
})

test('F2: only the broker schedule may defer — the sessions heuristic and a throwing hours read both ATTEMPT the close', async () => {
  for (const hours of [() => ({ open: false, source: 'heuristic' }), () => { throw new Error('hours table unreadable') }]) {
    const db = fresh()
    bookRow(db)
    const f = fakes({ hours })
    const r = await run(db, f, DUE)
    assert.equal(f.calls.close.length, 1, JSON.stringify(r.skipped))
    assert.equal(r.deferredClosed, 0)
  }
})

test('F2: a close the broker refuses is flagged exit_pending and retried on the next pass', async () => {
  const db = fresh()
  bookRow(db)
  const f = fakes()
  let fail = true
  f.deps.close = async (_c, args) => { if (fail) throw new Error('MARKET_CLOSED'); f.calls.close.push(args); return {} }
  await run(db, f, DUE)
  assert.equal(row(db).note, 'exit_pending: MARKET_CLOSED')
  fail = false
  const r = await run(db, f, LATER)
  assert.equal(f.calls.close.length, 1, JSON.stringify(r.skipped))
  assert.equal(row(db).status, 'exit_sent')
})

// ---------------------------------------------------------------------------
// S-2 wiring in loop.js, parsed (comments are not in the syntax tree, so a
// comment naming a function cannot satisfy these — failure mode #2).
// ---------------------------------------------------------------------------
function loopCalls() {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
  const calls = {}
  const walk = (node, chain) => {
    if (!node || typeof node.type !== 'string') return
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') (calls[node.callee.name] ||= []).push({ node, chain })
    const next = ['IfStatement', 'TryStatement', 'FunctionDeclaration', 'ConditionalExpression', 'LogicalExpression'].includes(node.type) ? [...chain, node] : chain
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (k === 'handler' && node.type === 'TryStatement') { walk(v, [...chain, { type: 'CatchOf', of: node }]); continue }
      if (Array.isArray(v)) v.forEach(c => walk(c, next))
      else if (v && typeof v.type === 'string') walk(v, next)
    }
  }
  walk(ast, [])
  const conds = (x) => x.chain.filter(n => n.type === 'IfStatement').map(n => src.slice(n.test.start, n.test.end))
  return { src, calls, conds }
}

test('S-2 wiring: loop.js calls the book once, gated by nothing but the cTrader credentials — not the symbols block, the scan switch, Scan-off-everywhere or weekend quiet', () => {
  const { calls, conds } = loopCalls()
  const book = calls.runMomentumBook || []
  assert.equal(book.length, 1, 'exactly one call of runMomentumBook')
  assert.deepEqual(conds(book[0]), ['getCtraderCreds(db).ready'], 'the only condition above the book is the credentials read')
  const scanGate = calls.runMomentumShadow?.[0]
  assert.ok(scanGate, 'the shadow is still called')
  const shadowConds = conds(scanGate)
  for (const gate of ['!symbolsJson', 'allSymbols.length === 0', 'weekendQuiet && symbols.length === 0', '!scanEnabled', '!scanWanted']) {
    assert.ok(shadowConds.includes(gate), `the shadow still ranks inside the scan branch (${gate}): ${JSON.stringify(shadowConds)}`)
    assert.ok(!conds(book[0]).includes(gate), `the book is not under ${gate}`)
  }
  const bookArgs = book[0].node.arguments[1]
  const entriesHeld = bookArgs.properties.find(p => p.key?.name === 'entriesHeld')
  assert.equal(entriesHeld?.value?.name, 'bookEntriesHeld', 'the book is told why the scan did not run')
  // Before the partial-TP1 manager (its rank exit reserves a plan first).
  assert.ok(calls.runMomentumPartialPass[0].node.start > book[0].node.start)
  assert.ok(book[0].node.start > scanGate.node.start, 'after the shadow, so a pass reads this cycle\'s ranking')
})

test('S-2 wiring: bookEntriesHeld names each reason the scan branch is skipped, and is null only when it runs', () => {
  const { src } = loopCalls()
  const i = src.indexOf('bookEntriesHeld = allSymbols.length === 0')
  assert.ok(i > 0)
  const expr = src.slice(i, src.indexOf('\n      if (allSymbols.length === 0) {', i))
  // Evaluate the loop's own expression over the four switches.
  const held = (v) => new Function('allSymbols', 'weekendQuiet', 'symbols', 'scanEnabled', 'scanWanted', `let bookEntriesHeld; ${expr}; return bookEntriesHeld`)(v.all, v.quiet, v.sym, v.en, v.want)
  const base = { all: ['KO.US'], quiet: false, sym: ['KO.US'], en: true, want: true }
  assert.equal(held(base), null)
  assert.equal(held({ ...base, en: false }), 'Scan disabled')
  assert.equal(held({ ...base, want: false }), 'Scan off on every trading account')
  assert.equal(held({ ...base, quiet: true, sym: [] }), 'weekend quiet with nothing to scan')
  assert.equal(held({ ...base, all: [], sym: [] }), 'no enabled symbols')
  assert.equal(held({ ...base, quiet: true, sym: ['BTCUSD'] }), null, 'quiet with crypto: the scan runs')
})

// ---------------------------------------------------------------------------
// F6: the momentum_book heartbeat.
// ---------------------------------------------------------------------------
test('F6: momentum_book is a registered, grouped controller; the pass writes its record; the loop beats it on success and failed in its catch', async () => {
  assert.ok(CONTROLLERS.momentum_book, 'registered')
  assert.equal(CONTROLLERS.momentum_book.tiedToLoop, true)
  assert.equal(CONTROLLERS.momentum_book.effect.key, MOMENTUM_BOOK_PASS_KEY)
  assert.ok(CONTROLLER_GROUPS.some(g => g.names.includes('momentum_book')), 'grouped')

  const db = fresh()
  bookRow(db)
  const f = fakes({ hours: CLOSED })
  await run(db, f, DUE, { entriesHeld: 'Scan disabled' })
  const rec = JSON.parse(getState(db, MOMENTUM_BOOK_PASS_KEY))
  assert.equal(rec.at, new Date(DUE).toISOString())
  assert.equal(rec.deferredClosed, 1)
  assert.equal(rec.entriesHeld, 'Scan disabled')
  beat(db, 'momentum_book', { now: new Date(DUE) })
  const v = heartbeatView(db, { now: new Date(DUE + 1000) }).find(x => x.name === 'momentum_book')
  assert.equal(v.status, 'ok', JSON.stringify(v))
  assert.equal(v.work_product?.hasRecord, true)
  assert.notEqual(v.verdict, 'dormant')

  const { calls } = loopCalls()
  const bookTry = calls.runMomentumBook[0].chain.filter(n => n.type === 'TryStatement').at(-1)
  const beats = (calls.hbeat || []).filter(h => h.node.arguments[1]?.value === 'momentum_book')
  const inCatch = h => h.chain.some(n => n.type === 'CatchOf' && n.of === bookTry)
  assert.ok(beats.some(h => h.chain.includes(bookTry) && !inCatch(h) && h.node.start > calls.runMomentumBook[0].node.start), 'beats on the success path, after the pass')
  assert.ok(beats.some(h => inCatch(h) && h.node.arguments[2]?.value === false), 'beats failed in its catch')
})

test('F6: with the book switched off the controller is dormant, not stalled', () => {
  const db = initDB(':memory:')
  const v = heartbeatView(db, { now: new Date(DUE) }).find(x => x.name === 'momentum_book')
  assert.equal(v.verdict, 'dormant', JSON.stringify(v))
  assert.match(v.dormant_reason, /switched off/)
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  assert.notEqual(heartbeatView(db, { now: new Date(DUE) }).find(x => x.name === 'momentum_book').verdict, 'dormant')
})

// ---------------------------------------------------------------------------
// Checker B1: the ROW-CURSOR entry hold. An account the momentum-account
// config does not name takes the row-cursor path; its `tryEnter` must refuse
// every entry — the shadow's fresh `enter` row AND the reconcile of a held
// name — while `entriesHeld` is set, and offer both when it is null.
// ---------------------------------------------------------------------------
function rowCursorDb() {
  const db = fresh({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 } } })
  // A named account that is NOT this one: ACC is off the daily pass.
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: '99990001', volTargetPct: 10, maxPositions: 8 }))
  db.prepare(`INSERT INTO momentum_shadow (at, symbol, action, side, rank_pct, conviction, price, timeframe, universe) VALUES ('2026-09-25T21:00:00.000Z','KO.US','enter','long',0.92,9,60,'1d',20)`).run()
  return db
}

for (const why of ['Scan disabled', 'Scan off on every trading account', 'weekend quiet with nothing to scan']) {
  test(`B1 row-cursor: ${why} — neither the shadow's enter row nor the held name reaches autoTrade`, async () => {
    const db = rowCursorDb()
    const f = fakes()
    const r = await run(db, f, DUE, { entriesHeld: why })
    assert.equal(r.momentumAccount, undefined, 'the account took the row-cursor path, not the daily pass')
    assert.deepEqual(f.calls.autoTrade, [], `no entry while held: ${JSON.stringify(r.skipped)}`)
    assert.equal(r.entries, 0)
    assert.equal(r.entriesHeld, why)
  })
}

test('B1 row-cursor: with entriesHeld null the same pass offers the enter row and the held name to autoTrade', async () => {
  const db = rowCursorDb()
  const f = fakes()
  const r = await run(db, f, DUE)
  assert.equal(r.momentumAccount, undefined)
  assert.ok(f.calls.autoTrade.includes('KO.US'), `the shadow's enter row is offered: ${JSON.stringify(r.skipped)}`)
  assert.ok(f.calls.autoTrade.includes('BTCUSD'), `the held name is reconciled: ${JSON.stringify(r.skipped)}`)
})

// ---------------------------------------------------------------------------
// Checker N1: ONE send per cycle for a refused close — the pending-only retry
// and the pass's own exit call no longer both send the same row.
// ---------------------------------------------------------------------------
const refusing = (f, msg = 'TRADING_DISABLED') => { f.deps.close = async (_c, args) => { f.calls.close.push(args); throw new Error(msg) } }
const bookRowFull = (db) => db.prepare(`SELECT status, note, exit_refusals, exit_retry_after FROM momentum_book WHERE symbol = 'KO.US'`).get()

for (const label of ['entries held', 'margin exhausted']) {
  test(`N1: ${label} — an always-refusing close is sent exactly once per cycle`, async () => {
    const db = fresh()
    bookRow(db)
    const f = fakes()
    refusing(f)
    let opts = { entriesHeld: 'Scan disabled' }
    if (label === 'margin exhausted') { f.deps.marginHeadroom = () => 0; opts = {} }
    // Two cycles below the backoff threshold; the day's cursor never
    // advances on a held pass, so both are "due".
    for (const [i, at] of [DUE, DUE + 5 * 60_000].entries()) {
      const before = f.calls.close.length
      const r = await run(db, f, at, opts)
      assert.equal(f.calls.close.length - before, 1, `cycle ${i + 1}: one send, not two: ${JSON.stringify(r.skipped)}`)
    }
    assert.equal(bookRowFull(db).exit_refusals, 2)
  })
}

test('N1: a due, running pass sends an already-pending refused close once (the pending retry, not again from the rank exit)', async () => {
  const db = fresh()
  bookRow(db)
  db.prepare(`UPDATE momentum_book SET note = 'exit_pending: TRADING_DISABLED', exit_refusals = 1`).run()
  const f = fakes()
  refusing(f)
  const r = await run(db, f, DUE)
  assert.equal(f.calls.close.length, 1, JSON.stringify(r.skipped))
  assert.equal(bookRowFull(db).exit_refusals, 2)
})

// ---------------------------------------------------------------------------
// Checker N2: the refused-exit retry backs off after 3 consecutive refusals.
// ---------------------------------------------------------------------------
test('N2: below 3 refusals every pass retries; from the 3rd the retry waits 30 min, recorded on the row; a send that goes clears it', async () => {
  const db = fresh()
  bookRow(db)
  const f = fakes()
  refusing(f)
  const held = { entriesHeld: 'Scan disabled' }
  const t = (m) => DUE + m * 60_000
  await run(db, f, t(0), held)
  assert.equal(bookRowFull(db).exit_retry_after, null, '1st refusal: no backoff')
  await run(db, f, t(5), held)
  assert.equal(bookRowFull(db).exit_retry_after, null, '2nd refusal: no backoff')
  await run(db, f, t(10), held)
  assert.equal(f.calls.close.length, 3, 'three passes, three sends')
  let b = bookRowFull(db)
  assert.equal(b.exit_refusals, 3)
  assert.equal(b.exit_retry_after, new Date(t(40)).toISOString(), '3rd refusal: next retry 30 min on')
  assert.equal(b.note, 'exit_pending: TRADING_DISABLED')
  for (const m of [15, 20, 39]) {
    const r = await run(db, f, t(m), held)
    assert.equal(f.calls.close.length, 3, `t+${m}: backing off`)
    assert.ok(r.skipped.some(s => s.includes('refused exit backing off')), JSON.stringify(r.skipped))
  }
  await run(db, f, t(40), held)
  assert.equal(f.calls.close.length, 4, 'retried at the backoff time')
  assert.equal(bookRowFull(db).exit_retry_after, new Date(t(70)).toISOString())
  f.deps.close = async (_c, args) => { f.calls.close.push(args); return {} }
  await run(db, f, t(70), held)
  assert.equal(f.calls.close.length, 5)
  b = bookRowFull(db)
  assert.equal(b.status, 'exit_sent')
  assert.equal(b.exit_retry_after, null)
})

test('N2: a MARKET_CLOSED refusal (the 3rd) waits for the broker\'s next open; with no schedule it falls back to 30 min', async () => {
  for (const [nextOpen, expect] of [[() => MON_OPEN, MON_OPEN], [() => null, DUE + 10 * 60_000 + 30 * 60_000]]) {
    const db = fresh()
    bookRow(db)
    const f = fakes()
    refusing(f, 'MARKET_CLOSED')
    f.deps.nextBrokerOpen = nextOpen
    for (const m of [0, 5, 10]) await run(db, f, DUE + m * 60_000, { entriesHeld: 'Scan disabled' })
    assert.equal(bookRowFull(db).exit_retry_after, new Date(expect).toISOString())
    await run(db, f, expect - 60_000, { entriesHeld: 'Scan disabled' })
    assert.equal(f.calls.close.length, 3, 'nothing before the retry time')
    await run(db, f, expect, { entriesHeld: 'Scan disabled' })
    assert.equal(f.calls.close.length, 4, 'sent at the retry time')
  }
})

test('N2: nextBrokerOpenMs reads the broker schedule — the session after the current one, or the next open when closed; null with no schedule', () => {
  const db = initDB(':memory:')
  assert.equal(nextBrokerOpenMs(db, 'KO.US', DUE), null)
  const day = 86_400
  const schedule = [1, 2, 3, 4, 5].map(d => ({ startSecond: d * day + 13.5 * 3600, endSecond: d * day + 20 * 3600 }))
  db.prepare(`INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES ('KO.US', ?, 'UTC')`).run(JSON.stringify(schedule))
  const monOpen = Date.UTC(2026, 8, 28, 13, 30)
  assert.equal(nextBrokerOpenMs(db, 'KO.US', Date.UTC(2026, 8, 25, 19, 0)), monOpen, 'open Friday: the session after this one')
  assert.equal(nextBrokerOpenMs(db, 'KO.US', LATER), monOpen, 'closed Saturday: the next open')
})

test('N2: a withdrawn pending exit clears its refusal record', async () => {
  const db = fresh()
  bookRow(db)
  db.prepare(`UPDATE momentum_book SET note = 'exit_pending: TRADING_DISABLED', exit_refusals = 3, exit_retry_after = ?`).run(new Date(DUE + 3600_000).toISOString())
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { 'KO.US': { side: 'long', entryRank: 0.9 } }, refused: {}, lastRunMs: 2, lastUniverse: 20 }))
  const f = fakes()
  await run(db, f, DUE)
  const b = bookRowFull(db)
  assert.equal(f.calls.close.length, 0)
  assert.match(b.note, /^exit withdrawn/)
  assert.equal(b.exit_refusals, null)
  assert.equal(b.exit_retry_after, null)
})

// ---------------------------------------------------------------------------
// A failed close never relabels an exit_sent row; the pending retry skips a
// trade already terminal.
// ---------------------------------------------------------------------------
test('a failure after the row reached exit_sent leaves the row exit_sent with its note', async () => {
  const db = fresh()
  bookRow(db)
  const f = fakes()
  // The close goes and the row is marked exit_sent; the log line after it
  // then throws, which lands in the same catch as a refused close.
  const log = (m) => { if (/rank exit KO\.US/.test(m)) throw new Error('log sink down') }
  const r = await run(db, f, DUE, { log })
  assert.equal(f.calls.close.length, 1)
  assert.ok(r.skipped.some(s => s.includes('log sink down')), `the failure reached the catch: ${JSON.stringify(r.skipped)}`)
  const b = bookRowFull(db)
  assert.equal(b.status, 'exit_sent')
  assert.equal(b.note, 'rank exit (daily pass)', 'not relabelled exit_pending')
  assert.equal(b.exit_refusals, null)
})

test('row-cursor path: a failure after the row reached exit_sent leaves the row exit_sent with its note', async () => {
  const db = rowCursorDb()
  bookRow(db)
  db.prepare(`INSERT INTO momentum_shadow (at, symbol, action, side, rank_pct, conviction, price, timeframe, universe) VALUES ('2026-09-25T21:01:00.000Z','KO.US','exit','long',0.2,2,60,'1d',20)`).run()
  const f = fakes()
  const log = (m) => { if (/momentum book: rank exit KO\.US/.test(m)) throw new Error('log sink down') }
  const r = await run(db, f, DUE, { log })
  assert.equal(r.momentumAccount, undefined)
  assert.equal(f.calls.close.length, 1, JSON.stringify(r.skipped))
  assert.ok(r.skipped.some(s => s.includes('log sink down')), `the failure reached the catch: ${JSON.stringify(r.skipped)}`)
  const b = bookRowFull(db)
  assert.equal(b.status, 'exit_sent')
  assert.equal(b.note, 'rank exit', 'not relabelled exit_pending')
})

test('the pending retry skips a row whose trade is already terminal', async () => {
  assert.deepEqual([...ACCOUNT_TERMINAL_TRADE_STATES].sort(), [...BOOK_TERMINAL_TRADE_STATES].sort(), 'one terminal set on both paths')
  for (const st of ACCOUNT_TERMINAL_TRADE_STATES) {
    const db = fresh()
    bookRow(db)
    db.prepare(`UPDATE momentum_book SET note = 'exit_pending: TRADING_DISABLED'`).run()
    db.prepare(`UPDATE trades SET status = ?`).run(st)
    const f = fakes()
    const r = await run(db, f, LATER)   // not due: only the pending retry runs
    assert.equal(f.calls.close.length, 0, `${st}: ${JSON.stringify(r.skipped)}`)
    assert.ok(r.skipped.some(s => s.includes(`is ${st}`)), JSON.stringify(r.skipped))
  }
})
