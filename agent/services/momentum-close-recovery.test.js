// node --test agent/services/momentum-close-recovery.test.js
//
// T2 (V3 P0-1b): partial and rank close attempts recovered from broker deal
// history. The manager and the rank exit run against the real exec-engine
// close path (EXEC_ENGINE=cpp over HTTP) into test-support/fake-broker.js,
// which answers a close the ways the gateway really can: ORDER_FILLED with
// the deal, ORDER_ACCEPTED with no deal (the fill dropped as a late frame,
// engine.cpp dispatchFrame), its own TIMEOUT, NOT_CONNECTED, a broker error;
// and fills now, later or never. Reads (reconcile, deal history, spot) come
// from the same fake ledger.
//
// The first test was written before the fix and is red on main: an accepted
// close ended AMBIGUOUS, which would have blocked the rank exit for good
// (V3-SEQUENCE risk 2).
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { tempDir } from '../test-support/temp-dir.js'
import { startFakeBroker } from '../test-support/fake-broker.js'
import { closePosition, invalidateSidecarSession, pushSidecarSession } from '../lib/exec-engine.js'
import { registerPartialPlan, runPartialPlan, readPartialPlan } from './momentum-partial-manager.js'
import { makeMomentumPartialBroker } from './momentum-partial-broker.js'
import { runMomentumRankExit } from './momentum-rank-exit.js'
import { planMomentumTargets } from './momentum-target-policy.js'
import { partialDealHistoryEvidence, TRANSPORT_HORIZON_MS, MAX_CLOCK_SKEW_MS } from './momentum-broker-evidence.js'

const ACCOUNT = '4001', SYMBOL = 22
const HOSTS = ['demo.ctraderapi.com', 'live.ctraderapi.com']
const plan = planMomentumTargets({ side: 'BUY', entry: 100, originalStop: 90, requiredRr: 3,
  costReservePrice: 0.4, digits: 2, volume: 10000, minVolume: 100, stepVolume: 100 })
const ENV = ['EXEC_ENGINE', 'EXEC_URL', 'EXEC_URL_DEMO', 'EXEC_URL_LIVE', 'EXEC_SECRET', 'EXEC_FALLBACK']

/** A fake broker holding one BUY 10000 @ 100 (SL 90, TP 140.4 from relative
 * brackets on a 2-digit grid), a registered plan, and the real adapter. */
