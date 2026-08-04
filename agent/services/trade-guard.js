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
import { singleFlight, authorisedAccountId, accountFilterSql, scopeToAccount } from './acting-layer.js'

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
export function runTradeGuards(db, creds, deps = {}) {
  return singleFlight('trade_guards', () => tradeGuardsPass(db, creds, deps))
}

async function tradeGuardsPass(db, creds, deps = {}) {
  const summary = { checked: 0, slMoves: 0, partialCloses: 0, refused: 0, errors: [] }
  try {
    const accountId = authorisedAccountId(creds)
    const rows = db.prepare(
      `SELECT mp.id, mp.symbol, mp.side, mp.entry_price, mp.current_sl, mp.current_tp,
              mp.guard_json, mp.be_moved, mp.trade_id,
              t.ctrader_position_id AS position_id, t.account_id AS account_id
       FROM monitored_positions mp
       JOIN trades t ON t.id = mp.trade_id
       WHERE mp.status = 'active' AND mp.guard_json IS NOT NULL
         AND t.ctrader_position_id IS NOT NULL
         AND ${accountFilterSql('t.account_id')}`
    ).all(accountId)
    if (rows.length === 0) return summary

    const exec = deps.exec ?? await import('../lib/exec-engine.js')
    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const sizing = deps.sizing ?? await import('../lib/lot-sizing.js')
    const notify = deps.notify ?? (() => {})

    // BROKER TRUTH, added 2026-08-04. This was the only acting layer with no
    // reconcile: it amended stops using `current_sl` and `entry_price` read
    // from the DB, against whatever account the caller's creds pointed at.
    // Both halves of that were wrong — a stale local stop makes "is this
    // tighter?" a question about the wrong number, and an unverified position
    // id makes it a question about the wrong account. One extra round-trip per
    // pass buys both, and single-flight means the pass count went DOWN.
    const rec = await exec.reconcile(creds)
    const live = new Map()
    for (const p of (rec?.position || [])) {
      if (p.positionId != null) live.set(String(p.positionId), p)
    }
    const scoped = scopeToAccount(rows, { accountId, live })
    summary.refused = scoped.foreign.length + scoped.unknown.length
    if (scoped.foreign.length) {
      summary.errors.push(`${scoped.foreign.length} position(s) belong to another account and were not touched`)
    }
    const owned = scoped.owned
    if (owned.length === 0) return summary

    const map = getSymbolMap(db)
    const bySymbol = {}
    for (const r of owned) {
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

    for (const r of owned) {
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

      // Broker SL beats the DB column. The C++ trail engine amends the broker
      // WITHOUT writing `current_sl` — it reports via /trail-status, which only
      // the profit keeper reads — so between keeper passes the local value is
      // behind the real stop, and "is this tighter?" answered against it can
      // WIDEN a stop the ratchet already moved. Same for the entry price on an
      // adopted position.
      const bp = live.get(String(r.position_id))
      const brokerSl = bp?.stopLoss ?? null
      const entryPrice = bp?.price ?? r.entry_price

      const acts = decideGuardActions({
        side: r.side, entryPrice, currentSl: brokerSl ?? r.current_sl,
        price, pipSize, guard, beMoved: !!r.be_moved,
      })

      if (acts.moveSlTo != null) {
        const sl = roundToDigits(acts.moveSlTo, meta.digits)
        try {
          await exec.amendPosition(creds, {
            positionId: parseInt(r.position_id), stopLoss: sl,
            ctidTraderAccountId: r.account_id ?? accountId ?? undefined,
          })
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
          await exec.closePosition(creds, {
            positionId: parseInt(r.position_id), volume,
            ctidTraderAccountId: r.account_id ?? accountId ?? undefined,
          })
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
