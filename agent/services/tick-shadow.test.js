// agent/services/tick-shadow.test.js — P6a: the shadow portfolio as evidence.
// The heartbeat pull is idempotent and restart-aware; the portfolio figures
// are in R and the drawdown is peak-to-trough; each account's projection
// uses ITS OWN stamped balance and risk config, never the global key; the
// routes reach it. Source pins are comment-stripped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB, setState, getState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { pullTickShadow, TICK_SHADOW_CURSOR_KEY } from './heartbeat.js'
import { portfolioStats, shadowPortfolio, accountRiskPerTrade, tickShadowView, expectancyLowerR, maxConcurrentOpen } from './tick-shadow.js'

const DEMO = '46979908', DEMO2 = '46130058', LIVE = '42993489'
function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false }); upsertAccount(db, { accountId: DEMO2, isLive: false }); upsertAccount(db, { accountId: LIVE, isLive: true })
  return db
}
const trade = (seq, o = {}) => ({ seq, symbolId: 1, side: 'BUY', signalSeq: seq * 10, entrySeq: seq * 10 + 1, exitSeq: seq * 10 + 9, entry: 1000, exit: 1030, stop: 990, target: 1030, stopDistance: 10, reason: 'target', holdEvents: 8, holdMs: 800, entryMs: 1_000_000 + seq * 1000, exitMs: 1_000_800 + seq * 1000, grossR: 3, netR: 3, profile: 'abcdef0123456789', ...o })