async function scene(t, { host = 'demo.ctraderapi.com', dbPath = null } = {}) {
  const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]))
  const broker = await startFakeBroker({ accounts: [ACCOUNT], symbols: { [SYMBOL]: { digits: 2 } } })
  for (const k of ['EXEC_URL_DEMO', 'EXEC_URL_LIVE']) delete process.env[k]
  Object.assign(process.env, { EXEC_ENGINE: 'cpp', EXEC_URL: broker.url, EXEC_SECRET: 'sekret', EXEC_FALLBACK: '0' })
  invalidateSidecarSession()
  t.after(async () => {
    invalidateSidecarSession()
    await broker.close()
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  })
  broker.setQuote(SYMBOL, { bid: 99.9, ask: 100 })
  const pos = broker.open(ACCOUNT, { symbolId: SYMBOL, tradeSide: 'BUY', volume: 10000, relativeStopLoss: 1_000_000, relativeTakeProfit: 4_040_000 })
  assert.equal(pos.stopLoss, 90); assert.equal(pos.takeProfit, 140.4)
  const positionId = String(pos.positionId)
  const identity = { host, accountId: ACCOUNT, symbolId: String(SYMBOL) }
  let db = dbPath ? new Database(dbPath) : new Database(':memory:')
  registerPartialPlan(db, { accountId: ACCOUNT, tradeId: 7, positionId, plan, evidenceId: 'fixture:7', identity })
  const creds = { ...identity, ready: true, clientId: 'c', clientSecret: 's', accessToken: 't' }
  const s = { broker, identity, positionId, creds, current: creds, credentialReads: 0, dealReads: 0, failDeals: false }
  s.transports = {
    now: () => broker.nowMs,
    readCredentials: () => { s.credentialReads++; return s.current },
    reconcile: async (_h, _ci, _cs, _at, account) => broker.reconcile(account),
    quote: async (c, symbolId) => broker.spot(c.accountId, symbolId),
    deals: async (_h, _ci, _cs, _at, account, pid, to) => {
      s.dealReads++
      if (s.failDeals) throw Error('deal history read failed')
      return broker.positionDeals(account, pid, { toTimestamp: to })
    },
  }
  s.owner = () => ({ accountId: ACCOUNT, tradeId: 7, positionId, status: 'open', owner: 'momentum_book',
    guardActive: false, entry: 100, initialRisk: 10, side: 'BUY' })
  s.adapter = () => {
    const a = makeMomentumPartialBroker(db, { identity, tradeId: 7 }, s.transports)
    a.readOwnership = s.owner
    return a
  }
  s.run = (deps = s.adapter()) => runPartialPlan(db, s.current, 7, deps)
  s.row = () => readPartialPlan(db, ACCOUNT, 7)
  s.closes = () => broker.callsFor('close').length
  s.trigger = () => broker.setQuote(SYMBOL, { bid: 130.4, ask: 130.5 })
  s.reopen = () => { db.close(); db = new Database(dbPath) }
  s.db = () => db
  s.rankDeps = () => ({ now: () => broker.nowMs, timeoutMs: 5000, readCredentials: () => s.current, readOwnership: s.owner,
    rankReconcile: async (_h, _ci, _cs, _at, account) => broker.reconcile(account),
    rankDeals: async (_h, _ci, _cs, _at, account, pid, to) => broker.positionDeals(account, pid, { toTimestamp: to }),
    close: closePosition, log: () => {} })
  s.book = { account_id: ACCOUNT, trade_id: 7, position_id: positionId }
  t.after(() => { try { db.close() } catch { /* closed by the test */ } })
  return s
}

test('WRITTEN FIRST: a close answered ORDER_ACCEPTED is recovered from deal history, RECEIVED then CONFIRMED, with one close (red on main: AMBIGUOUS)', async t => {
  for (const host of HOSTS) {
    const s = await scene(t, { host })
    s.trigger()
    s.broker.closeAnswer({ reply: 'accepted' })
    const out = await s.run()
    assert.equal(out.state, 'CONFIRMED', `${host}: ${JSON.stringify(out)}`)
    assert.equal(s.closes(), 1, host)
    const row = s.row()
    assert.equal(row.state, 'CONFIRMED')
    assert.equal(row.receipt.source, 'deal_history')
    assert.equal(row.receipt.orderId, row.order_id, 'the receipt is the deal of the accepted order')
    assert.match(s.broker.lastCall('close').outcome, new RegExp(`order=${row.order_id}$`))
    assert.equal(s.broker.positions(ACCOUNT)[0].volume, plan.runnerVolume)
    // Later passes never close again.
    await s.run(); await s.run()
    assert.equal(s.closes(), 1, host)
  }
})

test('an accepted close whose fill lands later stays SENDING with its order id, then confirms from history; no second close', async t => {
  const s = await scene(t)
  s.trigger()
  s.broker.closeAnswer({ reply: 'accepted', fill: 'deferred' })
  const first = await s.run()
  assert.equal(first.state, 'SENDING'); assert.equal(first.reason, 'awaiting_transport_horizon')
  assert.match(s.row().order_id, /^[1-9]\d*$/)
  s.broker.tick(30_000)
  assert.equal((await s.run()).state, 'SENDING', 'no deal yet and inside the window: unchanged')
  s.broker.tick(5_000); s.broker.fillDeferred()
  s.broker.tick(25_000)
  assert.equal((await s.run()).state, 'CONFIRMED')
  assert.equal(s.closes(), 1)
})

