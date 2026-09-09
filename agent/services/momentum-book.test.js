// node --test agent/services/momentum-book.test.js
//
// The long-only TS momentum book (owner order 03-09-2026). Pinned: the pure
// arithmetic (ATR, the stop that only rises, the synth with no target and
// marketOnly); the cycle against an in-memory DB with fake broker calls —
// off writes nothing; a shadow long entry becomes one autoTrade per armed
// account with the keeper paused and a book row; a shadow exit closes the
// position; the trail ratchets up and never down; an account with the
// strategy not armed, or autotrade off, is skipped; the report reads it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import { setStage } from './stage-matrix.js'
import {
  atrOf, trailStop, buildEntrySynth, momentumBookConfig, runMomentumBook, momentumBookReport,
  MOMENTUM_BOOK_CONFIG_KEY, MOMENTUM_BOOK_STATE_KEY, TSMOM_STRATEGY, DEFAULT_MOMENTUM_BOOK, RECONCILE_EVERY_MS,
} from './momentum-book.js'
import { bookCloseVolume } from './book-close-volume.js'
import { MOMENTUM_SHADOW_STATE_KEY } from './momentum-shadow.js'

const DEMO = '111', LIVE = '222'
const cfg = momentumBookConfig({ enabled: true })

test('off by default; config repairs nonsense', () => {
  assert.equal(DEFAULT_MOMENTUM_BOOK.enabled, false)
  assert.equal(momentumBookConfig({ enabled: 'yes' }).enabled, false)
  const c = momentumBookConfig({ atrPeriod: 1, stopAtr: 50, maxPositionsPerAccount: 0 })
  assert.deepEqual([c.atrPeriod, c.stopAtr, c.maxPositionsPerAccount], [5, 10, 1])
})

test('ATR, the stop that only rises, and the entry synth with no target', () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 100, h: 101 + i * 0.1, l: 99 + i * 0.1, c: 100 + i * 0.1 }))
  const a = atrOf(bars, 20)
  assert.ok(a > 1.9 && a < 2.2, `ATR ≈ 2 (range 2 + gap 0.1), got ${a}`)
  assert.equal(atrOf(bars.slice(0, 10), 20), null, 'thin bars → null, never a number')
  assert.equal(trailStop({ prevStop: 90, close: 100, atr: 2, stopAtr: 3 }), 94)
  assert.equal(trailStop({ prevStop: 95, close: 100, atr: 2, stopAtr: 3 }), 95, 'never lowers')
  assert.equal(trailStop({ prevStop: null, close: 100, atr: 2, stopAtr: 3 }), 94)
  assert.equal(trailStop({ prevStop: 95, close: NaN, atr: 2, stopAtr: 3 }), 95, 'no price → the stop stands')
  const s = buildEntrySynth({ symbol: 'BTCUSD', price: 77000, atr: 1500, cfg, conviction: 9, rankPct: 1 })
  assert.equal(s.consensus_bias, 'long')
  assert.equal(s.entry, 77000)
  assert.equal(s.sl, 77000 - 3 * 1500)
  assert.equal(s.tp1, null, 'no target: the exit is the ranking or the stop')
  assert.equal(s.strategy, TSMOM_STRATEGY)
  assert.equal(s.marketOnly, true)
  assert.equal(s.auto_trade, true)
  assert.equal(s.overall_conviction, 9)
  assert.equal(buildEntrySynth({ symbol: 'X', price: 10, atr: 5, cfg }), null, 'a stop at or below zero is not a trade')
})

