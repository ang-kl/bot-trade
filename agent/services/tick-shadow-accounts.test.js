// agent/services/tick-shadow-accounts.test.js — §2: the account execution
// simulation. Behavioural, against a real in-memory DB and the real services;
// the one source-reading test is labelled as the wiring pin it is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { initDB, setState } from '../db.js'
import { upsertAccount } from './account-registry.js'
import { shadowPortfolio } from './tick-shadow.js'
import {
  accountContext, accountExecutionSim, evidenceCount, REFUSAL_REASONS, snapToStep,
  tickShadowAccountsView,
} from './tick-shadow-accounts.js'
import { LOT_SIZE_KEY } from '../lib/lot-size-registry.js'
import { pendingExposure } from './entry-ledger.js'

const A = '46979908', B = '46130058', LIVE = '42993489'
const W = 100_000                      // wire units per 1.0 of price

/** EURUSD at 1.10, 10 pip stop, a +3R winner. Prices are wire units. */
function shadowRow(db, seq, o = {}) {
  const r = {
    side: 'cpp_exec_demo', boot_id: 'b1', seq, symbol_id: 1, profile_hash: 'p1', trade_side: 'BUY',
    entry: 1.10 * W, exit: 1.103 * W, stop: 1.099 * W, stop_distance: 0.001 * W,
    reason: 'target', gross_r: 3, net_r: 3, entry_ms: 1_000_000 + seq * 10_000, exit_ms: 1_005_000 + seq * 10_000,
    cost_class: 'fx', commission_wire: 0, commission_bps: 0.35, slippage_wire: 0, slippage_bps: 0.5, ...o,
  }
  db.prepare(`INSERT INTO tick_shadow_trades
    (side, boot_id, seq, symbol_id, profile_hash, trade_side, entry, exit, stop, stop_distance, reason,
     gross_r, net_r, entry_ms, exit_ms, cost_class, commission_wire, commission_bps, slippage_wire, slippage_bps)
    VALUES (@side,@boot_id,@seq,@symbol_id,@profile_hash,@trade_side,@entry,@exit,@stop,@stop_distance,@reason,
     @gross_r,@net_r,@entry_ms,@exit_ms,@cost_class,@commission_wire,@commission_bps,@slippage_wire,@slippage_bps)`).run(r)
  return r
}

function fresh({ accounts = [[A, 10_000]], symbols = { EURUSD: 1, 'LLY.US': 2 } } = {}) {
  const db = initDB(':memory:')
  for (const [id, bal] of accounts) {
    upsertAccount(db, { accountId: id, isLive: id === LIVE })
    db.prepare('UPDATE accounts SET enabled = 1 WHERE account_id = ?').run(id)
    if (bal != null) setState(db, `acct:${id}:account_balance_usd`, String(bal))
  }
  setState(db, 'symbol_id_map', JSON.stringify(symbols))
  // The broker's own volume declaration for EURUSD: 1 lot = 100,000 units
  // (protocol lotSize 10,000,000), minimum 0.01 lots, step 0.01 lots.
  setState(db, LOT_SIZE_KEY, JSON.stringify({
    EURUSD: { lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000 },
    'LLY.US': { lotSize: 100, minVolume: 100, stepVolume: 100 },
  }))
  return db
}

// ───────────────────────────────────────────────────────────────────────────
// THE COUNTING RULE
// ───────────────────────────────────────────────────────────────────────────

test('COUNTING RULE: shared observations are counted ONCE — projecting the same shadow trades onto N accounts never multiplies the evidence count', () => {
  const db = fresh({ accounts: [[A, 10_000], [B, 10_000]] })
  for (let i = 1; i <= 4; i++) shadowRow(db, i, { symbol_id: 1 })
  const one = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' })
  assert.equal(one.evidence.accounts, 2)
  assert.equal(one.evidence.sharedObservations, 4, 'four shadow trades are four observations')
  assert.equal(one.evidence.accountRows, 8, 'two accounts × four trades — projections, not observations')
  assert.notEqual(one.evidence.sharedObservations, one.evidence.accountRows)
  // the rule is on the record with the figures it governs
  assert.match(one.evidence.rule, /never summed into an evidence total/)
  // and the function that returns an evidence count takes the SHARED trades,
  // so there is no argument through which account rows could enter it
  assert.equal(evidenceCount(db.prepare('SELECT * FROM tick_shadow_trades').all()), 4)
  assert.equal(evidenceCount([]), 0)
  // adding a third account changes the projections and NOT the evidence
  upsertAccount(db, { accountId: '46130059', isLive: false })
  db.prepare('UPDATE accounts SET enabled = 1 WHERE account_id = ?').run('46130059')
  setState(db, 'acct:46130059:account_balance_usd', '10000')
  const two = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' })
  assert.equal(two.evidence.sharedObservations, 4, 'a third account is not a fifth observation')
  assert.equal(two.evidence.accountRows, 12)
  // no per-account figure is an evidence count either: `signalsOffered` is
  // the SHARED count, identical on every account, never a sum
  for (const a of two.accounts) assert.equal(a.signalsOffered, 4)
})

