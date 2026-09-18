// node --test agent/services/edge-watchdog.test.js
import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState, getState } from '../db.js'
import { runEdgeWatchdog, strategyRollingEdge } from './edge-watchdog.js'
import { setStage, armedTradeKeys } from './stage-matrix.js'

// Insert n closed trades for a strategy with the given per-trade pnls.
function seed(db, strategy, pnls) {
  const ins = db.prepare(
    `INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at)
     VALUES ('EURUSD','BUY','closed',?,?,?)`
  )
  pnls.forEach((p, i) => ins.run(strategy, p, `2026-07-10 ${String(i % 24).padStart(2, '0')}:00:00`))
}

const arm = (db, keys) => setState(db, 'enabled_strategies_json', JSON.stringify(keys))
const isArmed = (db, key) => JSON.parse(getState(db, 'enabled_strategies_json') || '[]').includes(key)

test('rollingEdge: honest expectancy/PF, excludes NULL net_pnl', () => {
  const db = initDB(':memory:')
  seed(db, 'rsi_meanrev', [10, -5, 4])
  // a NULL (un-backfilled) close must not be read as a loss
  db.prepare(`INSERT INTO trades (symbol,side,status,label_strategy,net_pnl,closed_at) VALUES ('EURUSD','BUY','closed','rsi_meanrev',NULL,'2026-07-10 05:00:00')`).run()
  const e = strategyRollingEdge(db, 'rsi_meanrev', 20)
  assert.equal(e.trades, 3)
  assert.equal(e.net, 9)
  assert.equal(e.expectancy, 3)
  assert.equal(e.profitFactor, Math.round((14 / 5) * 100) / 100)
})

// ---------------------------------------------------------------------------
// Scoping (owner order, 02-09-2026). The earned floor gates PER ACCOUNT but
// consumed this pooled window; the watchdog keeps the pooled view on purpose.
// ---------------------------------------------------------------------------

function seedScoped(db, strategy, accountId, pnls, bracket = null) {
  const ins = db.prepare(
    `INSERT INTO trades (symbol, side, status, label_strategy, net_pnl, closed_at, account_id, entry_price, sl_price, tp_price)
     VALUES ('EURUSD','BUY','closed',?,?,?,?,?,?,?)`
  )
  pnls.forEach((p, i) => ins.run(strategy, p, `2026-07-11 ${String(i % 24).padStart(2, '0')}:00:00`, accountId,
    bracket ? 100 : null, bracket ? 99 : null, bracket ? 100 + bracket : null))
}

test('rollingEdge accountId: a string scopes to that account plus unscoped legacy rows; null pools every account', () => {
  const db = initDB(':memory:')
  seedScoped(db, 'rsi_meanrev', 'A', [10, -5])
  seedScoped(db, 'rsi_meanrev', 'B', [-20, -20, -20])
  seedScoped(db, 'rsi_meanrev', null, [4])
  assert.equal(strategyRollingEdge(db, 'rsi_meanrev', 20, { accountId: 'A' }).trades, 3, 'A + legacy NULL rows')
  assert.equal(strategyRollingEdge(db, 'rsi_meanrev', 20, { accountId: 'A' }).net, 9)
  assert.equal(strategyRollingEdge(db, 'rsi_meanrev', 20, { accountId: 'B' }).trades, 4)
  assert.equal(strategyRollingEdge(db, 'rsi_meanrev', 20, { accountId: null }).trades, 6, 'pooled')
  assert.equal(strategyRollingEdge(db, 'rsi_meanrev', 20).trades, 6, 'no option = pooled (unchanged default)')
  assert.equal(strategyRollingEdge(db, 'rsi_meanrev', 20, { accountId: 'C' }).trades, 1, 'unknown account sees only legacy rows')
})

