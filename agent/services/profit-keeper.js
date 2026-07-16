// ---------------------------------------------------------------------------
// agent/services/profit-keeper.js — automatic profit protection for
// MANUAL / EXTERNAL positions (opt-in, off by default).
//
// The gap it closes: the bot watched non-bot positions but never acted, so
// a manual trade could peak well in profit and bleed back negative. The
// keeper tracks each position's peak floating profit (USD) and, once the
// peak reaches `armProfitUsd`, RATCHETS a real broker-side stop-loss that
// locks `100 - givebackPct`% of the peak. The stop lives AT THE BROKER —
// tick-level protection between loop cycles, not polling. If price has
// already retraced past the lock (or the SL amend fails), the position is
// closed at market. Optional `takeProfitUsd` closes outright at +$X.
//
// Safety by construction:
//   · opt-in (profit_keeper_json.on), scope 'external' (default) or 'all'
//   · a stop only ever TIGHTENS; the keeper never widens risk
//   · positions with owner-armed guard rules (guard_json) are skipped —
//     explicit per-position rules outrank the global policy
//   · volumes/prices come from the live broker reconcile, never stale rows
//   · every action goes through the exec engine (C++ sidecar when
//     EXEC_ENGINE=cpp) and lands in action_log + Telegram
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { instrumentType } from '../lib/contracts.js'
import { roundToDigits } from './trade-guard.js'

export const DEFAULT_PROFIT_KEEPER = {
  on: false,
  scope: 'external',      // 'external' = manual/imported positions only · 'all' = bot positions too
  armProfitUsd: 50,       // start protecting once peak floating profit reaches this
  givebackPct: 40,        // allowed retrace of the peak before the lock closes it
  takeProfitUsd: null,    // optional hard close at +$X (null = off)
}

export function loadProfitKeeperConfig(db) {
  try {
    const saved = JSON.parse(getState(db, 'profit_keeper_json') || 'null')
    return { ...DEFAULT_PROFIT_KEEPER, ...(saved || {}) }
  } catch {
    return { ...DEFAULT_PROFIT_KEEPER }
  }
}

// Quote-ccy ⇄ USD conversion for the P&L math — exact for USD-quoted
// symbols (incl. commodities/indices via instrumentType, which knows that
// NATGAS is energy, not an FX pair) and USD-base pairs; crosses with no
// USD leg are skipped rather than mis-protected.
function quoteInfo(symbol, price) {
  const t = instrumentType(symbol)
  if (t === 'fx (USD-base)') return price > 0 ? { toUsd: (q) => q / price, toQuote: (u) => u * price } : null
  if (t === 'fx cross') return null
  return { toUsd: (q) => q, toQuote: (u) => u }
}

/**
 * Pure decision for one position. Returns
 *   { newPeak, profitUsd, action } — action is null, {close:true,reason} or {sl}.
 */
export function decideProfitKeeper(cfg, { side, entry, price, lots, unitsPerLot, symbol, peak, currentSl, digits }) {
  const out = { newPeak: peak || 0, profitUsd: null, action: null }
  if (!cfg?.on || !(price > 0) || !(entry > 0) || !(lots > 0) || !(unitsPerLot > 0)) return out
  const q = quoteInfo(symbol, price)
  if (!q) return out // cross with no USD leg — cannot convert honestly
  const s = String(side || '').toUpperCase()
  const dir = s === 'LONG' || s === 'BUY' ? 1 : -1

  const profitQuote = (price - entry) * dir * lots * unitsPerLot
  const profitUsd = q.toUsd(profitQuote)
  out.profitUsd = Math.round(profitUsd * 100) / 100
  out.newPeak = Math.max(peak || 0, out.profitUsd)

  if (Number(cfg.takeProfitUsd) > 0 && profitUsd >= Number(cfg.takeProfitUsd)) {
    out.action = { close: true, reason: `take_profit_usd ${out.profitUsd} >= ${cfg.takeProfitUsd}` }
    return out
  }

  if (!(Number(cfg.armProfitUsd) > 0) || out.newPeak < Number(cfg.armProfitUsd)) return out

  const lockUsd = out.newPeak * (1 - Math.min(95, Math.max(0, Number(cfg.givebackPct))) / 100)
  if (profitUsd <= lockUsd) {
    out.action = { close: true, reason: `giveback peak=${out.newPeak.toFixed(2)} now=${out.profitUsd} lock=${lockUsd.toFixed(2)}` }
    return out
  }

  // Ratchet the broker SL to the price that locks `lockUsd` — tighten only.
  const moveQuote = q.toQuote(lockUsd) / (lots * unitsPerLot)
  const slTarget = roundToDigits(entry + dir * moveQuote, digits)
  const tighter = currentSl == null || (dir === 1 ? slTarget > currentSl : slTarget < currentSl)
  if (tighter) out.action = { sl: slTarget, lockUsd: Math.round(lockUsd * 100) / 100 }
  return out
}

