// node --test agent/lib/cooldown-counterfactual.test.js
//
// THE INCIDENT THIS PINS (broker statement, 03-08-2026):
//   JPN225 Sell close 20:15:36 → next open 20:53:44   gap 38.1 min
//   JPN225 Sell close 20:54:45 → next open 21:31:22   gap 36.6 min
// −$10,487.68 across the two, both inside the shipped 240-minute default and
// both waved through by a 5-minute configured window that left no trace.
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { cooldownCounterfactual, formatUsd, DEFAULT_SYMBOL_COOLDOWN_MIN } from './cooldown-counterfactual.js'

const T0 = Date.parse('2026-08-03T20:15:36Z')
const at = (minutesLater) => T0 + minutesLater * 60_000

test('the JPN225 re-entry the 5-minute window allowed and the default would not', () => {
  const cf = cooldownCounterfactual({
    lastCloseAt: '2026-08-03T20:15:36Z',
    lastNetPnl: -1315.92,
    configuredMin: 5,
    nowMs: at(38),
  })
  assert.equal(cf.minutesSince, 38)
  assert.equal(cf.wouldBlockAtDefault, true)
  assert.match(cf.note, /configured 5m/)
  // The default became 60 on 2026-08-06 (owner). 60 still refuses this
  // re-entry — that is exactly why 60 was the number chosen — so the incident
  // stays pinned; only the figure quoted in the sentence moves.
  assert.match(cf.note, /default of 60m would have REFUSED/)
  assert.match(cf.note, /loss of \$1,315\.92, 38m ago/)
})

test('a re-entry after a WIN says nothing — that is not the hazard', () => {
  const cf = cooldownCounterfactual({
    lastCloseAt: '2026-08-03T20:15:36Z', lastNetPnl: 412.5, configuredMin: 5, nowMs: at(38),
  })
  assert.equal(cf.wouldBlockAtDefault, true, 'the default WOULD still have blocked it')
  assert.equal(cf.note, null, 'but re-entering after a win is ordinary trend behaviour')
})

test('a scratch close is not a loss', () => {
  const cf = cooldownCounterfactual({
    lastCloseAt: '2026-08-03T20:15:36Z', lastNetPnl: 0, configuredMin: 5, nowMs: at(38),
  })
  assert.equal(cf.note, null)
})

test('missing P&L is not silently read as a loss', () => {
  const cf = cooldownCounterfactual({
    lastCloseAt: '2026-08-03T20:15:36Z', lastNetPnl: null, configuredMin: 5, nowMs: at(38),
  })
  assert.equal(cf.lastNetPnl, null)
  assert.equal(cf.note, null, 'a row with no realised P&L is unknown, not bad')
})

test('a window already at the default has no counterfactual to offer', () => {
  const cf = cooldownCounterfactual({
    lastCloseAt: '2026-08-03T20:15:36Z', lastNetPnl: -1315.92, configuredMin: 240, nowMs: at(38),
  })
  assert.equal(cf.wouldBlockAtDefault, false)
  assert.equal(cf.note, null)
})

test('a longer-than-default window is not scolded by the default', () => {
  const cf = cooldownCounterfactual({
    lastCloseAt: '2026-08-03T20:15:36Z', lastNetPnl: -1315.92, configuredMin: 480, nowMs: at(38),
  })
  assert.equal(cf.wouldBlockAtDefault, false)
  assert.equal(cf.note, null)
})

test('past the default window, both agree and nothing is said', () => {
  const cf = cooldownCounterfactual({
    lastCloseAt: '2026-08-03T20:15:36Z', lastNetPnl: -1315.92, configuredMin: 5, nowMs: at(241),
  })
  assert.equal(cf.minutesSince, 241)
  assert.equal(cf.wouldBlockAtDefault, false)
  assert.equal(cf.note, null)
})

test('exactly at the default boundary the default would NOT have blocked', () => {
  const cf = cooldownCounterfactual({
    lastCloseAt: '2026-08-03T20:15:36Z', lastNetPnl: -100, configuredMin: 5, nowMs: at(60),
  })
  assert.equal(cf.wouldBlockAtDefault, false, '60m elapsed on a 60m window is unlocked')
  assert.equal(DEFAULT_SYMBOL_COOLDOWN_MIN, 60, 'and the default really is 60')
})

test('no close history yields a shaped result, not a throw', () => {
  const cf = cooldownCounterfactual({ configuredMin: 5 })
  assert.equal(cf.minutesSince, null)
  assert.equal(cf.wouldBlockAtDefault, false)
  assert.equal(cf.note, null)
  assert.equal(cf.configuredMin, 5)
  assert.equal(cf.defaultMin, DEFAULT_SYMBOL_COOLDOWN_MIN)
})

