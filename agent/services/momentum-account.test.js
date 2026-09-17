// node --test agent/services/momentum-account.test.js
//
// The momentum account (owner 07-09-2026, §7,386·D1): one account runs the
// momentum system — vol-target sizing, a universe pre-filtered by
// affordability, one decision per day, tsmom_long only.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, getState, setState } from '../db.js'
import {
  momentumAccountConfig, loadMomentumAccount, isMomentumAccount, momentumAccountIds, momentumAccountStateKey, migrateLegacyPassCursor, ALL_ACCOUNTS, MOMENTUM_ACCOUNT_KEY, MOMENTUM_ACCOUNT_STATE_KEY, MOMENTUM_UNIVERSE_KEY,
  momentumUniverse, momentumUniverseSymbols, volTargetLots, dailyDue, thresholdMs, buildUniverse, runMomentumAccountPass, momentumAccountReport,
} from './momentum-account.js'
import { buildEntrySynth, loadMomentumBook, momentumBookConfig, runMomentumBook, MOMENTUM_BOOK_CONFIG_KEY, TSMOM_STRATEGY } from './momentum-book.js'
import { MOMENTUM_SHADOW_STATE_KEY } from './momentum-shadow.js'
import { evaluateTrade } from './risk.js'
import { evidenceGate } from './evidence-gate.js'
import { setStage } from './stage-matrix.js'

const MOM = '46979908', OTHER = '43097342'
const strip = (s) => s.replace(/\/\/.*$/gm, '')

