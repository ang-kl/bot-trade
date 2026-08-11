// A4 — four traffic lights per account, from data that actually exists.
//
// docs/per-account-control-plan.md §3. The owner asked whether these are
// needed. They are: with several accounts the most expensive mistake is
// believing an account is quiet when it isn't, and its inverse — thinking one
// is working when its broker session is down. Both are invisible today.
//
//   Link    broker session authorised, reconcile fresh
//   Scan    scanning, and not starved
//   Enter   armed, and not blocked by a guard
//   Manage  watching the positions that exist, all with stops
//
// ===========================================================================
// THE MANAGE LIGHT IS NOT A STATUS
// ===========================================================================
// Red on Manage means the plan's §1 invariant is violated — open exposure with
// nothing watching it. That is an alarm, not a state, and it should never be
// reachable through the API (archiveAccount refuses it). It is computed here
// anyway, because an invariant nobody checks is a comment.
//
// A position with no stop is AMBER, not red: it is being watched, and the
// naked-position guardian is the thing that will fix it. Red is reserved for
// "not watching at all".
//
// ===========================================================================
// WHAT THIS REFUSES TO DO
// ===========================================================================
// Every light can be `unknown`, and unknown is rendered as its own state
// rather than folded into green. A roster that has never been recorded, a
// controller that has never beaten, a symbol set nobody has scanned — those
// are absences of evidence, and a green light built on one would be exactly
// the "believing an account is quiet when it isn't" failure this exists to
// prevent.
//
// Nothing here is a per-account probe of the broker. The link facts available
// are the ROSTER (which accounts the token enumerated, and how fresh that is)
// and the reconcile heartbeat, which is process-wide. So the Link light is
// honest about being partly a process-level reading, and says so in its
// reason rather than implying a per-account session check that does not exist.
import { capabilityView } from './account-capabilities.js'
import { accountAtBroker, brokerRosterStatus } from './broker-roster.js'
import { heartbeatView } from './heartbeat.js'
import { loadGlobalGuards, evaluateGlobalGuards } from './global-guards.js'

export const LIGHTS = ['link', 'scan', 'enter', 'manage']
export const STATES = ['red', 'amber', 'green', 'unknown']

/** Worst-first ordering, so a row's overall state is a reduce. */
export function worstLight(a, b) {
  return STATES.indexOf(a) <= STATES.indexOf(b) ? a : b
}

const light = (state, reason) => ({ state, reason })

/**
 * @param {*} db
 * @param {{now?: number}} opts
 * @returns {{accounts: object[], rosterKnown: boolean, rosterFresh: boolean,
 *            globalHalt: boolean, generatedAt: string}}
 */
export function accountTrafficLights(db, { now = Date.now() } = {}) {
  const caps = capabilityView(db)

  const roster = safe(() => brokerRosterStatus(db, now), { known: false, fresh: false })
  const beats = safe(() => heartbeatView(db, { now: new Date(now) }), [])
  const byName = new Map(beats.map(b => [b.name, b]))

  // Portfolio-level halt: an account can be perfectly armed and still unable
  // to enter because the global layer said no. Reporting it as green Enter
  // would be the "thinking it's working when it isn't" half of the problem.
  const guards = safe(() => loadGlobalGuards(db), {})
  const guardEval = safe(() => evaluateGlobalGuards(db, guards), { ok: true })
  const globalHalt = guardEval.ok === false

  // Positions with no stop, per account. Amber on Manage.
  const stopless = new Map()
  try {
    for (const r of db.prepare(
      `SELECT COALESCE(account_id, '') AS acct, COUNT(*) AS c
         FROM monitored_positions
        WHERE status = 'active' AND current_sl IS NULL
        GROUP BY COALESCE(account_id, '')`
    ).all()) stopless.set(String(r.acct), Number(r.c || 0))
  } catch { /* old DB — treated as unknown below, never as zero */ }
  const stoplessKnown = stopless.size > 0 || tableReadable(db)

  const accounts = caps.map(a => {
    const id = a.accountId
    // Unstamped rows belong to whoever is asking, the same convention
    // openWork() uses — so they are added to this account's stopless count.
    const noStop = (stopless.get(id) || 0) + (stopless.get('') || 0)

    const lights = {
      link: linkLight(db, id, roster, byName, now),
      scan: scanLight(a, byName),
      enter: enterLight(a, globalHalt, guardEval),
      manage: manageLight(a, noStop, stoplessKnown),
    }
    const overall = LIGHTS.map(k => lights[k].state).reduce(worstLight, 'green')
    return { ...a, lights, overall }
  })

  return {
    accounts,
    rosterKnown: !!roster.known,
    rosterFresh: !!roster.fresh,
    globalHalt,
    globalHaltReason: globalHalt ? (guardEval.reason || 'global guard') : null,
    generatedAt: new Date(now).toISOString(),
  }
}

