// node --test agent/services/exit-chain.test.js
//
// The exit-chain scaffold (02-09-2026 plan, part 2). Pinned in order of what
// would hurt most: that a family under the floor is `insufficient` and stays
// returned; that the terminal state absorbs and `trail_armed` is empty by
// construction; that `byState` equals exit-counterfactual's on the same
// trades; that `days` is capped at retention; that the module writes
// nothing and imports no strategy module or manager.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB } from '../db.js'
import { recordPositionEvent, POSITION_EVENTS_RETENTION_DAYS, MANAGEMENT_STATES } from './position-events.js'
import { exitCounterfactual } from './exit-counterfactual.js'
import { STRATEGY_REGISTRY, STRATEGY_FAMILIES, familyOf } from './strategies.js'
import {
  stateSequences, fitChain, exitChainReport, compareToTrail,
  EXIT_CHAIN_MIN_CLOSES, CHAIN_STATES, CLOSED,
} from './exit-chain.js'

const MIN = 60_000
const t0 = Date.now() - 3 * 3_600_000
const bar = (m, o, h, l, c) => [t0 + m * MIN, o, h, l, c, 0]
const STOPPED = [bar(0, 100, 100.2, 98.9, 99)]

/**
 * One closed clean-bot trade with a postmortem R and, optionally, a journal
 * path written through recordPositionEvent so the state stamps are the real
 * ones. `path` is a list of event kinds; `sl_moved` to entry is break-even.
 */