function fresh() {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${MOM}','3',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${OTHER}','1',0,1,'active')`).run()
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: MOM, volTargetPct: 10, maxPositions: 8, cadence: 'daily', dailyRunAfterUtc: '21:05' }))
  return db
}
// Lot meta in cTrader units: lotSize in CENTS of units. 1 lot = 1 BTC → lotSize 100; min 0.01 lot.
const META = { BTCUSD: { lotSize: 100, minVolume: 1, stepVolume: 1, digits: 2 }, NATGAS: { lotSize: 1_000_000, minVolume: 10_000, stepVolume: 10_000, digits: 3 } }
const BARS = (close, atr) => Array.from({ length: 30 }, (_, i) => ({ t: i, o: close, h: close + atr / 2, l: close - atr / 2, c: close }))

test('config: defaults, clamps, the account id is a string, cadence is daily unless told loop', () => {
  const c = momentumAccountConfig(null)
  assert.equal(c.accountId, null)
  assert.equal(c.volTargetPct, 10)
  assert.equal(c.maxPositions, 8)
  assert.equal(c.cadence, 'daily')
  const d = momentumAccountConfig({ accountId: 46979908, volTargetPct: 500, maxPositions: 0, dailyRunAfterUtc: 'junk', cadence: 'loop' })
  assert.equal(d.accountId, '46979908')
  assert.equal(d.volTargetPct, 100)
  assert.equal(d.maxPositions, 1)
  assert.equal(d.dailyRunAfterUtc, '21:05')
  assert.equal(d.cadence, 'loop')
  const db = fresh()
  assert.equal(isMomentumAccount(db, MOM), true)
  assert.equal(isMomentumAccount(db, OTHER), false)
  assert.equal(isMomentumAccount(db, null), false)
  assert.equal(loadMomentumAccount(initDB(':memory:')).accountId, null, 'unconfigured → nowhere')
})

test('the universe is data: the file lists classes, a state override REPLACES it, names are upper-cased and unique', () => {
  const db = initDB(':memory:')
  const u = momentumUniverse(db)
  assert.ok(u.length >= 40, `file universe has ${u.length} names`)
  assert.ok(u.some(x => x.symbol === 'BTCUSD' && x.class === 'crypto'))
  assert.ok(u.some(x => x.symbol === 'US30' && x.class === 'index'))
  assert.ok(u.some(x => x.symbol === 'EURUSD' && x.class === 'fx'))
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['btcusd', 'BTCUSD', 'XAUUSD'] }))
  assert.deepEqual(momentumUniverseSymbols(db), ['BTCUSD', 'XAUUSD'])
})

test('volTargetLots: 10%/8 slots on $100k at 2% daily ATR → $3,937 notional → 0.05 BTC; a $300 account cannot afford one min lot', () => {
  // assetVol = 0.02 × √252 = 31.75%; target = 100k × 10% / 8 = $1,250/yr; notional = 1250 / 0.3175 = $3,937; at $77,000/BTC = 0.0511 → snapped 0.05
  const s = volTargetLots({ equity: 100_000, volTargetPct: 10, maxPositions: 8, atr: 1540, price: 77_000, symbol: 'BTCUSD', meta: META.BTCUSD })
  assert.equal(s.affordable, true)
  assert.equal(s.lots, 0.05)
  assert.equal(s.notionalUsd, 3937)
  assert.equal(s.assetVolPct, 31.75)
  const tiny = volTargetLots({ equity: 300, volTargetPct: 10, maxPositions: 8, atr: 1540, price: 77_000, symbol: 'BTCUSD', meta: META.BTCUSD })
  assert.equal(tiny.affordable, false)
  assert.match(tiny.note, /below_min_lot/)
  assert.equal(volTargetLots({ equity: 0, volTargetPct: 10, maxPositions: 8, atr: 1, price: 1, symbol: 'X', meta: META.BTCUSD }).affordable, false)
})

test('dailyDue: once per UTC day after the threshold; loop cadence is always due', () => {
  const day = Date.UTC(2026, 8, 7) // 2026-09-07
  const t = thresholdMs(day + 3 * 3600_000, '21:05')
  assert.equal(t, day + 21 * 3600_000 + 5 * 60_000)
  assert.equal(dailyDue({ nowMs: day + 20 * 3600_000, lastRunMs: 0 }), false, 'before the threshold: not yet')
  assert.equal(dailyDue({ nowMs: day + 21.5 * 3600_000, lastRunMs: 0 }), true, 'after the threshold, never run: due')
  assert.equal(dailyDue({ nowMs: day + 22 * 3600_000, lastRunMs: day + 21.5 * 3600_000 }), false, 'ran today already')
  assert.equal(dailyDue({ nowMs: day + 24 * 3600_000 + 22 * 3600_000, lastRunMs: day + 21.5 * 3600_000 }), true, 'next day after the threshold: due again')
  assert.equal(dailyDue({ nowMs: day + 20 * 3600_000, lastRunMs: 0, cadence: 'loop' }), true)
})

function fakes({ fill = true, equity = 100_000 } = {}) {
  const calls = { autoTrade: [], close: [] }
  return {
    calls,
    deps: {
      symbolIdFor: async (_c, symbol) => ({ BTCUSD: 1, NATGAS: 2 })[symbol] ?? null,
      volumeMeta: async (_c, id) => (id === 1 ? META.BTCUSD : META.NATGAS),
      bars: async (_c, id) => (id === 1 ? BARS(77_000, 1540) : BARS(2.9, 0.06)),
      spot: async (_c, id) => (id === 1 ? { bid: 76_990, ask: 77_000 } : { bid: 2.899, ask: 2.9 }),
      equity: () => equity,
      rates: () => null,
      atrOf: (bars) => { let s = 0; for (let i = bars.length - 14; i < bars.length; i++) s += bars[i].h - bars[i].l; return s / 14 },
      mayTrade: () => ({ ok: true, item: null }),
      close: async (_c, args) => { calls.close.push(args); return {} },
      positionVolume: async () => 500_000,
      amend: async () => ({}),
      phasesOn: () => true,
      autoTrade: async (db, symbol, synth, _w, acct) => {
        calls.autoTrade.push({ symbol, synth, acct })
        if (!fill) return null
        const orderSide = synth.consensus_bias === 'short' ? 'SELL' : 'BUY'
        const t = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES (?,?,'open',?,?,NULL,?,?,?,'bot_market_dispatch',?,datetime('now'))`)
          .run(symbol, orderSide, synth.entry, synth.sl, synth.strategy, synth.strategy, acct.accountId, `pos-${symbol}-${acct.accountId}`)
        db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, account_id, status, source) VALUES (?, ?, ?, ?, ?, ?, 'active', 'autopilot')`).run(symbol, t.lastInsertRowid, synth.consensus_bias, synth.entry, synth.sl, acct.accountId)
        return { side: orderSide, tradeId: t.lastInsertRowid }
      },
    },
  }
}
const DUE = Date.UTC(2026, 8, 7, 21, 30)   // 21:30 UTC, past the 21:05 threshold
const NOT_DUE = Date.UTC(2026, 8, 7, 12, 0)
// PR-O: an entry stamp relative to DUE, not to the wall clock — a row stamped
// `datetime('now')` is in the FUTURE relative to DUE and would be held back by
// the minimum hold, hiding whether the exit ran at all.
const FIVE_DAYS_BEFORE_DUE = new Date(DUE - 5 * 86_400_000).toISOString()

test('buildUniverse: unknown names are reported, unaffordable names are excluded with the reason, tradable names carry their vol-target size', async () => {
  const db = fresh()
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD', 'NATGAS', 'MYSTERY'] }))
  const f = fakes({ equity: 100_000 })
  const b = await buildUniverse(db, { accountId: MOM, creds: {}, cfg: loadMomentumAccount(db), deps: f.deps })
  assert.equal(b.equity, 100_000)
  assert.equal(b.universe.MYSTERY.ok, false)
  assert.equal(b.universe.MYSTERY.reason, 'unknown_symbol')
  assert.equal(b.universe.BTCUSD.ok, true)
  assert.equal(b.universe.BTCUSD.lots, 0.05)
  assert.equal(b.universe.NATGAS.ok, true, `NATGAS: ${b.universe.NATGAS.reason}`)
  const small = await buildUniverse(db, { accountId: MOM, creds: {}, cfg: loadMomentumAccount(db), deps: fakes({ equity: 300 }).deps })
  assert.equal(small.universe.BTCUSD.ok, false)
  assert.match(small.universe.BTCUSD.reason, /below_min_lot/)
})

test('the daily pass: not due → nothing; due → the shadow\'s tradable longs are entered best rank first, sized by the vol target, once per day; a dropped name exits next day', async () => {
  const db = fresh()
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD', 'NATGAS', 'MYSTERY'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 }, NATGAS: { side: 'long', entryRank: 0.85, entryConviction: 8 }, MYSTERY: { side: 'long', entryRank: 0.99 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const bookCfg = loadMomentumBook(db)
  const f = fakes()
  const acct = { accountId: MOM, isLive: false }
  const early = await runMomentumAccountPass(db, { acct, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: NOT_DUE })
  assert.equal(early.ran, false)
  assert.equal(f.calls.autoTrade.length, 0)

  const r = await runMomentumAccountPass(db, { acct, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE })
  assert.equal(r.ran, true)
  assert.equal(r.entries, 2, `skipped: ${JSON.stringify(r.skipped)}`)
  assert.deepEqual(f.calls.autoTrade.map(c => c.symbol), ['BTCUSD', 'NATGAS'], 'best rank first; MYSTERY is unknown on this account and never proposed')
  const s = f.calls.autoTrade[0].synth
  assert.equal(s.strategy, TSMOM_STRATEGY)
  assert.equal(s.sizing, 'vol_target')
  assert.equal(s.sizedVolume, 0.05)
  assert.equal(s.marketOnly, false, 'a closed market gets a resting limit at this price, not a refusal')
  assert.equal(s.tp1, null)
  assert.equal(s.source, 'momentum_account')
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book WHERE account_id = ? AND status = 'open'`).get(MOM).n, 2)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM monitored_positions WHERE paused = 1`).get().n, 2, 'the keeper is paused on the book rows')
  assert.equal(r.universe.tradable, 2)
  assert.equal(r.universe.byReason.unknown_symbol, 1)

  // Same day again: not due, nothing proposed.
  const again = await runMomentumAccountPass(db, { acct, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE + 3600_000 })
  assert.equal(again.ran, false)
  assert.equal(f.calls.autoTrade.length, 2)

  // Next day the shadow has dropped NATGAS: the pass closes it and re-enters nothing.
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const next = await runMomentumAccountPass(db, { acct, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE + 86_400_000 })
  assert.equal(next.ran, true)
  assert.equal(next.exits, 1)
  assert.equal(next.entries, 0)
  assert.deepEqual(f.calls.close, [{ positionId: `pos-NATGAS-${MOM}`, volume: 500_000 }], 'the daily-pass exit carries the broker volume (09-09-2026)')
  assert.equal(db.prepare(`SELECT status FROM momentum_book WHERE symbol = 'NATGAS'`).get().status, 'exit_sent')
  const rep = momentumAccountReport(db)
  assert.equal(rep.config.accountId, MOM)
  assert.equal(rep.universe.tradable, 2)
  assert.equal(rep.lastPass.exits, 1)
  assert.equal(JSON.parse(getState(db, momentumAccountStateKey(MOM))).lastRunMs, DUE + 86_400_000, 'PR-B: the pass cursor is per account')
  assert.equal(rep.accounts[MOM].lastPass.exits, 1)
})

test('PR-B (owner principle 9): accountId "_all" runs the daily pass on EVERY enabled account, each sized from its OWN equity, each with its own cursor; a disabled account is not a momentum account', async () => {
  const db = fresh()
  const THIRD = '42993489', OFF = '47790949'
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${THIRD}','2',1,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${OFF}','4',0,0,'archived')`).run()
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: '_all', volTargetPct: 10, maxPositions: 8 }))
  assert.equal(loadMomentumAccount(db).accountId, ALL_ACCOUNTS)
  assert.equal(momentumAccountConfig({ accountId: '_ALL' }).accountId, ALL_ACCOUNTS, 'case-insensitive')
  for (const id of [MOM, OTHER, THIRD]) assert.equal(isMomentumAccount(db, id), true, `${id} is a momentum account under _all`)
  assert.equal(isMomentumAccount(db, OFF), false, 'a disabled account is not')
  assert.equal(isMomentumAccount(db, '99999999'), false, 'an unknown account is not')
  assert.deepEqual(momentumAccountIds(db), [THIRD, OTHER, MOM].sort())
  // Two accounts, two balances: the same shadow holding sizes to different lots.
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const io = { getState, setState }
  for (const id of [MOM, OTHER, THIRD]) setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: id }, io)
  const equityOf = { [MOM]: 100_000, [OTHER]: 20_000, [THIRD]: 300 }
  const f = fakes()
  f.deps.equity = (accountId) => equityOf[String(accountId)]
  const accounts = [{ accountId: MOM, isLive: false }, { accountId: OTHER, isLive: false }, { accountId: THIRD, isLive: true }, { accountId: OFF, isLive: false }]
  const r = await runMomentumBook(db, { accounts, credsFor: (a) => ({ accountId: a.accountId }), deps: { ...f.deps, symbolMap: { BTCUSD: 1 } }, now: DUE })
  assert.equal(r.ran, true)
  const byAcct = Object.fromEntries(f.calls.autoTrade.map(c => [c.acct.accountId, c.synth]))
  assert.equal(byAcct[MOM].sizing, 'vol_target'); assert.equal(byAcct[MOM].sizedVolume, 0.05, '100k equity → 0.05 lots')
  assert.equal(byAcct[OTHER].sizing, 'vol_target'); assert.equal(byAcct[OTHER].sizedVolume, 0.01, '20k equity → 0.01 lots — sized by ITS balance, not the first account\'s')
  assert.equal(byAcct[THIRD], undefined, '300 equity: below the min lot → excluded at universe build, nothing placed')
  assert.equal(r.entries, 2, `skipped: ${JSON.stringify(r.skipped)}`)
  for (const id of [MOM, OTHER, THIRD]) assert.equal(JSON.parse(getState(db, momentumAccountStateKey(id))).lastRunMs, DUE, `${id} keeps its own cursor`)
  assert.equal(getState(db, momentumAccountStateKey(OFF)), null, 'the disabled account never ran')
  const rep = momentumAccountReport(db)
  assert.equal(rep.config.account, 'every enabled account')
  assert.deepEqual(Object.keys(rep.accounts).sort(), [THIRD, OTHER, MOM].sort())
  assert.equal(rep.accounts[MOM].universe.tradable, 1); assert.equal(rep.accounts[THIRD].universe.tradable, 0)
  assert.equal(rep.universe.built, 3); assert.equal(rep.universe.tradable, 2)
  assert.equal(rep.universe.byReason.below_min_lot, 1)
  // The checked-in file declares every account.
  const file = JSON.parse(readFileSync(new URL('../config/momentum-account.json', import.meta.url), 'utf8'))
  assert.equal(file.accountId, '_all'); assert.equal('exclusive' in file, false)
})

