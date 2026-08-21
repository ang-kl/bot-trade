// ---------------------------------------------------------------------------
// agent/services/stopout-estimate.js — price the trades the ledger cannot.
//
// Owner order, 2026-08-22 audit item 2: "the daily-loss gauge must count
// broker-side stop-outs at planned risk immediately, not when the P&L
// backfill lands."
//
// THE HOLE THIS CLOSES. A trade stopped out AT THE BROKER closes with
// net_pnl NULL until the backfill fills it in. Every daily gauge is a
// `SUM(net_pnl)` — and SUM skips NULLs — so on exactly the kind of day the
// gauges exist for (a run of fast stop-outs) they read the day as flat.
// 21 Aug 2026, account 46130058: three NatGas stop-outs and a flipped short,
// all NULL at the time, and an AUTO entry was approved at 16:09 SGT with the
// day already 4.4% down against a 3% cap. unresolved-pnl.js blocks entries on
// the same fact, but it AGES OUT (unknownPnlMaxAgeMin / unknownPnlMinAttempts)
// — after which the rows neither block nor count. This module makes them
// count.
//
// WHAT A NULL ROW IS WORTH. The plan knew: the entry, the stop and the volume
// were all recorded when the trade was placed, and
// `usdLossPerLot(symbol, |entry − sl|, entry, rates) × volume` is the loss the
// stop was DESIGNED to take. It is a floor, not the truth — the same audit
// measured a stop-out filled at 3.7× planned risk — but a floor pulls the
// gauge the right way, and the moment the backfill lands the row leaves this
// estimate and enters the SUM with its real value. A row is always in exactly
// one of the two: NULL and estimated, or filled and summed. No double count.
//
// WHAT IS NOT COUNTED. A NULL row whose close looks like a TAKE-PROFIT
// (close_reason names tp/target/bank, or the exit sits on tp_price —
// perf-ledger's classifyOutcome) is skipped: charging a winner at planned
// risk would spend the daily budget on money that was MADE. It backfills
// positive and enters the sum then. Everything else — stop-shaped, manual,
// unclassifiable — is treated as a stop-out, because a close we cannot read
// is exactly the one not to assume was fine.
// ---------------------------------------------------------------------------

import { usdLossPerLot } from '../lib/contracts.js'
import { classifyOutcome } from './perf-ledger.js'

/**
 * Planned risk of ONE trade row in USD, or null when it cannot be priced.
 * Distance = |entry − sl|; a row with no stop recorded cannot be priced here
 * (initial_risk lives on monitored_positions, not trades).
 */
export function plannedRiskUsd(row, rates = null) {
  // `Number(null)` is 0 and 0 is finite — a missing stop must read as
  // UNPRICEABLE, not as a stop sitting at zero (which would price the row at
  // the full entry distance). Same guard the cooldown-counterfactual carries.
  const num = (v) => {
    if (v == null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  const entry = num(row.entry_price)
  const sl = num(row.sl_price)
  const vol = num(row.volume)
  if (entry == null || sl == null || vol == null) return null
  const dist = Math.abs(entry - sl)
  if (!(dist > 0) || !(vol > 0)) return null
  const perLot = usdLossPerLot(row.symbol, dist, entry, rates)
  if (!Number.isFinite(perLot) || !(perLot > 0)) return null
  return Math.round(perLot * vol * 100) / 100 // cents — see estimate below
}

/** Is this NULL-pnl closed row a stop-out for gauge purposes? (Everything
 * except a clearly TP-shaped close — see header.) */
export function countsAsStopout(row) {
  return classifyOutcome(row) !== 'tp'
}

/**
 * Estimate the unpriced losses among closed trades since `sinceSql`
 * (space-separated "YYYY-MM-DD HH:MM:SS", compared with the same
 * REPLACE(closed_at,'T',' ') normalisation as every daily gauge).
 *
 * Account scoping — three modes because the three callers legitimately
 * differ (see equity-stop.js's attribution note):
 *   accountId undefined/null + scope 'all'      → every row (portfolio)
 *   accountId set + scope 'scoped' (default)    → account's rows + NULL-account rows
 *   accountId set + scope 'attributed'          → account's rows only
 *
 * @returns {{ estUsd:number, counted:number, unpriceable:number, tpSkipped:number }}
 *   estUsd is a POSITIVE magnitude (callers subtract it from their sum).
 *   unpriceable rows are counted but contribute $0 — they still trip the
 *   unresolved-pnl block during its window, which is the remaining cover.
 */
export function estimateStopoutLossUsd(db, { sinceSql, accountId = null, scope = 'scoped', rates = null }) {
  let where = ''
  const params = [sinceSql]
  if (accountId != null && scope === 'attributed') {
    where = 'AND account_id = ?'
    params.push(String(accountId))
  } else if (accountId != null) {
    where = 'AND (account_id = ? OR account_id IS NULL)'
    params.push(String(accountId))
  }
  const rows = db.prepare(
    `SELECT symbol, entry_price, exit_price, sl_price, tp_price, volume,
            net_pnl, close_reason
       FROM trades
      WHERE status = 'closed' AND net_pnl IS NULL
        AND closed_at IS NOT NULL
        AND REPLACE(closed_at, 'T', ' ') >= ? ${where}`
  ).all(...params)

  let estUsd = 0
  let counted = 0
  let unpriceable = 0
  let tpSkipped = 0
  for (const row of rows) {
    if (!countsAsStopout(row)) { tpSkipped++; continue }
    const usd = plannedRiskUsd(row, rates)
    if (usd == null) { unpriceable++; continue }
    estUsd += usd
    counted++
  }
  // Cents precision: these figures land in veto strings and checks_json, and
  // 150.00000000000568 is float noise, not information.
  return { estUsd: Math.round(estUsd * 100) / 100, counted, unpriceable, tpSkipped }
}
