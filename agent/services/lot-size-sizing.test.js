// node --test agent/services/lot-size-sizing.test.js
//
// PROVEN AGAINST REAL FILLS, 23-08-2026, before any code moved. Burn-in's
// first round-trips on demo 43097342 settle which lot convention is money:
//
//   DOGEUSD SELL 0.01 lots, stop hit: move 0.00259
//     broker convention (1 lot = 1,000): −$0.0259 → booked net −$0.03  ✓
//     contracts.js table (1 lot = 1):    −$0.0000                       ✗
//   ADAUSD SELL 0.01, gapped stop: broker (100/lot) $0.0091 ≈ −$0.01   ✓
//
// The broker is right and the table is wrong — 100× on ADAUSD/XRPUSD, 1000×
// on DOGEUSD, 9 symbols in all (GET /state/lot-size-parity). Orders are SENT
// in the broker's convention, so a DOGEUSD entry sized with the table would
// risk ~1000× its budget — and the notional/margin guards read the SAME
// table, so nothing downstream could object. The registry (broker truth,
// recorded at order time) now outranks the table at the gate: sizing, the
// notional cap and the margin estimate all price in the convention the order
// will actually fill in.

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { rememberLotSize, CENTS_PER_UNIT } from '../lib/lot-size-registry.js'
import { usdLossPerLot, notionalUsd } from '../lib/contracts.js'
import { computeRiskBasedVolume, requiredMargin, evaluateTrade, DEFAULT_RISK_CONFIG } from './risk.js'

// ---- the pure layers -------------------------------------------------------

test('usdLossPerLot: broker override outranks the table; absent changes nothing', () => {
  assert.equal(usdLossPerLot('DOGEUSD', 0.00256, 0.0912), 0.00256)          // table (1/lot)
  assert.equal(usdLossPerLot('DOGEUSD', 0.00256, 0.0912, null, 1000), 2.56) // broker
  for (const bad of [null, 0, -5, NaN, 'x']) {
    assert.equal(usdLossPerLot('DOGEUSD', 0.00256, 0.0912, null, bad), 0.00256,
      `junk override ${bad} must fall back to the table, not to garbage`)
  }
})

test('notionalUsd: same override, same fallback discipline', () => {
  assert.ok(Math.abs(notionalUsd('DOGEUSD', 0.01, 0.0912, null, 1000) / notionalUsd('DOGEUSD', 0.01, 0.0912) - 1000) < 1e-6)
})

test('THE 1000× SIZING ERROR, reproduced and then corrected', () => {
  // $10,000 balance, 1% risk, the real DOGEUSD stop distance.
  const table = computeRiskBasedVolume(10_000, 'DOGEUSD', 0.00256, 0.01, 0.0912)
  const broker = computeRiskBasedVolume(10_000, 'DOGEUSD', 0.00256, 0.01, 0.0912, null, 1000)
  assert.ok(table.volume / broker.volume > 900, `table sized ${table.volume}, broker ${broker.volume}`)
  // And the corrected figure actually respects the budget in REAL dollars:
  // volume × move-to-stop × broker units/lot ≤ $100.
  assert.ok(broker.volume * 0.00256 * 1000 <= 100 + 1e-9)
})

test('requiredMargin prices in the convention the order fills in', () => {
  const t = requiredMargin('DOGEUSD', 39, 0.0912, 100)
  const b = requiredMargin('DOGEUSD', 39, 0.0912, 100, null, 1000)
  assert.ok(Math.abs(b.notional / t.notional - 1000) < 1e-6)
})

// ---- the gate, end to end --------------------------------------------------

function fresh() {
  const db = initDB(':memory:')
  setState(db, 'account_balance_usd', '10000')
  setState(db, 'account_leverage', '100')
  setState(db, 'ctrader_account_id', 'A')
  return db
}
// A DOGEUSD proposal shaped like the real burn-in short, at the 3.05 floor.
const proposal = {
  symbol: 'DOGEUSD', side: 'SELL', entry: 0.0912, sl: 0.09376,
  tp1: 0.0912 - 3.05 * 0.00256, accountId: 'A', strategy: 'burnin',
}

test('WITH the registry, the gate sizes ~1000× smaller and says which source priced it', () => {
  const noReg = fresh()
  const withReg = fresh()
  rememberLotSize(withReg, 'DOGEUSD', 1000 * CENTS_PER_UNIT)
  const a = evaluateTrade(noReg, { ...proposal }, { ...DEFAULT_RISK_CONFIG })
  const b = evaluateTrade(withReg, { ...proposal }, { ...DEFAULT_RISK_CONFIG })
  assert.equal(a.checks?.units_per_lot?.source, 'table')
  assert.equal(b.checks?.units_per_lot?.source, 'broker')
  assert.equal(b.checks.units_per_lot.value, 1000)
  const va = a.checks?.risk_based_volume, vb = b.checks?.risk_based_volume
  assert.ok(va > 0 && vb > 0, `gate did not size: ${a.veto_reason} / ${b.veto_reason}`)
  assert.ok(va / vb > 900, `table sized ${va} lots, broker ${vb} — the 1000× must be gone`)
})

test('a symbol the registry has never seen prices from the table, unchanged', () => {
  const db = fresh()
  const r = evaluateTrade(db, {
    symbol: 'GBPUSD', side: 'BUY', entry: 1.25, sl: 1.245, tp1: 1.2675, accountId: 'A',
  }, { ...DEFAULT_RISK_CONFIG })
  assert.equal(r.checks?.units_per_lot?.source, 'table')
})
