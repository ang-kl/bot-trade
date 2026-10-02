// node --test agent/services/stop-policy-controller.test.js
//
// The desired-state controller for the stop policy (02-10-2026): canary first,
// one stamp per account, throttled re-asks, and the skips that keep it off
// positions it must not touch. Behaviour against a stub exec (the sidecar's
// answers), a real in-memory db, the real policy module.
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initDB } from '../db.js'
import { setStopPolicy } from '../lib/stop-policy.js'
import { runStopPolicyPass, resetStopPolicyController, stopPolicyControllerView, classifyOutcome, confirmedAt, remember, RECHECK_MS, RETRY_MS, CANARY_HOLD_MS, TRACKED_MAX } from './stop-policy-controller.js'

const NOW = 1_800_000_000_000
const OK = { policy: { applied: true, readback: 'confirmed', refused: null, skipped: null } }
const COMPLIANT = { unchanged: true, policy: { applied: false, readback: 'confirmed', refused: null, skipped: null } }

function rig({ live = false } = {}) {
  const db = initDB(':memory:')
  for (const id of ['42', '43']) db.prepare(`INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES (?, 0, 1, 'active')`).run(id)
  if (live) db.prepare(`INSERT INTO accounts (account_id, is_live, enabled, mode) VALUES ('44', 1, 1, 'active')`).run()
  let n = 0
  function position(account, { side = 'BUY', entry = 100, sl = 95, paused = 0, optOut = 0, row = true, book = false } = {}) {
    const posId = 9000 + (++n)
    if (row) {
      const tradeId = db.prepare(`INSERT INTO trades (symbol, side, entry_price, volume, status, ctrader_position_id, account_id, opened_at)
        VALUES ('EURUSD', ?, ?, 0.01, 'open', ?, ?, datetime('now'))`).run(side, entry, String(posId), account).lastInsertRowid
      db.prepare(`INSERT INTO monitored_positions (symbol, trade_id, side, entry_price, current_sl, current_tp, status, account_id, source, paused, keeper_opt_out)
        VALUES ('EURUSD', ?, ?, ?, ?, 110, 'active', ?, 'autopilot', ?, ?)`).run(tradeId, side, entry, sl, account, paused, optOut)
      if (book) db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, entered_at, status)
        VALUES (?, ?, 'EURUSD', ?, 'long', ?, ?, datetime('now'), 'open')`).run(tradeId, account, String(posId), entry, sl)
    }
    return { positionId: posId, stopLoss: sl, takeProfit: 110 }
  }
  const broker = { '42': [], '43': [], '44': [] }
  const sent = []
  let answer = () => OK
  const exec = {
    reconcile: async (creds) => ({ position: broker[String(creds.accountId)] || [] }),
    amendPosition: async (creds, args) => { sent.push({ account: String(creds.accountId), isLive: !!creds.isLive, args }); const a = answer(args); if (a instanceof Error) throw a; return a },
  }
  return { db, position, broker, sent, exec, setAnswer: (f) => { answer = f } }
}

const creds = { ready: true, accountId: '42', isLive: false }

beforeEach(() => { setStopPolicy(null); resetStopPolicyController() })

test('canary first: one stamp in the first pass, then one per account', async () => {
  const r = rig()
  r.broker['42'] = [r.position('42'), r.position('42')]
  r.broker['43'] = [r.position('43')]
  const p1 = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  assert.equal(r.sent.length, 1, 'before the canary is confirmed, one position in total')
  assert.equal(p1.stamped, 1)
  assert.ok(stopPolicyControllerView().canaryConfirmedAt)
  const p2 = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW + 1000 })
  assert.equal(r.sent.length, 1 + 2, 'confirmed canary: at most one per account per pass (two accounts)')
  assert.equal(p2.skipped.recent, 1, 'the position the canary already stamped is not asked again')
})

test('the wire a stamp carries: policyOnly, the direction, the broker stop for the lock rule, no stop or target of Node\'s own', async () => {
  const r = rig()
  r.broker['42'] = [r.position('42', { entry: 100, sl: 101 })]
  await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  const a = r.sent[0].args
  assert.equal(a.policyOnly, true)
  assert.equal(a.expectedDirection, 1)
  assert.deepEqual(a.stopContext, { side: 'BUY', entry: 100, book: false, stop: 101 })
  assert.equal('stopLoss' in a, false)
  assert.equal('takeProfit' in a, false)
})

test('a refusal before the canary holds the whole controller, and the hold is released after CANARY_HOLD_MS', async () => {
  const r = rig()
  r.broker['42'] = [r.position('42')]
  r.broker['43'] = [r.position('43')]
  r.setAnswer(() => ({ policy: { applied: false, readback: 'none', refused: { errorCode: 'X' }, skipped: null } }))
  const p1 = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  assert.equal(p1.refused, 1)
  assert.equal(p1.held, true)
  assert.equal(r.sent.length, 1, 'the second account was not spent on a refusing broker')
  const p2 = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW + 60_000 })
  assert.equal(p2.held, true)
  assert.equal(r.sent.length, 1, 'held: nothing sent')
  r.setAnswer(() => OK)
  await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW + CANARY_HOLD_MS + 1 })
  assert.ok(r.sent.length > 1, 'released after the hold')
})

test('an error is retried after RETRY_MS, a confirmed stamp is not asked again before RECHECK_MS', async () => {
  const r = rig()
  r.broker['42'] = [r.position('42')]
  r.setAnswer(() => new Error('sidecar down'))
  await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  assert.equal(r.sent.length, 1)
  r.setAnswer(() => COMPLIANT)
  const early = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW + RETRY_MS - 1 })
  assert.equal(r.sent.length, 1, 'inside the retry window nothing is sent')
  assert.equal(early.held, true, 'the canary never confirmed, so it is still held')
  await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW + CANARY_HOLD_MS + 1 })
  assert.equal(r.sent.length, 2)
  const again = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW + CANARY_HOLD_MS + 2000 })
  assert.equal(r.sent.length, 2, 'confirmed compliant: not re-asked')
  assert.equal(again.skipped.recent, 1)
  await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW + CANARY_HOLD_MS + RECHECK_MS + 5000 })
  assert.equal(r.sent.length, 3, 're-checked after RECHECK_MS')
})

test('an unreadable read-back is reported as unverifiable and not re-stamped every pass', async () => {
  const r = rig()
  r.broker['42'] = [r.position('42')]
  r.setAnswer(() => ({ policy: { applied: true, readback: 'unreadable', refused: null, skipped: null } }))
  const p = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  assert.equal(p.unverifiable, 1)
  assert.equal(stopPolicyControllerView().unverifiable.length, 1)
  await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW + CANARY_HOLD_MS + 1 })
  assert.equal(r.sent.length, 1, 'not asked again inside RECHECK_MS')
})

test('skips: no stop, paused, keeper_opt_out, no monitored row, policy off', async () => {
  const r = rig()
  r.broker['42'] = [
    { positionId: 1, stopLoss: null, takeProfit: 110 },
    r.position('42', { paused: 1 }),
    r.position('42', { optOut: 1 }),
    r.position('42', { row: false }),
  ]
  const p = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  assert.equal(r.sent.length, 0)
  assert.deepEqual(p.skipped, { no_stop: 1, paused: 1, keeper_opt_out: 1, no_row: 1 })
  r.broker['42'] = [r.position('42')]
  setStopPolicy({ enabled: false })
  const off = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  assert.equal(r.sent.length, 0)
  assert.equal(off.skipped.policy_off, 1)
})

test('a momentum-book row is stamped with book:true (trigger only, never trailing)', async () => {
  const r = rig()
  r.broker['42'] = [r.position('42', { book: true })]
  await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  assert.equal(r.sent[0].args.stopContext.book, true)
})

test('classifyOutcome reads the sidecar policy block', () => {
  assert.equal(classifyOutcome(null, new Error('x')), 'error')
  assert.equal(classifyOutcome({}, null), 'no_policy_block')
  assert.equal(classifyOutcome({ policy: { refused: { errorCode: 'X' } } }), 'refused')
  assert.equal(classifyOutcome({ policy: { skipped: 'cooldown', readback: 'none' } }), 'cooldown')
  assert.equal(classifyOutcome(OK), 'stamped')
  assert.equal(classifyOutcome(COMPLIANT), 'compliant')
  assert.equal(classifyOutcome({ policy: { readback: 'mismatch' } }), 'mismatch')
  assert.equal(classifyOutcome({ policy: { readback: 'unverified' } }), 'unverifiable')
})

test('single flight: a second pass started while one is still running joins it and stamps nothing beside it', async () => {
  const r = rig()
  r.broker['42'] = [r.position('42')]
  let release
  const gate = new Promise(res => { release = res })
  const slow = { ...r.exec, amendPosition: async (c, a) => { await gate; return r.exec.amendPosition(c, a) } }
  const p1 = runStopPolicyPass(r.db, creds, { exec: slow, nowMs: NOW })
  const p2 = runStopPolicyPass(r.db, creds, { exec: slow, nowMs: NOW })
  assert.strictEqual(p1, p2, 'the same in-flight pass')
  release()
  await p1
  assert.equal(r.sent.length, 1)
})


// ---------------------------------------------------------------------------
// Pre-merge review fixes (02-10-2026)
// ---------------------------------------------------------------------------
const liveCreds = (id) => ({ ready: true, accountId: id, isLive: true })

test('BOTH BROKER SIDES: the other side\'s accounts are stamped too, with that side\'s credentials (the selected account reaches one host)', async () => {
  const r = rig({ live: true })
  r.broker['42'] = [r.position('42')]
  r.broker['44'] = [r.position('44')]
  const deps = { exec: r.exec, nowMs: NOW, credsForSide: (isLive, id) => (isLive ? liveCreds(id) : { ready: true, accountId: id, isLive: false }) }
  await runStopPolicyPass(r.db, creds, deps) // the canary: one real stamp, ends the pass
  assert.equal(r.sent.length, 1)
  await runStopPolicyPass(r.db, creds, { ...deps, nowMs: NOW + 1000 })
  assert.deepEqual(r.sent.map(s => [s.account, s.isLive]).sort(), [['42', false], ['44', true]], 'the live account was reached with live credentials')
})

test('a side whose credentials are unavailable is an ERROR, never a quiet gap, and the other side still runs', async () => {
  const r = rig({ live: true })
  r.broker['42'] = [r.position('42')]
  const p = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW, credsForSide: (isLive, id) => ({ ready: false, accountId: id, isLive }) })
  assert.deepEqual(p.errors, ['stop policy: credentials unavailable for a required broker side'])
  assert.equal(r.sent.length, 1, 'the base side was still stamped')
})

test('F2: a no-op does not confirm the canary, does not hold it, and does not use up its one stamp', async () => {
  const r = rig()
  r.broker['42'] = [r.position('42')]
  r.broker['43'] = [r.position('43')]
  const answers = [COMPLIANT, OK]
  r.setAnswer(() => answers.shift())
  const p = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  assert.equal(r.sent.length, 2, 'the compliant account cost nothing: the next account was asked in the same pass')
  assert.equal(p.compliant, 1)
  assert.equal(p.stamped, 1)
  assert.equal(p.held, false)
  assert.ok(stopPolicyControllerView().canaryConfirmedAt, 'the real stamp confirmed it')

  resetStopPolicyController() // the controller state is process-wide; start the second half from a cold canary
  const r2 = rig()
  r2.broker['42'] = [r2.position('42')]
  r2.setAnswer(() => COMPLIANT)
  await runStopPolicyPass(r2.db, creds, { exec: r2.exec, nowMs: NOW })
  assert.equal(stopPolicyControllerView().canaryConfirmedAt, null, 'all no-ops: the path was never proven, so the canary is still open')
})

test('F3: no new broker call starts after the soft deadline, and the rest wait for the next pass', async () => {
  const r = rig()
  r.broker['42'] = [r.position('42')]
  r.broker['43'] = [r.position('43')]
  let t = 0
  const clock = () => (t += 10) // every look at the clock costs 10 ms
  const p = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW, clock, softDeadlineMs: 5 })
  assert.equal(r.sent.length, 0)
  assert.equal(p.deadline, true)
  const q = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW + 1000 })
  assert.equal(q.deadline, false)
  assert.equal(r.sent.length, 1, 'the next pass with time to spare stamps')
})

test('F4: a position id spelled as a float string on either side still matches its monitored row', async () => {
  // The 02-08 production bug: trades.ctrader_position_id stored as "234698574.0"
  // while the broker hands round "234698574" (lib/pos-id.js).
  const r = rig()
  const pos = r.position('42')
  r.db.prepare(`UPDATE trades SET ctrader_position_id = ?`).run(`${pos.positionId}.0`)
  r.broker['42'] = [pos]
  const p = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  assert.equal(p.skipped.no_row, undefined, 'the row side may carry the legacy spelling')
  assert.equal(r.sent.length, 1)
  assert.equal(confirmedAt('42', String(pos.positionId)) != null, true, 'and the verifier\'s spelling finds the answer')
  resetStopPolicyController()
  r.sent.length = 0
  r.db.prepare(`UPDATE trades SET ctrader_position_id = ?`).run(String(pos.positionId))
  r.broker['42'] = [{ ...pos, positionId: `${pos.positionId}.0` }]
  const q = await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW })
  assert.equal(q.skipped.no_row, undefined, 'and the broker side may')
  assert.equal(r.sent.length, 1)
})

test('after the canary the accounts are stamped in PARALLEL (the pass is as long as its slowest account, inside the band budget)', async () => {
  const r = rig()
  r.broker['42'] = [r.position('42')]
  r.broker['43'] = [r.position('43')]
  await runStopPolicyPass(r.db, creds, { exec: r.exec, nowMs: NOW }) // the canary
  r.broker['42'] = [r.position('42')]
  r.broker['43'] = [r.position('43')]
  let started = 0
  let overlapped = null
  let release
  const bothStarted = new Promise(res => { release = res })
  const exec = { ...r.exec, amendPosition: async (c, a) => {
    started++
    if (started === 2) release()
    const together = await Promise.race([bothStarted.then(() => true), new Promise(res => setTimeout(() => res(false), 300))])
    if (overlapped === null) overlapped = together
    return OK
  } }
  await runStopPolicyPass(r.db, creds, { exec, nowMs: NOW + 1000 })
  assert.equal(started, 2)
  assert.equal(overlapped, true, 'the second account\'s amend was in flight while the first was still waiting')
})

test('F5: the tracked map is bounded and drops the oldest', () => {
  for (let i = 0; i < TRACKED_MAX + 25; i++) remember(`42:${i}`, { at: i, outcome: 'compliant' })
  const v = stopPolicyControllerView()
  assert.equal(v.tracked, TRACKED_MAX)
  assert.equal(confirmedAt('42', 0), null, 'the oldest is gone')
  assert.notEqual(confirmedAt('42', TRACKED_MAX + 24), null, 'the newest is kept')
})
