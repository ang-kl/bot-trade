// ---------------------------------------------------------------------------
// agent/services/evidence-gate.js — a strategy trades live on an account only
// on evidence or on the owner's word (owner "build it", 03-09-2026).
//
// THE RULE. For one strategy on one account, dispatch is allowed when either
//   (a) the owner hand-pinned the strategy's trade cell on that account's
//       stage-matrix overlay (an explicit true; only routes and the owner's
//       overlay migration write one), or
//   (b) the strategy's own live record on that account clears the
//       pre-registered bar — EVIDENCE_GATE_DEFAULTS.minCloses closes at
//       profit factor ≥ minPf over windowDays (clean bot origins, the
//       account's rows plus unscoped legacy rows, the same population the
//       earned floor reads).
// Otherwise the proposal is refused with `evidence_gate: …` and the refusal
// is the strategy's SHADOW record: the risk event carries the full proposal,
// so what it would have taken is measured at zero cost. Measured 03-09-2026:
// 30 days of strategy closes read PF 0.54 at 32% win — the machine had been
// paying to learn what a shadow learns for free.
//
// Fail-open on error: a gate that cannot be read must not become a silent
// disarm of every strategy (failure mode #3).
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { isHandPinned } from './stage-matrix.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import { isMomentumAccount, TSMOM_STRATEGY } from './momentum-account.js'

export const EVIDENCE_GATE_KEY = 'evidence_gate_json'
export const EVIDENCE_GATE_DEFAULTS = Object.freeze({ on: true, minCloses: 30, minPf: 1.5, windowDays: 90 })

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d)

export function evidenceGateConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = EVIDENCE_GATE_DEFAULTS
  return {
    on: r.on !== false,
    minCloses: Math.round(clamp(r.minCloses, 1, 1000, d.minCloses)),
    minPf: clamp(r.minPf, 0.1, 10, d.minPf),
    windowDays: Math.round(clamp(r.windowDays, 1, 365, d.windowDays)),
  }
}

export function loadEvidenceGate(db) {
  try { return evidenceGateConfig(JSON.parse(getState(db, EVIDENCE_GATE_KEY) || 'null')) } catch { return evidenceGateConfig(null) }
}

/**
 * One strategy's live record on one account: clean bot closes with known
 * P&L over the window, the account's rows plus unscoped legacy rows.
 * profitFactor null = no losses yet (never a number that reads as earned).
 */
