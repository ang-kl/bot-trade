// Persistent, pre-authenticated cTrader connections.
//
// THE PROBLEM (measured 2026-07-28). Every broker call in ctrader-ws.js opens
// its own WebSocket, does the TLS handshake, sends APP_AUTH_REQ, waits,
// sends ACCOUNT_AUTH_REQ, waits — and only then sends the request it actually
// came for. Measured fixed cost: ~1.8s per call, independent of payload size.
// A scan cycle makes hundreds of these. Production's own error log shows the
// bill: 46 failures in one day, all of the form
//
//   "Client network socket disconnected before secure TLS connection was
//    established"  /  "WS timeout after 30000ms — expecting 2101 after
//    sending 2100"
//
// i.e. the connection and the *auth handshake* failing, not the trading
// request. Those symbols simply do not get scanned that cycle.
//
// The V8 CPU profile of the loop settled that none of this is CPU — the
// monitor phase was 97.9% idle. The loop is not computing, it is waiting on
// connections it keeps rebuilding.
//
// THE FIX. Keep a small pool of already-authenticated sockets per account and
// run requests over them. Auth is paid once per socket instead of once per
// call.
//
// WHY A POOL OF SERIAL SESSIONS, AND NOT ONE MULTIPLEXED SOCKET. The obvious
// design is a single connection with every request in flight at once,
// correlated by clientMsgId. That requires the broker to echo clientMsgId back
// on every response. cTrader's docs say it does; this codebase has never
// depended on it — wsRun sets a clientMsgId and then matches purely on
// payloadType arrival order. Betting a live trading account on undocumented-
// by-us behaviour is not a trade worth making: a mis-correlated response means
// one position's close reply is read as another's.
//
// So each session runs exactly ONE request at a time — identical matching
// semantics to today, on a socket that behaves exactly as today's does —
// and concurrency comes from having several sessions. clientMsgId is still
// checked, but only as a VETO: a response whose echoed id contradicts the
// request in flight is refused rather than trusted. That is strictly safer
// than today and does not depend on the echo existing.
//
// WHAT IS GENUINELY NEW AND NEEDS WATCHING. A long-lived authenticated socket
// receives UNSOLICITED events — an EXECUTION_EVENT when a broker-side stop
// fires, for instance. A short-lived socket rarely lived long enough to see
// one. While a request is in flight, such an event could look like its
// response. Mitigations, in order: the clientMsgId veto above; and
// `isUnsolicited`, which drops execution events carrying no clientMsgId when
// the in-flight request is not itself an order. Both are tested.
//
// OFF BY DEFAULT. Set CTRADER_WS_POOL=1 to enable. Unset, ctrader-ws.js takes
// exactly the path it takes today.
import WebSocket from 'ws'

import { PT } from './ctrader-payload-types.js'

/** Feature flag. Read per call so a deploy can flip it without a restart. */
export function poolEnabled() {
  return String(process.env.CTRADER_WS_POOL || '').trim() === '1'
}

// How many authenticated sockets to keep per account. Concurrency for the
// scan phase comes entirely from this number, since each session is serial.
// Default 6 matches SCAN_CONCURRENCY — the historical-rate token bucket, not
// the socket count, is what paces trendbar requests.
const POOL_SIZE = Math.max(1, Number(process.env.CTRADER_WS_POOL_SIZE) || 6)

// Close a session that has gone this long without work. Holding sockets open
// forever against a broker that may silently drop them trades one problem for
// another; a re-auth every few idle minutes is cheap.
const IDLE_MS = Math.max(30_000, Number(process.env.CTRADER_WS_IDLE_MS) || 600_000)

const HEARTBEAT_MS = 9_000
const AUTH_TIMEOUT_MS = Math.max(5_000, Number(process.env.CTRADER_WS_AUTH_TIMEOUT_MS) || 20_000)

/**
 * Should this message be ignored rather than read as the in-flight response?
 *
 * The hazard a persistent socket introduces: a broker-initiated EXECUTION_EVENT
 * (a stop firing on some other position) arriving while we happen to be waiting
 * for an EXECUTION_EVENT of our own. Exported and pure so the rule is testable
 * without a broker.
 *
 * @param {{payloadType:number, clientMsgId?:string}} msg
 * @param {{msgId:string, sentType:number}} inflight
 */