test('a restart in SENDING (database closed and reopened, a new adapter) with a matching deal confirms without a close', async t => {
  const dbPath = join(tempDir('t2-restart-'), 'agent.db')
  const s = await scene(t, { dbPath })
  s.trigger()
  s.broker.closeAnswer({ reply: 'accepted', fill: 'deferred' })
  assert.equal((await s.run()).state, 'SENDING')
  const orderId = s.row().order_id
  s.reopen()
  s.broker.fillDeferred(); s.broker.tick(1_000)
  const out = await s.run(s.adapter())
  assert.equal(out.state, 'CONFIRMED', JSON.stringify(out))
  assert.equal(s.row().receipt.orderId, orderId)
  assert.equal(s.closes(), 1)
})

test('a close landing late, at 35 s, is never declared NOT_EXECUTED', async t => {
  // The gateway's own TIMEOUT (no order id) with the broker filling at 35 s.
  const s = await scene(t)
  s.trigger()
  s.broker.closeAnswer({ reply: 'timeout', fill: 'deferred' })
  const seen = []
  seen.push((await s.run()).state)
  assert.equal(seen[0], 'AMBIGUOUS')
  s.broker.tick(30_000); seen.push((await s.run()).state)
  s.broker.tick(5_000); const [late] = s.broker.fillDeferred()
  s.broker.tick(1_000); seen.push((await s.run()).state)
  s.broker.tick(TRANSPORT_HORIZON_MS); seen.push((await s.run()).state)
  assert.ok(!seen.includes('NOT_EXECUTED'), seen.join(' → '))
  // Without an order id the deal is not attributed to the attempt; the
  // record says the volume changed and names the deal.
  const row = s.row()
  assert.equal(row.state, 'VOLUME_CHANGED')
  assert.equal(row.reason, 'volume_changed_attribution_unproven')
  assert.deepEqual(row.evidence.closingDealIds, [String(late.dealId)])
  assert.equal(row.receipt, null)
  assert.equal(s.closes(), 1)
})

test('no deal past the transport horizon with a fresh full-volume read is NOT_EXECUTED: no resend, and the rank exit proceeds', async t => {
  const s = await scene(t)
  s.trigger()
  s.broker.closeAnswer({ reply: 'timeout', fill: 'never' })
  assert.equal((await s.run()).state, 'AMBIGUOUS')
  s.broker.tick(TRANSPORT_HORIZON_MS - 1_000)
  assert.equal((await s.run()).reason, 'awaiting_transport_horizon')
  s.broker.tick(2_000)
  const out = await s.run()
  assert.equal(out.state, 'NOT_EXECUTED', JSON.stringify(out))
  assert.equal(s.row().evidence.observedVolume, plan.volume)
  await s.run()
  assert.equal(s.closes(), 1, 'never resent')
  // The rank exit closes the full volume, once.
  const rank = await runMomentumRankExit(s.db(), s.current, s.book, s.rankDeps())
  assert.deepEqual(rank, { handled: true, state: 'CONFIRMED' })
  assert.equal(s.closes(), 2)
  assert.equal(s.broker.lastCall('close').body.volume, plan.volume)
  assert.equal(s.row().state, 'RANK_CONFIRMED')
})

test('a token refresh between preflight and send reverts to ARMED without using the attempt', async t => {
  const s = await scene(t)
  s.trigger()
  const rotated = { ...s.creds, accessToken: 'rotated' }
  const read = s.transports.readCredentials
  // readPosition, quote and the preflight read the old token; close() reads the new one.
  s.transports.readCredentials = () => (s.credentialReads >= 3 ? rotated : read())
  const out = await s.run()
  assert.equal(out.state, 'ARMED'); assert.equal(out.reason, 'close_not_sent')
  assert.match(s.row().reason, /close_not_sent: pre_transport/)
  assert.equal(s.closes(), 0, 'nothing reached the gateway')
  s.transports.readCredentials = () => rotated
  s.current = rotated
  assert.equal((await s.run()).state, 'CONFIRMED')
  assert.equal(s.closes(), 1)
})

