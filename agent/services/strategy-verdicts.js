// ---------------------------------------------------------------------------
// agent/services/strategy-verdicts.js — the 30-close verdict, both directions
// (owner order 09-09-2026 15:20 SGT, §7,539·B·2: "build B·1, B·2, B·3, B·4
// in one PR").
//
// The cluster rule (#868) pinned every strategy ON for every account. A pin
// is the owner's word and the evidence gate admits it without a record —
// which means nothing would ever turn a losing pinned strategy off again, and
// nothing would ever let a winning one out of the reduced-risk cohort. This
// module is the judgement the pin was always meant to earn: each hand-pinned
// strategy, on each account, is judged on ITS OWN closed record on that
// account (the evidence gate's window and query, so the two never disagree):
//
//   closes <  bar          → pending : half risk (the exploration budget)
//   PF ≥ fullPf            → full    : the normal per-trade budget
//   PF <  offPf            → off     : the risk gate refuses it here
//   otherwise              → half    : stays in the cohort at half risk
//
// A strategy that is NOT hand-pinned on the account is out of scope
// ('n/a', scale 1): it either cleared the evidence gate on its record (already
// judged) or is the momentum book's own. The pin itself is never rewritten —
// the boot seed would only put it back — the verdict lives in the gate, so a
// record that recovers reopens the strategy on its own.
// ---------------------------------------------------------------------------
import { getState } from '../db.js'
import { isHandPinned } from './stage-matrix.js'
import { evidenceRecord, loadEvidenceGate } from './evidence-gate.js'
import { STRATEGY_KEYS } from './strategies.js'

export const STRATEGY_VERDICT_KEY = 'strategy_verdict_json'

export const STRATEGY_VERDICT_DEFAULTS = Object.freeze({
  on: true,
  closes: 30,        // the pre-registered sample (02-09-2026 review; earned-floor verdict target)
  fullPf: 1.5,       // at or above → full risk
  offPf: 1.1,        // below → refused on this account
  pendingScale: 0.5, // risk scale while the record is under `closes`
  halfScale: 0.5,    // risk scale between offPf and fullPf
})

const num = (v, dflt, lo, hi) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}

export function strategyVerdictConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = STRATEGY_VERDICT_DEFAULTS
  const fullPf = num(r.fullPf, d.fullPf, 1, 10)
  return {
    on: r.on !== false,
    closes: Math.round(num(r.closes, d.closes, 5, 500)),
    fullPf,
    offPf: Math.min(fullPf, num(r.offPf, d.offPf, 0, 10)),
    pendingScale: num(r.pendingScale, d.pendingScale, 0.05, 1),
    halfScale: num(r.halfScale, d.halfScale, 0.05, 1),
  }
}

export function loadStrategyVerdictConfig(db) {
  try { return strategyVerdictConfig(JSON.parse(getState(db, STRATEGY_VERDICT_KEY) || 'null')) } catch { return strategyVerdictConfig(null) }
}

/**
 * The verdict for one strategy on one account.
 * @returns {{state:'n/a'|'pending'|'full'|'half'|'off', riskScale:number, closes:number,
 *            profitFactor:number|null, winRate:number|null, net:number, bar:object, reason:string|null}}
 */
export function strategyVerdict(db, { strategy, accountId }) {
  const cfg = loadStrategyVerdictConfig(db)
  const bar = { closes: cfg.closes, fullPf: cfg.fullPf, offPf: cfg.offPf }
  const na = (reason) => ({ state: 'n/a', riskScale: 1, closes: 0, profitFactor: null, winRate: null, net: 0, bar, reason })
  if (!cfg.on) return na('off')
  if (!strategy || accountId == null) return na('unscoped')
  if (!isHandPinned(db, getState, accountId, String(strategy))) return na('not_pinned')
  const record = evidenceRecord(db, { strategy, accountId, windowDays: loadEvidenceGate(db).windowDays })
  const base = { closes: record.closes, profitFactor: record.profitFactor, winRate: record.winRate, net: record.net, bar, reason: null }
  if (record.closes < cfg.closes) return { state: 'pending', riskScale: cfg.pendingScale, ...base }
  const pf = record.profitFactor
  // null PF = wins and no losses yet: nothing to divide by, and nothing to
  // punish — reads as full.
  if (pf === null || pf >= cfg.fullPf) return { state: 'full', riskScale: 1, ...base }
  if (pf < cfg.offPf) return { state: 'off', riskScale: 0, ...base, reason: `PF ${pf} over ${record.closes} closes < ${cfg.offPf}` }
  return { state: 'half', riskScale: cfg.halfScale, ...base }
}

/** Every enabled account × every hand-pinned strategy, with its verdict. */
export function strategyVerdictsView(db, accountIds = null) {
  const cfg = loadStrategyVerdictConfig(db)
  let ids = accountIds
  if (!ids) {
    try { ids = db.prepare(`SELECT account_id FROM accounts WHERE enabled = 1 ORDER BY account_id`).all().map(r => String(r.account_id)) } catch { ids = [] }
  }
  const accounts = {}
  for (const id of ids) {
    const rows = {}
    for (const key of STRATEGY_KEYS) {
      if (!isHandPinned(db, getState, id, key)) continue
      const v = strategyVerdict(db, { strategy: key, accountId: id })
      rows[key] = { state: v.state, riskScale: v.riskScale, closes: v.closes, profitFactor: v.profitFactor, winRate: v.winRate, net: v.net }
    }
    accounts[id] = rows
  }
  return {
    config: cfg,
    note: 'Hand-pinned strategies only, judged on their own closes on that account (evidence-gate window). pending = under the sample, half risk; full = PF at or above fullPf; half = between; off = refused by the risk gate on this account until the record recovers.',
    accounts,
  }
}
