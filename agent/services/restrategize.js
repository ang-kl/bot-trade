// ---------------------------------------------------------------------------
// agent/services/restrategize.js — after the tamper watch detects a manual
// change to a tracked position, VERIFY the changed trade against the market
// and RECALIBRATE (owner: "re-strategize and verify if the intention trade
// has been tampered, and recalibrate the TP and SL").
//
// Per change kind, the honest response differs:
//
// · reversed  → the original thesis is dead. Read the market fresh (1h ATR +
//   momentum), recalibrate SL/TP for the NEW direction (1×ATR stop, minRR×
//   reward), AMEND them at the broker, and report whether current momentum
//   even supports the owner's new direction.
// · volume    → levels stay (the setup didn't change) but the RISK did:
//   recompute risked USD at the current SL against the per-trade cap and
//   flag a breach; sync trades.volume so future partials size correctly.
// · sl/tp move→ the owner SET those levels deliberately — never fight them.
//   Audit only: recompute R:R and risked USD, flag if below minRR or above
//   the risk cap.
//
// Toggle: agent_state tamper_restrategize ('false' disables the amend path;
// audits still run). All deps injectable for tests.
//
// THE AMEND THE BROKER WILL TAKE (12-10-2026, demo stress run D3; owner
// "Writer + re-strategize"). The levels were rounded to five places and set
// from the last 1h close; nothing checked them against the symbol or the
// market. Measured at 13:36Z on 43097342: GER40 refused ("25221.41403 has
// more digits than symbol allows. Allowed 1 digits") and DOW.US refused ("New
// SL for BUY position should be <= current BID price. current BID: 28.14, SL:
// 28.20788"). The reversal amend now rounds to the symbol's own digits (this
// account's broker record, read by the symbol id the reversed position
// carries) and refuses a stop on the wrong side of the current quote; without
// the symbol id, verified digits or a two-sided quote it amends nothing and
// says why. Claude · № 13,782 12-Oct (claude-builder)
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { atrFromBars } from './profit-keeper.js'
import { loadRiskConfig, getAccountBalance, scanRates } from './risk.js'
import { usdLossPerLot } from '../lib/contracts.js'
import { measureAmend } from './protection-latency.js'
import { roundToDigits } from './trade-guard.js'

const r5 = (v) => Math.round(v * 100000) / 100000
const positiveInt = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 ? n : null }

/** Pure: fresh SL/TP for a direction from price + ATR (floor at minSlPct). */
export function recalibrateLevels({ side, price, atr, minSlPct = 0.001, rr = 1.5 }) {
  const p = Number(price)
  const dir = side === 'long' ? 1 : -1
  const slDist = Math.max(Number(atr) || 0, p * minSlPct)
  if (!(p > 0) || !(slDist > 0)) return null
  return { sl: r5(p - dir * slDist), tp: r5(p + dir * slDist * rr), slDist: r5(slDist) }
}

/** Pure: risk audit for a position shape. */
export function auditRisk({ symbol, side, entry, sl, tp, lots, balance, riskCfg, rates = null }) {
  const dist = entry != null && sl != null ? Math.abs(entry - sl) : null
  const perLot = dist ? usdLossPerLot(symbol, dist, entry, rates) : null
  const riskUsd = perLot != null && lots != null ? Math.round(perLot * lots * 100) / 100 : null
  const capUsd = balance != null ? Math.round(balance * (riskCfg.perTradeRiskPct ?? 0.05) * 100) / 100 : null
  const rr = dist && tp != null ? Math.round((Math.abs(tp - entry) / dist) * 100) / 100 : null
  const issues = []
  if (riskUsd != null && capUsd != null && riskUsd > capUsd) issues.push(`risk $${riskUsd} exceeds your ${((riskCfg.perTradeRiskPct ?? 0.05) * 100).toFixed(1)}% cap ($${capUsd})`)
  if (sl == null) issues.push('position has NO stop loss at the broker')
  if (rr != null && rr < (riskCfg.minRR ?? 1.5)) issues.push(`R:R ${rr} is below your ${riskCfg.minRR ?? 1.5} floor`)
  return { riskUsd, capUsd, rr, issues, side }
}

/**
 * React to one tamper-watch change. Returns a summary object; never throws.
 * deps: { fetchBars(symbol) → 1h bars, amend(creds, {positionId, stopLoss,
 * takeProfit}), getMeta(symbolId) → {brokerDigits}, getQuote(symbolId) →
 * {bid, ask}, now } — all optional, real implementations resolved lazily.
 */
