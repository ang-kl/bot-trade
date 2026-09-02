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
  MOMENTUM_BOOK_CONFIG_KEY, MOMENTUM_BOOK_STATE_KEY, TSMOM_STRATEGY, DEFAULT_MOMENTUM_BOOK,
} from './momentum-book.js'

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
function shadowRow(db, { symbol, action, side = 'long', rank = 1, conviction = 9, price = 100 }) {
  return db.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, timeframe, universe, applied, at) VALUES (?, ?, ?, ?, ?, ?, '1d', 20, 0, datetime('now'))`).run(symbol, action, side, rank, conviction, price).lastInsertRowid
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
  // Price falls back: the stop does NOT follow.
  f.deps.bars = async () => f.bars
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 3_000 })
  assert.equal(r.trailed, 0)
  assert.equal(db.prepare(`SELECT stop FROM momentum_book`).get().stop, after)
  // Rank exit: the position is closed and the row says why.
  shadowRow(db, { symbol: 'BTCUSD', action: 'exit' })
  r = await runMomentumBook(db, { accounts, credsFor, deps: f.deps, now: 4_000 })
  assert.equal(r.exits, 1)
  assert.equal(f.calls.close.length, 1)
  assert.equal(f.calls.close[0].positionId, `pos-BTCUSD-${DEMO}`)
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
  assert.ok(block.includes('phasesOn: (accountId) => !!effectivePhases(db, accountId)?.autotrade'))
  assert.ok(src.includes("synth.marketOnly !== true && !fresh"), 'a marketOnly synth never rests as a limit')
})
