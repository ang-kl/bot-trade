// When the C++ sidecar cannot reach the broker, fall back to Node's own
// WebSocket order path instead of failing.
//
// WHY (incident 2026-07-29). The heartbeat read "C++ exec engine STALLED ·
// broker session down — sidecar is reconnecting to cTrader" from 07:58. While
// that lasts, EXEC_ENGINE=cpp routes every order, close and amend into a
// service with no broker link, and they simply fail. Node has a complete,
// tested implementation of the identical operations (ctrader-ws.js) sitting
// unused the whole time.
//
// WHY NOT A SECOND SIDECAR (the owner asked). A second copy of the same code,
// with the same credentials, against the same broker, stops working at the
// same instant for the same reason — cTrader was unreachable, the sidecar was
// not broken. And two sidecars authorised on one account is a DOUBLE-EXECUTION
// hazard: the M2 work deliberately keeps one broker session per account so two
// writers can never both act on one position. This gives redundancy without a
// second service and without a second concurrent writer.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONLY RULE THAT MATTERS
//
// Falling back after an order MIGHT have reached the broker would place the
// same trade twice. So a write may only be retried on the JS path when the
// sidecar PROVABLY did not act. Exactly two situations qualify:
//
//   1. The sidecar is up and says `connected: false` — it holds no broker
//      session, so it cannot have submitted anything. This is the incident
//      case, and it is the strong one.
//
//   2. The HTTP request never reached the sidecar at all: connection refused,
//      DNS failure, or a socket error before any response byte. Nothing was
//      sent, so nothing was executed.
//
// Everything else is AMBIGUOUS and must fail rather than retry. A timeout
// after the request body went out is the dangerous case: the sidecar may have
// filled the order and only the reply was lost. That is precisely the shape
// behind the 4x duplicate USDIDR incident, and it is why this file refuses
// far more often than it allows.
//
// Reads (positions, reconcile) are idempotent, so they may always fall back.
// ─────────────────────────────────────────────────────────────────────────────

/** Operations that change money. Anything not listed is treated as a read. */
export const WRITE_OPS = Object.freeze(['order', 'close', 'amend', 'cancel'])

export const isWriteOp = (op) => WRITE_OPS.includes(op)

// Node/undici surfaces "the request never got out" through these. Matched on
// the error CODE where possible, since messages are not stable across runtimes.
const PRE_SUBMIT_CODES = new Set([
  'ECONNREFUSED',  // nothing listening — the sidecar process is down
  'ENOTFOUND',     // DNS never resolved
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ECONNRESET',    // see the guard in preSubmitFailure — only pre-response
])

/**
 * Did this failure provably happen BEFORE anything reached the sidecar?
 *
 * Deliberately narrow. `ECONNRESET` counts only when nothing was received —
 * a reset mid-response means the request WAS processed and the answer was
 * lost, which is the ambiguous case.
 */
export function preSubmitFailure(err) {
  if (!err) return false
  const code = err.cause?.code || err.code || ''
  if (!PRE_SUBMIT_CODES.has(code)) return false
  if (code === 'ECONNRESET' && err.responseStarted === true) return false
  return true
}

/**
 * May this operation be retried on the JS path?
 *
 * @param {{op:string, sidecarConnected:boolean|null, err?:Error, sidecarReachable?:boolean}} ctx
 * @returns {{fallback:boolean, reason:string}}
 */
export function mayFallbackToJs({ op, sidecarConnected, err, sidecarReachable = true } = {}) {
  const write = isWriteOp(op)

  // (1) The sidecar answered and told us it has no broker session. It cannot
  // have acted, whatever else happened. Safe for reads AND writes.
  if (sidecarReachable && sidecarConnected === false) {
    return { fallback: true, reason: 'sidecar has no broker session (connected:false) — it cannot have executed' }
  }

  // (2) The request never left. Nothing was submitted.
  if (preSubmitFailure(err)) {
    return { fallback: true, reason: `request never reached the sidecar (${err.cause?.code || err.code}) — nothing was submitted` }
  }

  // Reads are idempotent: a second attempt cannot move money.
  if (!write) {
    if (err) return { fallback: true, reason: 'read operation — a retry cannot change any position' }
    return { fallback: false, reason: 'sidecar answered' }
  }

  // Everything else. A timeout, a 5xx, an aborted response — the sidecar may
  // have filled and lost the reply. Refusing here is the whole point.
  return {
    fallback: false,
    reason: err
      ? 'ambiguous sidecar failure on a write — the order may already be live at the broker; refusing to resubmit'
      : 'sidecar is connected',
  }
}

/**
 * Human-readable line for the action log / Telegram when a fallback fires.
 * Every fallback is recorded: silently switching execution engines mid-flight
 * is exactly the kind of thing that must never be discovered later from P&L.
 */
export function fallbackNote(op, reason) {
  return `exec fallback: ${op} routed to the Node WS path — ${reason}`
}