// ───────────────────────────────────────────────────────────────────────────
// THE ACCOUNT'S OWN INPUTS
// ───────────────────────────────────────────────────────────────────────────

test('the account simulation uses the REAL drawdownDeriskFactor, where the 1R rescale hard-codes 1', () => {
  const db = fresh()
  setState(db, `acct:${A}:risk_config_json`, JSON.stringify({
    perTradeRiskPct: 0.02, maxRiskCapPct: 0.05, derisk: { on: true, windowHours: 24, triggerPct: 0.02, mult: 0.5 },
  }))
  const plain = accountContext(db, A)
  assert.equal(plain.ddFactor, 1)
  assert.equal(plain.baseBudgetUsd, 200)
  // a realized loss past the trigger on THIS account arms the anti-tilt layer
  db.prepare(`INSERT INTO trades (symbol, side, status, net_pnl, closed_at, account_id)
    VALUES ('EURUSD','buy','closed', -500, datetime('now','-1 hours'), ?)`).run(A)
  const derisked = accountContext(db, A)
  assert.equal(derisked.ddFactor, 0.5, 'the real factor, read from this account\'s own realized P&L')
  assert.equal(derisked.baseBudgetUsd, 100, 'the budget is halved — 200 is what the rescale would still report')
  // and the rescale really does still report the underisked figure
  shadowRow(db, 1)
  const pf = shadowPortfolio(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' })
  assert.equal(pf.accounts.find(x => x.accountId === '…9908').usdPerR, 200,
    'the retained 1R rescale is unchanged and still hard-codes ddFactor 1 — that is why it is labelled a display')
  assert.match(pf.projectionNote, /a display, not evidence/)
})

test('sharedSignalRiskSplit: one signal fanned to N accounts SPLITS the budget, it does not multiply it', () => {
  const db = fresh({ accounts: [[A, 10_000], [B, 10_000]] })
  setState(db, 'risk_config_json', JSON.stringify({ perTradeRiskPct: 0.02, maxRiskCapPct: 0.05 }))
  const alone = accountContext(db, A, { sharedAccounts: 1 })
  assert.equal(alone.sharedSplit, 1); assert.equal(alone.riskBudgetUsd, 200)
  const shared = accountContext(db, A, { sharedAccounts: 2 })
  assert.equal(shared.sharedSplit, 0.5); assert.equal(shared.riskBudgetUsd, 100)
  // 'off' is honoured
  setState(db, `acct:${A}:risk_config_json`, JSON.stringify({ perTradeRiskPct: 0.02, maxRiskCapPct: 0.05, sharedSignalRiskSplit: 'off' }))
  assert.equal(accountContext(db, A, { sharedAccounts: 2 }).riskBudgetUsd, 200)
})

test('an account with no stamped balance produces a row per signal with reason balance_not_read — never a dropped signal', () => {
  const db = fresh({ accounts: [[A, 10_000], [B, null]] })
  for (let i = 1; i <= 3; i++) shadowRow(db, i)
  const sim = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' })
  const b = sim.accounts.find(x => x.accountId === '…0058')
  assert.equal(b.balance, null)
  assert.equal(b.refused, 3); assert.equal(b.executed, 0)
  assert.deepEqual(b.refusals, { balance_not_read: 3 }, 'three signals, three rows, one reason')
  // the global key is never a substitute
  setState(db, 'account_balance_usd', '45837.59')
  const again = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' })
  assert.equal(again.accounts.find(x => x.accountId === '…0058').executed, 0)
  assert.ok(!JSON.stringify(again).includes('45837'), 'the global balance never appears')
})

// ───────────────────────────────────────────────────────────────────────────
// THE REFUSALS
// ───────────────────────────────────────────────────────────────────────────

test('below_min_lot: a budget too small for the broker\'s own minimum refuses, and the refusal is a row', () => {
  // EURUSD, 0.001 of price of stop, 100,000 units per lot → $100 of risk per
  // lot. A $0.50 budget buys 0.005 lots, under the broker's 0.01 minimum.
  const db = fresh({ accounts: [[A, 100]] })
  setState(db, 'risk_config_json', JSON.stringify({ perTradeRiskPct: 0.005 }))
  shadowRow(db, 1)
  const sim = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' })
  const a = sim.accounts[0]
  assert.equal(a.executed, 0)
  assert.deepEqual(a.refusals, { below_min_lot: 1 })
  const row = a.rows[0]
  assert.equal(row.minLots, 0.01); assert.equal(row.lotStep, 0.01)
  assert.ok(row.lots < row.minLots, 'the sized volume really is under the broker\'s minimum')
  // a balance that can afford it executes — same signal, same code path
  setState(db, `acct:${A}:account_balance_usd`, '10000')
  const ok = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' }).accounts[0]
  assert.equal(ok.executed, 1); assert.deepEqual(ok.refusals, {})
})

test('the lot increment is snapped DOWN before the minimum is tested, never after', () => {
  assert.equal(snapToStep(0.137, 0.01), 0.13)
  assert.equal(snapToStep(0.9, 1), 0)
  assert.equal(snapToStep(2.7, 0.5), 2.5)
  assert.equal(snapToStep(0.005, 0.01), 0, 'below one step is zero lots, not "nearly a step"')
  assert.equal(snapToStep(0.137, null), 0.13, 'no broker step → the repo\'s 2dp convention')
  // behavioural: a 1-lot step makes a 0.9-lot budget unfillable
  const db = fresh({ accounts: [[A, 10_000]] })
  setState(db, LOT_SIZE_KEY, JSON.stringify({ EURUSD: { lotSize: 10_000_000, minVolume: 100_000, stepVolume: 10_000_000 } }))
  setState(db, 'risk_config_json', JSON.stringify({ perTradeRiskPct: 0.009 }))  // $90 ÷ $100/lot = 0.9 lots
  shadowRow(db, 1)
  const a = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' }).accounts[0]
  assert.equal(a.rows[0].lotStep, 1)
  assert.equal(a.rows[0].lots, 0, '0.9 lots snaps down to 0 on a 1-lot step')
  assert.equal(a.rows[0].reason, 'below_min_lot')
})

test('position_cap: the cap is read from the account\'s own config and the simulation\'s own open positions count against it', () => {
  const db = fresh({ accounts: [[A, 1_000_000]] })
  setState(db, `acct:${A}:risk_config_json`, JSON.stringify({ perTradeRiskPct: 0.001, maxOpenPositions: 2 }))
  // three OVERLAPPING signals on three different symbols — nothing closes
  // before the next opens, so the third meets the cap
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2, AUDUSD: 3 }))
  setState(db, LOT_SIZE_KEY, JSON.stringify(Object.fromEntries(['EURUSD', 'GBPUSD', 'AUDUSD'].map(s => [s, { lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000 }]))))
  for (const [i, sid] of [1, 2, 3].entries()) shadowRow(db, i + 1, { symbol_id: sid, entry_ms: 1_000_000 + i, exit_ms: 9_000_000 })
  const a = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' }).accounts[0]
  assert.equal(a.maxOpenPositions, 2)
  assert.equal(a.executed, 2)
  assert.deepEqual(a.refusals, { position_cap: 1 })
  // and once the first two have CLOSED, a later signal fits again
  shadowRow(db, 4, { symbol_id: 1, entry_ms: 9_500_000, exit_ms: 9_600_000 })
  const b = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' }).accounts[0]
  assert.equal(b.executed, 3, 'the simulated positions retire at their own exit time')
})