test('runMomentumBook routes the momentum account to the daily pass and the other accounts to the row cursor', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const io = { getState, setState }
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: MOM }, io)
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: OTHER }, io)
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  db.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, timeframe, universe, applied, at) VALUES ('BTCUSD','enter','long',0.95,9,77000,'1d',20,0,datetime('now'))`).run()
  const f = fakes()
  const accounts = [{ accountId: MOM, isLive: false }, { accountId: OTHER, isLive: false }]
  const r = await runMomentumBook(db, { accounts, credsFor: (a) => ({ accountId: a.accountId }), deps: { ...f.deps, symbolMap: { BTCUSD: 1 } }, now: DUE })
  assert.equal(r.ran, true)
  assert.equal(r.entries, 2, `skipped: ${JSON.stringify(r.skipped)}`)
  const byAcct = Object.fromEntries(f.calls.autoTrade.map(c => [c.acct.accountId, c.synth]))
  assert.equal(byAcct[MOM].sizing, 'vol_target', 'the momentum account is vol-target sized')
  assert.equal(byAcct[MOM].sizedVolume, 0.05)
  assert.equal(byAcct[OTHER].sizing, undefined, 'the other account is sized by the risk gate as before')
  assert.equal(byAcct[OTHER].marketOnly, true)
  assert.equal(r.momentumAccount.account, MOM)
})

// ---------------------------------------------------------------------------
// The risk gate: one system per account, and the vol-target size honoured
// only where it belongs.
// ---------------------------------------------------------------------------

function gateDb() {
  const db = fresh()
  setState(db, `acct:${MOM}:account_balance_usd`, '100000')
  setState(db, `acct:${OTHER}:account_balance_usd`, '100000')
  setState(db, 'ctrader_account_id', OTHER)
  return db
}
const tsmomProposal = (accountId, extra = {}) => ({
  symbol: 'BTCUSD', side: 'long', entry: 77_000, sl: 72_380, tp1: null, requestedVolume: null,
  strategy: TSMOM_STRATEGY, conviction: 8, source: 'momentum_account', accountId, sizing: 'vol_target', sizedVolume: 0.05, ...extra,
})

test('risk gate: the momentum account is OPEN (owner 09-09-2026, the cluster rule); PR-B deleted the exclusive switch and the momentum_account_only veto — a stored exclusive:true changes nothing', () => {
  const db = gateDb()
  const prop = { symbol: 'EURUSD', side: 'long', entry: 1.1, sl: 1.097, tp1: 1.1105, requestedVolume: 0.01, strategy: 'ema_pullback', conviction: 8, accountId: MOM }
  const open = evaluateTrade(db, prop)
  assert.doesNotMatch(String(open.veto_reason || ''), /momentum_account_only/, 'the stack trades here like anywhere else')
  assert.equal(open.checks.momentum_account, true, 'the account is still a momentum account (daily pass, vol sizing)')
  // RED if the 07-09 veto comes back behind a stored switch.
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ ...loadMomentumAccount(db), exclusive: true }))
  const r = evaluateTrade(db, prop)
  assert.doesNotMatch(String(r.veto_reason || ''), /momentum_account_only/, 'a stored exclusive:true is inert')
  assert.equal('exclusive' in loadMomentumAccount(db), false, 'the config no longer carries the switch')
  assert.equal('exclusive' in momentumAccountConfig({ exclusive: true }), false)
  const other = evaluateTrade(db, { ...prop, accountId: OTHER })
  assert.doesNotMatch(String(other.veto_reason || ''), /momentum_account_only/)
})

test('risk gate: the vol-target size is THE size on the momentum account; declared elsewhere it is ignored; the min-lot floor still vetoes', () => {
  const db = gateDb()
  const mom = evaluateTrade(db, tsmomProposal(MOM))
  assert.equal(mom.approved, true, `veto: ${mom.veto_reason}`)
  assert.equal(mom.adjusted_volume, 0.05, 'the sized volume, not balance × risk%')
  assert.equal(mom.checks.sizing, 'vol_target')
  const other = evaluateTrade(db, tsmomProposal(OTHER))
  assert.equal(other.checks.sizing, undefined)
  assert.equal(other.checks.sizing_ignored, 'vol_target size declared outside the momentum account')
  assert.notEqual(other.adjusted_volume, 0.05, 'elsewhere the gate sizes from the risk budget as before')
  // A tiny account: the risk budget would veto insufficient_equity, but the vol-target size clears the min lot on the momentum account…
  setState(db, `acct:${MOM}:account_balance_usd`, '2000')
  const small = evaluateTrade(db, tsmomProposal(MOM, { sizedVolume: 0.01 }))
  assert.equal(small.approved, true, `veto: ${small.veto_reason}`)
  assert.equal(small.adjusted_volume, 0.01)
  // …and a vol-target size below the broker minimum is still refused — the universe build is what keeps such names out.
  const dust = evaluateTrade(db, tsmomProposal(MOM, { sizedVolume: 0.001 }))
  assert.equal(dust.approved, false)
  assert.match(dust.veto_reason, /insufficient_equity/)
})

test('evidence gate: tsmom_long is admitted on the momentum account by construction; other strategies there are not', () => {
  const db = fresh()
  assert.equal(evidenceGate(db, { strategy: TSMOM_STRATEGY, accountId: MOM }).via, 'momentum_account')
  assert.equal(evidenceGate(db, { strategy: TSMOM_STRATEGY, accountId: OTHER }).allowed, false, 'elsewhere the pin or the record is still required')
  assert.equal(evidenceGate(db, { strategy: 'ema_pullback', accountId: MOM }).allowed, false)
})

test('wiring pins (comments stripped): the size rides both dispatch paths, the gate honours it only under the momentum-account check, the shadow ranks the universe first', () => {
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /sizing: synth\.sizing \?\? null,\s*sizedVolume: synth\.sizedVolume \?\? null,/, 'market path must pass the vol-target size into the proposal')
  assert.match(loop, /momentumUniverseSymbols\(db\)/, 'the shadow must rank the momentum universe')
  assert.match(loop, /equity: \(accountId\) => getAccountBalance\(db, accountId\)/, 'the universe build needs this account\'s equity')
  assert.match(loop, /volumeMeta: async \(creds, symbolId\)/, 'the universe build needs the lot meta')
  const cml = strip(readFileSync(new URL('./closed-market-limits.js', import.meta.url), 'utf8'))
  assert.match(cml, /sizing: synth\.sizing \?\? null,\s*sizedVolume: synth\.sizedVolume \?\? null,/, 'the resting-limit path must pass the size too')
  const risk = strip(readFileSync(new URL('./risk.js', import.meta.url), 'utf8'))
  assert.match(risk, /if \(volTargetSized && momentumAcct && proposal\.strategy === MOMENTUM_STRATEGY\)/, 'the gate honours the size only on a momentum account for tsmom')
  assert.doesNotMatch(risk, /momentum_account_only:/, 'PR-B: the one-system veto is gone from the gate')
  const book = strip(readFileSync(new URL('./momentum-book.js', import.meta.url), 'utf8'))
  assert.match(book, /if \(isMomentumAccount\(db, accountId\)\) \{[\s\S]*runMomentumAccountPass\(db, \{ acct, creds, bookCfg: cfg, buildEntrySynth, deps, now, log, marginExhausted, entryBrake \}\)/, 'the book must route the momentum account to the daily pass WITH its margin state AND its entry brake (PR-P)')
  // PR-P: the brake is computed ONCE per account, above the momentum-account
  // branch, so both entry paths read the same verdict. If this moves below
  // the `continue`, the path that actually trades stops being braked — the
  // exact shape of the defect PR-K's first draft shipped.
  assert.match(book, /const entryBrake = bookEntryBrake\(db, \{ accountId, marks: state\.marks, markFail: state\.markFail, bookCfg: cfg, now \}\)[\s\S]*if \(isMomentumAccount\(db, accountId\)\)/, 'the entry brake must be computed before the momentum-account branch')
  // PR-P (checker MAJOR 1): the brake must measure the CARRIED set, not just
  // `open` — an exit that has been sent is exposure the account still holds.
  const dd = strip(readFileSync(new URL('./book-open-drawdown.js', import.meta.url), 'utf8'))
  assert.match(dd, /WHERE b\.status IN \('open', 'exit_sent'\) AND b\.account_id = \?/, 'the brake reads the carried set')
})

test('scope: a shadow row for a momentum-universe name is NOT taken by a row-cursor account outside its scan universe; the momentum account still takes it', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const io = { getState, setState }
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: MOM }, io)
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: OTHER }, io)
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD', 'NATGAS'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95 }, NATGAS: { side: 'long', entryRank: 0.9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  db.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, timeframe, universe, applied, at) VALUES ('BTCUSD','enter','long',0.95,9,77000,'1d',20,0,datetime('now'))`).run()
  db.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, timeframe, universe, applied, at) VALUES ('NATGAS','enter','long',0.9,8,2.9,'1d',20,0,datetime('now'))`).run()
  const f = fakes()
  const accounts = [{ accountId: MOM, isLive: false }, { accountId: OTHER, isLive: false }]
  // The scan only ever covered BTCUSD; NATGAS is a momentum-universe name.
  const r = await runMomentumBook(db, { accounts, credsFor: (a) => ({ accountId: a.accountId }), deps: { ...f.deps, symbolMap: { BTCUSD: 1, NATGAS: 2 }, scanSymbols: ['BTCUSD'] }, now: DUE })
  const got = f.calls.autoTrade.map(c => `${c.acct.accountId}:${c.symbol}`).sort()
  assert.deepEqual(got, [`${MOM}:BTCUSD`, `${MOM}:NATGAS`, `${OTHER}:BTCUSD`].sort(), `skipped: ${JSON.stringify(r.skipped)}`)
  assert.ok(r.skipped.some(s => s.includes(`${OTHER} NATGAS: outside this account's scan universe`)))
  // No scan list passed (tests, legacy callers): nothing is filtered.
  const f2 = fakes()
  const db2 = fresh()
  setState(db2, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setState(db2, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: null }))
  setStage(db2, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: OTHER }, io)
  db2.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, timeframe, universe, applied, at) VALUES ('NATGAS','enter','long',0.9,8,2.9,'1d',20,0,datetime('now'))`).run()
  await runMomentumBook(db2, { accounts: [{ accountId: OTHER, isLive: false }], credsFor: (a) => ({ accountId: a.accountId }), deps: { ...f2.deps, symbolMap: { NATGAS: 2 } }, now: DUE })
  assert.deepEqual(f2.calls.autoTrade.map(c => c.symbol), ['NATGAS'])
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  assert.match(loop, /scanSymbols: symbols\.map\(/, 'the loop must hand the book the scan universe')
})

test('the repo declaration switches the momentum account on at boot, idempotently, and overrides a differing stored value', async () => {
  const { seedMomentumAccountFromConfig, loadMomentumAccount, MOMENTUM_ACCOUNT_KEY } = await import('./momentum-account.js')
  const { initDB, setState } = await import('../db.js')
  const { readFileSync, writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const db = initDB(':memory:')
  const dir = mkdtempSync(join(tmpdir(), 'ma-'))
  const file = join(dir, 'momentum-account.json')
  writeFileSync(file, JSON.stringify({ _note: 'x', accountId: '46979908', volTargetPct: 10, maxPositions: 8 }))
  const lines = []
  const a = seedMomentumAccountFromConfig(db, { file, log: (m) => lines.push(m) })
  assert.equal(a.applied, true); assert.equal(a.error, null)
  assert.equal(loadMomentumAccount(db).accountId, '46979908'); assert.equal(loadMomentumAccount(db).maxPositions, 8)
  assert.equal(loadMomentumAccount(db).cadence, 'daily', 'a key the file does not name keeps its stored/default value')
  assert.match(lines[0], /…9908: volTarget 10% maxPositions 8/)
  assert.equal(seedMomentumAccountFromConfig(db, { file }).applied, false, 'idempotent')
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: null }))
  assert.equal(seedMomentumAccountFromConfig(db, { file }).applied, true, 'the file wins over a differing stored value at boot')
  assert.equal(loadMomentumAccount(db).accountId, '46979908')
  // the checked-in file itself declares every enabled account (PR-B, principle 9)
  const real = seedMomentumAccountFromConfig(initDB(':memory:'), { log: (m) => lines.push(m) })
  assert.equal(real.error, null); assert.equal(real.effective.accountId, '_all'); assert.equal(real.effective.volTargetPct, 10); assert.equal(real.effective.maxPositions, 8)
  assert.match(lines[lines.length - 1], /momentum account every enabled account: volTarget 10%/)
  assert.ok(seedMomentumAccountFromConfig(db, { file: join(dir, 'missing.json') }).error?.startsWith('momentum-account.json unreadable'))
  // wiring pin: index.js applies it at boot, after the horizons
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(src, /seedAccountHorizonsFromConfig\(db, \{ log[\s\S]{0,900}?seedMomentumAccountFromConfig\(db, \{ log/, 'the boot seed runs after the horizons seed')
})

// PR-B checker (11-09-2026): the daily pass applies the SAME gates the
// row-cursor tryEnter applies — an exhausted margin pool takes no entries,
// an unfundable name is skipped by name — and a FUNDED live account goes
// through the pass like any other, sized from its own equity.
function allAccountsDb() {
  const db = fresh()
  const LIVE = '42993489'
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${LIVE}','2',1,1,'active')`).run()
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: '_all', volTargetPct: 10, maxPositions: 8 }))
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD', 'NATGAS'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 }, NATGAS: { side: 'long', entryRank: 0.85, entryConviction: 8 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  const io = { getState, setState }
  for (const id of [MOM, OTHER, LIVE]) setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: id }, io)
  return { db, LIVE }
}

