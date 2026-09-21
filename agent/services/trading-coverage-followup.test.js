import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, getState, setState } from '../db.js'
import { probeOneSidecar } from './heartbeat.js'
import { upsertAccount } from './account-registry.js'
import { accountExecutionSim } from './tick-shadow-accounts.js'
import { controllerRuntimeView } from './controller-runtime.js'
import { tickTrialsView, importTickTrial } from './tick-research.js'
import { costsForClass, loadRepoSchedule, sizedCommissionUsdRoundTrip } from '../lib/tick-cost-schedule.js'
import { simulate, blockExpectancyLowerR, expectancyLowerR } from '../lib/tick-replay-sim.js'
import { LOT_SIZE_KEY } from '../lib/lot-size-registry.js'

const A = '1234'
function fixture(t) {
  const db = initDB(':memory:')
  t.after(() => db.close())
  upsertAccount(db, { accountId: A, isLive: false })
  db.prepare('UPDATE accounts SET enabled = 1 WHERE account_id = ?').run(A)
  setState(db, `acct:${A}:account_balance_usd`, '10000')
  setState(db, 'symbol_id_map', JSON.stringify({ EURUSD: 1, GBPUSD: 2 }))
  setState(db, LOT_SIZE_KEY, JSON.stringify({ EURUSD: { lotSize: 10000000, minVolume: 100000, stepVolume: 100000 } }))
  db.prepare(`INSERT INTO tick_shadow_trades (side, boot_id, seq, symbol_id, profile_hash, trade_side, entry, exit, stop, stop_distance, reason, gross_r, net_r, entry_ms, exit_ms, cost_class)
    VALUES ('cpp_exec_demo','b1',1,1,'p1','BUY',110000,110300,109900,100,'target',3,3,1000,2000,'fx')`).run()
  return db
}
const run = (db, extra = {}) => accountExecutionSim(db, { side: 'cpp_exec_demo', profilePrefix: 'p1', ...extra })
function intent(db, { id = 'i1', symbol = 'EURUSD', sid = 1, producer = 'tick_momentum', state = 'RESERVED' } = {}) {
  db.prepare(`INSERT INTO entry_intents (id,account_id,environment,symbol,symbol_id,side,order_type,volume,producer_id,basis,mode_epoch,permit_id,permit_expires_at,state)
    VALUES (?,?,'demo',?,?,'BUY','MARKET',0.1,?,'tick',1,?,datetime('now','+5 minutes'),?)`).run(id,A,symbol,sid,producer,id,state)
}

test('HK commissions convert HKD notional to USD and refuse missing conversion', () => {
  const row = costsForClass(loadRepoSchedule(), 'stock_hk')
  const args = { entryUsd: 100, exitUsd: 110, symbol: '0005.HK', rates: { USDHKD: 7.8 }, lots: 1, unitsPerLot: 500 }
  const fee = sizedCommissionUsdRoundTrip(row, 'stock_hk', args)
  assert.ok(Math.abs(fee.usd - (100 + 110) * 500 / 7.8 * row.commissionBpsPerSide / 10000) < 1e-10)
  assert.ok(Number.isNaN(sizedCommissionUsdRoundTrip(row, 'stock_hk', { ...args, rates: null }).usd))
})

test('standing reservations are capacity; a sent permit is exposure', t => {
  const db = fixture(t)
  intent(db)
  assert.equal(run(db).accounts[0].executed, 1)
  assert.equal(run(db).accounts[0].openIntentsNow, 0)
  db.prepare("UPDATE entry_intents SET state = 'SENT'").run()
  assert.deepEqual(run(db).accounts[0].refusals, { intent_open: 1 })
})

test('genuine pending orders on other symbols consume position capacity', t => {
  const db = fixture(t)
  setState(db, `acct:${A}:risk_config_json`, JSON.stringify({ maxOpenPositions: 1 }))
  intent(db, { symbol: 'GBPUSD', sid: 2, producer: 'copilot' })
  assert.deepEqual(run(db).accounts[0].refusals, { position_cap: 1 })
})

