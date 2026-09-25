// agent/services/strategy-qualification.test.js — V3 Q4b (PR-B1): bar-side
// qualification, report only. Pinned: exact PF-R, PF-USD, Wilson bounds and
// ETA on a fixture; 'insufficient' under the bar; the ETA ages today's closes
// out of the rolling window; pooled copies count once; every cell reconciles
// with the gate's own reader; and a CLOSED month is sealed append-only — a
// trade rewritten after the month closes leaves the sealed figure unchanged
// and appends a restatement beside it (D3).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { initDB, getState, setState } from '../db.js'
import { setStage } from './stage-matrix.js'
import {
  strategyQualificationReport, reachability, clusterCopies, monthWindows, sealClosedWindows, stampMs,
  QUALIFICATION_DEFINITION, UNREACHABLE, COPY_WINDOW_MS,
} from './strategy-qualification.js'
import { evidenceGate, evidenceRecord, EVIDENCE_GATE_KEY } from './evidence-gate.js'

const A = '111', B = '222', C = '333'
const DAY = 86_400_000
const NOW = Date.parse('2026-09-25T00:00:00Z')
const PATTERN = [2, -1, -1, 1.5, -1, 3, -1, 0.5, -1, -1]
const stamp = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19)

function fresh() {
  const db = initDB(':memory:')
  const acct = db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode, base_currency) VALUES (?, ?, 0, 1, 'active', ?)`)
  acct.run(A, '1', 'USD'); acct.run(B, '2', 'USD'); acct.run(C, '3', 'SGD')
  return db
}

/** One clean bot close; R stamped, gross = net unless given. */
function close(db, { strategy, account = A, r, net, gross = net, atMs, openMs = atMs - 3_600_000, symbol = 'EURUSD', side = 'BUY', origin = 'bot_market_dispatch', sl = 1.09 }) {
  return Number(db.prepare(`INSERT INTO trades (symbol, side, entry_price, exit_price, sl_price, status, label_strategy, origin, account_id, opened_at, closed_at, closed_at_ms, realised_rr, net_pnl, gross_pnl)
      VALUES (?, ?, 1.1, 1.1, ?, 'closed', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(symbol, side, sl, strategy, origin, account, stamp(openMs), stamp(atMs), atMs, r, net, gross).lastInsertRowid)
}

/** 30 closes on A: PF-R 21/18, but the money of the third run is sized so PF-USD is 1540/3000. */
function pinnedFixture(db) {
  for (let i = 0; i < 30; i++) {
    const r = PATTERN[i % 10]
    const net = i < 20 ? r * 100 : (r > 0 ? r * 20 : r * 300)
    close(db, { strategy: 'rsi2_reversion', account: A, r, net, atMs: NOW - (i + 1) * 3_600_000 })
  }
}

const cellOf = (rep, s, a) => rep.cells.find(c => c.strategy === s && c.accountId === a)

test('the definition is frozen and pinned — an edit to ANY field without a new id is red', () => {
  assert.equal(Object.isFrozen(QUALIFICATION_DEFINITION), true)
  assert.deepEqual(Object.entries(QUALIFICATION_DEFINITION), Object.entries({
    id: 'bar-qualification-v1',
    population: "the evidence gate's (evidence-gate.js evidenceRows): status closed, net_pnl known, a label_strategy, origin bot_*, closed_at in the window; per account = the account's rows plus unscoped legacy rows",
    bar: 'evidence_gate_json minCloses over windowDays, read at report time, never copied',
    profitFactorR: 'r-net-v1 (pf-metrics.js) over R-scored closes; unscored closes counted by reason',
    profitFactorUsd: "usd-net-v0 (pf-metrics.js) over closes: the gate's own figure",
    winRate: 'r-net-v1 wins / R-scored closes, with the Wilson 95 % interval (z = 1.96); reported, never a bar (D2)',
    insufficient: 'a figure whose own count is under the bar reads {status: "insufficient"}, never a number',
    rate: 'closes in the last 30 days (closed_at) / 30, per day',
    eta: 'the first day t (0 < t <= windowDays) at which the closes still inside the rolling window at t plus rate x t reach the bar; none: "unreachable at current rate"',
    steadyState: "rate x windowDays: what the rolling window holds once today's closes have aged out",
    pooled: "per strategy across every account; a copy = the same strategy, symbol and side opened on a DIFFERENT account within 15 minutes of the signal's first open; a signal counts once: R = mean net R of its scored copies, money = the sum of its copies",
    closedWindows: 'UTC calendar months; sealed append-only on the first report read after the month closes (the last 3); a later difference is appended as a restatement and the sealed row never changes',
  }))
  assert.equal(COPY_WINDOW_MS, 15 * 60_000)
})

