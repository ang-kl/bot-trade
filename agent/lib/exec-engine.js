// ---------------------------------------------------------------------------
// agent/lib/exec-engine.js — order-path delegator. Default ('js') is a thin
// passthrough to ctrader-ws.js so behaviour stays byte-identical; EXEC_ENGINE
// =cpp routes the same calls to the C++ sidecar over HTTP. loop.js
// matches on 'order rejected' and 'POSITION_NOT_FOUND' in error messages, so
// sidecar error bodies are surfaced verbatim in thrown Error messages.
// ---------------------------------------------------------------------------

export function execEngineMode() {
  return process.env.EXEC_ENGINE === 'cpp' ? 'cpp' : 'js'
}

// ---------------------------------------------------------------------------
// SIDECAR-DOWN FALLBACK (incident 2026-07-29). When the sidecar loses its
// broker session, cpp mode used to simply fail every order, close and amend
// for the duration — while Node's own complete implementation of the same
// operations sat unused. `withFallback` retries on the JS path, but ONLY when
// lib/exec-fallback.js can prove the sidecar did not act. See that file: it
// refuses far more often than it allows, because a wrong "yes" here places a
// live order twice.
//
// Enabled by default; EXEC_FALLBACK=0 disables it and restores the old
// fail-hard behaviour.
// ---------------------------------------------------------------------------
const fallbackEnabled = () => String(process.env.EXEC_FALLBACK ?? '1') !== '0'

/** Records every fallback so an engine switch can never be discovered later from P&L alone. */
let onFallback = (note) => console.warn(`[exec] ${note}`)
export function setFallbackReporter(fn) { onFallback = typeof fn === 'function' ? fn : onFallback }

async function withFallback(op, cppFn, jsFn, base) {
  try {
    return await cppFn()
  } catch (err) {
    if (!fallbackEnabled()) throw err
    const { mayFallbackToJs, fallbackNote } = await import('./exec-fallback.js')
    // Ask the sidecar whether it holds a broker session. A short timeout: this
    // runs on an already-failing path and must not add latency to an order.
    //
    // `base` is the sidecar the failing call went to. Pinging any OTHER one
    // would answer a question nobody asked — a healthy live sidecar must never
    // be read as evidence that the demo sidecar did not act.
    let connected = null
    let reachable = true
    try {
      const h = await pingSidecar({ timeoutMs: 2_000, base })
      connected = h?.connected ?? null
      reachable = h?.ok === true || h?.connected !== undefined
    } catch { reachable = false }

    const verdict = mayFallbackToJs({ op, sidecarConnected: connected, err, sidecarReachable: reachable })
    if (!verdict.fallback) throw err
    try { onFallback(fallbackNote(op, verdict.reason)) } catch { /* logging must never break execution */ }
    return jsFn()
  }
}

// Dynamic import keeps the ws module (and its socket deps) out of the process
// entirely when the sidecar handles execution.
async function ws() {
  return import('../lib/ctrader-ws.js')
}

// ---------------------------------------------------------------------------
// THE ROUTING SEAM (Phase 1 of the two-sidecar plan, 2026-08-05).
//
// One ExecEngine holds exactly one broker host for its whole life
// (cpp-exec/src/engine.cpp — POST /connect with a different host TEARS DOWN the
// existing session rather than adding one). So live and demo accounts cannot
// share a sidecar process, and on 05-08 they did not share one: all four demo
// accounts sat `enabled = 1` in the registry and absent from the single
// sidecar's authorised roster, every dispatch short-circuited at the
// connectivity gate, and no trade opened for twelve hours.
//
// `execBase()` was a no-arg global returning ONE url, which is why nothing in
// Node could express "the demo account's sidecar". This function is the seam
// that makes it expressible.
//
// MIGRATION PROPERTY: with only EXEC_URL set — today's deployment — every host
// resolves to the same single base and nothing changes. The split happens later
// by setting one env var, and unsetting it rolls back.
//
// An UNKNOWN host also falls back to the default rather than throwing. Node
// must not be the thing that decides a host is illegitimate: the sidecar
// refuses a host that disagrees with its own (Phase 3), which is enforcement at
// the boundary rather than a guess in the caller.
// ---------------------------------------------------------------------------
export const EXEC_HOST_LIVE = 'live.ctraderapi.com'
export const EXEC_HOST_DEMO = 'demo.ctraderapi.com'

/** @param {{host?: string}|string} [credsOrHost] */
export function execBaseFor(credsOrHost) {
  const fallback = process.env.EXEC_URL || 'http://127.0.0.1:8091'
  const raw = typeof credsOrHost === 'string' ? credsOrHost : credsOrHost?.host
  const host = String(raw || '').trim().toLowerCase()
  if (host === EXEC_HOST_LIVE) return process.env.EXEC_URL_LIVE || fallback
  if (host === EXEC_HOST_DEMO) return process.env.EXEC_URL_DEMO || fallback
  return fallback
}

