import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { initDB } from '../db.js'
import { prepareMomentumTargetProposal } from './momentum-target-proposal.js'
import { recordMomentumEntry, readMomentumEntry, bindMomentumEntry } from './momentum-entry-contract.js'
import { planMomentumTargets } from './momentum-target-policy.js'
import { bookEntryWrite } from './book-entry-write.js'
import { readPartialPlan } from './momentum-partial-manager.js'

const now = 1790264000000
const identity = { provider: 'ctrader', host: 'demo.ctraderapi.com', accountId: '11', symbolId: '22' }
const schedule = JSON.parse(readFileSync(new URL('../config/tick-shadow-sim.json', import.meta.url)))
const proposal = prepareMomentumTargetProposal({ identity, symbol: 'ETHUSD', side: 'BUY', entry: 100, originalStop: 90,
  volume: 10000, requiredRr: 3, nowMs: now, maxAgeMs: 5000, carryingCostReservePrice: 0.3,
  quote: { ...identity, bid: 99.9, ask: 100, observedAtMs: now, receivedAtMs: now, source: 'broker_spot' },
  symbolMeta: { ...identity, lotSize: 100, minVolume: 100, stepVolume: 100, digits: 2, quoteAsset: 'USD', receivedAtMs: now, source: 'broker_symbol' },
  conversion: { quoteAsset: 'USD', quoteUsdRate: 1, source: 'usd_identity' },
}, schedule)
function fixture(t, p = proposal, path = ':memory:') {
  const db = initDB(path); t.after(() => { if (db.open) db.close() })
  db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume)
    VALUES(7,'ETHUSD',?,'submitting','11','bot_market_dispatch',1,?,?,?,?)`)
    .run(p.plan.side, p.plan.entry, p.plan.originalStop, p.plan.brokerTarget, p.plan.volume / p.evidence.symbolMeta.lotSize)
  return db
}
function fill(patch = {}) {
  return { ...identity, positionId: '33', side: 'BUY', entry: 101, volume: 10000,
    stopLoss: 91, takeProfit: proposal.plan.brokerTarget + 1, observedAtMs: now, source: 'broker_reconcile', ...patch }
}

test('immutable target intent belongs to the existing submitting trade before a broker call', t => {
  const db = fixture(t)
  recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal, nowMs: now })
  const saved = readMomentumEntry(db, '11', 7)
  assert.equal(saved.state, 'PREPARED'); assert.equal(saved.proposal.evidenceId, proposal.evidenceId)
  assert.deepEqual(recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal, nowMs: now }), saved)
  assert.throws(() => recordMomentumEntry(db, { accountId: '12', tradeId: 7, proposal, nowMs: now }), /identity/)
  assert.throws(() => recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal: { ...proposal, evidenceId: 'changed' }, nowMs: now }), /evidence/)
})

test('confirmed fill shifts the original bracket without changing the retained risk or cost reserve', t => {
  const db = fixture(t)
  recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal, nowMs: now })
  const result = bindMomentumEntry(db, { accountId: '11', tradeId: 7, position: fill(), nowMs: now })
  assert.equal(result.state, 'BOUND'); assert.equal(result.plan.entry, 101)
  assert.equal(result.plan.initialRisk, 10); assert.equal(result.plan.originalStop, 91)
  assert.equal(result.plan.costReservePrice, proposal.plan.costReservePrice)
  assert.equal(result.plan.brokerTarget, proposal.plan.brokerTarget + 1)
})

test('foreign, stale, changed-volume and unprotected fills never enroll a manager', t => {
  for (const patch of [{ accountId: '12' }, { host: 'live.ctraderapi.com' }, { symbolId: '23' },
    { observedAtMs: now - 5001 }, { observedAtMs: now + 1 }, { volume: 9000 }, { stopLoss: 89 },
    { takeProfit: null }, { source: 'local_cache' }, { side: 'SELL' }]) {
    const db = fixture(t)
    recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal, nowMs: now })
    assert.throws(() => bindMomentumEntry(db, { accountId: '11', tradeId: 7, position: fill(patch), nowMs: now }), /fill/)
    assert.equal(readMomentumEntry(db, '11', 7).state, 'PREPARED')
  }
})

test('book handover and enrollment commit together, and a failure rolls both back', async t => {
  for (const sabotage of [false, true]) {
    const db = fixture(t)
    recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal, nowMs: now })
    const bound = bindMomentumEntry(db, { accountId: '11', tradeId: 7, position: fill(), nowMs: now })
    db.prepare("UPDATE trades SET status='open',ctrader_position_id='33',entry_price=101,sl_price=91,tp_price=?,label_strategy='tsmom_long' WHERE id=7").run(bound.plan.brokerTarget)
    db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,initial_risk,current_sl,current_tp,account_id,strategy)
      VALUES('ETHUSD',7,'long',101,10,91,?,'11','tsmom_long')`).run(bound.plan.brokerTarget)
    if (sabotage) db.prepare("UPDATE monitored_positions SET guard_json='{}' WHERE trade_id=7").run()
    const handover = () => bookEntryWrite(db, { accountId: '11', row: { tradeId: 7, symbol: 'ETHUSD', positionId: '33',
      side: 'long', entry: 101, stop: 91, enteredAt: new Date(now).toISOString() } })
    if (sabotage) {
      assert.throws(handover, /ownership/)
      assert.equal(db.prepare('SELECT count(*) n FROM momentum_book').get().n, 0)
      assert.equal(db.prepare('SELECT paused FROM monitored_positions WHERE trade_id=7').get().paused, 0)
      assert.equal(readMomentumEntry(db, '11', 7).state, 'BOUND')
    } else {
      const result = handover()
      assert.equal(result.targetPolicy, 'partial_runner')
      assert.equal(readMomentumEntry(db, '11', 7).state, 'ENROLLED')
      const managed = readPartialPlan(db, '11', 7)
      assert.equal(managed.state, 'ARMED'); assert.deepEqual(managed.plan, bound.plan)
      assert.deepEqual(managed.identity, identity)
    }
  }
})