test('pinned figures: 30 closes → PF-R 1.167 (r-net-v1) beside PF-USD 0.51 (usd-net-v0), Wilson 40 % [24.59, 57.68], reached', () => {
  const db = fresh()
  pinnedFixture(db)
  const rep = strategyQualificationReport(db, { now: NOW })
  assert.equal(rep.reportOnly, true)
  assert.deepEqual(rep.metrics.profitFactorR, 'r-net-v1')
  assert.deepEqual(rep.metrics.profitFactorUsd, 'usd-net-v0')
  assert.deepEqual(rep.bar, { closes: 30, windowDays: 90, source: 'evidence_gate_json via loadEvidenceGate (evidence-gate.js)' })
  const c = cellOf(rep, 'rsi2_reversion', A)
  assert.equal(c.closes, 30)
  assert.equal(c.status, 'measured')
  assert.equal(c.profitFactorR, 1.167, 'RED if PF-R is computed from money (it would read 0.513)')
  assert.equal(c.profitFactorUsd, 0.51)
  assert.deepEqual(c.winRate, { pct: 40, lo: 24.59, hi: 57.68, method: 'wilson-95' })
  assert.deepEqual(c.r, { scored: 30, unscorable: 0, unscorableBy: { noR: 0, scratchCost: 0, suspectExit: 0 }, wins: 12, losses: 18, netR: 3, lossless: false })
  assert.deepEqual(c.usd, { wins: 12, losses: 18, netUsd: -1460 })
  assert.equal(c.reachability.verdict, 'reached')
  assert.equal(c.reachability.etaDays, 0)
  assert.equal(c.reconciled, true)
  assert.equal(rep.reconciled, true)
  // Another account has none of A's closes: nothing listed for it (not pinned, no closes).
  assert.equal(cellOf(rep, 'rsi2_reversion', B), undefined)
})

test('the gate\'s own record carries both PFs, each labelled, and the gate still judges MONEY (nothing gates on R)', () => {
  const db = fresh()
  pinnedFixture(db)
  const rec = evidenceRecord(db, { strategy: 'rsi2_reversion', accountId: A })
  assert.equal(rec.closes, 30)
  assert.equal(rec.profitFactor, 0.51)
  assert.equal(rec.profitFactorR, 1.167)
  assert.equal(rec.rScored, 30); assert.equal(rec.rUnscorable, 0)
  assert.deepEqual(rec.metrics, { profitFactor: 'usd-net-v0', profitFactorR: 'r-net-v1' })
  // The gate reads the money PF: 0.51 < 1.5 → shadow, whatever R reads.
  const v = evidenceGate(db, { strategy: 'rsi2_reversion', accountId: A })
  assert.equal(v.allowed, false); assert.equal(v.via, 'shadow')
  assert.match(v.reason, /PF 0\.51 \(bar 1\.5\)/)
})

test('insufficient: under the bar every derived figure reads insufficient; counts stay; 29 → insufficient, 30 → measured', () => {
  const db = fresh()
  for (let i = 0; i < 29; i++) close(db, { strategy: 'vp_value', account: B, r: PATTERN[i % 10], net: PATTERN[i % 10] * 50, atMs: NOW - (i + 1) * DAY / 2 })
  let c = cellOf(strategyQualificationReport(db, { now: NOW }), 'vp_value', B)
  assert.equal(c.status, 'insufficient')
  assert.deepEqual(c.profitFactorR, { status: 'insufficient', trades: 29, needed: 30 })
  assert.deepEqual(c.profitFactorUsd, { status: 'insufficient', trades: 29, needed: 30 })
  assert.deepEqual(c.winRate, { status: 'insufficient', trades: 29, needed: 30 })
  assert.equal(c.r.wins, 12, 'counts are shown under the bar')
  close(db, { strategy: 'vp_value', account: B, r: -1, net: -50, atMs: NOW - DAY / 4 })
  c = cellOf(strategyQualificationReport(db, { now: NOW }), 'vp_value', B)
  assert.equal(c.status, 'measured')
  assert.equal(typeof c.profitFactorR, 'number')
})