async function sidecar(base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${process.env.EXEC_SECRET || ''}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // Bounded (2026-08-01 audit #2): with no timeout, a sidecar wedged behind
    // its reconcile mutex hung the CALLER — the profit keeper's exit call
    // just sat there, and exec-fallback never saw an error to act on. 30s is
    // above every sidecar-side request timeout, so a genuine slow answer
    // still lands; only a wedge aborts.
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  if (!res.ok) {
    // Preserve the sidecar/broker text verbatim — callers match substrings.
    throw new Error(text || `exec sidecar ${res.status} on ${path}`)
  }
  return text ? JSON.parse(text) : null
}

// The sidecar holds no broker credentials of its own — the access token and
// account id live in the keeper's DB. Push them before the first call and
// again whenever they change (token refresh, account switch).
//
// KEYED BY BASE URL, not global. Two sidecars hold two independent sessions,
// and a scalar memo would let a push to the live sidecar satisfy the demo
// sidecar's check — the demo process would then serve orders having never been
// sent any credentials at all. With one base configured this map holds exactly
// one entry and behaves as the scalar did.
const lastPushedKey = new Map()

// M4 finding (2026-07-24): when the SIDECAR alone restarts (env change,
// crash, Railway redeploy of just that service) it loses its credentials,
// but this memo still matches — so every ensureSidecarSession call returns
// without pushing and the broker session never comes back until the AGENT
// restarts. The heartbeat probe calls this when it sees hasCredentials:false
// on a live sidecar, forcing the next ensure (or its own re-push) through.
// Clears EVERY base. Its callers mean "forget everything we believe about the
// sidecar session" — a partial clear would leave exactly the stale belief they
// are trying to discard.
export function invalidateSidecarSession() {
  lastPushedKey.clear()
}

// Explicit re-push for the probe path: invalidate + ensure in one call.
// Safe to call with not-ready creds (returns false, pushes nothing).
export async function pushSidecarSession(creds) {
  if (!creds?.ready) return false
  invalidateSidecarSession()
  await ensureSidecarSession(creds)
  return true
}
async function ensureSidecarSession(creds) {
  // M2: the sidecar multiplexes many ctidTraderAccountIds on ONE session
  // (same host+token). Re-pushing /connect for another account under the
  // same token is an incremental AccountAuth server-side — no reconnect —
  // so the memo key only needs to cover the (host, token, account) triple.
  // creds.accountIds (optional) pre-authorizes a whole roster in one push.
  //
  // THE ROSTER IS NO LONGER SORTED HERE. It used to be, and that discarded the
  // one piece of information the order carries: ctrader-creds.js:46 builds
  // `[primary, ...others]` on purpose, and engine.cpp resolves an unstamped
  // operation to accountIds_.front(). Sorting made `[A,B]` and `[B,A]` hash
  // identically, so the memo asserted two sessions with DIFFERENT primaries
  // were the same session.
  //
  // Be clear about what this line does and does not fix. It does not fix
  // routing — withAccount() below does that, by making the sidecar's default
  // unreachable from Node. What it fixes is the memo telling us something
  // untrue about the session we hold. The cost is an extra /connect when the
  // primary changes; engine.cpp takes its sameSession branch for that push, so
  // it is one cheap HTTP call and no reconnect.
  const roster = Array.isArray(creds.accountIds) && creds.accountIds.length
    ? creds.accountIds.join(',')
    : String(creds.accountId)
  const base = execBaseFor(creds)
  const key = `${creds.host}|${roster}|${creds.accessToken}`
  if (key === lastPushedKey.get(base)) return
  await sidecar(base, 'POST', '/connect', {
    host: creds.host,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    accessToken: creds.accessToken,
    accountId: creds.accountId,
    ...(Array.isArray(creds.accountIds) && creds.accountIds.length
      ? { accountIds: creds.accountIds }
      : {}),
  })
  lastPushedKey.set(base, key)
}

