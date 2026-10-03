// node --test agent/services/exit-hours.test.js
//
// 27-09 follow-up (1), 03-10-2026: the exit deferral reads the ACCOUNT
// CALENDAR — the source S-8 entries read, holidays included — not the
// name-keyed weekly schedule. Each behaviour test drives the REAL book path
// with no injected hours reader over a real in-memory calendar.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import { recordMarketCalendar } from './market-calendar.js'
import { isSymbolOpenCached } from './symbol-hours.js'
import { exitMarketHours, exitMayDefer, exitHoursSourceLabel, EXIT_DEFERRING_SOURCES } from './exit-hours.js'
import { MOMENTUM_ACCOUNT_KEY, MOMENTUM_UNIVERSE_KEY } from './momentum-account.js'
import { runMomentumBook, MOMENTUM_BOOK_CONFIG_KEY, TSMOM_STRATEGY, _resetDeferredClosedForTests } from './momentum-book.js'
import { MOMENTUM_SHADOW_STATE_KEY } from './momentum-shadow.js'
import { setStage } from './stage-matrix.js'

const D = 86400, H = 3600
const HOST = 'demo.ctraderapi.com'
const dayNo = iso => Date.parse(`${iso}T00:00:00Z`) / 86400_000
// A 24×5 schedule in UTC (Mon 00:00 → Sat 00:00), so only the HOLIDAY can
// close the Friday under test; the name-keyed row carries the same hours.
const ALL_WEEK = [{ startSecond: 1 * D, endSecond: 6 * D }]
const FRI = Date.UTC(2026, 8, 25, 21, 5, 40)   // Fri 25-09-2026 21:05:40Z
const THU = Date.UTC(2026, 8, 24, 12, 0)       // Thu 24-09-2026 12:00Z
const HOLIDAY_FRI = { holidayId: 9, name: 'Test holiday', scheduleTimeZone: 'UTC', holidayDate: dayNo('2026-09-25'), isRecurring: false, startSecond: 0, endSecond: D }

/** The account's own map and calendar for `symbol` (symbolId 1), observed `observedMs`. */
function calendar(db, { accountId, symbol, holiday = [HOLIDAY_FRI], observedMs }) {
  setState(db, accountSymbolMapKey(accountId), JSON.stringify({ builtAt: new Date(observedMs).toISOString(), accountId, map: { [symbol]: 1 } }))
  recordMarketCalendar(db, { host: HOST, accountId, symbolId: '1' }, { symbolId: 1, scheduleTimeZone: 'UTC', tradingMode: 0, schedule: ALL_WEEK, holiday }, { nowMs: observedMs })
}
function symbolHoursRow(db, symbol) {
  db.prepare('INSERT INTO symbol_hours (symbol, schedule_json, tz) VALUES (?, ?, ?)')
    .run(symbol, JSON.stringify(ALL_WEEK.map(i => ({ start: i.startSecond, end: i.endSecond }))), 'UTC')
}

// ---------------------------------------------------------------------------
// The reading itself.
// ---------------------------------------------------------------------------
test('a holiday on the account calendar reads CLOSED (account_calendar) where the name-keyed schedule reads OPEN; exitMayDefer says so', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('4242','1',0,1,'active')`).run()
  calendar(db, { accountId: '4242', symbol: 'KO.US', observedMs: FRI - H * 1000 })
  symbolHoursRow(db, 'KO.US')
  assert.equal(isSymbolOpenCached(db, 'KO.US', new Date(FRI)).open, true, 'the pre-S-8 reader: weekly schedule only, holiday ignored')
  const h = exitMarketHours(db, { symbol: 'KO.US', accountId: '4242', now: new Date(FRI) })
  assert.equal(h.open, false, 'RED if the exit path ignores the holiday')
  assert.equal(h.source, 'account_calendar')
  assert.equal(h.calendarReason, 'broker_holiday')
  assert.equal(exitMayDefer(h), true)
  assert.equal(exitHoursSourceLabel(h), 'account calendar')
  // The day before (observed before that read, inside the 24 h freshness
  // bound): the same calendar reads OPEN, from the same source.
  calendar(db, { accountId: '4242', symbol: 'KO.US', observedMs: THU - H * 1000 })
  const open = exitMarketHours(db, { symbol: 'KO.US', accountId: '4242', now: new Date(THU) })
  assert.equal(open.open, true)
  assert.equal(open.source, 'account_calendar')
  assert.equal(exitMayDefer(open), false)
  assert.deepEqual([...EXIT_DEFERRING_SOURCES], ['account_calendar', 'broker'])
})

test('UNKNOWN on the account calendar never holds an exit: the name-keyed schedule answers, named as such', () => {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('4242','1',0,1,'active')`).run()
  symbolHoursRow(db, 'KO.US')
  // No account symbol map → UNKNOWN → the symbol_hours row (source 'broker').
  const noMap = exitMarketHours(db, { symbol: 'KO.US', accountId: '4242', now: new Date(FRI) })
  assert.equal(noMap.open, true)
  assert.equal(noMap.source, 'broker')
  assert.equal(noMap.calendarReason, 'account_symbol_map_missing')
  // No account at all (a row with no account_id): the same fallback.
  const noAcct = exitMarketHours(db, { symbol: 'KO.US', now: new Date(FRI) })
  assert.equal(noAcct.source, 'broker')
  assert.equal(noAcct.calendarReason, 'account_required')
  // A broker-schedule CLOSED from the fallback still defers (the pre-S-8 rule).
  const sat = exitMarketHours(db, { symbol: 'KO.US', accountId: '4242', now: new Date(Date.UTC(2026, 8, 26, 12)) })
  assert.equal(sat.open, false); assert.equal(sat.source, 'broker'); assert.equal(exitMayDefer(sat), true)
  assert.equal(exitHoursSourceLabel(sat), 'broker schedule')
  // The heuristic (no row) and an error never defer.
  assert.equal(exitMayDefer({ open: false, source: 'heuristic' }), false)
  assert.equal(exitMayDefer({ open: false, source: 'error' }), false)
  assert.equal(exitMayDefer(null), false)
})

