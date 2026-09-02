// ---------------------------------------------------------------------------
// agent/services/adaptive-breaker.js — the machine's answer to a loss streak.
//
// Owner doctrine (2026-07-17): "cooldown pauses are for humans — if the bot
// loses 3 in a row it should CHANGE strategy and/or filters, not sit out."
// So instead of a time-based cooldown, a per-strategy losing streak triggers
// an ADAPTATION through the stage matrix:
//
//   streak of N consecutive losses on strategy X →
//     · other strategies still trade-enabled → disarm X at Auto Trade & Open
//     · X is the LAST enabled strategy      → arm the next unarmed
//       confluence filter (rsi → vwap → fvg) instead, tightening entries
//       rather than going idle
//     · X is last AND every filter already armed → HOLD X armed (tightened)
//       — never disarm the last strategy to zero
//
// INVARIANT (2026-07-21 audit): the breaker NEVER leaves the account with zero
// armed strategies. An earlier "aggressive" mode disarmed the last strategy on
// the theory the autopilot would re-arm proven combos — but on a LIVE account
// without autopilot_allow_live the autopilot only SUGGESTS and never re-arms,
// so the account ratcheted to zero armed and stopped trading entirely (the
// "no pending trades for hours" symptom). Adapting (tighten filters) is the
// aggressive-in-spirit response; going dark is not.
//
// Every action goes through setStage() (single source of truth with the
// Tune matrix + legacy keys), lands in action_log, and pings the owner.
// A streak is acted on ONCE — the id of its newest losing trade is
// remembered per strategy; only a new loss re-triggers.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { STRATEGY_KEYS } from './strategies.js'
import { loadStageMatrix, setStage, armedTradeKeys, disarmStrategyEverywhere, FILTER_DEFS } from './stage-matrix.js'
import { noteLiveDisarm } from './strategy-autopilot.js'

export const DEFAULT_ADAPTIVE_BREAKER = { on: true, streak: 3 }

