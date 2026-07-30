// node --test agent/multi-account-routing.characterisation.test.js
//
// PHASES 1 AND 2 — the multi-account order path. Owner-approved 2026-07-30.
//
// Phase 1 wrote these tests to record a defect: exits carried no account, so the
// C++ sidecar filled in its own primary, and on every non-primary account
// positions opened and were then never managed. Phase 2 fixed it, in
// exec-engine's withAccount(), after the owner chose "refuse" over "default".
//
// THE TESTS THAT RECORDED THE DEFECT ARE STILL HERE, FLIPPED. Each one is now
// titled FIXED and asserts the opposite of what it used to assert — the calls
// that read "resolvedBy: primary, account: A" read "resolvedBy: explicit,
// account: B", and each still states what it used to do. Keeping the pair
// visible is the point: it is the difference between "the tests pass" and "the
// tests changed in exactly the way the fix predicted". Tests 11 and 12 are NOT
// flipped, because the C++ behaviour they record is unchanged and the
// sidecar-side refusal work depends on it.
//
// WHY A FAKE BROKER RATHER THAN MORE READING. Every claim made about
// multi-account safety up to now came from reading code. The specific question
// here — which account does the broker actually act on — spans two languages and
// a session cache, and reading it got the answer WRONG on the first attempt: the
// natural assumption is that the primary account follows the most recent
// /connect, and it does not. It is elected once per broker session and then
// frozen (engine.cpp:63-107). test-support/fake-broker.js keeps a ledger per
// account and records, for every operation, whether its account came from the
// caller or was filled in from the primary — which turns the question into an
// assertion and turned that wrong assumption into a failing test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { startFakeBroker } from './test-support/fake-broker.js'
import {
  placeOrder, amendPosition, closePosition, cancelOrder, reconcile,
  invalidateSidecarSession, pushSidecarSession, pingSidecar, setFallbackReporter,
  resolveOrderAccount,
} from './lib/exec-engine.js'
import { mayFallbackToJs } from './lib/exec-fallback.js'

const A = '4001' // the account that happens to be pushed first
const B = '4002' // the second account — the one things go missing on

/** Creds as ctrader-creds.js builds them: roster leads with the primary. */
function creds(accountId, { roster = [A, B], host = 'demo.ctraderapi.com' } = {}) {
  const primary = String(accountId)
  return {
    host,
    clientId: 'ci',
    clientSecret: 'cs',
    accessToken: 'token-1',
    accountId: primary,
    accountIds: [primary, ...roster.filter(id => id !== primary)],
  }
}

/** Creds WITHOUT a roster — loop.js:517 hand-assembles exactly this shape. */
function credsNoRoster(accountId, { host = 'demo.ctraderapi.com' } = {}) {
  const c = creds(accountId, { host })
  delete c.accountIds
  return c
}

const ENTRY = {
  symbolId: 41,
  orderType: 'MARKET',
  tradeSide: 'BUY',
  volume: 100_000,
  relativeStopLoss: 50_000,
  relativeTakeProfit: 50_000,
}

/**
 * Plant a filled position on `acct`, using THAT account's own credentials.
 *
 * The tests used to plant with `placeOrder(creds(A), {ctidTraderAccountId: B})`
 * — one set of credentials driving two accounts. That shortcut is now refused by
 * design (see the guard_account_mismatch test): credentials naming one account
 * and a payload naming another is a caller confusion, and production has no such
 * caller. So the helper does what the real code does — one account's creds per
 * account's order.
 */
async function plantOn(acct, extra = {}) {
  return placeOrder(creds(acct), { ...ENTRY, ...extra })
}

/**
 * Every test gets a fresh broker AND a cleared session memo. `lastPushedKey` is
 * module-level state in exec-engine.js, so a test that forgot this would
 * inherit the previous test's session and prove nothing.
 */
