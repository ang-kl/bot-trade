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
// sidecar PROVABLY did not act — and "provably" means an attestation about
// THIS REQUEST, never an inference from state observed around it.
//
// Exactly two things qualify:
//
//   1. The sidecar answered THIS request with `errorCode: NOT_CONNECTED`.
//      engine.cpp checks `ws_.isOpen()` and returns that BEFORE `sendText` —
//      so not one byte of this order was written to the broker socket. It is
//      the sidecar telling us, about this specific call, that it refused it.
//      This is the incident case.
//
//   2. The HTTP request never reached the sidecar process at all: connection
//      refused, DNS failure, host/network unreachable. The connection was
//      never established, so the request bytes never left.
//
// Everything else is AMBIGUOUS and must fail rather than retry.
//
// TWO THINGS THAT LOOK LIKE PROOF AND ARE NOT (both found in review of the
// first version of this file, both of which would have placed live orders
// twice):
//
//   · A `/health` probe reporting `connected: false`, taken AFTER the failing
//     call. If the sidecar's broker socket dropped mid-request — after the
//     order went out, before the reply came back — the order may be live at
//     the broker and the probe still says disconnected. The snapshot describes
//     the sidecar NOW; it says nothing about the moment of submission. Health
//     is advisory here and never authorises a write.
//
//   · `ECONNRESET`. A reset can arrive after the sidecar read and executed the
//     request, with the response lost. undici does not tell us which side of
//     execution the reset fell on, so it is ambiguous by construction. The
//     first version guarded this with a `responseStarted` flag that nothing
//     ever set, which made every reset look pre-submit.
//
// A timeout after the body went out is the same shape: the sidecar may have
// filled and only the reply was lost. That is precisely the 4x duplicate
// USDIDR incident, and it is why this file refuses far more often than it
// allows. The asymmetry is the whole design — a refused fallback costs one
// failed order; a wrong one costs a doubled live position.
//
// Reads (positions, reconcile) are idempotent, so they may always fall back.
// ─────────────────────────────────────────────────────────────────────────────

/** Operations that change money. Anything not listed is treated as a read. */
export const WRITE_OPS = Object.freeze(['order', 'close', 'amend', 'cancel'])

export const isWriteOp = (op) => WRITE_OPS.includes(op)

// Node/undici surfaces "the connection was never established" through these.
// Matched on the error CODE, since messages are not stable across runtimes.
//
// ECONNRESET is deliberately ABSENT — see the header. A reset proves only that
// the connection died, not that it died before the request was acted on.
const PRE_SUBMIT_CODES = new Set([
  'ECONNREFUSED',  // nothing listening — the sidecar process is down
  'ENOTFOUND',     // DNS never resolved
  'EHOSTUNREACH',
  'ENETUNREACH',
])

/**
 * Did this failure provably happen BEFORE the connection was even established?
 *
 * Deliberately narrow: only codes that mean no TCP connection existed, so no
 * request bytes can have been written.
 */
export function preSubmitFailure(err) {
  if (!err) return false
  const code = err.cause?.code || err.code || ''
  return PRE_SUBMIT_CODES.has(code)
}

/**
 * Did the sidecar attest, about THIS request, that it never sent it?
 *
 * cpp-exec/src/engine.cpp `request()` returns
 *   {"errorCode":"NOT_CONNECTED","description":"websocket is not connected"}
 * from a check that runs BEFORE `ws_.sendText`, surfaced as an HTTP 502 whose
 * body `sidecar()` throws verbatim. So this string is a per-call statement of
 * non-submission — not a guess about the sidecar's general state.
 *
 * SEND_FAILED is NOT accepted. `sendText` failing mid-frame is unlikely to
 * reach the broker as a valid length-prefixed message, but "unlikely" is not
 * "provably not", and the cost of being wrong is a duplicate live position.
 */
export function sidecarAttestsNotSent(err) {
  if (!err) return false
  const msg = String(err.message || '')
  // Match the JSON field rather than a bare substring, so a broker
  // *description* that merely mentions the phrase cannot be mistaken for the
  // sidecar's own code.
  return /"errorCode"\s*:\s*"NOT_CONNECTED"/.test(msg)
}

/**
 * May this operation be retried on the JS path?
 *
 * @param {{op:string, sidecarConnected:boolean|null, err?:Error, sidecarReachable?:boolean}} ctx
 *   sidecarConnected is ADVISORY ONLY — a health snapshot taken around the
 *   call. It never authorises a write. See the header.
 * @returns {{fallback:boolean, reason:string}}
 */
export function mayFallbackToJs({ op, sidecarConnected, err, sidecarReachable = true } = {}) {
  const write = isWriteOp(op)

  // (1) The sidecar answered THIS request saying it never reached the socket.
  if (sidecarAttestsNotSent(err)) {
    return {
      fallback: true,
      reason: 'sidecar refused this request with NOT_CONNECTED before sending — it provably did not execute',
    }
  }

  // (2) The connection was never established, so nothing was written.
  if (preSubmitFailure(err)) {
    return {
      fallback: true,
      reason: `request never reached the sidecar (${err.cause?.code || err.code}) — nothing was submitted`,
    }
  }

  // Reads are idempotent: a second attempt cannot move money.
  if (!write) {
    if (err) return { fallback: true, reason: 'read operation — a retry cannot change any position' }
    // A health snapshot saying the sidecar holds no session is worth acting on
    // for a read (go get the data from Node instead), and only for a read.
    if (sidecarReachable && sidecarConnected === false) {
      return { fallback: true, reason: 'read operation and the sidecar reports no broker session' }
    }
    return { fallback: false, reason: 'sidecar answered' }
  }

  // Every other write outcome. A timeout, a 5xx, an aborted response, or a
  // health probe that merely LOOKS conclusive — the sidecar may have filled
  // and lost the reply. Refusing here is the whole point.
  return {
    fallback: false,
    reason: err
      ? 'ambiguous sidecar failure on a write — the order may already be live at the broker; refusing to resubmit'
      : 'sidecar answered',
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
