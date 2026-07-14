// ---------------------------------------------------------------------------
// agent/services/trade-guard.js — per-position trade-management rules
// (cTrader-style Protect features, enforced by the bot each loop cycle).
//
// Rules live in monitored_positions.guard_json, PER POSITION:
//   {
//     breakEven:   { on, triggerPips, offsetPips },   // move SL to entry±offset once price is triggerPips in profit
//     trailing:    { on, distancePips },              // SL follows price at a fixed pip distance — tighten only
//     takeProfits: [{ price, lots, done }]            // bot-managed partial closes (broker holds only ONE native TP)
//   }
//
// decideGuardActions is pure (unit-tested); runTradeGuards does the I/O.
// The broker's native SL/TP stay authoritative — these rules only ever
// TIGHTEN protection or take profit; they never widen risk.
// ---------------------------------------------------------------------------

import { getSymbolMap } from '../lib/ctrader-creds.js'

/**
 * Pure decision: given one position's state and its guard rules, return the
 * actions to take now.
 *
 * @param {object} a
 * @param {string} a.side 'long'|'short' (or BUY/SELL)
 * @param {number} a.entryPrice
 * @param {number|null} a.currentSl broker-side SL if known
 * @param {number} a.price latest close
 * @param {number} a.pipSize e.g. 0.0001
 * @param {object|null} a.guard parsed guard_json
 * @param {boolean} a.beMoved break-even already executed for this position
 * @returns {{ moveSlTo: number|null, beMoved: boolean, closes: Array<{index:number, lots:number, price:number}> }}
 */
export function decideGuardActions({ side, entryPrice, currentSl, price, pipSize, guard, beMoved }) {
  const out = { moveSlTo: null, beMoved: false, closes: [] }
  if (!guard || !(price > 0) || !(entryPrice > 0) || !(pipSize > 0)) return out
  // Float slack: a price EXACTLY at the trigger must fire (1.1015-1.1000
  // computes to 14.999…9 pips without it).
  const EPS = 1e-9
  const s = String(side || '').toUpperCase()
  const dir = s === 'LONG' || s === 'BUY' ? 1 : -1
  const favPips = ((price - entryPrice) * dir) / pipSize + EPS
  const tighter = (candidate, incumbent) =>
    incumbent == null || (dir === 1 ? candidate > incumbent : candidate < incumbent)

  // Break-even — one-shot: SL to entry ± offset once triggerPips in profit.
  const be = guard.breakEven
  if (be?.on && !beMoved && Number(be.triggerPips) > 0 && favPips >= Number(be.triggerPips)) {
    const target = entryPrice + dir * (Number(be.offsetPips) || 0) * pipSize
    if (tighter(target, currentSl)) {
      out.moveSlTo = target
      out.beMoved = true
    }
  }

  // Trailing — SL follows price at distancePips; only ever tightens.
  const tr = guard.trailing
  if (tr?.on && Number(tr.distancePips) > 0) {
    const target = price - dir * Number(tr.distancePips) * pipSize
    if (tighter(target, currentSl) && (out.moveSlTo == null || tighter(target, out.moveSlTo))) {
      out.moveSlTo = target
      // trailing past entry supersedes a pending break-even move
      if (out.beMoved && ((dir === 1 && target < entryPrice) || (dir === -1 && target > entryPrice))) {
        out.beMoved = false
      }
    }
  }

  // Bot-managed partial take-profits — close `lots` when price crosses level.
  for (let i = 0; i < (guard.takeProfits || []).length; i++) {
    const tp = guard.takeProfits[i]
    if (!tp || tp.done || !(Number(tp.price) > 0) || !(Number(tp.lots) > 0)) continue
    const crossed = dir === 1 ? price >= Number(tp.price) - EPS : price <= Number(tp.price) + EPS
    if (crossed) out.closes.push({ index: i, lots: Number(tp.lots), price: Number(tp.price) })
  }

  return out
}

/** Round a price to the symbol's allowed decimals — the broker rejects more. */
export function roundToDigits(price, digits) {
  const f = Math.pow(10, digits ?? 5)
  return Math.round(price * f) / f
}