function fresh() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${DEMO}','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${LIVE}','2',1,1,'active')`).run()
  setState(db, 'symbol_id_map', JSON.stringify({ BTCUSD: 1, NATGAS: 2 }))
  return db
}
function shadowRow(db, { symbol, action, side = 'long', rank = 1, conviction = 9, price = 100, at = new Date().toISOString() }) {
  // `at` is ISO, as the shadow writes it (momentum-shadow.js: new Date(now).toISOString()).
  return db.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, timeframe, universe, applied, at) VALUES (?, ?, ?, ?, ?, ?, '1d', 20, 0, ?)`).run(symbol, action, side, rank, conviction, price, at).lastInsertRowid
}
function fakes({ fill = true } = {}) {
  const calls = { autoTrade: [], amend: [], close: [] }
  const bars = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 100, h: 101 + i * 0.1, l: 99 + i * 0.1, c: 100 + i * 0.1 }))
  return {
    calls, bars,
    deps: {
      symbolMap: { BTCUSD: 1, NATGAS: 2 },
      bars: async () => bars,
      spot: async () => ({ bid: 102.9, ask: 103 }),
      amend: async (_c, args) => { calls.amend.push(args); return {} },
      close: async (_c, args) => { calls.close.push(args); return {} },
      positionVolume: async () => 1000,
      phasesOn: () => true,
      mayTrade: () => ({ ok: true, item: null }),
      autoTrade: async (db, symbol, synth, _w, acct) => {
        calls.autoTrade.push({ symbol, synth, acct })
        if (!fill) return null
        const t = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES (?,'BUY','open',?,?,NULL,?,?,?,'bot_market_dispatch',?,datetime('now'))`)
          .run(symbol, synth.entry, synth.sl, synth.strategy, synth.strategy, acct.accountId, `pos-${symbol}-${acct.accountId}`)
        db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, account_id, status, source) VALUES (?, ?, 'long', ?, ?, ?, 'active', 'autopilot')`).run(symbol, t.lastInsertRowid, synth.entry, synth.sl, acct.accountId)
        return { side: 'BUY', tradeId: t.lastInsertRowid }
      },
    },
  }
}
const accounts = [{ accountId: DEMO, isLive: false }, { accountId: LIVE, isLive: true }]
const credsFor = (a) => ({ accountId: a.accountId, host: a.isLive ? 'live' : 'demo' })

test('disabled: nothing runs, nothing written', async () => {
  const db = fresh()
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  assert.deepEqual(await runMomentumBook(db, { accounts, credsFor, deps: f.deps }), { ran: false, why: 'disabled' })
  assert.equal(f.calls.autoTrade.length, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book`).get().n, 0)
})

