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
import { runMomentumBook, bookHoldLogLine, MOMENTUM_BOOK_CONFIG_KEY, MOMENTUM_BOOK_PASS_KEY, TSMOM_STRATEGY, BOOK_TERMINAL_TRADE_STATES } from './momentum-book.js'
import { thenAlways } from '../lib/then-always.js'
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
  assert.equal(b.exit_refusals, null, 'N-a: a send that goes clears the whole refusal record')
})

test('N2: a MARKET_CLOSED refusal (the 3rd) waits for the named next open, capped at 2 h; with none it falls back to 30 min', async () => {
  const third = DUE + 10 * 60_000
  for (const [nextOpen, expect] of [[() => MON_OPEN, third + 2 * 3600_000], [() => third + 45 * 60_000, third + 45 * 60_000], [() => null, third + 30 * 60_000]]) {
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

test('N2/B-1: nextBrokerOpenMs names a next open ONLY when the broker schedule says closed now; null when open or unscheduled', () => {
  const db = initDB(':memory:')
  assert.equal(nextBrokerOpenMs(db, 'KO.US', DUE), null)
  const day = 86_400
  const schedule = [1, 2, 3, 4, 5].map(d => ({ startSecond: d * day + 13.5 * 3600, endSecond: d * day + 20 * 3600 }))
  db.prepare(`INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES ('KO.US', ?, 'UTC')`).run(JSON.stringify(schedule))
  const monOpen = Date.UTC(2026, 8, 28, 13, 30)
  assert.equal(nextBrokerOpenMs(db, 'KO.US', Date.UTC(2026, 8, 25, 19, 0)), null, 'open Friday: the schedule says open, so it names no next open')
  assert.equal(nextBrokerOpenMs(db, 'KO.US', LATER), monOpen, 'closed Saturday: the next open')
})

// ---------------------------------------------------------------------------
// Fix round 2, B-1: the MARKET_CLOSED backoff on REAL broker schedules (no
// injected nextBrokerOpen). A close is sent only when the hours check says
// open, so the refusal contradicts the schedule; the schedule's next open is
// trusted only when that schedule itself says closed now, and every wait is
// capped at 2 h.
// ---------------------------------------------------------------------------
const DAY = 86_400
async function threeMarketClosedRefusals(schedule, lastAt) {
  const db = fresh()
  bookRow(db)
  db.prepare(`INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES ('KO.US', ?, 'UTC')`).run(JSON.stringify(schedule))
  const f = fakes()   // the injected hours check says OPEN, so each pass sends
  refusing(f, 'MARKET_CLOSED')
  // Two earlier refusals already on the row (the pending retry runs every
  // pass, due or not); this pass sends and takes the 3rd.
  db.prepare(`UPDATE momentum_book SET note = 'exit_pending: MARKET_CLOSED', exit_refusals = 2`).run()
  await run(db, f, lastAt, { entriesHeld: 'Scan disabled' })
  assert.equal(f.calls.close.length, 1)
  return bookRowFull(db)
}

test('B-1: weekly single interval (Sun 22:00 → Fri 21:00), refused Mon 28-09 15:00Z — 30 min, not the 151 h park at 04-10 22:00Z', async () => {
  const b = await threeMarketClosedRefusals([{ startSecond: 22 * 3600, endSecond: 5 * DAY + 21 * 3600 }], Date.UTC(2026, 8, 28, 15, 0))
  assert.equal(b.exit_refusals, 3)
  assert.equal(b.exit_retry_after, '2026-09-28T15:30:00.000Z')
})

test('B-1: US-stock daily sessions (Mon–Fri 13:30–20:00), refused inside the session — 30 min, not the next day\'s open', async () => {
  const b = await threeMarketClosedRefusals([1, 2, 3, 4, 5].map(d => ({ startSecond: d * DAY + 13.5 * 3600, endSecond: d * DAY + 20 * 3600 })), Date.UTC(2026, 8, 28, 15, 0))
  assert.equal(b.exit_retry_after, '2026-09-28T15:30:00.000Z')
})

// A DISAGREEMENT CASE, not the production path (nit round N-1): the injected
// hours check says OPEN while the symbol_hours row says CLOSED. In
// production both read the same row, so a send never happens here — see the
// real-schedule test below.
test('B-1 disagreement case (injected hours check OPEN, schedule CLOSED): the schedule\'s next open, capped at now + 2 h', async () => {
  const us = [1, 2, 3, 4, 5].map(d => ({ startSecond: d * DAY + 13.5 * 3600, endSecond: d * DAY + 20 * 3600 }))
  // Mon 21:00Z: next open Tue 13:30Z is 16.5 h away → capped at 23:00Z.
  let b = await threeMarketClosedRefusals(us, Date.UTC(2026, 8, 28, 21, 0))
  assert.equal(b.exit_retry_after, '2026-09-28T23:00:00.000Z')
  // Mon 12:30Z: next open 13:30Z is inside the cap → the open itself.
  b = await threeMarketClosedRefusals(us, Date.UTC(2026, 8, 28, 12, 30))
  assert.equal(b.exit_retry_after, '2026-09-28T13:30:00.000Z')
})

test('N-1 production path (real symbol_hours, nothing injected): schedule closed → no send, the row stays exit_pending; schedule open → a refusal waits 30 min', async () => {
  const db = fresh()
  bookRow(db)
  db.prepare(`INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES ('KO.US', ?, 'UTC')`).run(JSON.stringify([1, 2, 3, 4, 5].map(d => ({ startSecond: d * DAY + 13.5 * 3600, endSecond: d * DAY + 20 * 3600 }))))
  db.prepare(`UPDATE momentum_book SET note = 'exit_pending: MARKET_CLOSED', exit_refusals = 2`).run()
  const f = fakes()
  delete f.deps.isSymbolOpen
  delete f.deps.nextBrokerOpen
  refusing(f, 'MARKET_CLOSED')
  // Mon 21:00Z: the schedule says closed — F2 defers, nothing is sent.
  const closed = await run(db, f, Date.UTC(2026, 8, 28, 21, 0), { entriesHeld: 'Scan disabled' })
  assert.equal(f.calls.close.length, 0, JSON.stringify(closed.skipped))
  let b = bookRowFull(db)
  assert.equal(b.status, 'open')
  assert.equal(b.note, 'exit_pending: MARKET_CLOSED')
  assert.equal(b.exit_refusals, null, 'item 2: the closure clears the refusal record — a deferral is not a refusal, and the count does not carry over')
  assert.equal(closed.deferredClosed, 1)
  // Tue 15:00/15:05/15:10Z: the schedule says open — each pass sends once and
  // is refused; the count starts again at 1 and the 3rd waits 30 min.
  for (const [i, m] of [0, 5, 10].entries()) {
    await run(db, f, Date.UTC(2026, 8, 29, 15, m), { entriesHeld: 'Scan disabled' })
    assert.equal(f.calls.close.length, i + 1)
  }
  b = bookRowFull(db)
  assert.equal(b.exit_refusals, 3)
  assert.equal(b.exit_retry_after, '2026-09-29T15:40:00.000Z')
})

// ---------------------------------------------------------------------------
// S-2 small round, item 2: "consecutive refusals" are consecutive WHILE THE
// MARKET IS OPEN. A closed-market deferral clears the refusal record.
// ---------------------------------------------------------------------------
test('item 2: two refusals, a closure, the reopen — the first refusal after it is the 1st (no backoff), not the 3rd', async () => {
  const db = fresh()
  bookRow(db)
  let hours = OPEN
  const f = fakes({ hours: (s, at) => hours(s, at) })
  refusing(f)
  const held = { entriesHeld: 'Scan disabled' }
  const t = (m) => DUE + m * 60_000
  await run(db, f, t(0), held)
  await run(db, f, t(5), held)
  assert.equal(bookRowFull(db).exit_refusals, 2)
  hours = CLOSED
  const r = await run(db, f, t(10), held)
  assert.equal(r.deferredClosed, 1)
  assert.equal(f.calls.close.length, 2, 'nothing sent while closed')
  let b = bookRowFull(db)
  assert.equal(b.exit_refusals, null, 'the closure cleared the count')
  assert.equal(b.exit_retry_after, null)
  assert.match(b.note, /^exit_pending:/, 'still owed')
  hours = OPEN
  await run(db, f, t(15), held)
  b = bookRowFull(db)
  assert.equal(f.calls.close.length, 3)
  assert.equal(b.exit_refusals, 1, 'the first refusal after the reopen is the 1st')
  assert.equal(b.exit_retry_after, null, 'and waits no backoff')
  await run(db, f, t(20), held)
  assert.equal(f.calls.close.length, 4, 'retried on the very next pass')
})

test('item 2: a closure inside a backoff window clears the backoff — the reopen sends at once', async () => {
  const db = fresh()
  bookRow(db)
  let hours = OPEN
  const f = fakes({ hours: (s, at) => hours(s, at) })
  refusing(f)
  const held = { entriesHeld: 'Scan disabled' }
  const t = (m) => DUE + m * 60_000
  for (const m of [0, 5, 10]) await run(db, f, t(m), held)
  assert.equal(bookRowFull(db).exit_retry_after, new Date(t(40)).toISOString(), 'three refusals: backing off to t+40')
  hours = CLOSED
  await run(db, f, t(15), held)
  assert.equal(bookRowFull(db).exit_retry_after, null, 'the closure cleared the backoff inside its window')
  hours = OPEN
  await run(db, f, t(20), held)
  assert.equal(f.calls.close.length, 4, 'sent at the reopen, not held until t+40')
  assert.equal(bookRowFull(db).exit_refusals, 1)
})

test('N-2: the close resolves and the exit_sent UPDATE throws — no refusal recorded, no exit_pending, no re-send', async () => {
  const db = fresh()
  bookRow(db)
  db.exec(`CREATE TRIGGER fail_exit_sent BEFORE UPDATE OF status ON momentum_book WHEN NEW.status = 'exit_sent' BEGIN SELECT RAISE(ABORT, 'disk full'); END`)
  const f = fakes()
  const r = await run(db, f, DUE)
  assert.equal(f.calls.close.length, 1, 'the close went')
  assert.equal(r.exits, 0, 'the row never reached exit_sent, so it is not counted')
  assert.ok(r.skipped.some(s => s.includes('KO.US: close sent; post-send record failed (row not marked exit_sent) — disk full')), JSON.stringify(r.skipped))
  assert.ok(!r.skipped.some(s => /close failed/.test(s)), 'not a refused close')
  const b = bookRowFull(db)
  assert.equal(b.status, 'open')
  assert.doesNotMatch(String(b.note), /^exit_pending:/, 'not flagged for the every-pass retry')
  assert.equal(b.exit_refusals, null)
  // The next pass (not due) does not send it again.
  await run(db, f, DUE + 5 * 60_000)
  assert.equal(f.calls.close.length, 1, 'no re-send')
})

test('N-b: a post-send record failure has its own skip reason, counts as an exit, and leaves the row exit_sent with no refusal', async () => {
  const db = fresh()
  bookRow(db)
  const f = fakes()
  f.deps.recordPositionEvent = () => { throw new Error('journal down') }
  const r = await run(db, f, DUE)
  assert.equal(f.calls.close.length, 1)
  assert.equal(r.exits, 1, 'the close went, so it is an exit')
  assert.ok(r.skipped.some(s => s.includes('KO.US: close sent; post-send record failed — journal down')), JSON.stringify(r.skipped))
  assert.ok(!r.skipped.some(s => /close failed/.test(s)), 'not reported as a failed close')
  const b = bookRowFull(db)
  assert.equal(b.status, 'exit_sent')
  assert.equal(b.note, 'rank exit (daily pass)')
  assert.equal(b.exit_refusals, null)
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

// ---------------------------------------------------------------------------
// S-2 small round, item 1: the book runs even when a phase before it throws.
// runLoop has no injection point, so the mechanism is exercised through
// thenAlways (its own tests: agent/lib/then-always.test.js) with the REAL
// book, and the loop's use of it is pinned from the parsed source.
// ---------------------------------------------------------------------------
function findAll(root, pred) {
  const out = []
  const stack = []
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (pred(node)) out.push({ node, parents: [...stack] })
    stack.push(node)
    for (const k of Object.keys(node)) {
      const v = node[k]
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v.type === 'string') visit(v)
    }
    stack.pop()
  }
  visit(root)
  return out
}
const namedCall = (name) => (n) => n.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === name

test('item 1: a phase before the book throws — the real book still sends its exit, takes no entry, and the error reaches the cycle unchanged', async () => {
  const db = fresh({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 } } })
  bookRow(db)
  const f = fakes()
  const boom = new Error('runMonitorPhase: cannot read properties of undefined')
  let bookEntriesHeld = null   // the scan ran this cycle; then the monitor phase threw
  let summary = null
  // The two closures have the loop's shape (pinned below): the pre-book
  // region throws; the book closure holds entries and runs the book.
  await assert.rejects(thenAlways(
    async () => { throw boom },
    async (preBookError) => {
      if (preBookError) bookEntriesHeld = `the cycle errored before the book — ${String(preBookError.message || preBookError).slice(0, 160)}`
      summary = await run(db, f, DUE, { entriesHeld: bookEntriesHeld })
    },
  ), (err) => err === boom, 'the cycle catch receives the same error')
  assert.equal(f.calls.close.length, 1, `the exit went out: ${JSON.stringify(summary?.skipped)}`)
  assert.equal(row(db).status, 'exit_sent')
  assert.deepEqual(f.calls.autoTrade, [], 'no entry on a cycle that errored')
  assert.match(summary.entriesHeld, /^the cycle errored before the book — runMonitorPhase: cannot read/)
})

test('item 1 wiring: loop.js runs the pre-book region and the book through ONE awaited thenAlways inside the cycle try — the named phases before, the book after, entries held on an error', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
  const ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true })
  const calls = findAll(ast, namedCall('thenAlways'))
  assert.equal(calls.length, 1, 'one thenAlways call')
  const { node: call, parents } = calls[0]
  assert.equal(parents.at(-1).type, 'AwaitExpression', 'awaited: the rethrow reaches the cycle catch, and what follows waits for the book')
  assert.ok(parents.some(p => p.type === 'FunctionDeclaration' && p.id?.name === 'runLoop'), 'inside runLoop')
  const cycleTry = parents.filter(p => p.type === 'TryStatement').at(-1)
  assert.ok(cycleTry?.handler && /cycleErrored = true/.test(src.slice(cycleTry.handler.start, cycleTry.handler.end)), 'inside the cycle try, whose catch accounts for the error')
  const [before, after] = call.arguments
  assert.ok(before?.type === 'ArrowFunctionExpression' && before.async, 'the pre-book region is the first closure')
  assert.ok(after?.type === 'ArrowFunctionExpression' && after.async, 'the book is the second closure')
  // The unguarded phases the refute named are all in the pre-book region.
  for (const name of ['rankHotSymbols', 'llmBlocked', 'runMonitorPhase', 'runMomentumShadow']) {
    assert.ok(findAll(before.body, namedCall(name)).length >= 1, `${name} is before the book, inside the first closure`)
  }
  assert.ok(findAll(before.body, n => n.type === 'CallExpression' && src.slice(n.callee.start, n.callee.end) === 's.insertScan.run').length >= 1, 'the scan persist is inside the first closure')
  // A `return` in the pre-book region would end the closure, not the cycle,
  // and run the book and the rest of the cycle after it — none is allowed.
  const FN = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
  const returns = []
  const walkOwn = (n) => {
    if (!n || typeof n.type !== 'string' || FN.has(n.type)) return
    if (n.type === 'ReturnStatement') returns.push(src.slice(n.start, n.end))
    for (const k of Object.keys(n)) { const v = n[k]; if (Array.isArray(v)) v.forEach(walkOwn); else if (v && typeof v.type === 'string') walkOwn(v) }
  }
  before.body.body.forEach(walkOwn)
  assert.deepEqual(returns, [], 'no return in the pre-book region')
  // The book: once, in the second closure only.
  const books = findAll(ast, namedCall('runMomentumBook'))
  assert.equal(books.length, 1)
  assert.ok(books[0].parents.includes(after), 'the book call is inside the second closure')
  // An errored cycle holds entries, before the book runs.
  const param = after.params[0]?.name
  assert.ok(param, 'the book closure takes the pre-book error')
  const stmts = after.body.body
  const guard = stmts.findIndex(st => st.type === 'IfStatement' && st.test.type === 'Identifier' && st.test.name === param &&
    st.consequent.type === 'ExpressionStatement' && st.consequent.expression.type === 'AssignmentExpression' && st.consequent.expression.left.name === 'bookEntriesHeld')
  assert.ok(guard >= 0, 'if (<the error>) bookEntriesHeld = …')
  assert.ok(guard < stmts.findIndex(st => books[0].parents.includes(st)), 'set before the book runs')
  // The partial-TP1 pass follows the book, outside thenAlways.
  const partial = findAll(ast, namedCall('runMomentumPartialPass'))
  assert.equal(partial.length, 1)
  assert.ok(!partial[0].parents.includes(call) && partial[0].node.start > call.end, 'after thenAlways, not inside it')
})