test('an unparseable timestamp is treated as no history', () => {
  const cf = cooldownCounterfactual({ lastCloseAt: 'not-a-date', lastNetPnl: -500, configuredMin: 5 })
  assert.equal(cf.minutesSince, null)
  assert.equal(cf.note, null)
})

test('minutes round DOWN so an observation cannot overshoot its own window', () => {
  const cf = cooldownCounterfactual({
    lastCloseAt: '2026-08-03T20:15:36Z', lastNetPnl: -10, configuredMin: 5, nowMs: at(37.9),
  })
  assert.equal(cf.minutesSince, 37)
})

test('formatUsd carries magnitude, not sign', () => {
  assert.equal(formatUsd(-1315.92), '$1,315.92')
  assert.equal(formatUsd(-9171.76), '$9,171.76')
  assert.equal(formatUsd(0), '$0.00')
})

// ---------------------------------------------------------------------------
// The risk gate records it — and does NOT act on it
// ---------------------------------------------------------------------------

function dbWithClosedTrade({ closedAt, netPnl, symbol = 'JPN225' }) {
  const db = initDB(':memory:')
  db.prepare("INSERT OR REPLACE INTO accounts (account_id, is_live, enabled) VALUES ('43097342', 0, 1)").run()
  setState(db, 'ctrader_account_id', '43097342')
  setState(db, 'acct:43097342:account_balance_usd', '50000')
  // The daily-loss cap would otherwise bind first on a −$1,315 close and the
  // proposal would never reach the cooldown block at all. Lifted here so the
  // test exercises the gate it is about — not a change to any shipped default.
  setState(db, 'risk_config_json', JSON.stringify({
    symbolCooldownMinutes: 5, dailyLossLimit: 1e9, dailyLossPct: 0.99, maxConsecutiveLosses: 0,
  }))
  db.prepare(
    `INSERT INTO trades (symbol, side, status, closed_at, net_pnl, account_id)
     VALUES (?, 'sell', 'closed', ?, ?, '43097342')`
  ).run(symbol, closedAt, netPnl)
  return db
}

test('the verdict CARRIES the counterfactual while still approving', async () => {
  const { evaluateTrade } = await import('../services/risk.js')
  // A loss 38 minutes ago: outside the configured 5m, well inside the 240m default.
  const closedAt = new Date(Date.now() - 38 * 60_000).toISOString()
  const db = dbWithClosedTrade({ closedAt, netPnl: -1315.92 })

  const v = evaluateTrade(db, { symbol: 'JPN225', bias: 'short', entry: 40000, sl: 40400, tp1: 39400, accountId: '43097342' })

  assert.ok(!/symbol_cooldown wait/.test(v.veto_reason || ''), 'the 5-minute window still allows it — behaviour is unchanged')
  assert.equal(v.checks.symbol_cooldown_would_block_at_default, true)
  assert.equal(v.checks.symbol_cooldown_minutes_since_loss, 38)
  assert.match(v.checks.symbol_cooldown_counterfactual, /would have REFUSED this entry/)
  assert.match(v.checks.symbol_cooldown_counterfactual, /\$1,315\.92/)
})

test('a WINNING last close leaves the verdict unannotated', async () => {
  const { evaluateTrade } = await import('../services/risk.js')
  const closedAt = new Date(Date.now() - 38 * 60_000).toISOString()
  const db = dbWithClosedTrade({ closedAt, netPnl: 900 })

  const v = evaluateTrade(db, { symbol: 'JPN225', bias: 'short', entry: 40000, sl: 40400, tp1: 39400, accountId: '43097342' })
  assert.equal(v.checks.symbol_cooldown_counterfactual, undefined)
  assert.equal(v.checks.symbol_cooldown_would_block_at_default, undefined)
})

test('inside the CONFIGURED window the veto still fires, unchanged', async () => {
  const { evaluateTrade } = await import('../services/risk.js')
  const closedAt = new Date(Date.now() - 2 * 60_000).toISOString()
  const db = dbWithClosedTrade({ closedAt, netPnl: -1315.92 })

  const v = evaluateTrade(db, { symbol: 'JPN225', bias: 'short', entry: 40000, sl: 40400, tp1: 39400, accountId: '43097342' })
  assert.equal(v.approved, false)
  assert.match(v.veto_reason, /symbol_cooldown wait=/)
  // The counterfactual is for entries that got THROUGH; a refusal needs no
  // second opinion about a longer window that would also have refused.
  assert.equal(v.checks.symbol_cooldown_counterfactual, undefined)
})

// ---------------------------------------------------------------------------
// OWNER DECISION 2026-08-06 — the cooldown is LOSS-ONLY and ACCOUNT-SCOPED
// ---------------------------------------------------------------------------