test('a shadow long entry becomes one autoTrade per ARMED account, with the keeper paused and a book row; short rows are never read', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const io = { getState, setState }
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, io)
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: LIVE }, io)
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', rank: 0.95, conviction: 9 })
  shadowRow(db, { symbol: 'NATGAS', action: 'enter', side: 'short', rank: 0.05, conviction: 9 })
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.equal(r.ran, true)
  assert.equal(r.accounts, 2)
  assert.equal(r.entries, 2, `one long per armed account; the short row is never a book entry — skipped: ${JSON.stringify(r.skipped)}`)
  assert.deepEqual(f.calls.autoTrade.map(c => [c.symbol, c.acct.accountId, c.acct.isLive]), [['BTCUSD', DEMO, false], ['BTCUSD', LIVE, true]])
  const synth = f.calls.autoTrade[0].synth
  assert.equal(synth.entry, 103, 'priced at the live ask, not the bar close')
  assert.equal(synth.tp1, null)
  assert.equal(synth.marketOnly, true)
  assert.equal(synth.strategy, TSMOM_STRATEGY)
  const rows = db.prepare(`SELECT * FROM momentum_book ORDER BY id`).all()
  assert.equal(rows.length, 2)
  assert.ok(rows.every(x => x.status === 'open' && x.side === 'long' && x.trade_id != null && x.position_id.startsWith('pos-BTCUSD')))
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM monitored_positions WHERE paused = 1`).get().n, 2, 'the keeper is paused on book positions')
  assert.equal(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).lastShadowRowId, 2)
  // A second pass with no new shadow rows enters nothing and does not re-enter the open name.
  const r2 = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_100_000 })
  assert.equal(r2.entries, 0)
  assert.equal(f.calls.autoTrade.length, 2)
})

test('accounts where tsmom_long is not armed, or autotrade is off, are skipped; the cap holds; an unfilled autoTrade leaves no row', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true, maxPositionsPerAccount: 1 }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  shadowRow(db, { symbol: 'NATGAS', action: 'enter' })
  const f = fakes()
  let r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps })
  assert.equal(r.accounts, 1, 'LIVE is not armed')
  assert.equal(r.entries, 1, 'the cap of 1 holds')
  assert.ok(r.skipped.some(s => /maxPositionsPerAccount/.test(s)))
  // autotrade off on the account → skipped entirely
  const db2 = fresh()
  setState(db2, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db2, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db2, { symbol: 'BTCUSD', action: 'enter' })
  const g = fakes(); g.deps.phasesOn = () => false
  r = await runMomentumBook(db2, { accounts, credsFor, deps: g.deps })
  assert.equal(r.accounts, 0)
  assert.equal(g.calls.autoTrade.length, 0)
  // gate/broker refused → no book row, no pause
  const db3 = fresh()
  setState(db3, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db3, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db3, { symbol: 'BTCUSD', action: 'enter' })
  const h = fakes({ fill: false })
  r = await runMomentumBook(db3, { accounts, credsFor, deps: h.deps })
  assert.equal(r.entries, 0)
  assert.equal(db3.prepare(`SELECT COUNT(*) n FROM momentum_book`).get().n, 0)
})

test('a shadow exit closes the position and marks the row; the trail ratchets the stop up, never down, and a closed trade closes the row', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  const before = db.prepare(`SELECT stop FROM momentum_book`).get().stop
  // Price climbs: the close of the fake bars is 102.9, stop was 103 − 3·ATR. Push the bars up 10 and trail.
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h + 10, l: b.l + 10, c: b.c + 10 }))
  let r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.trailed, 1)
  const after = db.prepare(`SELECT stop FROM momentum_book`).get().stop
  assert.ok(after > before, `stop rose: ${before} → ${after}`)
  assert.equal(f.calls.amend.length, 1)
  assert.equal(f.calls.amend[0].stopLoss, after)
  assert.equal(f.calls.amend[0].takeProfit, null, 'the book states it holds no target — a stop-only amend would clear one at the broker')
  assert.equal(db.prepare(`SELECT sl_price FROM trades`).get().sl_price, after, 'the ledger follows the ratchet')
  assert.equal(db.prepare(`SELECT current_sl FROM monitored_positions`).get().current_sl, after)
  // A target left on the record (a row adopted before the clearing shipped) goes with the amend that clears it at the broker.
  db.prepare(`UPDATE monitored_positions SET current_tp = 999`).run()
  db.prepare(`UPDATE trades SET tp_price = 999`).run()
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h + 20, l: b.l + 20, c: b.c + 20 }))
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_500 })
  assert.equal(r.trailed, 1)
  assert.equal(db.prepare(`SELECT current_tp FROM monitored_positions`).get().current_tp, null, 'the trail clears the recorded target with the broker amend')
  assert.equal(db.prepare(`SELECT tp_price FROM trades`).get().tp_price, null)
  const after2 = db.prepare(`SELECT stop FROM momentum_book`).get().stop
  assert.ok(after2 > after)
  // Price falls back: the stop does NOT follow.
  f.deps.bars = async () => f.bars
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 3_000 })
  assert.equal(r.trailed, 0)
  assert.equal(db.prepare(`SELECT stop FROM momentum_book`).get().stop, after2)
  // Rank exit: the position is closed and the row says why.
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit' })
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 4_000 })
  assert.equal(r.exits, 1)
  assert.equal(f.calls.close.length, 1)
  assert.equal(f.calls.close[0].positionId, `pos-BTCUSD-${DEMO}`)
  assert.equal(f.calls.close[0].volume, 1000, 'the close carries the broker volume — cTrader refuses one without (LLY.US, 09-09-2026)')
  assert.equal(db.prepare(`SELECT status, note FROM momentum_book`).get().status, 'exit_sent')
  // The reconciler closes the trade; the next pass closes the row and the report reads it.
  db.prepare(`UPDATE trades SET status = 'closed', net_pnl = 250, closed_at = datetime('now')`).run()
  db.prepare(`UPDATE momentum_book SET status = 'open'`).run() // simulate a row the reconciler beat to the close
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000 })
  const rep = momentumBookReport(db)
  assert.equal(rep.open.length, 0)
  assert.deepEqual(rep.closed, { n: 1, wins: 1, winRate: 100, profitFactor: null, net: 250 })
  assert.equal(rep.config.enabled, true)
})

test('wiring pins: the loop runs the book after the shadow with the real autoTrade and broker calls injected; the limit branch honours marketOnly (comments stripped)', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const shadow = src.indexOf("import('./services/momentum-shadow.js')")
  const book = src.indexOf("import('./services/momentum-book.js')")
  assert.ok(shadow > 0 && book > shadow, 'the book runs after the shadow')
  const block = src.slice(book, book + 2600)
  assert.ok(block.includes('accounts: getAutopilotAccounts(db)'))
  assert.ok(block.includes('credsFor: (a) => getCtraderCreds(db, a)'))
  assert.ok(block.includes('autoTrade,'))
  assert.ok(block.includes('amend: (creds, args) => exec.amendPosition(creds, { positionId: args.positionId, stopLoss: args.stopLoss, takeProfit: null })'), 'the loop states the book holds no target on every amend')
  assert.ok(block.includes('close: (creds, args) => exec.closePosition(creds, args)'))
  assert.ok(block.includes('positionVolume: async (creds, positionId) => brokerPositionVolume((await exec.reconcile(creds)).position || [], positionId)'), 'the loop hands the book the broker volume for its closes')
  assert.ok(block.includes('phasesOn: (accountId) => !!effectivePhases(db, accountId)?.autotrade'))
  assert.ok(block.includes("digitsFor: async (creds, symbolId) => (await (await import('./lib/lot-sizing.js')).getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)).digits"), 'the loop hands the book the symbol digits the trailed stop is rounded to')
  assert.ok(src.includes("synth.marketOnly !== true && !fresh"), 'a marketOnly synth never rests as a limit')
})

// ---------------------------------------------------------------------------
// 04-09-2026, Railway logs: every trail amend since adoption was refused —
// "Order price = 1053.4199999999998 has more digits than allowed" (LLY.US),
// "Order protection = 344.358 has more digits than symbol allows. Allowed 2
// digits" (GD.US). The book's stop that "only rises" had never risen once.
// ---------------------------------------------------------------------------

test('the trailed stop is rounded to the symbol digits before the amend, and the rounded value is what the ledger stores', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  const askedDigits = []
  f.deps.digitsFor = async (_c, symbolId) => { askedDigits.push(symbolId); return 2 }
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  // Bars shifted by a float-noisy amount: close − 3·ATR carries far more than two decimals.
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h + 10.123456789, l: b.l + 10.123456789, c: b.c + 10.123456789 }))
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.trailed, 1)
  assert.equal(f.calls.amend.length, 1)
  const sent = f.calls.amend[0].stopLoss
  assert.equal(sent, Math.round(sent * 100) / 100, `the amend carries at most two decimals: ${sent}`)
  assert.equal(db.prepare(`SELECT stop FROM momentum_book`).get().stop, sent, 'the book stores what the broker holds')
  assert.equal(db.prepare(`SELECT sl_price FROM trades`).get().sl_price, sent)
  assert.ok(askedDigits.length >= 1 && askedDigits.every(id => id === 1), `digits are asked for THIS symbol id on every pass: ${JSON.stringify(askedDigits)}`)
})

test('without a digits source the raw trailed stop still goes out (the fixture path) — the loop wiring pin above is what guarantees production rounds', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  f.deps.bars = async () => f.bars.map(b => ({ ...b, h: b.h + 10.123456789, l: b.l + 10.123456789, c: b.c + 10.123456789 }))
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.trailed, 1)
  assert.notEqual(f.calls.amend[0].stopLoss, Math.round(f.calls.amend[0].stopLoss * 100) / 100, 'no rounding was applied — proves the digits path is what the first test exercised')
})

// ---------------------------------------------------------------------------
// 03-09-2026: the first production pass read LLY.US at 6.56 on ACCT-LIVE-1
// (1,159.32 on the demos) because one shared symbol map was applied to every
// account, and could not enter an open market at all because the no-target
// bracket tripped guard_no_target. Both are pinned here.
// ---------------------------------------------------------------------------

test('the symbol id is resolved PER ACCOUNT through symbolIdFor(creds, symbol); a null resolution skips the entry with the account named', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const io = { getState, setState }
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, io)
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: LIVE }, io)
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', rank: 0.95, conviction: 9 })
  const f = fakes()
  const asked = []
  const seenIds = []
  f.deps.symbolIdFor = async (creds, symbol) => { asked.push([creds.accountId, symbol]); return creds.accountId === LIVE ? null : 77 }
  f.deps.bars = async (_c, id) => { seenIds.push(id); return f.bars }
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.deepEqual(asked.slice(0, 2), [[DEMO, 'BTCUSD'], [LIVE, 'BTCUSD']], 'each account resolves with ITS OWN creds (the trail pass asks again for the open row)')
  assert.ok(seenIds.length >= 1 && seenIds.every(id => id === 77), `bars (entry and trail) are fetched with the account-resolved id, never the shared map's 1: ${JSON.stringify(seenIds)}`)
  assert.equal(r.entries, 1)
  assert.ok(r.skipped.some(s => s.startsWith(`${LIVE} BTCUSD: not in this account's symbol list`)), JSON.stringify(r.skipped))
  assert.equal(f.calls.autoTrade.length, 1)
  assert.equal(f.calls.autoTrade[0].synth.noTarget, true, 'the no-target bracket is STATED on the synth')
})

