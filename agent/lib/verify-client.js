// agent/lib/verify-client.js — the Node side of cpp-verify.
//
// cpp-verify re-fetches a closed position's deals from cTrader and compares
// them against the record this process wrote. It exists so that nothing
// certifies its own work, which means this client's only job is to ASK and to
// carry the answer back unchanged. It must never decide a verdict itself:
// a `verified` that this process produced because the verifier was
// unreachable would be worse than no verification at all.
//
// UNCONFIGURED IS A STATE, NOT A FAILURE. `VERIFY_URL` is set by the owner
// once the Railway service exists. Until then `verifyClient()` returns null,
// the capture path skips verification, and every record stays `unverified` —
// which is exactly what it is. Nothing pretends otherwise, and `/health` says
// `verifier: unconfigured` rather than leaving a silent gap.

const DEFAULT_TIMEOUT_MS = 30_000

/** Build the request body cpp-verify's POST /verify expects. */
export function verifyRequestFor(record, { host, slackMs = 10 * 60_000 } = {}) {
  return {
    host,
    accountId: Number(record.account_id),
    // The window must CONTAIN the whole position, opening deal included —
    // cpp-verify answers `unverified` with "widen it" when the open falls
    // outside, and that answer would be ours to cause rather than the
    // broker's to report.
    fromMs: Number(record.opened_at_ms) - slackMs,
    toMs: Number(record.closed_at_ms) + slackMs,
    record: {
      positionId: Number(record.ctrader_position_id),
      symbolId: record.symbol_id ?? undefined,
      tradeSide: record.direction === 'short' ? 2 : 1,
      volume: record.volume,
      entryPrice: record.entry_price,
      exitPrice: record.exit_price,
      netPnl: record.net_pnl,
      openedAtMs: record.opened_at_ms,
      closedAtMs: record.closed_at_ms,
    },
  }
}

/**
 * A verifier, or null when one is not configured.
 *
 * `host` is the broker host the position's account trades on — cpp-verify
 * holds one session per host and answers for whichever it was connected to,
 * so this is routing, not a policy distinction between accounts.
 */
export function verifyClient({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = String(env.VERIFY_URL || '').trim().replace(/\/+$/, '')
  const secret = String(env.EXEC_SECRET || '').trim()
  if (!base || !secret || typeof fetchImpl !== 'function') return null

  return async function verify(record, { host = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const brokerHost = host || String(env.CTRADER_HOST || '').trim()
    if (!brokerHost) return { state: null, skipped: 'no_host' }

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${base}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify(verifyRequestFor(record, { host: brokerHost })),
        signal: ctl.signal,
      })
      if (!res.ok) return { state: null, skipped: `http_${res.status}` }
      const body = await res.json()
      // THE ANSWER IS CARRIED, NOT INTERPRETED. If cpp-verify says the fetch
      // was incomplete it answers `unverified`, and that is what gets stored:
      // a gap in ITS reading is not evidence about our record, and turning it
      // into anything else here would re-introduce the self-certification
      // this whole service exists to prevent.
      if (!body || typeof body.state !== 'string') return { state: null, skipped: 'bad_reply' }
      return {
        state: body.state,
        disputes: Array.isArray(body.disputes) ? body.disputes : [],
        host: brokerHost,
        fetchComplete: body.fetchComplete === true,
        broker: body.broker || null,
      }
    } catch (e) {
      return { state: null, skipped: e.name === 'AbortError' ? 'timeout' : e.message }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** For /health: say whether verification is on, and why not when it is off. */
export function verifierStatus(env = process.env) {
  const base = String(env.VERIFY_URL || '').trim()
  if (!base) return { configured: false, reason: 'VERIFY_URL not set' }
  if (!String(env.EXEC_SECRET || '').trim()) return { configured: false, reason: 'EXEC_SECRET not set' }
  return { configured: true, url: base.replace(/\/\/[^@]*@/, '//') }
}
