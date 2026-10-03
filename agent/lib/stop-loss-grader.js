// ---------------------------------------------------------------------------
// agent/lib/stop-loss-grader.js — grade the LIVE stop-loss policy from the
// agent's own read-only state routes (02-10-2026, PR-3). Pure: it takes what
// GET /state/stop-policy and /state/heartbeats answered
// and returns one verdict per check. scripts/verify-stop-loss-integrated.mjs
// fetches (GET only, never /actions) and prints; this file decides.
//
// Verdicts are words, never colours: PASS, FAIL, NOT VERIFIABLE. The third is a
// first-class result — "no amend has happened yet" is not a pass, and a reading
// the broker does not give us is not a failure.
// ---------------------------------------------------------------------------

import { brokerTrigger } from './stop-policy.js'

export const PASS = 'PASS'
export const FAIL = 'FAIL'
export const NOT_VERIFIABLE = 'NOT VERIFIABLE'

const last4 = id => `…${String(id ?? '').slice(-4)}`
const check = (id, verdict, detail) => ({ id, verdict, detail })

/**
 * @param {{policy?: object, heartbeats?: object, baselineTp?: Record<string, number|null>}} input
 *   baselineTp — take-profit by `${account}:${positionId}` from an earlier run.
 */
export function gradeStopLoss({ policy, heartbeats, baselineTp = null } = {}) {
  const out = []
  const accounts = Array.isArray(heartbeats?.runtime?.accounts) ? heartbeats.runtime.accounts : []
  const prot = accounts.map(a => ({ id: last4(a.accountId), ...(a.independentProtection ?? a) , raw: a }))

  // 1. The policy is on and says Opposite.
  const p = policy?.policy
  out.push(!p ? check('policy_on', NOT_VERIFIABLE, 'GET /state/stop-policy did not answer')
    : p.enabled === true && String(p.triggerMethod).toUpperCase() === 'OPPOSITE' ? check('policy_on', PASS, `enabled, trigger ${p.triggerMethod}, trailing ${p.trailing}`)
    : check('policy_on', FAIL, `enabled=${p.enabled}, trigger=${p.triggerMethod}`))

  // 2. The independent broker read: every account answered, fresh, no drift.
  const unreadable = prot.filter(a => a.ok !== true || a.stale === true)
  out.push(!accounts.length ? check('verifier_reads', NOT_VERIFIABLE, 'no account in the heartbeat runtime')
    : unreadable.length ? check('verifier_reads', FAIL, `not ok or stale: ${unreadable.map(a => a.id).join(', ')}`)
    : check('verifier_reads', PASS, `${accounts.length} of ${accounts.length} accounts read fresh`))

  // 3. Every open stop reads Opposite at the broker.
  let stops = 0, opposite = 0, unknown = 0
  const notOpposite = []
  for (const a of prot) {
    for (const pos of a.positions ?? []) {
      stops++
      const t = brokerTrigger(pos) // the policy module's reader: no other file names the broker's trigger field
      if (t == null) unknown++
      else if (t === 2) opposite++
      else notOpposite.push(`${a.id}/${String(pos.positionId).slice(-4)}`)
    }
  }
  out.push(stops === 0 ? check('stops_opposite', NOT_VERIFIABLE, 'no open position with a stop in the read')
    : notOpposite.length ? check('stops_opposite', FAIL, `${notOpposite.length} of ${stops} not Opposite: ${notOpposite.slice(0, 8).join(', ')}`)
    : unknown ? check('stops_opposite', NOT_VERIFIABLE, `${opposite} Opposite, ${unknown} of ${stops} give no trigger in the read`)
    : check('stops_opposite', PASS, `${opposite} of ${stops} Opposite`))

  // 4. No position without a stop or a target, and no policy drift.
  const missingSl = prot.reduce((n, a) => n + (Number(a.missingSl) || 0), 0)
  const missingTp = prot.reduce((n, a) => n + (Number(a.missingTp) || 0), 0)
  out.push(missingSl || missingTp ? check('protection_complete', FAIL, `missing stop ${missingSl}, missing target ${missingTp}`) : check('protection_complete', PASS, 'no missing stop, no missing target'))
  const drift = prot.flatMap(a => (a.policyDrift ?? []).map(d => `${a.id}/${String(d.positionId ?? d).slice(-4)}`))
  out.push(drift.length ? check('policy_drift', FAIL, `drift: ${drift.slice(0, 8).join(', ')}`) : check('policy_drift', PASS, 'no position reads a different trigger than it was confirmed with'))

  // 5. The controller: no refusal, no error, not held.
  const c = policy?.controller
  const counts = policy?.counts ?? {}
  if (!c) out.push(check('controller', NOT_VERIFIABLE, 'no controller block'))
  else {
    const l = c.last ?? {}
    const bad = []
    if (c.holdUntil) bad.push('held after a refusal or error')
    if (Number(l.refused) > 0) bad.push(`${l.refused} refused`)
    if (Number(l.failed) > 0 || (l.errors ?? []).length) bad.push(`${l.failed ?? 0} failed, errors ${(l.errors ?? []).length}`)
    if (Number(l.mismatch) > 0) bad.push(`${l.mismatch} read-back mismatch`)
    out.push(bad.length ? check('controller', FAIL, bad.join('; ')) : !l.at ? check('controller', NOT_VERIFIABLE, 'no pass has run since the last boot') : check('controller', PASS, `last pass considered ${l.considered}, stamped ${l.stamped}, compliant ${l.compliant}`))
  }
  out.push(Number(counts.refused) > 0 || Number(counts.readback?.mismatch) > 0
    ? check('amend_outcomes', FAIL, `refused ${counts.refused}, read-back mismatch ${counts.readback?.mismatch}`)
    : Number(counts.amends) === 0 ? check('amend_outcomes', NOT_VERIFIABLE, 'no amend since the last boot')
    : check('amend_outcomes', PASS, `${counts.amends} amends, ${counts.applied} applied, ${counts.unchanged} unchanged, none refused`))

  // (Check 6, the MAE/Chandelier observer's receipts, was removed with the
  // observer on 03-10-2026: it never produced a usable reading in production.)

  // 7. Take profit identical to the baseline (an amend REPLACES protection).
  if (baselineTp) {
    const now = {}
    for (const a of prot) for (const pos of a.positions ?? []) now[`${a.id}:${pos.positionId}`] = pos.takeProfit ?? null
    const changed = Object.keys(baselineTp).filter(k => k in now && now[k] !== baselineTp[k])
    const gone = Object.keys(baselineTp).filter(k => baselineTp[k] != null && k in now && now[k] == null)
    out.push(gone.length ? check('target_unchanged', FAIL, `lost a target: ${gone.slice(0, 8).join(', ')}`)
      : changed.length ? check('target_unchanged', NOT_VERIFIABLE, `${changed.length} target(s) differ from the baseline (a bot target change is legitimate; none was lost)`)
      : check('target_unchanged', PASS, `${Object.keys(baselineTp).filter(k => k in now).length} targets identical to the baseline`))
  } else out.push(check('target_unchanged', NOT_VERIFIABLE, 'no baseline: run once to write one, again after the next amend window'))

  const worst = out.some(o => o.verdict === FAIL) ? FAIL : out.some(o => o.verdict === NOT_VERIFIABLE) ? NOT_VERIFIABLE : PASS
  return { verdict: worst, checks: out }
}

/** The target map a later run compares against. */
export function targetSnapshot(heartbeats) {
  const out = {}
  for (const a of heartbeats?.runtime?.accounts ?? []) {
    const ip = a.independentProtection ?? a
    for (const pos of ip.positions ?? []) out[`${last4(a.accountId)}:${pos.positionId}`] = pos.takeProfit ?? null
  }
  return out
}