test('symbol_already_held: a real open position on the symbol refuses the signal', () => {
  const db = fresh()
  shadowRow(db, 1)
  db.prepare(`INSERT INTO monitored_positions (symbol, side, status, account_id, entry_price) VALUES ('EURUSD','long','active',?,1.1)`).run(A)
  const a = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' }).accounts[0]
  assert.deepEqual(a.refusals, { symbol_already_held: 1 })
  assert.equal(a.openPositionsNow, 1)
})

test('intent_open: an open entry intent on the symbol refuses the signal — pendingExposure is what reads it', () => {
  const db = fresh()
  shadowRow(db, 1)
  // A SENT permit is exposure. An unused standing RESERVED permit is capacity.
  db.prepare(`INSERT INTO entry_intents
    (id, account_id, environment, symbol, symbol_id, side, order_type, volume, producer_id, basis, mode_epoch,
     permit_id, permit_expires_at, state)
    VALUES ('i1', ?, 'demo', 'EURUSD', 1, 'BUY', 'MARKET', 0.1, 'tick_momentum', 'tick', 1,
     'p1', datetime('now','+5 minutes'), 'SENT')`).run(A)
  assert.equal(pendingExposure(db, A).length, 1, 'the ledger reports the open intent')
  const a = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' }).accounts[0]
  assert.deepEqual(a.refusals, { intent_open: 1 })
  assert.equal(a.openIntentsNow, 1)
})

