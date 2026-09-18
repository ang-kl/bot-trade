// ---------------------------------------------------------------------------
// agent/services/risk-config-seed.js — the stored risk overrides brought back
// under the repo, once. Wave 4 of docs/first-principles-audit-2026-09-19.md
// §K (item 13).
//
// WHAT WAS FOUND (19-09-2026, read from /state/risk-matrix). The global
// `risk_config_json` held 55 keys. Seventeen differed from DEFAULT_RISK_CONFIG;
// thirty-seven were stored AT their default — the Risk page's save spread the
// EFFECTIVE config into the store (routes/actions.js used loadRiskConfig() as
// its base), so every default became a permanent override that no longer
// follows a default change; and one key (kellyFraction) is retired and read
// by nothing.
//
// WHAT THIS DOES, ONCE PER FILE CONTENT (risk_config_seed_json holds the
// sha256 of the file's operative fields; a boot with the same hash changes
// nothing, so what a human sets afterwards stands):
//   - `reset`: the named stored overrides are DELETED from the store, so the
//     default is in force again. The file names only resets that tighten a
//     bound or are inert — a reset that would loosen a live bound is a
//     risk-limit change and stays in `keep` until the owner orders it (P7).
//   - `keep`: never touched, whatever is stored.
//   - `prunePinnedDefaults`: a stored value deep-equal to its default is
//     removed — no behaviour change today, and the key follows the default
//     again from now on.
//   - `dropRetired`: stored keys absent from DEFAULT_RISK_CONFIG are removed.
// The per-account overlays (`acct:<id>:risk_config_json`) are NOT touched:
// none exists in production today, and an overlay is a human's per-account
// decision, not a spread artefact.
//
// Every change is recorded through noteRiskConfigChanges (by: 'boot_seed'),
// so the Risk page's "changed at" column and the arming-style audit trail
// both see it.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { getState, setState } from '../db.js'
import { DEFAULT_RISK_CONFIG, loadRiskConfig } from './risk.js'
import { noteRiskConfigChanges } from './risk-config-history.js'

export const RISK_CONFIG_SEED_KEY = 'risk_config_seed_json'
export const RISK_CONFIG_KEY = 'risk_config_json'

const DEFAULT_FILE = new URL('../config/risk-config.json', import.meta.url)

function deepEqual(a, b) { return JSON.stringify(a) === JSON.stringify(b) }

/** The operative fields of the file, hashed — `_note` is prose and does not re-apply the seed. */
export function riskConfigSeedHash(cfg) {
  const content = JSON.stringify({
    reset: Array.isArray(cfg.reset) ? [...cfg.reset].sort() : null,
    keep: Array.isArray(cfg.keep) ? [...cfg.keep].sort() : null,
    prunePinnedDefaults: cfg.prunePinnedDefaults === true,
    dropRetired: cfg.dropRetired === true,
  })
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/**
 * Apply the seed. Returns what happened; never throws (an unreadable file is
 * `error`, and the store is untouched).
 *
 * @returns {{applied:boolean, hash:string|null, reset:string[], pruned:string[], dropped:string[], kept:string[], skipped:string[], storedKeys:number|null, error:string|null}}
 */
export function seedRiskConfigFromFile(db, { file = DEFAULT_FILE, log = () => {}, defaults = DEFAULT_RISK_CONFIG } = {}) {
  const out = { applied: false, hash: null, reset: [], pruned: [], dropped: [], kept: [], skipped: [], storedKeys: null, error: null }
  let cfg
  try { cfg = JSON.parse(readFileSync(file, 'utf8')) } catch (err) { out.error = `cannot read ${String(file)}: ${err?.message ?? err}`; return out }
  if (!cfg || typeof cfg !== 'object') { out.error = 'malformed seed file'; return out }
  const hash = riskConfigSeedHash(cfg)
  out.hash = hash

  let seeded = null
  try { seeded = JSON.parse(getState(db, RISK_CONFIG_SEED_KEY) || 'null') } catch { seeded = null }

  let stored = {}
  try { stored = JSON.parse(getState(db, RISK_CONFIG_KEY) || '{}') || {} } catch { stored = {} }
  if (typeof stored !== 'object' || Array.isArray(stored)) stored = {}
  out.storedKeys = Object.keys(stored).length

  const keep = new Set(Array.isArray(cfg.keep) ? cfg.keep.map(String) : [])
  const resetList = Array.isArray(cfg.reset) ? cfg.reset.map(String) : []
  for (const k of resetList) {
    if (!(k in defaults)) out.skipped.push(`reset ${k}: not a risk key`)
    if (keep.has(k)) out.skipped.push(`reset ${k}: also in keep — keep wins`)
  }
  for (const k of keep) if (k in stored) out.kept.push(k)

  if (seeded?.hash === hash) {
    // Already applied for this content: whatever a human did since stands.
    return out
  }
  // A CONTENT CHANGE APPLIES THE DELTA, NOT THE WHOLE LIST (checker, Wave
  // 4a): a reset key this seed already applied under an earlier hash is a
  // human's to change afterwards — adding one key to `reset` later must
  // not re-reset the other nine. The record keeps the union of keys ever
  // reset; only keys outside it are reset now.
  const resetBefore = new Set(Array.isArray(seeded?.resetEver) ? seeded.resetEver.map(String) : [])

  const before = loadRiskConfig(db)
  const next = { ...stored }
  for (const k of resetList) {
    if (!(k in defaults) || keep.has(k)) continue
    if (resetBefore.has(k)) { out.skipped.push(`reset ${k}: applied under an earlier content — a later value is the operator's`); continue }
    if (k in next && !deepEqual(next[k], defaults[k])) { delete next[k]; out.reset.push(k) } else if (k in next) { delete next[k]; out.pruned.push(k) }
  }
  if (cfg.dropRetired === true) {
    for (const k of Object.keys(next)) {
      if (!(k in defaults) && !keep.has(k)) { delete next[k]; out.dropped.push(k) }
    }
  }
  if (cfg.prunePinnedDefaults === true) {
    for (const k of Object.keys(next)) {
      if (keep.has(k)) continue
      if (k in defaults && deepEqual(next[k], defaults[k])) { delete next[k]; out.pruned.push(k) }
    }
  }

  const changed = !deepEqual(next, stored)
  if (changed) {
    setState(db, RISK_CONFIG_KEY, JSON.stringify(next))
    try { noteRiskConfigChanges(db, before, loadRiskConfig(db), { by: 'boot_seed' }) } catch { /* the store is already written; the stamp is best-effort */ }
    for (const k of out.reset) log(`[boot] risk config: ${k} ${JSON.stringify(stored[k])} → default ${JSON.stringify(defaults[k])} (from config/risk-config.json)`)
  }
  out.applied = changed
  const resetEver = [...new Set([...resetBefore, ...resetList.filter(k => (k in defaults) && !keep.has(k))])].sort()
  setState(db, RISK_CONFIG_SEED_KEY, JSON.stringify({
    hash, at: new Date().toISOString(), reset: out.reset, pruned: out.pruned, dropped: out.dropped, kept: out.kept, resetEver,
  }))
  return out
}