test('an open tsmom_long trade with no book row (a resting limit that filled later) is adopted once, keeper paused; an exited row is not re-adopted', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  // The limit path stamps a 1.5R target (3.45) on both rows; the book must clear it at adoption.
  const tid = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES ('NATGAS','BUY','open',3.0,2.7,3.45,?,?,?,'bot_market_dispatch','pos-late',datetime('now'))`)
    .run(TSMOM_STRATEGY, TSMOM_STRATEGY, DEMO).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, account_id, status, source) VALUES ('NATGAS', ?, 'long', 3.0, 2.7, 3.45, ?, 'active', 'autopilot')`).run(tid, DEMO)
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.equal(r.adopted, 1)
  const row = db.prepare(`SELECT * FROM momentum_book WHERE trade_id = ?`).get(tid)
  assert.ok(row && row.status === 'open' && row.position_id === 'pos-late' && row.stop >= 2.7, JSON.stringify(row))
  const mp = db.prepare(`SELECT paused, current_tp FROM monitored_positions WHERE trade_id = ?`).get(tid)
  assert.equal(mp.paused, 1)
  // 04-09-2026: the target-restore sweep reads current_tp and would put the
  // limit's 1.5R target back at the broker after the book's amend cleared it.
  assert.equal(mp.current_tp, null, 'the book holds no target — the record must say so, or the restore sweep re-caps the position')
  assert.equal(db.prepare(`SELECT tp_price FROM trades WHERE id = ?`).get(tid).tp_price, null)
  // second pass: nothing new to adopt
  const r2 = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_100_000 })
  assert.equal(r2.adopted, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book`).get().n, 1)
  // rank exit → exit_sent; the trade row is still 'open' until the reconciler closes it — must NOT be adopted again
  shadowRow(db, { symbol: 'NATGAS', action: 'exit' })
  const r3 = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_200_000 })
  assert.equal(r3.exits, 1)
  assert.equal(r3.adopted, 0)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book`).get().n, 1)
})

