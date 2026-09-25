import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerPartialPlan, runPartialPlan, readPartialPlan } from './momentum-partial-manager.js'
import { planMomentumTargets } from './momentum-target-policy.js'

const plan = planMomentumTargets({ side: 'BUY', entry: 100, originalStop: 90, requiredRr: 3,
  costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 })
const at = 1790264000000
function setup(t, accountId = '11') {
  const db = new Database(':memory:')
  t.after(() => db.close())
  registerPartialPlan(db, { accountId, tradeId: 7, positionId: '123', plan, evidenceId: 'fixture:7', identity: { host: 'demo.ctraderapi.com', accountId, symbolId: '22' } })
  let volume = 10000, calls = 0
  const deps = {
    now: () => at, maxAgeMs: 5000,
    readOwnership: () => owner(accountId),
    readPosition: async () => ({ accountId, positionId: '123', side: 'BUY', entry: 100, volume,
      stopLoss: 95, takeProfit: 140.4, observedAtMs: at }),
    quote: async () => ({ accountId, positionId: '123', bid: 130.4, ask: 130.6, observedAtMs: at }),
    close: async (_creds, order) => { calls++; volume -= order.volume; return {
      accountId, positionId: '123', dealId: '999', closedVolume: order.volume, price: 130.4, executedAtMs: deps.now(),
    } },
  }
  return { db, deps, creds: { accountId, host: 'demo.ctraderapi.com' }, calls: () => calls }
}

test('partial confirms a matching broker receipt and residual volume, once across repeated passes', async t => {
  const f = setup(t)
  const result = await runPartialPlan(f.db, f.creds, 7, f.deps)
  assert.equal(result.state, 'CONFIRMED')
  assert.equal(readPartialPlan(f.db, '11', 7).receipt.dealId, '999')
  await runPartialPlan(f.db, f.creds, 7, f.deps)
  assert.equal(f.calls(), 1)
})

test('concurrent passes share a durable claim and cannot both close', async t => {
  const f = setup(t)
  await Promise.all([runPartialPlan(f.db, f.creds, 7, f.deps), runPartialPlan(f.db, f.creds, 7, f.deps)])
  assert.equal(f.calls(), 1)
})

test('timeout leaves an ambiguous durable attempt and never retries the close', async t => {
  const f = setup(t)
  let calls = 0
  f.deps.close = async () => { calls++; throw Error('timeout after possible fill') }
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'AMBIGUOUS')
  await runPartialPlan(f.db, f.creds, 7, f.deps)
  assert.equal(calls, 1)
})

test('foreign, stale, changed-volume and missing broker target observations never send', async t => {
  for (const patch of [{ accountId: '12' }, { observedAtMs: at - 5001 }, { volume: 9000 },
    { takeProfit: null }, { stopLoss: 89 }, { side: 'SELL' }, { entry: 101 }]) {
    const f = setup(t)
    const read = f.deps.readPosition
    f.deps.readPosition = async () => ({ ...await read(), ...patch })
    await runPartialPlan(f.db, f.creds, 7, f.deps)
    assert.equal(f.calls(), 0, JSON.stringify(patch))
  }
})

test('wrong-account receipt or wrong residual cannot be stamped confirmed', async t => {
  for (const patch of [{ accountId: '12' }, { closedVolume: 2700 }, { dealId: null }]) {
    const f = setup(t), close = f.deps.close
    f.deps.close = async (...args) => ({ ...await close(...args), ...patch })
    assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'AMBIGUOUS')
  }
  const f = setup(t)
  f.deps.close = async () => ({ accountId: '11', positionId: '123', dealId: '999', closedVolume: 2600, price: 130.4, executedAtMs: at })
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'RECEIVED')
})

test('stored receipt permits readback recovery without a second broker close', async t => {
  const f = setup(t), read = f.deps.readPosition
  let reads = 0
  f.deps.readPosition = async () => { if (++reads === 2) throw Error('readback unavailable'); return read() }
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'RECEIVED')
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'CONFIRMED')
  assert.equal(f.calls(), 1)
})

test('freshness is measured when each awaited read completes, with quote identity checked', async t => {
  const f = setup(t), read = f.deps.readPosition, quote = f.deps.quote
  let now = at
  f.deps.now = () => now
  f.deps.readPosition = async () => { now += 100; return { ...await read(), observedAtMs: now } }
  f.deps.quote = async () => ({ ...await quote(), observedAtMs: now })
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'CONFIRMED')
  const g = setup(t), wrongQuote = g.deps.quote
  g.deps.quote = async () => ({ ...await wrongQuote(), accountId: '12' })
  await runPartialPlan(g.db, g.creds, 7, g.deps)
  assert.equal(g.calls(), 0)
})

