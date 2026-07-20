// ---------------------------------------------------------------------------
// agent/services/profit-keeper.js — automatic profit protection for
// MANUAL / EXTERNAL positions (opt-in, off by default).
//
// Two modes:
//
// ADAPTIVE (default) — thresholds in volatility units, not dollars, so the
// policy self-scales across instruments, position sizes and regimes:
//   · arm once peak floating profit ≥ max(armAtrMult × ATR-value of the
//     position, armBalancePct% of balance)
//   · then RATCHET a broker-side stop `trailAtrMult × ATR` behind the peak
//     price (Chandelier exit) — tighten-only
//   · optional scale-out: close `scaleOutFrac` of the position once armed
//     (bank some, let the rest run)
//   · if price has already fallen through the trail, close at market
//
// FIXED — the original dollar policy: arm at +$X peak, close when profit
// gives back more than givebackPct% of the peak, SL ratchet at the lock.
//
// Both modes: optional takeProfitUsd closes outright at +$X. The stop lives
// AT THE BROKER — tick-level protection between loop cycles, not polling.
//
// Safety by construction:
//   · opt-in (profit_keeper_json.on), scope 'external' (default) or 'all'
//   · a stop only ever TIGHTENS; the keeper never widens risk
//   · losing positions are untouched — nothing happens until profit arms
//   · positions with owner-armed guard rules (guard_json) are skipped
//   · volumes/prices come from the live broker reconcile, never stale rows
//   · every action goes through the exec engine (C++ sidecar when
//     EXEC_ENGINE=cpp) and lands in action_log + Telegram
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { instrumentType } from '../lib/contracts.js'
import { getAccountBalance } from './risk.js'
import { roundToDigits } from './trade-guard.js'

export const DEFAULT_PROFIT_KEEPER = {
  on: false,
  scope: 'external',      // 'external' = manual/imported positions only · 'all' = bot positions too
  mode: 'adaptive',       // 'adaptive' (ATR/balance units) · 'fixed' (dollar thresholds)
  // adaptive mode
  atrTimeframe: '1h',
  atrPeriod: 14,
  armAtrMult: 1,          // arm once peak profit ≥ this × the position's ATR-value…
  armBalancePct: 0.1,     // …and at least this % of balance (noise floor)
  trailAtrMult: 2.5,      // Chandelier: SL trails this × ATR behind the peak price
  scaleOutFrac: 0,        // fraction closed once armed (0 = off, 0.5 = half)
  // fixed mode
  armProfitUsd: 50,
  givebackPct: 40,
  // both modes
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

/**
 * Wilder's ATR from OHLC bars [{h,l,c}…] oldest→newest. Returns null when
 * there are not enough bars for the period.
 */
export function atrFromBars(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null
  const trs = []
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]
    const prevC = bars[i - 1].c
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC)))
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }
  return atr
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
 * Pure decision for one position. `action` is null or an object that may
 * combine { close, reason } | { sl, lockUsd } | { scaleOutFrac }.
 */
export function decideProfitKeeper(cfg, {
  side, entry, price, lots, unitsPerLot, symbol, peak, currentSl, digits,
  atr = null, balance = null, scaledOut = false,
}) {
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

  const tighter = (candidate) =>
    currentSl == null || (dir === 1 ? candidate > currentSl : candidate < currentSl)

  if (cfg.mode === 'adaptive' && atr > 0) {
    // Arm threshold in volatility units with a balance-relative noise floor.
    const armUsdAtr = q.toUsd(Number(cfg.armAtrMult) * atr * lots * unitsPerLot)
    const armUsdBal = balance > 0 ? balance * (Number(cfg.armBalancePct) / 100) : 0
    const armUsd = Math.max(armUsdAtr, armUsdBal)
    if (!(armUsd > 0) || out.newPeak < armUsd) return out

    // Chandelier trail: SL sits trailAtrMult × ATR behind the PEAK price.
    const peakPrice = entry + dir * q.toQuote(out.newPeak) / (lots * unitsPerLot)
    const slTarget = roundToDigits(peakPrice - dir * Number(cfg.trailAtrMult) * atr, digits)
    const breached = dir === 1 ? price <= slTarget : price >= slTarget
    if (breached) {
      out.action = { close: true, reason: `chandelier peak=${out.newPeak.toFixed(2)} trail=${slTarget} now=${price}` }
      return out
    }
    const action = {}
    if (Number(cfg.scaleOutFrac) > 0 && !scaledOut) action.scaleOutFrac = Math.min(0.9, Number(cfg.scaleOutFrac))
    if (tighter(slTarget)) {
      action.sl = slTarget
      action.lockUsd = Math.round(q.toUsd((slTarget - entry) * dir * lots * unitsPerLot) * 100) / 100
    }
    out.action = Object.keys(action).length ? action : null
    return out
  }

  // FIXED mode (also the fallback when no ATR is available).
  if (!(Number(cfg.armProfitUsd) > 0) || out.newPeak < Number(cfg.armProfitUsd)) return out

  const lockUsd = out.newPeak * (1 - Math.min(95, Math.max(0, Number(cfg.givebackPct))) / 100)
  if (profitUsd <= lockUsd) {
    out.action = { close: true, reason: `giveback peak=${out.newPeak.toFixed(2)} now=${out.profitUsd} lock=${lockUsd.toFixed(2)}` }
    return out
  }
  const moveQuote = q.toQuote(lockUsd) / (lots * unitsPerLot)
  const slTarget = roundToDigits(entry + dir * moveQuote, digits)
  if (tighter(slTarget)) out.action = { sl: slTarget, lockUsd: Math.round(lockUsd * 100) / 100 }
  return out
}