export function isUnsolicited(msg, inflight) {
  if (!inflight) return true
  // The broker echoed an id, and it is not ours. Never ours, whatever the type.
  if (msg.clientMsgId && msg.clientMsgId !== inflight.msgId) return true
  // An execution event with no id, while we are not the ones who asked for an
  // order or an amend, is somebody else's fill.
  if (msg.payloadType === PT.EXECUTION_EVENT && !msg.clientMsgId) {
    const weAsked = inflight.sentType === PT.NEW_ORDER_REQ ||
      inflight.sentType === PT.AMEND_POSITION_SLTP_REQ ||
      inflight.sentType === PT.CLOSE_POSITION_REQ ||
      inflight.sentType === PT.CANCEL_ORDER_REQ
    if (!weAsked) return true
  }
  return false
}

let seq = 0
const nextMsgId = () => `p${++seq}`

class Session {
  constructor(key, { host, appAuth, accountAuth, connect, log }) {
    // The account this session is authenticated for. Sessions are never shared
    // across accounts — a socket is authenticated to exactly one.
    this.key = key
    this.host = host
    this.appAuth = appAuth
    this.accountAuth = accountAuth
    this.connect = connect
    this.log = log
    this.ws = null
    this.ready = null        // Promise<void> once connecting/connected
    this.dead = false
    this.busy = false        // exactly one request at a time — see header
    // Serialisation is enforced HERE, not by the caller. acquire() may hand
    // back a busy session when the pool is full, and two requests sharing one
    // socket would overwrite each other's `inflight` — i.e. one position's
    // reply read as another's, the exact failure this design exists to avoid.
    this.chain = Promise.resolve()
    this.inflight = null     // {msgId, sentType, onMsg, onFail}
    this.hb = null
    this.idle = null
    this.lastUsedAt = Date.now()
  }