// ---------------------------------------------------------------------------
// RECONCILE (owner "build it", 03-09-2026, §7,272·B): the shadow emits `enter`
// only on the flat→long transition, so a held name whose order never filled
// (an expired closed-market limit, a gate refusal that day) was never tried
// again. Every pass re-proposes each held long with no open row and no
// working limit, at most once per symbol per account per RECONCILE_EVERY_MS.
// ---------------------------------------------------------------------------

test('reconcile: a long the shadow holds with no book row and no working limit is re-proposed; throttled per symbol/account; a working limit or an open row blocks it', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  // The shadow holds BTCUSD and NATGAS long; no new enter rows exist (they were consumed earlier).
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: {
    BTCUSD: { side: 'long', entryPrice: 77000, enteredAt: 1, entryRank: 0.95, entryConviction: 9 },
    NATGAS: { side: 'long', entryPrice: 2.9, enteredAt: 1, entryRank: 0.9, entryConviction: 8 },
  }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  // NATGAS already has a resting tsmom limit on this account → must not be stacked.
  db.prepare(`INSERT INTO pending_orders (symbol, timeframe, order_id, dir, level, sl, tp, volume, placed_at, expires_at, status, note, strategy, account_id) VALUES ('NATGAS','1d','o1',1,2.9,2.7,NULL,1,datetime('now'),datetime('now','+1 day'),'working','pending-closed',?,?)`).run(TSMOM_STRATEGY, DEMO)
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.equal(r.reconciled, 1, `only BTCUSD is reconciled: ${JSON.stringify(r.skipped)}`)
  assert.equal(r.entries, 1)
  assert.deepEqual(f.calls.autoTrade.map(c => c.symbol), ['BTCUSD'])
  const row = db.prepare(`SELECT * FROM momentum_book WHERE symbol = 'BTCUSD' AND account_id = ?`).get(DEMO)
  assert.ok(row && row.status === 'open' && /reconciled/.test(row.note), JSON.stringify(row))
  assert.equal(row.entry_rank, 0.95, 'the held rank rides on the row')
  // Same pass again within the hour: BTCUSD now has an open row, NATGAS still has its limit → nothing.
  const r2 = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 + 60_000 })
  assert.equal(r2.reconciled, 0)
  assert.equal(f.calls.autoTrade.length, 1)
  // Throttle: a held name whose attempt was refused is not retried inside RECONCILE_EVERY_MS.
  db.prepare(`DELETE FROM pending_orders`).run()
  const g = fakes({ fill: false })
  const r3 = await runMomentumBook(db, { accounts, credsFor, deps: g.deps, now: 5_000_000 + 120_000 })
  assert.equal(r3.reconciled, 1, 'NATGAS attempted once the limit is gone')
  assert.equal(g.calls.autoTrade.length, 1)
  const r4 = await runMomentumBook(db, { accounts, credsFor, deps: g.deps, now: 5_000_000 + 180_000 })
  assert.equal(r4.reconciled, 0, 'not retried within the hour')
  assert.equal(g.calls.autoTrade.length, 1)
  const r5 = await runMomentumBook(db, { accounts, credsFor, deps: g.deps, now: 5_000_000 + 120_000 + RECONCILE_EVERY_MS + 1 })
  assert.equal(r5.reconciled, 1, 'retried after the hour')
  assert.ok(JSON.parse(getState(db, MOMENTUM_BOOK_STATE_KEY)).reconciledAt[`${DEMO}|NATGAS`] > 0, 'the throttle stamp persists')
})