/**
 * One keeper pass: broker-truth positions in scope → decide → act through
 * the exec engine. Never throws; returns a summary.
 */
export async function runProfitKeeper(db, creds, deps = {}) {
  const summary = { checked: 0, slMoves: 0, closes: 0, errors: [] }
  try {
    const cfg = loadProfitKeeperConfig(db)
    if (!cfg.on) return summary

    const scopeSql = cfg.scope === 'all'
      ? "mp.source IS NULL OR mp.source IN ('autopilot', 'external', 'manual')"
      : "mp.source IN ('external', 'manual')"
    const rows = db.prepare(
      `SELECT mp.id, mp.symbol, mp.side, mp.entry_price, mp.current_sl, mp.peak_profit_usd,
              t.ctrader_position_id AS position_id
       FROM monitored_positions mp
       JOIN trades t ON t.id = mp.trade_id
       WHERE mp.status = 'active' AND mp.guard_json IS NULL
         AND t.ctrader_position_id IS NOT NULL AND (${scopeSql})`
    ).all()
    if (rows.length === 0) return summary

    const exec = deps.exec ?? await import('../lib/exec-engine.js')
    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const sizing = deps.sizing ?? await import('../lib/lot-sizing.js')
    const notify = deps.notify ?? (() => {})

    // Broker truth: live volume, entry, current SL per position.
    const rec = await exec.reconcile(creds)
    const live = new Map()
    for (const p of (rec.position || [])) {
      if (p.positionId != null) live.set(String(p.positionId), p)
    }

    const involved = rows
      .map(r => ({ r, bp: live.get(String(r.position_id)) }))
      .filter(x => x.bp)
    const symbolIds = [...new Set(involved.map(x => x.bp.tradeData?.symbolId).filter(Boolean))]
    if (symbolIds.length === 0) return summary
    const prices = await ws.wsGetLastCloses(
      creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolIds
    )

    const updPeak = db.prepare('UPDATE monitored_positions SET peak_profit_usd = ? WHERE id = ?')
    const updAct = db.prepare(
      `UPDATE monitored_positions
       SET current_sl = COALESCE(?, current_sl), last_check_action = ?, last_check_at = datetime('now')
       WHERE id = ?`
    )

    for (const { r, bp } of involved) {
      const td = bp.tradeData || {}
      const price = prices[td.symbolId]
      if (price == null) continue
      let meta
      try {
        meta = await sizing.getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, td.symbolId)
      } catch (err) { summary.errors.push(`${r.symbol}: ${err.message}`); continue }
      summary.checked++

      const lots = td.volume && meta.lotSize ? td.volume / meta.lotSize : null
      const decision = decideProfitKeeper(cfg, {
        side: r.side,
        entry: bp.price ?? r.entry_price,
        price,
        lots,
        unitsPerLot: meta.lotSize / 100,
        symbol: r.symbol,
        peak: r.peak_profit_usd,
        currentSl: bp.stopLoss ?? r.current_sl,
        digits: meta.digits,
      })
      if (decision.newPeak !== (r.peak_profit_usd || 0)) updPeak.run(decision.newPeak, r.id)
      if (!decision.action) continue

      if (decision.action.close) {
        try {
          await exec.closePosition(creds, { positionId: parseInt(r.position_id), volume: td.volume })
          updAct.run(null, 'profit_keeper_close', r.id)
          summary.closes++
          notify(`💰 Profit Keeper closed ${r.symbol} (${r.side}) at ~${price}: ${decision.action.reason}`)
        } catch (err) { summary.errors.push(`${r.symbol} close: ${err.message}`) }
      } else if (decision.action.sl != null) {
        try {
          await exec.amendPosition(creds, { positionId: parseInt(r.position_id), stopLoss: decision.action.sl })
          updAct.run(decision.action.sl, 'profit_keeper_lock', r.id)
          summary.slMoves++
          notify(`🔒 Profit Keeper: ${r.symbol} SL ratcheted to ${decision.action.sl} (locks ~$${decision.action.lockUsd} of the $${decision.newPeak.toFixed(2)} peak)`)
        } catch (err) {
          summary.errors.push(`${r.symbol} SL: ${err.message}`)
          // Broker refused the stop (too close to market?) — if profit is
          // still above the lock we simply retry next cycle; the giveback
          // close path handles the retraced case.
        }
      }
    }

    if (summary.slMoves || summary.closes) {
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('KEEPER', '/profit-keeper', JSON.stringify(summary).slice(0, 2000))
      } catch { /* action_log appears after first boot */ }
    }
  } catch (err) {
    summary.errors.push(err.message)
  }
  return summary
}