test('nonfinite or coercible quotes cannot trigger a financial action', async t => {
  for (const bid of [Infinity, NaN, '131']) {
    const f = setup(t), quote = f.deps.quote
    f.deps.quote = async () => ({ ...await quote(), bid, ask: Infinity })
    await runPartialPlan(f.db, f.creds, 7, f.deps)
    assert.equal(f.calls(), 0)
  }
})

test('a hanging close times out without permitting another attempt', async t => {
  const f = setup(t)
  f.deps.timeoutMs = 10
  f.deps.close = () => new Promise(() => {})
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'AMBIGUOUS')
  assert.equal(readPartialPlan(f.db, '11', 7).state, 'AMBIGUOUS')
})

test('a crash after durable claim survives database reopen without resend or plan replacement', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'momentum-partial-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'agent.db')
  let db = new Database(path)
  db.pragma('journal_mode=WAL')
  const input = { accountId: '11', tradeId: 7, positionId: '123', plan, evidenceId: 'fixture:7', identity: { host: 'demo.ctraderapi.com', accountId: '11', symbolId: '22' } }
  registerPartialPlan(db, input)
  db.prepare("UPDATE momentum_partial_plans SET state='SENDING',attempted_at=?").run(at)
  db.close()
  db = new Database(path)
  t.after(() => db.close())
  let calls = 0
  assert.equal((await runPartialPlan(db, { accountId: '11' }, 7, { close: () => { calls++ } })).state, 'SENDING')
  assert.equal(calls, 0)
  assert.equal(registerPartialPlan(db, input).state, 'SENDING')
  assert.throws(() => registerPartialPlan(db, { ...input, evidenceId: 'replacement' }), /different evidence/)
})

test('persisted corrupt or altered arithmetic refuses before any broker request', async t => {
  for (const json of ['{broken', JSON.stringify({ ...plan, closeVolume: 9900 }), JSON.stringify(null)]) {
    const f = setup(t)
    f.db.prepare('UPDATE momentum_partial_plans SET plan_json=?').run(json)
    let reads = 0
    f.deps.readPosition = async () => { reads++; throw Error('must not read') }
    const result = await runPartialPlan(f.db, f.creds, 7, f.deps)
    assert.equal(result.reason, 'stored_plan_invalid')
    assert.equal(reads, 0)
    assert.equal(f.calls(), 0)
  }
})

test('a missing or changed lifecycle owner refuses before send', async t => {
  for (const ownership of [null, { ...owner(), accountId: '12' }, { ...owner(), tradeId: 8 },
    { ...owner(), positionId: '124' }, { ...owner(), status: 'closed' },
    { ...owner(), owner: 'fast_monitor' }, { ...owner(), guardActive: true },
    { ...owner(), initialRisk: 9 }, { ...owner(), entry: 101 }]) {
    const f = setup(t)
    f.deps.readOwnership = () => ownership
    const result = await runPartialPlan(f.db, f.creds, 7, f.deps)
    assert.equal(result.reason, 'lifecycle_ownership_unverified')
    assert.equal(f.calls(), 0)
  }
  const f = setup(t)
  delete f.deps.readOwnership
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).reason, 'lifecycle_ownership_unverified')
})

test('ownership is rechecked after async preflight immediately before the durable claim', async t => {
  const f = setup(t), quote = f.deps.quote
  f.deps.quote = async (...args) => {
    f.deps.readOwnership = () => ({ ...owner(), status: 'exit_sent' })
    return quote(...args)
  }
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).reason, 'lifecycle_ownership_unverified')
  assert.equal(f.calls(), 0)
})

function owner(accountId = '11') {
  return { accountId, tradeId: 7, positionId: '123', status: 'open', owner: 'momentum_book',
    guardActive: false, initialRisk: 10, entry: 100, side: 'BUY' }
}

test('a RECEIVED row with a missing or foreign persisted receipt cannot become confirmed', async t => {
  for (const receipt of [null, '{broken', JSON.stringify({ accountId: '12', positionId: '123',
    dealId: '999', closedVolume: plan.closeVolume, price: 130.4 })]) {
    const f = setup(t)
    f.db.prepare("UPDATE momentum_partial_plans SET state='RECEIVED',receipt_json=?").run(receipt)
    f.deps.readPosition = async () => ({ accountId: '11', positionId: '123', side: 'BUY', entry: 100,
      volume: plan.runnerVolume, stopLoss: 95, takeProfit: 140.4, observedAtMs: at })
    assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).reason, 'stored_receipt_invalid')
    assert.equal(readPartialPlan(f.db, '11', 7).state, 'RECEIVED')
    assert.equal(f.calls(), 0)
  }
})

