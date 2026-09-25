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
  assert.deepEqual(b, { basis: 'tick', basisSource: 'intent', intentId: 'idddddd4', intentState: 'UNKNOWN', intentBasis: 'tick' })
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

test('basisOfTrade (PR #1086 blocker 1): a pre-open or manual trade WITH a non-tick ledger intent is not bar — the checker\'s three positions', () => {
  const db = initDB(':memory:')
  intent(db, { id: 'ipre0011', basis: 'bar', producer: 'closed_market_limits', positionId: 11 })
  intent(db, { id: 'iman0012', basis: 'bar', producer: 'route_manual_order', positionId: 12 })   // written before WP-A
  close(db, { r: 1, positionId: 11, label: 'PRE|v1|TREND|HI|LDN|1h', source: 'preopen' })   // 11
  close(db, { r: 1, positionId: 12, label: 'MAN|v1|-', source: 'manual' })                   // 12
  close(db, { r: 1, positionId: 13, label: 'PRE|v1|TREND|HI|LDN|1h', source: 'preopen' })   // 13, no intent
  const got = closedTradesWithBasis(db).map(t => `${t.basis}/${t.basisSource}`)
  assert.deepEqual(got, ['preopen/trade_source', 'manual/trade_source', 'preopen/trade_source'])
  const [p11, p12] = closedTradesWithBasis(db)
  assert.equal(p11.intentId, 'ipre0011'); assert.equal(p11.intentBasis, 'bar', 'the intent is still carried')
  assert.equal(p12.intentId, 'iman0012')
})