test('insufficient per figure: 30 closes with 2 unscorable (no R) publish PF-USD but not PF-R or the win rate', () => {
  const db = fresh()
  for (let i = 0; i < 30; i++) close(db, { strategy: 'va_breakout', account: A, r: i < 2 ? null : PATTERN[i % 10], net: i < 2 ? 10 : PATTERN[i % 10] * 10, sl: i < 2 ? null : 1.09, atMs: NOW - (i + 1) * 3_600_000 })
  // realised_rr null and no stop on record → no R: counted noR, never scored.
  const c = cellOf(strategyQualificationReport(db, { now: NOW }), 'va_breakout', A)
  assert.equal(c.closes, 30)
  assert.equal(c.r.scored, 28)
  assert.deepEqual(c.r.unscorableBy, { noR: 2, scratchCost: 0, suspectExit: 0 })
  assert.deepEqual(c.profitFactorR, { status: 'insufficient', trades: 28, needed: 30 })
  assert.equal(typeof c.profitFactorUsd, 'number')
})

test('ETA ages today\'s closes out of the rolling window: 25 closes, 10 expiring at day 5, rate 0.5/day → 30 days (not the naive 10)', () => {
  const db = fresh()
  for (let i = 0; i < 10; i++) close(db, { strategy: 'vwap_trend', account: C, r: 1, net: 10, atMs: NOW - 85 * DAY })
  for (let i = 0; i < 15; i++) close(db, { strategy: 'vwap_trend', account: C, r: 1, net: 10, atMs: NOW - 5 * DAY })
  const c = cellOf(strategyQualificationReport(db, { now: NOW }), 'vwap_trend', C)
  assert.deepEqual(c.reachability, {
    closes: 25, needed: 5, closesLast30d: 15, ratePerDay: 0.5, steadyStateCloses: 45, sustainable: true, unstamped: 0,
    verdict: 'reachable', etaDays: 30, etaAt: new Date(NOW + 30 * DAY).toISOString(),
  })
})

test('unreachable at current rate: the window cannot hold 30 at 0.2/day; no recent close is unreachable; a bar already met is reached', () => {
  const db = fresh()
  for (let i = 0; i < 4; i++) close(db, { strategy: 'ema_pullback', account: B, r: -1, net: -10, atMs: NOW - 80 * DAY })
  for (let i = 0; i < 6; i++) close(db, { strategy: 'ema_pullback', account: B, r: 1, net: 10, atMs: NOW - 10 * DAY })
  const c = cellOf(strategyQualificationReport(db, { now: NOW }), 'ema_pullback', B)
  assert.equal(c.reachability.verdict, UNREACHABLE)
  assert.equal(c.reachability.etaDays, null)
  assert.equal(c.reachability.ratePerDay, 0.2)
  assert.equal(c.reachability.steadyStateCloses, 18)
  assert.equal(c.reachability.sustainable, false)
  // Pure function: rate 0 → unreachable; the ETA is capped at the window.
  assert.equal(reachability([NOW - 40 * DAY], { bar: 30, windowDays: 90, now: NOW }).verdict, UNREACHABLE)
  const at89 = Array.from({ length: 29 }, () => NOW - DAY)
  assert.equal(reachability(at89, { bar: 30, windowDays: 90, now: NOW }).etaDays, 1, 'rate 29/30 per day: one more close in 1.03 days, shown to 0.1')
  assert.equal(reachability(Array.from({ length: 30 }, () => NOW - DAY), { bar: 30, windowDays: 90, now: NOW }).verdict, 'reached')
})

