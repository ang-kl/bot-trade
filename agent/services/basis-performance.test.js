// agent/services/basis-performance.test.js — plan P1 and D1–D3: the entry
// basis on every closed trade (never 'unknown'), one frozen metric
// definition, exact pinned figures, 'insufficient' below the owner's
// minimum, and a closed window that never changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { initDB } from '../db.js'
import { basisOfTrade, basisPerformanceReport, closedTradesWithBasis, METRIC_DEFINITION } from './basis-performance.js'
import { intentMaps } from './trade-basis.js'
import { loadThresholds, tradedTickEvidence } from './tick-validation.js'

const A = '46130058', B = '47790949'
const T0 = Date.parse('2026-09-01T00:00:00Z')
let seq = 0

function intent(db, { id, account = A, basis = 'tick', producer = 'tick_momentum', state = 'FILLED', positionId = null }) {
  db.prepare(`INSERT INTO entry_intents (id, account_id, environment, symbol, symbol_id, side, order_type, volume, producer_id, basis, mode_epoch, config_revision, permit_id, permit_expires_at, state, broker_position_id)
              VALUES (?, ?, 'demo', 'EURUSD', 1, 'BUY', 'MARKET', 1000, ?, ?, 1, 1, ?, '2026-09-01T00:00:00Z', ?, ?)`)
    .run(id, account, producer, basis, `p-${id}`, state, positionId == null ? null : String(positionId))
}

/** A closed trade at T0 + n hours with a stamped R; gross = net unless given. */
function close(db, { account = A, r, net = null, gross = null, label = 'AP|v1|TREND|HI|LDN|1h', source = 'autopilot', positionId = null, atMs = null, mismatch = null }) {
  seq += 1
  const at = atMs ?? T0 + seq * 3_600_000
  const n = net ?? r * 100
  db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, status, closed_at, closed_at_ms, net_pnl, gross_pnl, realised_rr, pnl_price_mismatch, label_raw, source, account_id, ctrader_position_id)
              VALUES ('EURUSD', 'BUY', 1.1, 1.1, 1.09, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(new Date(at).toISOString().replace('T', ' ').slice(0, 19), at, n, gross ?? n, r, mismatch, label, source, account, positionId == null ? null : String(positionId))
}

const PATTERN = [2, -1, -1, 1.5, -1, 3, -1, 0.5, -1, -1]

test('basisOfTrade: intent, label intent, tick label, and bar — never unknown', () => {
  const db = initDB(':memory:')
  intent(db, { id: 'iaaaaaa1', positionId: 101 })
  intent(db, { id: 'ibbbbbb2', positionId: null })
  close(db, { r: 1, positionId: 101, label: 'tick:hash|||||||iaaaaaa1', source: 'autopilot' })       // A
  close(db, { r: 1, positionId: 202, label: 'tick:hash|||||||ibbbbbb2', source: 'autopilot' })       // B
  close(db, { r: 1, positionId: 303, label: 'tick:abc', source: 'autopilot' })                       // C
  close(db, { r: 1, positionId: 404, label: 'AP|v1|RSI2|HI|LDN|1h', source: 'autopilot' })            // D
  const got = closedTradesWithBasis(db).map(t => `${t.basis}/${t.basisSource}`)
  assert.deepEqual(got, ['tick/intent', 'tick/label_intent', 'tick/label', 'bar/no_intent_bar'])
  for (const t of closedTradesWithBasis(db)) { assert.ok(t.basis); assert.notEqual(t.basis, 'unknown') }
})

test('basisOfTrade: an intent on ANOTHER account never resolves the basis, by position or by tag', () => {
  const db = initDB(':memory:')
  intent(db, { id: 'icccccc3', account: B, positionId: 555 })
  close(db, { account: A, r: 1, positionId: 555, label: 'AP|v1|TREND|HI|LDN|1h' })
  close(db, { account: A, r: 1, positionId: 556, label: 'AP|v1|TREND|HI|LDN|1h|icccccc3' })
  const got = closedTradesWithBasis(db).map(t => `${t.basis}/${t.basisSource}`)
  assert.deepEqual(got, ['bar/no_intent_bar', 'bar/no_intent_bar'])
})