// Option 4: hand the profit keeper's trail specs to the sidecar's
// tick-level ratchet (POST /trail-config, full replace — push [] to clear).
// cpp mode only; BEST-EFFORT by contract: any failure returns false and the
// keeper carries on — its own 3s ratchet remains the fallback. Never
// throws, never blocks the keeper on a broken sidecar.
export async function pushTrailConfig(creds, positions) {
  if (execEngineMode() !== 'cpp') return false
  try {
    await ensureSidecarSession(creds)
    const r = await sidecar(execBaseFor(creds), 'POST', '/trail-config', { positions: Array.isArray(positions) ? positions : [] })
    // The sidecar now reports specs it REFUSED (bad dir / missing ids) —
    // surface the coverage gap instead of letting "sent N" read as "tracking N".
    if (r && Number(r.rejected) > 0) {
      console.log(`[exec] trail-config: sidecar rejected ${r.rejected} spec(s) — those positions are NOT tick-trailed (keeper ratchet still covers them)`)
    }
    return true
  } catch {
    return false // sidecar down or TRAIL_TICK_ENABLED unset — keeper's own ratchet still runs
  }
}

// Backtest fast-path: cpp mode POSTs the payload to the sidecar's /backtest
// (no /connect push — the backtester needs no broker session) and returns the
// parsed {trades, stats, wf} body; a non-2xx response throws so the caller
// can decide. js mode returns null WITHOUT any HTTP call — the caller falls
// back to the JS engine.
export async function backtestRemote(payload) {
  if (execEngineMode() !== 'cpp') return null
  // DELIBERATELY the default base, not a routed one. The backtester pushes no
  // credentials and touches no account, so it has no side to be on; either
  // sidecar answers identically. Routing it would invent a choice that does
  // not exist.
  return sidecar(execBaseFor(), 'POST', '/backtest', payload)
}