test('a hand-pinned strategy with no closes is listed (0 closes, unreachable) — the verdict that never arrives is visible', () => {
  const db = fresh()
  setStage(db, { kind: 'strategy', key: 'fib_confluence', stage: 'trade', on: true, accountId: C }, { getState, setState })
  const rep = strategyQualificationReport(db, { now: NOW })
  const c = cellOf(rep, 'fib_confluence', C)
  assert.equal(c.pinned, true)
  assert.equal(c.closes, 0)
  assert.equal(c.reachability.verdict, UNREACHABLE)
  assert.equal(c.reconciled, true)
  assert.equal(cellOf(rep, 'fib_confluence', A), undefined, 'not pinned there, no closes: not listed')
  assert.ok(rep.summary.emptyCells > 0)
})

test('legacy unscoped rows count on every account (the gate\'s population) and are named; the reconciliation holds', () => {
  const db = fresh()
  close(db, { strategy: 'rsi_meanrev', account: null, r: 1, net: 10, atMs: NOW - DAY })
  close(db, { strategy: 'rsi_meanrev', account: A, r: -1, net: -10, atMs: NOW - DAY })
  const rep = strategyQualificationReport(db, { now: NOW })
  assert.equal(cellOf(rep, 'rsi_meanrev', A).closes, 2)
  assert.equal(cellOf(rep, 'rsi_meanrev', A).legacyUnscoped, 1)
  assert.equal(cellOf(rep, 'rsi_meanrev', B).closes, 1)
  for (const a of [A, B, C]) assert.equal(cellOf(rep, 'rsi_meanrev', a).closes, evidenceRecord(db, { strategy: 'rsi_meanrev', accountId: a, now: NOW }).closes)
  assert.equal(rep.reconciled, true)
  // Probes and non-bot origins are outside the gate's population, and so outside this report.
  close(db, { strategy: 'rsi_meanrev', account: A, r: 5, net: 50, atMs: NOW - DAY, origin: 'reconciler_adopted' })
  assert.equal(cellOf(strategyQualificationReport(db, { now: NOW }), 'rsi_meanrev', A).closes, 2)
})

test('pooled: copies of one signal across accounts count once; the same account twice is two signals; mixed currencies publish no PF-USD', () => {
  const db = fresh()
  const t = NOW - 2 * DAY
  // Signal 1: A, B at +0/+2 min and C at +5 min — one signal. R 2 on each copy.
  close(db, { strategy: 'donchian_breakout', account: A, r: 2, net: 200, openMs: t, atMs: t + DAY / 4 })
  close(db, { strategy: 'donchian_breakout', account: B, r: 2, net: 100, openMs: t + 2 * 60_000, atMs: t + DAY / 4 })
  close(db, { strategy: 'donchian_breakout', account: C, r: 2, net: 30, openMs: t + 5 * 60_000, atMs: t + DAY / 4 })
  // Signal 2 and 3: A twice within 3 minutes — the same account cannot be its own copy.
  close(db, { strategy: 'donchian_breakout', account: A, r: -1, net: -100, openMs: t + 3 * 3_600_000, atMs: t + DAY / 2 })
  close(db, { strategy: 'donchian_breakout', account: A, r: -1, net: -100, openMs: t + 3 * 3_600_000 + 3 * 60_000, atMs: t + DAY / 2 })
  // Signal 4: B 16 minutes after signal 1's first open — outside the copy window, its own signal; opposite side too.
  close(db, { strategy: 'donchian_breakout', account: B, r: 1, net: 50, openMs: t + 16 * 60_000, atMs: t + DAY / 4, side: 'SELL' })
  const rep = strategyQualificationReport(db, { now: NOW })
  const p = rep.pooled.find(x => x.strategy === 'donchian_breakout')
  assert.equal(p.copies, 6)
  assert.equal(p.signals, 4, 'RED if copies are counted as independent closes (6)')
  assert.equal(p.collapsed, 2)
  assert.equal(p.closes, 4)
  assert.equal(p.accounts, 3)
  assert.deepEqual(p.r, { scored: 4, unscorable: 0, unscorableBy: { noR: 0, scratchCost: 0, suspectExit: 0 }, wins: 2, losses: 2, netR: 1, lossless: false })
  assert.deepEqual(p.currencies, ['SGD', 'USD'])
  assert.deepEqual(p.profitFactorUsd, { status: 'mixed_currency', currencies: ['SGD', 'USD'] })
  assert.equal(p.reachability.closes, 4)
  // Per account nothing is collapsed: A has its three closes.
  assert.equal(cellOf(rep, 'donchian_breakout', A).closes, 3)
  // The pure clusterer: a row with no open stamp stands alone.
  const { signals, unmatched } = clusterCopies([{ id: 1, account_id: A, symbol: 'X', side: 'BUY', openedMs: null }, { id: 2, account_id: B, symbol: 'X', side: 'BUY', openedMs: null }])
  assert.equal(signals.length, 2); assert.equal(unmatched, 2)
})

