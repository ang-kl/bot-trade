import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import {
  goalTracker, loadGoal, daysRemaining, winsNeeded, winnersNeededForPf,
  impliedWinRateForPf, DEFAULT_GOAL, GOAL_STATE_KEY, auditGoalChange,
} from './goal-tracker.js'

const NOW = Date.parse('2026-08-02T12:00:00Z')
const DAY = 86_400_000

function freshDb() {
  return initDB(':memory:')
}

/** Insert `n` closed trades for an account, `wins` of them profitable. */
function seedTrades(db, { accountId, wins, losses, winAmt = 100, lossAmt = -50, startMs = NOW - 10 * DAY, spacingMs = DAY / 4 }) {
  const ins = db.prepare(
    `INSERT INTO trades (symbol, side, status, net_pnl, closed_at_ms, opened_at, account_id)
     VALUES ('EURUSD', 'buy', 'closed', ?, ?, ?, ?)`
  )
  let t = startMs
  for (let i = 0; i < wins; i++) {
    ins.run(winAmt, t, new Date(t).toISOString(), accountId)
    t += spacingMs
  }
  for (let i = 0; i < losses; i++) {
    ins.run(lossAmt, t, new Date(t).toISOString(), accountId)
    t += spacingMs
  }
}

function seedAccount(db, id, { isLive = 0, enabled = 1, label = null } = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO accounts (account_id, is_live, enabled, broker_label, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(String(id), isLive, enabled, label, new Date(NOW).toISOString())
}

// ---------------------------------------------------------------------------
// The arithmetic, in isolation
// ---------------------------------------------------------------------------

test('winsNeeded inverts the aggregate hit rate', () => {
  // 100 trades, 60 wins, 20 more coming, target 68%:
  // need ceil(0.68 * 120 - 60) = ceil(21.6) = 22 wins out of 20 -> impossible.
  assert.equal(winsNeeded({ wins: 60, trades: 100, remaining: 20, targetPct: 68 }), 22)
  // Same record with 100 more trades: ceil(0.68*200 - 60) = 76 of 100 -> hard
  // but reachable.
  assert.equal(winsNeeded({ wins: 60, trades: 100, remaining: 100, targetPct: 68 }), 76)
})

test('winsNeeded is <= 0 once the target is already locked', () => {
  // 90 wins of 100 with 10 to come: 0.68*110 = 74.8, already have 90.
  assert.ok(winsNeeded({ wins: 90, trades: 100, remaining: 10, targetPct: 68 }) <= 0)
})

test('winsNeeded does not round a whole number up by one', () => {
  // 0.5 * (50 + 50) = 50 exactly, with 25 wins in hand -> 25 more, not 26.
  assert.equal(winsNeeded({ wins: 25, trades: 50, remaining: 50, targetPct: 50 }), 25)
})

test('winnersNeededForPf solves the ratio at the observed trade sizes', () => {
  // GW 1000 (10x100), GL 1000 (20x50), 20 more trades, target 1.68.
  // k >= (1.68*(1000+20*50) - 1000) / (100 + 1.68*50) = 2360/184 = 12.83 -> 13
  const k = winnersNeededForPf({
    grossWin: 1000, grossLoss: 1000, avgWin: 100, avgLoss: 50, remaining: 20, target: 1.68,
  })
  assert.equal(k, 13)
  // Verify by substitution: 13 wins / 7 losses gets there, 12 does not.
  const pf = (n) => (1000 + n * 100) / (1000 + (20 - n) * 50)
  assert.ok(pf(13) >= 1.68)
  assert.ok(pf(12) < 1.68)
})

test('winnersNeededForPf is null without an observed average win or loss', () => {
  assert.equal(winnersNeededForPf({ grossWin: 0, grossLoss: 100, avgWin: null, avgLoss: 50, remaining: 10, target: 1.68 }), null)
  assert.equal(winnersNeededForPf({ grossWin: 100, grossLoss: 0, avgWin: 100, avgLoss: null, remaining: 10, target: 1.68 }), null)
})

test('daysRemaining counts to the end of the deadline day and floors at zero', () => {
  assert.equal(daysRemaining('2026-08-12', Date.parse('2026-08-02T12:00:00Z')), 11)
  assert.equal(daysRemaining('2026-08-02', Date.parse('2026-08-02T00:00:00Z')), 1)
  assert.equal(daysRemaining('2026-07-01', Date.parse('2026-08-02T00:00:00Z')), 0)
})

// ---------------------------------------------------------------------------
// Goal config
// ---------------------------------------------------------------------------

test('the goal defaults to the owner stated gate', () => {
  const db = freshDb()
  assert.deepEqual(loadGoal(db), DEFAULT_GOAL)
})

test('goal overrides merge over defaults and reject nonsense', () => {
  const db = freshDb()
  setState(db, GOAL_STATE_KEY, JSON.stringify({ winRatePct: 70, deadline: 'soon', profitFactor: -3 }))
  const g = loadGoal(db)
  assert.equal(g.winRatePct, 70)
  assert.equal(g.deadline, DEFAULT_GOAL.deadline, 'a malformed date falls back rather than crashing the panel')
  assert.equal(g.profitFactor, DEFAULT_GOAL.profitFactor, 'a negative target is not a target')
})

test('unparseable goal state does not throw', () => {
  const db = freshDb()
  setState(db, GOAL_STATE_KEY, '{not json')
  assert.deepEqual(loadGoal(db), DEFAULT_GOAL)
})

// ---------------------------------------------------------------------------
// The tracker end to end
// ---------------------------------------------------------------------------

test('an account with no closed trades reports no_data, not a zero win rate', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  const out = goalTracker(db, { now: NOW })
  const row = out.accounts.find(a => a.accountId === '5203012')
  assert.equal(row.trades, 0)
  assert.equal(row.verdict, 'no_data')
  assert.equal(row.winRate.value, null)
  assert.equal(row.profitFactor.value, null)
})