// ---------------------------------------------------------------------------
// The daily path (momentum-account.js exitDroppedHoldings, `_all`): the F2
// deferral with NO injected hours reader, over the real calendar.
// ---------------------------------------------------------------------------
const ACC = '46130058'
function dailyRig() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${ACC}','1',0,1,'active')`).run()
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: '_all', volTargetPct: 10, maxPositions: 8 }))
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['KO.US', 'BTCUSD'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: {}, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: ACC }, { getState, setState })
  const tradeId = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, label_strategy, strategy, account_id, origin, ctrader_position_id, volume, opened_at) VALUES ('KO.US','BUY','open',60,55,?,?,?,'bot_market_dispatch','pos-KO.US',1,'2026-09-10 14:00:00')`)
    .run(TSMOM_STRATEGY, TSMOM_STRATEGY, ACC).lastInsertRowid
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note) VALUES (?, ?, 'KO.US', 'pos-KO.US', 'long', 60, 55, 1, 0.9, ?, 'open', 'test row')`)
    .run(tradeId, ACC, new Date(FRI - 10 * D * 1000).toISOString())
  const calls = { close: [] }
  const deps = {
    symbolMap: { 'KO.US': 1, BTCUSD: 2 },
    symbolIdFor: async (_c, s) => ({ 'KO.US': 1, BTCUSD: 2 })[s] ?? null,
    volumeMeta: async () => ({ lotSize: 100, minVolume: 1, stepVolume: 1, digits: 2 }),
    bars: async () => Array.from({ length: 30 }, (_, i) => ({ t: i, o: 60, h: 60.5, l: 59.5, c: 60 })),
    spot: async () => ({ bid: 59.99, ask: 60 }),
    equity: () => 100_000, rates: () => null, atrOf: () => 1,
    mayTrade: () => ({ ok: true, item: null }),
    close: async (_c, args) => { calls.close.push(args); return {} },
    positionVolume: async () => 100, amend: async () => ({}), phasesOn: () => true,
    autoTrade: async () => null,
    // NO isSymbolOpen: the real exit-hours reader runs.
  }
  const run = (now) => runMomentumBook(db, { accounts: [{ accountId: ACC, isLive: false }], credsFor: (a) => ({ accountId: a.accountId }), deps, now })
  const row = () => db.prepare(`SELECT status, note FROM momentum_book WHERE symbol = 'KO.US'`).get()
  return { db, calls, run, row }
}

test('daily path: a holiday on the account calendar holds the rank exit (exit_pending, no broker call) although the name-keyed schedule says open; when the calendar says open it is sent', async () => {
  const { db, calls, run, row } = dailyRig()
  symbolHoursRow(db, 'KO.US')
  calendar(db, { accountId: ACC, symbol: 'KO.US', observedMs: FRI - H * 1000 })
  let r = await run(FRI)
  assert.equal(calls.close.length, 0, `RED if the exit went to the broker on the holiday: ${JSON.stringify(r.skipped)}`)
  assert.equal(r.deferredClosed, 1)
  assert.equal(row().status, 'open')
  assert.match(row().note, /^exit_pending: market closed \(account calendar\)/)
  // The holiday is over by the calendar's reading (a fresh observation,
  // no holiday row): the owed exit goes on this pass.
  const later = FRI + 16 * H * 1000 // Sat 13:05Z, inside the 24×5 window? no — Sat is closed by schedule
  assert.equal(exitMarketHours(db, { symbol: 'KO.US', accountId: ACC, now: new Date(later) }).open, false, 'Saturday: closed by the schedule itself')
  const mon = Date.UTC(2026, 8, 28, 13, 35)
  calendar(db, { accountId: ACC, symbol: 'KO.US', holiday: [], observedMs: mon - H * 1000 })
  r = await run(mon)
  assert.equal(calls.close.length, 1, `sent when the account calendar says open: ${JSON.stringify(r.skipped)}`)
  assert.equal(row().status, 'exit_sent')
})

