// ---------------------------------------------------------------------------
// agent/services/edge-watchdog.js — per-strategy alpha-decay enforcement.
//
// Owner mandate: "ensure no alpha decay" — the machine, not a human watching
// a dashboard, should retire a strategy the moment its LIVE edge turns
// negative. Two breakers already existed but each has a blind spot:
//   · adaptive-breaker  — reacts to a per-strategy consecutive LOSS STREAK.
//   · performance-breaker — reacts to the AGGREGATE profit factor of ALL
//     strategies combined, and disarms autotrade wholesale.
// Neither catches a SINGLE strategy grinding to negative expectancy WITHOUT a
// streak (win, lose, lose, win, lose, lose … PF ~0.3, no streak ever hitting
// 3, and the aggregate stays afloat because another strategy is carrying it).
// That grind is exactly how the account bled while every brake stayed quiet.
//
// This watchdog runs once per loop and, for each ARMED strategy, computes its
// rolling live expectancy/PF/win over a full window (now honest — broker
// stop-outs are backfilled). A strategy that is CLEARLY losing over a real
// sample is disarmed at its Auto Trade & Open cell, through the same setStage
// path the Tune matrix and the other breakers use. Acts once per newest trade
// (dedupe), lands in action_log, pings the owner. Auto-disarm defaults ON —
// this is the enforcement the owner explicitly asked the machine to own.
//
// It only ever DISARMS (never arms) and only touches strategies that are
// already live, so the worst case is "stopped trading a loser too eagerly",
// recoverable with one click in Tune — the safe direction to be wrong in.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { enabledStrategies } from './strategies.js'
import { armedTradeKeys, disarmStrategyEverywhere } from './stage-matrix.js'
import { noteLiveDisarm } from './strategy-autopilot.js'

export const DEFAULT_EDGE_WATCHDOG = {
  on: true,          // enforcement armed by default (owner: "no alpha decay")
  window: 20,        // rolling window of a strategy's most recent closed trades
  minTrades: 15,     // never judge an edge on a handful of trades
  pfFloor: 0.95,     // profit factor must be under this to count as "no edge"
}