test('a tiny perfect record is insufficient_sample, never met', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  seedTrades(db, { accountId: '5203012', wins: 3, losses: 0 })
  const row = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '5203012')
  assert.equal(row.winRate.value, 100)
  assert.equal(row.sampleOk, false)
  assert.equal(row.verdict, 'insufficient_sample',
    'a 3-trade 100% record must not show green on a gate that decides real money')
})

test('a large record clearing both targets reads met', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  // 40 trades, 30 wins (75%), PF = 3000/500 = 6.0
  seedTrades(db, { accountId: '5203012', wins: 30, losses: 10 })
  const row = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '5203012')
  assert.equal(row.trades, 40)
  assert.equal(row.winRate.value, 75)
  assert.equal(row.profitFactor.value, 6)
  assert.equal(row.verdict, 'met')
})

test('a large record below target with too few trades left is out_of_reach', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  // 100 trades, 40 wins (40%), closed over ~2 days -> a high trade rate, but
  // still nowhere near 68% aggregate with 11 days left.
  seedTrades(db, { accountId: '5203012', wins: 40, losses: 60, startMs: NOW - 2 * DAY, spacingMs: DAY / 60 })
  const row = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '5203012')
  assert.equal(row.winRate.value, 40)
  const need = row.winRate.winsNeeded
  assert.ok(need > 0)
  if (need > row.expectedRemaining) {
    assert.equal(row.winRate.verdict, 'out_of_reach')
  } else {
    assert.equal(row.winRate.verdict, 'at_risk',
      'reachable only by beating the observed hit rate')
  }
})

test('out_of_reach is arithmetic: needing more wins than trades remaining', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  // 50 trades, 10 wins, spread one per day over 50 days -> ~1 trade/day, so
  // only ~11 more close before the deadline. Lifting 20% to 68% would take
  // 32 wins out of those 11.
  seedTrades(db, { accountId: '5203012', wins: 10, losses: 40, startMs: NOW - 50 * DAY, spacingMs: DAY })
  const row = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '5203012')
  assert.ok(row.expectedRemaining < row.winRate.winsNeeded,
    'the requirement exceeds the trades expected before the deadline')
  assert.equal(row.winRate.verdict, 'out_of_reach')
  assert.equal(row.verdict, 'out_of_reach', 'the weaker of the two gates governs')
})