test('the gateway answering NOT_CONNECTED reverts to ARMED; the next pass closes once', async t => {
  for (const host of HOSTS) {
    const s = await scene(t, { host })
    s.trigger()
    // The session is pushed, then the broker link drops: the gateway answers
    // every write NOT_CONNECTED before sending anything.
    await pushSidecarSession(s.current)
    s.broker.dropSession()
    const out = await s.run()
    assert.equal(out.state, 'ARMED'); assert.equal(out.reason, 'close_not_sent')
    assert.match(s.row().reason, /NOT_CONNECTED/)
    assert.equal(s.broker.lastCall('close').outcome, 'NOT_CONNECTED')
    assert.equal(s.broker.positions(ACCOUNT)[0].volume, plan.volume)
    invalidateSidecarSession()
    assert.equal((await s.run()).state, 'CONFIRMED', host)
    assert.equal(s.broker.callsFor('close').filter(c => /^filled/.test(c.outcome)).length, 1)
  }
})

test('a definite broker rejection is terminal REJECTED with its reason; nothing is resent', async t => {
  const s = await scene(t)
  s.trigger()
  // The production shape, read from /state/momentum-account on 24-09.
  s.broker.failNext('close', { status: 502, body: '{"description":"Trading is not available: Market is closed.","errorCode":"MARKET_CLOSED"}' })
  const out = await s.run()
  assert.equal(out.state, 'REJECTED'); assert.equal(out.reason, 'broker_rejected: MARKET_CLOSED')
  await s.run()
  assert.equal(s.closes(), 1)
  // The rank exit proceeds from REJECTED with the full volume.
  assert.equal((await runMomentumRankExit(s.db(), s.current, s.book, s.rankDeps())).state, 'CONFIRMED')
  assert.equal(s.broker.lastCall('close').body.volume, plan.volume)
})

test('a manual partial of the same volume with another order id is not taken as the receipt', async t => {
  const s = await scene(t)
  s.trigger()
  s.broker.closeAnswer({ reply: 'accepted', fill: 'never' })
  assert.equal((await s.run()).state, 'SENDING')
  const ours = s.row().order_id
  const manual = s.broker.externalClose(ACCOUNT, s.positionId, plan.closeVolume)
  assert.notEqual(String(manual.orderId), ours)
  s.broker.tick(1_000)
  assert.equal((await s.run()).state, 'SENDING')
  assert.equal(s.row().receipt, null)
  s.broker.tick(TRANSPORT_HORIZON_MS)
  const out = await s.run()
  assert.equal(out.state, 'VOLUME_CHANGED'); assert.equal(out.reason, 'volume_changed_without_this_order')
  assert.equal(s.row().receipt, null, 'never CONFIRMED on another order\'s deal')
  assert.deepEqual(s.row().evidence.closingDealIds, [String(manual.dealId)])
  assert.equal(s.closes(), 1)
})

test('an absent position is CLOSED_EXTERNALLY with its closing deals, an external partial is VOLUME_CHANGED, a failed deal read changes nothing', async t => {
  for (const host of HOSTS) {
    const s = await scene(t, { host })
    const stop = s.broker.externalClose(ACCOUNT, s.positionId)
    s.failDeals = true
    const failed = await s.run()
    assert.equal(failed.state, 'ARMED'); assert.equal(failed.reason, 'deal_history_unavailable')
    s.failDeals = false
    const out = await s.run()
    assert.equal(out.state, 'CLOSED_EXTERNALLY'); assert.equal(out.reason, 'position_closed_before_partial')
    assert.deepEqual(s.row().evidence.closingDealIds, [String(stop.dealId)])
    assert.equal(s.row().evidence.absent, true)
    assert.equal(s.closes(), 0)
    await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, s.rankDeps()), /closed externally/)
    assert.equal(s.closes(), 0)

    const v = await scene(t, { host })
    const partial = v.broker.externalClose(ACCOUNT, v.positionId, 4000)
    const changed = await v.run()
    assert.equal(changed.state, 'VOLUME_CHANGED'); assert.equal(v.row().evidence.observedVolume, 6000)
    assert.deepEqual(v.row().evidence.closingDealIds, [String(partial.dealId)])
    assert.equal(v.closes(), 0)
    // The plan no longer describes the position: the caller's own close applies.
    assert.deepEqual(await runMomentumRankExit(v.db(), v.current, v.book, v.rankDeps()), { handled: false, state: 'VOLUME_CHANGED' })
  }
})

