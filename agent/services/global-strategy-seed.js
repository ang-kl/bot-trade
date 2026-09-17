// ---------------------------------------------------------------------------
// agent/services/global-strategy-seed.js — PR-U: carry out an owner order to
// arm a strategy GLOBALLY, from the repo.
//
// WHY FROM THE REPO. The route that does this (POST /actions/strategies) needs
// the bearer token, and the token has answered 401 since 07-09. The momentum
// account, the strategy pins, the watchlist additions and the tick observation
// switch are all already declared this way for the same reason. This is the
// same mechanism for the global list.
//
// WHY THE GLOBAL LIST IS THE RIGHT LEVER (measured 17-09-2026). The momentum
// book reached 2 of 5 considered accounts, with three reading "tsmom_long not
// armed". PR-T's report showed `tsmom_long` was NOT among the ratcheted
// per-account cells — and `tsmom_long` carries `defaultOn: false` in the
// registry, so unless `enabled_strategies_json` names it the strategy is off
// everywhere that has no explicit true cell. The two accounts still running
// the book carry such a cell; the other three do not. So this is ONE switch,
// not five per-account decisions.
//
// SEED-ONCE, AND THAT IS THE POINT. Each key is applied at most once, recorded
// per key. If the edge watchdog or the adaptive breaker later disarms one of
// these on measured evidence, the next boot must NOT put it back. An arm that
// reasserts itself every boot is a guard whose trigger can never hold — the
// shape CLAUDE.md failure mode #3 names, and the shape #876 already had to fix
// once for the per-account pins. The owner ordered an ARM, not an exemption.
//
// ADDITIVE ONLY. A key is appended to the list; nothing is ever removed, and a
// strategy already present is left alone and reported `present`. The write
// goes through `setStage`, so it takes the same path, the same back-compat
// (`cup_handle_enabled`) and the same arming-ledger row as an owner clicking
// the switch would — actor `boot_seed`, with the order as the reason.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'

import { STRATEGY_KEYS, enabledStrategies } from './strategies.js'
import { setStage } from './stage-matrix.js'

export const GLOBAL_SEED_STATE_KEY = 'global_strategy_seed_json'

/** `tsmom_long:2` re-arms tsmom_long once more; the suffix is the seed record's identity, not the strategy's. */
const strategyOf = (entry) => String(entry).split(':')[0]

/**
 * Apply `config/global-strategies.json`'s `arm` list to the global enabled
 * list, once per entry.
 *
 * Returns { armed, present, seeded, skipped, error } — `armed` is what this
 * boot changed, `present` was already on, `seeded` was applied by an earlier
 * boot and is deliberately NOT re-applied, `skipped` names anything unusable.
 * Never throws: a malformed config must not stop the process from booting.
 */
export function seedGlobalStrategiesFromConfig(db, io, { file = null, log = () => {} } = {}) {
  const out = { armed: [], present: [], seeded: [], skipped: [], error: null }
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(file || new URL('../config/global-strategies.json', import.meta.url), 'utf8'))
  } catch (err) {
    out.error = `config/global-strategies.json unreadable: ${err.message}`
    return out
  }
  const entries = Array.isArray(cfg?.arm) ? cfg.arm : null
  if (!entries) { out.error = 'config/global-strategies.json has no `arm` array'; return out }

  const { getState, setState } = io
  let done = []
  try {
    const parsed = JSON.parse(getState(db, GLOBAL_SEED_STATE_KEY) || 'null')
    if (Array.isArray(parsed)) done = parsed.map(String)
  } catch { done = [] }
  const doneSet = new Set(done)
  let dirty = false

  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) { out.skipped.push(`${JSON.stringify(entry)}: not a string`); continue }
    const key = strategyOf(entry)
    if (!STRATEGY_KEYS.includes(key)) { out.skipped.push(`${entry}: unknown strategy '${key}'`); continue }
    // Already on globally — nothing to do, and NOT recorded as seeded, so the
    // order still stands if it is later disarmed and the entry is re-issued.
    if (enabledStrategies(db, getState).some(s => s.key === key)) { out.present.push(entry); continue }
    // Applied by an earlier boot and since turned off by something. Left off:
    // see the seed-once note in the header.
    if (doneSet.has(entry)) { out.seeded.push(entry); continue }

    setStage(db, {
      kind: 'strategy', key, stage: 'trade', on: true,
      actor: 'boot_seed',
      reason: `owner order: arm ${key} globally (config/global-strategies.json)`,
      evidence: { file: 'agent/config/global-strategies.json', entry, seedOnce: true },
    }, { getState, setState })
    out.armed.push(entry)
    doneSet.add(entry)
    dirty = true
    log(`[boot] global strategy arm: ${key} ON globally (owner order, config/global-strategies.json)`)
  }
  if (dirty) setState(db, GLOBAL_SEED_STATE_KEY, JSON.stringify([...doneSet]))
  return out
}