test('at_risk means reachable only by improving on the observed hit rate', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  // 40 trades at 60%, plenty of trades still expected (high rate over 1 day
  // span means a large expectedRemaining) -> the requirement lands above 60%.
  seedTrades(db, { accountId: '5203012', wins: 24, losses: 16, startMs: NOW - DAY, spacingMs: DAY / 60 })
  const row = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '5203012')
  assert.equal(row.winRate.value, 60)
  assert.ok(row.expectedRemaining > row.winRate.winsNeeded, 'reachable')
  assert.ok(row.winRate.requiredRateOnRemaining > row.winRate.value,
    'it demands better than the account has managed')
  assert.equal(row.winRate.verdict, 'at_risk')
})

test('there is no on_track verdict: below target at steady form never arrives', () => {
  // The load-bearing claim in the verdict set. Both metrics are computed from
  // the account's own performance, so an account that keeps performing exactly
  // as it has been converges on the number it already has. Below target must
  // therefore read at_risk — it is only reachable by IMPROVING — and the
  // required lift is visible as requiredRateOnRemaining above value.
  const db = freshDb()
  seedAccount(db, '5203012')
  seedTrades(db, { accountId: '5203012', wins: 27, losses: 13, startMs: NOW - DAY, spacingMs: DAY / 200 })
  const row = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '5203012')
  assert.equal(row.winRate.value, 67.5, 'just under the 68 gate')
  assert.ok(row.expectedRemaining > row.winRate.winsNeeded, 'arithmetically reachable')
  assert.ok(row.winRate.requiredRateOnRemaining > row.winRate.value,
    'reaching the gate demands better than the account has managed')
  assert.equal(row.winRate.verdict, 'at_risk')
  const out = goalTracker(db, { now: NOW })
  const verdicts = new Set(out.accounts.map(a => a.verdict).concat(out.portfolio.verdict))
  assert.ok(!verdicts.has('on_track'), 'the verdict set has no unreachable state')
})

test('the profit-factor requirement names the assumption it rests on', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  seedTrades(db, { accountId: '5203012', wins: 20, losses: 20 })
  const row = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '5203012')
  assert.match(row.profitFactor.assumes, /average/)
  assert.match(row.profitFactor.assumes, /100\.00/)
  assert.match(row.profitFactor.assumes, /50\.00/)
})

test('a record with no losses does not fail the profit-factor gate', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  seedTrades(db, { accountId: '5203012', wins: 35, losses: 0 })
  const row = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '5203012')
  assert.equal(row.profitFactor.value, null, 'PF is undefined without a denominator, not Infinity')
  assert.equal(row.profitFactor.verdict, 'met')
})

test('the portfolio row is rebuilt from every trade, not averaged from accounts', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedAccount(db, 'B')
  // A: 8 wins / 2 losses = 80%.  B: 10 wins / 30 losses = 25%.
  // Averaging the RATES gives 52.5%; the true pooled rate is 18/50 = 36%.
  seedTrades(db, { accountId: 'A', wins: 8, losses: 2 })
  seedTrades(db, { accountId: 'B', wins: 10, losses: 30 })
  const out = goalTracker(db, { now: NOW })
  assert.equal(out.portfolio.trades, 50)
  assert.equal(out.portfolio.winRate.value, 36)
  const mean = (out.accounts.find(a => a.accountId === 'A').winRate.value
    + out.accounts.find(a => a.accountId === 'B').winRate.value) / 2
  assert.notEqual(out.portfolio.winRate.value, mean)
})

test('per-account scoping does not leak another account trades', () => {
  const db = freshDb()
  seedAccount(db, 'A')
  seedAccount(db, 'B')
  seedTrades(db, { accountId: 'A', wins: 30, losses: 5 })
  seedTrades(db, { accountId: 'B', wins: 1, losses: 40 })
  const out = goalTracker(db, { now: NOW })
  assert.equal(out.accounts.find(a => a.accountId === 'A').trades, 35)
  assert.equal(out.accounts.find(a => a.accountId === 'B').trades, 41)
})

test('the trade rate is measured over the account own span, never divided by zero', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  // Everything closed inside one hour.
  seedTrades(db, { accountId: '5203012', wins: 5, losses: 5, startMs: NOW - 3_600_000, spacingMs: 60_000 })
  const row = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '5203012')
  assert.equal(row.spanDays, 1)
  assert.equal(row.tradesPerDay, 10)
  assert.ok(Number.isFinite(row.expectedRemaining))
})

