// ---------------------------------------------------------------------------
// agent/services/loss-guardian.js — the loss-side mirror of profit-keeper.
//
// Owner (AUDUSD down $200, unmanaged 10h): "shouldn't you be mindful." A
// LOSING position is never touched by the Profit-Keeper (it only protects
// gains), and a MANUAL position is observe-only — so a naked manual loser can
// ride with nothing bounding the worst case. This guardian closes that gap.
//
// It is deliberately CONSERVATIVE, because the armed edge is mean-reversion:
// those setups EXPECT to go underwater before the bounce, so cutting a red
// position early would destroy the edge. The guardian therefore does NOT
// tighten a position that already has a stop — it only:
//
//   1. PROTECTS a naked position (no stop-loss) — places a broker stop a
//      generous maxAtrMult×ATR from entry (fallbackAdversePct of price if ATR
//      is unavailable). If price has ALREADY blown past where that stop would
//      sit, the max tolerable loss is already exceeded → close at market.
//   2. Enforces an optional hard TIME CAP (maxHoldHours) for positions that
//      carry no time cap of their own — no idea sits unmanaged forever.
//
// It never widens risk, never moves an existing stop, and honours the same
// owner overrides as the keeper (guard_json, keeper_opt_out). Every action
// goes through the exec engine and lands in action_log + Telegram.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { roundToDigits } from './trade-guard.js'

export const DEFAULT_LOSS_GUARDIAN = {
  on: true,                 // safety net on by default — no naked losers
  scope: 'all',             // 'all' = bot + manual/external · 'external' = manual only
  atrTimeframe: '1h',
  atrPeriod: 14,
  maxAtrMult: 3,            // protective stop distance for a NAKED position (wide — mean-reversion room)
  fallbackAdversePct: 0.02, // if ATR is unavailable, cap adverse at 2% of entry price
  maxHoldHours: null,       // optional hard time cap for positions without one (null = off)
}

export function loadLossGuardianConfig(db) {
  try {
    const saved = JSON.parse(getState(db, 'loss_guardian_json') || 'null')
    return { ...DEFAULT_LOSS_GUARDIAN, ...(saved || {}) }
  } catch {
    return { ...DEFAULT_LOSS_GUARDIAN }
  }
}

/**
 * decideLossGuardian(cfg, ctx) → { action, reason } | { action: null }
 * Pure. ctx: { side, entry, price, currentSl, atr, digits, ageHours }.
 *   · time cap breached          → close
 *   · naked & price past the cap  → close (max loss already exceeded)
 *   · naked & still inside        → place protective stop
 *   · has a stop / inside cap      → HOLD (never touch a valid mean-rev stop)
 */
export function decideLossGuardian(cfg, ctx) {
  const { side, entry, price, currentSl, atr, digits, ageHours } = ctx
  const long = String(side).toUpperCase() === 'BUY'

  // 1) Hard time cap — applies whether or not a stop exists.
  if (cfg.maxHoldHours != null && Number.isFinite(ageHours) && ageHours >= cfg.maxHoldHours) {
    return { action: { close: true }, reason: `time_cap ${ageHours.toFixed(1)}h ≥ ${cfg.maxHoldHours}h` }
  }

  // 2) Only NAKED positions get a protective stop — never touch an existing one.
  if (currentSl != null) return { action: null }
  if (entry == null || price == null) return { action: null }

  const dist = (Number.isFinite(atr) && atr > 0)
    ? cfg.maxAtrMult * atr
    : cfg.fallbackAdversePct * entry
  if (!(dist > 0)) return { action: null }

  const level = long ? entry - dist : entry + dist
  // Already blown past where the protective stop would sit → the max tolerable
  // loss is already exceeded; don't set a stop the broker would reject, close.
  const past = long ? price <= level : price >= level
  if (past) {
    return { action: { close: true }, reason: `naked position already beyond max loss (${cfg.maxAtrMult}×ATR)` }
  }
  const sl = roundToDigits(level, digits)
  return { action: { sl }, reason: `protective stop on a naked position (${cfg.maxAtrMult}×ATR from entry)` }
}

function atrFromBars(bars, period) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null
  let sum = 0
  for (let i = bars.length - period; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  }
  return sum / period
}

/**
 * One guardian pass: broker-truth positions in scope → decide → act through
 * the exec engine. Never throws; returns a summary.
 */
export async function runLossGuardian(db, creds, deps = {}) {
  const summary = { checked: 0, stops: 0, closes: 0, errors: [] }
  try {
    const cfg = loadLossGuardianConfig(db)
    if (!cfg.on) return summary

    const scopeSql = cfg.scope === 'all'
      ? "mp.source IS NULL OR mp.source IN ('autopilot', 'external', 'manual')"
      : "mp.source IN ('external', 'manual')"
    const rows = db.prepare(
      `SELECT mp.id, mp.symbol, mp.side, mp.entry_price, mp.current_sl,
              t.ctrader_position_id AS position_id
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
    const nowMs = deps.now ?? Date.now()

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

    // ATR per symbol — only needed to size a protective stop for a naked position.
    const atrBySymbolId = {}
    const nakedSymbolIds = [...new Set(involved.filter(x => (x.bp.stopLoss ?? x.r.current_sl) == null).map(x => x.bp.tradeData?.symbolId).filter(Boolean))]
    for (const id of nakedSymbolIds) {
      try {
        const bars = await ws.wsGetTrendbarsBatch(
          creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
          id, [cfg.atrTimeframe], Math.max(cfg.atrPeriod * 3, 50)
        )
        atrBySymbolId[id] = atrFromBars(bars?.[cfg.atrTimeframe] || [], cfg.atrPeriod)
      } catch { atrBySymbolId[id] = null }
    }

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

      const openMs = td.openTimestamp ? Number(td.openTimestamp) : null
      const ageHours = openMs != null ? (nowMs - openMs) / 3_600_000 : null
      const decision = decideLossGuardian(cfg, {
        side: r.side,
        entry: bp.price ?? r.entry_price,
        price,
        currentSl: bp.stopLoss ?? r.current_sl,
        atr: atrBySymbolId[td.symbolId] ?? null,
        digits: meta.digits,
        ageHours,
      })
      if (!decision.action) continue

      if (decision.action.close) {
        try {
          await exec.closePosition(creds, { positionId: parseInt(r.position_id), volume: td.volume })
          updAct.run(null, 'loss_guardian_close', r.id)
          summary.closes++
          notify(`🛟 Loss Guardian closed ${r.symbol} (${r.side}) at ~${price}: ${decision.reason}`)
        } catch (err) { summary.errors.push(`${r.symbol} close: ${err.message}`) }
        continue
      }
      if (decision.action.sl != null) {
        try {
          await exec.amendPosition(creds, { positionId: parseInt(r.position_id), stopLoss: decision.action.sl })
          updAct.run(decision.action.sl, 'loss_guardian_stop', r.id)
          summary.stops++
          notify(`🛟 Loss Guardian: ${r.symbol} had NO stop — protective SL set at ${decision.action.sl} (${decision.reason})`)
        } catch (err) { summary.errors.push(`${r.symbol} SL: ${err.message}`) }
      }
    }

    if (summary.stops || summary.closes) {
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('GUARDIAN', '/loss-guardian', JSON.stringify(summary).slice(0, 2000))
      } catch { /* action_log appears after first boot */ }
    }
  } catch (err) {
    summary.errors.push(err.message)
  }
  return summary
}