test('the daily pass on a margin-exhausted account places NOTHING (exits still run, the cursor is not advanced); an unfundable symbol is skipped by name', async () => {
  const { db } = allAccountsDb()
  const bookCfg = loadMomentumBook(db)
  const f = fakes()
  // An open row the shadow no longer holds: the exit must still go out while entries are refused.
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note) VALUES (NULL, ?, 'NATGAS', 'pos-NATGAS-x', 'long', 2.9, 2.7, 0.06, 0.8, '2026-09-06T21:30:00Z', 'open', 'x')`).run(MOM)
  const capped = await runMomentumAccountPass(db, { acct: { accountId: MOM, isLive: false }, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE, marginExhausted: true })
  assert.equal(capped.ran, false); assert.match(capped.why, /margin exhausted/)
  assert.equal(f.calls.autoTrade.length, 0, 'RED if an exhausted account takes a daily-pass entry')
  assert.equal(capped.exits, 1, 'the exit still runs'); assert.deepEqual(f.calls.close, [{ positionId: 'pos-NATGAS-x', volume: 500_000 }])
  assert.equal(getState(db, momentumAccountStateKey(MOM)), null, 'the cursor is not advanced — retried once headroom frees')
  // Through the book: the headroom reader marks the account exhausted.
  const f2 = fakes()
  const r = await runMomentumBook(db, { accounts: [{ accountId: MOM, isLive: false }], credsFor: (a) => ({ accountId: a.accountId }), deps: { ...f2.deps, symbolMap: { BTCUSD: 1, NATGAS: 2 }, marginHeadroom: () => 0 }, now: DUE })
  assert.equal(f2.calls.autoTrade.length, 0, `book: exhausted → nothing placed; skipped ${JSON.stringify(r.skipped)}`)
  assert.ok(r.skipped.some(s => /margin exhausted/.test(s)))
  // Headroom back: the same day's pass now runs, and the unfundable name is skipped by name.
  const f3 = fakes()
  const ok = await runMomentumAccountPass(db, { acct: { accountId: MOM, isLive: false }, creds: {}, bookCfg, buildEntrySynth, deps: { ...f3.deps, fundable: (_a, sym) => (sym === 'BTCUSD' ? { ok: false, reason: 'unfundable: min lot needs $9,000 margin' } : { ok: true }) }, now: DUE })
  assert.equal(ok.ran, true)
  assert.deepEqual(f3.calls.autoTrade.map(c => c.symbol), [], 'BTCUSD unfundable, NATGAS no longer held → nothing')
  assert.ok(ok.skipped.some(s => s.startsWith('BTCUSD: unfundable')), JSON.stringify(ok.skipped))
  assert.equal(JSON.parse(getState(db, momentumAccountStateKey(MOM))).lastRunMs, DUE, 'a completed pass advances the cursor')
})

test('a FUNDED live account goes through the daily pass: its autoTrade call carries isLive:true and its OWN vol-target size', async () => {
  const { db, LIVE } = allAccountsDb()
  const equityOf = { [MOM]: 100_000, [OTHER]: 20_000, [LIVE]: 60_000 }
  const f = fakes()
  f.deps.equity = (accountId) => equityOf[String(accountId)]
  const accounts = [{ accountId: MOM, isLive: false }, { accountId: OTHER, isLive: false }, { accountId: LIVE, isLive: true }]
  const r = await runMomentumBook(db, { accounts, credsFor: (a) => ({ accountId: a.accountId }), deps: { ...f.deps, symbolMap: { BTCUSD: 1, NATGAS: 2 } }, now: DUE })
  const liveCalls = f.calls.autoTrade.filter(c => c.acct.accountId === LIVE)
  assert.equal(liveCalls.length, 2, `the live account entered both holdings; skipped ${JSON.stringify(r.skipped)}`)
  for (const c of liveCalls) assert.equal(c.acct.isLive, true, 'routing: the live side\'s creds')
  const liveBtc = liveCalls.find(c => c.symbol === 'BTCUSD').synth
  assert.equal(liveBtc.sizing, 'vol_target'); assert.equal(liveBtc.sizedVolume, 0.03, '60k equity → 0.03 lots, its own size')
  assert.equal(f.calls.autoTrade.find(c => c.acct.accountId === MOM && c.symbol === 'BTCUSD').synth.sizedVolume, 0.05)
  assert.equal(f.calls.autoTrade.find(c => c.acct.accountId === OTHER && c.symbol === 'BTCUSD').synth.sizedVolume, 0.01)
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM momentum_book WHERE account_id = ? AND status = 'open'`).get(LIVE).n, 2)
  assert.equal(JSON.parse(getState(db, momentumAccountStateKey(LIVE))).lastRunMs, DUE)
})