test('a past deadline leaves zero days and makes any shortfall out_of_reach', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  setState(db, GOAL_STATE_KEY, JSON.stringify({ deadline: '2026-07-01' }))
  seedTrades(db, { accountId: '5203012', wins: 20, losses: 20 })
  const out = goalTracker(db, { now: NOW })
  assert.equal(out.daysRemaining, 0)
  const row = out.accounts.find(a => a.accountId === '5203012')
  assert.equal(row.expectedRemaining, 0)
  assert.equal(row.winRate.verdict, 'out_of_reach')
})

test('the window option restricts the record without changing the gate', () => {
  const db = freshDb()
  seedAccount(db, '5203012')
  // Old losing run, recent winning run.
  seedTrades(db, { accountId: '5203012', wins: 0, losses: 40, startMs: NOW - 60 * DAY, spacingMs: DAY / 4 })
  seedTrades(db, { accountId: '5203012', wins: 35, losses: 5, startMs: NOW - 5 * DAY, spacingMs: DAY / 12 })
  const allTime = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '5203012')
  const recent = goalTracker(db, { now: NOW, days: 7 }).accounts.find(a => a.accountId === '5203012')
  assert.equal(allTime.trades, 80)
  assert.equal(recent.trades, 40)
  assert.ok(recent.winRate.value > allTime.winRate.value)
  assert.equal(recent.winRate.target, 68, 'the window changes the record, not the gate')
})

test('registry metadata rides along so the panel can flag the live account', () => {
  const db = freshDb()
  seedAccount(db, '1251247', { isLive: 1, enabled: 0, label: 'Live' })
  const row = goalTracker(db, { now: NOW }).accounts.find(a => a.accountId === '1251247')
  assert.equal(row.isLive, true)
  assert.equal(row.enabled, false)
  assert.equal(row.label, 'Live')
})

// ---------------------------------------------------------------------------
// 2026-08-03 — the two goals were not a pair, and requiring both silently
// enforced the far stricter one.
//
// PF = W/(1−W) × (avgWin/avgLoss). At the observed payoff of 1.86 (avg win
// $224.77, avg loss $121.07), a 68% win rate implies PF ≈ 3.95 — more than
// double the 1.68 target. So "68% AND 1.68" was really "68%", and 68% needed
// 144 winners from ~98 remaining trades: arithmetically impossible.
//
// PF 1.68 at that same payoff needs ~47.5% wins. That is the actionable
// number, and the gate now follows profit factor.
// ---------------------------------------------------------------------------

test('the win rate a PF target implies at the observed payoff', () => {
  // The owner's real numbers, 245 closed trades.
  const r = impliedWinRateForPf({ avgWin: 224.77, avgLoss: 121.07, target: 1.68 })
  assert.ok(Math.abs(r - 47.5) < 0.2, `expected ~47.5%, got ${r}`)

  // Sanity: feeding that win rate back through PF = W/(1−W) × payoff returns
  // the target, so the two formulas cannot drift apart unnoticed.
  const W = r / 100
  const pf = (W / (1 - W)) * (224.77 / 121.07)
  assert.ok(Math.abs(pf - 1.68) < 0.01, `round-trip gave PF ${pf}`)
})

test('a symmetric payoff needs a symmetric win rate', () => {
  // payoff 1.0 → PF target 1.68 needs 62.7% wins. Worth pinning: it shows the
  // implied rate moves with the payoff, which is the whole point.
  const r = impliedWinRateForPf({ avgWin: 100, avgLoss: 100, target: 1.68 })
  assert.ok(Math.abs(r - 62.69) < 0.1, `expected ~62.7%, got ${r}`)
})

test('an unobservable payoff yields null rather than a guess', () => {
  assert.equal(impliedWinRateForPf({ avgWin: 0, avgLoss: 100, target: 1.68 }), null)
  assert.equal(impliedWinRateForPf({ avgWin: 100, avgLoss: 0, target: 1.68 }), null)
  assert.equal(impliedWinRateForPf({ avgWin: null, avgLoss: null, target: 1.68 }), null)
})

test('the gate follows profit factor, not the AND of both', () => {
  // A row that MEETS profit factor but misses win rate must now read as met:
  // under the old AND it read out_of_reach, which is what put "Out of reach"
  // on a card whose PF gate was the one the owner cared about.
  const g = loadGoal({ getState: () => null })
  assert.equal(g.gateOn, 'profitFactor')
})