function readyBook(db, p, position) {
  recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal: p, nowMs: now })
  const bound = bindMomentumEntry(db, { accountId: '11', tradeId: 7, position, nowMs: now })
  db.prepare("UPDATE trades SET status='open',ctrader_position_id='33',entry_price=?,sl_price=?,tp_price=?,label_strategy='tsmom_long' WHERE id=7")
    .run(bound.plan.entry, bound.plan.originalStop, bound.plan.brokerTarget)
  db.prepare(`INSERT INTO monitored_positions(symbol,trade_id,side,entry_price,initial_risk,current_sl,current_tp,account_id,strategy)
    VALUES('ETHUSD',7,?,?,?,?,?, '11','tsmom_long')`).run(p.plan.side === 'BUY' ? 'long' : 'short', bound.plan.entry, bound.plan.initialRisk, bound.plan.originalStop, bound.plan.brokerTarget)
  return () => bookEntryWrite(db, { accountId: '11', row: { tradeId: 7, symbol: 'ETHUSD', positionId: '33',
    side: p.plan.side === 'BUY' ? 'long' : 'short', entry: bound.plan.entry, stop: bound.plan.originalStop, enteredAt: new Date(now).toISOString() } })
}

test('a minimum-volume plan keeps its native target and never creates a partial manager', t => {
  const plan = planMomentumTargets({ ...proposal.plan, volume: 100 })
  const evidence = { ...proposal.evidence, plan }
  const p = { ...proposal, plan, evidence, evidenceId: createHash('sha256').update(JSON.stringify(evidence)).digest('hex') }
  assert.equal(plan.mode, 'whole_position_minimum')
  const db = fixture(t, p)
  const handover = readyBook(db, p, fill({ volume: 100, takeProfit: plan.brokerTarget + 1 }))
  assert.equal(handover().targetPolicy, 'whole_position_minimum')
  assert.equal(readMomentumEntry(db, '11', 7).state, 'ENROLLED')
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='momentum_partial_plans'").get().n, 0)
  assert.equal(db.prepare('SELECT current_tp FROM monitored_positions WHERE trade_id=7').get().current_tp, plan.brokerTarget + 1)
})