export function loadEdgeWatchdogConfig(db) {
  try {
    const p = JSON.parse(getState(db, 'edge_watchdog_json') || 'null')
    if (p && typeof p === 'object') {
      return {
        on: p.on !== false,
        window: Math.min(200, Math.max(5, Math.round(Number(p.window) || 20))),
        minTrades: Math.min(200, Math.max(5, Math.round(Number(p.minTrades) || 15))),
        pfFloor: Math.min(1.5, Math.max(0, Number.isFinite(Number(p.pfFloor)) ? Number(p.pfFloor) : 0.95)),
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...DEFAULT_EDGE_WATCHDOG }
}

/**
 * Rolling edge for one strategy over its last `window` closed trades. Only
 * trades with a realized P&L count (NULLs are un-backfilled broker closes —
 * excluding them keeps the maths honest rather than reading a loss as 0).
 *
 * Scoping (owner order, 02-09-2026):
 *  · `accountId` — a string scopes the window to that account's closes
 *    (`account_id = ? OR account_id IS NULL`: pre-scoping rows are legacy
 *    single-account history and count everywhere, the same contract as
 *    accountEconomics). null = the POOLED view across every account. The
 *    watchdog pools on purpose (it disarms globally); the earned floor gates
 *    per account and must measure per account — it used to consume the pooled
 *    number, so one account's record could earn another account's floor.
 *  · `rrBand` — `{ below: R }` restricts the window to trades whose PLANNED
 *    bracket (trades.tp_price / sl_price / entry_price, written once at
 *    dispatch and never trailed) had R:R under R. The earned floor measures W
 *    on trades taken at ≥3R and applied it to justify <3R entries; the band
 *    keeps the measurement on the population the verdict admits. Rows with
 *    no planned bracket (tp or sl NULL, zero stop distance) are not IN the
 *    band — they cannot be, their R:R is unknowable — so they are excluded,
 *    not read as sub-floor.
 *  · `ownOnly` — with an accountId, count ONLY that account's stamped closes
 *    (no legacy NULL rows): the per-account no-edge verdict that overrides
 *    a hand pin (PR-B checker, 11-09-2026) must be the account's own record.
 */
export function strategyRollingEdge(db, strategyKey, window, { accountId = null, rrBand = null, ownOnly = false } = {}) {
  const acct = accountId != null ? String(accountId) : null
  const below = Number(rrBand?.below)
  const banded = Number.isFinite(below) && below > 0
  const rows = db.prepare(
    `SELECT id, net_pnl FROM trades
      WHERE status = 'closed' AND net_pnl IS NOT NULL AND label_strategy = ?
        AND (? IS NULL OR account_id = ? OR (? = 0 AND account_id IS NULL))
        AND (? = 0 OR (
          tp_price IS NOT NULL AND sl_price IS NOT NULL AND entry_price IS NOT NULL
          AND ABS(sl_price - entry_price) > 0
          AND ABS(tp_price - entry_price) / ABS(sl_price - entry_price) < ?))
      ORDER BY closed_at DESC, id DESC LIMIT ?`
  ).all(strategyKey, acct, acct, ownOnly ? 1 : 0, banded ? 1 : 0, banded ? below : 0, window)
  const n = rows.length
  if (n === 0) return { trades: 0, expectancy: null, profitFactor: null, winRate: null, net: 0, newestId: null }
  const wins = rows.filter(r => Number(r.net_pnl) > 0)
  const grossWin = wins.reduce((s, r) => s + Number(r.net_pnl), 0)
  const grossLoss = Math.abs(rows.filter(r => Number(r.net_pnl) < 0).reduce((s, r) => s + Number(r.net_pnl), 0))
  const net = rows.reduce((s, r) => s + Number(r.net_pnl), 0)
  return {
    trades: n,
    expectancy: Math.round((net / n) * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? null : 0),
    winRate: Math.round((wins.length / n) * 100),
    net: Math.round(net * 100) / 100,
    newestId: rows[0].id,
  }
}

/**
 * One pass — call once per loop cycle. Disarms any armed strategy whose live
 * edge is clearly negative over a full window. Returns the actions taken and
 * the per-strategy evaluation (for the dashboard). Never throws.
 */
/** The enabled accounts whose OWN closes over the window read clearly no-edge (same bar as the pooled verdict). */
export function accountsWithOwnNoEdge(db, strategyKey, cfg) {
  let ids = []
  try { ids = db.prepare('SELECT account_id FROM accounts WHERE enabled = 1 ORDER BY account_id').all().map(r => String(r.account_id)) } catch { return [] }
  return ids.filter(id => {
    const e = strategyRollingEdge(db, strategyKey, cfg.window, { accountId: id, ownOnly: true })
    return e.trades >= cfg.minTrades && e.expectancy < 0 && e.profitFactor != null && e.profitFactor < cfg.pfFloor
  })
}

export function runEdgeWatchdog(db, { notify } = {}) {
  const cfg = loadEdgeWatchdogConfig(db)
  if (!cfg.on) return { skipped: 'off', actions: [], evaluated: [] }

  const io = { getState, setState }
  const actions = []
  const evaluated = []

  // Candidates are strategies armed ANYWHERE — the global list, or any
  // account's overlay pin. Global-only candidates left a pin-armed strategy
  // invisible to the watchdog entirely (the same hole its disarm had):
  // globally off, still trading on pinned accounts, never evaluated.
  const armed = new Set(enabledStrategies(db, getState).map(s => s.key))
  try {
    for (const r of db.prepare('SELECT account_id FROM accounts').all()) {
      for (const k of armedTradeKeys(db, getState, String(r.account_id))) armed.add(k)
    }
  } catch { /* no accounts table — global candidates only */ }
  for (const key of armed) {
    try {
      // POOLED on purpose: the watchdog disarms a strategy everywhere, so it
      // judges the strategy's whole book. accountId: null is that intent
      // written down, not a default left unread.
      const e = strategyRollingEdge(db, key, cfg.window, { accountId: null })
      evaluated.push({ strategy: key, ...e })
      if (e.trades < cfg.minTrades || e.newestId == null) continue

      // "Clearly no edge": losing money on average AND a sub-floor profit
      // factor. Requiring both keeps a breakeven-but-noisy strategy
      // (expectancy -0.01, PF 0.99) from being disarmed on a coin-flip.
      const pf = e.profitFactor
      const clearlyLosing = e.expectancy < 0 && pf != null && pf < cfg.pfFloor
      if (!clearlyLosing) continue

      // Act once per newest trade — don't re-disarm every cycle.
      const seenKey = `edge_watchdog_acted_${key}`
      if (String(getState(db, seenKey)) === String(e.newestId)) continue

      // Everywhere, not just the global list — a per-account trade pin kept
      // globally-disarmed strategies proposing for days (2026-08-31). The
      // helper no-ops per scope where the strategy is not armed or is the
      // last one armed, so no separate "actually armed" pre-check is needed —
      // but only a disarm that CHANGED something is an action worth stamping,
      // logging or waking the owner for.
      //
      // HAND-PINNED ARMS ARE HELD (09-09-2026), the breaker's 03-09 rule
      // applied here too. Measured: the cluster rule (#868) pinned every
      // strategy on every account at 13:49 SGT; this watchdog unpinned
      // fib_618_fade and fib_confluence everywhere at 13:54 on their POOLED
      // record, and the boot seed re-pinned them at 16:08 — two evaluators
      // overriding each other on the owner's word. A pin is judged per
      // account by the 30-close verdict (strategy-verdicts.js) instead. PR-B
      // (11-09-2026, owner principle 1): held on EVERY scope, not demo only;
      // the global list is still disarmed here.
      //
      // …EXCEPT where the no-edge record is the account's OWN (checker,
      // 11-09-2026): an account whose own closes over the window clear
      // minTrades and read clearly losing has its pin written false — the
      // pooled verdict holds the pins, the account's own does not. With
      // `_all` pins on every account a pin that always held left the
      // watchdog unable to disarm anything.
      const ownVerdictScopes = accountsWithOwnNoEdge(db, key, cfg)
      const scopes = disarmStrategyEverywhere(db, io, key, {
        neverZero: false, exemptHandPinned: true, ownVerdictScopes,
        // PR-S: the decay figures travel with the write, so a later reader
        // can see WHICH measurement retired the strategy rather than only
        // that something did.
        actor: 'edge_watchdog',
        reason: `no edge: expectancy ${Number(e.expectancy).toFixed(2)}, PF ${Number(pf).toFixed(2)} over ${e.trades} closes`,
        evidence: { expectancy: e.expectancy, profitFactor: pf, winRate: e.winRate, trades: e.trades, net: e.net, ownVerdictScopes },
      })
      const heldPinned = [...(scopes.held || [])]
      if (scopes.length === 0) continue
      setState(db, seenKey, String(e.newestId))
      // Tell the autopilot: a live disarm holds for the cool-off, and the
      // divergence tracker sees who ended the arm (02-09-2026).
      try { noteLiveDisarm(db, key, 'watchdog') } catch { /* never undoes the disarm */ }
      const action = { strategy: key, did: 'disarmed_no_edge', scopes: [...scopes], heldPinned, ownVerdictScopes, expectancy: e.expectancy, profitFactor: pf, winRate: e.winRate, trades: e.trades, net: e.net }
      actions.push(action)
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('WATCHDOG', '/edge', JSON.stringify(action).slice(0, 2000))
      } catch { /* audit best-effort */ }
      try {
        notify?.(`🛑 EDGE WATCHDOG: ${key} disarmed — negative edge over ${e.trades} trades (expectancy $${e.expectancy}, PF ${pf ?? '∞'}, win ${e.winRate}%, net $${e.net}). No alpha-decay: it stopped trading itself. Re-arm from Tune when it earns it back.`)
      } catch { /* best effort */ }
    } catch (err) {
      console.error('[edge-watchdog]', key, err.message)
    }
  }

  // A compact snapshot for the dashboard / audit — the last evaluation and any
  // actions, honestly labelled (no fabricated numbers; nulls stay null).
  try {
    setState(db, 'edge_watchdog_last_json', JSON.stringify({ at: new Date().toISOString(), cfg, evaluated, actions }))
  } catch { /* best effort */ }

  return { actions, evaluated }
}