test('daily path: with no account calendar the pre-S-8 reading stands — the exit of an open (schedule) market is sent', async () => {
  const { calls, run, row, db } = dailyRig()
  symbolHoursRow(db, 'KO.US')
  const r = await run(FRI)
  assert.equal(calls.close.length, 1, `UNKNOWN never holds an exit: ${JSON.stringify(r.skipped)}`)
  assert.equal(row().status, 'exit_sent')
})

// ---------------------------------------------------------------------------
// The row-cursor path (momentum-book.js, an account of its own): the same
// deferral, no injected reader.
// ---------------------------------------------------------------------------
test('row-cursor path: a holiday on the account calendar defers the rank exit (one line naming account_calendar); no broker call', async () => {
  _resetDeferredClosedForTests()
  const DEMO = '111'
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${DEMO}','1',0,1,'active')`).run()
  setState(db, 'symbol_id_map', JSON.stringify({ BTCUSD: 1 }))
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true, bookExitCadence: 'every_pass' }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  const shadowRow = (action, at) => db.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, timeframe, universe, applied, at) VALUES ('BTCUSD', ?, 'long', 1, 9, 100, '1d', 20, 0, ?)`).run(action, new Date(at).toISOString())
  const calls = { close: [] }
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 100, h: 101 + i * 0.1, l: 99 + i * 0.1, c: 100 + i * 0.1 }))
  const deps = {
    symbolMap: { BTCUSD: 1 },
    bars: async () => bars,
    spot: async () => ({ bid: 102.9, ask: 103 }),
    amend: async (_c, args) => ({ protection: { stopLoss: args.stopLoss, takeProfit: args.takeProfit, verified: true, source: 'broker_reconcile', readStartedAtMs: Date.now(), checkedAtMs: Date.now(), readDurationMs: 0 } }),
    close: async (_c, args) => { calls.close.push(args); return {} },
    positionVolume: async () => 1000, phasesOn: () => true,
    mayTrade: () => ({ ok: true, item: null }),
    autoTrade: async (db, symbol, synth, _w, acct) => {
      const t = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES (?,'BUY','open',?,?,?,?,?,?,'bot_market_dispatch',?,datetime('now'))`)
        .run(symbol, synth.entry, synth.sl, synth.entry + 10, synth.strategy, synth.strategy, acct.accountId, `pos-${symbol}-${acct.accountId}`)
      db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, account_id, status, source) VALUES (?, ?, 'long', ?, ?, ?, ?, 'active', 'autopilot')`).run(symbol, t.lastInsertRowid, synth.entry, synth.sl, synth.entry + 10, acct.accountId)
      return { side: 'BUY', tradeId: t.lastInsertRowid }
    },
  }
  const accounts = [{ accountId: DEMO, isLive: false }]
  const credsFor = (a) => ({ accountId: a.accountId, host: 'demo' })
  symbolHoursRow(db, 'BTCUSD')
  calendar(db, { accountId: DEMO, symbol: 'BTCUSD', observedMs: THU - H * 1000 })
  shadowRow('enter', THU)
  await runMomentumBook(db, { accounts, credsFor, deps, now: THU })
  assert.equal(db.prepare(`SELECT COUNT(*) AS c FROM momentum_book WHERE status = 'open'`).get().c, 1, 'the book entered')
  shadowRow('exit', FRI - 60_000)
  // Fresh observation for the Friday read (the 24 h freshness bound).
  calendar(db, { accountId: DEMO, symbol: 'BTCUSD', observedMs: FRI - H * 1000 })
  const lines = []
  const r = await runMomentumBook(db, { accounts, credsFor, deps, now: FRI, log: (l) => lines.push(l) })
  assert.equal(calls.close.length, 0, `RED if the row-cursor exit went to the broker on the holiday: ${JSON.stringify(r.skipped)}`)
  assert.equal(r.deferredClosed, 1)
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'open')
  assert.equal(lines.filter(l => /deferred — market closed \(account_calendar\)/.test(l)).length, 1, lines.join('\n'))
})

// ---------------------------------------------------------------------------
// The position manager's hold (loop.js, #1186) asks the same reader.
// ---------------------------------------------------------------------------
test('wiring pin: the closed-market hold asks exitMarketHours for the position\'s own account, not the name-keyed schedule', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  const call = src.indexOf('runWithClosedMarketHold({')
  assert.ok(call > 0)
  const block = src.slice(call, call + 500)
  assert.match(block, /isOpen: \(\) => exitMarketHours\(db, \{ symbol: pos\.symbol, accountId: pos\.account_id \}\)\.open === true/)
  assert.ok(!/isOpen: \(\) => isSymbolOpenCached/.test(block), 'the hold reads the account calendar, not symbol_hours')
})
