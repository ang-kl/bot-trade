// The server-derived engine status, polled ONCE and shared by every mount
// (plan §13: "one server-derived engine status component with revision and
// freshness, rather than separate UI interpretations of flags"). Reads
// GET /state/entry-engines (requested/effective mode, transition, revision,
// epoch, counts) and GET /state/tick-readiness (the classed blockers). The
// UI never derives a mode from any other flag: what the gateway acknowledged
// is what is shown, and the age of the answer is shown beside it.
//
// Lives in lib/ because a component module may only export components
// (react-refresh/only-export-components); the sidebar line and the Accounts
// panel both subscribe here.
import { useEffect, useSyncExternalStore } from 'react'
import { agentGet, agentConfigured, pageAsleep } from './agent-api.js'
import { engineReadinessFor } from './engine-status-view.js'

const POLL_MS = 15_000
let snapshot = { engines: null, readiness: null, at: null, error: null, loading: false }
const listeners = new Set()
let timer = null
let inflight = null

function emit(next) {
  snapshot = { ...snapshot, ...next }
  for (const l of listeners) l()
}

export async function refreshEngineStatus() {
  if (inflight) return inflight
  if (!agentConfigured()) { emit({ error: 'agent not configured' }); return null }
  emit({ loading: true })
  inflight = (async () => {
    try {
      // `account=all` is explicit and wins over the viewed-account lens
      // (agent-api.js withViewedAccount): this panel shows every account's
      // row regardless of which one is being traded, so a narrowed answer
      // for just the viewed account is wrong here (checker BLOCKER 1).
      // /state/entry-engines is not lens-scoped at all (state.js), so it
      // needs no such override.
      const [engines, readiness] = await Promise.all([agentGet('/state/entry-engines'), agentGet('/state/tick-readiness?account=all')])
      emit({ engines, readiness, at: Date.now(), error: null, loading: false })
    } catch (e) {
      emit({ error: e?.message || String(e), loading: false })
    } finally { inflight = null }
  })()
  return inflight
}

/**
 * A refresh that is guaranteed to START after this call: if a poll is already
 * in flight its answer predates the action just taken, so wait for it and
 * then fetch again (PR-G, checker minor 10 — refreshEngineStatus alone
 * returns the in-flight poll and the switch would render a stale value).
 */
export async function refreshEngineStatusAfterAction() {
  if (inflight) { try { await inflight } catch { /* the fresh fetch below reports its own error */ } }
  return refreshEngineStatus()
}

function tick() {
  if (pageAsleep()) return
  refreshEngineStatus()
}

function subscribe(l) {
  listeners.add(l)
  if (listeners.size === 1) {
    tick()
    timer = setInterval(tick, POLL_MS)
  }
  return () => {
    listeners.delete(l)
    if (listeners.size === 0 && timer) { clearInterval(timer); timer = null }
  }
}
const getSnapshot = () => snapshot

/** Every account's engine status + readiness, and the age of the answer. */
export function useEngineStatus() {
  const s = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  useEffect(() => { /* subscription is the effect; nothing else to do */ }, [])
  return s
}

/**
 * The row for one account, matched by the redacted suffix the server prints,
 * with its readiness record joined by the row's OWN full identity
 * (routingAccountId) — never by suffix, and never assuming
 * `snap.readiness.accounts` exists: engineReadinessFor reads both shapes
 * GET /state/tick-readiness can answer (S1a), so a narrowed `?account=` read
 * (S3's viewed-account wiring) still joins for the matching row and reads
 * null — "no record" — for every other one, instead of null for all of them.
 */
export function engineRowFor(snap, accountId) {
  if (!snap?.engines?.accounts || accountId == null) return null
  const tail = String(accountId).slice(-4)
  const row = snap.engines.accounts.find(a => String(a.accountId).endsWith(tail)) || null
  if (!row) return null
  const ready = engineReadinessFor(snap.readiness, row.routingAccountId)
  return { ...row, readiness: ready }
}