test('basisOfTrade: with a non-tick intent, label evidence, then the producer, then the intent\'s basis; tick stays authoritative; external does not override', () => {
  const db = initDB(':memory:')
  intent(db, { id: 'ia000021', basis: 'bar', producer: 'scan_dispatch', positionId: 21 })
  intent(db, { id: 'ia000022', basis: 'bar', producer: 'closed_market_limits', positionId: 22 })
  intent(db, { id: 'ia000023', basis: 'bar', producer: 'route_trade_now', positionId: 23 })
  intent(db, { id: 'ia000024', basis: 'manual_assisted', producer: 'route_execute_trade', positionId: 24 })
  intent(db, { id: 'ia000025', basis: 'manual', producer: 'route_manual_order', positionId: 25 })
  intent(db, { id: 'ia000026', basis: 'tick', producer: 'tick_momentum', positionId: 26 })
  intent(db, { id: 'ia000027', basis: 'bar', producer: 'scan_dispatch', positionId: 27 })
  intent(db, { id: 'ia000028', basis: 'manual_assisted', producer: 'some_future_id', positionId: 28 })
  close(db, { r: 1, positionId: 21, label: 'PRE|v1|TREND|HI|LDN|1h', source: 'autopilot' })  // label PRE beats a bar intent
  close(db, { r: 1, positionId: 22, label: 'AP|v1|TREND|HI|LDN|1h', source: 'autopilot' })   // no PRE evidence: the producer answers
  close(db, { r: 1, positionId: 23, label: '', source: 'autopilot' })                         // manual_assisted family → manual
  close(db, { r: 1, positionId: 24, label: '', source: 'autopilot' })                         // WP-A manual_assisted basis → manual
  close(db, { r: 1, positionId: 25, label: '', source: 'autopilot' })                         // WP-A manual basis → manual
  close(db, { r: 1, positionId: 26, label: 'MAN|v1|-', source: 'manual' })                   // a tick intent is authoritative
  close(db, { r: 1, positionId: 27, label: 'x', source: 'external' })                        // external is no evidence against an intent
  close(db, { r: 1, positionId: 28, label: '', source: 'autopilot' })                         // unknown producer, manual_assisted basis → manual
  const rows = closedTradesWithBasis(db)
  assert.deepEqual(rows.map(t => `${t.basis}/${t.basisSource}`), [
    'preopen/label_source', 'preopen/intent_producer', 'manual/intent_producer', 'manual/intent_producer',
    'manual/intent_producer', 'tick/intent', 'bar/intent', 'manual/intent',
  ])
  assert.deepEqual(rows.map(t => t.intentBasis), ['bar', 'bar', 'bar', 'manual_assisted', 'manual', 'tick', 'bar', 'manual_assisted'])
  const rep = basisPerformanceReport(db, { days: 0, now: T0 + 9 * 86_400_000 })
  assert.deepEqual(Object.keys(rep.accounts[0].byBasis), ['bar', 'manual', 'preopen', 'tick'], 'no separate manual_assisted row')
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

test('D3: the metric definition is frozen and pinned — an edit to ANY field without a new id is red', () => {
  assert.equal(Object.isFrozen(METRIC_DEFINITION), true)
  // Every field, verbatim, in order (PR #1086 review: pinning four of twelve
  // let a profitFactor edit under the same id stay green). A change here is a
  // change of definition: give it a new id, and change this pin with it.
  assert.deepEqual(Object.entries(METRIC_DEFINITION), Object.entries({
    id: 'r-net-v1',
    unit: 'R of the stop the broker first held (broker_sl_initial, else sl_price)',
    netR: 'realised_rr × net_pnl / gross_pnl when the signs agree; else gross realised_rr, counted grossOnly',
    win: 'net R > 0',
    loss: 'net R < 0 (0 R is neither)',
    profitFactor: 'gross winning R / gross losing R; null with no losing trade',
    payoff: '(gross winning R / wins) / (gross losing R / losses); null with no wins or no losses',
    winRate: 'wins / trades, with the Wilson 95 % interval (z = 1.96)',
    expectancy: 'mean net R; lower bounds = 5th percentile of 1000 bootstrap means (seed 7) and of circular moving blocks',
    order: 'close order (closed_at_ms, else closed_at), then id',
    window: '[fromMs, toMs) on the close stamp',
    sampleMinimum: 'traded.minTrades from agent/config/tick-validation.json',
    unscorable: 'counted, never scored: no R (noR); R = 0 with a non-zero net (scratchCost); exit_price_suspect = 1 (suspectExit)',
  }))
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
  assert.deepEqual(acct.byBasis.manual.unscorableBy, { noR: 1, scratchCost: 0, suspectExit: 0 })
  const sum = Object.values(acct.byBasis).reduce((s, b) => s + b.trades + b.unscorable, 0)
  assert.equal(sum, rep.closedTrades); assert.equal(rep.closedTrades, 7); assert.equal(rep.reconciled, true)
  assert.deepEqual(rep.reconciliation, { basisSum: 7, independentCount: 7, noCloseStamp: 0 })
})

test('unscorable, named: R = 0 with a non-zero net (a cost-only close) and exit_price_suspect = 1 are counted, never scored', () => {
  const db = initDB(':memory:')
  close(db, { r: 1, gross: 100, net: 90 })                     // scored: 0.9 R
  close(db, { r: -1, gross: -100, net: -110 })                 // scored: −1.1 R
  close(db, { r: 0, gross: 0, net: -156.95 })                  // commission only: was 0 R, neither win nor loss
  close(db, { r: 0, gross: 0, net: 0 })                        // a true scratch: 0 R, scored, neither
  close(db, { r: 2, gross: 200, net: 190 })                    // exit price suspect: not scored
  db.prepare('UPDATE trades SET exit_price_suspect = 1 WHERE id = (SELECT MAX(id) FROM trades)').run()
  const rows = closedTradesWithBasis(db)
  assert.deepEqual(rows.map(r => r.unscorableAs), [null, null, 'scratchCost', null, 'suspectExit'])
  assert.deepEqual(rows.map(r => r.netR == null ? null : +r.netR.toFixed(4)), [0.9, -1.1, null, 0, null])
  const b = basisPerformanceReport(db, { days: 0, now: T0 + 9 * 86_400_000, thresholds: { traded: { minTrades: 1 } } }).accounts[0].byBasis.bar
  assert.equal(b.trades, 3); assert.equal(b.wins, 1); assert.equal(b.losses, 1)
  assert.equal(b.unscorable, 2)
  assert.deepEqual(b.unscorableBy, { noR: 0, scratchCost: 1, suspectExit: 1 })
  assert.equal(b.closes, 5); assert.equal(b.netUsd, 13.05, 'the money of an unscorable close still counts')
})

test('reconciled compares against an INDEPENDENT count: a legacy close stamp the string window misplaces turns it false', () => {
  const db = initDB(':memory:')
  const from = Date.parse('2026-09-01T00:00:00Z')
  close(db, { r: 1, atMs: from + 3_600_000 })
  close(db, { r: 1, atMs: from + 2 * 3_600_000 })
  const now = from + 9 * 86_400_000
  const ok = basisPerformanceReport(db, { fromMs: from, toMs: now, now })
  assert.equal(ok.reconciled, true); assert.deepEqual(ok.reconciliation, { basisSum: 2, independentCount: 2, noCloseStamp: 0 })
  // closed 2026-08-31 21:00 UTC, stamped with an offset and no closed_at_ms:
  // the string compare puts it inside [from, …), its time does not
  close(db, { r: 1 })
  db.prepare("UPDATE trades SET closed_at_ms = NULL, closed_at = '2026-09-01T05:00:00+08:00' WHERE id = (SELECT MAX(id) FROM trades)").run()
  // and one close with no stamp at all: outside every window, named
  close(db, { r: 1 })
  db.prepare('UPDATE trades SET closed_at_ms = NULL, closed_at = NULL WHERE id = (SELECT MAX(id) FROM trades)').run()
  const bad = basisPerformanceReport(db, { fromMs: from, toMs: now, now })
  assert.equal(bad.closedTrades, 3)
  assert.equal(bad.reconciled, false)
  assert.deepEqual(bad.reconciliation, { basisSum: 3, independentCount: 2, noCloseStamp: 1 })
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