/**
 * One pass over every active guarded position: fetch latest closes, decide,
 * execute (SL amends + partial closes) through the exec engine, persist the
 * updated guard state. Never throws — callers get a summary either way.
 */
export async function runTradeGuards(db, creds, deps = {}) {
  const summary = { checked: 0, slMoves: 0, partialCloses: 0, errors: [] }
  try {
    const rows = db.prepare(
      `SELECT mp.id, mp.symbol, mp.side, mp.entry_price, mp.current_sl, mp.current_tp,
              mp.guard_json, mp.be_moved, t.ctrader_position_id AS position_id
       FROM monitored_positions mp
       JOIN trades t ON t.id = mp.trade_id
       WHERE mp.status = 'active' AND mp.guard_json IS NOT NULL
         AND t.ctrader_position_id IS NOT NULL`
    ).all()
    if (rows.length === 0) return summary

    const exec = deps.exec ?? await import('../lib/exec-engine.js')
    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const sizing = deps.sizing ?? await import('../lib/lot-sizing.js')
    const notify = deps.notify ?? (() => {})

    const map = getSymbolMap(db)
    const bySymbol = {}
    for (const r of rows) {
      const id = map[String(r.symbol).toUpperCase()]
      if (id != null) bySymbol[r.symbol] = id
    }
    const symbolIds = [...new Set(Object.values(bySymbol))]
    if (symbolIds.length === 0) return summary

    const prices = await ws.wsGetLastCloses(
      creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolIds
    )

    const updGuard = db.prepare('UPDATE monitored_positions SET guard_json = ?, scaled_out = 1 WHERE id = ?')
    const updSl = db.prepare(
      `UPDATE monitored_positions
       SET current_sl = ?, be_moved = CASE WHEN ? THEN 1 ELSE be_moved END,
           last_check_action = ?, last_check_at = datetime('now')
       WHERE id = ?`
    )

    for (const r of rows) {
      const symbolId = bySymbol[r.symbol]
      const price = symbolId != null ? prices[symbolId] : null
      if (price == null) continue
      summary.checked++
      let guard = null
      try { guard = JSON.parse(r.guard_json) } catch { continue }

      let meta
      try {
        meta = await sizing.getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
      } catch (err) {
        summary.errors.push(`${r.symbol}: ${err.message}`)
        continue
      }
      const pipSize = meta.pipPosition != null ? Math.pow(10, -meta.pipPosition) : null
      if (!pipSize) continue

      const acts = decideGuardActions({
        side: r.side, entryPrice: r.entry_price, currentSl: r.current_sl,
        price, pipSize, guard, beMoved: !!r.be_moved,
      })

      if (acts.moveSlTo != null) {
        const sl = roundToDigits(acts.moveSlTo, meta.digits)
        try {
          await exec.amendPosition(creds, { positionId: parseInt(r.position_id), stopLoss: sl })
          updSl.run(sl, acts.beMoved ? 1 : 0, acts.beMoved ? 'guard_break_even' : 'guard_trail', r.id)
          summary.slMoves++
          notify(`🛡 ${r.symbol}: SL moved to ${sl} (${acts.beMoved ? 'break-even' : 'trailing'})`)
        } catch (err) {
          summary.errors.push(`${r.symbol} SL: ${err.message}`)
        }
      }

      for (const c of acts.closes) {
        const volume = Math.round(c.lots * meta.lotSize)
        try {
          await exec.closePosition(creds, { positionId: parseInt(r.position_id), volume })
          guard.takeProfits[c.index].done = true
          updGuard.run(JSON.stringify(guard), r.id)
          summary.partialCloses++
          notify(`🎯 ${r.symbol}: partial take-profit — closed ${c.lots} lot(s) at ~${price}`)
        } catch (err) {
          summary.errors.push(`${r.symbol} TP${c.index + 1}: ${err.message}`)
        }
      }
    }

    if (summary.slMoves || summary.partialCloses) {
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('GUARD', '/trade-guards', JSON.stringify(summary).slice(0, 2000))
      } catch { /* action_log appears after first boot migration */ }
    }
  } catch (err) {
    summary.errors.push(err.message)
  }
  return summary
}
