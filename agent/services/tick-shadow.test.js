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
import { TICK_COST_MAP_KEY as TICK_COST_MAP_KEY_T } from '../lib/tick-cost-schedule.js'

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
  // the last status read said two shadow trades were open on this side: the restart took them.
  // V3 Q0: the status names its boot — the sidecar has sent shadowPortfolio.bootId
  // since #892 — and only a count observed FOR boot-1 is boot-1's loss.
  setState(db, 'cpp_exec_demo_tick_json', JSON.stringify({ at: 'x', status: { shadowPortfolio: { bootId: 'boot-1', open: 2 } } }))
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

// PR-L (docs/plan-execution-audit-2026-09-11.md §16): the cost-sensitivity
// line. The shadow trades already on record were closed spread-only, so what
// the owner needs before switching anything on is what THOSE trades would
// have earned under the schedule — at 0 ×, 1 × and 2 ×.
test('PR-L: the shadow view carries a cost-sensitivity line at 0x, 1x and 2x, priced by each symbol\'s class', async () => {
  const { TICK_COST_MAP_KEY, loadRepoSchedule, scheduleHash } = await import('../lib/tick-cost-schedule.js')
  const { sideCostSchedule } = await import('./tick-shadow.js')
  const db = fresh()
  const side = { name: 'cpp_exec_demo' }
  // six closed trades on two symbols: one a US stock, one FX. Recorded with
  // NO cost columns — exactly the shape of the 236 already on record.
  const rows = [1, 2, 3, 4, 5, 6].map(i => trade(i, {
    symbolId: i % 2 ? 11 : 22,
    entry: 1_000_000, exit: i % 2 ? 1_030_000 : 990_000, stopDistance: 10_000,
    grossR: i % 2 ? 3 : -1, netR: i % 2 ? 3 : -1, reason: i % 2 ? 'target' : 'stop',
  }))
  await pullTickShadow(db, { pullSidecarShadow: async () => ({ bootId: 'b1', latestSeq: 6, total: 6, trades: rows }) }, side)
  // before the keeper has pushed a symbol map, everything prices at the
  // FALLBACK and the line says so rather than pretending it knew
  const before = shadowPortfolio(db, { side: 'cpp_exec_demo' })
  assert.equal(before.costSensitivity.symbolMapped, false)
  assert.equal(before.costSensitivity.viaFallback, 6)
  // now the keeper's map: 11 is a US stock, 22 is an FX pair
  setState(db, TICK_COST_MAP_KEY, JSON.stringify({ cpp_exec_demo: { at: '2026-09-16T00:00:00Z', symbolClass: { 11: 'stock_us', 22: 'fx' }, unclassified: [] } }))
  const c = sideCostSchedule(db, 'cpp_exec_demo')
  assert.equal(c.mapped, true); assert.equal(c.classOfSymbol(11), 'stock_us'); assert.equal(c.classOfSymbol(22), 'fx'); assert.equal(c.classOfSymbol(99), null)
  const v = shadowPortfolio(db, { side: 'cpp_exec_demo' })
  const s = v.costSensitivity
  assert.deepEqual(s.rows.map(r => r.multiple), [0, 1, 2])
  assert.equal(s.priced, 6); assert.equal(s.unpriceable, 0); assert.equal(s.viaFallback, 0)
  assert.equal(s.symbolMapped, true)
  assert.equal(s.scheduleHash, scheduleHash(loadRepoSchedule()))
  // the recorded book paid nothing, so 0x reproduces the recorded profit factor
  assert.equal(s.rows[0].profitFactor, v.profitFactor, '0x is the book as recorded — spread-only')
  assert.ok(s.rows[1].profitFactor < s.rows[0].profitFactor, 'the schedule must lower it')
  assert.ok(s.rows[2].profitFactor < s.rows[1].profitFactor, 'twice the schedule lowers it again')
  assert.ok(s.rows[2].netR < s.rows[0].netR)
  assert.match(s.note, /1x is NOT the recorded profit factor/)
  // the view exposes it per profile too
  const view = tickShadowView(db)
  const demo = view.sides.find(x => x.side === 'cpp_exec_demo')
  assert.ok(demo.profiles[0].costSensitivity.rows.length === 3, 'every profile row carries the line')
})

