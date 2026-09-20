// ---------------------------------------------------------------------------
// producer-retirement.test.js — the intraday retirement (owner order
// 20-09-2026: "retire the intraday paths, keep momentum only").
//
// ONE structural fence: admitEntry refuses every producer marked `retired` in
// lib/entry-producers.js, before the mode and basis checks, and records the
// refusal as a decision_log SKIP carrying the proposal's levels — never a
// risk_events veto (the boundary #968 drew for a cycle-stable, per-account
// refusal). The scan keeps running: its proposals end here and are scored by
// the refusal ledger for forgone R at zero risk.
// ---------------------------------------------------------------------------
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { readFileSync } from 'node:fs'

import { initDB } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { admitEntry, requestEntryMode, _resetRefusalDedupe, RETIRED_REFUSAL_WINDOW_MS } from './entry-mode.js'
import { ENTRY_PRODUCERS, retiredProducers, automaticProducers, isProducerRetired } from '../lib/entry-producers.js'
import { reasonHead } from './risk.js'
import { evidenceShadowRefusals } from './refusal-ledger.js'
import { DEFAULT_GAP_MS } from './opportunity-identity.js'

const DEMO = '46130058', OTHER = '42993489'
const RETIRED_BY_THIS_ORDER = ['scan_dispatch', 'closed_market_limits']

function fresh() {
  const db = initDB(':memory:')
  upsertAccount(db, { accountId: DEMO, isLive: false })
  upsertAccount(db, { accountId: OTHER, isLive: true })
  _resetRefusalDedupe()
  return db
}
const proposal = (o = {}) => ({
  symbol: 'EURUSD', side: 'BUY', entry: 1.1, sl: 1.09, tp1: 1.13, tp2: 1.15,
  strategy: 'donchian_breakout', timeframe: '1h', conviction: 8, ...o,
})
const skips = (db) => db.prepare(`SELECT * FROM decision_log WHERE stage = 'producer_retired'`).all()

test('the fence refuses each producer this order retired, with the reason head producer_retired', () => {
  const db = fresh()
  for (const id of RETIRED_BY_THIS_ORDER) {
    assert.equal(isProducerRetired(id), true, `${id} is retired in the inventory`)
    const a = admitEntry(db, { accountId: DEMO, producerId: id, basis: 'bar', proposal: proposal() })
    assert.equal(a.ok, false, `${id} is refused`)
    assert.equal(a.retired, true)
    assert.equal(reasonHead(a.reason), 'producer_retired', a.reason)
    assert.match(a.reason, new RegExp(`^producer_retired: ${id} — 2026-09-20 `), a.reason)
  }
})

test('the kept producers still trade: the two momentum paths are admitted under a normal mode, and the tick engine is not retired', () => {
  const db = fresh()
  for (const id of ['daily_momentum_account', 'cross_sectional_book']) {
    const a = admitEntry(db, { accountId: DEMO, producerId: id, basis: 'bar' })
    assert.equal(a.ok, true, `${id}: ${a.reason}`)
    assert.equal(a.mode, 'TIME_BASED')
  }
  // The owner pulled the tick engine back out of this order mid-build: it
  // stays reachable, gated as before by the per-account switch to
  // TICK_MOMENTUM (a bar-mode account still refuses it on basis, not on a
  // retirement).
  assert.equal(isProducerRetired('tick_momentum'), false)
  const tick = admitEntry(db, { accountId: DEMO, producerId: 'tick_momentum', basis: 'tick' })
  assert.equal(tick.ok, false)
  assert.equal(reasonHead(tick.reason), 'entry_mode_basis', tick.reason)
  assert.deepEqual(automaticProducers().map(p => p.id), ['daily_momentum_account', 'cross_sectional_book', 'tick_momentum'])
})

