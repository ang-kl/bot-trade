// ---------------------------------------------------------------------------
// agent/test-support/fake-broker.js — a deterministic two-account fake of the
// C++ exec sidecar, for Phase-1 characterisation of the multi-account order
// path. Test support only; nothing in agent/ imports this at runtime.
//
// WHY THIS EXISTS. Every safety claim about multi-account routing so far has
// been an assertion about code that was read, not behaviour that was observed.
// The existing sidecar stub in lib/exec-engine.test.js answers every request
// with one canned `nextResponse`, so it cannot tell you the one thing that
// matters here: WHICH ACCOUNT the broker actually acted on, and HOW that was
// decided. This fake keeps a separate ledger per account and records, for every
// operation, whether the account came from the caller's payload or was filled
// in from the session's primary. That single distinction is what turns
// "the routing looks wrong" into a test that fails.
//
// WHAT IS FAITHFUL TO THE REAL SIDECAR (cpp-exec/src/engine.cpp, main.cpp):
//   * `withAccountId(payload, primaryAccountLocked())` — engine.cpp:276-280
//     stamps ctidTraderAccountId ONLY when the caller left it out, and the
//     default is `accountIds_.front()`.
//   * setCredentials' TWO branches (engine.cpp:63-107), which decide what
//     front() is. A push matching the live session's host+app+token only
//     APPENDS unauthorised ids and leaves the order alone; only a push that
//     finds no matching live session clears the list and elects a new primary.
//     So the primary is chosen once per session and then frozen. Reproducing
//     this correctly is the entire reason this file exists — an earlier draft
//     assumed the primary followed the most recent push, which is wrong in the
//     direction that makes the bug look milder than it is.
//   * /order, /amend, /close, /cancel all go through that same stamp
//     (engine.cpp:317, 330, 337, 344).
//   * POST /positions requires ctidTraderAccountId and 400s without it
//     (main.cpp:316-320); GET /positions is the legacy primary-only view.
//   * A dropped websocket answers BEFORE anything is written, with
//     {"errorCode":"NOT_CONNECTED","description":"websocket is not connected"}.
//     The exact string matters: lib/exec-fallback.js treats it as the sidecar's
//     per-call attestation that the request never reached the broker, and it is
//     one of only two things that authorise a JS-path retry of a write.
//   * GET /health reports {ok, connected, hasCredentials, lastReconcileAt,
//     accounts} — including the roster that pingSidecar used to drop.
//
// WHAT IS MODELLED, NOT COPIED. The broker behind the sidecar is not in this
// repo, so its verdicts are invented — but only in ways whose SHAPE is known
// from production error text:
//   * A position id is looked up in the resolved account's ledger only, and a
//     miss answers `POSITION_NOT_FOUND: position <id> unknown`. cTrader position
//     ids are per-account, so an exit aimed at the wrong account cannot find its
//     position — this is the mechanism, not a guess about it.
//   * An operation on an account outside the authorised roster answers
//     `order rejected: NOT_AUTHORIZED account <id>`.
// Both strings are chosen to match what loop.js substring-matches on, so a test
// written against this fake exercises the same branches production takes.
//
// DETERMINISM. No timers and no wall clock anywhere:
//   * Slow calls use GATES, not sleeps. hold(op) parks the next response for
//     that op; arrived(op) resolves once the request has landed and been
//     applied; release(op) lets the reply go. Two operations can therefore be
//     interleaved in an exact, reproducible order, which is the only way to
//     test a late response without a race.
//   * `lastReconcileAt` comes from a virtual clock the test advances with
//     tick(ms). Nothing here reads Date.now().
// ---------------------------------------------------------------------------

import http from 'node:http'

/** Per-account starting position id, so an id alone identifies its account. */
const ID_BASE = 1000

/**
 * Start the fake. Returns a handle; call `close()` when done.
 *
 * @param {{accounts?: string[], startMs?: number}} [opts]
 *   accounts — the ids the BROKER will accept an auth for. Anything outside
 *   this list is refused, the way an unauthorised ctidTraderAccountId would be.
 */
