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
import { enabledStrategies, judgedAtHorizon } from './strategies.js'
import { armedTradeKeys, disarmStrategyEverywhere } from './stage-matrix.js'
import { noteLiveDisarm } from './strategy-autopilot.js'
import { depositCurrencies } from './deposit-currencies.js'

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
 *    watchdog pools on purpose when money has one verified unit (it disarms globally); the earned floor gates
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
 * Monetary metrics require one account/host-verified deposit currency over
 * this exact sample. Counts and win rates remain available independently.
 */
export function strategyRollingEdge(db, strategyKey, window, { accountId = null, rrBand = null, ownOnly = false } = {}) {
  const acct = accountId != null ? String(accountId) : null
  const below = Number(rrBand?.below)
  const banded = Number.isFinite(below) && below > 0
  const rows = db.prepare(
    `SELECT id, account_id, net_pnl FROM trades
      WHERE status = 'closed' AND net_pnl IS NOT NULL AND label_strategy = ?
        AND (? IS NULL OR account_id = ? OR (? = 0 AND account_id IS NULL))
        AND (? = 0 OR (
          tp_price IS NOT NULL AND sl_price IS NOT NULL AND entry_price IS NOT NULL
          AND ABS(sl_price - entry_price) > 0
          AND ABS(tp_price - entry_price) / ABS(sl_price - entry_price) < ?))
      ORDER BY closed_at DESC, id DESC LIMIT ?`
  ).all(strategyKey, acct, acct, ownOnly ? 1 : 0, banded ? 1 : 0, banded ? below : 0, window)
  const n = rows.length
  const wins = rows.filter(r => Number(r.net_pnl) > 0)
  // Selection/counts/sign-only win rates retain the same population. Money
  // can be aggregated only when every row has one account-owned known unit;
  // legacy NULL owners are not assigned the requesting account's currency.
  const sample = { trades: n, winRate: n ? Math.round((wins.length / n) * 100) : null, newestId: rows[0]?.id ?? null }
  const units = n ? depositCurrencies(db) : {}
  const currencyCounts = {}
  let unverifiedTrades = 0
  for (const row of rows) {
    const currency = units[String(row.account_id ?? '').trim()]?.currency
    if (!currency) unverifiedTrades++
    else currencyCounts[currency] = (currencyCounts[currency] || 0) + 1
  }
  const currencies = Object.keys(currencyCounts)
  if (unverifiedTrades || currencies.length !== 1) {
    return { ...sample, currency: null, currencyCounts, unverifiedTrades,
      moneyReason: unverifiedTrades ? 'unverified_currency' : (n ? 'mixed_currencies' : 'empty_sample'),
      expectancy: null, profitFactor: null, net: n ? null : 0 }
  }
  const grossWin = wins.reduce((s, r) => s + Number(r.net_pnl), 0)
  const grossLoss = Math.abs(rows.filter(r => Number(r.net_pnl) < 0).reduce((s, r) => s + Number(r.net_pnl), 0))
  const net = rows.reduce((s, r) => s + Number(r.net_pnl), 0)
  return {
    ...sample,
    currency: currencies[0], currencyCounts, unverifiedTrades: 0, moneyReason: null,
    expectancy: Math.round((net / n) * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? null : 0),
    net: Math.round(net * 100) / 100,
  }
}

/**
 * One pass — call once per loop cycle. Disarms any armed strategy whose live
 * edge is clearly negative over a full window. Returns the actions taken and
 * the per-strategy evaluation (for the dashboard). Never throws.
 */
/** The enabled accounts whose OWN closes over the window read clearly no-edge (same bar as the pooled verdict). */
function ownNoEdgeVerdicts(db, strategyKey, cfg) {
  let ids = []
  try { ids = db.prepare('SELECT account_id FROM accounts WHERE enabled = 1 ORDER BY account_id').all().map(r => String(r.account_id)) } catch { return [] }
  return ids.map(accountId => ({ accountId,
    edge: strategyRollingEdge(db, strategyKey, cfg.window, { accountId, ownOnly: true }),
  })).filter(({ edge: e }) => !e.moneyReason && e.trades >= cfg.minTrades
    && e.expectancy < 0 && e.profitFactor != null && e.profitFactor < cfg.pfFloor)
}

