// ---------------------------------------------------------------------------
// agent/services/account-pregate.js — the cycle-level guards, asked ONCE per
// account per cycle, before any symbol is built into an order for it.
//
// PR-C of docs/owner-principles-plan-2026-09-11.md (owner principle 7:
// vetoes are a cost to minimise). Measured 11-09-2026 on production: 10,593
// proposals reached the risk gate, 10,580 were vetoed, 9,915 of them
// `max_positions`. An account sitting at its cap was asked the same question
// once per symbol per cycle — ~36k evaluations a day, each a risk_events row,
// each answered identically until a position closed.
//
// The inputs of these guards are per-account and cycle-stable: the balance's
// scope, the FX-day loss picture, the campaign stop, the unknown-P&L block,
// the loss streak and the open-position count do not change between two
// symbols of the same cycle. So they are asked here, first, and an account
// they refuse writes ONE decision_log skip (stage `account_pregate:<guard>`)
// and contributes no risk_events rows that cycle.
//
// SAME FUNCTION, TWO CALLERS. Every predicate here is an export of risk.js
// that evaluateTrade itself calls — balanceScopeVerdict, dailyLossVerdict,
// lossStreakVerdict, openPositionsForAccount + maxPositionsVerdict,
// exposureVerdict, correlationVerdict, rrFloorVerdict. The gate keeps all of
// them as the backstop (the checkSymbolCap doctrine: a guard only one caller
// consults stopped none of the seventeen), and because it is the same
// function the two cannot drift.
//
// Two levels, because two of the eight need the proposal: the currency
// exposure and the correlation caps combine the held book with THIS symbol
// and side, so they run per (account, symbol) in proposalPregate — still
// before the gate, still as skips, on the same memoised position read.
//
// Nothing here throws into the loop: a reader that fails answers "ok" and the
// gate decides, which is the same fail-open shape the margin pool uses.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { sizingBalance } from '../lib/sizing-balance.js'
import {
  loadRiskConfig, getAccountBalance,
  balanceScopeVerdict, dailyLossVerdict, lossStreakVerdict,
  openPositionsForAccount, maxPositionsVerdict, countedPositionsWithTickFires,
  exposureVerdict, correlationVerdict, rrFloorVerdict,
} from './risk.js'
import { recordDecision } from './decision-log.js'

export const PREGATE_STAGE_PREFIX = 'account_pregate:'
export const RR_PREFILTER_STAGE = 'rr_prefilter'

let memoCycle = null
const memo = new Map() // accountId → verdict for memoCycle

/** Forget the per-cycle memo. Tests; the loop passes a fresh `cycle` instead. */
export function resetAccountPregate() {
  memoCycle = null
  memo.clear()
}

/**
 * The six account-level guards, in the gate's order, for one account. Pure
 * read — writes nothing. Returns `{ ok, guard, reason, openPositions, config,
 * balance }` so the proposal-level checks can reuse the position read.
 */
export function accountPregateVerdict(db, accountId, { config = null, nowMs = Date.now() } = {}) {
  const acct = accountId != null ? String(accountId) : (getState(db, 'ctrader_account_id') || null)
  const cfg = config || loadRiskConfig(db, acct)
  const refuse = (v, extra = {}) => ({ ok: false, guard: v.guard, reason: v.reason, config: cfg, ...extra })

  const bal = sizingBalance(db, acct)
  const scope = balanceScopeVerdict(bal)
  if (scope.block) return refuse(scope)

  const balance = getAccountBalance(db, acct)
  const daily = dailyLossVerdict(db, cfg, acct, { balance, nowMs })
  if (daily.block) return refuse(daily, { balance })

  const streak = lossStreakVerdict(db, cfg, acct, nowMs)
  if (streak.block) return refuse(streak, { balance })

  // The count is the leak-fixed scoped read; the list the proposal-level
  // checks reuse stays NULL-inclusive (see openPositionsForAccount).
  // C9: the same count as the gate's step 3, unadopted tick fires included.
  const counted = countedPositionsWithTickFires(db, acct, { now: nowMs }).counted
  const cap = maxPositionsVerdict(counted, cfg)
  if (cap.block) return refuse(cap, { balance })
  const openPositions = openPositionsForAccount(db, acct)

  return { ok: true, guard: null, reason: null, config: cfg, balance, openPositions }
}

/**
 * What the memo is keyed on besides the cycle: the account's active book.
 * A fill or a close INSIDE a cycle changes this, so the next symbol re-asks
 * instead of trusting a verdict about a book that no longer exists. One
 * indexed aggregate per call, against the six-guard evaluation it saves.
 */
