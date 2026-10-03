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
import { whyCell } from './arming-log.js'
import { STRATEGY_REGISTRY } from './strategies.js'
import { isMomentumAccount, TSMOM_STRATEGY } from './momentum-account.js'
import { netRof, summarizeR, summarizeUsd, PF_METRICS } from './pf-metrics.js'

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
 * The gate's population, read once: clean bot closes with known P&L, the
 * account's rows plus unscoped legacy rows. `strategy` null reads every
 * labelled strategy and `accountId` null every account (the gate's own
 * `? IS NULL` reading) — the qualification report reads the window once and
 * groups in JS, then reconciles each cell against evidenceRecord.
 *
 * Window: closed_at >= datetime(<now>, -windowDays days) — SQLite's clock
 * unless `now` (ms) is given, so the gate's call keeps the filter it always
 * ran (SQLite's datetime('now', '-N days')) — or, with `fromMs`, the closed
 * window [fromMs, toMs) on the same closed_at stamp.
 */
export function evidenceRows(db, { strategy = null, accountId = null, windowDays = 90, now = null, fromMs = null, toMs = null } = {}) {
  const stamp = (ms) => new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19)
  const where = ["status = 'closed'", 'net_pnl IS NOT NULL', "origin LIKE 'bot_%'"]
  const params = []
  if (strategy != null) { where.push('label_strategy = ?'); params.push(String(strategy)) } else where.push('label_strategy IS NOT NULL')
  if (fromMs != null) {
    where.push('closed_at >= ?'); params.push(stamp(fromMs))
    if (toMs != null) { where.push('closed_at < ?'); params.push(stamp(toMs)) }
  } else {
    where.push('closed_at >= datetime(?, ?)')
    params.push(now == null ? 'now' : stamp(now), `-${Math.max(1, Math.round(windowDays))} days`)
  }
  if (accountId != null) { where.push('(account_id = ? OR account_id IS NULL)'); params.push(String(accountId)) }
  try {
    return db.prepare(`
      SELECT id, account_id, label_strategy, symbol, side, entry_price, exit_price, sl_price, broker_sl_initial,
             gross_pnl, net_pnl, realised_rr, pnl_price_mismatch, exit_price_suspect, opened_at, closed_at, closed_at_ms
        FROM trades WHERE ${where.join(' AND ')} ORDER BY id`).all(...params)
  } catch { return [] }
}

/**
 * The record over a set of evidence rows. `profitFactor` is usd-net-v0 and
 * is what the gate and the verdicts JUDGE; `profitFactorR` is r-net-v1 (D1),
 * reported beside it over the R-scored closes with the unscored ones counted
 * (`rUnscorable`), and read by nothing that gates (Q4b / PR-B1).
 */
export function summarizeEvidence(rows) {
  const known = (rows || []).filter(r => Number.isFinite(Number(r.net_pnl)))
  const usd = summarizeUsd(known.map(r => r.net_pnl))
  const r = summarizeR(known.map(netRof))
  return {
    closes: usd.closes,
    wins: usd.wins,
    winRate: usd.winRate,
    profitFactor: usd.profitFactor,
    net: usd.net,
    profitFactorR: r.profitFactor,
    rScored: r.scored,
    rUnscorable: r.unscorable,
    metrics: PF_METRICS,
  }
}

/**
 * One strategy's live record on one account: clean bot closes with known
 * P&L over the window, the account's rows plus unscoped legacy rows.
 * profitFactor null = no losses yet (never a number that reads as earned).
 */