async function withBroker(fn, brokerOpts) {
  const prev = { engine: process.env.EXEC_ENGINE, url: process.env.EXEC_URL, secret: process.env.EXEC_SECRET, fb: process.env.EXEC_FALLBACK }
  const broker = await startFakeBroker(brokerOpts)
  process.env.EXEC_ENGINE = 'cpp'
  process.env.EXEC_URL = broker.url
  process.env.EXEC_SECRET = 'sekret'
  invalidateSidecarSession()
  try {
    await fn(broker)
  } finally {
    invalidateSidecarSession()
    await broker.close()
    for (const [k, v] of Object.entries({ EXEC_ENGINE: prev.engine, EXEC_URL: prev.url, EXEC_SECRET: prev.secret, EXEC_FALLBACK: prev.fb })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  }
}

// ---------------------------------------------------------------------------
// 1. THE PATHS THAT ARE ALREADY CORRECT — entries and reads stamp the account.
// ---------------------------------------------------------------------------

test('an entry lands on the account its credentials name, not on the session primary', async () => {
  // loop.js:418 builds the autotrade payload with an explicit
  // ctidTraderAccountId, and exec-engine now guarantees one is present either
  // way. This is what that buys: the fill lands on B even though A is primary.
  await withBroker(async (broker) => {
    await reconcile(creds(A)) // A is the first push, so A is the primary
    await plantOn(B)
    assert.equal(broker.primary, A, 'A is the primary — the roster led with it')
    const call = broker.lastCall('order')
    assert.equal(call.account, B)
    assert.equal(call.resolvedBy, 'explicit', 'the caller named the account; the sidecar did not have to guess')
    assert.equal(broker.positionIds(A).length, 0, 'nothing on A')
    assert.equal(broker.positionIds(B).length, 1, 'the position is on B, where it was aimed')
  })
})

test('cancelOrder stamps the account itself, so it routes correctly with no help from the caller', async () => {
  // exec-engine.js:323 puts ctidTraderAccountId in the /cancel body from
  // creds.accountId. One of only two write paths that does.
  await withBroker(async (broker) => {
    await plantOn(A)
    await cancelOrder(creds(B), { orderId: 555 })
    const call = broker.lastCall('cancel')
    assert.equal(call.account, B)
    assert.equal(call.resolvedBy, 'explicit')
  })
})

test('reconcile stamps the account itself and returns only that account\'s positions', async () => {
  await withBroker(async (broker) => {
    await plantOn(A)
    await plantOn(B)
    const snapA = await reconcile(creds(A))
    const snapB = await reconcile(creds(B))
    assert.equal(snapA.position.length, 1)
    assert.equal(snapB.position.length, 1)
    assert.notEqual(snapA.position[0].positionId, snapB.position[0].positionId)
    // The fake mints 1000-range ids for A and 2000-range for B, so a bare id
    // names its own account — which is what makes the next section legible.
    assert.equal(snapA.position[0].ctidTraderAccountId, Number(A))
    assert.equal(snapB.position[0].ctidTraderAccountId, Number(B))

    // And the reconcile timestamp comes from the fake's virtual clock, not the
    // wall clock — so a staleness assertion can never flake.
    const before = (await pingSidecar()).lastReconcileAt
    broker.tick(90_000)
    await reconcile(creds(A))
    assert.equal((await pingSidecar()).lastReconcileAt, before + 90_000)
  })
})

// ---------------------------------------------------------------------------
// 2. WAS THE HOLE, NOW THE FIX — the exit paths still send no account id, but
//    exec-engine's withAccount() stamps it from creds before the request leaves
//    Node, so the sidecar's primary-account default is never reached.
//
//    These four tests were the ones that recorded the defect. They are flipped
//    rather than deleted: the assertion that used to read "resolvedBy: primary,
//    account: A" now reads "resolvedBy: explicit, account: B", and each one
//    still says what it used to do. That contrast IS the proof the fix landed,
//    and it is why the file is worth keeping under this name.
// ---------------------------------------------------------------------------

test('FIXED: closePosition stamps the account from creds, so an exit for B reaches B', async () => {
  await withBroker(async (broker) => {
    // Establish A as the session primary, then open a position genuinely on B.
    await reconcile(creds(A))
    await plantOn(B)
    const [pidOnB] = broker.positionIds(B)

    // Closed the way profit-keeper.js:324 does — positionId and volume, no
    // account. That call site is UNCHANGED; the delegator now supplies the
    // account. Before the fix this failed with POSITION_NOT_FOUND against A,
    // and B's position stayed open.
    const out = await closePosition(creds(B), { positionId: pidOnB, volume: 100_000 })
    assert.equal(out.ok, true)

    const call = broker.lastCall('close')
    assert.equal(call.resolvedBy, 'explicit', 'the broker was told the account; it did not have to guess')
    assert.equal(call.account, B, 'and it acted on B, which is what the credentials named')
    assert.equal(call.body.ctidTraderAccountId, Number(B), 'the id is in the wire body')
    assert.deepEqual(broker.positionIds(B), [], 'B\'s position is closed — the exit actually happened')
    assert.equal(broker.primary, A, 'and the primary is still A, which no longer matters')
  })
})

test('FIXED: amendPosition stamps too — a stop-loss move aimed at B is applied on B', async () => {
  await withBroker(async (broker) => {
    await reconcile(creds(A))
    await plantOn(B, { stopLoss: 1.0 })
    const [pidOnB] = broker.positionIds(B)
    // profit-keeper.js:355 / loss-guardian.js:203 / trade-guard.js:155, unchanged.
    await amendPosition(creds(B), { positionId: pidOnB, stopLoss: 1.5 })
    assert.equal(broker.lastCall('amend').account, B)
    assert.equal(broker.positions(B)[0].stopLoss, 1.5, 'the protective stop moved, on the right account')
  })
})

test('FIXED: the primary account no longer decides anything for an exit', async () => {
  // The test that used to be titled "when the primary IS the intended account
  // the exit works — which is why this hides". It hid because the outcome
  // depended on the primary. Now both accounts behave identically, which is the
  // property that makes the bug unable to come back quietly.
  await withBroker(async (broker) => {
    for (const acct of [A, B]) {
      await plantOn(acct)
      const [pid] = broker.positionIds(acct)
      const out = await closePosition(creds(acct), { positionId: pid, volume: 100_000 })
      assert.equal(out.ok, true, `close on ${acct} should succeed`)
      assert.equal(broker.lastCall('close').resolvedBy, 'explicit')
      assert.equal(broker.lastCall('close').account, acct)
      assert.deepEqual(broker.positionIds(acct), [])
    }
  })
})

test('FIXED: a contradictory account is refused rather than resolved one way or the other', async () => {
  // If the payload names one account and the credentials name another, somebody
  // is confused about which account this operation belongs to. Picking either
  // one risks acting on the wrong account's money, so the delegator refuses and
  // nothing reaches the broker. No current caller can trigger this — every one
  // derives both from the same id — so this exists to catch the next caller.
  await withBroker(async (broker) => {
    await reconcile(creds(A))
    const before = broker.calls.length
    for (const call of [
      () => placeOrder(creds(A), { ...ENTRY, ctidTraderAccountId: parseInt(B) === parseInt(A) ? 1 : parseInt(B) }),
      () => closePosition(creds(A), { positionId: 1, volume: 1, ctidTraderAccountId: parseInt(B) }),
      () => amendPosition(creds(A), { positionId: 1, stopLoss: 1, ctidTraderAccountId: parseInt(B) }),
    ]) {
      await assert.rejects(call(), (err) => {
        assert.match(err.message, /guard_account_mismatch/)
        assert.match(err.message, /refusing to guess/)
        return true
      })
    }
    assert.equal(broker.calls.length, before, 'not one of the three reached the broker')
  })
})

test('FIXED: an operation with no account anywhere is refused, not handed to the broker to pick', async () => {
  await withBroker(async (broker) => {
    await reconcile(creds(A))
    const before = broker.calls.length
    const noAcct = { ...creds(A), accountId: null }
    await assert.rejects(
      closePosition(noAcct, { positionId: 1, volume: 1 }),
      (err) => { assert.match(err.message, /guard_no_account/); return true },
    )
    assert.equal(broker.calls.length, before)
  })
})

test('FIXED: resolveOrderAccount\'s verdicts, as a pure function', () => {
  assert.deepEqual(resolveOrderAccount({ accountId: '4001' }, {}), { ok: true, accountId: 4001 })
  assert.deepEqual(resolveOrderAccount({ accountId: '4001' }, { ctidTraderAccountId: 4001 }), { ok: true, accountId: 4001 })
  // A payload-only account is honoured — cancelOrder and the entry paths rely
  // on agreement, not on the payload being empty.
  assert.deepEqual(resolveOrderAccount({}, { ctidTraderAccountId: '4002' }), { ok: true, accountId: 4002 })
  assert.equal(resolveOrderAccount({ accountId: '4001' }, { ctidTraderAccountId: 4002 }).ok, false)
  assert.equal(resolveOrderAccount({}, {}).ok, false)
  assert.equal(resolveOrderAccount(null, null).ok, false)
  // Empty string is "absent", not account 0 — Number('') is 0, which would have
  // been a silent route to a nonexistent account.
  assert.equal(resolveOrderAccount({ accountId: '' }, {}).ok, false)
  assert.equal(resolveOrderAccount({ accountId: '4001' }, { ctidTraderAccountId: '' }).accountId, 4001)
})

// ---------------------------------------------------------------------------
// 3. THE SESSION MEMO — it used to SORT the roster, which erased the ordering
//    that decides the primary. Now it does not. Note what this does and does not
//    buy: §2's stamping is what fixes routing; this only stops the memo asserting
//    that two sessions with different primaries are the same session.
// ---------------------------------------------------------------------------

test('FIXED: the memo key keeps roster ORDER, so a change of primary re-pushes /connect', async () => {
  await withBroker(async (broker) => {
    // ctrader-creds.js:46 deliberately leads the roster with the primary:
    //   accountIds = [primary, ...rows.filter(id => id !== primary)]
    // ensureSidecarSession used to key on [...accountIds].sort(), so [A,B] and
    // [B,A] produced the SAME key and the second push never happened.
    assert.deepEqual(creds(A).accountIds, [A, B])
    assert.deepEqual(creds(B).accountIds, [B, A])

    await reconcile(creds(A))
    assert.equal(broker.connectCount, 1)
    assert.equal(broker.primary, A)

    await reconcile(creds(B))
    assert.equal(broker.connectCount, 2, 'the key differs now, so the session change is not swallowed')
    // The primary STILL does not move, because engine.cpp takes its sameSession
    // branch — see the next test. That is exactly why the stamping in §2, not
    // this, is the fix.
    assert.equal(broker.primary, A)
    assert.deepEqual(broker.roster, [A, B])
  })
})

test('a re-push with a DIFFERENT accountId does not move the primary — the sidecar adds the account instead', async () => {
  // The half of this that is easy to get wrong. Node's memo key for roster-less
  // creds (loop.js:517) is host|accountId|token, so naming a different account
  // DOES send a second /connect. But engine.cpp:70-89 sees the same host, app
  // and token on a live session, takes the sameSession branch, and only
  // APPENDS the new id — accountIds_ is never cleared and never reordered.
  //
  // So Node believes it switched account and the sidecar did not. The primary
  // is set exactly once per session, by whichever push found no live session.
  await withBroker(async (broker) => {
    await reconcile(credsNoRoster(A))
    assert.equal(broker.primary, A)
    assert.deepEqual(broker.roster, [A])

    await reconcile(credsNoRoster(B))
    assert.equal(broker.connectCount, 2, 'Node\'s key changed, so it did re-push')
    assert.equal(broker.lastCall('connect').outcome, 'roster 4001,4002')
    assert.deepEqual(broker.roster, [A, B], 'B was added to the session')
    assert.equal(broker.primary, A, 'but the primary did NOT move — this is the sameSession branch')
  })
})

test('FIXED: the primary is still frozen — and that no longer harms anything', async () => {
  // The C++ behaviour is UNCHANGED and still surprising: once a session is live,
  // nothing short of a token change, a host change or a reconnect moves
  // accountIds_.front(). This test keeps recording that, because it is the fact
  // the sidecar-side refusal work depends on. What changed is that it no longer
  // has consequences, because no operation reaches the default any more.
  await withBroker(async (broker) => {
    await reconcile(creds(A))
    assert.equal(broker.primary, A)

    await placeOrder(credsNoRoster(B), { ...ENTRY, ctidTraderAccountId: parseInt(B) })
    const [pidOnB] = broker.positionIds(B)
    assert.equal(broker.primary, A, 'B trading did not make B the primary — still true')

    // The exit that used to fail three times in a row now succeeds first time.
    const out = await closePosition(creds(B), { positionId: pidOnB, volume: 100_000 })
    assert.equal(out.ok, true)
    assert.equal(broker.lastCall('close').account, B)
    assert.equal(broker.lastCall('close').resolvedBy, 'explicit')
    assert.deepEqual(broker.positionIds(B), [])
    assert.equal(broker.primary, A, 'the primary is untouched and irrelevant')
  })
})

test('FIXED: NOTHING reaching the broker resolves by primary any more — the sweep', async () => {
  // The property, stated once over the whole surface rather than per operation.
  // If a future change reintroduces an unstamped write, this fails even if the
  // per-operation tests above were edited to match the regression.
  await withBroker(async (broker) => {
    await reconcile(creds(A))     // A becomes the primary…
    broker.reset()                // …and is dropped from the log, so only B's ops are judged
    await placeOrder(creds(B), { ...ENTRY })                       // entry, no explicit id in the payload
    const [pid] = broker.positionIds(B)
    await amendPosition(creds(B), { positionId: pid, stopLoss: 1.5 })
    await cancelOrder(creds(B), { orderId: 77 })
    await reconcile(creds(B))
    await closePosition(creds(B), { positionId: pid, volume: 100_000 })

    const acting = broker.calls.filter(c => c.op !== 'connect')
    assert.ok(acting.length >= 5, 'all five operations were exercised')
    const guessed = acting.filter(c => c.resolvedBy === 'primary')
    assert.deepEqual(guessed, [], 'no operation may reach the broker without naming its account')
    assert.ok(acting.every(c => c.account === B), 'and every one acted on B')
  })
})

// ---------------------------------------------------------------------------
// 4. RECONNECTS — the sidecar restart the M4 soak found, and its fix.
// ---------------------------------------------------------------------------

test('a sidecar that lost its credentials is NOT re-pushed on its own — the memo still matches', async () => {
  await withBroker(async (broker) => {
    await reconcile(creds(A))
    assert.equal(broker.connectCount, 1)

    // The sidecar alone restarted (env change, crash, single-service redeploy).
    broker.forgetCredentials()
    const h = await pingSidecar()
    assert.equal(h.hasCredentials, false)
    assert.equal(h.connected, false)
    assert.deepEqual(h.accounts, [], 'the roster is empty because the process forgot it')

    // Node's lastPushedKey still matches, so ensureSidecarSession pushes
    // nothing and every call fails for as long as the memo stands.
    await assert.rejects(reconcile(creds(A)), (err) => {
      assert.match(err.message, /NOT_CONNECTED/)
      return true
    })
    assert.equal(broker.connectCount, 1, 'no re-push happened by itself — this is the M4 finding')
  })
})

test('invalidateSidecarSession is what breaks the deadlock, and pushSidecarSession does it in one call', async () => {
  await withBroker(async (broker) => {
    await reconcile(creds(A))
    broker.forgetCredentials()

    invalidateSidecarSession()
    await reconcile(creds(A))
    assert.equal(broker.connectCount, 2, 'the next call re-pushed once the memo was cleared')
    assert.equal(broker.primary, A)

    // The probe path uses pushSidecarSession, which invalidates and pushes.
    broker.forgetCredentials()
    const pushed = await pushSidecarSession({ ...creds(A), ready: true })
    assert.equal(pushed, true)
    assert.equal(broker.connectCount, 3)
    assert.equal(broker.connected, true)
    // And it refuses not-ready creds rather than pushing a half-session.
    assert.equal(await pushSidecarSession({ ...creds(A), ready: false }), false)
    assert.equal(broker.connectCount, 3)
  })
})

test('a dropped broker link, credentials retained, answers NOT_CONNECTED before writing anything', async () => {
  await withBroker(async (broker) => {
    await reconcile(creds(A))
    broker.dropSession() // websocket down; creds still held

    const h = await pingSidecar()
    assert.equal(h.hasCredentials, true, 'this is a link drop, not a restart')
    assert.equal(h.connected, false)
    assert.deepEqual(h.accounts, [Number(A), Number(B)], 'the roster survives a link drop')

    // EXEC_FALLBACK off isolates the sidecar's own reply from the retry logic.
    process.env.EXEC_FALLBACK = '0'
    await assert.rejects(
      placeOrder(creds(A), { ...ENTRY, ctidTraderAccountId: parseInt(A) }),
      (err) => { assert.match(err.message, /"errorCode"\s*:\s*"NOT_CONNECTED"/); return true },
    )
    assert.equal(broker.positionIds(A).length, 0, 'nothing was placed — the refusal came before the socket')
  })
})

test('pingSidecar reports the roster in the order the session holds it, primary first', async () => {
  // The ORDER is the part worth pinning: element 0 is the account every
  // unstamped operation will resolve to, so /health already tells an operator
  // where the exits are going — provided nobody re-sorts it on the way out.
  // (exec-engine.test.js pins the separate rule that a MISSING roster reads as
  // null rather than as an empty one.)
  await withBroker(async (broker) => {
    await reconcile(creds(B)) // B leads its own roster
    const h = await pingSidecar()
    assert.deepEqual(h.accounts, [Number(B), Number(A)], 'primary first, as pushed')
    assert.equal(h.accounts[0], Number(broker.primary), 'element 0 IS the primary')
    assert.equal(h.ok, true)
  })
})

// ---------------------------------------------------------------------------
// 5. LATE RESPONSES — the reply is in flight after the broker has already acted.
// ---------------------------------------------------------------------------

test('a held reply proves the broker acted BEFORE the caller heard back', async () => {
  // This is the duplicate-order hazard as a mechanism rather than a warning. The
  // position exists at the broker while the HTTP call is still outstanding, so a
  // caller that gave up and retried would place a second one. It is exactly why
  // lib/exec-fallback.js refuses to retry a write on an ambiguous failure.
  await withBroker(async (broker) => {
    await reconcile(creds(A)) // establish the session first
    broker.hold('order')
    const inFlight = placeOrder(creds(A), { ...ENTRY, ctidTraderAccountId: parseInt(A) })
    await broker.arrived('order')

    assert.equal(broker.positionIds(A).length, 1, 'the fill is already real, with no reply delivered yet')

    broker.release('order')
    const out = await inFlight
    assert.equal(out.executionType, 'ORDER_FILLED')
    assert.equal(out.position.ctidTraderAccountId, Number(A))
  })
})

test('two accounts in flight at once do not contaminate each other\'s ledger', async () => {
  await withBroker(async (broker) => {
    await reconcile(creds(A))
    broker.hold('order')
    const first = placeOrder(creds(A), { ...ENTRY, ctidTraderAccountId: parseInt(A) })
    await broker.arrived('order')

    // B's order is submitted and answered while A's reply is still parked.
    const second = await plantOn(B)
    assert.equal(second.position.ctidTraderAccountId, Number(B))

    broker.release('order')
    const firstOut = await first
    assert.equal(firstOut.position.ctidTraderAccountId, Number(A))
    assert.equal(broker.positionIds(A).length, 1)
    assert.equal(broker.positionIds(B).length, 1)
    // Interleaving changed nothing about attribution: each fill stayed on the
    // account its payload named.
    assert.notEqual(broker.positionIds(A)[0], broker.positionIds(B)[0])
  })
})

// ---------------------------------------------------------------------------
// 6. REJECTS AND FAILURES — the error text loop.js matches on survives.
// ---------------------------------------------------------------------------

test('a broker reject reaches the caller verbatim, per account', async () => {
  await withBroker(async (broker) => {
    await reconcile(creds(A))
    broker.failNext('order', { status: 422, body: 'order rejected: MARKET_CLOSED' })
    await assert.rejects(
      plantOn(B),
      (err) => {
        assert.match(err.message, /order rejected/)
        assert.match(err.message, /MARKET_CLOSED/)
        return true
      },
    )
    assert.equal(broker.positionIds(B).length, 0)
    // The scripted failure was consumed, so the retry behaves normally — a
    // reject must not poison the account.
    const ok = await plantOn(B)
    assert.equal(ok.ok, true)
    assert.equal(broker.positionIds(B).length, 1)
  })
})

test('an operation on an account outside the authorised roster is refused, not silently retargeted', async () => {
  // This used to drive the case with creds(A) and a payload naming B. That is now
  // refused by Node before it reaches the network (see the guard_account_mismatch
  // test), so there are two independent layers and this one has to be driven
  // directly at the broker to be exercised at all:
  //
  //   layer 1, Node — the account is always named, and a contradiction is refused
  //   layer 2, broker — an op naming an UNauthorised account is refused
  //
  // Layer 2 still matters. It is what makes "the account was named but the
  // session never authorised it" a loud failure instead of a retarget, and every
  // other test here leans on the fake modelling it faithfully. So it is probed
  // with a raw request that bypasses exec-engine on purpose.
  await withBroker(async (broker) => {
    await reconcile(creds(A, { roster: [A] })) // only A authorised
    assert.deepEqual(broker.roster, [A])

    const res = await fetch(`${broker.url}/order`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sekret' },
      body: JSON.stringify({ ...ENTRY, ctidTraderAccountId: parseInt(B) }),
    })
    assert.equal(res.status, 422)
    assert.match(await res.text(), /NOT_AUTHORIZED/)
    assert.equal(broker.positionIds(A).length, 0, 'and it did NOT fall back to the primary')
    assert.equal(broker.positionIds(B).length, 0, 'nor did it open on the unauthorised account')
  })
}, { concurrency: false })