function bookFingerprint(db, acct) {
  try {
    const r = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS top
         FROM monitored_positions
        WHERE status = 'active' AND (account_id = ? OR account_id IS NULL OR ? IS NULL)`
    ).get(acct, acct)
    return `${r?.n ?? 0}:${r?.top ?? 0}`
  } catch { return null }
}

/** Forget one account's verdict for the current cycle — the loop calls this after it places an order. */
export function invalidateAccountPregate(accountId) {
  memo.delete(accountId != null ? String(accountId) : '-')
}

/**
 * Ask the account-level guards once per `cycle` and record ONE skip row for a
 * refused account. Subsequent calls in the same cycle (one per symbol in the
 * fan-out) return the memoised verdict and write nothing.
 *
 * `cycle` is the loop's counter; without one nothing is memoised (every call
 * is a fresh read and a fresh row), which is the shape tests use to prove the
 * row is written and the shape the memo exists to avoid.
 */
export function accountPregate(db, accountId, { cycle = null, config = null, nowMs = Date.now() } = {}) {
  if (cycle != null && cycle !== memoCycle) {
    memoCycle = cycle
    memo.clear()
  }
  const key = accountId != null ? String(accountId) : '-'
  const acct = key === '-' ? null : key
  const fp = cycle != null ? bookFingerprint(db, acct) : null
  const had = cycle != null ? memo.get(key) : undefined
  if (had && had.fingerprint === fp) return had
  let v
  try {
    v = accountPregateVerdict(db, accountId, { config, nowMs })
  } catch (err) {
    // Fail open: the gate is the backstop and will read the same state.
    v = { ok: true, guard: null, reason: null, config: config || null, balance: null, openPositions: null, unreadable: String(err?.message || err) }
  }
  // One row per (account, cycle, guard): a re-ask after the book changed
  // writes again only when the answer changed.
  if (!v.ok && !(had && !had.ok && had.guard === v.guard)) {
    recordDecision(db, {
      accountId: acct,
      symbol: null, timeframe: null, strategy: null,
      stage: `${PREGATE_STAGE_PREFIX}${v.guard}`, decision: 'skip',
      reason: v.reason, loopId: cycle,
      detail: { guard: v.guard, cycle, onceForCycle: true },
    })
  }
  if (cycle != null) memo.set(key, { ...v, fingerprint: fp })
  return v
}

/**
 * The proposal-level pre-gate for one (account, symbol): the currency
 * exposure cap, the correlation cap and the R:R floor — each the gate's own
 * function, each recorded as a decision_log skip instead of a risk_events
 * veto. Returns `{ ok, stage, reason }`.
 *
 * `proposal` is `{ symbol, side, strategy, timeframe, entry, sl, tp1 }` with
 * side as BUY/SELL. Missing prices skip the R:R check — the gate names that
 * case itself (missing_entry_or_sl / tp_required) and owns it.
 *
 * `account` is the verdict accountPregate returned (its position read and
 * config are reused); a null/unreadable one triggers a fresh read.
 */
export function proposalPregate(db, accountId, proposal, { cycle = null, account = null, nowMs = Date.now() } = {}) {
  const acct = accountId != null ? String(accountId) : null
  const skip = (stage, reason, detail = null) => {
    recordDecision(db, {
      accountId: acct,
      symbol: proposal.symbol, timeframe: proposal.timeframe ?? null, strategy: proposal.strategy ?? null,
      stage, decision: 'skip', reason, loopId: cycle, detail,
    })
    return { ok: false, stage, reason }
  }
  try {
    const cfg = account?.config || loadRiskConfig(db, acct)
    const openPositions = Array.isArray(account?.openPositions) ? account.openPositions : openPositionsForAccount(db, acct)

    const expo = exposureVerdict(openPositions, proposal, cfg)
    if (expo.block) return skip(`${PREGATE_STAGE_PREFIX}overexposed`, expo.reason, { exposure: expo.exposure })

    const corr = correlationVerdict(db, openPositions, proposal, cfg, nowMs)
    if (corr.block) return skip(`${PREGATE_STAGE_PREFIX}correlated`, corr.reason, { correlation: corr.detail })

    const entry = Number(proposal.entry), sl = Number(proposal.sl), tp1 = Number(proposal.tp1)
    if (Number.isFinite(entry) && Number.isFinite(sl) && Number.isFinite(tp1) && Math.abs(entry - sl) > 0) {
      const rr = Math.round((Math.abs(tp1 - entry) / Math.abs(entry - sl)) * 100) / 100
      const rrV = rrFloorVerdict(db, {
        strategy: proposal.strategy, rr, accountId: acct, config: cfg,
        entry, sl, tp1, side: proposal.side,
      })
      if (!rrV.ok) return skip(RR_PREFILTER_STAGE, rrV.reason, { rr, rrFloor: rrV.rrFloor, requested: rrV.requested, ...rrV.checks })
    }
  } catch {
    // Fail open — the gate reads the same state and decides.
  }
  return { ok: true, stage: null, reason: null }
}