test('basisOfTrade: every intent state is keyed (not only FILLED), and the state is carried', () => {
  const { byPos, byId } = (() => { const db = initDB(':memory:'); intent(db, { id: 'idddddd4', state: 'UNKNOWN', positionId: 77 }); return intentMaps(db) })()
  const b = basisOfTrade({ account_id: A, ctrader_position_id: '77', label_raw: '', source: 'autopilot' }, byPos, byId)
  assert.deepEqual(b, { basis: 'tick', basisSource: 'intent', intentId: 'idddddd4', intentState: 'UNKNOWN' })
})

test('basisOfTrade: manual, external and pre-open trades are their OWN class, never bar', () => {
  const db = initDB(':memory:')
  close(db, { r: 1, label: 'MAN|v1|-', source: 'manual' })
  close(db, { r: 1, label: 'some broker label', source: 'external' })
  close(db, { r: 1, label: 'PRE|v1|TREND|HI|LDN|1h', source: 'autopilot' })
  close(db, { r: 1, label: '', source: null })
  close(db, { r: 1, label: '', source: 'autopilot' })
  const got = closedTradesWithBasis(db).map(t => `${t.basis}/${t.basisSource}`)
  assert.deepEqual(got, ['manual/trade_source', 'external/trade_source', 'preopen/label_source', 'external/no_owner_evidence', 'bar/no_intent_bar'])
})

test('pinned figures (D3): 30 tick trades → exact PF, payoff, wins, Wilson interval and lower bounds, stamped r-net-v1', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 30; i++) close(db, { r: PATTERN[i % 10], label: 'tick:pin', source: 'autopilot' })
  const rep = basisPerformanceReport(db, { accountId: A, days: 0, now: T0 + 40 * 86_400_000 })
  assert.equal(rep.metricDefinition, 'r-net-v1')
  const t = rep.accounts[0].byBasis.tick
  assert.equal(t.trades, 30); assert.equal(t.wins, 12); assert.equal(t.losses, 18)
  assert.equal(t.netR, 3)
  assert.equal(t.profitFactor, 1.167)
  assert.equal(t.payoff, 1.75)
  assert.deepEqual(t.winRate, { pct: 40, lo: 24.59, hi: 57.68, method: 'wilson-95' })
  assert.equal(t.expectancyR, 0.1)
  assert.equal(t.expectancyLowerR, -0.3333)
  assert.equal(t.blockExpectancyLowerR, -0.1)
  assert.equal(t.maxDrawdownR, 2.5)
  assert.equal(rep.reconciled, true)
})

test('D3: the metric definition is frozen and pinned — an edit without a new id is red', () => {
  assert.equal(Object.isFrozen(METRIC_DEFINITION), true)
  assert.deepEqual(Object.keys(METRIC_DEFINITION), ['id', 'unit', 'netR', 'win', 'loss', 'profitFactor', 'payoff', 'winRate', 'expectancy', 'order', 'window', 'sampleMinimum'])
  assert.equal(METRIC_DEFINITION.id, 'r-net-v1')
  assert.equal(METRIC_DEFINITION.win, 'net R > 0')
  assert.equal(METRIC_DEFINITION.winRate, 'wins / trades, with the Wilson 95 % interval (z = 1.96)')
})

test('D3 drift: a CLOSED window\'s figures do not change when later trades land', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 30; i++) close(db, { r: PATTERN[i % 10], label: 'tick:pin', atMs: T0 + i * 3_600_000 })
  const win = { accountId: A, fromMs: T0, toMs: T0 + 30 * 3_600_000, now: T0 + 60 * 86_400_000 }
  const before = basisPerformanceReport(db, win)
  // later trades, a later bar trade, and one exactly AT toMs (the window is half-open)
  close(db, { r: 5, label: 'tick:pin', atMs: T0 + 30 * 3_600_000 })
  for (let i = 0; i < 10; i++) close(db, { r: -1, label: 'tick:pin', atMs: T0 + (31 + i) * 3_600_000 })
  close(db, { r: 4, atMs: T0 + 50 * 3_600_000 })
  const after = basisPerformanceReport(db, { ...win, now: T0 + 90 * 86_400_000 })
  assert.equal(after.window.closed, true)
  assert.deepEqual(after.accounts, before.accounts)
  assert.equal(after.accounts[0].byBasis.tick.profitFactor, 1.167)
  assert.deepEqual(after.accounts[0].byBasis.tick.winRate, { pct: 40, lo: 24.59, hi: 57.68, method: 'wilson-95' })
})