export async function restrategizeAfterTamper(db, creds, change, deps = {}) {
  try {
    const accountId = creds?.accountId == null ? null : String(creds.accountId)
    if (!accountId) return { did: 'skipped', reason: 'account_required' }
    // A broker position ID is only meaningful within its account. One known
    // owner may identify a legacy NULL stamp, but conflicting or wholly
    // unattributed rows cannot authorise a ledger or broker amendment.
    const matches = db.prepare(
      `SELECT mp.*, t.volume AS lots, t.ctrader_position_id AS position_id
       FROM monitored_positions mp
       LEFT JOIN trades t ON t.id = mp.trade_id
       WHERE mp.status = 'active' AND t.ctrader_position_id = ?
         AND (t.account_id = ? OR mp.account_id = ?)
         AND (t.account_id IS NULL OR t.account_id = ?)
         AND (mp.account_id IS NULL OR mp.account_id = ?)`
    ).all(String(change.positionId), accountId, accountId, accountId, accountId)
    if (matches.length > 1) return { did: 'skipped', reason: 'position_identity_ambiguous' }
    const mp = matches[0]
    if (!mp) return { did: 'skipped', reason: 'position_not_found' }

    const riskCfg = loadRiskConfig(db, accountId)
    const balance = getAccountBalance(db, accountId)
    const rates = scanRates(db)

    // ---- volume change: levels keep, risk re-audited, ledger synced ------
    if (change.kind === 'volume') {
      const ratio = Number(change.from) > 0 ? Number(change.to) / Number(change.from) : null
      const newLots = ratio != null && mp.lots != null ? Math.round(mp.lots * ratio * 100) / 100 : mp.lots
      if (newLots != null && mp.trade_id && ratio != null) {
        db.prepare('UPDATE trades SET volume = ? WHERE id = ?').run(newLots, mp.trade_id)
      }
      const audit = auditRisk({ symbol: mp.symbol, side: mp.side, entry: mp.entry_price, sl: mp.current_sl, tp: mp.current_tp, lots: newLots, balance, riskCfg, rates })
      return { did: 'risk_audit', lots: newLots, ...audit }
    }

    // ---- SL/TP hand-moved: respect the owner's levels, audit only --------
    if (change.kind === 'sl_moved' || change.kind === 'tp_moved') {
      const audit = auditRisk({ symbol: mp.symbol, side: mp.side, entry: mp.entry_price, sl: mp.current_sl, tp: mp.current_tp, lots: mp.lots, balance, riskCfg, rates })
      return { did: 'risk_audit', lots: mp.lots, ...audit }
    }

    // ---- reversal: full re-strategize + recalibrate ----------------------
    if (change.kind !== 'reversed') return { did: 'skipped', reason: 'unknown_kind' }

    // The symbol id this account holds the position under, from its own
    // snapshot (the reconciler's reversed change carries it).
    const ownSymbolId = positiveInt(change.symbolId)

    let bars = null
    try {
      if (deps.fetchBars) bars = await deps.fetchBars(mp.symbol)
      else {
        const symbolMap = JSON.parse(getState(db, 'symbol_id_map') || '{}')
        const symbolId = ownSymbolId ?? symbolMap[String(mp.symbol).toUpperCase()]
        if (symbolId) {
          const ws = await import('../lib/ctrader-ws.js')
          const byTf = await ws.wsGetTrendbarsBatch(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId, ['1h'], 40, 20_000)
          bars = byTf['1h'] || null
        }
      }
    } catch { /* market read best-effort */ }

    const lastClose = bars?.length ? bars[bars.length - 1].c : mp.entry_price
    const atr = bars?.length ? atrFromBars(bars) : null
    // Direction check: 1h momentum over the last 4 closed bars — does the
    // market even lean the way the owner reversed to?
    let aligned = null
    if (bars?.length >= 5) {
      const mom = lastClose - bars[bars.length - 5].c
      aligned = mp.side === 'long' ? mom > 0 : mom < 0
    }

    const levels = recalibrateLevels({ side: mp.side, price: lastClose, atr, rr: riskCfg.minRR ?? 1.5 })
    if (!levels) return { did: 'verified_only', aligned, reason: 'no_market_read' }

    if (getState(db, 'tamper_restrategize') === 'false') {
      return { did: 'verified_only', aligned, proposed: levels, reason: 'recalibrate_disabled' }
    }

    // D3: the amend the broker will take — the symbol's digits, the stop on
    // the right side of the current quote — or no amend, with the reason.
    const notApplied = (reason, extra = {}) => ({ did: 'verified_only', aligned, proposed: levels, reason, ...extra })
    if (ownSymbolId == null) return notApplied('symbol_identity_unknown')
    let digits = null
    try {
      const meta = deps.getMeta ? await deps.getMeta(ownSymbolId)
        : await (await import('../lib/lot-sizing.js')).getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, accountId, ownSymbolId)
      digits = meta?.brokerDigits
    } catch { /* unread precision is unverified precision */ }
    if (!Number.isInteger(digits) || digits < 0 || digits > 10) return notApplied('digits_unverified')
    let quote = null
    try {
      quote = deps.getQuote ? await deps.getQuote(ownSymbolId)
        : await (await import('../lib/ctrader-ws.js')).wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, accountId, ownSymbolId)
    } catch { /* no quote */ }
    const bid = Number(quote?.bid)
    const ask = Number(quote?.ask)
    if (!(bid > 0) || !(ask > 0)) return notApplied('no_current_quote')
    const sl = roundToDigits(levels.sl, digits)
    const tp = roundToDigits(levels.tp, digits)
    // A long's stop sits below the bid it would close at, a short's above the ask.
    if (mp.side === 'long' ? !(sl < bid) : !(sl > ask)) {
      return notApplied('stop_wrong_side', { proposed: { ...levels, sl, tp }, quote: { bid, ask } })
    }

    const amend = deps.amend ?? (await import('../lib/exec-engine.js')).amendPosition
    // V3 M5: timed on the way through; the payload is untouched.
    await measureAmend({ path: 'restrategize', source: 'restrategize', accountId, positionId: mp.position_id },
      () => amend(creds, { positionId: mp.position_id, stopLoss: sl, takeProfit: tp }))
    db.prepare(
      `UPDATE monitored_positions SET current_sl = ?, current_tp = ?, initial_risk = ?,
         broker_sl = ?, broker_tp = ?,
         thesis = COALESCE(thesis, '') || ' | SL/TP recalibrated for the reversed direction (1×ATR stop, ' || ? || 'R target)'
       WHERE id = ?`
    ).run(sl, tp, levels.slDist, sl, tp, String(riskCfg.minRR ?? 1.5), mp.id)

    const audit = auditRisk({ symbol: mp.symbol, side: mp.side, entry: mp.entry_price, sl, tp, lots: mp.lots, balance, riskCfg, rates })
    return { did: 'recalibrated', aligned, sl, tp, ...audit }
  } catch (e) {
    return { did: 'error', error: e.message }
  }
}