/**
 * One keeper pass: broker-truth positions in scope → decide → act through
 * the exec engine. Never throws; returns a summary.
 */
export async function runProfitKeeper(db, creds, deps = {}) {
  const summary = { checked: 0, slMoves: 0, closes: 0, scaleOuts: 0, errors: [] }
  try {
    const cfg = loadProfitKeeperConfig(db)
    if (!cfg.on) return summary

    const scopeSql = cfg.scope === 'all'
      ? "mp.source IS NULL OR mp.source IN ('autopilot', 'external', 'manual')"
      : "mp.source IN ('external', 'manual')"
    const rows = db.prepare(
      `SELECT mp.id, mp.symbol, mp.side, mp.entry_price, mp.current_sl, mp.peak_profit_usd,
              mp.scaled_out, t.ctrader_position_id AS position_id
       FROM monitored_positions mp
       JOIN trades t ON t.id = mp.trade_id
       WHERE mp.status = 'active' AND mp.guard_json IS NULL
         AND (mp.keeper_opt_out IS NULL OR mp.keeper_opt_out != 1)
         AND t.ctrader_position_id IS NOT NULL AND (${scopeSql})`
    ).all()
    if (rows.length === 0) return summary

    const exec = deps.exec ?? await import('../lib/exec-engine.js')
    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const sizing = deps.sizing ?? await import('../lib/lot-sizing.js')
    const notify = deps.notify ?? (() => {})
    const balance = getAccountBalance(db)

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

    // ATR per symbol (adaptive mode only) — one bar fetch per symbol per pass.
    const atrBySymbolId = {}
    if (cfg.mode === 'adaptive') {
      for (const id of symbolIds) {
        try {
          const bars = await ws.wsGetTrendbarsBatch(
            creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
            id, [cfg.atrTimeframe], Math.max(cfg.atrPeriod * 3, 50)
          )
          atrBySymbolId[id] = atrFromBars(bars?.[cfg.atrTimeframe] || [], cfg.atrPeriod)
        } catch { atrBySymbolId[id] = null /* falls back to fixed thresholds */ }
      }
    }

    const updPeak = db.prepare('UPDATE monitored_positions SET peak_profit_usd = ? WHERE id = ?')
    const updAct = db.prepare(
      `UPDATE monitored_positions
       SET current_sl = COALESCE(?, current_sl), last_check_action = ?, last_check_at = datetime('now')
       WHERE id = ?`
    )
    const updScaled = db.prepare('UPDATE monitored_positions SET scaled_out = 1 WHERE id = ?')

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
        atr: atrBySymbolId[td.symbolId] ?? null,
        balance,
        scaledOut: !!r.scaled_out,
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
        continue
      }
      if (decision.action.scaleOutFrac) {
        const vol = Math.round(td.volume * decision.action.scaleOutFrac)
        if (meta.minVolume == null || vol >= meta.minVolume) {
          try {
            await exec.closePosition(creds, { positionId: parseInt(r.position_id), volume: vol })
            updScaled.run(r.id)
            updAct.run(null, 'profit_keeper_scaleout', r.id)
            summary.scaleOuts++
            notify(`💰 Profit Keeper banked ${Math.round(decision.action.scaleOutFrac * 100)}% of ${r.symbol} at ~${price} — the rest runs with the trail`)
          } catch (err) { summary.errors.push(`${r.symbol} scale-out: ${err.message}`) }
        }
      }
      if (decision.action.sl != null) {
        try {
          await exec.amendPosition(creds, { positionId: parseInt(r.position_id), stopLoss: decision.action.sl })
          updAct.run(decision.action.sl, 'profit_keeper_lock', r.id)
          summary.slMoves++
          notify(`🔒 Profit Keeper: ${r.symbol} SL ratcheted to ${decision.action.sl}${decision.action.lockUsd != null ? ` (locks ~$${decision.action.lockUsd})` : ''}`)
        } catch (err) {
          summary.errors.push(`${r.symbol} SL: ${err.message}`)
          // Broker refused the stop (too close to market?) — retried next
          // cycle; the breach/giveback close paths handle the retraced case.
        }
      }
    }

    if (summary.slMoves || summary.closes || summary.scaleOuts) {
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