test('a RECEIVED partial whose position is then absent is terminal, with the receipt kept', async t => {
  const s = await scene(t)
  s.trigger()
  const reconcile = s.transports.reconcile
  let reads = 0
  s.transports.reconcile = async (...args) => { if (++reads === 2) throw Error('readback unavailable'); return reconcile(...args) }
  assert.equal((await s.run()).state, 'RECEIVED')
  const receipt = s.row().receipt
  const runnerStop = s.broker.externalClose(ACCOUNT, s.positionId)
  const out = await s.run()
  assert.equal(out.state, 'CLOSED_EXTERNALLY'); assert.equal(out.reason, 'position_closed_after_partial')
  assert.deepEqual(s.row().receipt, receipt)
  assert.ok(s.row().evidence.closingDealIds.includes(String(runnerStop.dealId)))
  assert.equal(s.closes(), 1)
})

test('"position not found" at the close is confirmed by an absence read, then CLOSED_EXTERNALLY', async t => {
  const s = await scene(t)
  s.trigger()
  // The stop fills between the preflight read and the close.
  const quote = s.transports.quote
  let stop
  s.transports.quote = async (...args) => { const q = await quote(...args); stop = s.broker.externalClose(ACCOUNT, s.positionId); return q }
  const out = await s.run()
  assert.equal(out.state, 'CLOSED_EXTERNALLY', JSON.stringify(out))
  assert.deepEqual(s.row().evidence.closingDealIds, [String(stop.dealId)])
  assert.equal(s.broker.lastCall('close').outcome, 'POSITION_NOT_FOUND')
})

// ---------------------------------------------------------------------------
// Deal-history matching, unit level: the real decoder over crafted pages.
// ---------------------------------------------------------------------------
const at = 1790264000000
function sending(t, { orderId = '555', now = at + 10_000, volume = plan.runnerVolume } = {}) {
  const db = new Database(':memory:'); t.after(() => db.close())
  const identity = { host: 'demo.ctraderapi.com', accountId: '11', symbolId: '22' }
  registerPartialPlan(db, { accountId: '11', tradeId: 7, positionId: '123', plan, evidenceId: 'fixture:7', identity })
  db.prepare("UPDATE momentum_partial_plans SET state='SENDING',attempted_at=?,order_id=?").run(at, orderId)
  let closes = 0, page = null
  const deps = { now: () => now, maxAgeMs: 5000,
    readOwnership: () => null,
    readPosition: async () => ({ accountId: '11', positionId: '123', side: 'BUY', entry: 100, volume,
      stopLoss: 90, takeProfit: 140.4, observedAtMs: now }),
    quote: async () => { throw Error('no quote on recovery') },
    close: async () => { closes++ },
    readClosingDeals: async () => partialDealHistoryEvidence(page, { identity, positionId: '123', nowMs: now }),
  }
  return { db, deps, creds: { accountId: '11', host: 'demo.ctraderapi.com' }, closes: () => closes, page: p => { page = p } }
}
const deal = patch => ({ dealId: 901, orderId: 555, positionId: 123, symbolId: 22, tradeSide: 'SELL', dealStatus: 2,
  volume: plan.closeVolume, filledVolume: plan.closeVolume, executionPrice: 130.4, executionTimestamp: at + 50,
  closePositionDetail: { entryPrice: 100.00000000000001, closedVolume: plan.closeVolume }, ...patch })
const history = (deals, patch = {}) => ({ ctidTraderAccountId: 11, deal: deals, hasMore: false, ...patch })