test('reconcile never touches shorts or names with a fresh enter row this pass (those go through the normal entry)', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: {
    NATGAS: { side: 'short', entryPrice: 2.9, enteredAt: 1, entryRank: 0.05, entryConviction: 9 },
    BTCUSD: { side: 'long', entryPrice: 77000, enteredAt: 1, entryRank: 0.95, entryConviction: 9 },
  }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', rank: 0.95, conviction: 9 })
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.equal(r.entries, 1)
  assert.equal(r.reconciled, 0, 'BTCUSD entered through its enter row; the short is never a candidate')
  assert.deepEqual(f.calls.autoTrade.map(c => c.symbol), ['BTCUSD'])
})

test('THE 21:32 SGT CASE: the momentum account adopts its filled tsmom_long trade too, before its daily branch', async () => {
  const { MOMENTUM_ACCOUNT_KEY } = await import('./momentum-account.js')
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: DEMO, volTargetPct: 10, maxPositions: 8 }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  const tid = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES ('MSFT.US','BUY','open',500.44,463.47,510,?,?,?,'reconciler_adopted','pos-msft',datetime('now'))`)
    .run(TSMOM_STRATEGY, TSMOM_STRATEGY, DEMO).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, account_id, status, source) VALUES ('MSFT.US', ?, 'long', 500.44, 463.47, 510, ?, 'active', 'autopilot')`).run(tid, DEMO)
  const f = fakes()
  const r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 5_000_000 })
  assert.equal(r.adopted, 1, JSON.stringify(r.skipped))
  const row = db.prepare(`SELECT * FROM momentum_book WHERE trade_id = ?`).get(tid)
  assert.ok(row && row.status === 'open' && row.position_id === 'pos-msft', JSON.stringify(row))
  assert.equal(db.prepare(`SELECT paused, current_tp FROM monitored_positions WHERE trade_id = ?`).get(tid).paused, 1)
})