  /** Open the socket and complete both auth steps. Idempotent. */
  open() {
    if (this.ready) return this.ready
    this.ready = new Promise((resolve, reject) => {
      let ws
      try { ws = this.connect(`wss://${this.host}:5036`) } catch (err) { reject(err); return }
      this.ws = ws
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        this.destroy(err)
        reject(err)
      }
      const timer = setTimeout(() => fail(new Error(`cTrader WS timeout after ${AUTH_TIMEOUT_MS}ms — session auth`)), AUTH_TIMEOUT_MS)
      if (typeof timer.unref === 'function') timer.unref()

      // Auth is a fixed two-step exchange; run it inline rather than through
      // the general request path, which assumes an authenticated session.
      let stage = 'app'
      ws.on('open', () => {
        this.hb = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            try { this.ws.send(JSON.stringify({ payloadType: PT.HEARTBEAT })) } catch { /* the close handler deals with it */ }
          }
        }, HEARTBEAT_MS)
        if (typeof this.hb.unref === 'function') this.hb.unref()
        this.send({ payloadType: PT.APP_AUTH_REQ, payload: this.appAuth })
      })

      ws.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg.payloadType === PT.HEARTBEAT) return

        if (!settled) {
          if (msg.payloadType === PT.ERROR_RES) {
            const e = msg.payload || {}
            fail(new Error(`cTrader error: ${e.errorCode || 'unknown'} — ${e.description || ''}`))
            return
          }
          if (stage === 'app' && msg.payloadType === PT.APP_AUTH_RES) {
            stage = 'account'
            this.send({ payloadType: PT.ACCOUNT_AUTH_REQ, payload: this.accountAuth })
            return
          }
          if (stage === 'account' && msg.payloadType === PT.ACCOUNT_AUTH_RES) {
            settled = true
            clearTimeout(timer)
            this.armIdleTimer()
            resolve()
          }
          return
        }
        this.route(msg)
      })

      ws.on('error', (err) => {
        const wrapped = new Error(`cTrader WS error: ${err.message}`)
        if (!settled) { fail(wrapped); return }
        this.destroy(wrapped)
      })
      ws.on('close', () => {
        const err = new Error('cTrader WS closed')
        if (!settled) { fail(err); return }
        this.destroy(err)
      })
    })
    return this.ready
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj))
  }

  /** Deliver a post-auth message to the in-flight request, or drop it. */
  route(msg) {
    const f = this.inflight
    if (!f) return
    if (isUnsolicited(msg, f)) return
    f.onMsg(msg)
  }

  armIdleTimer() {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => {
      if (!this.busy) this.destroy(new Error('idle'))
    }, IDLE_MS)
    if (typeof this.idle.unref === 'function') this.idle.unref()
  }

  /** Tear down and fail anything in flight. Safe to call repeatedly. */
  destroy(err) {
    if (this.dead) return
    this.dead = true
    clearInterval(this.hb)
    clearTimeout(this.idle)
    const f = this.inflight
    this.inflight = null
    this.busy = false
    try { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close() } catch { /* already gone */ }
    const siblings = pool.get(this.key)
    if (siblings) {
      const i = siblings.indexOf(this)
      if (i >= 0) siblings.splice(i, 1)
      if (!siblings.length) pool.delete(this.key)
    }
    if (f) f.onFail(err)
  }

  /**
   * Run one already-authenticated request sequence.
   *
   * `steps` is the same shape wsRun takes, minus the auth prefix. The
   * per-step wait/timeout semantics — including crediting back time spent
   * parked on the historical rate limiter — match wsRun exactly, because
   * scan behaviour depends on them.
   */
  run(steps, timeoutMs, collectAll, takeHistoricalToken, isHistorical) {
    // Queue behind whatever this socket is already doing. The tail is kept
    // rejection-free so one failed request never poisons the queue.
    const mine = this.chain.then(
      () => this.runNow(steps, timeoutMs, collectAll, takeHistoricalToken, isHistorical))
    this.chain = mine.then(() => {}, () => {})
    return mine
  }

  runNow(steps, timeoutMs, collectAll, takeHistoricalToken, isHistorical) {
    if (this.dead) return Promise.reject(new Error('cTrader WS closed'))
    return new Promise((resolve, reject) => {
      this.busy = true
      this.lastUsedAt = Date.now()
      clearTimeout(this.idle)

      let stepIdx = 0
      let timer = null
      const seen = []
      const collected = []
      let done = false

      const finish = (fn, arg) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.inflight = null
        this.busy = false
        if (!this.dead) this.armIdleTimer()
        fn(arg)
      }

      const onTimeout = () => {
        const pending = steps[stepIdx]
        const label = pending
          ? `expecting ${pending.expect} after sending ${pending.send.payloadType}`
          : 'unknown step'
        const seenStr = seen.length ? ` received=[${seen.join(',')}]` : ''
        // The socket's state after a timeout is unknown — a late response would
        // land on whoever runs next. Drop it rather than reuse it.
        const err = new Error(`cTrader WS timeout after ${timeoutMs}ms — ${label}${seenStr}`)
        finish(reject, err)
        this.destroy(err)
      }
      timer = setTimeout(onTimeout, timeoutMs)

      const onFail = (err) => {
        // Preserve wsRun's "after sending <type>" marker — isAmbiguousSubmitError
        // reads it to decide whether an order may have reached the broker.
        const sent = steps[stepIdx]?.send.payloadType
        const suffix = sent != null ? ` — after sending ${sent}` : ''
        finish(reject, new Error(`${err.message}${suffix}`))
      }

      const sendStep = async (i) => {
        const step = steps[i]
        if (isHistorical(step.send.payloadType)) {
          const waited = await takeHistoricalToken()
          if (done) return
          if (this.dead || this.ws?.readyState !== WebSocket.OPEN) {
            finish(reject, new Error('cTrader WS closed while queued'))
            return
          }
          if (waited > 0) {
            clearTimeout(timer)
            timer = setTimeout(onTimeout, timeoutMs)
          }
        }
        const msgId = nextMsgId()
        this.inflight = { msgId, sentType: step.send.payloadType, onMsg, onFail }
        this.send({ clientMsgId: msgId, payloadType: step.send.payloadType, payload: step.send.payload })
      }

      function onMsg(msg) {
        seen.push(msg.payloadType)
        if (msg.payloadType === PT.ERROR_RES) {
          const e = msg.payload || {}
          finish(reject, new Error(`cTrader error: ${e.errorCode || 'unknown'} — ${e.description || ''}`))
          return
        }
        if (msg.payloadType === PT.ORDER_ERROR_EVENT) {
          const e = msg.payload || {}
          const posRef = e.positionId ? ` positionId=${e.positionId}` : ''
          finish(reject, new Error(`cTrader order rejected: ${e.errorCode || 'unknown'} — ${e.description || ''}${posRef}`))
          return
        }
        if (msg.payloadType !== steps[stepIdx]?.expect) return
        if (collectAll) collected.push(msg.payload || {})
        stepIdx++
        if (stepIdx >= steps.length) {
          finish(resolve, collectAll ? collected : (msg.payload || {}))
        } else {
          sendStep(stepIdx).catch(err => finish(reject, err))
        }
      }
      // sendStep installs `this.inflight` (with the real clientMsgId) before it
      // sends; nothing can arrive for us until then, so there is deliberately
      // no placeholder here — an inflight entry with an empty msgId would make
      // isUnsolicited's clientMsgId veto pass anything.
      sendStep(0).catch(err => finish(reject, err))
    })
  }
}

