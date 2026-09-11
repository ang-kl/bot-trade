// ---------------------------------------------------------------------------
// agent/services/account-horizon.js — one horizon per account, enforced
// (§7,437·B·6, owner order 08-09-2026 18:40 SGT).
//
// The momentum account already refuses non-momentum proposals. This extends
// that to every account: an account may declare the horizon it trades
// (intraday: bars up to 1h; swing: up to a day; position: longer) and the
// strategy families it takes. The gates then refuse anything outside that
// BEFORE analysis — a setup no armed account could take is not analysed
// sixty times an hour — and again per account in the fan-out, so a swing
// setup never reaches an intraday account's sizing.
//
// Nothing declared means nothing changes: an account with no horizon and no
// family set admits everything, exactly as before this file existed.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { getState, setState } from '../db.js'
import { tfMs } from '../lib/timeframes.js'
import { familyOf, STRATEGY_FAMILIES } from './strategies.js'

export const HORIZONS = Object.freeze(['intraday', 'swing', 'position'])
export const HORIZON_KEY = (accountId) => `acct:${accountId}:horizon_json`
const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS

/** intraday ≤ 1h bars · swing ≤ 1d · position beyond. null for an unreadable timeframe. */
export function horizonOfTimeframe(tf) {
  let ms = null
  try { ms = tfMs(tf) } catch { ms = null }
  if (!(ms > 0)) return null
  if (ms <= HOUR_MS) return 'intraday'
  if (ms <= DAY_MS) return 'swing'
  return 'position'
}

/** Normalise a declaration: unknown horizons and families are dropped, never invented. */
export function normalizeHorizon(raw) {
  const horizon = HORIZONS.includes(raw?.horizon) ? raw.horizon : null
  const families = Array.isArray(raw?.families) ? raw.families.map(String).filter(f => STRATEGY_FAMILIES.includes(f)) : []
  return { horizon, families: [...new Set(families)] }
}

export function loadAccountHorizon(db, accountId) {
  try { return normalizeHorizon(JSON.parse(getState(db, HORIZON_KEY(String(accountId))) || 'null')) } catch { return normalizeHorizon(null) }
}

/** Start from what is stored, apply the patch, store what results (failure mode #5). `horizon: null` clears; `families: []` clears. */
export function setAccountHorizon(db, accountId, patch = {}) {
  const stored = loadAccountHorizon(db, accountId)
  const merged = { ...stored }
  if ('horizon' in patch) merged.horizon = patch.horizon
  if ('families' in patch) merged.families = patch.families
  const next = normalizeHorizon(merged)
  setState(db, HORIZON_KEY(String(accountId)), JSON.stringify(next))
  return next
}

/**
 * Does this declaration admit a proposal? Pure. An unknown family (a
 * strategy the registry does not name) or an unreadable timeframe is not a
 * verdict: it admits, so a registry gap cannot silently disarm an account.
 */
export function horizonAdmits(decl, { timeframe = null, strategy = null, basis = null } = {}) {
  const d = normalizeHorizon(decl)
  // P5 (plan B11, TM-19): a basis that is neither 'bar' nor 'tick' is not
  // a verdict either way — it is refused BEFORE the undeclared-admits rule,
  // so an unknown new-mode input cannot bypass the classification on an
  // account that never declared a horizon.
  if (basis != null && basis !== 'bar' && basis !== 'tick') return { ok: false, reason: `basis '${basis}' is not classified; only bar and tick are` }
  if (!d.horizon && !d.families.length) return { ok: true, reason: null }
  const fam = strategy ? familyOf(strategy) : null
  if (d.families.length && fam && !d.families.includes(fam)) {
    return { ok: false, reason: `family ${fam} (${strategy}) is outside this account's set [${d.families.join(', ')}]` }
  }
  // P5 (plan B11, TM-19): a tick-basis proposal is classified explicitly —
  // it holds for events, never for days, so it is intraday risk and an
  // account declared swing or position refuses it. A basis that is neither
  // 'bar' nor 'tick' is not a verdict either way: it is refused, so an
  // unknown new-mode input cannot bypass the classification.
  if (basis === 'tick') {
    if (d.horizon && d.horizon !== 'intraday') return { ok: false, reason: `a tick signal is intraday risk; this account trades ${d.horizon}` }
    return { ok: true, reason: null }
  }
  const h = horizonOfTimeframe(timeframe)
  if (d.horizon && h && h !== d.horizon) {
    return { ok: false, reason: `${timeframe} is a ${h} bar; this account trades ${d.horizon}` }
  }
  return { ok: true, reason: null }
}

/** Would ANY of these accounts take it? The pre-analysis question. */
export function anyAccountAdmits(db, accountIds, proposal) {
  const refusedBy = []
  let admitted = false
  for (const id of accountIds || []) {
    const v = horizonAdmits(loadAccountHorizon(db, id), proposal)
    if (v.ok) admitted = true
    else refusedBy.push({ accountId: String(id), reason: v.reason })
  }
  if (!(accountIds || []).length) return { ok: true, refusedBy: [], note: 'no accounts to ask — admitted' }
  return { ok: admitted, refusedBy }
}

/**
 * Apply the owner's declarations from agent/config/account-horizons.json
 * at boot (08-09-2026: the declaring route needs the bearer token, which
 * was lost on 07-09; the file is the durable declaration and survives a
 * database reset). Idempotent — an account already stored as declared is
 * left alone; a differing stored value is overwritten by the file, which
 * is the point of a declaration in the repo.
 * @returns {{applied:string[], unchanged:string[], error:string|null}}
 */
export function seedAccountHorizonsFromConfig(db, { file = null, log = () => {} } = {}) {
  const out = { applied: [], unchanged: [], error: null }
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(file || new URL('../config/account-horizons.json', import.meta.url), 'utf8'))
  } catch (err) {
    out.error = `account-horizons.json unreadable: ${err.message}`
    return out
  }
  for (const [accountId, raw] of Object.entries(cfg || {})) {
    if (!/^\d+$/.test(accountId) || !raw || typeof raw !== 'object') continue
    const want = normalizeHorizon(raw)
    const have = loadAccountHorizon(db, accountId)
    if (have.horizon === want.horizon && have.families.join(',') === want.families.join(',')) { out.unchanged.push(accountId); continue }
    setAccountHorizon(db, accountId, want)
    out.applied.push(accountId)
    log(`[boot] account horizon …${accountId.slice(-4)}: ${want.horizon || 'any horizon'}${want.families.length ? ` [${want.families.join(', ')}]` : ''} (from config/account-horizons.json)`)
  }
  return out
}

export function horizonsView(db, accountIds = []) {
  return {
    horizons: HORIZONS, families: STRATEGY_FAMILIES,
    accounts: (accountIds || []).map(id => ({ accountId: String(id), ...loadAccountHorizon(db, id) })),
    note: 'intraday = bars up to 1h, swing = up to 1d, position = longer. An account with no horizon and no families admits everything. POST /actions/account-horizon {accountId, horizon, families} to declare.',
  }
}
