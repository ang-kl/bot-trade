// ---------------------------------------------------------------------------
// agent/services/global-guards.js — 5A GLOBAL CAPITAL PROTECTION (multi-
// account plan, non-negotiable requirement).
//
// Per-account limits (risk.js) protect each account from itself; this layer
// protects the WHOLE portfolio from all of them at once. It is evaluated
// inside evaluateTrade BEFORE approval, across every account's rows, so no
// single account can approve its way past a portfolio-level stop.
//
// Semantics (asymmetric merge, plan 5A): global guards only ever ADD vetoes
// on top of per-account guards — they can never loosen one. All knobs
// default OFF: with no `global_guards_json` state key, this module is a
// no-op and behaviour is identical to the pre-5A gate.
//
// Fail-safe: a `global_guards_json` value that EXISTS but cannot be parsed
// means the owner set protections we can no longer read — the safe reading
// of that state is "no new entries" (halt) until the config is fixed, never
// "carry on unprotected". A missing key is simply "feature unused" and
// stays wide open.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { fxDayStartSql } from './risk.js'
import { unresolvedPnlSince, unknownPnlBlocks, DEFAULT_UNKNOWN_PNL_BLOCK, DEFAULT_UNKNOWN_PNL_GRACE_MIN } from './unresolved-pnl.js'

export const DEFAULT_GLOBAL_GUARDS = {
  halt: false,                    // portfolio-wide no-new-entries switch
  portfolioDailyLossUsd: null,    // veto new entries when today's realized
                                  // pnl across ALL accounts ≤ -this (USD)
  maxTotalOpenPositions: null,    // cap on open bot positions across ALL accounts
  // P1 / audit F-L6-06: only meaningful alongside portfolioDailyLossUsd —
  // a closed trade with NULL net_pnl is UNKNOWN, not zero, and past the grace
  // window it blocks rather than letting the portfolio sum under-count it.
  blockOnUnknownPnl: DEFAULT_UNKNOWN_PNL_BLOCK,
  unknownPnlGraceMin: DEFAULT_UNKNOWN_PNL_GRACE_MIN,
}

/**
 * Load the global guard config. Missing key → defaults (all off).
 * Present-but-corrupt key → fail-safe halt (see header).
 */
export function loadGlobalGuards(db) {
  const raw = getState(db, 'global_guards_json')
  if (!raw) return { ...DEFAULT_GLOBAL_GUARDS }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object')
    return { ...DEFAULT_GLOBAL_GUARDS, ...parsed }
  } catch {
    return { ...DEFAULT_GLOBAL_GUARDS, halt: true, _failsafe: 'unreadable global_guards_json' }
  }
}

/**
 * Evaluate the portfolio-level guards. Pure read across ALL accounts (no
 * account_id filter — that is the point). Returns { ok:true, checks } or
 * { ok:false, reason, checks }.
 */
export function evaluateGlobalGuards(db, guards = null) {
  const g = guards || loadGlobalGuards(db)
  const checks = {}

  if (g.halt === true) {
    return { ok: false, reason: g._failsafe ? `global_halt: ${g._failsafe}` : 'global_halt', checks }
  }

  const lossCap = Number(g.portfolioDailyLossUsd)
  if (lossCap > 0) {
    // Format-proof timestamp comparison — same REPLACE normalization as the
    // per-account daily-loss gate (closed_at may be space- or T-separated).
    // Day anchor = FX day open, 17:00 NY — the SAME anchor the per-account
    // daily-loss cap moved to (owner sign-off 2026-07-24). This guard was
    // missed in that migration and still rolled at UTC midnight, so right
    // after 00:00 UTC the portfolio sum forgot the evening's losses while
    // the per-account caps still counted them.
    const dayStartSql = fxDayStartSql()
    const row = db.prepare(
      `SELECT COALESCE(SUM(net_pnl), 0) AS pnl FROM trades
       WHERE status = 'closed' AND REPLACE(closed_at, 'T', ' ') >= ?`
    ).get(dayStartSql)
    checks.portfolio_daily_pnl = row?.pnl || 0
    checks.portfolio_daily_cap_usd = lossCap

    // P1 / AUDIT F-L6-06: SUM skips NULL net_pnl and COALESCE turns an
    // all-NULL day into 0, so a day of broker-side stop-outs — which close
    // with net_pnl left NULL — reads as flat and this cap never trips. Past
    // the grace window an unknown P&L blocks instead of counting as zero.
    const unresolved = unresolvedPnlSince(db, dayStartSql, {
      accountId: null, // portfolio: every account, which is the point
      graceMin: g.unknownPnlGraceMin,
    })
    checks.portfolio_unresolved_pnl_trades = unresolved.count
    const unknown = unknownPnlBlocks(unresolved, {
      enabled: g.blockOnUnknownPnl,
      graceMin: g.unknownPnlGraceMin ?? DEFAULT_UNKNOWN_PNL_GRACE_MIN,
      scope: 'portfolio',
    })
    if (unknown.block) return { ok: false, reason: unknown.reason, checks }

    if (checks.portfolio_daily_pnl <= -lossCap) {
      return {
        ok: false,
        reason: `portfolio_daily_loss pnl=${checks.portfolio_daily_pnl.toFixed(2)} cap=${lossCap.toFixed(2)}`,
        checks,
      }
    }
  }

  const posCap = Number(g.maxTotalOpenPositions)
  if (posCap > 0) {
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM trades WHERE status = 'open'`
    ).get()
    checks.portfolio_open_positions = row?.n || 0
    checks.portfolio_position_cap = posCap
    if (checks.portfolio_open_positions >= posCap) {
      return {
        ok: false,
        reason: `portfolio_position_cap open=${checks.portfolio_open_positions} cap=${posCap}`,
        checks,
      }
    }
  }

  return { ok: true, checks }
}