test('boot migrates the previously named account\'s global pass cursor to its per-account key once, then clears the legacy key', async () => {
  const { seedMomentumAccountFromConfig } = await import('./momentum-account.js')
  const { writeFileSync, mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const db = initDB(':memory:')
  // The pre-PR-B deploy: config names one account, the global cursor says today already ran.
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: MOM, volTargetPct: 10, maxPositions: 8 }))
  setState(db, MOMENTUM_ACCOUNT_STATE_KEY, JSON.stringify({ lastRunMs: DUE, universe: { BTCUSD: { ok: true } }, universeBuiltAt: 'x', lastPass: { entries: 1 } }))
  const dir = mkdtempSync(join(tmpdir(), 'ma-mig-'))
  const file = join(dir, 'momentum-account.json')
  writeFileSync(file, JSON.stringify({ accountId: '_all', volTargetPct: 10, maxPositions: 8 }))
  const lines = []
  seedMomentumAccountFromConfig(db, { file, log: (m) => lines.push(m) })
  assert.equal(JSON.parse(getState(db, momentumAccountStateKey(MOM))).lastRunMs, DUE, 'RED if the cursor is not carried: the first pass would re-run the same UTC day')
  assert.equal(getState(db, MOMENTUM_ACCOUNT_STATE_KEY), null, 'the legacy key is cleared')
  assert.ok(lines.some(l => /pass cursor migrated/.test(l)))
  assert.equal(loadMomentumAccount(db).accountId, '_all')
  // The pass on that account the same day: not due.
  const f = fakes()
  const r = await runMomentumAccountPass(db, { acct: { accountId: MOM, isLive: false }, creds: {}, bookCfg: loadMomentumBook(db), buildEntrySynth, deps: f.deps, now: DUE + 3600_000 })
  assert.equal(r.ran, false)
  // Idempotent and never overwrites an existing per-account key.
  setState(db, MOMENTUM_ACCOUNT_STATE_KEY, JSON.stringify({ lastRunMs: 1 }))
  assert.deepEqual(migrateLegacyPassCursor(db, { accountId: MOM }), { migrated: true, accountId: MOM, reason: null })
  assert.equal(JSON.parse(getState(db, momentumAccountStateKey(MOM))).lastRunMs, DUE, 'existing per-account cursor kept')
  assert.equal(migrateLegacyPassCursor(db, { accountId: MOM }).reason, 'no_legacy_key')
  // A legacy key with no named account (null / _all): cleared, nothing copied.
  setState(db, MOMENTUM_ACCOUNT_STATE_KEY, JSON.stringify({ lastRunMs: 1 }))
  assert.equal(migrateLegacyPassCursor(db, { accountId: '_all' }).reason, 'legacy_cursor_named_no_account')
  assert.equal(getState(db, MOMENTUM_ACCOUNT_STATE_KEY), null)
})