test('every manual and manual_assisted route is still admitted — the owner keeps every hand', () => {
  const db = fresh()
  requestEntryMode(db, DEMO, 'STOPPED')   // even with the engine stopped
  const manual = ENTRY_PRODUCERS.filter(p => p.family === 'manual' || p.family === 'manual_assisted')
  assert.deepEqual(manual.map(p => p.id).sort(), [
    'route_execute_trade', 'route_manual_order', 'route_position_double',
    'route_position_reverse', 'route_trade_now', 'route_validation_fill',
  ], 'the six hand routes')
  for (const p of manual) {
    const a = admitEntry(db, { accountId: DEMO, producerId: p.id, basis: 'bar' })
    assert.equal(a.ok, true, `${p.id}: ${a.reason}`)
  }
  assert.equal(skips(db).length, 0, 'a manual route writes no retirement skip')
})

test('the refusal is a decision_log skip and NOT a risk_events veto, deduped per account and producer', () => {
  const db = fresh()
  // Three cycles of the same proposal, on two accounts.
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const acct of [DEMO, OTHER]) {
      admitEntry(db, { accountId: acct, producerId: 'scan_dispatch', basis: 'bar', proposal: proposal() })
    }
  }
  const rows = skips(db)
  assert.equal(rows.length, 2, 'one row per account, not one per cycle')
  assert.deepEqual(rows.map(r => r.account_id).sort(), [OTHER, DEMO].sort())
  for (const r of rows) {
    assert.equal(r.decision, 'skip')
    assert.equal(r.reason, 'producer_retired: scan_dispatch')
    assert.equal(r.symbol, 'EURUSD')
    assert.equal(r.strategy, 'donchian_breakout')
  }
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM risk_events`).get().n, 0, 'no veto row: a retirement is cycle-stable and per account')

  // A DIFFERENT setup is its own record — the ledger needs one scoreable row
  // per opportunity, and collapsing them all into one would throw the
  // evidence away.
  admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'bar', proposal: proposal({ symbol: 'XAUUSD', strategy: 'vwap_trend' }) })
  assert.equal(skips(db).length, 3)
  // …but a second cycle on that same setup still writes nothing.
  admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'bar', proposal: proposal({ symbol: 'XAUUSD', strategy: 'vwap_trend' }) })
  assert.equal(skips(db).length, 3)
})

test('the refusal carries the proposal levels, so the refusal ledger can score what the retired stack forwent', () => {
  const db = fresh()
  admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'bar', proposal: proposal() })
  const detail = JSON.parse(skips(db)[0].detail_json)
  assert.equal(detail.producerId, 'scan_dispatch')
  assert.match(detail.reason, /^producer_retired: scan_dispatch/)
  assert.deepEqual(
    { entry: detail.proposal.entry, sl: detail.proposal.sl, tp1: detail.proposal.tp1, side: detail.proposal.side },
    { entry: 1.1, sl: 1.09, tp1: 1.13, side: 'BUY' },
  )
  // The ledger's own reader picks it up with its levels intact.
  const pending = evidenceShadowRefusals(db)
  const mine = pending.find(g => g.symbol === 'EURUSD')
  assert.ok(mine, `the ledger reads the skip: ${JSON.stringify(pending)}`)
  assert.equal(mine.account_id, DEMO)
  assert.equal(JSON.parse(mine.proposal_json).sl, 1.09)
  assert.match(mine.reason, /^producer_retired/)
})

test('INVARIANT: every producer marked retired in the inventory is refused by admitEntry — marking one is sufficient and cannot silently do nothing', () => {
  const db = fresh()
  const retired = retiredProducers()
  assert.ok(retired.length >= 5, `the retired roster: ${retired.map(p => p.id).join(', ')}`)
  for (const p of retired) {
    const a = admitEntry(db, { accountId: DEMO, producerId: p.id, basis: p.basis || 'bar' })
    assert.equal(a.ok, false, `${p.id} must be refused`)
    assert.equal(reasonHead(a.reason), 'producer_retired', `${p.id}: ${a.reason}`)
  }
  // And the converse: nothing NOT marked retired is refused for that reason.
  for (const p of ENTRY_PRODUCERS.filter(x => !x.retired)) {
    const a = admitEntry(db, { accountId: DEMO, producerId: p.id, basis: p.basis || 'bar' })
    assert.notEqual(reasonHead(a.reason), 'producer_retired', `${p.id} is not retired`)
  }
})

test('the fence is asked BEFORE the mode and basis checks, so the reason a reader sees is the true one', () => {
  const db = fresh()
  requestEntryMode(db, DEMO, 'STOPPED')
  const a = admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'bar' })
  assert.equal(reasonHead(a.reason), 'producer_retired', `a stopped account still names the retirement: ${a.reason}`)
  // A tick-basis ask on a bar account would have said entry_mode_basis.
  const b = admitEntry(db, { accountId: OTHER, producerId: 'closed_market_limits', basis: 'tick' })
  assert.equal(reasonHead(b.reason), 'producer_retired', b.reason)
})

test('wiring pin: autoTrade asks the fence with the proposal in hand, before the market-hours gate and before any order row (comments stripped)', () => {
  // No injection point: autoTrade builds its own creds and the fence call is
  // invisible from entry-mode.js. Source, stripped of comments.
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const ask = src.indexOf('const retired = admitEntry(db, {')
  assert.ok(ask > 0, 'autoTrade asks admitEntry by name')
  const block = src.slice(ask, ask + 900)
  assert.ok(block.includes('accountId, producerId, basis: \'bar\','), 'asked for THIS account and THIS producer')
  assert.ok(block.includes('proposal: {'), 'with the proposal')
  for (const field of ['entry: synth.entry', 'sl: synth.sl', 'tp1: synth.tp1', 'strategy: synth.strategy']) {
    assert.ok(block.includes(field), `the proposal carries ${field}`)
  }
  assert.ok(block.includes('if (!retired.ok && retired.retired)'), 'only a RETIRED refusal stops the path here; every other verdict is left to the boundary')
  // Before the closed-market branch, the evidence gate and the order row.
  assert.ok(ask < src.indexOf('placeClosedMarketLimit('))
  assert.ok(ask < src.indexOf('const { evidenceGate }'))
  assert.ok(ask < src.indexOf('INSERT INTO trades'))
})

// ---------------------------------------------------------------------------
// FIX ROUND 20-09-2026. The first cut keyed the closed-market and HTF
// branches on a module-level constant, which retired those paths for EVERY
// producer — including the momentum account, whose daily pass runs at 21:05
// UTC with the US and HK markets shut, and the manual_assisted routes. The
// retirement is keyed on the PRODUCER: whose risk it is travels with the
// placement, and the fence answers.
// ---------------------------------------------------------------------------
const limitFakes = () => {
  const placed = []
  return {
    placed,
    risk: {
      loadRiskConfig: () => ({}),
      evaluateTrade: () => ({ approved: true, adjusted_volume: 0.1 }),
      persistRiskEvent: () => {},
      persistPostApprovalVeto: () => {},
    },
    sizing: {
      getVolumeMeta: async () => ({ digits: 2, lotSize: 100, minVolume: 1 }),
      lotsToVolume: (lots) => ({ volume: Math.round(lots * 100), belowMin: false }),
      relativePoints: (d, dg) => Math.round(d * Math.pow(10, dg)),
    },
    exec: { placeOrder: async (_c, p) => { placed.push(p); return { order: { orderId: 9001 } } }, cancelOrder: async () => ({}) },
  }
}
const MOM_SYNTH = { consensus_bias: 'long', entry: 100, sl: 98, tp1: 104, strategy: 'tsmom_long', timeframe: '1d', overall_conviction: 9 }

test('a KEPT producer still rests its closed-market limit — the momentum account and the hand routes are not retired with the scan', async () => {
  const { placeClosedMarketLimit } = await import('./closed-market-limits.js')
  const creds = { host: 'demo', clientId: 'c', clientSecret: 's', accessToken: 't', accountId: DEMO }
  for (const producerId of ['daily_momentum_account', 'cross_sectional_book', 'route_trade_now', 'route_validation_fill']) {
    const db = fresh()
    db.prepare(`INSERT OR REPLACE INTO agent_state (key, value) VALUES ('symbol_id_map', ?)`).run(JSON.stringify({ US30: 7 }))
    const f = limitFakes()
    const r = await placeClosedMarketLimit(db, creds, 'US30', MOM_SYNTH, { ...f, producerId })
    assert.equal(r.placed, true, `${producerId}: ${r.skipped || ''} ${r.reason || ''}`)
    assert.equal(f.placed.length, 1, `${producerId} rests exactly one limit`)
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM pending_orders WHERE note = 'pending-closed'`).get().n, 1)
    assert.equal(skips(db).length, 0, `${producerId}: no retirement skip`)
  }
})

