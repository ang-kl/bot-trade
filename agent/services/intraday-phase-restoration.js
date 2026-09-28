import { readFileSync } from 'node:fs'
import { getState, setState } from '../db.js'
import { effectivePhases, masterPhases, setAccountPhases } from './account-phases.js'

export const PHASE_RESTORE_STATE_KEY = 'owner_phase_restoration_json'

/** Apply the owner's one-time S/A/T order to enabled accounts, without re-arming a later disarm. */
export function restoreApprovedAccountPhases(db, { file = null, log = () => {} } = {}) {
  let cfg
  try { cfg = JSON.parse(readFileSync(file || new URL('../config/intraday-phase-restoration.json', import.meta.url), 'utf8')) }
  catch (err) { return { applied: [], held: [], skipped: [], error: `phase order unreadable: ${err.message}` } }
  if (!cfg || typeof cfg.orderId !== 'string' || !/^owner-approved-intraday-[0-9]{8}$/.test(cfg.orderId)) {
    return { applied: [], held: [], skipped: [], error: 'phase order has no valid owner order ID' }
  }
  if (!Array.isArray(cfg.accountIds) || cfg.accountIds.length !== 7
      || new Set(cfg.accountIds).size !== 7 || !cfg.accountIds.every(id => typeof id === 'string' && /^[0-9]+$/.test(id))) {
    return { applied: [], held: [], skipped: [], error: 'phase order needs seven distinct existing account IDs' }
  }
  const result = { applied: [], held: [], skipped: [], error: null }
  const master = masterPhases(db)
  if (!master.scan || !master.analyze || !master.autotrade) {
    result.error = 'master emergency stop or phase OFF: refusing to re-arm accounts at boot'
    return result
  }
  let prior = {}
  try { prior = JSON.parse(getState(db, PHASE_RESTORE_STATE_KEY) || '{}') || {} } catch { prior = {} }
  const done = new Set(prior.orderId === cfg.orderId && Array.isArray(prior.doneIds) ? prior.doneIds.map(String) : [])
  const rows = db.prepare('SELECT account_id, mode FROM accounts WHERE enabled = 1 ORDER BY account_id').all()
  const approved = new Set(cfg.accountIds)
  for (const row of rows) {
    const id = String(row.account_id)
    if (!approved.has(id)) continue // no future account inherits this financial approval
    if (done.has(id)) { result.held.push(id); continue }
    if (!['active', 'manage_only'].includes(row.mode)) { result.skipped.push(`${id}: mode ${row.mode}`); continue }
    setAccountPhases(db, id, { scan: true, analyze: true, autotrade: true }, {
      actor: 'owner-approved-seed', via: 'agent/config/intraday-phase-restoration.json',
      reason: 'owner approval 2026-09-28: restore S/A/T on all seven accounts after CI and review',
    })
    const effective = effectivePhases(db, id)
    if (!effective.scan || !effective.analyze || !effective.autotrade) {
      result.skipped.push(`${id}: effective S/A/T not all on`)
      continue
    }
    done.add(id)
    setState(db, PHASE_RESTORE_STATE_KEY, JSON.stringify({ orderId: cfg.orderId, doneIds: [...done] }))
    result.applied.push(id)
    log(`[boot] owner-approved S/A/T restoration: account …${id.slice(-4)} ON once`)
  }
  return result
}