test('PR-D (owner principle 8): the daily pass is two-sided — a shadow short at conviction 9 under a fresh down-trend is a SELL row priced at the BID with the stop above entry; at 8 refused; no reading refused; against an up-trend refused; a short row exits when the shadow drops the short; the report says the side', async () => {
  const db = fresh()
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('NATGAS', 'trending', 'short', datetime('now'))`).run()
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD', 'NATGAS'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 }, NATGAS: { side: 'short', entryRank: 0.05, entryConviction: 9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const bookCfg = loadMomentumBook(db)
  const f = fakes()
  const acct = { accountId: MOM, isLive: false }
  const r = await runMomentumAccountPass(db, { acct, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE })
  assert.equal(r.entries, 2, `skipped: ${JSON.stringify(r.skipped)}`)
  const sh = f.calls.autoTrade.find(c => c.symbol === 'NATGAS').synth
  assert.equal(sh.consensus_bias, 'short'); assert.ok(sh.sl > sh.entry, 'a short stop is ABOVE entry'); assert.equal(sh.sizing, 'vol_target')
  assert.equal(sh.entry, 2.899, 'a short is priced at the bid, not the ask (checker item c)')
  assert.match(sh.direction_reason, /^tsmom:short conviction 9 ≥ 9 trend down/)
  const row = db.prepare(`SELECT side, entry_price, stop FROM momentum_book WHERE symbol = 'NATGAS'`).get()
  assert.equal(row.side, 'short'); assert.ok(row.stop > row.entry_price)
  assert.equal(db.prepare(`SELECT side FROM trades WHERE symbol = 'NATGAS'`).get().side, 'SELL')
  assert.ok(momentumAccountReport(db).open.some(o => o.symbol === 'NATGAS' && o.side === 'short'), 'the report selects the side (checker item f)')
  // Next day the shadow no longer holds the short: the row exits.
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const next = await runMomentumAccountPass(db, { acct, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE + 86_400_000 })
  assert.equal(next.exits, 1); assert.equal(db.prepare(`SELECT status FROM momentum_book WHERE symbol = 'NATGAS'`).get().status, 'exit_sent')
  // conviction 8 → refused by the short rule; a fresh up-trend reading → refused by alignment
  const db2 = fresh()
  setState(db2, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['NATGAS'] }))
  setState(db2, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { NATGAS: { side: 'short', entryRank: 0.15, entryConviction: 8 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const g = fakes()
  const r2 = await runMomentumAccountPass(db2, { acct, creds: {}, bookCfg, buildEntrySynth, deps: g.deps, now: DUE })
  assert.equal(r2.entries, 0); assert.ok(r2.skipped.some(s => /^NATGAS: short_rule: conviction 8 < 9/.test(s)), JSON.stringify(r2.skipped))
  const db2b = fresh()
  setState(db2b, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['NATGAS'] }))
  setState(db2b, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { NATGAS: { side: 'short', entryRank: 0.05, entryConviction: 9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const g2 = fakes()
  const r2b = await runMomentumAccountPass(db2b, { acct, creds: {}, bookCfg, buildEntrySynth, deps: g2.deps, now: DUE })
  assert.equal(r2b.entries, 0); assert.ok(r2b.skipped.some(s => /^NATGAS: direction_no_trend_reading/.test(s)), JSON.stringify(r2b.skipped))
  const db3 = fresh()
  setState(db3, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['NATGAS'] }))
  setState(db3, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { NATGAS: { side: 'short', entryRank: 0.05, entryConviction: 9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  db3.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('NATGAS', 'trending', 'long', datetime('now'))`).run()
  const h = fakes()
  const r3 = await runMomentumAccountPass(db3, { acct, creds: {}, bookCfg, buildEntrySynth, deps: h.deps, now: DUE })
  assert.equal(r3.entries, 0); assert.ok(r3.skipped.some(s => /^NATGAS: direction_against_trend: short into an up-trend/.test(s)), JSON.stringify(r3.skipped))
  assert.equal(h.calls.autoTrade.length, 0)
})