export function evidenceRecord(db, { strategy, accountId = null, windowDays = 90 } = {}) {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT net_pnl FROM trades
       WHERE status = 'closed' AND net_pnl IS NOT NULL
         AND label_strategy = ?
         AND origin LIKE 'bot_%'
         AND closed_at >= datetime('now', ?)
         AND (? IS NULL OR account_id = ? OR account_id IS NULL)
    `).all(String(strategy), `-${Math.max(1, Math.round(windowDays))} days`, accountId, accountId == null ? null : String(accountId))
  } catch { rows = [] }
  const pnl = rows.map(r => Number(r.net_pnl)).filter(Number.isFinite)
  const wins = pnl.filter(x => x > 0)
  const gw = wins.reduce((a, b) => a + b, 0)
  const gl = Math.abs(pnl.filter(x => x < 0).reduce((a, b) => a + b, 0))
  return {
    closes: pnl.length,
    wins: wins.length,
    winRate: pnl.length ? Math.round((wins.length / pnl.length) * 1000) / 10 : null,
    profitFactor: gl > 0 ? Math.round((gw / gl) * 100) / 100 : (pnl.length ? null : 0),
    net: Math.round(pnl.reduce((a, b) => a + b, 0) * 100) / 100,
  }
}

/**
 * The verdict for one strategy on one account.
 * @returns {{allowed:boolean, via:'off'|'pinned'|'record'|'shadow'|'unlabelled', reason:string|null, record:object|null, bar:{minCloses:number,minPf:number}}}
 */
export function evidenceGate(db, { strategy, accountId = null } = {}) {
  const cfg = loadEvidenceGate(db)
  const bar = { minCloses: cfg.minCloses, minPf: cfg.minPf }
  if (!cfg.on) return { allowed: true, via: 'off', reason: null, record: null, bar }
  if (!strategy) return { allowed: false, via: 'unlabelled', reason: 'unlabelled proposal — no strategy to hold a record for', record: null, bar }
  if (isHandPinned(db, getState, accountId, String(strategy))) {
    return { allowed: true, via: 'pinned', reason: null, record: null, bar }
  }
  // (c) THE MOMENTUM ACCOUNT runs the momentum system by construction
  // (owner 07-09-2026, §7,386·D1): tsmom_long is admitted there without a
  // pin or a record — the account IS the pin. Every other strategy on that
  // account is refused upstream by the risk gate (momentum_account_only).
  if (String(strategy) === TSMOM_STRATEGY && isMomentumAccount(db, accountId)) {
    return { allowed: true, via: 'momentum_account', reason: null, record: null, bar }
  }
  const record = evidenceRecord(db, { strategy, accountId, windowDays: cfg.windowDays })
  const clears = record.closes >= cfg.minCloses && (record.profitFactor === null || record.profitFactor >= cfg.minPf)
  if (clears) return { allowed: true, via: 'record', reason: null, record, bar }
  const acct = accountId == null ? 'unscoped' : `…${String(accountId).slice(-4)}`
  return {
    allowed: false, via: 'shadow', record, bar,
    reason: `${strategy} on ${acct}: ${record.closes}/${cfg.minCloses} closes, PF ${record.profitFactor ?? 'n/a'} (bar ${cfg.minPf}); not hand-pinned — logged as shadow`,
  }
}

/** Per strategy × enabled account: pinned, record, verdict, and the shadow refusals of the last 7 days. */
export function evidenceGateReport(db) {
  const cfg = loadEvidenceGate(db)
  let accounts = []
  try { accounts = db.prepare(`SELECT account_id, is_live FROM accounts WHERE enabled = 1 ORDER BY account_id`).all() } catch { accounts = [] }
  let shadow = {}
  try {
    // Rows written before PR-C (risk_events vetoes; repeat_count summed) …
    for (const r of db.prepare(`
      SELECT json_extract(proposal_json, '$.strategy') AS s, account_id AS a, SUM(COALESCE(repeat_count, 1)) AS n
        FROM risk_events
       WHERE veto_reason LIKE 'evidence_gate:%' AND created_at >= datetime('now', '-7 days')
       GROUP BY s, a`).all()) shadow[`${r.s}|${r.a ?? ''}`] = (shadow[`${r.s}|${r.a ?? ''}`] || 0) + r.n
  } catch { /* pre-migration schema — the decision_log read below still counts */ }
  try {
    // … and the decision_log skips the gate writes since (services/gate-skips.js).
    for (const r of db.prepare(`
      SELECT strategy AS s, account_id AS a, COUNT(*) AS n
        FROM decision_log
       WHERE stage = 'evidence_gate' AND decision = 'skip' AND created_at >= datetime('now', '-7 days')
       GROUP BY s, a`).all()) shadow[`${r.s}|${r.a ?? ''}`] = (shadow[`${r.s}|${r.a ?? ''}`] || 0) + r.n
  } catch { /* nothing to add */ }
  const strategies = {}
  for (const s of STRATEGY_REGISTRY) {
    strategies[s.key] = {}
    for (const a of accounts) {
      const id = String(a.account_id)
      const v = evidenceGate(db, { strategy: s.key, accountId: id })
      strategies[s.key][id] = {
        live: Number(a.is_live) !== 0,
        allowed: v.allowed, via: v.via,
        record: v.record ?? evidenceRecord(db, { strategy: s.key, accountId: id, windowDays: cfg.windowDays }),
        shadowRefusals7d: shadow[`${s.key}|${id}`] || 0,
      }
    }
  }
  return { reportOnly: true, config: cfg, accounts: accounts.map(a => String(a.account_id)), strategies }
}
