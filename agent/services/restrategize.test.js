// node --test agent/services/restrategize.test.js
//
// Post-tamper re-strategize: level recalibration math, risk audit, and the
// per-kind behaviour (reversal amends fresh SL/TP; volume syncs the ledger
// and audits risk; owner-moved levels are respected and only audited).

import test from 'node:test'
import assert from 'node:assert/strict'
import { initDB, setState } from '../db.js'
import { recalibrateLevels, auditRisk, restrategizeAfterTamper, summarize } from './restrategize.js'

function seed(db, { positionId = '42', accountId = '11', monitorAccountId = accountId, side = 'long', entry = 100, sl = 99, tp = 102, lots = 0.1 } = {}) {
  const tradeId = db.prepare(
    `INSERT INTO trades (symbol, side, entry_price, volume, ctrader_position_id, account_id, source, status, opened_at)
     VALUES ('XAUUSD', ?, ?, ?, ?, ?, 'autopilot', 'open', datetime('now'))`
  ).run(side === 'long' ? 'BUY' : 'SELL', entry, lots, positionId, accountId).lastInsertRowid
  db.prepare(
    `INSERT INTO monitored_positions (symbol, trade_id, account_id, side, entry_price, current_sl, current_tp, thesis, source, status)
     VALUES ('XAUUSD', ?, ?, ?, ?, ?, ?, 'test', 'autopilot', 'active')`
  ).run(tradeId, monitorAccountId, side, entry, sl, tp)
  return tradeId
}

// Rising 1h series: close climbs 1 per bar → momentum positive, ATR ≈ 1.
const risingBars = Array.from({ length: 40 }, (_, i) => ({ o: 100 + i, h: 101 + i, l: 99.5 + i, c: 100.5 + i, v: 10 }))

test('recalibrateLevels: 1×ATR stop, minRR reward, direction-aware', () => {
  const long = recalibrateLevels({ side: 'long', price: 100, atr: 2, rr: 1.5 })
  assert.deepEqual(long, { sl: 98, tp: 103, slDist: 2 })
  const short = recalibrateLevels({ side: 'short', price: 100, atr: 2, rr: 1.5 })
  assert.deepEqual(short, { sl: 102, tp: 97, slDist: 2 })
  // ATR unknown → minSlPct floor keeps a real stop
  const floor = recalibrateLevels({ side: 'long', price: 100, atr: null, minSlPct: 0.001, rr: 1.5 })
  assert.equal(floor.slDist, 0.1)
  assert.equal(recalibrateLevels({ side: 'long', price: 0, atr: 1 }), null)
})

test('auditRisk flags over-cap risk, missing SL, and thin R:R', () => {
  const riskCfg = { perTradeRiskPct: 0.01, minRR: 1.5 }
  // XAUUSD ~100 lots-per-unit contract: use a generic symbol so usdLossPerLot
  // resolves via its default path — issues list is what we assert on.
  const bad = auditRisk({ symbol: 'EURUSD', side: 'long', entry: 1.1, sl: null, tp: 1.2, lots: 1, balance: 1000, riskCfg })
  assert.ok(bad.issues.some(i => /NO stop loss/.test(i)))
  const thin = auditRisk({ symbol: 'EURUSD', side: 'long', entry: 1.1, sl: 1.09, tp: 1.105, lots: 0.01, balance: 100000, riskCfg })
  assert.ok(thin.issues.some(i => /R:R/.test(i)))
  assert.equal(thin.rr, 0.5)
})

test('reversal → fresh SL/TP amended at the broker and persisted, momentum verdict included', async () => {
  const db = initDB(':memory:')
  seed(db, { side: 'long' }) // owner reversed TO long; market is rising → aligned
  const amends = []
  const out = await restrategizeAfterTamper(db, { host: 'h', accountId: '11' }, { kind: 'reversed', symbol: 'XAUUSD', positionId: '42', from: 'short', to: 'long' }, {
    fetchBars: async () => risingBars,
    amend: async (_c, args) => { amends.push(args); return { ok: true } },
  })
  assert.equal(out.did, 'recalibrated')
  assert.equal(out.aligned, true)
  assert.equal(amends.length, 1)
  assert.equal(amends[0].positionId, '42')
  assert.ok(amends[0].stopLoss < 139.5 && amends[0].stopLoss > 130) // below last close ~139.5
  assert.ok(amends[0].takeProfit > 139.5)
  const row = db.prepare('SELECT * FROM monitored_positions').get()
  assert.equal(row.current_sl, amends[0].stopLoss)
  assert.equal(row.current_tp, amends[0].takeProfit)
  assert.match(row.thesis, /recalibrated/)
})