export function evidenceRecord(db, { strategy, accountId = null, windowDays = 90, now = null } = {}) {
  return summarizeEvidence(evidenceRows(db, { strategy: String(strategy), accountId, windowDays, now }))
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
  // (c) A MOMENTUM ACCOUNT runs the momentum system by construction (owner
  // 07-09-2026, §7,386·D1; every enabled account since PR-B, 11-09-2026):
  // tsmom_long is admitted there without a pin or a record — the account IS
  // the pin. The rest of the stack is judged here like anywhere else.
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
  // R2 (the 03-10-2026 replays, docs/replays-2026-10-03.md): a shadow cell
  // with ZERO shadow refusals was read as "an entry path bypasses the gate".
  // It was not: the cells had been hand-pinned when their trades opened and
  // were unpinned afterwards by the edge watchdog or the breaker, and once a
  // cell's trade pin is false the STAGE MATRIX refuses the proposal upstream
  // (loop.js, `stage_matrix` skips), so the evidence gate never sees it and
  // its counter stays at zero for a reason the report did not show. A zero
  // that cannot tell "nothing proposed" from "refused upstream" from "pinned
  // until yesterday" is the shape of failure mode #3. So each cell now
  // carries the upstream skips, the last pin change and `whyZero`.
  let stageSkips = {}
  try {
    // A roster-wide skip (account_id NULL, decision-log.js ROSTER_STAGES)
    // applies to every account and is counted under each.
    for (const r of db.prepare(`
      SELECT strategy AS s, account_id AS a, COUNT(*) AS n
        FROM decision_log
       WHERE stage = 'stage_matrix' AND decision = 'skip' AND created_at >= datetime('now', '-7 days')
       GROUP BY s, a`).all()) stageSkips[`${r.s}|${r.a ?? ''}`] = (stageSkips[`${r.s}|${r.a ?? ''}`] || 0) + r.n
  } catch { stageSkips = {} }
  const strategies = {}
  for (const s of STRATEGY_REGISTRY) {
    strategies[s.key] = {}
    for (const a of accounts) {
      const id = String(a.account_id)
      const v = evidenceGate(db, { strategy: s.key, accountId: id })
      const shadowRefusals7d = shadow[`${s.key}|${id}`] || 0
      const stageSkips7d = (stageSkips[`${s.key}|${id}`] || 0) + (stageSkips[`${s.key}|`] || 0)
      const pin = lastPinChange(db, id, s.key)
      strategies[s.key][id] = {
        live: Number(a.is_live) !== 0,
        allowed: v.allowed, via: v.via,
        record: v.record ?? evidenceRecord(db, { strategy: s.key, accountId: id, windowDays: cfg.windowDays }),
        shadowRefusals7d,
        stageSkips7d,
        pin,
        whyZero: whyZero({ allowed: v.allowed, shadowRefusals7d, stageSkips7d, pin }),
      }
    }
  }
  return { reportOnly: true, config: cfg, accounts: accounts.map(a => String(a.account_id)), strategies }
}

/** The last arming-log row that SET this cell's trade pin, or null when none recorded. */
function lastPinChange(db, accountId, strategy) {
  try {
    const w = whyCell(db, { scope: accountId, kind: 'strategy', key: strategy, stage: 'trade', current: isHandPinned(db, getState, accountId, strategy) })
    const r = w?.lastSet
    return r ? { at: r.at, to: r.to, actor: r.actor, reason: r.reason, verdict: w.verdict } : null
  } catch { return null }
}

/**
 * Why a cell the gate would refuse shows no shadow refusal. Exported for the
 * test; null when the cell is allowed or has shadow refusals to show.
 *   'refused_upstream' — the stage matrix skipped the strategy here first
 *   'unpinned_recently' — the pin was set false inside the window and
 *                         nothing has been proposed since
 *   'no_proposals'      — nothing reached either gate in the window
 */
export function whyZero({ allowed, shadowRefusals7d, stageSkips7d, pin }) {
  if (allowed || shadowRefusals7d > 0) return null
  if (stageSkips7d > 0) return 'refused_upstream'
  if (pin && String(pin.to) === 'false' && pin.at && Date.now() - Date.parse(String(pin.at).replace(' ', 'T') + (/[zZ]$/.test(String(pin.at)) ? '' : 'Z')) <= 7 * 86_400_000) return 'unpinned_recently'
  return 'no_proposals'
}
