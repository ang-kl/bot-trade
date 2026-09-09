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
  momentumAccountConfig, loadMomentumAccount, isMomentumAccount, MOMENTUM_ACCOUNT_KEY, MOMENTUM_ACCOUNT_STATE_KEY, MOMENTUM_UNIVERSE_KEY,
  momentumUniverse, momentumUniverseSymbols, volTargetLots, dailyDue, thresholdMs, buildUniverse, runMomentumAccountPass, momentumAccountReport,
} from './momentum-account.js'
import { buildEntrySynth, loadMomentumBook, runMomentumBook, MOMENTUM_BOOK_CONFIG_KEY, TSMOM_STRATEGY } from './momentum-book.js'
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
        const t = db.prepare(`INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, label_strategy, strategy, account_id, origin, ctrader_position_id, opened_at) VALUES (?,'BUY','open',?,?,NULL,?,?,?,'bot_market_dispatch',?,datetime('now'))`)
          .run(symbol, synth.entry, synth.sl, synth.strategy, synth.strategy, acct.accountId, `pos-${symbol}-${acct.accountId}`)
        db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, account_id, status, source) VALUES (?, ?, 'long', ?, ?, ?, 'active', 'autopilot')`).run(symbol, t.lastInsertRowid, synth.entry, synth.sl, acct.accountId)
        return { side: 'BUY', tradeId: t.lastInsertRowid }
      },
    },
  }
}
const DUE = Date.UTC(2026, 8, 7, 21, 30)   // 21:30 UTC, past the 21:05 threshold
const NOT_DUE = Date.UTC(2026, 8, 7, 12, 0)

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
  assert.equal(JSON.parse(getState(db, MOMENTUM_ACCOUNT_STATE_KEY)).lastRunMs, DUE + 86_400_000)
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

test('risk gate: the momentum account is OPEN by default (owner 09-09-2026, the cluster rule); exclusive:true restores the one-system refusal', () => {
  const db = gateDb()
  const prop = { symbol: 'EURUSD', side: 'long', entry: 1.1, sl: 1.097, tp1: 1.1105, requestedVolume: 0.01, strategy: 'ema_pullback', conviction: 8, accountId: MOM }
  const open = evaluateTrade(db, prop)
  assert.doesNotMatch(String(open.veto_reason || ''), /momentum_account_only/, 'not exclusive → the stack trades here like anywhere else')
  assert.equal(open.checks.momentum_account, true, 'the account is still the momentum account (daily pass, vol sizing)')
  // The 07-09 rule, on request only.
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ ...loadMomentumAccount(db), exclusive: true }))
  const r = evaluateTrade(db, prop)
  assert.equal(r.approved, false)
  assert.match(r.veto_reason, /^momentum_account_only: ema_pullback/)
  const other = evaluateTrade(db, { ...prop, accountId: OTHER })
  assert.doesNotMatch(String(other.veto_reason || ''), /momentum_account_only/, 'other accounts are untouched by the rule')
  // Config shape: exclusive is a strict boolean, default false, seeded from the file when named.
  assert.equal(momentumAccountConfig(null).exclusive, false)
  assert.equal(momentumAccountConfig({ exclusive: 'yes' }).exclusive, false)
  assert.equal(momentumAccountConfig({ exclusive: true }).exclusive, true)
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
  assert.match(risk, /if \(volTargetSized && momentumAcct && proposal\.strategy === MOMENTUM_STRATEGY\)/, 'the gate honours the size only on the momentum account for tsmom')
  assert.match(risk, /momentum_account_only:/)
  const book = strip(readFileSync(new URL('./momentum-book.js', import.meta.url), 'utf8'))
  assert.match(book, /if \(isMomentumAccount\(db, accountId\)\) \{[\s\S]*runMomentumAccountPass\(db, \{ acct, creds, bookCfg: cfg, buildEntrySynth, deps, now, log \}\)/, 'the book must route the momentum account to the daily pass')
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
  // the checked-in file itself names the owner's account
  const real = seedMomentumAccountFromConfig(initDB(':memory:'))
  assert.equal(real.error, null); assert.equal(real.effective.accountId, '46979908'); assert.equal(real.effective.volTargetPct, 10); assert.equal(real.effective.maxPositions, 8)
  assert.ok(seedMomentumAccountFromConfig(db, { file: join(dir, 'missing.json') }).error?.startsWith('momentum-account.json unreadable'))
  // wiring pin: index.js applies it at boot, after the horizons
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.match(src, /seedAccountHorizonsFromConfig\(db, \{ log[\s\S]{0,900}?seedMomentumAccountFromConfig\(db, \{ log/, 'the boot seed runs after the horizons seed')
})
