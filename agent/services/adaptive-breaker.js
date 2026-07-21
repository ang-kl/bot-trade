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
//     · everything already armed             → disarm X and say so plainly
//
// Every action goes through setStage() (single source of truth with the
// Tune matrix + legacy keys), lands in action_log, and pings the owner.
// A streak is acted on ONCE — the id of its newest losing trade is
// remembered per strategy; only a new loss re-triggers.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { STRATEGY_KEYS } from './strategies.js'
import { loadStageMatrix, setStage, FILTER_DEFS } from './stage-matrix.js'

// aggressive (owner: "build more aggressive"): a losing strategy that is the
// LAST one armed is DISARMED immediately, instead of arming tightening filters
// and letting it ride (that's how fib bled 7 losses). Safe now that the
// autopilot backfills proven combos. Set aggressive:false for the old ladder.
export const DEFAULT_ADAPTIVE_BREAKER = { on: true, streak: 3, aggressive: true }

export function loadAdaptiveBreakerConfig(db) {
  try {
    const parsed = JSON.parse(getState(db, 'adaptive_breaker_json') || 'null')
    if (parsed && typeof parsed === 'object') {
      return {
        on: parsed.on !== false,
        streak: Math.min(10, Math.max(2, Math.round(Number(parsed.streak) || 3))),
        aggressive: parsed.aggressive !== false,
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
    if ((r.net_pnl ?? 0) < 0) streak++
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
      if (!me || !me.stages.trade) continue // not live-armed — nothing to adapt

      const othersOn = matrix.strategies.some(s => s.key !== key && s.stages.trade)
      let action
      if (othersOn) {
        setStage(db, { kind: 'strategy', key, stage: 'trade', on: false }, io)
        action = { strategy: key, streak, did: 'disarmed_strategy' }
      } else if (cfg.aggressive) {
        // AGGRESSIVE: cut the bleeding strategy even as the last one — the
        // autopilot re-arms proven combos, so we don't need to keep a loser
        // live just to avoid going idle.
        setStage(db, { kind: 'strategy', key, stage: 'trade', on: false }, io)
        action = { strategy: key, streak, did: 'disarmed_last_strategy' }
      } else {
        const nextFilter = FILTER_DEFS.find(f => !matrix.filters.find(x => x.key === f.key)?.stages.trade)
        if (nextFilter) {
          setStage(db, { kind: 'filter', key: nextFilter.key, stage: 'trade', on: true }, io)
          action = { strategy: key, streak, did: 'armed_filter', filter: nextFilter.key }
        } else {
          setStage(db, { kind: 'strategy', key, stage: 'trade', on: false }, io)
          action = { strategy: key, streak, did: 'disarmed_last_strategy' }
        }
      }
      actions.push(action)
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('BREAKER', '/adaptive', JSON.stringify(action).slice(0, 2000))
      } catch { /* audit best-effort */ }
      const msg = action.did === 'armed_filter'
        ? `🔧 ADAPTIVE BREAKER: ${key} lost ${streak} in a row — it is the last armed strategy, so the ${String(action.filter).toUpperCase()} filter is now armed to tighten its entries.`
        : action.did === 'disarmed_last_strategy'
          ? `🔧 ADAPTIVE BREAKER: ${key} lost ${streak} in a row and every filter is already armed — ${key} disarmed at Auto Trade & Open. Re-arm from Tune when ready.`
          : `🔧 ADAPTIVE BREAKER: ${key} lost ${streak} in a row — disarmed at Auto Trade & Open (other strategies stay live). Re-arm from Tune when ready.`
      try { notify?.(msg) } catch { /* best effort */ }
    } catch (err) {
      console.error('[adaptive-breaker]', key, err.message)
    }
  }
  return { actions }
}