test('deal history: the attempt\'s one exact deal confirms; each near miss leaves the state unchanged with no send', async t => {
  const good = sending(t)
  good.page(history([deal()]))
  assert.equal((await runPartialPlan(good.db, good.creds, 7, good.deps)).state, 'CONFIRMED', 'control: the exact deal')
  const misses = {
    'foreign position': [deal({ positionId: 124 })],
    'wrong volume': [deal({ filledVolume: 2500, volume: 2500, closePositionDetail: { entryPrice: 100, closedVolume: 2500 } })],
    'pre-attempt timestamp': [deal({ executionTimestamp: at - MAX_CLOCK_SKEW_MS - 1 })],
    'same-side deal': [deal({ tradeSide: 'BUY' })],
    'missing closePositionDetail': [deal({ closePositionDetail: undefined })],
    'another order id': [deal({ orderId: 556 })],
    'entry a tick away': [deal({ closePositionDetail: { entryPrice: 100.01, closedVolume: plan.closeVolume } })],
    'two matching deals': [deal(), deal({ dealId: 902 })],
  }
  for (const [name, deals] of Object.entries(misses)) {
    const f = sending(t)
    f.page(history(deals))
    const out = await runPartialPlan(f.db, f.creds, 7, f.deps)
    assert.equal(out.state, 'SENDING', `${name}: ${JSON.stringify(out)}`)
    assert.equal(readPartialPlan(f.db, '11', 7).receipt, null, name)
    assert.equal(f.closes(), 0, name)
  }
  for (const [name, page] of Object.entries({ hasMore: history([deal()], { hasMore: true }),
    'hasMore absent': history([deal()], { hasMore: undefined }), 'another account': history([deal()], { ctidTraderAccountId: 12 }) })) {
    const f = sending(t)
    f.page(page)
    const out = await runPartialPlan(f.db, f.creds, 7, f.deps)
    assert.equal(out.state, 'SENDING', name); assert.equal(out.reason, 'deal_history_unavailable', name)
    assert.equal(f.closes(), 0, name)
  }
})

test('deal history: the clock skew bound, on both sides', async t => {
  for (const [stamp, expected] of [[at - MAX_CLOCK_SKEW_MS + 500, 'CONFIRMED'], [at - MAX_CLOCK_SKEW_MS, 'CONFIRMED'],
    [at - MAX_CLOCK_SKEW_MS - 500, 'SENDING'], [at + 10_000 + MAX_CLOCK_SKEW_MS, 'CONFIRMED'], [at + 10_000 + MAX_CLOCK_SKEW_MS + 1, 'SENDING']]) {
    const f = sending(t)
    f.page(history([deal({ executionTimestamp: stamp })]))
    assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, expected, `deal at attempt${stamp - at >= 0 ? '+' : ''}${stamp - at} ms`)
  }
})

test('without an order id no deal is attributed, and NOT_EXECUTED needs the horizon and a read taken after it', async t => {
  const f = sending(t, { orderId: null })
  f.page(history([deal()]))
  assert.equal((await runPartialPlan(f.db, f.creds, 7, f.deps)).state, 'SENDING')
  assert.equal(readPartialPlan(f.db, '11', 7).receipt, null)
  // Full volume, no deal, inside the window: waits.
  const inside = sending(t, { orderId: null, volume: plan.volume, now: at + TRANSPORT_HORIZON_MS })
  inside.page(history([]))
  assert.equal((await runPartialPlan(inside.db, inside.creds, 7, inside.deps)).reason, 'awaiting_transport_horizon')
  // Past the window, but the read carries a time from inside it: waits.
  const stale = sending(t, { orderId: null, volume: plan.volume, now: at + TRANSPORT_HORIZON_MS + 1 })
  stale.page(history([]))
  const read = stale.deps.readPosition
  stale.deps.readPosition = async () => ({ ...await read(), observedAtMs: at + TRANSPORT_HORIZON_MS })
  assert.equal((await runPartialPlan(stale.db, stale.creds, 7, stale.deps)).reason, 'awaiting_transport_horizon')
  // Past the window with a read after it: proven never executed.
  const past = sending(t, { orderId: null, volume: plan.volume, now: at + TRANSPORT_HORIZON_MS + 1 })
  past.page(history([]))
  assert.equal((await runPartialPlan(past.db, past.creds, 7, past.deps)).state, 'NOT_EXECUTED')
  assert.equal(past.closes(), 0)
})

// ---------------------------------------------------------------------------
// The rank exit: every new state, its own order id, the bounded re-reservation.
// ---------------------------------------------------------------------------