test('a closing deal from before this attempt or the future cannot confirm the partial', async t => {
  for (const stamp of [at - 1, at + 1, undefined]) {
    const f = setup(t), close = f.deps.close
    f.deps.close = async (...args) => ({ ...await close(...args), executedAtMs: stamp })
    assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'AMBIGUOUS')
    assert.equal(f.calls(), 1)
  }
})

test('the original late broker receipt is retained after timeout without a second send', async t => {
  const f = setup(t), close = f.deps.close
  let deliver
  f.deps.timeoutMs = 5
  f.deps.close = async (...args) => {
    await new Promise(resolve => { deliver = resolve })
    return close(...args)
  }
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'AMBIGUOUS')
  deliver()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(readPartialPlan(f.db, '11', 7).state, 'RECEIVED')
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'CONFIRMED')
  assert.equal(f.calls(), 1)
})

// T1 (V3 P0-1a): a stored plan whose stop carries float residue (an unsnapped
// fill shift, 247.81000000000003) against the broker's grid stop 247.81. The
// manager compared these as floats, so the BUY's broker stop read as one ulp
// WIDER than the plan and the partial stayed ARMED on broker_position_mismatch.
test('broker prices match the stored plan in ticks, and a tick wider still refuses', async t => {
  for (const [side, stop, brokerStop, wider, entry] of [
    ['BUY', 247.81000000000003, 247.81, 247.80, 265.91],
    ['SELL', 283.93000000000006, 283.93, 283.94, 265.83]]) {
    const residue = planMomentumTargets({ side, entry, originalStop: stop, requiredRr: 3,
      costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 })
    assert.equal(residue.mode, 'partial_runner')
    assert.notEqual(residue.originalStop, brokerStop, 'the fixture must carry float residue to test anything')
    for (const [held, expected] of [[brokerStop, 'CONFIRMED'], [wider, 'ARMED']]) {
      const db = new Database(':memory:'); t.after(() => db.close())
      registerPartialPlan(db, { accountId: '11', tradeId: 7, positionId: '123', plan: residue, evidenceId: 'fixture:7',
        identity: { host: 'demo.ctraderapi.com', accountId: '11', symbolId: '22' } })
      let volume = 10000, calls = 0
      const trigger = residue.trigger
      const deps = { now: () => at, maxAgeMs: 5000,
        // The monitor's initial risk as the producer's fill anchoring writes it.
        readOwnership: () => ({ ...owner(), side, entry, initialRisk: 18.100000000000023 }),
        readPosition: async () => ({ accountId: '11', positionId: '123', side, entry, volume,
          stopLoss: held, takeProfit: residue.brokerTarget, observedAtMs: at }),
        quote: async () => ({ accountId: '11', positionId: '123', bid: trigger, ask: trigger, observedAtMs: at }),
        close: async (_creds, order) => {
          calls++; volume -= order.volume
          return { accountId: '11', positionId: '123', dealId: '999', closedVolume: order.volume, price: trigger, executedAtMs: at }
        },
      }
      const result = await runPartialPlan(db, { accountId: '11', host: 'demo.ctraderapi.com' }, 7, deps)
      assert.equal(result.state, expected, `${side} broker stop ${held}`)
      assert.equal(calls, expected === 'CONFIRMED' ? 1 : 0, `${side} broker stop ${held}`)
      if (expected === 'ARMED') assert.equal(result.reason, 'broker_position_mismatch')
    }
  }
})

// On this coarse grid Q 3 and Q 2.9 round to the same trigger (1004) and split,
// so { ...q3, requiredRr: 2.9 } is exactly the plan the old clamp computed for
// Q 2.9 and self-verified. Only the HARD_MIN_RR refusal can reject it.
test('a self-consistent plan whose Q sits below the gate\'s HARD_MIN_RR cannot be registered', t => {
  const base = { side: 'BUY', entry: 1000, originalStop: 999, costReservePrice: 0.5, digits: 0,
    volume: 10000, minVolume: 100, stepVolume: 100 }
  const q3 = planMomentumTargets({ ...base, requiredRr: 3 })
  assert.equal(q3.mode, 'partial_runner'); assert.equal(q3.trigger, 1004)
  const identity = { host: 'demo.ctraderapi.com', accountId: '11', symbolId: '22' }
  const db = new Database(':memory:'); t.after(() => db.close())
  assert.throws(() => registerPartialPlan(db, { accountId: '11', tradeId: 7, positionId: '123',
    plan: { ...q3, requiredRr: 2.9 }, evidenceId: 'fixture:7', identity }), /valid immutable partial plan/)
  assert.equal(registerPartialPlan(db, { accountId: '11', tradeId: 7, positionId: '123', plan: q3, evidenceId: 'fixture:7', identity }).state, 'ARMED')
})