test('rollingEdge rrBand: only closes whose PLANNED bracket was under the band count; no bracket = not in the band', () => {
  const db = initDB(':memory:')
  seedScoped(db, 'vwap_trend', 'A', [30, 30, 30], 3.5)   // ≥3R — outside the band
  seedScoped(db, 'vwap_trend', 'A', [30], 3.0)           // exactly 3.0 — not below
  seedScoped(db, 'vwap_trend', 'A', [30, -10], 1.6)      // the admitted band
  seedScoped(db, 'vwap_trend', 'A', [30])                // no bracket — unknowable
  const band = strategyRollingEdge(db, 'vwap_trend', 20, { accountId: 'A', rrBand: { below: 3 } })
  assert.equal(band.trades, 2)
  assert.equal(band.winRate, 50)
  assert.equal(strategyRollingEdge(db, 'vwap_trend', 20, { accountId: 'A' }).trades, 7, 'no band = every close')
  assert.equal(strategyRollingEdge(db, 'vwap_trend', 20, { rrBand: { below: 'junk' } }).trades, 7, 'an unreadable band is no band')
})

test('the watchdog itself stays POOLED — its disarm is global (source pin, comments stripped)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('./edge-watchdog.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '')
  assert.ok(src.includes('strategyRollingEdge(db, key, cfg.window, { accountId: null })'), 'the pooled intent must be written at the call')
})

test('disarms an armed strategy with clearly-negative edge over a full window', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  // 16 trades, mostly losers → expectancy < 0 and PF < 0.95.
  seed(db, 'rsi_meanrev', [5, -8, -7, 4, -9, -6, 3, -8, -7, 2, -9, -6, 4, -8, -7, 3])
  const notes = []
  const r = runEdgeWatchdog(db, { notify: (m) => notes.push(m) })
  assert.equal(r.actions.length, 1)
  assert.equal(r.actions[0].strategy, 'rsi_meanrev')
  assert.equal(isArmed(db, 'rsi_meanrev'), false, 'strategy disarmed')
  assert.ok(notes[0].includes('EDGE WATCHDOG'))
})

test('leaves a profitable armed strategy alone', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  seed(db, 'rsi_meanrev', Array.from({ length: 16 }, (_, i) => (i % 3 === 0 ? -4 : 6)))
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.actions.length, 0)
  assert.equal(isArmed(db, 'rsi_meanrev'), true)
})

test('does not judge on too few trades', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  seed(db, 'rsi_meanrev', [-9, -8, -7, -6]) // clearly losing but only 4 trades
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.actions.length, 0)
  assert.equal(isArmed(db, 'rsi_meanrev'), true)
})

test('spares a breakeven-but-noisy strategy (expectancy just under 0, PF ≥ floor)', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  // 8 wins of +10, 8 losses of -10.2 → expectancy -0.1, PF ≈ 0.98 (> 0.95 floor).
  seed(db, 'rsi_meanrev', [...Array(8).fill(10), ...Array(8).fill(-10.2)])
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.actions.length, 0, 'PF above floor → not disarmed')
  assert.equal(isArmed(db, 'rsi_meanrev'), true)
})

test('acts once per newest trade (no re-disarm every cycle)', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  seed(db, 'rsi_meanrev', Array.from({ length: 16 }, () => -5))
  const first = runEdgeWatchdog(db, {})
  assert.equal(first.actions.length, 1)
  const second = runEdgeWatchdog(db, {})
  assert.equal(second.actions.length, 0, 'deduped on newest trade id')
})