export function accountsWithOwnNoEdge(db, strategyKey, cfg) {
  return ownNoEdgeVerdicts(db, strategyKey, cfg).map(v => v.accountId)
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
    // Wave 1 (19-09-2026): a weeks-horizon family is not judged by a
    // 20-close window. Recorded as evaluated with the reason so the
    // exemption is visible, never silent.
    if (judgedAtHorizon(key)) { evaluated.push({ strategy: key, skipped: 'judged_at_horizon' }); continue }
    try {
      // POOLED on purpose: valid homogeneous money retains the strategy's
      // whole-book verdict. Unavailable money falls back only to OWN verdicts.
      const e = strategyRollingEdge(db, key, cfg.window, { accountId: null })
      evaluated.push({ strategy: key, ...e })
      let verdicts
      if (e.moneyReason) {
        // Unavailable pooled money is not a positive or negative verdict.
        // Retain the existing OWN no-edge protection at its existing bar,
        // confined to that account; no invented cross-currency conversion.
        verdicts = ownNoEdgeVerdicts(db, key, cfg)
      } else {
        // Homogeneous pooled money retains its whole-book predicate and
        // scope: full sample, negative expectancy AND PF under the floor.
        if (e.trades < cfg.minTrades || e.newestId == null
          || !(e.expectancy < 0 && e.profitFactor != null && e.profitFactor < cfg.pfFloor)) continue
        verdicts = [{ accountId: null, edge: e }]
      }
      for (const { accountId, edge } of verdicts) {
        const pf = edge.profitFactor

        // Act once per newest trade — don't re-disarm every cycle.
        const seenKey = accountId == null ? `edge_watchdog_acted_${key}` : `edge_watchdog_acted_${key}_acct_${accountId}`
        if (String(getState(db, seenKey)) === String(edge.newestId)) continue

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
        const ownVerdictScopes = accountId == null ? accountsWithOwnNoEdge(db, key, cfg) : [accountId]
        const scopes = disarmStrategyEverywhere(db, io, key, {
          neverZero: false, exemptHandPinned: true, ownVerdictScopes,
          onlyScopes: accountId == null ? null : [accountId],
          // PR-S: the decay figures travel with the write, so a later reader
          // can see WHICH measurement retired the strategy rather than only
          // that something did.
          actor: 'edge_watchdog',
          reason: `no edge${accountId == null ? '' : ` on account ${accountId}`}: expectancy ${edge.currency} ${Number(edge.expectancy).toFixed(2)}, PF ${Number(pf).toFixed(2)} over ${edge.trades} closes`,
          evidence: { expectancy: edge.expectancy, profitFactor: pf, winRate: edge.winRate, trades: edge.trades, net: edge.net,
            currency: edge.currency, accountId, newestId: edge.newestId, pooledMoneyReason: e.moneyReason, ownVerdictScopes },
        })
        const heldPinned = [...(scopes.held || [])]
        if (scopes.length === 0) continue
        setState(db, seenKey, String(edge.newestId))
        // Tell the autopilot: a live disarm holds for the cool-off, and the
        // divergence tracker sees who ended the arm (02-09-2026).
        try { noteLiveDisarm(db, key, 'watchdog') } catch { /* never undoes the disarm */ }
        const action = { strategy: key, did: 'disarmed_no_edge', scopes: [...scopes], heldPinned, ownVerdictScopes,
          accountId, currency: edge.currency, newestId: edge.newestId, pooledMoneyReason: e.moneyReason,
          expectancy: edge.expectancy, profitFactor: pf, winRate: edge.winRate, trades: edge.trades, net: edge.net }
        actions.push(action)
        try {
          db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
            .run('WATCHDOG', '/edge', JSON.stringify(action).slice(0, 2000))
        } catch { /* audit best-effort */ }
        try {
          notify?.(`🛑 EDGE WATCHDOG: ${key} disarmed${accountId == null ? '' : ` on account ${accountId}`} — negative edge over ${edge.trades} trades (expectancy ${edge.currency} ${edge.expectancy}, PF ${pf ?? '∞'}, win ${edge.winRate}%, net ${edge.currency} ${edge.net}). No alpha-decay: it stopped trading itself. Re-arm from Tune when it earns it back.`)
        } catch { /* best effort */ }
      }
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