// CHECKER BLOCKER 1: the shadow view separates COSTED rows from the rest, and
// `costedOnly` is what the SHADOW_PASSED gate reads. The 236 trades already on
// record carry no cost class — they were closed spread-only — and must not be
// able to satisfy the bar on a profit factor the measured costs never touched.
test('PR-L: the evidence read keeps only rows the book demonstrably CHARGED the schedule, and counts each population once', async () => {
  const { loadRepoSchedule, rowChargedUnder } = await import('../lib/tick-cost-schedule.js')
  const fx = loadRepoSchedule().classes.fx
  const db = fresh()
  const side = { name: 'cpp_exec_demo' }
  // stop 10_000 wire, entry 1_000_000. fx commission is 0.35 bps per side, so
  // the round trip on a 1_030_000 exit is (35 + 36.05)/10_000 = 0.0071 R.
  const charged = (i, win) => {
    const entry = 1_000_000, exit = win ? 1_030_000 : 990_000
    const grossR = (exit - entry) / 10_000
    const comm = (0.35 * entry / 10_000) + (0.35 * exit / 10_000)
    return trade(i, {
      entry, exit, stopDistance: 10_000, reason: win ? 'target' : 'stop',
      grossR: +grossR.toFixed(4), netR: +(grossR - comm / 10_000).toFixed(4),
      costClass: 'fx', commissionWirePerSide: fx.commissionWirePerSide, commissionBpsPerSide: fx.commissionBpsPerSide,
      slippageWirePerSide: fx.slippageWirePerSide, slippageBpsPerSide: fx.slippageBpsPerSide,
    })
  }
  const legacy = [1, 2].map(i => trade(i, { entry: 1_000_000, exit: 1_030_000, stopDistance: 10_000, grossR: 3, netR: 3 }))
  // ROUND-TWO CHECKER: a row that CLAIMS a class but was charged nothing.
  const claimsOnly = trade(7, {
    entry: 1_000_000, exit: 1_030_000, stopDistance: 10_000, grossR: 3, netR: 3,
    costClass: 'fx', commissionWirePerSide: 0, commissionBpsPerSide: 0, slippageWirePerSide: 0, slippageBpsPerSide: 0,
  })
  const bogusClass = trade(8, { entry: 1_000_000, exit: 1_030_000, stopDistance: 10_000, grossR: 3, netR: 3, costClass: 'not_a_class' })
  const blankClass = trade(9, { entry: 1_000_000, exit: 1_030_000, stopDistance: 10_000, grossR: 3, netR: 3, costClass: ' ' })
  // right terms, but the netR says nothing was actually subtracted
  const unspent = { ...charged(10, true), netR: 3, grossR: 3 }
  const lost = trade(11, { reason: 'lost_restart', netR: null, grossR: null })
  await pullTickShadow(db, { pullSidecarShadow: async () => ({ bootId: 'b1', latestSeq: 11, total: 11,
    trades: [...legacy, charged(3, true), charged(4, false), charged(5, true), claimsOnly, bogusClass, blankClass, unspent, lost] }) }, side)

  const sch = loadRepoSchedule()
  const gate = shadowPortfolio(db, { side: 'cpp_exec_demo', chargedUnder: sch })
  assert.equal(gate.trades, 3, 'only the three genuinely charged rows are evidence')
  assert.equal(gate.costAudit.charged, 3)
  assert.equal(gate.costAudit.closed, 9, 'nine closed rows…')
  assert.equal(gate.costAudit.lostRestart, 1, '…and one with no result, counted apart — never added into the same fraction')
  assert.equal(gate.costAudit.rows, 10)
  assert.equal(gate.costAudit.preCostModel, 3, 'the two pre-PR-L rows, plus the blank class — a blank is no class')
  assert.deepEqual(gate.costAudit.refused, { no_cost_class: 3, unknown_cost_class: 1, cost_terms_differ: 1, net_r_not_charged: 1 },
    'a blank class is NOT a class; a class this repo does not price is refused; zero terms under a charged schedule are refused; and right terms with an uncharged netR are refused')
  assert.equal(gate.costAudit.charged + Object.values(gate.costAudit.refused).reduce((a, b) => a + b, 0), gate.costAudit.closed,
    'charged + refused must account for every closed row exactly once')
  assert.equal(gate.costAudit.scheduleHash, sch && gate.costAudit.scheduleHash)

  // the three refusals, one at a time, straight from the predicate
  assert.equal(rowChargedUnder({ cost_class: 'fx', commission_wire: 0, commission_bps: 0, slippage_wire: 0, slippage_bps: 0 }, sch).reason, 'cost_terms_differ')
  assert.equal(rowChargedUnder({ cost_class: 'not_a_class' }, sch).reason, 'unknown_cost_class')
  assert.equal(rowChargedUnder({ cost_class: ' ' }, sch).reason, 'no_cost_class')
  assert.equal(rowChargedUnder({ cost_class: null }, sch).reason, 'no_cost_class')
  assert.equal(rowChargedUnder({ cost_class: 'fx', commission_wire: 0, commission_bps: 0.35, slippage_wire: 0, slippage_bps: 0.5,
    entry: 1_000_000, exit: 1_030_000, stop_distance: 10_000, gross_r: 3, net_r: 3 }, sch).reason, 'net_r_not_charged',
    'right terms, but the row\'s own netR says they were never spent')
  assert.equal(rowChargedUnder(charged(3, true), sch).ok, true, 'the predicate reads the sidecar\'s camelCase shape as well as the db row\'s snake_case')

  // with no schedule asked for, every closed row is shown and none is evidence
  const view = shadowPortfolio(db, { side: 'cpp_exec_demo' })
  assert.equal(view.trades, 9); assert.equal(view.costAudit.charged, null)
  assert.match(view.costAudit.note, /none is treated as evidence/)

  // the per-row cost model is stored and read back, not write-only
  const row = db.prepare('SELECT cost_class, commission_bps, commission_wire, slippage_bps, slippage_wire FROM tick_shadow_trades WHERE seq = 3').get()
  assert.equal(row.cost_class, 'fx'); assert.equal(row.commission_bps, 0.35); assert.equal(row.slippage_bps, 0.5)
  assert.equal(row.commission_wire, 0); assert.equal(row.slippage_wire, 0)

  // the sensitivity prices each row by the class the ROW carries, even when
  // the current symbol map says something else entirely
  setState(db, TICK_COST_MAP_KEY_T, JSON.stringify({ cpp_exec_demo: { at: 'x', symbolClass: { 1: 'stock_hk' }, unclassified: [] } }))
  const s = shadowPortfolio(db, { side: 'cpp_exec_demo' }).costSensitivity
  assert.ok(s.viaRow >= 3, 'the costed rows price by their own class')
  assert.ok(s.classDisagreements >= 3, 'row says fx, map says stock_hk — REPORTED, not silently re-priced')
})