test('reaches a strategy armed ONLY by a per-account pin: a LIVE pin is disarmed, a hand-pinned DEMO arm is held (09-09-2026)', () => {
  // 2026-08-31: globally-disarmed strategies kept proposing for days from
  // accounts whose overlay pins held them armed — and the watchdog never even
  // evaluated them, because its candidate set was the global list. The live
  // half of that lesson stands. 09-09-2026: the cluster rule pinned every
  // strategy on every demo account at 13:49 SGT and this watchdog unpinned
  // two of them at 13:54 on their pooled record; the boot seed re-pinned them
  // at 16:08. A demo hand pin is the owner's word, judged per account by the
  // 30-close verdict — the watchdog records it as held and leaves it. PR-B
  // (owner principle 1): a hand pin on a LIVE account is held the same way;
  // an account inheriting the global list still follows the global disarm.
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',0,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('222','2',1,1,'active')`).run()
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('444','4',1,1,'active')`).run() // live, inherits global
  arm(db, ['vwap_trend', 'rsi_meanrev']) // rsi_meanrev on the global list too, so the inheriting scope has something to lose
  setStage(db, { kind: 'strategy', key: 'rsi_meanrev', stage: 'trade', on: true, accountId: '111' }, { getState, setState })
  setStage(db, { kind: 'strategy', key: 'rsi_meanrev', stage: 'trade', on: true, accountId: '222' }, { getState, setState })
  seed(db, 'rsi_meanrev', Array.from({ length: 16 }, () => -5))
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.actions.length, 1, 'pin-armed strategy must be a candidate')
  assert.deepEqual(r.actions[0].scopes, ['global'], 'the global list is disarmed; both hand pins hold')
  assert.deepEqual(r.actions[0].heldPinned, ['111', '222'], 'the demo AND the live hand pin are held and named')
  assert.equal(armedTradeKeys(db, getState, '222').has('rsi_meanrev'), true, 'PR-B: a hand-pinned live scope is held under the watchdog — RED if the !isLive term returns')
  assert.equal(armedTradeKeys(db, getState, '111').has('rsi_meanrev'), true, 'demo hand pin still armed')
  assert.equal(armedTradeKeys(db, getState, '444').has('rsi_meanrev'), false, 'a scope inheriting the global list follows the global disarm')
  // A demo pin alone: nothing to disarm, no action, nothing stamped.
  const only = initDB(':memory:')
  only.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('111','1',0,1,'active')`).run()
  arm(only, ['vwap_trend'])
  setStage(only, { kind: 'strategy', key: 'rsi_meanrev', stage: 'trade', on: true, accountId: '111' }, { getState, setState })
  seed(only, 'rsi_meanrev', Array.from({ length: 16 }, () => -5))
  assert.equal(runEdgeWatchdog(only, {}).actions.length, 0)
  assert.equal(armedTradeKeys(only, getState, '111').has('rsi_meanrev'), true)
})

test('off switch fully disables enforcement', () => {
  const db = initDB(':memory:')
  arm(db, ['rsi_meanrev'])
  setState(db, 'edge_watchdog_json', JSON.stringify({ on: false }))
  seed(db, 'rsi_meanrev', Array.from({ length: 16 }, () => -5))
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.skipped, 'off')
  assert.equal(isArmed(db, 'rsi_meanrev'), true)
})

// ---------------------------------------------------------------------------
// Owner "go auto-disarm" (31-08-2026): rolling PF < 1.0 over the window
// disarms. At pfFloor 1.0 the two-clause guard (expectancy<0 AND pf<floor)
// degenerates to exactly that single rule, because PF<1 ⟺ net<0. This pins
// the DELTA the order bought: a strategy grinding at PF 0.98 is spared at
// the default floor and disarmed at the owner's.
// ---------------------------------------------------------------------------
test('pfFloor 1.0 disarms a PF-0.98 grinder that the 0.95 default spares', () => {
  // 8 wins of +10, 8 losses of -10.2 → PF ≈ 0.98, expectancy -0.1.
  const seedPnls = [...Array(8).fill(10), ...Array(8).fill(-10.2)]

  const db1 = initDB(':memory:')
  arm(db1, ['rsi_meanrev'])
  seed(db1, 'rsi_meanrev', seedPnls)
  assert.equal(runEdgeWatchdog(db1, {}).actions.length, 0, 'default floor 0.95 spares PF 0.98')
  assert.equal(isArmed(db1, 'rsi_meanrev'), true)

  const db2 = initDB(':memory:')
  arm(db2, ['rsi_meanrev'])
  setState(db2, 'edge_watchdog_json', JSON.stringify({ pfFloor: 1.0 }))
  seed(db2, 'rsi_meanrev', seedPnls)
  const r = runEdgeWatchdog(db2, {})
  assert.equal(r.actions.length, 1, 'owner floor 1.0 disarms the same record')
  assert.equal(isArmed(db2, 'rsi_meanrev'), false)
  // And a genuinely profitable record still survives the owner floor.
  const db3 = initDB(':memory:')
  arm(db3, ['rsi_meanrev'])
  setState(db3, 'edge_watchdog_json', JSON.stringify({ pfFloor: 1.0 }))
  seed(db3, 'rsi_meanrev', [...Array(8).fill(10), ...Array(8).fill(-9.8)]) // PF ≈ 1.02
  assert.equal(runEdgeWatchdog(db3, {}).actions.length, 0)
})