function seedClose(db, { strategy = 'rsi2_reversion', r = -1, path = [], bars = STOPPED, accountId = '111', closedAgoDays = 0 } = {}) {
  const closedAt = new Date(Date.now() - closedAgoDays * 86_400_000 - 30 * MIN).toISOString()
  const info = db.prepare(
    `INSERT INTO trades (symbol, side, status, entry_price, sl_price, tp_price, opened_at, closed_at, net_pnl, origin, account_id, label_strategy)
     VALUES ('JPN225','long','closed',100,99,101.6,?,?,?,'bot_market_dispatch',?,?)`
  ).run(new Date(t0).toISOString(), closedAt, r * 100, accountId, strategy)
  const id = Number(info.lastInsertRowid)
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price) VALUES ('JPN225', ?, 'long', 100)`).run(id)
  db.prepare(
    `INSERT INTO trade_postmortems (trade_id, symbol, side, entry_price, sl_price, r_multiple, classification, bars_json)
     VALUES (?, 'JPN225', 'long', 100, 99, ?, 'x', ?)`
  ).run(id, r, bars ? JSON.stringify(bars) : null)
  for (const kind of path) {
    recordPositionEvent(db, {
      tradeId: id, symbol: 'JPN225', kind,
      toValue: kind === 'sl_moved' ? 100 : null,
      rAt: kind === 'sl_moved' ? 0.7 : kind === 'scale_out' ? 1.0 : null,
    })
  }
  return id
}

const fresh = () => initDB(':memory:')

test('every registry key names a family, and the families are the four declared', () => {
  assert.deepEqual([...STRATEGY_FAMILIES], ['mean_reversion', 'breakout', 'trend', 'momentum'])
  for (const s of STRATEGY_REGISTRY) {
    assert.ok(STRATEGY_FAMILIES.includes(s.family), `${s.key} has no family`)
    assert.equal(familyOf(s.key), s.family)
  }
  assert.equal(familyOf('rsi2_reversion'), 'mean_reversion')
  assert.equal(familyOf('donchian_breakout'), 'breakout')
  assert.equal(familyOf('ema_pullback'), 'trend')
  assert.equal(familyOf('nope'), null)
})

test('the matrix is over the five lifecycle states plus one absorbing closed state', () => {
  assert.deepEqual([...CHAIN_STATES], [...MANAGEMENT_STATES, CLOSED])
})

test('sequences: the journal path is read in order, repeats collapse, terminal is closed:<kind>, unstamped is named', () => {
  const db = fresh()
  const a = seedClose(db, { r: 1.5, path: ['sl_moved', 'sl_moved', 'scale_out', 'close'] })
  const b = seedClose(db, { r: -1, path: [] })                       // no journal at all
  const c = seedClose(db, { r: 0.2, path: ['sl_moved'] })            // journaled, never closed in the journal
  const { sequences, considered, skipped } = stateSequences(db)
  assert.equal(considered, 3)
  assert.deepEqual(skipped, { not_clean_origin: 0, no_r: 0 })
  const byId = Object.fromEntries(sequences.map(s => [s.tradeId, s]))
  assert.deepEqual(byId[a].states, ['opened', 'be_moved', 'scaled_out', 'closed:close'])
  assert.equal(byId[a].lastState, 'scaled_out')
  assert.equal(byId[a].rAtTransition, 1.0)
  assert.equal(byId[a].stamped, true)
  assert.deepEqual(byId[b].states, ['opened', 'closed:unstamped'])
  assert.equal(byId[b].stamped, false)
  assert.equal(byId[b].lastState, 'opened')
  assert.equal(byId[b].rAtTransition, null)
  assert.deepEqual(byId[c].states, ['opened', 'be_moved', 'closed:unjournaled'])
  assert.equal(byId[c].family, 'mean_reversion')
})

test('sequences exclude non-clean origins by default, cap days at retention, and scope by account', () => {
  const db = fresh()
  seedClose(db, { r: 1 })
  db.prepare(`UPDATE trades SET origin = 'reconciler_adopted' WHERE id = ?`).run(seedClose(db, { r: 1 }))
  seedClose(db, { r: 1, accountId: '222' })
  seedClose(db, { r: 1, closedAgoDays: POSITION_EVENTS_RETENTION_DAYS + 5 })
  const all = stateSequences(db, { days: 3650 })
  assert.equal(all.days, POSITION_EVENTS_RETENTION_DAYS, 'a longer window would count trades whose journal is already pruned')
  assert.equal(all.sequences.length, 2)
  assert.equal(all.skipped.not_clean_origin, 1)
  assert.equal(stateSequences(db, { cleanOnly: false }).sequences.length, 3)
  assert.equal(stateSequences(db, { accountId: '111' }).sequences.length, 1)
})

test('fitChain: counts and row-normalised probabilities; closed:* absorbs; trail_armed row is empty by construction', () => {
  const seqs = [
    { r: 1.5, stamped: true, states: ['opened', 'be_moved', 'scaled_out', 'closed:close'], lastState: 'scaled_out', rAtTransition: 1.0 },
    { r: -1, stamped: true, states: ['opened', 'closed:close'], lastState: 'opened', rAtTransition: null },
    { r: 0.5, stamped: true, states: ['opened', 'be_moved', 'closed:loss_cap_close'], lastState: 'be_moved', rAtTransition: 0.7 },
    { r: -1, stamped: false, states: ['opened', 'closed:unstamped'], lastState: 'opened', rAtTransition: null },
  ]
  const c = fitChain(seqs, { minCloses: 3 })
  assert.equal(c.n, 4)
  assert.equal(c.stamped, 3)
  assert.equal(c.status, 'fitted')
  assert.equal(c.transitions.opened.be_moved, 2)
  assert.equal(c.transitions.opened.closed, 2)
  assert.equal(c.transitions.be_moved.scaled_out, 1)
  assert.equal(c.transitions.be_moved.closed, 1)
  assert.equal(c.transitions.scaled_out.closed, 1)
  assert.equal(c.probabilities.opened.be_moved, 0.5)
  assert.equal(c.probabilities.be_moved.closed, 0.5)
  // Absorbing: nothing leaves closed, and its row is all-null probabilities.
  assert.equal(Object.values(c.transitions.closed).reduce((a, b) => a + b, 0), 0)
  assert.ok(Object.values(c.probabilities.closed).every(p => p === null))
  // trail_armed: present, empty.
  assert.ok('trail_armed' in c.transitions)
  assert.equal(Object.values(c.transitions.trail_armed).reduce((a, b) => a + b, 0), 0)
  assert.ok(Object.values(c.probabilities.trail_armed).every(p => p === null))
  // byState: the counterfactual's shape.
  assert.deepEqual(c.byState.opened, { n: 2, wins: 0, totalR: -2, expectancyR: -1, winRate: 0, meanRAtTransition: null })
  assert.deepEqual(c.byState.scaled_out, { n: 1, wins: 1, totalR: 1.5, expectancyR: 1.5, winRate: 100, meanRAtTransition: 1 })
  // Under the floor it is still returned, and says so.
  assert.equal(fitChain(seqs, { minCloses: 4 }).status, 'insufficient')
  assert.equal(fitChain(seqs, { minCloses: 4 }).transitions.opened.be_moved, 2, 'the matrix is returned, its status is what changes')
  assert.equal(fitChain([]).status, 'insufficient')
  assert.equal(fitChain([]).minCloses, EXIT_CHAIN_MIN_CLOSES)
})

test('report: every declared family is present at n=0, verdict INSUFFICIENT until one family reaches the floor', () => {
  const db = fresh()
  let r = exitChainReport(db)
  assert.equal(r.verdict, 'INSUFFICIENT')
  assert.deepEqual(Object.keys(r.families).sort(), ['breakout', 'mean_reversion', 'momentum', 'trend'])
  assert.equal(r.minCloses, EXIT_CHAIN_MIN_CLOSES)
  assert.equal(r.biases.length, 2)
  for (let i = 0; i < 5; i++) seedClose(db, { strategy: 'rsi2_reversion', r: i % 2 ? 1 : -1, path: ['sl_moved', 'close'] })
  for (let i = 0; i < 2; i++) seedClose(db, { strategy: 'donchian_breakout', r: 2, path: ['close'] })
  r = exitChainReport(db, { minClosesPerFamily: 5 })
  assert.equal(r.verdict, 'FITTED')
  assert.equal(r.families.mean_reversion.status, 'fitted')
  assert.equal(r.families.mean_reversion.n, 5)
  assert.equal(r.families.breakout.status, 'insufficient')
  assert.equal(r.families.breakout.n, 2)
  assert.equal(r.families.trend.n, 0)
  assert.equal(r.n, 7)
  assert.equal(r.stamped, 7)
  // An attributed strategy outside the registry lands in its own bucket, never dropped.
  seedClose(db, { strategy: 'burnin', r: -1, path: ['close'] })
  r = exitChainReport(db, { minClosesPerFamily: 5 })
  assert.equal(r.families.unfamilied.n, 1)
  assert.equal(r.n, 8)
})

test('byState equals exit-counterfactual\'s on the bars-filtered subset, and the trail comparison rides on the same trades', () => {
  const db = fresh()
  for (let i = 0; i < 4; i++) seedClose(db, { r: 1.2, path: ['sl_moved', 'scale_out', 'close'] })
  for (let i = 0; i < 3; i++) seedClose(db, { r: -1, path: ['close'] })
  seedClose(db, { r: 0.4, path: ['sl_moved', 'close'], bars: null }) // no bar window: in the chain, not the counterfactual
  const chain = exitChainReport(db, { days: 30, minClosesPerFamily: 1 })
  const cf = exitCounterfactual(db, { days: 30 })
  assert.equal(chain.n, 8)
  assert.equal(cf.eligible, 7)
  // On the trades both can see, the per-state figures agree exactly.
  for (const st of ['scaled_out', 'opened']) {
    assert.deepEqual(chain.families.mean_reversion.byState[st], cf.byState[st], `byState.${st}`)
  }
  assert.equal(chain.families.mean_reversion.byState.be_moved.n, 1, 'the bars-less trade is only in the chain')
  assert.equal(cf.byState.be_moved, undefined)
  const tc = chain.trailComparison
  assert.equal(tc.eligible, 7)
  assert.deepEqual(Object.keys(tc.rules), ['trail_0.5R', 'trail_1R'])
  assert.deepEqual(tc.byState, cf.byState)
  assert.equal(compareToTrail(db, { days: 30 }).eligible, 7)
})

test('read-only: row counts identical before and after; source imports no strategy module or manager', () => {
  const db = fresh()
  seedClose(db, { r: 1, path: ['sl_moved', 'close'] })
  const count = () => ['trades', 'position_events', 'trade_postmortems', 'agent_state', 'monitored_positions']
    .map(t => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n)
  const before = count()
  exitChainReport(db); stateSequences(db); compareToTrail(db)
  assert.deepEqual(count(), before)
  const src = readFileSync(new URL('./exit-chain.js', import.meta.url), 'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  const imports = [...src.matchAll(/from '([^']+)'/g)].map(m => m[1])
  const allowed = new Set(['../lib/trade-origin.js', '../lib/strategy-attribution.js', './strategies.js', './position-events.js', './exit-counterfactual.js'])
  for (const i of imports) assert.ok(allowed.has(i), `unexpected import ${i}`)
  assert.ok(!/\b(INSERT|UPDATE|DELETE|setState|recordPositionEvent)\b/.test(src), 'the chain writes nothing')
})

test('the journal has a (trade_id, id) index, and the route is declared once with days, account and minCloses', () => {
  const db = fresh()
  const idx = db.prepare(`PRAGMA index_list(position_events)`).all().map(i => i.name)
  assert.ok(idx.includes('idx_position_events_trade'), idx.join(','))
  const cols = db.prepare(`PRAGMA index_info(idx_position_events_trade)`).all().map(c => c.name)
  assert.deepEqual(cols, ['trade_id', 'id'])
  const src = readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8')
  assert.equal((src.match(/router\.get\('\/exit-chain'/g) || []).length, 1)
  const body = src.slice(src.indexOf("router.get('/exit-chain'"))
  const block = body.slice(0, body.indexOf('\n  })\n') + 6)
  assert.ok(block.includes("import('../services/exit-chain.js')"))
  assert.ok(block.includes('requestedAccount(db, req)'))
  assert.ok(block.includes('req.query.minCloses'))
})