test('reversal with recalibration disabled → verdict only, no amend', async () => {
  const db = initDB(':memory:')
  seed(db, { side: 'short' }) // reversed to short while market rises → NOT aligned
  setState(db, 'tamper_restrategize', 'false')
  const amends = []
  const out = await restrategizeAfterTamper(db, { host: 'h', accountId: '11' }, { kind: 'reversed', symbol: 'XAUUSD', positionId: '42', from: 'long', to: 'short' }, {
    fetchBars: async () => risingBars,
    amend: async (_c, args) => { amends.push(args) },
  })
  assert.equal(out.did, 'verified_only')
  assert.equal(out.aligned, false)
  assert.ok(out.proposed.sl > 139.5) // short: SL above price
  assert.equal(amends.length, 0)
  assert.match(summarize(out), /not applied/)
})

test('volume change → trades.volume synced by ratio and risk audited', async () => {
  const db = initDB(':memory:')
  const tradeId = seed(db, { lots: 0.1 })
  setState(db, 'account_balance_usd', '10000')
  const out = await restrategizeAfterTamper(db, { host: 'h', accountId: '11' }, { kind: 'volume', symbol: 'XAUUSD', positionId: '42', from: 10, to: 50 })
  assert.equal(out.did, 'risk_audit')
  assert.equal(out.lots, 0.5) // 0.1 × (50/10)
  assert.equal(db.prepare('SELECT volume FROM trades WHERE id = ?').get(tradeId).volume, 0.5)
})

test('owner-moved SL/TP → audit only, never amends', async () => {
  const db = initDB(':memory:')
  seed(db)
  const amends = []
  const out = await restrategizeAfterTamper(db, { host: 'h', accountId: '11' }, { kind: 'sl_moved', symbol: 'XAUUSD', positionId: '42', from: 99, to: 95 }, {
    amend: async () => { amends.push(1) },
  })
  assert.equal(out.did, 'risk_audit')
  assert.equal(amends.length, 0)
})

test('summarize renders momentum disagreement and risk issues', () => {
  assert.match(summarize({ did: 'recalibrated', aligned: false, sl: 1, tp: 2, issues: [] }), /does NOT support/)
  assert.match(summarize({ did: 'risk_audit', riskUsd: 50, capUsd: 10, rr: 2, issues: ['risk $50 exceeds your 1.0% cap ($10)'] }), /exceeds/)
  assert.match(summarize({ did: 'risk_audit', riskUsd: 5, capUsd: 10, rr: 2, issues: [] }), /Within your risk limits/)
})

test('same broker position ID on two accounts changes only the supplied account and uses its risk inputs', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const a = seed(db, { accountId: '11', lots: 0.1 })
  const b = seed(db, { accountId: '22', lots: 0.2 })
  setState(db, 'ctrader_account_id', '11')
  setState(db, 'account_balance_usd', '100000')
  setState(db, 'acct:11:account_balance_usd', '100000')
  setState(db, 'acct:22:account_balance_usd', '1000')
  setState(db, 'acct:22:risk_config_json', JSON.stringify({ perTradeRiskPct: 0.01 }))
  const out = await restrategizeAfterTamper(db, { accountId: '22' }, { kind: 'volume', positionId: '42', from: 10, to: 20 })
  assert.equal(out.did, 'risk_audit')
  assert.equal(out.capUsd, 10)
  assert.equal(out.lots, 0.4)
  assert.equal(db.prepare('SELECT volume FROM trades WHERE id = ?').get(a).volume, 0.1)
  assert.equal(db.prepare('SELECT volume FROM trades WHERE id = ?').get(b).volume, 0.4)
})