// ---------------------------------------------------------------------------
// The close's volume (09-09-2026 17:00 SGT): LLY.US rank exit on ACCT-DEMO-1
// failed `Message missing required fields: volume`. Broker position first,
// trade lots × lot size second, else the close is NOT sent and the row stays
// open with the reason in the summary.
// ---------------------------------------------------------------------------
test('bookCloseVolume: broker volume first, trade lots × lot size second, null when neither can say', async () => {
  const db = fresh()
  const tid = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, label_strategy, strategy, account_id, origin, ctrader_position_id, volume, opened_at) VALUES ('LLY.US','BUY','open',700,650,?,?,?,'bot_market_dispatch','pos-lly',0.5,datetime('now'))`)
    .run(TSMOM_STRATEGY, TSMOM_STRATEGY, DEMO).lastInsertRowid
  const row = { trade_id: tid, position_id: 'pos-lly', symbol: 'LLY.US' }
  const lotDeps = { symbolIdFor: async () => 7, volumeMeta: async () => ({ lotSize: 100 }) }
  assert.equal(await bookCloseVolume(db, {}, row, { positionVolume: async () => 60, ...lotDeps }), 60, 'the broker is the authority')
  assert.equal(await bookCloseVolume(db, {}, row, { positionVolume: async () => null, ...lotDeps }), 50, '0.5 lots × 100 = 50 units')
  assert.equal(await bookCloseVolume(db, {}, row, { positionVolume: async () => { throw new Error('502') }, ...lotDeps }), 50, 'a broker read failure falls through to the trade row')
  assert.equal(await bookCloseVolume(db, {}, row, { positionVolume: async () => null }), null, 'no lot meta → nothing to send')
  assert.equal(await bookCloseVolume(db, {}, { ...row, trade_id: null }, { positionVolume: async () => null, ...lotDeps }), null, 'no trade row → nothing to send')
  db.prepare(`UPDATE trades SET volume = NULL WHERE id = ?`).run(tid)
  assert.equal(await bookCloseVolume(db, {}, row, { positionVolume: async () => null, ...lotDeps }), null, 'a trade with no lots → nothing to send')
})

test('a rank exit with no resolvable volume is NOT sent: the row stays open, the summary says why, and the next pass retries once the broker answers', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter' })
  const f = fakes()
  let brokerVolume = null
  f.deps.positionVolume = async () => brokerVolume
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM momentum_book WHERE status = 'open'`).get().n, 1)
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit' })
  let r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 2_000 })
  assert.equal(r.exits, 0)
  assert.equal(f.calls.close.length, 0, 'no volume, no close')
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'open', 'the row is not marked exit_sent for a close that never went')
  assert.match(db.prepare(`SELECT note FROM momentum_book`).get().note, /^exit_pending: unknown volume/, 'the refused exit is flagged on the row so the next pass retries it (the shadow cursor never re-reads the exit row)')
  assert.ok(r.skipped.some(x => /BTCUSD: close failed — unknown volume/.test(x)), JSON.stringify(r.skipped))
  // The broker answers next pass: the close goes with its volume.
  brokerVolume = 250
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 3_000 })
  assert.equal(r.exits, 1)
  assert.deepEqual(f.calls.close, [{ positionId: `pos-BTCUSD-${DEMO}`, volume: 250 }])
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'exit_sent')
})