/** Human sentence for the Telegram alert tail. */
export function summarize(outcome) {
  if (!outcome) return ''
  if (outcome.did === 'recalibrated') {
    const dir = outcome.aligned == null ? '' : outcome.aligned
      ? ' 1h momentum AGREES with your new direction.'
      : ' ⚠ 1h momentum does NOT support your new direction — managing defensively.'
    const iss = outcome.issues?.length ? ` Issues: ${outcome.issues.join('; ')}.` : ''
    return ` Recalibrated: SL ${outcome.sl} · TP ${outcome.tp}.${dir}${iss}`
  }
  if (outcome.did === 'risk_audit') {
    const base = outcome.riskUsd != null ? ` Risk now $${outcome.riskUsd}${outcome.capUsd != null ? ` (cap $${outcome.capUsd})` : ''}${outcome.rr != null ? ` · R:R ${outcome.rr}` : ''}.` : ''
    const incomplete = outcome.riskUsd == null || outcome.capUsd == null || outcome.rr == null
    const iss = outcome.issues?.length ? ` ⚠ ${outcome.issues.join('; ')}.` : incomplete ? '' : ' Within your risk limits.'
    return `${base}${iss}${incomplete ? ' Risk comparison incomplete; one or more inputs are unavailable.' : ''}`
  }
  if (outcome.did === 'verified_only') {
    if (!outcome.proposed) return ''
    const levels = `proposed SL ${outcome.proposed.sl} · TP ${outcome.proposed.tp}`
    if (outcome.reason === 'recalibrate_disabled') return ` Recalibration is OFF — ${levels} not applied.`
    const why = {
      symbol_identity_unknown: 'the symbol this account holds the position under is unknown',
      digits_unverified: "the symbol's price precision is unverified",
      no_current_quote: 'there is no current two-sided quote',
      stop_wrong_side: `the stop would sit on the wrong side of the current price (bid ${outcome.quote?.bid} · ask ${outcome.quote?.ask})`,
    }[outcome.reason] || outcome.reason
    return ` Not recalibrated: ${why} — ${levels} not sent.`
  }
  if (outcome.did === 'error') return ` (re-strategize failed: ${outcome.error})`
  if (outcome.did === 'skipped') return ` (re-strategize skipped: ${outcome.reason})`
  return ''
}