test('scoped reversal preserves the other account, and manual level moves still never amend', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  const a = seed(db, { accountId: '11', side: 'short', sl: 101, tp: 98 })
  const b = seed(db, { accountId: '22', side: 'long' })
  const amends = []
  const deps = { fetchBars: async () => risingBars, amend: async (creds, args) => { amends.push({ creds, args }) } }
  const change = { kind: 'reversed', positionId: '42' }
  const out = await restrategizeAfterTamper(db, { accountId: '22' }, change, deps)
  assert.equal(out.did, 'recalibrated')
  assert.equal(amends.length, 1)
  assert.equal(amends[0].creds.accountId, '22')
  assert.equal(db.prepare('SELECT current_sl FROM monitored_positions WHERE trade_id = ?').get(a).current_sl, 101)
  assert.equal(db.prepare('SELECT current_sl FROM monitored_positions WHERE trade_id = ?').get(b).current_sl, out.sl)
  for (const kind of ['sl_moved', 'tp_moved']) {
    const audit = await restrategizeAfterTamper(db, { accountId: '22' }, { ...change, kind }, deps)
    assert.equal(audit.did, 'risk_audit')
    assert.equal(audit.capUsd, null)
    assert.match(summarize(audit), /incomplete/)
  }
  assert.equal(amends.length, 1)
})

test('unowned, foreign, contradictory and duplicate identity evidence never authorises work', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  seed(db, { accountId: null, positionId: 'unknown' })
  seed(db, { accountId: '11', monitorAccountId: '22', positionId: 'conflict' })
  const duplicate = seed(db, { accountId: '11', positionId: 'duplicate' })
  db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, account_id, side, entry_price, status)
    VALUES ('XAUUSD', ?, '11', 'long', 100, 'active')`).run(duplicate)
  let calls = 0
  const deps = { fetchBars: async () => { calls++; return risingBars }, amend: async () => { calls++ } }
  for (const [creds, positionId, reason] of [
    [{}, 'duplicate', 'account_required'],
    [{ accountId: '11' }, 'unknown', 'position_not_found'],
    [{ accountId: '11' }, 'conflict', 'position_not_found'],
    [{ accountId: '33' }, 'duplicate', 'position_not_found'],
    [{ accountId: '11' }, 'duplicate', 'position_identity_ambiguous'],
  ]) {
    const out = await restrategizeAfterTamper(db, creds, { kind: 'reversed', positionId }, deps)
    assert.equal(out.did, 'skipped')
    assert.equal(out.reason, reason)
    assert.match(summarize(out), /skipped/)
  }
  assert.equal(calls, 0)
})

test('one uncontradicted account stamp identifies a legacy linked row without claiming NULL ownership', async t => {
  const db = initDB(':memory:'); t.after(() => db.close())
  seed(db, { accountId: '11', monitorAccountId: null, positionId: 'trade-owned' })
  seed(db, { accountId: null, monitorAccountId: '11', positionId: 'monitor-owned' })
  for (const positionId of ['trade-owned', 'monitor-owned']) {
    const out = await restrategizeAfterTamper(db, { accountId: '11' }, { kind: 'sl_moved', positionId })
    assert.equal(out.did, 'risk_audit')
  }
})

test('V3 M5: the recalibration amend is timed in the amend-latency ring; a thrown amend is recorded and still reported', async () => {
  const { _resetAmendLatencyForTests, _amendLatencyStateForTests } = await import('./protection-latency.js')
  _resetAmendLatencyForTests()
  const change = { kind: 'reversed', symbol: 'XAUUSD', positionId: '42', from: 'short', to: 'long' }
  const db = initDB(':memory:')
  seed(db, { side: 'long' })
  const ok = await restrategizeAfterTamper(db, { host: 'h', accountId: '11' }, change, {
    fetchBars: async () => risingBars, amend: async () => ({ ok: true }),
  })
  assert.equal(ok.did, 'recalibrated')
  const db2 = initDB(':memory:')
  seed(db2, { side: 'long' })
  const bad = await restrategizeAfterTamper(db2, { host: 'h', accountId: '11' }, change, {
    fetchBars: async () => risingBars, amend: async () => { throw new Error('amend timed out after 15000 ms') },
  })
  assert.equal(bad.did, 'error', 'the caller still sees the failure')
  const got = _amendLatencyStateForTests().amends.map(e => [e.path, e.source, e.positionId, e.account, e.outcome])
  assert.deepEqual(got, [['restrategize', 'restrategize', '42', '…11', 'ok'], ['restrategize', 'restrategize', '42', '…11', 'timeout']])
})