// ---------------------------------------------------------------------------
// Risk-Decision Audit, 2026-08-03, finding #2: the go-live gate could be
// loosened with no record of it. These cover the change detector.
// ---------------------------------------------------------------------------
test('the FIRST sighting of a goal is a baseline, not a logged change', () => {
  const db = initDB(':memory:')
  const r = auditGoalChange(db, loadGoal(db))
  assert.equal(r.changed, false, 'a fresh DB has not had its gate edited')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM action_log WHERE path LIKE '/goal/%'").get().n, 0)
})

test('loosening the gate is written to action_log, however it was written', () => {
  const db = initDB(':memory:')
  auditGoalChange(db, loadGoal(db))                     // baseline

  // Set DIRECTLY in agent_state — the path that has no setter, which is the
  // whole reason this is a detector rather than a logging saveGoal().
  setState(db, GOAL_STATE_KEY, JSON.stringify({ profitFactor: 1.2 }))
  const r = auditGoalChange(db, loadGoal(db))

  assert.equal(r.changed, true)
  assert.equal(r.from.profitFactor, 1.68)
  assert.equal(r.to.profitFactor, 1.2)
  const row = db.prepare("SELECT body FROM action_log WHERE path LIKE '/goal/%'").get()
  const logged = JSON.parse(row.body)
  assert.equal(logged.from.profitFactor, 1.68)
  assert.equal(logged.to.profitFactor, 1.2)
})

test('re-reading an UNCHANGED goal logs nothing', () => {
  const db = initDB(':memory:')
  auditGoalChange(db, loadGoal(db))
  for (let i = 0; i < 5; i++) auditGoalChange(db, loadGoal(db))
  // goalTracker calls this on every request; a row per read would drown the log.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM action_log WHERE path LIKE '/goal/%'").get().n, 0)
})

// S4b — THE PANEL THIS WORKSTREAM STARTED FROM. On 2026-08-03 the Go-Live card
// showed six panels under six per-account headings, every one drawing the same
// 245 POOLED trades, including the row labelled LIVE. Nothing on the screen
// contradicted it, because a wrong number and a right number look identical.
//
// The card now carries its OWN coverage so its dot can print the figure that
// was missing: how many of these rows are actually this account's.
test('each card reports what fraction of its rows belong to that account', () => {
  const db = initDB(':memory:')
  const ins = db.prepare(`
    INSERT INTO trades (account_id, symbol, side, status, net_pnl, closed_at, opened_at)
    VALUES (?, 'EURUSD', 'BUY', 'closed', ?, datetime('now'), datetime('now'))
  `)
  ins.run('AAA', 10)      // AAA's own
  ins.run('AAA', -5)      // AAA's own
  ins.run(null, 20)       // unstamped — counted for EVERY account, owned by none
  ins.run('BBB', 30)      // somebody else's

  const out = goalTracker(db, { accountIds: ['AAA'] })
  const card = out.accounts[0]

  // The OR-NULL read gives AAA three rows: its two plus the unstamped one.
  // BBB's row is not in the denominator — it was never AAA's to count.
  assert.equal(card.coverage.total, 3)
  assert.equal(card.coverage.attributable, 2)
  assert.equal(card.attributablePct, 66.7,
    'the card must be able to SAY "66.7% of 3 rows" rather than showing a clean number')

  // The roll-up spans every account by design, so coverage is not measured
  // against one — reporting a gap there would cry wolf on a portfolio view.
  assert.equal(out.portfolio.coverage, null)
  assert.equal(out.portfolio.attributablePct, null)
})

test('a fully-stamped account reads 100, and an empty one is not a failure', () => {
  const db = initDB(':memory:')
  db.prepare(`
    INSERT INTO trades (account_id, symbol, side, status, net_pnl, closed_at, opened_at)
    VALUES ('AAA', 'EURUSD', 'BUY', 'closed', 10, datetime('now'), datetime('now'))
  `).run()

  const clean = goalTracker(db, { accountIds: ['AAA'] }).accounts[0]
  assert.equal(clean.attributablePct, 100)

  // No trades yet is a FACT, not a gap. Painting a new account amber would
  // teach the operator to ignore amber, which costs the real ones.
  const empty = goalTracker(db, { accountIds: ['ZZZ'] }).accounts[0]
  assert.equal(empty.coverage.total, 0)
  assert.equal(empty.attributablePct, 100)
})