test('a file-backed restart preserves the prepared intent and the enrolled plan without duplicate handover', t => {
  const dir = mkdtempSync(join(tmpdir(), 'momentum-entry-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'agent.db')
  let db = fixture(t, proposal, path)
  recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal, nowMs: now })
  db.close(); db = initDB(path); t.after(() => { if (db.open) db.close() })
  assert.equal(readMomentumEntry(db, '11', 7).state, 'PREPARED')
  const handover = readyBook(db, proposal, fill())
  handover()
  const saved = readPartialPlan(db, '11', 7)
  assert.throws(handover, /bound plan/)
  assert.equal(db.prepare('SELECT count(*) n FROM momentum_book').get().n, 1)
  db.close(); db = initDB(path); t.after(() => { if (db.open) db.close() })
  assert.equal(readMomentumEntry(db, '11', 7).state, 'ENROLLED')
  assert.deepEqual(readPartialPlan(db, '11', 7), saved)
})

test('a different risk lifecycle cannot acquire the previously bound partial plan', t => {
  const db = fixture(t)
  const handover = readyBook(db, proposal, fill())
  db.prepare('UPDATE trades SET risk_event_id=2 WHERE id=7').run()
  assert.throws(handover, /lifecycle/)
  assert.equal(readMomentumEntry(db, '11', 7).state, 'BOUND')
  assert.equal(db.prepare('SELECT count(*) n FROM momentum_book').get().n, 0)
})

test('stale pre-submit prices and fractional broker units cannot become a durable entry plan', t => {
  const db = fixture(t)
  assert.throws(() => recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal, nowMs: now + 5001 }), /fresh/)
  assert.equal(readMomentumEntry(db, '11', 7), null)
  db.prepare('UPDATE trades SET volume=100.004 WHERE id=7').run()
  assert.throws(() => recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal, nowMs: now }), /bracket/)
  assert.equal(readMomentumEntry(db, '11', 7), null)
})

test('a failed mandatory plan write rolls back the newly created submitting trade', t => {
  const db = fixture(t)
  db.prepare('DELETE FROM trades WHERE id=7').run()
  assert.throws(db.transaction(() => {
    db.prepare(`INSERT INTO trades(id,symbol,side,status,account_id,origin,risk_event_id,entry_price,sl_price,tp_price,volume)
      VALUES(7,'ETHUSD','BUY','submitting','11','bot_market_dispatch',1,100,90,?,100)`).run(proposal.plan.brokerTarget)
    recordMomentumEntry(db, { accountId: '11', tradeId: 7, proposal: { ...proposal, evidenceId: 'damaged' }, nowMs: now })
  }), /evidence/)
  assert.equal(db.prepare('SELECT count(*) n FROM trades WHERE id=7').get().n, 0)
})

test('BUY and SELL fills enroll the same policy on either broker environment', t => {
  for (const host of ['demo.ctraderapi.com', 'live.ctraderapi.com']) {
    for (const side of ['BUY', 'SELL']) {
      const scoped = { ...identity, host }
      const p = prepareMomentumTargetProposal({ identity: scoped, symbol: 'ETHUSD', side, entry: 100,
        originalStop: side === 'BUY' ? 90 : 110, volume: 10000, requiredRr: 3, nowMs: now, maxAgeMs: 5000, carryingCostReservePrice: 0.3,
        quote: { ...scoped, bid: side === 'BUY' ? 99.9 : 100, ask: side === 'BUY' ? 100 : 100.1,
          observedAtMs: now, receivedAtMs: now, source: 'broker_spot' },
        symbolMeta: { ...scoped, ...proposal.evidence.symbolMeta, source: 'broker_symbol' },
        conversion: { quoteAsset: 'USD', quoteUsdRate: 1, source: 'usd_identity' } }, schedule)
      assert.equal(p.ok, true)
      const db = fixture(t, p)
      readyBook(db, p, fill({ ...scoped, side, stopLoss: p.plan.originalStop + 1, takeProfit: p.plan.brokerTarget + 1 }))()
      const stored = readPartialPlan(db, '11', 7)
      assert.equal(stored.state, 'ARMED'); assert.equal(stored.plan.side, side)
      assert.equal(stored.identity.host, host); assert.equal(stored.plan.initialRisk, 10)
    }
  }
})