test('pooled in one currency publishes PF-USD; a signal\'s R is the mean of its scored copies', () => {
  const db = fresh()
  for (let i = 0; i < 30; i++) {
    const t = NOW - (i + 1) * 3 * 3_600_000
    const r = PATTERN[i % 10]
    close(db, { strategy: 'fvg_retrace', account: A, r, net: r * 100, openMs: t, atMs: t + 3_600_000 })
    close(db, { strategy: 'fvg_retrace', account: B, r: r * 1.5, net: r * 10, openMs: t + 60_000, atMs: t + 3_600_000 })
  }
  const p = strategyQualificationReport(db, { now: NOW }).pooled.find(x => x.strategy === 'fvg_retrace')
  assert.equal(p.signals, 30); assert.equal(p.copies, 60)
  assert.deepEqual(p.currencies, ['USD'])
  // mean R per signal = 1.25 r → PF-R = (1.25·21)/(1.25·18); money summed = 110 r → PF-USD 2310/1980. Both 21/18.
  assert.equal(p.profitFactorR, 1.167)
  assert.equal(p.profitFactorUsd, 1.17)
  assert.equal(p.r.netR, 3.75)
})

test('closed windows are UTC calendar months fixed by the calendar: the last three before now\'s month', () => {
  assert.deepEqual(monthWindows(NOW).map(w => w.key), ['2026-06', '2026-07', '2026-08'])
  assert.deepEqual(monthWindows(Date.parse('2026-01-15T12:00:00Z')).map(w => w.key), ['2025-10', '2025-11', '2025-12'])
  const aug = monthWindows(NOW)[2]
  assert.equal(aug.fromMs, Date.parse('2026-08-01T00:00:00Z'))
  assert.equal(aug.toMs, Date.parse('2026-09-01T00:00:00Z'))
  assert.equal(stampMs('2026-08-31 23:59:59'), Date.parse('2026-08-31T23:59:59Z'))
  assert.equal(stampMs('2026-08-31T23:59:59+08:00'), Date.parse('2026-08-31T15:59:59Z'))
})

test('D3: a trade rewritten AFTER its month closed leaves the sealed figure unchanged and appends a restatement beside it', () => {
  const db = fresh()
  const aug = Date.parse('2026-08-10T00:00:00Z')
  const ids = []
  for (let i = 0; i < 5; i++) ids.push(close(db, { strategy: 'rsi2_reversion', account: A, r: PATTERN[i], net: PATTERN[i] * 100, atMs: aug + i * DAY }))
  const first = strategyQualificationReport(db, { now: NOW })
  const augFirst = first.closedWindows.find(w => w.window === '2026-08')
  assert.equal(augFirst.sealed, true)
  assert.equal(augFirst.closes, 5)
  const sealedCell = augFirst.cells.find(c => c.strategy === 'rsi2_reversion' && c.accountId === A)
  assert.equal(sealedCell.sealed.r.netR, 0.5)
  assert.equal(sealedCell.restatements, 0)

  // Broker reconciliation rewrites one closed row after the month closed (failure mode #6).
  db.prepare('UPDATE trades SET net_pnl = -500, gross_pnl = -500, realised_rr = -5 WHERE id = ?').run(ids[0])
  const second = strategyQualificationReport(db, { now: NOW + 3_600_000 })
  const augSecond = second.closedWindows.find(w => w.window === '2026-08')
  const cell2 = augSecond.cells.find(c => c.strategy === 'rsi2_reversion' && c.accountId === A)
  assert.deepEqual(cell2.sealed, sealedCell.sealed, 'RED if a closed window is recomputed on re-read: the sealed figure must not move')
  assert.equal(augSecond.sealedAt, augFirst.sealedAt)
  assert.equal(cell2.restatements, 1, 'RED if the difference is not recorded as a restatement')
  assert.equal(cell2.current.r.netR, -6.5, 'the restatement carries the rewritten figure')
  assert.equal(second.sealing.restated >= 1, true)
  // The rolling view (which covers August) moves; the sealed month does not.
  assert.equal(cellOf(second, 'rsi2_reversion', A).r.netR, -6.5)

  // Re-read with nothing changed: no second restatement.
  const third = strategyQualificationReport(db, { now: NOW + 2 * 3_600_000 })
  assert.equal(third.sealing.restated, 0)
  assert.equal(third.closedWindows.find(w => w.window === '2026-08').cells.find(c => c.accountId === A && c.strategy === 'rsi2_reversion').restatements, 1)

  // A close that lands in August late (a new key after the seal) is a restatement from nothing.
  close(db, { strategy: 'vp_value', account: B, r: 1, net: 10, atMs: aug + 3 * DAY })
  const fourth = strategyQualificationReport(db, { now: NOW + 3 * 3_600_000 })
  const late = fourth.closedWindows.find(w => w.window === '2026-08').cells.find(c => c.strategy === 'vp_value' && c.accountId === B)
  assert.equal(late.sealed, null)
  assert.equal(late.restatements, 1)
  assert.equal(late.current.closes, 1)
})

