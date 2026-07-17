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
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { atrFromBars } from './profit-keeper.js'
import { loadRiskConfig, getAccountBalance, scanRates } from './risk.js'
import { usdLossPerLot } from '../lib/contracts.js'

const r5 = (v) => Math.round(v * 100000) / 100000

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
  const capUsd = balance != null ? Math.round(balance * (riskCfg.perTradeRiskPct ?? 0.01) * 100) / 100 : null
  const rr = dist && tp != null ? Math.round((Math.abs(tp - entry) / dist) * 100) / 100 : null
  const issues = []
  if (riskUsd != null && capUsd != null && riskUsd > capUsd) issues.push(`risk $${riskUsd} exceeds your ${((riskCfg.perTradeRiskPct ?? 0.01) * 100).toFixed(1)}% cap ($${capUsd})`)
  if (sl == null) issues.push('position has NO stop loss at the broker')
  if (rr != null && rr < (riskCfg.minRR ?? 1.5)) issues.push(`R:R ${rr} is below your ${riskCfg.minRR ?? 1.5} floor`)
  return { riskUsd, capUsd, rr, issues, side }
}

/**
 * React to one tamper-watch change. Returns a summary object; never throws.
 * deps: { fetchBars(symbol) → 1h bars, amend(creds, {positionId, stopLoss,
 * takeProfit}), now } — all optional, real implementations resolved lazily.
 */
export async function restrategizeAfterTamper(db, creds, change, deps = {}) {
  try {
    const mp = db.prepare(
      `SELECT mp.*, t.volume AS lots, t.ctrader_position_id AS position_id
       FROM monitored_positions mp
       LEFT JOIN trades t ON t.id = mp.trade_id
       WHERE mp.status = 'active' AND t.ctrader_position_id = ?`
    ).get(String(change.positionId))
    if (!mp) return { did: 'skipped', reason: 'position_not_found' }

    const riskCfg = loadRiskConfig(db)
    const balance = getAccountBalance(db)
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

    let bars = null
    try {
      if (deps.fetchBars) bars = await deps.fetchBars(mp.symbol)
      else {
        const symbolMap = JSON.parse(getState(db, 'symbol_id_map') || '{}')
        const symbolId = symbolMap[String(mp.symbol).toUpperCase()]
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

    const amend = deps.amend ?? (await import('../lib/exec-engine.js')).amendPosition
    await amend(creds, { positionId: mp.position_id, stopLoss: levels.sl, takeProfit: levels.tp })
    db.prepare(
      `UPDATE monitored_positions SET current_sl = ?, current_tp = ?, initial_risk = ?,
         broker_sl = ?, broker_tp = ?,
         thesis = COALESCE(thesis, '') || ' | SL/TP recalibrated for the reversed direction (1×ATR stop, ' || ? || 'R target)'
       WHERE id = ?`
    ).run(levels.sl, levels.tp, levels.slDist, levels.sl, levels.tp, String(riskCfg.minRR ?? 1.5), mp.id)

    const audit = auditRisk({ symbol: mp.symbol, side: mp.side, entry: mp.entry_price, sl: levels.sl, tp: levels.tp, lots: mp.lots, balance, riskCfg, rates })
    return { did: 'recalibrated', aligned, sl: levels.sl, tp: levels.tp, ...audit }
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
    const iss = outcome.issues?.length ? ` ⚠ ${outcome.issues.join('; ')}.` : ' Within your risk limits.'
    return `${base}${iss}`
  }
  if (outcome.did === 'verified_only') {
    return outcome.proposed ? ` Recalibration is OFF — proposed SL ${outcome.proposed.sl} · TP ${outcome.proposed.tp} not applied.` : ''
  }
  if (outcome.did === 'error') return ` (re-strategize failed: ${outcome.error})`
  return ''
}