test('an account the broker does not know is dropped from the roster rather than failing the connect', async () => {
  // engine.cpp:263-269 drops an extra account whose auth fails and carries on.
  await withBroker(async (broker) => {
    await reconcile({ ...creds(A), accountIds: [A, '9999'] })
    assert.deepEqual(broker.roster, [A], 'the unknown account is gone')
    assert.equal(broker.primary, A, 'and the primary is unaffected')
  })
})

// ---------------------------------------------------------------------------
// 7. THE FALLBACK'S ASYMMETRY — when a failed write may be retried on the JS
//    path, and when it must not be. Pinned because Phase 2 must not widen it.
// ---------------------------------------------------------------------------

test('only NOT_CONNECTED and never-connected authorise retrying a WRITE; everything else refuses', () => {
  const notConnected = new Error(JSON.stringify({ errorCode: 'NOT_CONNECTED', description: 'websocket is not connected' }))
  assert.equal(mayFallbackToJs({ op: 'order', err: notConnected }).fallback, true)

  const refused = Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' })
  assert.equal(mayFallbackToJs({ op: 'order', err: refused }).fallback, true)

  // Everything ambiguous refuses, because the order may already be live.
  for (const err of [
    new Error('sidecar 500'),
    Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    Object.assign(new Error('timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
  ]) {
    for (const op of ['order', 'close', 'amend', 'cancel']) {
      assert.equal(mayFallbackToJs({ op, err, sidecarConnected: false }).fallback, false,
        `${op} must not retry on ${err.code || err.message}`)
    }
  }
  // Reads are idempotent, so they always may.
  assert.equal(mayFallbackToJs({ op: 'positions', err: new Error('sidecar 500') }).fallback, true)
})

test('a NOT_CONNECTED write does reach the JS path — end to end, through the real delegator', async () => {
  // Proven the way the existing exec-engine tests prove delegation: point the ws
  // host at a dead port, so a network error can only mean the JS path was
  // actually entered. Nothing here contacts a real broker.
  //
  // This test costs ~6s, all of it ctrader-ws's own 2s+4s retry backoff on
  // ECONNREFUSED. That is deliberate and should not be "optimised" by deleting
  // the assertion: this is the only place the NOT_CONNECTED attestation is shown
  // travelling through the real withFallback, the real exec-fallback verdict and
  // into the real ws delegate. The reporter assertion is here so the same 6s
  // also proves the switch was RECORDED — silently changing execution engines
  // mid-flight is the thing that must never be discovered later from P&L.
  const notes = []
  const restore = () => setFallbackReporter(() => {})
  setFallbackReporter((n) => notes.push(n))
  try {
    await withBroker(async (broker) => {
      await reconcile(creds(A, { host: '127.0.0.1' }))
      broker.dropSession()
      const p = placeOrder(creds(A, { host: '127.0.0.1' }), { ...ENTRY, ctidTraderAccountId: parseInt(A) })
      await assert.rejects(p, (err) =>
        /ECONNREFUSED|ETIMEDOUT|socket|closed|handshake|connect/i.test(err.message) ||
        /ECONNREFUSED|ETIMEDOUT/.test(err.code || ''))
      assert.equal(broker.positionIds(A).length, 0, 'and the sidecar placed nothing before refusing')
      assert.equal(notes.length, 1, 'the engine switch must be reported exactly once')
      assert.match(notes[0], /exec fallback: order routed to the Node WS path/)
      assert.match(notes[0], /NOT_CONNECTED before sending — it provably did not execute/)
    })
  } finally {
    restore()
  }
})

// ---------------------------------------------------------------------------
// THE CALL SITES §2 COVERS, so the Phase-2 diff has a checklist. Each of these
// passes a positionId with no ctidTraderAccountId, and so resolves to whatever
// the session primary happens to be:
//
//   services/profit-keeper.js:324, 340   closePosition
//   services/profit-keeper.js:355        amendPosition
//   services/loss-guardian.js:194        closePosition
//   services/loss-guardian.js:203        amendPosition
//   services/profit-ratchet.js:144       closePosition
//   services/loss-cap.js:129             closePosition
//   services/weekend-bank.js:72          closePosition
//   services/trade-guard.js:155          amendPosition
//   services/trade-guard.js:167          closePosition
//
// The entry paths already stamp it — loop.js:418, services/pending-orders.js:332,
// services/closed-market-limits.js:48 — as do cancelOrder and reconcile inside
// exec-engine.js. So the gap is exits, and only exits.
//
// WHY THAT COMBINATION IS THE WORST ONE. Entries route correctly, so positions
// really do open on every enabled account. Exits resolve to the single frozen
// primary, so on every OTHER account the stop-loss ratchet, the giveback close,
// the loss cap, the time cap and the weekend bank all fail with
// POSITION_NOT_FOUND — quietly, since each of those callers logs and carries on
// by design. The visible symptom is trades that open and are never managed,
// which is what "autotrade drops from the accounts" looks like from outside.
//
// ONE THING THIS FILE DOES NOT CLAIM. Whether a cTrader positionId can ever
// collide across two accounts under one cTID is UNVERIFIED — it is not in the
// public API docs and this session has no live multi-account data to check it
// against. If ids cannot collide, the symptom is the one pinned above: exits on
// non-primary accounts fail with POSITION_NOT_FOUND and positions stay open. If
// they can, the same code path closes a position on the WRONG account. The fix
// is identical either way, which is why the question is recorded rather than
// resolved.
// ---------------------------------------------------------------------------