// ---------------------------------------------------------------------------
// S-2 small round, item 3: the hold line prints on a held exit or a changed
// reason, not on every cycle of a weekend.
// ---------------------------------------------------------------------------
test('item 3: bookHoldLogLine — printed when an exit is held this pass or the entries-held reason changes; silent otherwise', () => {
  let last = null
  const step = (summary) => { const r = bookHoldLogLine(summary, last); last = r.reason; return r.line }
  const quiet = { ran: true, deferredClosed: 0, entriesHeld: 'weekend quiet with nothing to scan' }
  assert.equal(step(quiet), 'momentum book: 0 exit(s) held for a closed market (exit_pending); entries held — weekend quiet with nothing to scan', 'the reason appears: printed')
  for (let i = 0; i < 5; i++) assert.equal(step(quiet), null, `cycle ${i + 2} of the weekend, the same reason, nothing held: silent`)
  assert.match(step({ ...quiet, deferredClosed: 2 }), /^momentum book: 2 exit\(s\) held for a closed market/, 'an exit held this pass: printed')
  assert.equal(step(quiet), null)
  assert.match(step({ ...quiet, entriesHeld: 'Scan disabled' }), /; entries held — Scan disabled$/, 'the reason changes: printed')
  assert.match(step({ ran: true, deferredClosed: 0 }), /; entries no longer held$/, 'the reason clears: printed once')
  assert.equal(step({ ran: true, deferredClosed: 0 }), null, 'clean cycles: silent')
  assert.equal(step({ ran: false, why: 'disabled' }), null, 'a book that did not run prints nothing')
  assert.match(step({ ran: true, deferredClosed: 1 }), /^momentum book: 1 exit\(s\) held for a closed market \(exit_pending\)$/, 'a held exit with entries free: no tail')
})

test('item 3 wiring: the loop prints only what bookHoldLogLine returns and keeps the reason across cycles', () => {
  const code = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '')
  assert.match(code, /const hold = bookHoldLogLine\(mb, lastBookHeldReason\)\s+if \(hold\.line\) log\(hold\.line\)\s+lastBookHeldReason = hold\.reason/)
  assert.match(code, /^let lastBookHeldReason = null$/m, 'module state: it outlives the cycle')
  assert.doesNotMatch(code, /exit\(s\) held for a closed market/, 'no second, unconditional copy of the line')
})