test('a WIN two minutes ago does not lock the symbol', async () => {
  // It used to. The gate fired after ANY close, so a symbol that had just paid
  // was locked exactly as long as one that stopped us out.
  const { evaluateTrade } = await import('../services/risk.js')
  const db = dbWithClosedTrade({ closedAt: new Date(Date.now() - 2 * 60_000).toISOString(), netPnl: 900 })
  const v = evaluateTrade(db, { symbol: 'JPN225', bias: 'short', entry: 40000, sl: 40400, tp1: 39400, accountId: '43097342' })
  assert.ok(!/symbol_cooldown/.test(v.veto_reason || ''), v.veto_reason || '(approved)')
})

test('a LOSS two minutes ago still locks it, and the veto names the loss', async () => {
  const { evaluateTrade } = await import('../services/risk.js')
  const db = dbWithClosedTrade({ closedAt: new Date(Date.now() - 2 * 60_000).toISOString(), netPnl: -1315.92 })
  const v = evaluateTrade(db, { symbol: 'JPN225', bias: 'short', entry: 40000, sl: 40400, tp1: 39400, accountId: '43097342' })
  assert.equal(v.approved, false)
  assert.match(v.veto_reason, /symbol_cooldown wait=\d+m after=-1315\.92 account=43097342/)
  assert.equal(v.checks.symbol_cooldown_last_loss, -1315.92)
})

test('the most recent WIN does not hide an older loss still inside the window', async () => {
  // The query takes the latest LOSS, not the latest close. A win logged after a
  // loss must not unlock the level the loss was taken at.
  const { evaluateTrade } = await import('../services/risk.js')
  const db = dbWithClosedTrade({ closedAt: new Date(Date.now() - 4 * 60_000).toISOString(), netPnl: -800 })
  db.prepare(
    `INSERT INTO trades (symbol, side, status, closed_at, net_pnl, account_id)
     VALUES ('JPN225', 'sell', 'closed', ?, 120, '43097342')`
  ).run(new Date(Date.now() - 1 * 60_000).toISOString())
  const v = evaluateTrade(db, { symbol: 'JPN225', bias: 'short', entry: 40000, sl: 40400, tp1: 39400, accountId: '43097342' })
  assert.equal(v.approved, false)
  assert.match(v.veto_reason, /after=-800\.00/)
})

test("ANOTHER account's loss no longer locks this account's symbol", async () => {
  // It did, for the whole life of this gate: the query had no account_id
  // clause, so a close on 43097342 locked JPN225 on 46130058 and on live.
  const { evaluateTrade } = await import('../services/risk.js')
  const db = dbWithClosedTrade({ closedAt: new Date(Date.now() - 2 * 60_000).toISOString(), netPnl: -1315.92 })
  db.prepare("INSERT OR REPLACE INTO accounts (account_id, is_live, enabled) VALUES ('46130058', 0, 1)").run()
  setState(db, 'acct:46130058:account_balance_usd', '50000')
  const v = evaluateTrade(db, { symbol: 'JPN225', bias: 'short', entry: 40000, sl: 40400, tp1: 39400, accountId: '46130058' })
  assert.ok(!/symbol_cooldown/.test(v.veto_reason || ''), v.veto_reason || '(approved)')
})

test('a close with NO realised P&L yet is unknown, not a win — and does not lock', async () => {
  // `unknown_daily_pnl` owns that condition and blocks account-wide; judging it
  // again here would either double-block or silently disagree with it.
  const { evaluateTrade } = await import('../services/risk.js')
  const db = dbWithClosedTrade({ closedAt: new Date(Date.now() - 2 * 60_000).toISOString(), netPnl: null })
  const v = evaluateTrade(db, { symbol: 'JPN225', bias: 'short', entry: 40000, sl: 40400, tp1: 39400, accountId: '43097342' })
  assert.ok(!/symbol_cooldown/.test(v.veto_reason || ''), v.veto_reason || '(approved)')
})

test('AT 60 MINUTES the two JPN225 re-entries that cost -$10,487.68 are refused', async () => {
  // The whole point of choosing 60. Gaps were 38.1 and 36.6 minutes.
  const { evaluateTrade } = await import('../services/risk.js')
  for (const gapMin of [38, 37]) {
    const db = dbWithClosedTrade({ closedAt: new Date(Date.now() - gapMin * 60_000).toISOString(), netPnl: -1315.92 })
    setState(db, 'risk_config_json', JSON.stringify({
      symbolCooldownMinutes: 60, dailyLossLimit: 1e9, dailyLossPct: 0.99, maxConsecutiveLosses: 0,
    }))
    const v = evaluateTrade(db, { symbol: 'JPN225', bias: 'short', entry: 40000, sl: 40400, tp1: 39400, accountId: '43097342' })
    assert.equal(v.approved, false, `gap ${gapMin}m must be refused at 60m`)
    assert.match(v.veto_reason, /symbol_cooldown wait=/)
  }
})
