// ---------------------------------------------------------------------------
// agent/lib/inflight.js — the in-flight broker-call registry.
//
// Wave 5 of docs/first-principles-audit-2026-09-19.md §K item 15: "the
// watchdog logs the stuck call, not just the phase". Until this file the loop
// watchdog (loop.js startLoopWatchdog) could say `stuck in phase "scanning 1
// symbols"` and nothing else — the phase is a label written before the work,
// and a phase is dozens of broker round-trips. Which one hung was Railway log
// archaeology.
//
// WHAT IS REGISTERED. Every call that can wait on something outside this
// process: wsRun (ctrader-ws.js, the legacy per-call socket), the pooled
// session's run() (ctrader-session.js — where the QUEUE wait lives, which the
// per-step timer never covered) and the exec sidecar's HTTP calls
// (exec-engine.js sidecar()). beginCall returns a token; endCall retires it;
// inflightCalls() lists what is still open, oldest first.
//
// THE STATE KEY. The oldest open call is also stamped to `loop_inflight_json`
// at most once per STAMP_MIN_MS, so a reading survives the process the
// watchdog is about to kill: /health reads the in-memory registry while the
// process is alive; the stamp is for after the fact. The watchdog forces one
// last stamp before it exits.
//
// PROCESS-WIDE, in-memory. A token that is never ended (a caller that threw
// between begin and end) would sit in the map forever and be reported as the
// oldest call on every read — so every wiring site ends the call in a
// `finally`, and inflightCalls() also drops entries older than STALE_MS as a
// belt to that brace (a real broker call cannot be open for an hour; a
// registry entry can).
// ---------------------------------------------------------------------------

import { PT } from './ctrader-payload-types.js'

export const INFLIGHT_KEY = 'loop_inflight_json'
export const STAMP_MIN_MS = 2_000
/** An entry older than this is a leaked token, not a call — dropped on read. */
export const STALE_MS = 60 * 60_000

const calls = new Map() // token → { name, symbol, accountId, startedAt }
let seq = 0
let stampDb = null
let lastStampAt = 0
let setStateImpl = null

/**
 * Give the registry a db to stamp into. Called once at boot by whoever owns
 * the db (loop.js startLoop); without it the registry still works in memory
 * and simply never stamps. `setState` is injected so this lib does not import
 * db.js (ctrader-ws.js must stay free of the db).
 */
export function configureInflight({ db = null, setState = null } = {}) {
  stampDb = db
  setStateImpl = typeof setState === 'function' ? setState : null
  lastStampAt = 0
}

const PT_NAME = (() => {
  const m = new Map()
  for (const [k, v] of Object.entries(PT)) m.set(v, k)
  return m
})()

/** The last-4 account form every log line in this repo uses. */
export function shortAccount(accountId) {
  if (accountId == null || accountId === '') return null
  return `…${String(accountId).slice(-4)}`
}

/**
 * Name a wsRun/session step list: the request the caller came for (the last
 * step, past the auth pair), what it is about (symbolId / positionId /
 * orderId when the payload carries one) and the account from the auth step
 * or the payload. Pure; never throws on a malformed step list.
 */
export function describeSteps(steps, accountId = null) {
  let name = 'ws:unknown'
  let symbol = null
  let acct = accountId
  try {
    const list = Array.isArray(steps) ? steps : []
    const last = list[list.length - 1]
    const pt = last?.send?.payloadType
    name = `ws:${PT_NAME.get(pt) || pt || 'unknown'}`
    const p = last?.send?.payload || {}
    if (p.symbolId != null) symbol = Array.isArray(p.symbolId) ? `symbolId ${p.symbolId.slice(0, 3).join(',')}${p.symbolId.length > 3 ? '…' : ''}` : `symbolId ${p.symbolId}`
    else if (p.symbolName != null) symbol = String(p.symbolName)
    else if (p.positionId != null) symbol = `position ${p.positionId}`
    else if (p.orderId != null) symbol = `order ${p.orderId}`
    for (const s of list) {
      if (s?.send?.payloadType === PT.ACCOUNT_AUTH_REQ && s.send.payload?.ctidTraderAccountId != null) { acct = s.send.payload.ctidTraderAccountId; break }
    }
    if (acct == null && p.ctidTraderAccountId != null) acct = p.ctidTraderAccountId
  } catch { /* a description is never worth a throw */ }
  return { name, symbol, accountId: acct == null ? null : String(acct) }
}

/** Register a call. Returns the token endCall takes. */
export function beginCall({ name, symbol = null, accountId = null } = {}, now = Date.now()) {
  const token = ++seq
  calls.set(token, { name: String(name || 'unknown'), symbol: symbol == null ? null : String(symbol), accountId: accountId == null ? null : String(accountId), startedAt: now })
  maybeStamp(now)
  return token
}

/** Retire a call. Unknown tokens are ignored (a double end is harmless). */
export function endCall(token, now = Date.now()) {
  calls.delete(token)
  maybeStamp(now)
}

/** Open calls, oldest first, each with its age in ms. Leaked entries are dropped. */
export function inflightCalls(now = Date.now()) {
  const out = []
  for (const [token, c] of calls) {
    if (now - c.startedAt > STALE_MS) { calls.delete(token); continue }
    out.push({ ...c, ms: now - c.startedAt })
  }
  out.sort((a, b) => a.startedAt - b.startedAt)
  return out
}

export function oldestInflight(now = Date.now()) {
  return inflightCalls(now)[0] || null
}

/** What /health serves: `{ oldest: {...} | null, count }`. */
export function inflightSummary(now = Date.now()) {
  const list = inflightCalls(now)
  return { oldest: list[0] || null, count: list.length }
}

/** `11m42s` / `42s` / `850ms` */
export function fmtMs(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0))
  if (n < 1000) return `${n}ms`
  const s = Math.round(n / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

/** One line for a call: `ws:GET_TRENDBARS_REQ symbolId 1 (…0949) for 11m42s`. */
export function describeCall(c) {
  if (!c) return 'none'
  const acct = shortAccount(c.accountId)
  return `${c.name}${c.symbol ? ` ${c.symbol}` : ''}${acct ? ` (${acct})` : ''} for ${fmtMs(c.ms)}`
}

/**
 * Stamp the oldest call (or null) to INFLIGHT_KEY, at most once per
 * STAMP_MIN_MS unless forced. Cheap on purpose: begin/end are on the hot
 * path of every broker call. Never throws.
 */
export function maybeStamp(now = Date.now(), force = false) {
  if (!stampDb || !setStateImpl) return false
  if (!force && now - lastStampAt < STAMP_MIN_MS) return false
  lastStampAt = now
  try {
    const s = inflightSummary(now)
    setStateImpl(stampDb, INFLIGHT_KEY, JSON.stringify({ at: new Date(now).toISOString(), count: s.count, oldest: s.oldest }))
    return true
  } catch { return false }
}

export function _resetInflightForTests() {
  calls.clear()
  seq = 0
  lastStampAt = 0
}