export function loadAdaptiveBreakerConfig(db) {
  try {
    const parsed = JSON.parse(getState(db, 'adaptive_breaker_json') || 'null')
    if (parsed && typeof parsed === 'object') {
      return {
        on: parsed.on !== false,
        streak: Math.min(10, Math.max(2, Math.round(Number(parsed.streak) || 3))),
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...DEFAULT_ADAPTIVE_BREAKER }
}

/** Leading consecutive-loss streak for one strategy; newest trade id rides along. */
export function strategyLossStreak(db, strategyKey, limit = 12) {
  const rows = db.prepare(
    `SELECT id, net_pnl FROM trades
      WHERE status = 'closed' AND closed_at IS NOT NULL AND label_strategy = ?
      ORDER BY closed_at DESC, id DESC LIMIT ?`
  ).all(strategyKey, limit)
  let streak = 0
  for (const r of rows) {
    // A broker-side close lands with net_pnl NULL until the paced backfill
    // fills it (every 3rd cycle). `(null ?? 0) < 0` read that as "not a
    // loss" and TERMINATED the streak — so the freshest stop-out was exactly
    // the trade that stopped the breaker seeing the streak (codebase audit,
    // 02-09-2026). Unknown money is skipped, not counted either way.
    if (r.net_pnl == null) continue
    if (Number(r.net_pnl) < 0) streak++
    else break
  }
  return { streak, newestId: rows[0]?.id ?? null }
}

/**
 * One pass — call once per loop cycle. Returns the actions taken (possibly
 * empty). Failures inside one strategy's handling never block the others.
 */
export function runAdaptiveBreaker(db, { notify } = {}) {
  const cfg = loadAdaptiveBreakerConfig(db)
  if (!cfg.on) return { skipped: 'off', actions: [] }

  const io = { getState, setState }
  const actions = []
  for (const key of STRATEGY_KEYS) {
    try {
      const { streak, newestId } = strategyLossStreak(db, key)
      if (streak < cfg.streak || newestId == null) continue
      // Act once per streak: remember the newest losing trade we reacted to.
      const seenKey = `adaptive_breaker_acted_${key}`
      if (String(getState(db, seenKey)) === String(newestId)) continue
      setState(db, seenKey, String(newestId))

      const matrix = loadStageMatrix(db, getState)
      const me = matrix.strategies.find(s => s.key === key)
      // Live-armed ANYWHERE — the global trade cell, or any account's overlay
      // pin. The global-only check skipped a strategy that was off globally
      // but still trading on pinned accounts (2026-08-31), which is exactly
      // the state the breaker most needs to reach.
      let pinArmed = false
      if (!me?.stages.trade) {
        try {
          pinArmed = db.prepare('SELECT account_id FROM accounts').all()
            .some(r => armedTradeKeys(db, getState, String(r.account_id)).has(key))
        } catch { /* no accounts table — global answer stands */ }
      }
      if (!me?.stages.trade && !pinArmed) continue // not live-armed — nothing to adapt

      const othersOn = matrix.strategies.some(s => s.key !== key && s.stages.trade)
      let action
      if (othersOn) {
        // Everywhere, not just the global list — this breaker's 28-08
        // donchian_breakout disarm was silently outvoted for days by
        // per-account trade pins (2026-08-31). The helper holds the strategy
        // wherever it is the last one armed, same never-go-dark rule as below.
        // Hand-pinned DEMO arms are held (owner, 03-09-2026): the demo split
        // exists to measure a strategy's losses, and the breaker disarming
        // rsi2 on ACCT-DEMO-4 two minutes after the split (21:11 SGT) ended
        // the measurement it was set up for. The disarm still lands on the
        // global list and on live scopes, and the held scopes are recorded.
        const scopes = disarmStrategyEverywhere(db, io, key, { exemptHandPinnedDemo: true })
        const heldPinnedDemo = [...(scopes.held || [])]
        action = { strategy: key, streak, did: 'disarmed_strategy', scopes: [...scopes], heldPinnedDemo }
        // The autopilot honours a cool-off after a live disarm (02-09-2026):
        // it re-armed this breaker's rsi2 disarm twice in one morning.
        if (scopes.length) { try { noteLiveDisarm(db, key, 'breaker') } catch { /* never undoes the disarm */ } }
      } else {
        // LAST armed strategy — NEVER disarm to zero (the account would go dark
        // and, on live, the autopilot can't re-arm it). Tighten entries with
        // the next confluence filter; if every filter is already armed, HOLD it
        // armed rather than going idle.
        const nextFilter = FILTER_DEFS.find(f => !matrix.filters.find(x => x.key === f.key)?.stages.trade)
        if (nextFilter) {
          setStage(db, { kind: 'filter', key: nextFilter.key, stage: 'trade', on: true }, io)
          action = { strategy: key, streak, did: 'armed_filter', filter: nextFilter.key }
        } else {
          action = { strategy: key, streak, did: 'held_last_strategy' }
        }
      }
      actions.push(action)
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('BREAKER', '/adaptive', JSON.stringify(action).slice(0, 2000))
      } catch { /* audit best-effort */ }
      const msg = action.did === 'armed_filter'
        ? `🔧 ADAPTIVE BREAKER: ${key} lost ${streak} in a row — it is the last armed strategy, so the ${String(action.filter).toUpperCase()} filter is now armed to tighten its entries.`
        : action.did === 'held_last_strategy'
          ? `🔧 ADAPTIVE BREAKER: ${key} lost ${streak} in a row and every filter is already armed — keeping ${key} armed (the account never goes to zero armed strategies). Review it from Tune.`
          : `🔧 ADAPTIVE BREAKER: ${key} lost ${streak} in a row — disarmed at Auto Trade & Open (other strategies stay live). Re-arm from Tune when ready.`
      try { notify?.(msg) } catch { /* best effort */ }
    } catch (err) {
      console.error('[adaptive-breaker]', key, err.message)
    }
  }
  return { actions }
}