test('rank exit: a close answered ORDER_ACCEPTED confirms from deal history with one close', async t => {
  for (const host of HOSTS) {
    const s = await scene(t, { host })
    s.broker.closeAnswer({ reply: 'accepted' })
    assert.deepEqual(await runMomentumRankExit(s.db(), s.current, s.book, s.rankDeps()), { handled: true, state: 'CONFIRMED' }, host)
    assert.equal(s.closes(), 1)
    const claim = s.db().prepare('SELECT * FROM momentum_rank_exits').get()
    assert.equal(claim.state, 'CONFIRMED'); assert.match(claim.order_id, /^[1-9]\d*$/)
    assert.equal(JSON.parse(claim.receipt_json).source, 'deal_history')
    assert.equal(s.row().state, 'RANK_CONFIRMED')
    assert.deepEqual(s.broker.positions(ACCOUNT), [])
  }
})

test('rank exit: a close proven not executed gets ONE logged re-reservation, then stops for the owner', async t => {
  const s = await scene(t)
  const logs = []
  const deps = () => ({ ...s.rankDeps(), log: m => logs.push(m) })
  s.broker.closeAnswer({ reply: 'timeout', fill: 'never' })
  await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, deps()), /unconfirmed/)
  assert.equal(s.row().state, 'RANK_AMBIGUOUS')
  await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, deps()), /awaiting transport horizon/)
  assert.equal(s.closes(), 1)
  s.broker.tick(TRANSPORT_HORIZON_MS + 1_000)
  s.broker.closeAnswer({ reply: 'timeout', fill: 'never' })
  await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, deps()), /unconfirmed/)
  assert.equal(s.closes(), 2, 'the one re-reservation sent once more')
  assert.equal(logs.length, 1); assert.match(logs[0], /proven not executed \(send 1 of 2\); one re-reservation/)
  s.broker.tick(TRANSPORT_HORIZON_MS + 1_000)
  await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, deps()), /owner review/)
  await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, deps()), /owner review/)
  assert.equal(s.closes(), 2, 'no third send')
  assert.equal(s.row().state, 'RANK_NOT_EXECUTED')
  const claim = s.db().prepare('SELECT * FROM momentum_rank_exits').get()
  assert.equal(claim.attempts, 2); assert.equal(JSON.parse(claim.evidence_json).observedVolume, plan.volume)
})

test('rank exit: a broker rejection or NOT_CONNECTED returns the plan to its prior state; the exit stays owed and is not spent', async t => {
  const s = await scene(t)
  s.broker.failNext('close', { status: 502, body: '{"description":"Trading is not available: Market is closed.","errorCode":"MARKET_CLOSED"}' })
  await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, s.rankDeps()), /rejected by the broker \(MARKET_CLOSED\); the exit stays owed/)
  assert.equal(s.row().state, 'ARMED')
  let claim = s.db().prepare('SELECT * FROM momentum_rank_exits').get()
  assert.equal(claim.state, 'REJECTED'); assert.equal(claim.attempts, 0); assert.equal(claim.last_outcome, 'rejected')
  await pushSidecarSession(s.current)
  s.broker.dropSession()
  await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, s.rankDeps()), /not sent \(NOT_CONNECTED\)/)
  assert.equal(s.row().state, 'ARMED')
  claim = s.db().prepare('SELECT * FROM momentum_rank_exits').get()
  assert.equal(claim.attempts, 0)
  invalidateSidecarSession()
  assert.deepEqual(await runMomentumRankExit(s.db(), s.current, s.book, s.rankDeps()), { handled: true, state: 'CONFIRMED' })
  assert.equal(s.broker.callsFor('close').filter(c => /^filled/.test(c.outcome)).length, 1)
})

test('rank exit: a timed-out close whose fill carries no known order id is not attributed; the absent position is recorded, not re-closed', async t => {
  const s = await scene(t)
  s.broker.closeAnswer({ reply: 'timeout', fill: 'now' })
  await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, s.rankDeps()), /unconfirmed/)
  await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, s.rankDeps()), /closed externally/)
  assert.equal(s.row().state, 'RANK_CLOSED_EXTERNALLY')
  await assert.rejects(runMomentumRankExit(s.db(), s.current, s.book, s.rankDeps()), /closed externally/)
  assert.equal(s.closes(), 1)
})
