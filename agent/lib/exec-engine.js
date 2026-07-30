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

async function withFallback(op, cppFn, jsFn) {
  try {
    return await cppFn()
  } catch (err) {
    if (!fallbackEnabled()) throw err
    const { mayFallbackToJs, fallbackNote } = await import('./exec-fallback.js')
    // Ask the sidecar whether it holds a broker session. A short timeout: this
    // runs on an already-failing path and must not add latency to an order.
    let connected = null
    let reachable = true
    try {
      const h = await pingSidecar({ timeoutMs: 2_000 })
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

function execBase() {
  return process.env.EXEC_URL || 'http://127.0.0.1:8091'
}

async function sidecar(method, path, body) {
  const res = await fetch(execBase() + path, {
    method,
    headers: {
      authorization: `Bearer ${process.env.EXEC_SECRET || ''}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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
let lastPushedKey = ''

// M4 finding (2026-07-24): when the SIDECAR alone restarts (env change,
// crash, Railway redeploy of just that service) it loses its credentials,
// but this memo still matches — so every ensureSidecarSession call returns
// without pushing and the broker session never comes back until the AGENT
// restarts. The heartbeat probe calls this when it sees hasCredentials:false
// on a live sidecar, forcing the next ensure (or its own re-push) through.
export function invalidateSidecarSession() {
  lastPushedKey = ''
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
  const key = `${creds.host}|${roster}|${creds.accessToken}`
  if (key === lastPushedKey) return
  await sidecar('POST', '/connect', {
    host: creds.host,
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
    accessToken: creds.accessToken,
    accountId: creds.accountId,
    ...(Array.isArray(creds.accountIds) && creds.accountIds.length
      ? { accountIds: creds.accountIds }
      : {}),
  })
  lastPushedKey = key
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
    await sidecar('POST', '/trail-config', { positions: Array.isArray(positions) ? positions : [] })
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
  return sidecar('POST', '/backtest', payload)
}

// Liveness probe of the C++ engine for the heartbeat monitor. js mode is
// trivially "alive" (execution happens in-process); cpp mode polls the
// sidecar's unauthenticated GET /health, which also reports whether its
// broker session is up and when it last reconciled.
export async function pingSidecar({ timeoutMs = 5_000 } = {}) {
  if (execEngineMode() !== 'cpp') return { ok: true, mode: 'js' }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(execBase() + '/health', { signal: ctrl.signal })
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
    const res = await fetch(execBase() + '/trail-status', {
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

export async function placeOrder(creds, orderPayload) {
  const g = validateExecGuard(orderPayload, creds?.execGuard)
  if (!g.ok) throw new Error(g.reason)
  const v = validateOrderBracket(orderPayload)
  if (!v.ok) throw new Error(v.reason)
  // Throws on an unresolvable or contradictory account, BEFORE the guard-passed
  // order can reach either engine.
  orderPayload = withAccount(creds, orderPayload)
  if (execEngineMode() === 'cpp') {
    return withFallback('order',
      async () => { await ensureSidecarSession(creds); return sidecar('POST', '/order', orderPayload) },
      async () => {
        const m = await ws()
        return m.wsPlaceOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, orderPayload)
      })
  }
  const m = await ws()
  return m.wsPlaceOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, orderPayload)
}

/** Push the atomic guard config to the C++ sidecar (#3). No-op in js mode. */
export async function setExecGuard(creds, cfg) {
  if (execEngineMode() !== 'cpp') return { ok: true, mode: 'js' }
  await ensureSidecarSession(creds)
  return sidecar('POST', '/config', cfg)
}

export async function amendPosition(creds, args) {
  args = withAccount(creds, args)
  if (execEngineMode() === 'cpp') {
    return withFallback('amend',
      async () => { await ensureSidecarSession(creds); return sidecar('POST', '/amend', args) },
      async () => {
        const m = await ws()
        return m.wsAmendPosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
      })
  }
  const m = await ws()
  return m.wsAmendPosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
}

export async function closePosition(creds, args) {
  args = withAccount(creds, args)
  if (execEngineMode() === 'cpp') {
    return withFallback('close',
      async () => { await ensureSidecarSession(creds); return sidecar('POST', '/close', args) },
      async () => {
        const m = await ws()
        return m.wsClosePosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
      })
  }
  const m = await ws()
  return m.wsClosePosition(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, args)
}

export async function cancelOrder(creds, { orderId }) {
  // cancelOrder always built its own body from creds.accountId and so was never
  // part of the exit gap — but it goes through the same helper now, so there is
  // exactly one rule about where an account comes from and one error to read
  // when it cannot be determined.
  const acct = withAccount(creds, { orderId })
  if (execEngineMode() === 'cpp') {
    return withFallback('cancel',
      async () => { await ensureSidecarSession(creds); return sidecar('POST', '/cancel', acct) },
      async () => {
        const m = await ws()
        return m.wsCancelOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, { orderId })
      })
  }
  const m = await ws()
  return m.wsCancelOrder(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, { orderId })
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
        return await sidecar('POST', '/positions', { ctidTraderAccountId: parseInt(creds.accountId) })
      } catch (err) {
        if (!/404|not found/i.test(err.message)) throw err
        return await sidecar('GET', '/positions')
      }
    } catch (err) {
      if (!/no reconcile data yet/.test(err.message)) throw err
      const m = await ws()
      return m.wsReconcile(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)
    }
  }
  const m = await ws()
  return m.wsReconcile(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)
}