test('margin_insufficient: the account\'s own margin cap and used margin refuse the signal', () => {
  const db = fresh({ accounts: [[A, 10_000]] })
  // a tiny margin cap with a large-but-affordable risk budget: the risk gate
  // would size it, the margin headroom will not hold it
  setState(db, `acct:${A}:risk_config_json`, JSON.stringify({ perTradeRiskPct: 0.05, maxMarginUsagePct: 0.001 }))
  setState(db, `acct:${A}:account_leverage`, '100')
  shadowRow(db, 1)
  const a = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' }).accounts[0]
  assert.deepEqual(a.refusals, { margin_insufficient: 1 })
  const row = a.rows[0]
  assert.ok(row.marginRequiredUsd > row.marginCapUsd, 'the required margin really exceeds the cap')
  // a workable cap lets the same signal through
  setState(db, `acct:${A}:risk_config_json`, JSON.stringify({ perTradeRiskPct: 0.05, maxMarginUsagePct: 0.9 }))
  assert.equal(accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' }).accounts[0].executed, 1)
})

test('symbol_unmapped: a shadow row whose symbol id resolves to no name is a ROW, not a silent drop', () => {
  const db = fresh({ symbols: {} })
  shadowRow(db, 1, { symbol_id: 777 })
  const a = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' }).accounts[0]
  assert.deepEqual(a.refusals, { symbol_unmapped: 1 })
  assert.equal(a.executed + a.refused, 1, 'every offered signal is accounted for')
  // every reason this module can record is declared
  for (const r of a.rows) assert.ok(REFUSAL_REASONS.includes(r.reason), `${r.reason} must be a declared reason`)
})

test('the per-account row set accounts for every shared signal — executed + refused is always the shared count', () => {
  const db = fresh({ accounts: [[A, 10_000], [B, 60]] })
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2 }))
  setState(db, LOT_SIZE_KEY, JSON.stringify(Object.fromEntries(['EURUSD', 'GBPUSD'].map(s => [s, { lotSize: 10_000_000, minVolume: 100_000, stepVolume: 100_000 }]))))
  for (let i = 1; i <= 6; i++) shadowRow(db, i, { symbol_id: i % 2 ? 1 : 2, entry_ms: 1_000_000 + i * 50_000, exit_ms: 1_010_000 + i * 50_000 })
  const sim = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' })
  for (const a of sim.accounts) {
    assert.equal(a.executed + a.refused, 6, `${a.accountId}: six signals, six rows`)
    assert.equal(Object.values(a.refusals).reduce((x, y) => x + y, 0), a.refused)
  }
})

// ───────────────────────────────────────────────────────────────────────────
// PERSISTENCE
// ───────────────────────────────────────────────────────────────────────────

test('the fills table keys on (shadow_trade_id, account_id), is idempotent, and keeps the refusals', () => {
  const db = fresh({ accounts: [[A, 10_000], [B, 60]] })   // B cannot reach the minimum lot
  for (let i = 1; i <= 3; i++) shadowRow(db, i, { entry_ms: 1_000_000 + i * 50_000, exit_ms: 1_010_000 + i * 50_000 })
  accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1', persist: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_shadow_account_fills').get().n, 6)
  accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1', persist: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_shadow_account_fills').get().n, 6, 'a second run updates, it does not duplicate')
  const refused = db.prepare(`SELECT reason, COUNT(*) AS n FROM tick_shadow_account_fills WHERE executed = 0 GROUP BY reason`).all()
  assert.ok(refused.length > 0, 'the refusals are on the table, not lost')
  for (const r of refused) assert.ok(REFUSAL_REASONS.includes(r.reason))
  // and tick_shadow_trades gains NO account column — it is the shared record
  const cols = db.prepare('PRAGMA table_info(tick_shadow_trades)').all().map(c => c.name)
  assert.ok(!cols.some(c => /account/i.test(c)), 'the shared market-signal record has no account field')
})

