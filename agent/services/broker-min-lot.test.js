// ---------------------------------------------------------------------------
// agent/services/broker-min-lot.test.js — the risk gate sizes against the
// BROKER's minimum lot for the symbol, not a global assumption.
//
// THE MEASUREMENT THIS EXISTS FOR (production /health, 17-09-2026 08:57 UTC):
//
//   7 order(s)/trade(s) from 17 approval(s) (11 refused downstream, each with
//   a reason) · topVetoes: below_min_volume n=10, spread_too_wide n=1
//
// Ten of seventeen approvals died AFTER approval because the executor fetched
// the broker's real minimum and found the approved size below it. The gate had
// sized against `config.minLotSize` — a global default of 0.01 — while the
// line that applied it was commented "Never ship below broker minimum".
//
// The broker's answer was available the whole time: `getVolumeMeta` returns
// `minVolume` on every order and the order path recorded only `lotSize`.
// ---------------------------------------------------------------------------

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { initDB, setState } from '../db.js'
import { evaluateTrade } from './risk.js'
import { rememberVolumeMeta } from '../lib/lot-size-registry.js'
import { MOMENTUM_ACCOUNT_KEY } from './momentum-account.js'
import { TSMOM_STRATEGY } from './momentum-book.js'

const MOM = '46979908'

function fresh({ balance = '100000' } = {}) {
  const db = initDB(':memory:')
  db.prepare(`INSERT INTO accounts (account_id, trader_login, is_live, enabled, mode) VALUES ('${MOM}','3',0,1,'active')`).run()
  setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify({ accountId: MOM, volTargetPct: 10, maxPositions: 8, cadence: 'daily', dailyRunAfterUtc: '21:05' }))
  if (balance != null) setState(db, `acct:${MOM}:account_balance_usd`, balance)
  return db
}

// BTCUSD: 1 lot = 1 BTC, so protocol lotSize is 100 (cents of units).
// minVolume 100 → the broker's smallest order is ONE whole lot.
const ONE_LOT = { lotSize: 100, minVolume: 100, stepVolume: 100, digits: 2 }

// The vol-target path on the momentum account lets the test name the sized
// volume outright, so the min-lot comparison is exercised without having to
// reverse-engineer a balance that produces a particular fraction of a lot.
const proposal = (extra = {}) => ({
  symbol: 'BTCUSD', side: 'long', entry: 77_000, sl: 72_380, tp1: null, requestedVolume: null,
  strategy: TSMOM_STRATEGY, conviction: 8, source: 'momentum_account', accountId: MOM,
  sizing: 'vol_target', sizedVolume: 0.5, ...extra,
})

test('a size below the BROKER minimum is refused at the gate, not approved and refused at the transport', () => {
  const db = fresh()
  rememberVolumeMeta(db, 'BTCUSD', ONE_LOT)
  const r = evaluateTrade(db, proposal({ sizedVolume: 0.5 }))
  assert.equal(r.approved, false, 'half a lot cannot be sent when the broker will not accept less than one')
  assert.match(r.veto_reason, /insufficient_equity min_lot=1 \(broker\)/,
    'and the reason names the broker as the source, so nobody reads it as a config choice')
})

test('the same size is approved when the broker has never described the symbol — unknown is not a block', () => {
  // The fallback is today's exact behaviour. A symbol the broker has not
  // described must keep dispatching as before; this change refuses on
  // KNOWLEDGE, never on the absence of it.
  const db = fresh()
  const r = evaluateTrade(db, proposal({ sizedVolume: 0.5 }))
  assert.equal(r.approved, true, `veto: ${r.veto_reason}`)
  assert.equal(r.checks.broker_min_lots, undefined, 'nothing is claimed about a minimum we were never told')
})

test('a size at or above the broker minimum is approved, and the minimum is recorded on the verdict', () => {
  const db = fresh()
  rememberVolumeMeta(db, 'BTCUSD', ONE_LOT)
  const r = evaluateTrade(db, proposal({ sizedVolume: 1 }))
  assert.equal(r.approved, true, `veto: ${r.veto_reason}`)
  assert.equal(r.checks.broker_min_lots, 1, 'the verdict carries what it judged against')
})

test('a legacy registry entry (lot size only) does not manufacture a minimum', () => {
  // Every deployed database holds bare-number entries written before the
  // minimum was recorded. Reading one as a minimum would refuse real trades.
  const db = fresh()
  setState(db, 'broker_lot_size_json', JSON.stringify({ BTCUSD: 100 }))
  const r = evaluateTrade(db, proposal({ sizedVolume: 0.5 }))
  assert.equal(r.approved, true, `veto: ${r.veto_reason}`)
  assert.equal(r.checks.broker_min_lots, undefined)
})

test('WITHOUT A BALANCE the floor does not rise to the broker minimum — that would increase risk', () => {
  // THE ONE THING THIS CHANGE DELIBERATELY DOES NOT DO. With a balance, the
  // insufficient_equity check above has already proved the per-trade budget
  // covers the broker's minimum, so flooring there spends at most the budget.
  // With no balance no budget was computed and nothing is proved, so raising a
  // position to a larger broker minimum would be risking an unvalidated
  // amount. The floor stays at the configured assumption exactly as before.
  const db = fresh({ balance: null })
  rememberVolumeMeta(db, 'BTCUSD', ONE_LOT)
  const r = evaluateTrade(db, proposal({ sizedVolume: 0.02 }))
  if (r.approved) {
    assert.ok(r.adjusted_volume < 1,
      'the position was NOT inflated to the broker minimum on an unvalidated budget')
  }
})

test('both write sites feed the registry the FULL broker meta, not just the lot size', () => {
  // WITHOUT THIS PIN the gate tests above stay green forever on a registry
  // nothing fills — the exact shape of "a repair that nothing calls"
  // (CLAUDE.md #4). Two sites must record it:
  //   · the order path, which holds meta for a symbol the account has traded
  //   · the daily fundable-universe build, which asks for every watchlist name
  //     and is therefore the only way a symbol is known BEFORE its first order
  const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  const loop = strip(readFileSync(new URL('../loop.js', import.meta.url), 'utf8'))
  const fundable = strip(readFileSync(new URL('./fundable-universe.js', import.meta.url), 'utf8'))

  assert.match(loop, /rememberVolumeMeta\(db, symbol, meta\)/,
    'the order path records the whole declaration, minimum included')
  assert.doesNotMatch(loop, /rememberLotSize\(db, symbol, meta\.lotSize\)/,
    'and no longer records the lot size alone, which is what discarded the minimum')
  assert.match(fundable, /rememberVolumeMeta\(db, symbol, meta\)/,
    'the daily build teaches the registry the whole watchlist')
})

test('the gate judges against the broker minimum at every refusal that names a min lot', () => {
  // The margin-shrink refusals compared a shrunk size against the same global
  // assumption. Leaving them behind would let a position shrink to 0.02 lots,
  // pass a 0.01 assumption, and be refused at the transport for the same
  // reason as before — the defect surviving in three places out of four.
  const risk = readFileSync(new URL('./risk.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  assert.equal((risk.match(/shrunk < effMinLots/g) || []).length, 3,
    'all three margin-shrink refusals read the broker minimum')
  assert.doesNotMatch(risk, /shrunk < config\.minLotSize/,
    'and none of them still reads the global assumption')
})
