// ---------------------------------------------------------------------------
// agent/services/stop-policy-controller.js — the desired-state controller for
// the stop policy (02-10-2026; owner: "Opposite for stop-loss and broker-side
// trailing").
//
// WHY A CONTROLLER. The policy is stamped on every amend the bot SENDS
// (exec-engine.amendPosition), but the bot's entries are MARKET/LIMIT orders
// with relative SL/TP and nothing amends a position after the fill — and the
// broker only takes a position's stop trigger from an amend. So a position
// that is never amended would never carry the policy. This pass sends, to each
// open position that has a stop, one `policyOnly` amend: the SIDECAR reads the
// live stop and target itself and re-sends them with the two policy fields, so
// Node never sends a stale level (the stored current_sl can be looser than a
// broker-trailed stop). When the broker already carries the policy the sidecar
// answers `unchanged` and sends nothing.
//
// SAFETY SHAPE
//   · BOTH BROKER SIDES. The band job is handed the SELECTED account's
//     credentials, which reach one host; every other account would be dropped
//     silently (ctrader-creds.js records that exact defect as F-RISK-01). So
//     this builds one context per side the way runProtectionAuditBothSides
//     does, and a side whose credentials are unavailable is an ERROR (the
//     heartbeat goes red), never a quiet gap. The policy has no demo/live split
//     (owner principle 1).
//   · CANARY FIRST, CONFIRMED BY A REAL STAMP. Until one amend has been applied
//     AND read back as confirmed, the passes are sequential and the first real
//     stamp ends its own pass. A no-op (the broker already carries the policy)
//     proves nothing about stamping, so it neither confirms the canary, nor
//     holds it, nor uses up its one stamp. A refusal, an error, a read-back that
//     disagrees or cannot vouch for it holds the whole controller for
//     CANARY_HOLD_MS.
//   · At most ONE policy call per account per pass; accounts run in parallel
//     once the canary is confirmed.
//   · SOFT DEADLINE. The band waits 5 s for a job and counts an overrun as
//     failed evidence, so no new broker call starts after SOFT_DEADLINE_MS; what
//     is left waits for the next pass.
//   · A position is not re-asked for RECHECK_MS after an outcome (6 h), or
//     RETRY_MS after an error: Spotware logged a read-back bug where
//     trailingStopLoss reads false when enabled, so "not confirmed" must not
//     become "stamp again every minute".
//   · Never stamps: a position with no broker stop (the naked-position guard's
//     job), a paused row, a keeper_opt_out row, a position with no monitored
//     row (nothing says its side or entry), or any position while the policy
//     is off.
//   · Momentum-book rows get the trigger method but never the trailing flag
//     (stopContext.book → lib/stop-policy.js; the book trails by its own rule).
//   · No manual broker order is involved: this is the bot applying its own
//     policy to its own protection, and the stop LEVEL never moves.
// ---------------------------------------------------------------------------
import { getStopPolicy, sideDirection, saveTrailingRegistry } from '../lib/stop-policy.js'
import { normPosId } from '../lib/pos-id.js'
import { setState } from '../db.js'
import { makeBookHeldCheck } from './book-held.js'

export const RECHECK_MS = 6 * 3600 * 1000
export const RETRY_MS = 5 * 60 * 1000
export const CANARY_HOLD_MS = 30 * 60 * 1000
export const SOFT_DEADLINE_MS = 3500
export const TRACKED_MAX = 2000

// In memory on purpose: it is a throttle, not a record. After a restart every
// position is asked once more, and the sidecar answers `unchanged` for the ones
// that already carry the policy.
const state = {
  canaryConfirmedAt: null,
  holdUntil: 0,
  lastAsk: new Map(),   // `${account}:${positionId}` -> { at, outcome }
  last: null,
}

export function resetStopPolicyController() {
  state.canaryConfirmedAt = null
  state.holdUntil = 0
  state.lastAsk = new Map()
  state.last = null
}

/** Remember one answer; the map is bounded (oldest dropped), so closed positions never accumulate. Exported for the bound's own test. */
export function remember(key, value) {
  state.lastAsk.delete(key)
  state.lastAsk.set(key, value)
  while (state.lastAsk.size > TRACKED_MAX) state.lastAsk.delete(state.lastAsk.keys().next().value)
}

/** When this controller last got a CONFIRMED answer for a position (stamped or already compliant), else null. */
export function confirmedAt(accountId, positionId) {
  const v = state.lastAsk.get(`${accountId}:${normPosId(positionId)}`)
  return v && (v.outcome === 'stamped' || v.outcome === 'compliant') ? v.at : null
}