test('persisted scenarios reproduce results after balances, exposure and lot rules change', t => {
  const db = fixture(t)
  const first = run(db, { persist: true })
  assert.equal(first.scenario.historicalExecutionEvidence, false)
  const saved = db.prepare('SELECT * FROM tick_shadow_account_scenarios WHERE scenario_id = ?').get(first.scenario.id)
  const scenario = JSON.parse(saved.inputs_json)
  setState(db, `acct:${A}:account_balance_usd`, '1')
  setState(db, LOT_SIZE_KEY, '{}')
  intent(db, { state: 'UNKNOWN' })
  const repeat = run(db, { scenario })
  assert.deepEqual(repeat.accounts, first.accounts)
  assert.equal(repeat.scenario.id, first.scenario.id)
  const current = run(db, { persist: true })
  assert.notEqual(current.scenario.id, first.scenario.id)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tick_shadow_account_scenarios').get().n, 2)
  assert.equal(db.prepare('SELECT result_json FROM tick_shadow_account_scenarios WHERE scenario_id = ?').get(first.scenario.id).result_json, saved.result_json)
})

test('Controllers never call a refused account protected, even when its old audit checked zero', t => {
  const db = fixture(t)
  const nowMs = Date.now()
  setState(db, 'cpp_exec_demo_refused_accounts_json', JSON.stringify([A]))
  const a = controllerRuntimeView(db, { nowMs }).accounts.find(a => a.accountId === A)
  assert.equal(a.brokerAccess, 'TOKEN_REFUSED')
  assert.equal(a.protection.ok, false)
  assert.match(a.protection.summary, /cannot be verified/)
  assert.deepEqual(a.entryCounts, { unsent: 0, inFlight: 0, unknown: 0 })
})

test('heartbeat records explicit disabled tick status even without a health tick object', async t => {
  const db = fixture(t)
  const now = new Date()
  let pulls = 0
  await probeOneSidecar(db, {
    pingSidecar: async () => ({ ok: true, connected: true, lastReconcileAt: now.getTime(), tick: null }),
    sidecarTickStatus: async () => { pulls++; return { enabled: false } },
  }, { name: 'cpp_exec', base: 'http://test', isLive: true }, { now })
  assert.equal(pulls, 1)
  assert.deepEqual(JSON.parse(getState(db, 'cpp_exec_tick_json')).status, { enabled: false })
  assert.equal(controllerRuntimeView(db, { nowMs: now.getTime() }).sides[1].tickBlock, 'unavailable')
})

test('replay marks intra-trade drawdown even when the only close is a winner', () => {
  const ev = [100,100,111,105,120].map((bid, i) => ({ seq:i+1,recvMs:1000+i*100,bid,ask:bid+2,changed:true,snapshot:false,crossed:false }))
  const sig = { ...ev[0], side:'BUY',stopDistance:10 }
  const r = simulate(ev, {}, { latencyMs:0,targetR:10,minTargetToCost:0 }, { signalsOverride:[sig] })
  assert.equal(r.summary.maxDrawdownR, 0, 'closed-only drawdown misses the retracement')
  assert.equal(r.summary.markToMarketDrawdownR, 0.6)
  assert.equal(r.summary.drawdownBasis, 'closed_trades_only')
  assert.equal(r.summary.markToMarketBasis, 'executable_quotes_net_of_costs')
  assert.equal(r.trades[0].entryMs, 1100)
})

test('moving-block uncertainty is reproducible and preserves clustered outcomes', () => {
  const rs = [...Array(20).fill(1), ...Array(20).fill(-1)]
  const result = blockExpectancyLowerR(rs, { blockLength: 10 })
  assert.deepEqual(result, blockExpectancyLowerR(rs, { blockLength: 10 }))
  assert.ok(result.lowerR < expectancyLowerR(rs), 'clustering widens uncertainty in this fixture')
  assert.equal(blockExpectancyLowerR([1]).lowerR, null)
})

test('empty replay identifies warm-up and purge capacity, without lowering thresholds', t => {
  const db = fixture(t)
  const ev = Array.from({length:100}, (_,i) => ({ seq:i+1,recvMs:i*100,bid:100,ask:102,changed:true,snapshot:false,crossed:false }))
  const r = simulate(ev, { rangeEvents:1024, momentumEvents:256 })
  assert.equal(r.summary.diagnostics.outcome, 'insufficient_warmup')
  assert.equal(r.summary.diagnostics.warmupPriorEvents, 1025, 'actual oracle window, not N + M')
  assert.equal(r.blocks[1].eligibleEntryEvents, 0)
  importTickTrial(db, { ...r, manifest:{events:100} })
  const view = tickTrialsView(db)
  assert.equal(view.emptyTrials, 1)
  assert.equal(view.trials[0].evidenceState, 'EMPTY')
  assert.deepEqual(view.trials[0].matchingShadow, [])
  assert.match(view.trials[0].shadowAttribution, /cannot corroborate/)
})