test('the closed-market branch does not queue a kept producer\'s signal — there is no dead-queue path for it (source pin, comments stripped)', () => {
  const src = readFileSync(new URL('../loop.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const branch = src.indexOf('if (!marketGate.open) {')
  assert.ok(branch > 0)
  const block = src.slice(branch, src.indexOf('setState(db, `mkt_closed_logged_', branch))
  // The retirement is not a branch here: nothing short-circuits to the queue
  // before the placement, and the placement carries the caller's producer.
  assert.ok(!block.includes('CLOSED_MARKET_PRODUCER_RETIRED'), 'no module-level retirement guard on this branch')
  assert.ok(block.includes('{ producerId }),'), 'the fence travels with the caller\'s id')
  assert.ok(block.includes('{ producerId, requestedVolume: requestedVol,'), 'and so does the placement')
  // The legacy queue is still only the `off` fallback it always was.
  const queueAt = block.indexOf('queuePendingSignal(')
  assert.ok(queueAt > block.indexOf("r.skipped === 'off'"), 'the queue is reached only when the feature is OFF')
  // A retired producer never reaches this branch: the fence above returns first.
  assert.ok(src.indexOf('const retired = admitEntry(db, {') < branch)
})

test('the evidence does not go dark: a setup refused again after the opportunity window writes a fresh scoreable row', () => {
  const db = fresh()
  const t0 = Date.parse('2026-09-20T10:00:00Z')
  const ask = (now) => admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'bar', proposal: proposal(), now })
  ask(t0)
  ask(t0 + 60_000)                                // next cycle: same opportunity, no row
  ask(t0 + RETIRED_REFUSAL_WINDOW_MS - 1000)      // still inside the window
  assert.equal(skips(db).length, 1, 'one row per opportunity window, not one per cycle')
  ask(t0 + RETIRED_REFUSAL_WINDOW_MS + 1000)      // a new opportunity by the ledger's own gap rule
  assert.equal(skips(db).length, 2, 'the scan keeps producing evidence rather than falling silent after one row')
  assert.ok(RETIRED_REFUSAL_WINDOW_MS > DEFAULT_GAP_MS, 'wider than the gap, so two consecutive rows cannot collapse into one opportunity')
})

test('a refusal with no proposal is recorded once and is NOT read by the refusal ledger — it has nothing to score', () => {
  const db = fresh()
  // The producers own modules ask the fence with an account and no proposal.
  for (let i = 0; i < 3; i++) {
    admitEntry(db, { accountId: DEMO, producerId: 'closed_market_limits', basis: 'bar' })
    admitEntry(db, { accountId: DEMO, producerId: 'vpo_cpp_direct', basis: 'bar' })
  }
  const rows = skips(db)
  assert.equal(rows.length, 2, 'one row per producer, once')
  assert.ok(rows.every(r => r.symbol == null), 'no symbol, no levels')
  assert.deepEqual(evidenceShadowRefusals(db), [],
    'two producers must not collapse into one opportunity key and surface under whichever reason was written first')
  // A proposal-carrying refusal on the same account is still read.
  admitEntry(db, { accountId: DEMO, producerId: 'scan_dispatch', basis: 'bar', proposal: proposal() })
  assert.equal(evidenceShadowRefusals(db).length, 1)
})