export function stopPolicyControllerView() {
  return {
    canaryConfirmedAt: state.canaryConfirmedAt,
    holdUntil: state.holdUntil || null,
    tracked: state.lastAsk.size,
    last: state.last,
    unverifiable: [...state.lastAsk.entries()].filter(([, v]) => v.outcome === 'unverifiable').map(([k]) => k),
  }
}

/** What the sidecar's `policy` block says about one stamp. */
export function classifyOutcome(result, error) {
  if (error) return 'error'
  const p = result?.policy
  if (!p) return 'no_policy_block'
  if (p.refused) return 'refused'
  if (p.skipped === 'cooldown') return 'cooldown'
  if (p.readback === 'confirmed') return p.applied ? 'stamped' : 'compliant'
  if (p.readback === 'mismatch') return 'mismatch'
  // unreadable / unverified / none: the amend went (or nothing was due) but the
  // broker's read-back cannot vouch for it — reported, never read as drift.
  return 'unverifiable'
}

/**
 * One credential context per broker side, the way runProtectionAuditBothSides
 * builds them (naked-position-guard.js): the base credentials for their own
 * side, and for the other side the credentials of its first enabled account.
 * `deps.credsForSide(isLive, accountId)` is the same test hook.
 */
async function sideContexts(db, baseCreds, deps) {
  const { getEnabledAccounts } = await import('./account-registry.js')
  const { getCtraderCreds } = await import('../lib/ctrader-creds.js')
  const contexts = baseCreds?.ready ? [baseCreds] : []
  for (const isLive of [false, true]) {
    if (contexts.some(c => !!c.isLive === isLive)) continue
    const account = getEnabledAccounts(db).find(a => (Number(a.is_live) === 1) === isLive)
    if (!account) continue
    const credentials = (deps.credsForSide ?? ((side, id) => getCtraderCreds(db, { accountId: id, isLive: side })))(isLive, String(account.account_id))
    contexts.push(credentials)
  }
  return { contexts, getEnabledAccounts }
}

/** The accounts on one context's side (one credential set reaches one host), the context's own account first. */
function accountsFor(creds, getEnabledAccounts, db) {
  const isLive = !!creds.isLive
  const roster = getEnabledAccounts(db).filter(a => (Number(a.is_live) === 1) === isLive).map(a => String(a.account_id))
  const primary = creds.accountId != null ? String(creds.accountId) : null
  return [...new Set([...(primary ? [primary] : []), ...roster])].map(id => ({
    id,
    creds: id === primary ? creds : { ...creds, accountId: id },
  }))
}

const ROWS = `SELECT mp.id, mp.trade_id, mp.symbol, mp.side, mp.entry_price, mp.paused, mp.keeper_opt_out, mp.account_id,
                     t.ctrader_position_id
                FROM monitored_positions mp
                JOIN trades t ON t.id = mp.trade_id
               WHERE mp.status = 'active' AND t.ctrader_position_id IS NOT NULL
                 AND (mp.account_id = ? OR mp.account_id IS NULL)`

const flights = new WeakMap()
/** One pass at a time per database: a band that gave up waiting leaves its pass running, and a second pass must not stamp beside it. */
function singleFlight(db, work) {
  if (flights.has(db)) return flights.get(db)
  const pass = Promise.resolve().then(work).finally(() => { if (flights.get(db) === pass) flights.delete(db) })
  flights.set(db, pass)
  return pass
}

/**
 * One pass. Returns counts and the stamps sent; `errors` is only for a pass-level
 * failure (an account that could not be read, a side with no credentials), never
 * for a refused stamp — those are reported in `refused` and in
 * GET /state/stop-policy.
 */
export function runStopPolicyPass(db, baseCreds, deps = {}) {
  return singleFlight(db, () => stopPolicyPass(db, baseCreds, deps))
}