// Liveness probe of the C++ engine for the heartbeat monitor. js mode is
// trivially "alive" (execution happens in-process); cpp mode polls the
// sidecar's unauthenticated GET /health, which also reports whether its
// broker session is up and when it last reconciled.
export async function pingSidecar({ timeoutMs = 5_000, base = execBaseFor() } = {}) {
  if (execEngineMode() !== 'cpp') return { ok: true, mode: 'js' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    // Authenticated: the sidecar now serves the account roster on /health
    // ONLY to a bearer-carrying caller when EXEC_SECRET is set (the bare
    // response keeps ok/connected/counts for Railway's probe).
    const res = await fetch(base + '/health', {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${process.env.EXEC_SECRET || ''}` },
    })
    const body = await res.json().catch(() => null)
    return {
      ok: res.ok && body?.ok === true,
      mode: 'cpp',
      connected: body?.connected ?? null,
      hasCredentials: body?.hasCredentials ?? null,
      lastReconcileAt: body?.lastReconcileAt ?? null,
      // THE AUTHORISED ROSTER, which this function used to drop on the floor.
      // The sidecar has always reported it (cpp-exec/src/main.cpp GET /health
      // → "accounts"), but building the return object field-by-field silently
      // omitted it, so heartbeat.js's rosterDrift(r.accounts, …) compared
      // against `undefined` on every probe: `missing` was always the whole
      // registry, drift was ALWAYS true, the session was re-pushed every ~2
      // minutes, and `extra` — authorisation the owner revoked, the direction
      // that actually matters — could never fire at all. The drift check
      // appeared to work only because an unconditional re-push does converge
      // the roster.
      // null means "the sidecar did not tell us", which is NOT the same as
      // "the sidecar has no accounts" — rosterDrift now honours that difference.
      accounts: Array.isArray(body?.accounts) ? body.accounts : null,
      ...(res.ok ? {} : { error: `health ${res.status}` }),
    }
  } catch (e) {
    return { ok: false, mode: 'cpp', error: String(e?.message || e) }
  } finally {
    clearTimeout(t)
  }
}

// Which accounts the sidecar's broker session has actually AUTHORIZED right
// now — the connectivity truth the per-account sweeps gate on. With five
// enabled registry rows and one account failing AccountAuth, the sweeps used
// to probe the dead account every cycle anyway and eat a timeout + error per
// loop; the roster lets them skip it honestly until it reappears.
//
// Semantics are deliberately fail-OPEN:
//   - cpp mode, healthy sidecar → the roster array (as strings)
//   - cpp mode, sidecar unreachable / roster not reported → null = UNKNOWN —
//     callers must probe as before, because "the health endpoint blipped"
//     must never silently stop reconciling every account
//   - js mode → null: every broker call opens its own socket, so there is no
//     persistent session for an account to be disconnected FROM
//
// CACHED PER BASE. One sidecar's roster is not evidence about another's, and a
// shared cache entry would hand the demo sidecar's callers the live sidecar's
// answer for up to the TTL — the exact confusion this whole seam exists to end.
const rosterCache = new Map() // baseUrl -> {at, accounts}
export async function sidecarRoster({ ttlMs = 20_000, timeoutMs = 4_000, base = execBaseFor() } = {}) {
  if (execEngineMode() !== 'cpp') return null
  const now = Date.now()
  const hit = rosterCache.get(base)
  if (hit && now - hit.at < ttlMs) return hit.accounts
  const h = await pingSidecar({ timeoutMs, base })
  const accounts = h.ok && h.connected === true && Array.isArray(h.accounts)
    ? h.accounts.map(String)
    : null
  rosterCache.set(base, { at: now, accounts })
  return accounts
}

/**
 * The authorised roster of the sidecar that serves ONE side.
 *
 * Phase 2 of the two-sidecar plan. Every roster consumer was asking a no-arg
 * `sidecarRoster()` — i.e. `EXEC_URL`'s sidecar — and then comparing the answer
 * against accounts from BOTH sides. With one sidecar that is harmless, because
 * there is only one roster to be right about. Under a split it is the 05-08
 * outage rebuilt on purpose: the demo accounts would be measured against the
 * live sidecar's roster, found absent, and skipped before the (correctly
 * routed) order path was ever reached.
 *
 * Callers must ask per ACCOUNT SIDE, not once per pass. With only EXEC_URL set
 * both sides resolve to the same base and the 20s cache makes the second call
 * free, so nothing changes today.
 *
 * @param {boolean} isLive
 */
export async function sidecarRosterForSide(isLive, opts = {}) {
  return sidecarRoster({ ...opts, base: execBaseFor(isLive ? EXEC_HOST_LIVE : EXEC_HOST_DEMO) })
}

/** Both sides at once, for a caller that gates a mixed list of accounts. */
export async function sidecarRostersBySide(opts = {}) {
  // Sequential, not Promise.all: with one base configured the first call
  // populates the cache and the second is a map lookup. Racing them would
  // issue two identical HTTP probes for no benefit.
  const live = await sidecarRosterForSide(true, opts)
  const demo = await sidecarRosterForSide(false, opts)
  return { live, demo }
}

/** The roster relevant to one account row, honouring the fail-open contract. */
export function rosterForAccount(rosters, isLive) {
  return isLive ? rosters?.live ?? null : rosters?.demo ?? null
}

// P10: read-back of the C++ tick-level ratchet (GET /trail-status) so Node
// can journal each ratchet as a position_event — the sidecar itself must
// never write the DB directly. js mode / a disabled trail engine both
// return {enabled:false} rather than throwing; the caller (profit-keeper's
// pass) treats that as "nothing to diff".
export async function getTrailStatus(creds, { timeoutMs = 5_000 } = {}) {
  if (execEngineMode() !== 'cpp') return { enabled: false }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    await ensureSidecarSession(creds)
    const res = await fetch(execBaseFor(creds) + '/trail-status', {
      signal: ctrl.signal,
      headers: { authorization: `Bearer ${process.env.EXEC_SECRET || ''}` },
    })
    const body = await res.json().catch(() => null)
    if (!res.ok || !body) return { enabled: false }
    return body
  } catch {
    return { enabled: false }
  } finally {
    clearTimeout(t)
  }
}

// Bracket guarantee, engine-agnostic (item #4). The C++ core enforces this
// too, but the DEFAULT js path went straight to the broker — so this is the
// parity guard: a MARKET order with no stop attached is a naked position and
// is refused here, unless the caller explicitly sets allowNaked. Mirrors
// cpp-exec/src/order_guard.cpp so both engines behave identically.
export function orderHasBracket(p) {
  const num = (k) => Number(p?.[k])
  return num('relativeStopLoss') > 0 || num('stopLoss') > 0
}

// Owner-approved risk-gate change (2026-07-22): several open positions had
// no Take Profit at all — SL-only was never enough to call a trade "managed"
// (owner: "that is dangerous"). Mirrors orderHasBracket's shape exactly.
export function orderHasTarget(p) {
  const num = (k) => Number(p?.[k])
  return num('relativeTakeProfit') > 0 || num('takeProfit') > 0
}

export function validateOrderBracket(p) {
  const type = (p?.orderType || 'MARKET')
  const isMarket = type === 'MARKET' || type === 'MARKET_RANGE'
  if (isMarket && p?.allowNaked !== true) {
    if (!orderHasBracket(p)) {
      return { ok: false, reason: 'guard_naked_order: market order has no stop loss attached (set allowNaked to override)' }
    }
    if (!orderHasTarget(p)) {
      return { ok: false, reason: 'guard_no_target: market order has no take profit attached (set allowNaked to override)' }
    }
  }
  return { ok: true }
}

// 5A global-guard enforcement on the JS path (multi-account plan): the C++
// order_guard enforces halt + maxOrderVolume atomically, but the default js
// exec path went straight to the broker — the kill switch only worked when
// EXEC_ENGINE=cpp. This mirrors order_guard.cpp's halt/volume-cap verdicts
// (same reason strings — callers match substrings) so BOTH engines refuse
// identically. The guard rides in on creds.execGuard (attached by
// getCtraderCreds from exec_guard_json); callers that assemble creds by hand
// simply have no guard, exactly as before.
export function validateExecGuard(orderPayload, guard) {
  if (!guard || typeof guard !== 'object') return { ok: true }
  if (guard.halt === true) {
    return { ok: false, reason: 'guard_halt: execution halted by kill switch' }
  }
  const cap = Number(guard.maxOrderVolume)
  if (cap > 0 && Number(orderPayload?.volume) > cap) {
    return { ok: false, reason: 'guard_volume_cap: order volume exceeds the configured max' }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// ACCOUNT STAMPING — Phase 2, owner-approved 2026-07-30.
//
// THE BUG THIS CLOSES (characterised in agent/multi-account-routing.
// characterisation.test.js, written up in docs/multi-account-exit-routing-
// 2026-07-30.md). Twelve exit call sites pass a positionId and nothing else, so
// engine.cpp:276-280 filled in ctidTraderAccountId from its own primary — and
// the primary is elected once per broker session and then frozen, because
// setCredentials' sameSession branch only appends ids and never reorders them.
// The effect was that on every account except the primary, positions opened
// normally and were then never managed: the stop ratchet, the giveback close,
// the loss cap, the time cap and the weekend bank all failed with
// POSITION_NOT_FOUND, each one logging and carrying on by design.
//
// WHY HERE AND NOT AT THE CALL SITES. Twelve sites is twelve chances to forget,
// and the thirteenth caller has not been written yet. Every one of them already
// hands us `creds`, so the account is available at the chokepoint. Stamping here
// makes the sidecar's default UNREACHABLE from Node, which is the property worth
// having — not "all current callers happen to be correct".
//
// A MISMATCH IS AN ERROR, NOT A PREFERENCE. If a payload names one account and
// the credentials name another, someone is confused about which account this
// operation belongs to, and guessing either way risks acting on the wrong one.
// Every caller today derives both from the same id (loop.js:418,
// pending-orders.js:332, closed-market-limits.js:217 all pass creds.accountId),
// so this cannot fire on current code — it is here to catch the next caller.
//
// The JS/ws path was never affected: wsClosePosition and friends build the
// payload from their `accountId` argument and ignore any id in `args`. Stamping
// at the delegator is harmless there and keeps one rule for both engines.
// ---------------------------------------------------------------------------

/** The account this operation belongs to, or an error explaining why we can't tell. */
export function resolveOrderAccount(creds, payload) {
  const fromCreds = creds?.accountId == null || creds.accountId === '' ? null : Number(creds.accountId)
  const raw = payload?.ctidTraderAccountId
  const fromPayload = raw == null || raw === '' ? null : Number(raw)

  if (fromPayload != null && Number.isFinite(fromPayload)) {
    if (fromCreds != null && Number.isFinite(fromCreds) && fromCreds !== fromPayload) {
      return { ok: false, reason: `guard_account_mismatch: payload names account ${fromPayload} but the credentials name ${fromCreds} — refusing to guess which one this belongs to` }
    }
    return { ok: true, accountId: fromPayload }
  }
  if (fromCreds == null || !Number.isFinite(fromCreds)) {
    return { ok: false, reason: 'guard_no_account: neither the payload nor the credentials name an account — refusing to let the broker pick one' }
  }
  return { ok: true, accountId: fromCreds }
}

/** payload + an explicit ctidTraderAccountId. Throws rather than send an ambiguous write. */
function withAccount(creds, payload) {
  const r = resolveOrderAccount(creds, payload)
  if (!r.ok) throw new Error(r.reason)
  return { ...(payload && typeof payload === 'object' ? payload : {}), ctidTraderAccountId: r.accountId }
}

/**
 * Coerce the fields the broker protocol types as int64 to actual NUMBERS.
 *
 * PRODUCTION BUG 2026-07-31: `Position close (LLM) FAILED: Corn — Couldn't
 * parse integer: For input string: ""233934803"" (INVALID_REQUEST)`. The id
 * comes from trades.ctrader_position_id, which is a TEXT column, and the
 * sidecar forwards its /close body into the broker JSON verbatim — so the
 * broker received `"positionId":"233934803"` where the protocol demands an
 * integer, and the close failed on EVERY retry. The Node/ws path was immune
 * only because wsClosePosition parseInts its own payload; the sidecar path
 * had no such coercion, which made the two engines disagree about the same
 * arguments. One rule at the delegator, same as withAccount above.
 *
 * Only finite results are written back: a malformed id stays as it was so the
 * broker rejects it VISIBLY rather than a NaN turning into a silent null.
 */
export function withNumericIds(args) {
  const out = { ...(args && typeof args === 'object' ? args : {}) }
  for (const k of ['positionId', 'orderId', 'volume', 'ctidTraderAccountId']) {
    if (out[k] == null || out[k] === '') continue
    const n = Number(String(out[k]).replace(/^"+|"+$/g, ''))
    if (Number.isFinite(n)) out[k] = n
  }
  return out
}

/**
 * INVARIANT 3 — ATOMIC ORDER IDEMPOTENCY.
 * (bot_trade_remediation_plan_aligned.md §2.4.3, acceptance §2.6.3)
 *
 * 04-08-2026, 23:31:48: seventeen identical DOW.US sells, deal ids
 * DID312704298-DID312704314, one second, -$1,615.00.
 *
 * A 20-MINUTE DEDUPE ALREADY EXISTED and did not fire. loop.js:565 says why in
 * its own words: those orders "never reached the gate - they carry
 * risk_event_id NULL and were adopted by the reconciler 89 seconds after
 * filling". The window was never the missing piece. The missing piece is that
 * a window living in ONE CALLER cannot protect the paths that do not call it.
 *
 * So this sits at the boundary instead. `placeOrder` is the single funnel every
 * order passes through - pending-orders.js, closed-market-limits.js, autoTrade
 * and the manual routes all arrive here - which makes it the only place a lock
 * covers the path that actually doubled. The plan asks for this in
 * pending-orders.js; putting it there would have left the market-order path
 * uncovered, which is the same shape of mistake as the gate it replaces.
 *
 * IN-MEMORY, AND THAT IS THE RIGHT SCOPE. The failure is a re-entrant event
 * loop inside one process, and JavaScript's single thread makes the read and
 * the write below genuinely atomic: there is no `await` between them, so no
 * second dispatch can interleave. A SQLite lock would add durability across
 * restarts and buy nothing against the storm this exists to stop.
 *
 * THE KEY CARRIES NO TIME AT ALL, AND THAT IS THE POINT. The contract's
 * formula is hash(accountId + symbol + strategy + direction + signalTimestamp),
 * but a millisecond timestamp inside the key defeats the key: seventeen
 * dispatches a few milliseconds apart would hash seventeen different ways and
 * every one would pass.
 *
 * The first fix for that BUCKETED the timestamp to the TTL window
 * (`Math.floor(now / 60_000)`), which collapsed the burst but quietly bought a
 * different hole: buckets are fixed wall-clock windows, so two identical
 * orders 2ms apart that straddle a boundary — 11:59:59.999 and 12:00:00.001 —
 * hash differently and BOTH dispatch. Invariant 3 says "within 60 seconds",
 * which is a ROLLING window; a bucket is not one. The DOW.US storm was 89ms
 * wide, so a burst landing on a boundary would have split and leaked an order
 * from each side.
 *
 * So the key is pure identity, and the 60-second window lives where it always
 * belonged: in the lock's EXPIRY. Claim stamps `now + TTL`; any identical
 * order before that expiry is refused, whatever the wall clock says.
 */
const ORDER_LOCK_TTL_MS = 60_000
const orderLocks = new Map()

export function orderIdempotencyKey(payload) {
  return [
    payload?.ctidTraderAccountId ?? '',
    payload?.symbolId ?? '',
    payload?.tradeSide ?? '',
    payload?.orderType ?? '',
    // The strategy rides in the structured label; a fib entry and a trend
    // entry on the same symbol and side are different intents, not a double.
    String(payload?.label ?? '').split('|')[2] ?? '',
  ].join('|')
}

/** Exposed for tests and for the /state readout. */
export function _orderLockState() {
  return { size: orderLocks.size, keys: [...orderLocks.keys()] }
}

/**
 * TEST HOOK ONLY. Deliberately not called from anywhere in the running system:
 * a runtime path that can clear this map is a runtime path that can re-enable
 * the storm. Tests need it because two cases legitimately place the SAME order
 * twice — checking argument delegation, and checking that a demo order never
 * reaches the live sidecar — and outside a test that repetition is the bug.
 */
export function _resetOrderLocks() {
  orderLocks.clear()
}

export function claimOrderLock(payload, nowMs = Date.now()) {
  // Sweep first so a long-running process does not accumulate dead keys.
  for (const [k, exp] of orderLocks) if (exp <= nowMs) orderLocks.delete(k)
  const key = orderIdempotencyKey(payload)
  const held = orderLocks.get(key)
  if (held != null && held > nowMs) return { ok: false, key, msLeft: held - nowMs }
  orderLocks.set(key, nowMs + ORDER_LOCK_TTL_MS)
  return { ok: true, key }
}

export async function placeOrder(creds, orderPayload) {
  const g = validateExecGuard(orderPayload, creds?.execGuard)
  if (!g.ok) throw new Error(g.reason)
  const v = validateOrderBracket(orderPayload)
  if (!v.ok) throw new Error(v.reason)
  // Throws on an unresolvable or contradictory account, BEFORE the guard-passed
  // order can reach either engine.
  orderPayload = withNumericIds(withAccount(creds, orderPayload))
  // AFTER withAccount, so the key carries the resolved account rather than
  // whatever the caller happened to pass, and BEFORE any await, so the claim
  // cannot interleave with a second dispatch.
  const lock = claimOrderLock(orderPayload)
  if (!lock.ok) {
    const err = new Error(
      `DUPLICATE_ORDER_DISPATCH_BLOCKED: an identical order (${lock.key}) was already sent ` +
      `${((ORDER_LOCK_TTL_MS - lock.msLeft) / 1000).toFixed(1)}s ago — ` +
      `${(lock.msLeft / 1000).toFixed(1)}s left on the ${ORDER_LOCK_TTL_MS / 1000}s idempotency lock`,
    )
    err.code = 'DUPLICATE_ORDER_DISPATCH_BLOCKED'
    throw err
  }
  try {
    if (execEngineMode() === 'cpp') {
      return await withFallback('order',
        async () => { await ensureSidecarSession(creds); return sidecar(execBaseFor(creds), 'POST', '/order', orderPayload) },
        async () => {
          const m = await ws()
          return m.wsPlaceOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, orderPayload)
        }, execBaseFor(creds))
    }
    const m = await ws()
    return await m.wsPlaceOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, orderPayload)
  } catch (err) {
    // A DEFINITE REJECTION RELEASES THE LOCK. loop.js already draws this line
    // for its own dedupe and draws it correctly: "a plain order_failed —
    // broker REJECTED it, provably no position — is NOT caught here, so
    // ordinary rejections still retry next cycle as before."
    //
    // The asymmetry is the whole point. Holding the key after a reject costs
    // an entry for no safety: the broker has told us nothing was opened.
    // Releasing after an AMBIGUOUS failure — a timeout, a dropped socket, a
    // lost EXECUTION_EVENT — would re-arm the storm against a position that
    // may well be live, which is the expensive direction. So anything that is
    // not provably a rejection keeps the lock for its full 60 seconds.
    if (isDefiniteRejection(err)) releaseOrderLock(lock.key)
    throw err
  }
}

/**
 * Provably-not-filled, from the broker's own words. Deliberately narrow: the
 * default for an unrecognised failure is to KEEP the lock, because the cost of
 * being wrong runs one way (a duplicate live position) and not the other.
 */
export function isDefiniteRejection(err) {
  const m = `${err?.message || ''}`
  return /order rejected|\bREJECTED\b|MARKET_CLOSED|INVALID_REQUEST|TRADING_BAD_VOLUME|NOT_ENOUGH_MONEY/i.test(m)
}

function releaseOrderLock(key) {
  orderLocks.delete(key)
}

/** Push the atomic guard config to the C++ sidecar (#3). No-op in js mode. */
export async function setExecGuard(creds, cfg) {
  if (execEngineMode() !== 'cpp') return { ok: true, mode: 'js' }
  await ensureSidecarSession(creds)
  return sidecar(execBaseFor(creds), 'POST', '/config', cfg)
}

export async function amendPosition(creds, args) {
  args = withNumericIds(withAccount(creds, args))
  if (execEngineMode() === 'cpp') {
    return withFallback('amend',
      async () => { await ensureSidecarSession(creds); return sidecar(execBaseFor(creds), 'POST', '/amend', args) },
      async () => {
        const m = await ws()
        return m.wsAmendPosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
      }, execBaseFor(creds))
  }
  const m = await ws()
  return m.wsAmendPosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
}

export async function closePosition(creds, args) {
  args = withNumericIds(withAccount(creds, args))
  if (execEngineMode() === 'cpp') {
    return withFallback('close',
      async () => { await ensureSidecarSession(creds); return sidecar(execBaseFor(creds), 'POST', '/close', args) },
      async () => {
        const m = await ws()
        return m.wsClosePosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
      }, execBaseFor(creds))
  }
  const m = await ws()
  return m.wsClosePosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
}

export async function cancelOrder(creds, { orderId }) {
  // cancelOrder always built its own body from creds.accountId and so was never
  // part of the exit gap — but it goes through the same helper now, so there is
  // exactly one rule about where an account comes from and one error to read
  // when it cannot be determined.
  const acct = withNumericIds(withAccount(creds, { orderId }))
  if (execEngineMode() === 'cpp') {
    return withFallback('cancel',
      async () => { await ensureSidecarSession(creds); return sidecar(execBaseFor(creds), 'POST', '/cancel', acct) },
      async () => {
        const m = await ws()
        return m.wsCancelOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, { orderId })
      }, execBaseFor(creds))
  }
  const m = await ws()
  return m.wsCancelOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, { orderId })
}

/**
 * Should a failed sidecar reconcile fall back to the WS path? Returns the
 * reason string to log, or null to re-throw.
 *
 * Everything falls back EXCEPT credential/permission failures. Those are the
 * sidecar answering correctly that WE are misconfigured, and silently reading
 * around them would leave a broken EXEC_SECRET undetected forever — trading
 * one invisible failure for another. Every other error means "no answer from
 * the sidecar", and for a read that is simply a reason to ask elsewhere.
 */
export function reconcileFallbackReason(err) {
  const m = `${err?.message ?? err ?? ''}`.trim()
  // UNAVAILABILITY ONLY — "nobody answered", not "the answer was an error".
  //
  // The distinction is deliberate and three existing tests depend on it. A
  // sidecar that replies 500, or replies NOT_CONNECTED because it lost its
  // broker session, is UP and telling us something true; reading around that
  // would hide a state that needs fixing (the M4 credential-memo deadlock is
  // only detectable because those calls fail). A sidecar that cannot be
  // reached at all is a different thing entirely, and for a pure read there is
  // no reason to fail with a working alternative available.
  const unavailable = new RegExp([
    'no reconcile data yet',            // up, not ready yet — the original case
    'Application failed to respond',    // Railway's own 502 page: the six-day outage
    '\\b(502|503|504)\\b',
    'bad gateway', 'service unavailable', 'gateway time-?out',
    'fetch failed', 'socket hang up',
    'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
    'aborted', 'timeout',
  ].join('|'), 'i')
  if (!unavailable.test(m)) return null
  return (m.slice(0, 200) || 'unknown sidecar error')
}

export async function reconcile(creds) {
  if (execEngineMode() === 'cpp') {
    // The sidecar's own reconcile loop hasn't completed a single pass yet
    // (just started, reconnecting after a drop, etc) — GET /positions 503s
    // with "no reconcile data yet" the whole time. Owner hit this live:
    // pending-order-manager failed on every tick, and the main loop's own
    // reconcile phase failing before reaching weekend-bank's heartbeat call
    // left it looking STALLED too — one sidecar hiccup took out two
    // unrelated controllers. Fall back to the JS/WS reconcile path instead
    // of hard-failing every caller; the sidecar resumes owning reconcile
    // again the moment it reports data.
    try {
      await ensureSidecarSession(creds)
      // M2: ask for THIS account's snapshot (the sidecar reconciles every
      // authorized account). An older sidecar binary without the POST route
      // 404s — fall back to the legacy GET (primary-account view), which is
      // identical in the single-account era.
      try {
        return await sidecar(execBaseFor(creds), 'POST', '/positions', { ctidTraderAccountId: parseInt(creds.accountId) })
      } catch (err) {
        if (!/404|not found/i.test(err.message)) throw err
        return await sidecar(execBaseFor(creds), 'GET', '/positions')
      }
    } catch (err) {
      // WHY THIS IS BROADER THAN IT LOOKS. This used to fall back ONLY on
      // /no reconcile data yet/ — a sidecar that is UP but not yet ready. It
      // did not recognise a sidecar that is DOWN, and the two are the same
      // situation from here: nobody can answer, and reconcile is a pure READ
      // with a working alternative sitting right there.
      //
      // Measured cost of the narrow version: the cpp-exec service was
      // unavailable from 2026-08-04, every reconcile threw on Railway's 502
      // ("Application failed to respond"), and the whole phase died with it —
      // no position sync, no broker_orders ledger, no protection audit — for
      // SIX DAYS, until the service happened to redeploy. `broker_orders` was
      // still empty days later, which is why resting orders at the broker
      // were invisible to every view that reads it.
      //
      // Orders/amends/closes already do this properly via withFallback() and
      // mayFallbackToJs(), which weigh whether a WRITE might have landed
      // twice. Reconcile is the one exec path that hand-rolled its own check,
      // and a read needs no such care — re-reading is free.
      const reason = reconcileFallbackReason(err)
      if (reason == null) throw err
      try { onFallback(`reconcile: sidecar unusable (${reason}) — reading via the WS path`) } catch { /* logging must never break the read */ }
      const m = await ws()
      return m.wsReconcile(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)
    }
  }
  const m = await ws()
  return m.wsReconcile(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)
}