/** account key -> Session[] */
const pool = new Map()

// How a socket gets opened. Overridable so the ctrader-ws.js WIRING — not just
// this module in isolation — can be tested without a broker; wsRun does not
// thread a connect function through, and untested wiring is how a correct
// module ends up never being called.
let connectImpl = (url) => new WebSocket(url)
export function _setConnectForTests(fn) { connectImpl = fn || ((url) => new WebSocket(url)) }

/** Test seam — drop every session without waiting for idle timers. */
export function _resetPool() {
  for (const list of [...pool.values()]) {
    for (const s of [...list]) s.destroy(new Error('reset'))
  }
  pool.clear()
}

/** Open/busy socket counts, for /health. */
export function poolStatus() {
  const all = [...pool.values()].flat()
  return { accounts: pool.size, sockets: all.length, max: POOL_SIZE, busy: all.filter(s => s.busy).length }
}

/**
 * Acquire a session for this account, opening one if the pool has room.
 *
 * Selection is least-recently-used among idle sessions; if every session is
 * busy and the pool is full, the caller waits on the one that has been busy
 * longest. Callers are already bounded by SCAN_CONCURRENCY and the historical
 * token bucket, so no queue of its own is needed here.
 */
function acquire(key, opts) {
  let mine = pool.get(key)
  if (!mine) { mine = []; pool.set(key, mine) }
  const free = mine.filter(s => !s.busy && !s.dead)
  if (free.length) return free.sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0]
  if (mine.length < POOL_SIZE) {
    const s = new Session(key, opts)
    mine.push(s)
    return s
  }
  // Pool full and everything busy. Hand back the longest-idle one anyway:
  // Session.run serialises on the socket, and callers are already bounded by
  // SCAN_CONCURRENCY and the historical token bucket, so a queue here would
  // only duplicate limits that exist upstream.
  return mine.filter(s => !s.dead).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0] || (() => {
    const s = new Session(key, opts)
    mine.push(s)
    return s
  })()
}

/**
 * Run `steps` over a pooled, pre-authenticated connection.
 *
 * Same contract as wsRun's post-auth portion: resolves with the last step's
 * payload, or every step's payload when `collectAll`.
 */
export async function pooledRun(host, appAuth, accountAuth, steps, timeoutMs, collectAll, deps) {
  const key = `${host}|${appAuth.clientId}|${accountAuth.ctidTraderAccountId}|${accountAuth.accessToken}`
  const s = await acquire(key, {
    host, appAuth, accountAuth,
    connect: deps.connect || connectImpl,
    log: deps.log || (() => {}),
  })
  await s.open()
  return s.run(steps, timeoutMs, collectAll, deps.takeHistoricalToken, deps.isHistorical)
}
