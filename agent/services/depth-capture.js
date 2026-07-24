// ---------------------------------------------------------------------------
// agent/services/depth-capture.js — L2 depth snapshot at order submit
// (Performance Ledger collect-forward, slice 2 of the depth build).
//
// The C++ sidecar maintains per-symbol books from ProtoOADepthEvent frames
// (see cpp-exec/src/depth_book.hpp) and serves them on POST /depth. This
// module grabs a snapshot around order submission and reduces it to the two
// stored columns:
//   depth_json      — the raw book ({at, bids:[{price,sizeCents}], asks:[…]})
//   depth_imbalance — (Σbid − Σask) / (Σbid + Σask) over the top levels,
//                     +1 all-bid … −1 all-ask
//
// Honesty rules match the rest of collect-forward: null whenever depth is
// off (DEPTH_FEED_ENABLED unset sidecar-side), the subscription was rejected
// by the broker, the book is empty, the sidecar is unreachable, or the exec
// engine isn't the sidecar at all — never a fabricated or partial value.
// Capture is best-effort with a short timeout; it must never block or fail
// an order write.
// ---------------------------------------------------------------------------

/**
 * Size-weighted top-of-book imbalance in [-1, 1], or null when the book
 * can't support an honest number (missing, empty, or zero total size).
 *
 * @param {{bids?: Array<{sizeCents:number}>, asks?: Array<{sizeCents:number}>}|null} book
 * @param {number} levels max levels per side to include
 * @returns {number|null}
 */
export function depthImbalance(book, levels = 10) {
  if (!book || typeof book !== 'object') return null
  const sum = (side) => (Array.isArray(side) ? side : [])
    .slice(0, Math.max(1, levels))
    .reduce((acc, l) => acc + (Number.isFinite(Number(l?.sizeCents)) ? Number(l.sizeCents) : 0), 0)
  const bid = sum(book.bids)
  const ask = sum(book.asks)
  const total = bid + ask
  if (total <= 0) return null
  return Math.round(((bid - ask) / total) * 10000) / 10000
}

/**
 * Fetch the sidecar's current book for a symbol and reduce it to the stored
 * columns. Resolves {depthJson, depthImbalance} — both null unless a real
 * non-empty book came back.
 *
 * @param {number} symbolId cTrader symbol id
 * @param {{levels?: number, timeoutMs?: number}} [opts]
 * @returns {Promise<{depthJson: string|null, depthImbalance: number|null}>}
 */
export async function captureDepthAtEntry(symbolId, { levels = 10, timeoutMs = 1500 } = {}) {
  const none = { depthJson: null, depthImbalance: null }
  // Depth books live in the C++ sidecar only — in js exec mode there is no
  // process holding one, so the honest answer is "not collected".
  if (process.env.EXEC_ENGINE !== 'cpp') return none
  if (!Number.isFinite(Number(symbolId)) || Number(symbolId) <= 0) return none
  try {
    const base = process.env.EXEC_URL || 'http://127.0.0.1:8091'
    const res = await fetch(`${base}/depth`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.EXEC_SECRET || ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ symbolId: Number(symbolId), levels }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return none
    const body = await res.json()
    // `active` distinguishes a live subscription from off/rejected; a null
    // book under an active subscription is "no events yet" — still null.
    if (!body || body.active !== true || !body.book || typeof body.book !== 'object') return none
    const imb = depthImbalance(body.book, levels)
    return { depthJson: JSON.stringify(body.book), depthImbalance: imb }
  } catch {
    return none // unreachable/timeout — capture never blocks the trade write
  }
}