test('insufficient: 29 bar trades publish no derived figure; 30 publish numbers; the minimum is the owner file\'s', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 29; i++) close(db, { r: PATTERN[i % 10] })
  const now = T0 + 40 * 86_400_000
  assert.equal(loadThresholds().traded.minTrades, 30, 'the owner-held minimum is read, not copied')
  const b = basisPerformanceReport(db, { days: 0, now }).accounts[0].byBasis.bar
  for (const k of ['profitFactor', 'winRate', 'payoff', 'expectancyR', 'expectancyLowerR', 'blockExpectancyLowerR']) {
    assert.deepEqual(b[k], { status: 'insufficient', trades: 29, needed: 30 }, k)
  }
  assert.equal(b.trades, 29); assert.equal(typeof b.wins, 'number'); assert.equal(typeof b.netR, 'number')
  close(db, { r: PATTERN[9] })
  const b30 = basisPerformanceReport(db, { days: 0, now }).accounts[0].byBasis.bar
  assert.equal(typeof b30.profitFactor, 'number'); assert.equal(typeof b30.winRate.lo, 'number')
})

test('insufficient: the gate reads the thresholds it is given — a file with minTrades 5, and null → thresholds_unset', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 6; i++) close(db, { r: PATTERN[i] })
  const dir = mkdtempSync(join(tmpdir(), 'basis-perf-'))
  try {
    const file = join(dir, 'tick-validation.json')
    writeFileSync(file, JSON.stringify({ traded: { minTrades: 5 } }))
    const five = basisPerformanceReport(db, { days: 0, now: T0 + 9 * 86_400_000, thresholdsFile: file }).accounts[0].byBasis.bar
    assert.equal(typeof five.profitFactor, 'number', 'six trades pass a minimum of five')
    writeFileSync(file, JSON.stringify({ traded: { minTrades: 7 } }))
    const seven = basisPerformanceReport(db, { days: 0, now: T0 + 9 * 86_400_000, thresholdsFile: file }).accounts[0].byBasis.bar
    assert.deepEqual(seven.profitFactor, { status: 'insufficient', trades: 6, needed: 7 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
  const unset = basisPerformanceReport(db, { days: 0, now: T0 + 9 * 86_400_000, thresholds: { traded: { minTrades: null } } }).accounts[0].byBasis.bar
  assert.deepEqual(unset.profitFactor, { status: 'thresholds_unset', trades: 6, needed: null })
  assert.deepEqual(unset.winRate, { status: 'thresholds_unset', trades: 6, needed: null })
})

test('net R: a trade that won on price and lost after commission is a LOSS; sign disagreement keeps gross and is counted', () => {
  const db = initDB(':memory:')
  close(db, { r: 0.1, gross: 10, net: -5 })                 // won on price, lost net → −0.05 R
  close(db, { r: 1, gross: 100, net: 80 })                  // 0.8 R
  close(db, { r: 1, gross: -20, net: -25 })                 // signs disagree → gross 1 R, grossOnly
  close(db, { r: 2, gross: 200, net: 190, mismatch: 1 })    // flagged mismatch → gross 2 R, grossOnly
  const rows = closedTradesWithBasis(db)
  assert.deepEqual(rows.map(r => +r.netR.toFixed(4)), [-0.05, 0.8, 1, 2])
  assert.deepEqual(rows.map(r => r.rBasis), ['net', 'net', 'gross', 'gross'])
  const b = basisPerformanceReport(db, { days: 0, now: T0 + 9 * 86_400_000, thresholds: { traded: { minTrades: 1 } } }).accounts[0].byBasis.bar
  assert.equal(b.wins, 3); assert.equal(b.losses, 1); assert.equal(b.grossOnly, 2)
})

test('payoff is null, not a division by zero, with no losses or no wins', () => {
  const db = initDB(':memory:')
  for (let i = 0; i < 3; i++) close(db, { r: 1 })
  const b = basisPerformanceReport(db, { days: 0, now: T0 + 9 * 86_400_000, thresholds: { traded: { minTrades: 1 } } }).accounts[0].byBasis.bar
  assert.equal(b.payoff, null); assert.equal(b.profitFactor, null)
})

test('reconciliation: the tick count equals tradedTickEvidence where every tick trade has an intent; basis counts + unscorable = closed trades', () => {
  const db = initDB(':memory:')
  const rs = [2, -1, 1, -1, 3]
  rs.forEach((r, i) => { intent(db, { id: `itick${String(i).padStart(3, '0')}`, positionId: 900 + i }); close(db, { r, positionId: 900 + i, label: `tick:h|||||||itick${String(i).padStart(3, '0')}` }) })
  close(db, { r: 1 })
  close(db, { r: null, label: 'MAN|v1|-', source: 'manual' })  // no stop in R → unscorable, still counted
  db.prepare("UPDATE trades SET sl_price = NULL, realised_rr = NULL WHERE source = 'manual'").run()
  const rep = basisPerformanceReport(db, { accountId: A, days: 0, now: T0 + 9 * 86_400_000 })
  const acct = rep.accounts[0]
  assert.equal(acct.byBasis.tick.trades, tradedTickEvidence(db, A).trades)
  assert.equal(acct.byBasis.tick.trades, 5)
  assert.equal(acct.byBasis.manual.unscorable, 1)
  const sum = Object.values(acct.byBasis).reduce((s, b) => s + b.trades + b.unscorable, 0)
  assert.equal(sum, rep.closedTrades); assert.equal(rep.closedTrades, 7); assert.equal(rep.reconciled, true)
})

test('per account: each account is its own row; an account filter reads only that account', () => {
  const db = initDB(':memory:')
  close(db, { account: A, r: 1 }); close(db, { account: B, r: -1 }); close(db, { account: B, r: 2 })
  const all = basisPerformanceReport(db, { days: 0, now: T0 + 9 * 86_400_000 })
  assert.deepEqual(all.accounts.map(a => [a.accountId, a.closes]), [[A, 1], [B, 2]])
  const one = basisPerformanceReport(db, { accountId: B, days: 0, now: T0 + 9 * 86_400_000 })
  assert.deepEqual(one.accounts.map(a => a.accountId), [B])
})

test('GET /state/basis-performance: stamped r-net-v1, scoped by ?account, closed window by ?from=&to=', async () => {
  const db = initDB(':memory:')
  close(db, { account: A, r: 1, atMs: T0 + 3_600_000 })
  close(db, { account: B, r: -1, atMs: T0 + 3_600_000 })
  close(db, { account: A, r: 2, atMs: T0 + 5 * 3_600_000 })
  const { default: stateRouter } = await import('../routes/state.js')
  const app = express()
  app.use('/state', stateRouter(db))
  const s = await new Promise(resolve => { const srv = app.listen(0, () => resolve(srv)) })
  try {
    const base = `http://127.0.0.1:${s.address().port}/state/basis-performance`
    const all = await fetch(`${base}?days=0`).then(x => x.json())
    assert.equal(all.metricDefinition, 'r-net-v1')
    assert.deepEqual(all.accounts.map(a => a.accountId), [A, B])
    const one = await fetch(`${base}?days=0&account=${B}`).then(x => x.json())
    assert.deepEqual(one.accounts.map(a => a.accountId), [B])
    const win = await fetch(`${base}?account=${A}&from=${T0}&to=${T0 + 2 * 3_600_000}`).then(x => x.json())
    assert.equal(win.window.closed, true); assert.equal(win.closedTrades, 1)
  } finally { s.close() }
})
