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
      // LOTS need a lot: the keeper's importer stores centi-units / the
      // broker's lotSize, so the verifier is told that lotSize (contract 3).
      // Only the broker's own declaration travels — never the hardcoded
      // contract table, which would scale the broker's figure by a guess.
      // Absent → cpp-verify leaves the volume uncompared and says so.
      lotSize: Number(record.lot_size) > 0 ? Number(record.lot_size) : undefined,
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

  // WHICH HOSTS THIS CLIENT HAS OPENED A SESSION FOR.
  //
  // cpp-verify holds ONE SESSION PER HOST and answers only for accounts that
  // session was authorized on (its I17 check). Nothing in this process ever
  // called POST /connect, so every /verify returned 409 "no session for
  // host … POST /connect first" — and the 409 was swallowed as a null state,
  // so 38 re-armed records came back `0 verified` with no error line.
  //
  // Measured 18-09-2026: cpp-verify's /health reported "sessions":[] while
  // the drain reported 10 captured · 0 verified, four passes running.
  //
  // Per PROCESS, not persisted: the verifier holds its sessions in memory and
  // a restart drops them, so a cached "yes" that outlived the service would
  // be worse than no cache. A 409 clears the entry and reconnects once.
  const connected = new Set()

  async function connect(brokerHost, creds, timeoutMs) {
    const { clientId, clientSecret, accessToken, accountId } = creds || {}
    if (!clientId || !clientSecret || !accessToken || !accountId) return { ok: false, reason: 'no_credentials' }
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      const res = await fetchImpl(`${base}/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ host: brokerHost, clientId, clientSecret, accessToken, accountIds: [Number(accountId)] }),
        signal: ctl.signal,
      })
      if (!res.ok) return { ok: false, reason: `connect_http_${res.status}` }
      const body = await res.json().catch(() => null)
      // `authorized` counts the accounts the broker actually accepted. A 200
      // with zero authorized is a FAILURE to connect, not a session: treating
      // it as one would send every later /verify into a guaranteed 403.
      if (!body || !(Number(body.authorized) > 0)) return { ok: false, reason: 'connect_no_accounts' }
      connected.add(brokerHost)
      return { ok: true, authorized: Number(body.authorized) }
    } catch (e) {
      return { ok: false, reason: e.name === 'AbortError' ? 'connect_timeout' : `connect_${e.message}` }
    } finally {
      clearTimeout(timer)
    }
  }

  return async function verify(record, { host = null, timeoutMs = DEFAULT_TIMEOUT_MS, ...creds } = {}) {
    const brokerHost = host || String(env.CTRADER_HOST || '').trim()
    if (!brokerHost) return { state: null, skipped: 'no_host' }

    if (!connected.has(brokerHost)) {
      const c = await connect(brokerHost, creds, timeoutMs)
      if (!c.ok) return { state: null, skipped: c.reason }
    }

    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      let res = await fetchImpl(`${base}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify(verifyRequestFor(record, { host: brokerHost })),
        signal: ctl.signal,
      })
      // A 409 means the session went away under us — cpp-verify restarted, or
      // it was never there. Reconnect and try ONCE. Not a loop: a second 409
      // is a real condition and must be reported, not retried into silence.
      if (res.status === 409) {
        connected.delete(brokerHost)
        const c = await connect(brokerHost, creds, timeoutMs)
        if (!c.ok) return { state: null, skipped: c.reason }
        res = await fetchImpl(`${base}/verify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify(verifyRequestFor(record, { host: brokerHost })),
          signal: ctl.signal,
        })
      }
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
        // PR-AY: the contract the VERIFIER used, relayed unchanged. Absent
        // means an older binary that did not stamp one — which is stale, and
        // must NOT be filled in with the keeper's own constant.
        contractVersion: Number.isFinite(Number(body.contractVersion)) ? Number(body.contractVersion) : null,
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