test('only ENABLED accounts on the matching side are simulated, and ids are last-4 only', () => {
  const db = fresh({ accounts: [[A, 10_000], [LIVE, 10_000]] })
  db.prepare('UPDATE accounts SET enabled = 0 WHERE account_id = ?').run(A)
  upsertAccount(db, { accountId: B, isLive: false })
  db.prepare('UPDATE accounts SET enabled = 1 WHERE account_id = ?').run(B)
  setState(db, `acct:${B}:account_balance_usd`, '10000')
  shadowRow(db, 1)
  const sim = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' })
  assert.deepEqual(sim.accounts.map(a => a.accountId), ['…0058'], 'the disabled demo account and the live one are both out')
  const json = JSON.stringify(sim)
  assert.ok(!json.includes(A) && !json.includes(LIVE) && !json.includes(B), 'no full account id anywhere in the output')
})

test('the view reaches every side and every profile', () => {
  const db = fresh()
  shadowRow(db, 1); shadowRow(db, 2, { profile_hash: 'p2' })
  const v = tickShadowAccountsView(db)
  assert.equal(v.sides.length, 2)
  assert.deepEqual(v.sides[0].profiles.map(p => p.profile).sort(), ['p1', 'p2'])
  assert.equal(v.sides[1].profiles.length, 0, 'the live side has no shadow trades here')
  assert.match(v.note, /counted once/)
})

// ───────────────────────────────────────────────────────────────────────────
// WIRING PIN (a last resort: the route's call site is invisible from here)
// ───────────────────────────────────────────────────────────────────────────

test('wiring pin (source-read, comments stripped): the state route reaches the account simulation', () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const st = strip(readFileSync(new URL('../routes/state.js', import.meta.url), 'utf8'))
  assert.match(st, /router\.get\('\/tick-shadow-accounts'/)
  assert.match(st, /tickShadowAccountsView\(db/)
})

// ───────────────────────────────────────────────────────────────────────────
// PR-2c — every figure carries its cost sensitivity and its basis
// ───────────────────────────────────────────────────────────────────────────

test('every executed row carries 0x / 1x / 2x cost sensitivity, and the account total carries it too', () => {
  const db = fresh({ accounts: [[A, 10_000]] })
  for (let i = 1; i <= 3; i++) shadowRow(db, i, { entry_ms: 1_000_000 + i * 50_000, exit_ms: 1_010_000 + i * 50_000 })
  const a = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' }).accounts[0]
  assert.equal(a.executed, 3)
  for (const r of a.rows) {
    assert.ok(r.sensitivityUsd, 'an executed row without its sensitivity is a 1x figure presented alone')
    assert.ok(r.sensitivityUsd[0] > r.sensitivityUsd[1], '0x cost nets more than 1x')
    assert.ok(r.sensitivityUsd[1] > r.sensitivityUsd[2], '1x cost nets more than 2x')
    assert.equal(r.netUsd, r.sensitivityUsd[1], 'the reported net IS the 1x figure')
  }
  assert.ok(a.costSensitivityUsd[0] > a.costSensitivityUsd[1])
  assert.ok(a.costSensitivityUsd[1] > a.costSensitivityUsd[2])
  assert.equal(a.netUsd, a.costSensitivityUsd[1])
})

test('the simulation reports which cost terms are MEASURED and which are ASSUMED, beside the figures', () => {
  const db = fresh()
  shadowRow(db, 1)
  const sim = accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1' })
  assert.equal(sim.costBasis.slippage.basis, 'assumed', 'the slippage placeholder is never reported as measured')
  assert.equal(sim.costBasis.slippage.available, false)
  assert.equal(sim.costBasis.latency.basis, 'assumed', 'no intent→acknowledgement pairs here')
  assert.equal(sim.costBasis.commission.basis, 'measured_with_stated_gaps')
  // and the sized figures the two gaps close are on the record
  assert.equal(sim.sizedCommission.stockUsMinUsdPerSide, 0.02)
  assert.equal(sim.sizedCommission.fxUsdPerLotPerSide, 3.5)
  // the FX row really is charged the per-lot fee, not the bps approximation
  const row = sim.accounts[0].rows[0]
  assert.equal(row.costClass, 'fx'); assert.equal(row.costBasis, 'per_lot')
  assert.equal(row.commissionUsd, +(2 * 3.5 * row.lots).toFixed(4), '$3.50 per lot per side, both sides')
})