export async function startFakeBroker({ accounts = ['4001', '4002'], startMs = 1_700_000_000_000 } = {}) {
  const known = accounts.map(String)

  /** @type {Map<string, {positions: Map<number, any>, nextId: number, balance: number}>} */
  const ledgers = new Map(known.map((id, i) => [id, {
    positions: new Map(),
    // Account 0 mints 1000, 1001…; account 1 mints 2000, 2001… A bare position
    // id in a failure report therefore names its own account.
    nextId: ID_BASE * (i + 1),
    balance: 10_000,
  }]))

  const session = {
    connected: false,
    hasCredentials: false,
    /** The account an unstamped operation resolves to — engine.cpp's accountIds_.front(). */
    primary: null,
    roster: [],
    host: null,
    clientId: null,
    accessToken: null,
  }

  const state = {
    nowMs: startMs,
    lastReconcileAt: 0,
    connectCount: 0,
    /** Every operation, in order, with how its account was decided. */
    calls: [],
    /** op → {status, body} to answer with exactly once. */
    failOnce: new Map(),
    /** op → true: park the reply until release(op). */
    holds: new Set(),
    /** op → resolve fn for a parked reply. */
    parked: new Map(),
    /** op → resolve fn for arrived(op) waiters. */
    arrivals: new Map(),
  }

  function notifyArrival(op) {
    const waiters = state.arrivals.get(op)
    if (!waiters) return
    state.arrivals.delete(op)
    for (const r of waiters) r()
  }

  /** Faithful to engine.cpp: the caller's id wins; otherwise the primary. */
  function resolveAccount(body) {
    const explicit = body?.ctidTraderAccountId
    if (explicit !== undefined && explicit !== null && explicit !== '') {
      return { account: String(explicit), resolvedBy: 'explicit' }
    }
    return { account: session.primary == null ? null : String(session.primary), resolvedBy: 'primary' }
  }

  function record(op, account, resolvedBy, body, outcome) {
    state.calls.push({ seq: state.calls.length, op, account, resolvedBy, body, outcome })
  }

  const NOT_CONNECTED = {
    status: 502,
    body: JSON.stringify({ errorCode: 'NOT_CONNECTED', description: 'websocket is not connected' }),
  }

  /** Runs the operation and returns {status, body}. Pure w.r.t. HTTP framing. */
  function apply(op, url, body) {
    const scripted = state.failOnce.get(op)
    if (scripted) {
      state.failOnce.delete(op)
      record(op, null, 'scripted-failure', body, `scripted ${scripted.status}`)
      return scripted
    }

    if (op === 'connect') {
      const wanted = body?.accountId == null ? null : String(body.accountId)
      const extras = Array.isArray(body?.accountIds) ? body.accountIds.map(String) : []
      state.connectCount += 1

      // engine.cpp:63-107 has TWO branches, and the difference is the single
      // most consequential fact in this whole file.
      const sameSession = session.connected &&
        body?.host === session.host &&
        body?.clientId === session.clientId &&
        body?.accessToken === session.accessToken

      if (sameSession) {
        // engine.cpp:70-89. accountIds_ is NOT cleared and its ORDER is not
        // touched — new ids are appended, already-authorised ones skipped. So
        // `accountIds_.front()`, i.e. the account every unstamped operation
        // resolves to, DOES NOT MOVE. A push naming a different accountId adds
        // that account to the session and changes nothing about the primary.
        for (const id of [wanted, ...extras]) {
          if (id != null && known.includes(id) && !session.roster.includes(id)) session.roster.push(id)
        }
        record(op, session.primary, 'same-session', body, `roster ${session.roster.join(',')}`)
        return { status: 200, body: '{}' }
      }

      // engine.cpp:91-106 — a different host/app/token, or no live session yet.
      // accountIds_.clear(), primary = accountId, then extras; the websocket is
      // closed so the next loop pass reconnects and re-auths. THIS is the only
      // branch that can set the primary.
      const roster = []
      for (const id of [wanted, ...extras]) {
        if (id != null && !roster.includes(id)) roster.push(id)
      }
      // The broker refuses an auth for an account the token does not cover; the
      // sidecar drops those from the roster rather than failing the connect
      // (engine.cpp:263-269).
      session.roster = roster.filter(id => known.includes(id))
      session.primary = session.roster[0] ?? null
      session.host = body?.host ?? null
      session.clientId = body?.clientId ?? null
      session.accessToken = body?.accessToken ?? null
      // SIMPLIFICATION: the real sidecar comes back up on its own runLoop pass a
      // moment later; the fake is connected immediately. Nothing in these tests
      // depends on the reconnect window, and modelling it would add a timer.
      session.connected = session.roster.length > 0
      session.hasCredentials = session.roster.length > 0
      record(op, session.primary, 'fresh-session', body, `roster ${session.roster.join(',')}`)
      return { status: 200, body: '{}' }
    }

    if (!session.connected) {
      record(op, null, 'n/a', body, 'NOT_CONNECTED')
      return NOT_CONNECTED
    }

    const { account, resolvedBy } = resolveAccount(body)
    if (account == null || !session.roster.includes(account)) {
      record(op, account, resolvedBy, body, 'NOT_AUTHORIZED')
      return { status: 422, body: `order rejected: NOT_AUTHORIZED account ${account}` }
    }
    const led = ledgers.get(account)

    if (op === 'order') {
      const positionId = led.nextId++
      const pos = {
        positionId,
        ctidTraderAccountId: Number(account),
        symbolId: body?.symbolId ?? null,
        tradeSide: body?.tradeSide ?? null,
        volume: body?.volume ?? 0,
        stopLoss: body?.stopLoss ?? null,
        takeProfit: body?.takeProfit ?? null,
      }
      led.positions.set(positionId, pos)
      record(op, account, resolvedBy, body, `filled ${positionId}`)
      return { status: 200, body: JSON.stringify({ ok: true, executionType: 'ORDER_FILLED', position: pos }) }
    }

    if (op === 'close' || op === 'amend') {
      const pid = Number(body?.positionId)
      const pos = led.positions.get(pid)
      if (!pos) {
        // cTrader position ids are per-account. An exit aimed at the wrong
        // account cannot see its position, and this is what comes back.
        record(op, account, resolvedBy, body, 'POSITION_NOT_FOUND')
        return { status: 404, body: `POSITION_NOT_FOUND: position ${pid} unknown` }
      }
      if (op === 'close') {
        led.positions.delete(pid)
        record(op, account, resolvedBy, body, `closed ${pid}`)
        return { status: 200, body: JSON.stringify({ ok: true, executionType: 'ORDER_FILLED', closedPositionId: pid }) }
      }
      if (body?.stopLoss !== undefined) pos.stopLoss = body.stopLoss
      if (body?.takeProfit !== undefined) pos.takeProfit = body.takeProfit
      record(op, account, resolvedBy, body, `amended ${pid}`)
      return { status: 200, body: JSON.stringify({ ok: true, executionType: 'ORDER_AMENDED', positionId: pid }) }
    }

    if (op === 'cancel') {
      record(op, account, resolvedBy, body, `cancelled ${body?.orderId}`)
      return { status: 200, body: JSON.stringify({ executionType: 'ORDER_CANCELLED', orderId: body?.orderId }) }
    }

    if (op === 'positions') {
      // main.cpp:316-320 — the POST form demands the account explicitly.
      if (url === '/positions' && resolvedBy === 'primary' && body !== undefined) {
        record(op, null, resolvedBy, body, 'need ctidTraderAccountId')
        return { status: 400, body: '{"error":"need ctidTraderAccountId"}' }
      }
      state.lastReconcileAt = state.nowMs
      record(op, account, resolvedBy, body, `snapshot ${led.positions.size}`)
      return { status: 200, body: JSON.stringify({ position: [...led.positions.values()] }) }
    }

    record(op, account, resolvedBy, body, 'ok')
    return { status: 200, body: '{}' }
  }

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', async () => {
      const url = req.url || ''
      const body = raw ? JSON.parse(raw) : undefined

      if (url === '/health') {
        // Unauthenticated by contract, and it must never depend on the roster
        // being pushed — that is the whole point of a liveness probe.
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({
          ok: true,
          connected: session.connected,
          hasCredentials: session.hasCredentials,
          lastReconcileAt: state.lastReconcileAt,
          accounts: session.roster.map(Number),
        }))
      }

      const op = url === '/connect' ? 'connect'
        : url === '/order' ? 'order'
        : url === '/amend' ? 'amend'
        : url === '/close' ? 'close'
        : url === '/cancel' ? 'cancel'
        : url === '/positions' ? 'positions'
        : url.replace(/^\//, '')

      // Apply FIRST, then optionally park the reply. That ordering is what makes
      // a late response testable: the broker has already acted, and only the
      // answer is in flight — exactly the shape that turns a timeout into a
      // duplicate order if the caller retries.
      const out = apply(op, url, body)
      notifyArrival(op)

      if (state.holds.has(op)) {
        state.holds.delete(op)
        await new Promise((resolve) => state.parked.set(op, resolve))
      }

      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(out.body)
    })
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}`

  return {
    url,
    get calls() { return state.calls },
    get connectCount() { return state.connectCount },
    get primary() { return session.primary },
    get roster() { return [...session.roster] },
    get connected() { return session.connected },
    get hasCredentials() { return session.hasCredentials },

    /** Open positions on one account, as the broker sees them. */
    positions(account) { return [...(ledgers.get(String(account))?.positions.values() ?? [])] },
    /** Position ids on one account — the compact form most assertions want. */
    positionIds(account) { return this.positions(account).map(p => p.positionId) },

    /** Every call for one op, oldest first. */
    callsFor(op) { return state.calls.filter(c => c.op === op) },
    /** The most recent call for one op, or undefined. */
    lastCall(op) { return this.callsFor(op).at(-1) },

    /**
     * The websocket dropped. Writes now answer NOT_CONNECTED *before* anything
     * reaches the broker — the one sidecar reply that authorises a JS-path
     * retry of a write. Credentials are retained, so /health still reports
     * hasCredentials:true: this is a broker-link drop, not a sidecar restart.
     */
    dropSession() { session.connected = false },

    /**
     * The sidecar process restarted: it lost its credentials entirely. This is
     * the M4 finding's precondition — Node's lastPushedKey memo still matches,
     * so nothing re-pushes until something invalidates it.
     */
    forgetCredentials() {
      session.connected = false
      session.hasCredentials = false
      session.primary = null
      session.roster = []
      // Cleared too, so the next /connect takes the fresh-session branch — a
      // restarted process cannot possibly match the old session.
      session.host = null
      session.clientId = null
      session.accessToken = null
    },

    /** Answer the next call for `op` with this status/body, once. */
    failNext(op, { status, body }) { state.failOnce.set(op, { status, body: String(body) }) },

    /** Park the next reply for `op` until release(op). The op still APPLIES. */
    hold(op) { state.holds.add(op) },
    /** Let a parked reply go. */
    release(op) {
      const r = state.parked.get(op)
      if (!r) throw new Error(`nothing parked for "${op}" — hold(op) first, and await arrived(op)`)
      state.parked.delete(op)
      r()
    },
    /** Resolves once a request for `op` has landed and been applied. */
    arrived(op) {
      return new Promise((resolve) => {
        const list = state.arrivals.get(op) || []
        list.push(resolve)
        state.arrivals.set(op, list)
      })
    },

    /** Advance the virtual clock. Nothing here reads Date.now(). */
    tick(ms) { state.nowMs += ms },

    reset() {
      state.calls = []
      state.failOnce.clear()
      state.holds.clear()
      state.connectCount = 0
    },

    close() { return new Promise((r) => server.close(r)) },
  }
}
