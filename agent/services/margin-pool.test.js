// node --test agent/services/margin-pool.test.js
//
// § 7,453·A/B (owner, 08-09-2026): margin is judged per account and the
// dispatch draws on the POOL — richest headroom first, only an exhausted
// account skipped, by name. The single-account pre-gate it replaces paused
// every account on the selected account's number (17 of 30 loops on 08-09).

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState, getState } from '../db.js'
import { DEFAULT_RISK_CONFIG, portfolioMarginStatus, accountMarginPool } from './risk.js'
import { runMomentumBook, MOMENTUM_BOOK_CONFIG_KEY, TSMOM_STRATEGY } from './momentum-book.js'
import { setStage } from './stage-matrix.js'

function acct(db, id, balance) {
  setState(db, `acct:${id}:account_balance_usd`, String(balance))
  setState(db, `acct:${id}:account_leverage`, '100')
}
function hold(db, accountId, { symbol = 'EURUSD', volume = 1, entry = 1.1 } = {}) {
  const t = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, status, opened_at, account_id) VALUES (?, 'BUY', ?, ?, 'open', datetime('now'), ?)`)
    .run(symbol, entry, volume, accountId).lastInsertRowid
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, status, account_id) VALUES (?, ?, 'long', ?, 'active', ?)`).run(symbol, t, entry, accountId)
}

test('portfolioMarginStatus: named, it is THAT account — the broker snapshot applies to the selected account only', () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', 'A')
  setState(db, 'broker_snapshot_cache_json', JSON.stringify({ account: { health: { usedMargin: 100 } }, fetchedAt: new Date().toISOString() }))
  hold(db, 'B') // 1 lot EURUSD @ 1.10 at 1:100 → $1,100 of margin on B
  const a = portfolioMarginStatus(db, DEFAULT_RISK_CONFIG, { balance: 1000, leverage: 100, accountId: 'A' })
  const b = portfolioMarginStatus(db, DEFAULT_RISK_CONFIG, { balance: 1000, leverage: 100, accountId: 'B' })
  const unnamed = portfolioMarginStatus(db, DEFAULT_RISK_CONFIG, { balance: 1000, leverage: 100 })
  assert.equal(a.source, 'broker'); assert.equal(a.usedMargin, 100)
  assert.equal(b.source, 'estimate'); assert.equal(Math.round(b.usedMargin), 1100, 'B is estimated from its OWN rows, not read from A’s snapshot')
  assert.equal(unnamed.source, 'broker', 'no name means the selected account, as before')
})

test('accountMarginPool: richest first, exhausted named, unknown balance is not exhausted', () => {
  const db = initDB(':memory:')
  setState(db, 'ctrader_account_id', 'A')
  acct(db, 'A', 1000); acct(db, 'B', 1000) // cap = $500 each (maxMarginUsagePct 0.5)
  hold(db, 'A')                             // $1,100 used on A → exhausted
  hold(db, 'B', { volume: 0.1 })            // $110 used on B → $390 headroom
  const pool = accountMarginPool(db, DEFAULT_RISK_CONFIG, ['A', 'B', 'C'])
  assert.deepEqual(pool.map(p => p.accountId), ['B', 'C', 'A'])
  assert.equal(pool[0].exhausted, false); assert.equal(pool[0].status.headroom, 390)
  assert.equal(pool[1].status, null); assert.equal(pool[1].exhausted, false, 'no balance on record is unknown, not exhausted')
  assert.equal(pool[2].exhausted, true); assert.ok(pool[2].status.headroom < 0)
  assert.equal(pool[2].status.source, 'estimate', 'A has no fresh snapshot, so it is estimated too')
})