async function stopPolicyPass(db, baseCreds, deps = {}) {
  const clock = deps.clock ?? Date.now
  const startedAt = clock()
  const now = deps.nowMs ?? startedAt
  const softDeadlineMs = deps.softDeadlineMs ?? SOFT_DEADLINE_MS
  const out = { accounts: 0, considered: 0, stamped: 0, compliant: 0, refused: 0, unverifiable: 0, mismatch: 0, failed: 0, skipped: {}, held: false, deadline: false, errors: [], stamps: [] }
  const skip = (why) => { out.skipped[why] = (out.skipped[why] || 0) + 1 }
  const finish = () => { state.last = { at: now, ...out }; return out }
  const policy = getStopPolicy()
  if (!policy.enabled) { out.skipped.policy_off = 1; return finish() }
  if (now < state.holdUntil) { out.held = true; return finish() }
  const late = () => clock() - startedAt > softDeadlineMs

  const exec = deps.exec ?? await import('../lib/exec-engine.js')
  const { contexts, getEnabledAccounts } = await sideContexts(db, baseCreds, deps)
  const work = []
  for (const creds of contexts) {
    if (!creds?.ready) { out.errors.push('stop policy: credentials unavailable for a required broker side'); continue }
    work.push(...accountsFor(creds, getEnabledAccounts, db))
  }

  /**
   * One account: read it, pick the first eligible position, ask the sidecar to
   * stamp it. Returns the stamp record, or null when nothing was asked.
   */
  const stampAccount = async ({ id, creds }) => {
    if (late()) { out.deadline = true; skip('deadline'); return null }
    let positions
    try {
      const rec = await exec.reconcile(creds)
      positions = rec?.position || []
    } catch (err) {
      out.errors.push(`stop policy: account …${String(id).slice(-4)}: ${err?.message || err}`)
      return null
    }
    out.accounts++
    if (!positions.length) return null
    const rowByPos = new Map(db.prepare(ROWS).all(String(id)).map(r => [normPosId(r.ctrader_position_id), r]))
    const bookHolds = makeBookHeldCheck(db, id)
    const eligible = []
    for (const p of positions) {
      out.considered++
      const pid = normPosId(p.positionId)
      const brokerSl = Number(p.stopLoss)
      if (!(brokerSl > 0)) { skip('no_stop'); continue }
      const row = rowByPos.get(pid)
      if (!row) { skip('no_row'); continue }
      if (Number(row.paused) === 1) { skip('paused'); continue }
      if (Number(row.keeper_opt_out) === 1) { skip('keeper_opt_out'); continue }
      const dir = sideDirection(row.side)
      if (!dir) { skip('unknown_side'); continue }
      const key = `${id}:${pid}`
      const prev = state.lastAsk.get(key)
      const wait = prev ? (prev.outcome === 'error' ? RETRY_MS : RECHECK_MS) : 0
      if (prev && now - prev.at < wait) { skip('recent'); continue }
      eligible.push({ p, pid, row, dir, brokerSl, key })
    }
    if (!eligible.length) return null
    for (let i = 1; i < eligible.length; i++) skip('one_per_account')
    if (late()) { out.deadline = true; skip('deadline'); return null }

    const { p, pid, row, dir, brokerSl, key } = eligible[0]
    let result = null
    let error = null
    try {
      result = await exec.amendPosition(creds, {
        positionId: p.positionId,
        policyOnly: true,
        expectedDirection: dir,
        stopContext: { side: row.side, entry: Number(row.entry_price) || null, book: bookHolds(p.positionId, row.trade_id) === true, stop: brokerSl },
      })
    } catch (err) { error = err }
    const outcome = classifyOutcome(result, error)
    remember(key, { at: now, outcome })
    const stamp = { account: `…${String(id).slice(-4)}`, positionId: pid, outcome, error: error ? String(error.message || error).slice(0, 160) : null }
    out.stamps.push(stamp)
    if (outcome === 'stamped') out.stamped++
    else if (outcome === 'compliant') out.compliant++
    else if (outcome === 'refused') out.refused++
    else if (outcome === 'unverifiable') out.unverifiable++
    else if (outcome === 'mismatch') out.mismatch++
    else if (outcome === 'cooldown') skip('cooldown')
    else out.failed++
    return stamp
  }

  if (state.canaryConfirmedAt) {
    // Fan out: one call per account, in parallel (the pass is as long as its slowest account).
    await Promise.allSettled(work.map(stampAccount))
  } else {
    for (const item of work) {
      if (late()) { out.deadline = true; break }
      const stamp = await stampAccount(item)
      if (!stamp) continue
      if (stamp.outcome === 'stamped') { state.canaryConfirmedAt = now; break } // the canary ends its own pass
      if (stamp.outcome === 'compliant' || stamp.outcome === 'cooldown') continue // nothing was sent: proves nothing, costs nothing
      // Refused, errored, disagreeing or unable to vouch: do not spend a second
      // position on a broker that is not confirming.
      state.holdUntil = now + CANARY_HOLD_MS
      out.held = true
      break
    }
  }
  // Persist the trailing registry once per pass, only when something changed.
  saveTrailingRegistry(db, setState)
  return finish()
}