test('D3: the sealed record is append-only — UPDATE and DELETE are refused by the table itself', () => {
  const db = fresh()
  close(db, { strategy: 'rsi2_reversion', account: A, r: 1, net: 10, atMs: Date.parse('2026-08-10T00:00:00Z') })
  sealClosedWindows(db, { now: NOW })
  const n = db.prepare('SELECT COUNT(*) AS n FROM qualification_windows').get().n
  assert.ok(n >= 3, `sealed rows written (${n})`)
  assert.throws(() => db.prepare("UPDATE qualification_windows SET figures_json = '{}'").run(), /append-only/)
  assert.throws(() => db.prepare('DELETE FROM qualification_windows').run(), /append-only/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM qualification_windows').get().n, n)
  // A second seal pass writes nothing new; an owner change to the bar changes no stored row.
  assert.deepEqual(sealClosedWindows(db, { now: NOW + DAY }), { sealed: 0, restated: 0, errors: [] })
  setState(db, EVIDENCE_GATE_KEY, JSON.stringify({ minCloses: 1 }))
  const rep = strategyQualificationReport(db, { now: NOW + DAY })
  assert.equal(rep.sealing.restated, 0)
  const cell = rep.closedWindows.find(w => w.window === '2026-08').cells[0]
  assert.equal(cell.sealed.status, 'measured', 'the bar is applied on display, from the stored raw figures')
})

test('GET /state/strategy-qualification: report only, reconciled, and the read seals the closed months (wiring pinned by behaviour)', async () => {
  const db = fresh()
  const now = Date.now()
  close(db, { strategy: 'rsi2_reversion', account: A, r: 1, net: 10, atMs: now - 40 * DAY })
  close(db, { strategy: 'rsi2_reversion', account: A, r: -1, net: -10, atMs: now - DAY })
  const { default: stateRouter } = await import('../routes/state.js')
  const app = express()
  app.use('/state', stateRouter(db))
  const s = await new Promise(resolve => { const srv = app.listen(0, () => resolve(srv)) })
  try {
    const rep = await fetch(`http://127.0.0.1:${s.address().port}/state/strategy-qualification`).then(x => x.json())
    assert.equal(rep.reportOnly, true)
    assert.equal(rep.definition.id, 'bar-qualification-v1')
    assert.equal(rep.reconciled, true)
    assert.equal(cellOf(rep, 'rsi2_reversion', A).closes, 2)
    assert.equal(rep.closedWindows.length, 3)
    const sealedRows = db.prepare("SELECT COUNT(*) AS n FROM qualification_windows WHERE kind = 'sealed' AND scope = 'window'").get().n
    assert.equal(sealedRows, 3, 'RED if the route stops sealing: a record nothing writes is not a record')
  } finally { s.close() }
})