test('PR-D flip on the daily pass (checker items a, b): a long row whose shadow holding is now SHORT is exited and, the open set re-read after the exits, the short is entered the same day; the regime gate is on this path too', async () => {
  const db = fresh()
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['NATGAS'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { NATGAS: { side: 'long', entryRank: 0.95, entryConviction: 9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const bookCfg = loadMomentumBook(db)
  const f = fakes()
  const acct = { accountId: MOM, isLive: false }
  let r = await runMomentumAccountPass(db, { acct, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE })
  assert.equal(r.entries, 1, JSON.stringify(r.skipped))
  // the trend turned (why the shadow flipped) before the next day's pass
  db.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('NATGAS', 'trending', 'short', datetime('now'))`).run()
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { NATGAS: { side: 'short', entryRank: 0.05, entryConviction: 9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  r = await runMomentumAccountPass(db, { acct, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE + 86_400_000 })
  assert.equal(r.exits, 1, 'the long row is exited (the holding flipped)')
  assert.equal(r.entries, 1, `the short is entered the same day — skipped: ${JSON.stringify(r.skipped)}`)
  assert.deepEqual(db.prepare(`SELECT side, status FROM momentum_book ORDER BY id`).all(), [{ side: 'long', status: 'exit_sent' }, { side: 'short', status: 'open' }])
  assert.deepEqual(f.calls.autoTrade.map(c => c.synth.consensus_bias), ['long', 'short'])
  // the regime gate on the daily pass: a quiet regime refuses a long with a decision_log row
  const db2 = fresh()
  db2.prepare(`INSERT INTO regimes (symbol, regime, trend_direction, computed_at) VALUES ('BTCUSD', 'quiet', null, datetime('now'))`).run()
  setState(db2, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
  setState(db2, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const g = fakes()
  const r2 = await runMomentumAccountPass(db2, { acct, creds: {}, bookCfg, buildEntrySynth, deps: g.deps, now: DUE })
  assert.equal(r2.entries, 0); assert.ok(r2.skipped.some(s => /^BTCUSD: regime_block trend-in-quiet \(tsmom_long\)/.test(s)), JSON.stringify(r2.skipped))
  const { recentDecisions } = await import('./decision-log.js')
  assert.equal(recentDecisions(db2, { symbol: 'BTCUSD', stage: 'regime_gate' }).length, 1)
})

// ---------------------------------------------------------------------------
// PR-K (16-09-2026) — THE MINIMUM HOLD ON THE PATH THAT ACTUALLY TRADES.
//
// The first draft of PR-K put the horizon rules on the ROW-CURSOR path in
// momentum-book.js. `agent/config/momentum-account.json` ships
// `"accountId": "_all"` (PR-B, owner principle 9), so `isMomentumAccount` is
// true for every enabled account and `runMomentumBook` routes ALL of them to
// the daily pass below, `continue`-ing before the row-cursor path is reached:
// the rules were on, configured, documented and out of reach of what they
// guarded — CLAUDE.md failure mode #3 exactly. These cases pin the rule where
// the closes are actually sent.
//
// The CADENCE half needs nothing here: this pass already runs once per UTC day
// on its own lastRunMs cursor. What was missing is the floor on how long a
// position is held before a RANKING OPINION may close it.
// ---------------------------------------------------------------------------

function openBookRow(db, { accountId, symbol = 'BTCUSD', enteredAt, openedAt = null, positionId = 'pos-1' }) {
  let tradeId = null
  if (openedAt) {
    tradeId = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, label_strategy, strategy, account_id, origin, ctrader_position_id, volume, opened_at) VALUES (?,'BUY','open',100,94,?,?,?,'bot_market_dispatch',?,1,?)`)
      .run(symbol, TSMOM_STRATEGY, TSMOM_STRATEGY, accountId, positionId, openedAt).lastInsertRowid
  }
  db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note) VALUES (?, ?, ?, ?, 'long', 100, 94, 1, 0.9, ?, 'open', 'test row')`)
    .run(tradeId, accountId, symbol, positionId, enteredAt)
  return tradeId
}
// The ranking holds nothing, so every open row is a dropped holding.
const DROPPED = JSON.stringify({ holdings: {}, refused: {}, lastRunMs: 1, lastUniverse: 20 })

test('PR-K: the daily pass does NOT rank-exit a position younger than bookMinHoldHours; the next day\'s pass does — under the shipped "_all" config, on the path that trades', async () => {
  const db = fresh()
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: '_all', volTargetPct: 10, maxPositions: 8 }))
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, DROPPED)
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))   // defaults: 24 h
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: MOM }, { getState, setState })
  // Opened one minute before the daily pass — the checker's repro.
  openBookRow(db, { accountId: MOM, enteredAt: new Date(DUE - 60_000).toISOString(), openedAt: '2026-09-07 21:29:00' })
  const f = fakes()
  const accounts = [{ accountId: MOM, isLive: false }]
  const creds = (a) => ({ accountId: a.accountId })
  let r = await runMomentumBook(db, { accounts, credsFor: creds, deps: { ...f.deps, symbolMap: { BTCUSD: 1 } }, now: DUE })
  assert.equal(r.exits, 0, `a one-minute-old position is not rank-exited: ${JSON.stringify(r.skipped)}`)
  assert.equal(f.calls.close.length, 0, 'nothing was closed')
  assert.equal(r.rankExitsDeferred, 1, 'the deferral is counted where the summary can be read')
  assert.ok(r.skipped.some(s => /BTCUSD: rank exit held — held 0\.0h < bookMinHoldHours 24/.test(s)), JSON.stringify(r.skipped))
  assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'open')
  // The next daily pass, 24 h later: the opinion stands and the position goes.
  r = await runMomentumBook(db, { accounts, credsFor: creds, deps: { ...f.deps, symbolMap: { BTCUSD: 1 } }, now: DUE + 86_400_000 })
  assert.equal(r.exits, 1, `held long enough now: ${JSON.stringify(r.skipped)}`)
  assert.equal(f.calls.close.length, 1)
  assert.equal(db.prepare(`SELECT status, note FROM momentum_book`).get().note, 'rank exit (daily pass)')
})

test('PR-K: the hold is measured from the OLDEST stamp — a row adopted today for a trade filled three days ago is rank-exited today', async () => {
  const db = fresh()
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, DROPPED)
  const bookCfg = momentumBookConfig({ enabled: true })
  openBookRow(db, { accountId: MOM, enteredAt: new Date(DUE - 60_000).toISOString(), openedAt: '2026-09-04 09:00:00' })
  const f = fakes()
  const r = await runMomentumAccountPass(db, { acct: { accountId: MOM, isLive: false }, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE })
  assert.equal(r.exits, 1, `the adoption stamp is not a new clock: ${JSON.stringify(r.skipped)}`)
  assert.equal(r.rankExitsDeferred, 0)
})

test('PR-K: one stored value lifts the hold on this path too — bookExitCadence "every_pass" (and bookMinHoldHours 0) restore the pre-PR-K exit', async () => {
  for (const [label, stored] of [['every_pass', { enabled: true, bookExitCadence: 'every_pass' }], ['minHold 0', { enabled: true, bookMinHoldHours: 0 }]]) {
    const db = fresh()
    setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
    setState(db, MOMENTUM_SHADOW_STATE_KEY, DROPPED)
    openBookRow(db, { accountId: MOM, enteredAt: new Date(DUE - 60_000).toISOString(), openedAt: '2026-09-07 21:29:00' })
    const f = fakes()
    const r = await runMomentumAccountPass(db, { acct: { accountId: MOM, isLive: false }, creds: {}, bookCfg: momentumBookConfig(stored), buildEntrySynth, deps: f.deps, now: DUE })
    assert.equal(r.exits, 1, `${label}: the one-minute-old row is closed exactly as before PR-K — ${JSON.stringify(r.skipped)}`)
    assert.equal(f.calls.close.length, 1)
  }
})

test('PR-K: an UNREADABLE shadow state closes nothing (it was closing the whole book); a readable-but-empty ranking still exits', async () => {
  const bookCfg = momentumBookConfig({ enabled: true })
  const old = new Date(DUE - 10 * 86_400_000).toISOString()
  for (const blob of [null, '', 'not-json', '{"holdings":null}', '{}']) {
    const db = fresh()
    setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
    if (blob !== null) setState(db, MOMENTUM_SHADOW_STATE_KEY, blob)
    openBookRow(db, { accountId: MOM, enteredAt: old, openedAt: '2026-08-28 09:00:00' })
    const f = fakes()
    const r = await runMomentumAccountPass(db, { acct: { accountId: MOM, isLive: false }, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE })
    assert.equal(r.exits, 0, `${JSON.stringify(blob)}: a ranking that cannot be read is not an instruction to close everything`)
    assert.equal(f.calls.close.length, 0)
    assert.ok(r.skipped.some(s => /shadow state unreadable — no rank exits this pass/.test(s)), JSON.stringify(r.skipped))
    assert.equal(db.prepare(`SELECT status FROM momentum_book`).get().status, 'open')
  }
  // A ranking that reads fine and holds nothing is a real ranking: it exits.
  const db = fresh()
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, DROPPED)
  openBookRow(db, { accountId: MOM, enteredAt: old, openedAt: '2026-08-28 09:00:00' })
  const f = fakes()
  const r = await runMomentumAccountPass(db, { acct: { accountId: MOM, isLive: false }, creds: {}, bookCfg, buildEntrySynth, deps: f.deps, now: DUE })
  assert.equal(r.exits, 1, JSON.stringify(r.skipped))
})

test('PR-K: closes sent by the MARGIN-EXHAUSTED branch are counted in the book summary (that branch returns ran:false after sending them)', async () => {
  const db = fresh()
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: '_all', volTargetPct: 10, maxPositions: 8 }))
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
  setState(db, MOMENTUM_SHADOW_STATE_KEY, DROPPED)
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: MOM }, { getState, setState })
  openBookRow(db, { accountId: MOM, enteredAt: new Date(DUE - 10 * 86_400_000).toISOString(), openedAt: '2026-08-28 09:00:00' })
  const f = fakes()
  const r = await runMomentumBook(db, {
    accounts: [{ accountId: MOM, isLive: false }],
    credsFor: (a) => ({ accountId: a.accountId }),
    deps: { ...f.deps, symbolMap: { BTCUSD: 1 }, marginHeadroom: () => 0 },
    now: DUE,
  })
  assert.equal(f.calls.close.length, 1, 'the exit went out')
  assert.equal(r.exits, 1, 'and the summary says so — a real close reported as zero is how the routing defect stayed invisible')
  assert.equal(r.momentumAccount.ran, false)
})

// ---------------------------------------------------------------------------
// PR-P (16-09-2026): the per-account entry brake ON THE PATH THAT TRADES.
// `accountId: "_all"` routes every enabled account through this daily pass, so
// a brake enforced only on the row-cursor path would be on, configured and out
// of reach of what it guards — the exact defect PR-K's first draft shipped.
// ---------------------------------------------------------------------------
test('PR-P: a bleeding momentum account takes NO entry on its daily pass, by reason — while its rank EXITS still go', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: MOM }, { getState, setState })
  // The shadow holds BTCUSD (a candidate) and no longer holds AAA or BBB,
  // which the account IS holding — so this pass owes two exits and one entry.
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const marks = {}
  for (const symbol of ['AAA', 'BBB']) {
    const t = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES (?,'BUY','open',100,90,?,?,?,'bot_market_dispatch',?, ?)`)
      .run(symbol, TSMOM_STRATEGY, TSMOM_STRATEGY, MOM, `pos-${symbol}`, FIVE_DAYS_BEFORE_DUE).lastInsertRowid
    db.prepare(`INSERT INTO trade_plans (trade_id, account_id, symbol, side, risk_dist) VALUES (?,?,?,'long',10)`).run(t, MOM, symbol)
    db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entered_at, status) VALUES (?,?,?,?, 'long', 100, 90, 2, ?, 'open')`)
      .run(t, MOM, symbol, `pos-${symbol}`, FIVE_DAYS_BEFORE_DUE)
    marks[`${MOM}|${symbol}`] = { c: 90, at: DUE }     // both at their stops → 100%
  }
  setState(db, 'momentum_book_state_json', JSON.stringify({ lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {}, marks }))
  const f = fakes()
  const r = await runMomentumBook(db, { accounts: [{ accountId: MOM, isLive: false }], credsFor: () => ({ accountId: MOM }), deps: f.deps, now: DUE })
  assert.equal(r.entries, 0, 'the DAILY PASS took no new exposure')
  assert.equal(f.calls.autoTrade.length, 0)
  assert.equal(r.entriesBraked, 1)
  const line = r.skipped.find(s => /open book drawdown/.test(s))
  assert.ok(line, `the refusal is named: ${JSON.stringify(r.skipped)}`)
  assert.match(line, /100% of the risk put up \(>= 50%\) across 2 of 2 carried row\(s\), coverage 100%/)
  // EXITS ARE UNTOUCHED: both dropped holdings were closed at the broker on
  // the same pass the entry was refused.
  assert.equal(r.exits, 2, 'the brake never delays an exit')
  assert.deepEqual(f.calls.close.map(c => c.positionId).sort(), ['pos-AAA', 'pos-BBB'])
  // The refusal is in the account's own durable record, not only in the loop log.
  // The refusal is in the account's own DURABLE record. It is not pushed to
  // `summary.skipped` from inside the daily pass any more: that function
  // returns early on `not due`, which is most passes, so a line emitted there
  // would appear once a day. momentum-book.js owns the loop lines; this owns
  // the daily record.
  const lastPass = JSON.parse(getState(db, momentumAccountStateKey(MOM))).lastPass
  assert.match(lastPass.entryBrake.reason, /open book drawdown/, 'the daily pass records why it added nothing')
  assert.equal(lastPass.entryBrake.read.drawdownPct, 100)
})

test('PR-O control: the identical bleeding account with the brake OFF takes the entry', async () => {
  const db = fresh()
  setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true, bookDrawdownOn: false }))
  setState(db, MOMENTUM_UNIVERSE_KEY, JSON.stringify({ symbols: ['BTCUSD'] }))
  setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: MOM }, { getState, setState })
  setState(db, MOMENTUM_SHADOW_STATE_KEY, JSON.stringify({ holdings: { BTCUSD: { side: 'long', entryRank: 0.95, entryConviction: 9 } }, refused: {}, lastRunMs: 1, lastUniverse: 20 }))
  const marks = {}
  for (const symbol of ['AAA', 'BBB']) {
    const t = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES (?,'BUY','open',100,90,?,?,?,'bot_market_dispatch',?, ?)`)
      .run(symbol, TSMOM_STRATEGY, TSMOM_STRATEGY, MOM, `pos-${symbol}`, FIVE_DAYS_BEFORE_DUE).lastInsertRowid
    db.prepare(`INSERT INTO trade_plans (trade_id, account_id, symbol, side, risk_dist) VALUES (?,?,?,'long',10)`).run(t, MOM, symbol)
    db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entered_at, status) VALUES (?,?,?,?, 'long', 100, 90, 2, ?, 'open')`)
      .run(t, MOM, symbol, `pos-${symbol}`, FIVE_DAYS_BEFORE_DUE)
    marks[`${MOM}|${symbol}`] = { c: 90, at: DUE }
  }
  setState(db, 'momentum_book_state_json', JSON.stringify({ lastShadowRowId: 0, lastRunMs: 0, reconciledAt: {}, rankExitAt: {}, pendingFlips: {}, marks }))
  const f = fakes()
  const r = await runMomentumBook(db, { accounts: [{ accountId: MOM, isLive: false }], credsFor: () => ({ accountId: MOM }), deps: f.deps, now: DUE })
  assert.equal(r.entries, 1, 'the refusal above was the brake, not some other gate')
  assert.deepEqual(f.calls.autoTrade.map(c => c.symbol), ['BTCUSD'])
})