test('wiring pin: the owner has a route to the dials', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../routes/actions.js', import.meta.url), 'utf8')
  assert.ok(src.includes("router.post('/edge-watchdog'"), 'POST /actions/edge-watchdog route missing')
  assert.ok(src.includes("setState(db, 'edge_watchdog_json'"), 'route must write edge_watchdog_json')
})

// PR-B checker (11-09-2026): the pin holds against the POOLED verdict; an
// account whose OWN window reads clearly no-edge has its cell written false.
test('production shape (every account pinned): a no-edge record on account X\'s OWN closes disarms X\'s cell and holds the other pins; a pooled-only verdict holds every pin', () => {
  const db = initDB(':memory:')
  const ids = ['111', '222', '333']
  for (const [id, live] of [['111', 1], ['222', 0], ['333', 0]]) db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, ?, 1, 'active')`).run(id, id, live)
  arm(db, ['vwap_trend', 'rsi_meanrev'])
  const io = { getState, setState }
  for (const id of ids) for (const k of ['vwap_trend', 'rsi_meanrev']) setStage(db, { kind: 'strategy', key: k, stage: 'trade', on: true, accountId: id }, io)
  // 16 losses stamped on the LIVE account 111; the pooled window is the same 16.
  seedScoped(db, 'rsi_meanrev', '111', Array.from({ length: 16 }, () => -5))
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.actions.length, 1)
  assert.deepEqual(r.actions[0].ownVerdictScopes, ['111'])
  assert.deepEqual(r.actions[0].scopes.sort(), ['111', 'global'], 'RED if the pin holds against the account\'s own no-edge record')
  assert.deepEqual(r.actions[0].heldPinned, ['222', '333'])
  assert.equal(armedTradeKeys(db, getState, '111').has('rsi_meanrev'), false)
  assert.equal(armedTradeKeys(db, getState, '222').has('rsi_meanrev'), true)
  assert.equal(armedTradeKeys(db, getState, '333').has('rsi_meanrev'), true)
  // Pooled only: 16 legacy (NULL-account) losses — no account owns the record → every pin holds, the global list is disarmed.
  const db2 = initDB(':memory:')
  for (const id of ids) db2.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES (?, ?, 0, 1, 'active')`).run(id, id)
  arm(db2, ['vwap_trend', 'rsi_meanrev'])
  for (const id of ids) for (const k of ['vwap_trend', 'rsi_meanrev']) setStage(db2, { kind: 'strategy', key: k, stage: 'trade', on: true, accountId: id }, io)
  seed(db2, 'rsi_meanrev', Array.from({ length: 16 }, () => -5))
  const p = runEdgeWatchdog(db2, {})
  assert.equal(p.actions.length, 1)
  assert.deepEqual(p.actions[0].ownVerdictScopes, [])
  assert.deepEqual(p.actions[0].scopes, ['global'])
  assert.deepEqual(p.actions[0].heldPinned, ids)
  for (const id of ids) assert.equal(armedTradeKeys(db2, getState, id).has('rsi_meanrev'), true)
  // ownOnly excludes the legacy rows; the default scoping still counts them.
  assert.equal(strategyRollingEdge(db2, 'rsi_meanrev', 30, { accountId: '111', ownOnly: true }).trades, 0)
  assert.equal(strategyRollingEdge(db2, 'rsi_meanrev', 30, { accountId: '111' }).trades, 16)
})

test('Wave 1 (19-09-2026): a momentum-family strategy is judged at its horizon, never by the 20-close window — losing tsmom_long stays armed and is reported as skipped', () => {
  const db = initDB(':memory:')
  arm(db, ['tsmom_long', 'rsi_meanrev'])
  seed(db, 'tsmom_long', [-8, -7, -9, -6, -8, -7, -9, -6, -8, -7, -9, -6, -8, -7, -9, -6])
  const r = runEdgeWatchdog(db, {})
  assert.equal(r.actions.length, 0)
  assert.equal(isArmed(db, 'tsmom_long'), true, 'the book is not disarmed on a sample it cannot have earned')
  assert.deepEqual(r.evaluated.find(e => e.strategy === 'tsmom_long'), { strategy: 'tsmom_long', skipped: 'judged_at_horizon' })
})