function linkLight(db, id, roster, byName, now) {
  if (!roster.known) return light('unknown', 'no broker account roster has been recorded yet')
  if (!roster.fresh) return light('unknown', 'the recorded broker roster is stale, so membership cannot be confirmed')
  const at = safe(() => accountAtBroker(db, id, now), null)
  if (at === false) return light('red', 'this account is not in the broker roster for the current token')
  if (at == null) return light('unknown', 'broker membership could not be determined')

  // Reconcile freshness is PROCESS-wide, not per account. Said plainly rather
  // than dressed up as a per-account session check.
  const rec = byName.get('main_loop')
  if (!rec || rec.status === 'idle') return light('amber', 'at the broker; the loop has not reconciled yet')
  if (rec.status === 'stalled' || rec.status === 'error') {
    return light('red', `at the broker, but the main loop is ${rec.status} — nothing is reconciling`)
  }
  if (rec.status === 'warn') return light('amber', 'at the broker; the main loop is reporting failures')
  return light('green', 'at the broker, and the loop is reconciling')
}

function scanLight(a, byName) {
  if (!a.scan) {
    return light('red', a.mode === 'archived' ? 'archived' : a.mode === 'registered' ? 'registered, not engaged' : `scanning is off in ${a.mode}`)
  }
  const loop = byName.get('main_loop')
  if (!loop || loop.status === 'idle') return light('unknown', 'scanning is on, but the loop has not reported yet')
  if (loop.status === 'stalled') return light('amber', 'scanning is on, but the loop is stalled — nothing is sweeping')
  return light('green', 'scanning')
}

function enterLight(a, globalHalt, guardEval) {
  if (!a.enter) {
    if (a.mode === 'archived') return light('red', 'archived')
    if (a.mode === 'registered') return light('red', 'registered, not engaged — enable it to trade')
    if (!a.enabled) return light('red', 'the account is disabled, so it is not in the sidecar roster')
    return light('red', `entries are off in ${a.mode}`)
  }
  if (globalHalt) return light('amber', `armed, but the portfolio guard is blocking: ${guardEval.reason || 'halted'}`)
  return light('green', 'armed')
}

function manageLight(a, stoplessCount, stoplessKnown) {
  if (!a.manage) {
    // The §1 alarm. Reachable only by writing the column directly.
    if (!a.flat) {
      return light('red', `NOT WATCHING while ${a.reasonsText || describeWork(a)} remain open`)
    }
    return light('unknown', `${a.mode === 'registered' ? 'registered' : 'archived'} and flat — nothing to manage`)
  }
  if (a.flat) return light('green', 'nothing open to manage')
  if (!stoplessKnown) return light('unknown', `watching ${describeWork(a)}; stop coverage unknown`)
  if (stoplessCount > 0) {
    return light('amber', `watching ${describeWork(a)}, but ${stoplessCount} position${stoplessCount === 1 ? ' has' : 's have'} no stop recorded`)
  }
  return light('green', `watching ${describeWork(a)}`)
}

function describeWork(a) {
  const bits = []
  if (a.positions > 0) bits.push(`${a.positions} position${a.positions === 1 ? '' : 's'}`)
  if (a.pendings > 0) bits.push(`${a.pendings} working order${a.pendings === 1 ? '' : 's'}`)
  return bits.join(' and ') || 'nothing'
}

function tableReadable(db) {
  try {
    db.prepare('SELECT 1 FROM monitored_positions LIMIT 1').get()
    return true
  } catch { return false }
}

function safe(fn, fallback) {
  try {
    const v = fn()
    return v === undefined ? fallback : v
  } catch { return fallback }
}