test('the pull inserts new trades once, advances the cursor, re-reads the whole ring on a sidecar restart, and never duplicates', async () => {
  const db = fresh()
  const side = { name: 'cpp_exec_demo', base: 'http://demo:8081' }
  const calls = []
  let reply = { bootId: 'boot-1', latestSeq: 3, total: 3, trades: [trade(1), trade(2), trade(3, { netR: -1, grossR: -1, reason: 'stop', exit: 990 })] }
  const exec = { pullSidecarShadow: async (o) => { calls.push(o); return reply } }
  const r1 = await pullTickShadow(db, exec, side)
  assert.equal(r1.inserted, 3); assert.deepEqual(calls[0], { after: 0, bootId: '', base: 'http://demo:8081' })
  assert.deepEqual(JSON.parse(getState(db, TICK_SHADOW_CURSOR_KEY)).cpp_exec_demo, { bootId: 'boot-1', lastSeq: 3 })
  // the same ring again: nothing new
  const r2 = await pullTickShadow(db, exec, side)
  assert.equal(r2.inserted, 0); assert.deepEqual(calls[1], { after: 3, bootId: 'boot-1', base: 'http://demo:8081' })
  // a restart: new bootId, seq restarts at 1 — rows are distinct by boot
  // the last status read said two shadow trades were open on this side: the restart took them
  setState(db, 'cpp_exec_demo_tick_json', JSON.stringify({ at: 'x', status: { shadowPortfolio: { open: 2 } } }))
  reply = { bootId: 'boot-2', latestSeq: 1, total: 1, trades: [trade(1, { netR: 2, grossR: 2 })] }
  const r3 = await pullTickShadow(db, exec, side)
  assert.equal(r3.inserted, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_shadow_trades').get().n, 6)
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM tick_shadow_trades WHERE reason = 'lost_restart' AND boot_id = 'boot-1' AND net_r IS NULL`).get().n, 2, 'the open trades a restart took are on record, without a result')
  // the sidecar unreachable: no cursor change, no throw
  const r4 = await pullTickShadow(db, { pullSidecarShadow: async () => null }, side)
  assert.equal(r4, null)
  assert.deepEqual(JSON.parse(getState(db, TICK_SHADOW_CURSOR_KEY)).cpp_exec_demo, { bootId: 'boot-2', lastSeq: 1 })
  const row = db.prepare('SELECT * FROM tick_shadow_trades WHERE boot_id = ? AND seq = 3').get('boot-1')
  assert.equal(row.reason, 'stop'); assert.equal(row.net_r, -1); assert.equal(row.profile_hash, 'abcdef0123456789'); assert.equal(row.trade_side, 'BUY')
})

test('portfolio figures: profit factor in R, net, peak-to-trough drawdown, exits and hours', () => {
  const s = portfolioStats([
    { net_r: 2, reason: 'target', exit_ms: 0, symbol_id: 1 }, { net_r: -1, reason: 'stop', exit_ms: 3_600_000, symbol_id: 2 },
    { net_r: -1, reason: 'stop', exit_ms: 7_200_000, symbol_id: 1 }, { net_r: -1, reason: 'hold_events', exit_ms: 10_800_000, symbol_id: 1 },
    { net_r: 3, reason: 'target', exit_ms: 14_400_000, symbol_id: 3 },
  ])
  assert.equal(s.trades, 5); assert.equal(s.wins, 2); assert.equal(s.netR, 2); assert.equal(s.grossWinR, 5); assert.equal(s.grossLossR, 3)
  assert.equal(s.profitFactor, +(5 / 3).toFixed(3)); assert.equal(s.maxDrawdownR, 3, 'peak 2 → trough −1'); assert.equal(s.symbols, 3)
  assert.deepEqual(s.exits, { target: 2, stop: 2, hold_events: 1 }); assert.equal(s.hours, 4)
  assert.equal(s.losses, 3); assert.equal(s.resets, 0); assert.equal(s.lost, 0); assert.equal(s.resetSharePct, 0)
  assert.equal(portfolioStats([]).trades, 0); assert.equal(portfolioStats([]).profitFactor, null); assert.equal(portfolioStats([]).expectancyLowerR, null)
  // no losing trade → the profit factor is UNDEFINED (null), never Infinity (Statistics auditor)
  assert.equal(portfolioStats([{ net_r: 1 }, { net_r: 0.5 }]).profitFactor, null)
  // a reset-marked trade counts with its marked result; a lost one counts apart
  const withResets = portfolioStats([{ net_r: 1, reason: 'target' }, { net_r: -0.3, reason: 'reset' }, { net_r: null, reason: 'lost_restart' }, { net_r: 2, reason: 'target' }])
  assert.equal(withResets.trades, 3); assert.equal(withResets.resets, 1); assert.equal(withResets.lost, 1); assert.equal(withResets.resetSharePct, 50); assert.equal(withResets.netR, 2.7)
  // the bootstrap lower bound is deterministic and below the mean
  const bs = portfolioStats([{ net_r: 2 }, { net_r: -1 }, { net_r: 3 }, { net_r: -1 }, { net_r: 1.5 }, { net_r: -1 }])
  assert.equal(bs.expectancyLowerR, expectancyLowerR([2, -1, 3, -1, 1.5, -1])); assert.ok(bs.expectancyLowerR < bs.avgR)
  // concurrency from entry/exit intervals
  assert.equal(maxConcurrentOpen([{ entry_ms: 0, exit_ms: 10 }, { entry_ms: 5, exit_ms: 20 }, { entry_ms: 10, exit_ms: 30 }, { entry_ms: 25, exit_ms: 26 }]), 2)
})

test('each account is projected with ITS OWN balance and risk config; an unstamped account projects nothing; the global key is never read', () => {
  const db = fresh()
  setState(db, 'account_balance_usd', '45837.59')                    // the connected account's — must not leak
  setState(db, `acct:${DEMO}:account_balance_usd`, '10000')
  setState(db, 'risk_config_json', JSON.stringify({ perTradeRiskPct: 0.01 }))
  setState(db, `acct:${DEMO}:risk_config_json`, JSON.stringify({ perTradeRiskPct: 0.02, maxRiskCapPct: 0.05 }))
  const a = accountRiskPerTrade(db, DEMO)
  assert.equal(a.balance, 10000); assert.equal(a.usdPerR, 200); assert.equal(a.perTradeRiskPct, 0.02)
  const b = accountRiskPerTrade(db, DEMO2)
  assert.equal(b.balance, null); assert.equal(b.usdPerR, null); assert.equal(b.source, 'balance_not_read')
  for (const [i, r] of [2, -1, 3].entries()) db.prepare(`INSERT INTO tick_shadow_trades (side, boot_id, seq, symbol_id, profile_hash, trade_side, reason, net_r, gross_r, exit_ms) VALUES ('cpp_exec_demo', 'b', ?, 1, 'p1', 'BUY', 'x', ?, ?, ?)`).run(i + 1, r, r, i * 1000)
  const pf = shadowPortfolio(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' })
  assert.equal(pf.trades, 3); assert.equal(pf.netR, 4)
  const d = pf.accounts.find(x => x.accountId === '…9908'), d2 = pf.accounts.find(x => x.accountId === '…0058')
  assert.equal(d.projectedNetUsd, 800); assert.equal(d.projectedMaxDrawdownUsd, 200)
  assert.equal(d2.projectedNetUsd, null); assert.equal(d2.balance, null)
  assert.ok(!pf.accounts.some(x => x.accountId === '…3489'), 'a live account is not on the demo side')
  assert.ok(!JSON.stringify(pf).includes('45837'), 'the global balance never appears')
  const v = tickShadowView(db)
  assert.equal(v.sides.length, 2); assert.equal(v.sides[0].profiles[0].profile, 'p1'); assert.equal(v.sides[1].profiles.length, 0)
})

test('wiring pins: the heartbeat pulls the shadow after the recorder status, the route reaches the view, the validation stage reads the portfolio (comments stripped)', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const hb = strip(readFileSync(new URL('./heartbeat.js', import.meta.url), 'utf8'))
  assert.match(hb, /await pullTickStatus\(db, exec, side, nowMs\)[\s\S]{0,400}await pullTickShadow\(db, exec, side\)/)
  const st = strip(readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8'))
  assert.match(st, /router\.get\('\/tick-shadow'/); assert.match(st, /tickShadowView\(db\)/)
  const tv = strip(readFileSync(new URL('./tick-validation.js', import.meta.url), 'utf8'))
  assert.match(tv, /shadowPortfolio\(db, \{ side, profilePrefix: prefix, sinceMs/)
  assert.match(tv, /shadow_window_broken/)
  const gs = strip(readFileSync(new URL('./exec-guard-sync.js', import.meta.url), 'utf8'))
  assert.match(gs, /out\.tickShadowSim = loadTickShadowSim\(\)/); assert.match(gs, /tick\.shadowSim/)
  const ex = strip(readFileSync(new URL('../lib/exec-engine.js', import.meta.url), 'utf8'))
  assert.match(ex, /base \+ '\/tick-shadow'/)
})