test('the momentum book: richest account first, an exhausted account takes no entries, null headroom is not exhausted', async () => {
  const DEMO = '111', LIVE = '222'
  const fresh = () => {
    const db = initDB(':memory:')
    db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${DEMO}','1',0,1,'active')`).run()
    db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${LIVE}','2',1,1,'active')`).run()
    setState(db, MOMENTUM_BOOK_CONFIG_KEY, JSON.stringify({ enabled: true }))
    for (const id of [DEMO, LIVE]) setStage(db, { kind: 'strategy', key: TSMOM_STRATEGY, stage: 'trade', on: true, accountId: id }, { getState, setState })
    db.prepare(`INSERT INTO momentum_shadow (symbol, action, side, rank_pct, conviction, price, timeframe, universe, applied, at) VALUES ('BTCUSD','enter','long',0.9,9,100,'1d',20,0,datetime('now'))`).run()
    return db
  }
  const fakes = (headroom) => {
    const calls = []
    const bars = Array.from({ length: 30 }, (_, i) => ({ t: i, o: 100, h: 101 + i * 0.1, l: 99 + i * 0.1, c: 100 + i * 0.1 }))
    return {
      calls,
      deps: {
        symbolMap: { BTCUSD: 1 }, bars: async () => bars, spot: async () => ({ bid: 102.9, ask: 103 }),
        phasesOn: () => true, mayTrade: () => ({ ok: true, item: null }), marginHeadroom: headroom,
        autoTrade: async (_db, symbol, _synth, _w, a) => { calls.push({ symbol, accountId: a.accountId }); return null },
      },
    }
  }
  const accounts = [{ accountId: DEMO, isLive: false }, { accountId: LIVE, isLive: true }]
  const credsFor = (a) => ({ accountId: a.accountId })
  // DEMO exhausted, LIVE rich: LIVE is tried, DEMO is named and skipped
  const f = fakes((id) => id === DEMO ? 0 : 50)
  const db = fresh()
  const r1 = await runMomentumBook(db, { accounts, credsFor, deps: f.deps })
  assert.deepEqual(f.calls.map(c => c.accountId), [LIVE])
  assert.ok(r1.skipped.some(s => s.startsWith(`${DEMO}: margin exhausted (headroom $0.00)`)), JSON.stringify(r1.skipped))
  // richest first: DEMO 10 vs LIVE 90 → LIVE before DEMO regardless of roster order
  const g = fakes((id) => id === DEMO ? 10 : 90)
  await runMomentumBook(fresh(), { accounts, credsFor, deps: g.deps })
  assert.deepEqual(g.calls.map(c => c.accountId), [LIVE, DEMO])
  // no reading at all → nobody is exhausted (the first draft read null as $0)
  const h = fakes(() => null)
  await runMomentumBook(fresh(), { accounts, credsFor, deps: h.deps })
  assert.deepEqual(h.calls.map(c => c.accountId).sort(), [DEMO, LIVE])
})

test('wiring pin: the dispatch reads the pool once, skips only the exhausted account inside the fan-out, and the book shares the pool', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(src, /function portfolioMarginExhausted/, 'the single-account pre-gate is gone')
  assert.match(src, /const pool = marginPoolForCycle\(db\)\s+if \(pool\.length && pool\.every\(p => p\.exhausted\)\) return \{ fired: false, synth \}\s+const apAccounts = pool\.map\(p => p\.acct\)/,
    'the pool is read before the fan-out and only an ALL-exhausted pool ends the dispatch')
  assert.match(src, /const poolEntry = pool\.find\(p => String\(p\.accountId\) === String\(acct\.accountId\)\)\s+if \(poolEntry\?\.exhausted\) \{[\s\S]{0,700}?stage: 'margin_pool'[\s\S]{0,300}?continue\s+\}/,
    'an exhausted account is skipped by name inside the fan-out, with a decision row')
  assert.match(src, /accountMarginPool\(db, config, accounts\.map\(a => a\.accountId\)/, 'the pool is the per-account status from risk.js')
  assert.match(src, /marginHeadroom: \(accountId\) => marginPoolForCycle\(db\)\.find\(p => p\.accountId === String\(accountId\)\)\?\.status\?\.headroom \?\? null/, 'the momentum book reads the same pool')
})