test('wiring pin: both book exit paths resolve the volume before the close', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const f of ['./momentum-book.js', './momentum-account.js']) {
    const src = strip(readFileSync(new URL(f, import.meta.url), 'utf8'))
    assert.match(src, /const volume = await bookCloseVolume\(db, creds, row, deps\)[\s\S]{0,200}?if \(volume == null\) throw new Error\('unknown volume — close not sent'\)[\s\S]{0,120}?deps\.close\(creds, \{ positionId: row\.position_id, volume \}\)/, `${f} sends the close with its volume`)
    assert.ok(!/deps\.close\(creds, \{ positionId: row\.position_id \}\)/.test(src), `${f} has no volume-less close left`)
  }
})

// ---------------------------------------------------------------------------
// The ranking's last word (09-09-2026, the LLY.US residue): an exit refused
// BEFORE the exit_pending flag existed carries no flag and the cursor never
// re-reads the exit row. The newest shadow enter/exit word for the symbol,
// written after the row was entered, is an exit still owed.
// ---------------------------------------------------------------------------
test('an open row whose newest shadow word is exit (after entry) is exited even with no flag; adopted rows the shadow never ranked and re-entries are untouched', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: DEMO }, { getState, setState })
  shadowRow(db, { symbol: 'BTCUSD', action: 'enter', at: new Date(500).toISOString() })
  const f = fakes()
  let closeOk = false
  f.deps.close = async (_c, args) => { if (!closeOk) throw new Error('old code: nothing sent'); f.calls.close.push(args); return {} }
  await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 1_000 })
  assert.equal(db.prepare(`SELECT status FROM momentum_book WHERE symbol = 'BTCUSD'`).get().status, 'open')
  // The exit row is read once through the cursor; the close fails; then the
  // flag is wiped to mimic the pre-#872 code that never wrote one.
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit', at: new Date(5_000).toISOString() })
  shadowRow(db, { symbol: 'NATGAS', action: 'exit', at: new Date(2_000).toISOString() }) // consumed by this pass too: no NATGAS row yet
  let r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 6_000 })
  assert.equal(r.exits, 0)
  db.prepare(`UPDATE momentum_book SET note = 'rank entry' WHERE symbol = 'BTCUSD'`).run()
  // An adopted row the shadow never ranked, and a name re-entered AFTER its exit word.
  const adopted = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES ('MSFT.US','BUY','open',500,463,NULL,?,?,?,'reconciler_adopted','pos-msft',datetime('now'))`)
    .run(TSMOM_STRATEGY, TSMOM_STRATEGY, DEMO).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, account_id, status, source) VALUES ('MSFT.US', ?, 'long', 500, 463, ?, 'active', 'autopilot')`).run(adopted, DEMO)
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note) VALUES (NULL, ?, 'NATGAS', 'pos-natgas', 'long', 3, 2.7, 0.1, 0.9, ?, 'open', 're-entered after the exit word')`).run(DEMO, new Date(7_000).toISOString())
  closeOk = true
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 8_000 })
  assert.equal(r.exits, 1, JSON.stringify(r.skipped))
  assert.deepEqual(f.calls.close, [{ positionId: `pos-BTCUSD-${DEMO}`, volume: 1000 }], 'the owed BTCUSD exit goes; nothing else is closed')
  const st = Object.fromEntries(db.prepare(`SELECT symbol, status FROM momentum_book`).all().map(x => [x.symbol, x.status]))
  assert.equal(st.BTCUSD, 'exit_sent')
  assert.equal(st['MSFT.US'], 'open', 'adopted, never ranked by the shadow: untouched')
  assert.equal(st.NATGAS, 'open', 'entered after its exit word: untouched')
})
