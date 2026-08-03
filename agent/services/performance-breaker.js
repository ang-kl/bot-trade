// ---------------------------------------------------------------------------
// agent/services/performance-breaker.js — the "all hands on deck" checkpoint.
//
// Owner: "performance is bad now, what checkpoints would you have to trigger
// 'all hands on deck' to 'turn the tide'?" Two safeguards already existed
// (equity-stop: a same-day $ drawdown closes everything; adaptive-breaker: 3
// losses in a row on ONE strategy changes it), but neither catches a
// strategy that's just STRUCTURALLY losing without ever stringing 3 losses
// back to back — e.g. win, lose, lose, win, lose, lose can grind a profit
// factor of 0.2 with no streak ever hitting 3. This checks the AGGREGATE
// edge over a rolling window, the same profit-factor/expectancy numbers the
// Desk Performance panel already shows.
//
// AUTO-DISARM IS OFF (owner, 2026-07-30: "autoDisarm - leave it OFF"). The
// breaker ALERTS and does not stop trading by itself. Read the note on the
// constant below before changing that — it records why the owner reversed their
// own 2026-07-20 decision to arm it, and what is given up by leaving it off.
//
// This paragraph has been wrong twice, in both directions, because it duplicated
// a fact that lives 20 lines away. If you change the constant, change this line
// in the same edit or delete it — a header that describes the default is only
// useful while it is true.
//
// What auto-disarm does when it IS armed, and what it must not do: it writes the
// MASTER
// `autotrade_enabled` flag, which account-phases treats as an absolute veto
// over every per-account switch. That is intentional for a portfolio-wide edge
// failure (the stat is computed across all closed trades, so the finding is
// portfolio-wide), and it is deliberately NOT how the per-account equity stop
// behaves — that one disarms only its own account. If you want a weak edge to
// stop only some accounts, the breaker needs per-account stats first; it does
// not have them, so a global disarm is the only honest scope for it today.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { setPhaseFlag } from './phase-audit.js'
import { BREAKER_BAR } from './edge-bars.js'

export const DEFAULT_PERFORMANCE_BREAKER = {
  on: true,          // alerting armed by default — it only ever sends a message
  window: 20,         // rolling window of closed trades
  minTrades: 15,      // don't judge an edge on a handful of trades
  pfThreshold: BREAKER_BAR.profitFactor,   // below this over the window = trouble (edge-bars.js)
  // OFF, by the owner's instruction on 2026-07-30: "autoDisarm - leave it OFF".
  //
  // This REVERSES their own 2026-07-20 decision, which armed it after PF hit
  // 0.15 (net −$2019) and whose reasoning was: the trigger only fires below a
  // 0.8 profit factor over 15+ trades, so stopping there and waiting for a
  // human is the right default. That reasoning still stands on its own terms —
  // it is being overridden deliberately, not corrected.
  //
  // The change was asked and answered twice, the second time AFTER I corrected
  // my own mis-description of this constant as a stray bug (it was not; the
  // stale line-16 comment was the error). So this is an informed reversal.
  //
  // WHAT IS LOST: a structurally bleeding edge will no longer stop new entries
  // by itself. The 🚨 alert still fires every time the threshold is crossed, and
  // it names the profit factor, win rate, expectancy and net — so the signal is
  // intact and only the automatic action is gone. Re-arm from Tune, or set
  // autoDisarm: true here, if a weak window should pause trading again.
  autoDisarm: false,
}

/**
 * ONE-TIME: make the owner's 2026-07-30 "autoDisarm — leave it OFF" actually
 * take effect on an instance that stored `true` before they said it.
 *
 * WHY THIS IS NEEDED, AND WHY THE #509 CHANGE ALONE WAS NOT ENOUGH. #509 flipped
 * DEFAULT_PERFORMANCE_BREAKER.autoDisarm to false. But loadPerformanceBreakerConfig
 * only falls back to the default when the key is ABSENT — a stored
 * performance_breaker_json carrying `autoDisarm: true` from the owner's
 * 2026-07-20 arming still wins, and on 2026-07-30 the owner's desk had autotrade
 * off on every account with the master flag written false. This breaker is one of
 * the few things that writes that MASTER flag (:131), which is an absolute veto
 * over every per-account switch. So the instruction was given, the default was
 * changed, and the behaviour did not change. That gap was mine.
 *
 * WHAT IT DOES. Removes the stored `autoDisarm` key so the config inherits the
 * documented default (now false). Everything else in the stored config —
 * window, minTrades, pfThreshold, on — is preserved untouched.
 *
 * WHAT IT DOES NOT DO. It does not re-arm autotrade; restoring trading is the
 * owner's call, and this only stops the breaker disarming it again. It does not
 * pin autoDisarm off for ever either: after this runs, setting it from Tune
 * stores an explicit value that is honoured normally. Guarded by a state flag,
 * so it runs exactly once and a later deliberate `true` is never undone.
 */
export function migrateAutoDisarmOff(db) {
  const FLAG = 'pb_autodisarm_off_v1'
  if (getState(db, FLAG)) return { migrated: false, reason: 'already run' }
  let parsed = null
  try { parsed = JSON.parse(getState(db, 'performance_breaker_json') || 'null') } catch {
    setState(db, FLAG, new Date().toISOString())
    return { migrated: false, reason: 'stored config unreadable — nothing to strip' }
  }
  setState(db, FLAG, new Date().toISOString())
  if (!parsed || typeof parsed !== 'object' || parsed.autoDisarm === undefined) {
    return { migrated: false, reason: 'no stored autoDisarm — the default already applies' }
  }
  const had = parsed.autoDisarm
  const { autoDisarm: _dropped, ...rest } = parsed
  setState(db, 'performance_breaker_json', JSON.stringify(rest))
  try {
    db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
      .run('PB_AUTODISARM_OFF', '/migration', JSON.stringify({
        was: had, now: DEFAULT_PERFORMANCE_BREAKER.autoDisarm,
        note: "owner 2026-07-30 'autoDisarm - leave it OFF'; #509 changed only the default, a stored true still won",
      }).slice(0, 2000))
  } catch { /* audit best-effort */ }
  return { migrated: true, was: had }
}

export function loadPerformanceBreakerConfig(db) {
  try {
    const parsed = JSON.parse(getState(db, 'performance_breaker_json') || 'null')
    if (parsed && typeof parsed === 'object') {
      return {
        on: parsed.on !== false,
        window: Math.min(200, Math.max(5, Math.round(Number(parsed.window) || DEFAULT_PERFORMANCE_BREAKER.window))),
        minTrades: Math.min(200, Math.max(5, Math.round(Number(parsed.minTrades) || DEFAULT_PERFORMANCE_BREAKER.minTrades))),
        pfThreshold: Math.min(2, Math.max(0.1, Number(parsed.pfThreshold) || DEFAULT_PERFORMANCE_BREAKER.pfThreshold)),
        // NOT `parsed.autoDisarm === true`. That silently flipped the owner's
        // armed auto-disarm to OFF for two cases that both happen in practice:
        // a config saved from Tune whose payload simply omits the key, and a
        // value that arrived as the STRING "true" from a form. Either way an
        // unrelated settings save could quietly stand down a protection the
        // owner deliberately armed on 2026-07-20 — the opposite direction from
        // the "autotrade drops" complaint, and just as wrong.
        //
        // An ABSENT key now inherits the documented default; a present key is
        // honoured, including the string forms a JSON form produces.
        autoDisarm: parsed.autoDisarm === undefined || parsed.autoDisarm === null
          ? DEFAULT_PERFORMANCE_BREAKER.autoDisarm
          : parsed.autoDisarm === true || parsed.autoDisarm === 'true' || parsed.autoDisarm === 1,
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...DEFAULT_PERFORMANCE_BREAKER }
}

/** Rolling stats over the last `window` closed trades (all strategies). */
export function rollingStats(db, window) {
  const rows = db.prepare(
    `SELECT id, net_pnl FROM trades
      WHERE status = 'closed' AND net_pnl IS NOT NULL
      ORDER BY closed_at DESC, id DESC LIMIT ?`
  ).all(window)
  const trades = rows.length
  const wins = rows.filter(r => Number(r.net_pnl) > 0)
  const losses = rows.filter(r => Number(r.net_pnl) < 0)
  const grossWin = wins.reduce((s, r) => s + Number(r.net_pnl), 0)
  const grossLoss = Math.abs(losses.reduce((s, r) => s + Number(r.net_pnl), 0))
  const net = rows.reduce((s, r) => s + Number(r.net_pnl), 0)
  return {
    trades,
    winRate: trades ? Math.round((wins.length / trades) * 100) : null,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : (grossWin > 0 ? null : 0),
    expectancy: trades ? Math.round((net / trades) * 100) / 100 : null,
    net: Math.round(net * 100) / 100,
    newestId: rows[0]?.id ?? null,
  }
}

/**
 * One pass — call once per loop cycle (cheap: one indexed query). Fires the
 * alert AT MOST once per newest-trade-id (same "act once per streak"
 * dedupe pattern as adaptive-breaker), so it doesn't repeat every cycle
 * while the window stays bad.
 */
export function runPerformanceBreaker(db, { notify } = {}) {
  const cfg = loadPerformanceBreakerConfig(db)
  if (!cfg.on) return { skipped: 'off' }

  const stats = rollingStats(db, cfg.window)
  if (stats.trades < cfg.minTrades || stats.newestId == null) return { skipped: 'insufficient_sample', stats }
  if (stats.profitFactor == null || stats.profitFactor >= cfg.pfThreshold) return { skipped: 'above_threshold', stats }

  const seenKey = 'performance_breaker_acted_id'
  if (String(getState(db, seenKey)) === String(stats.newestId)) return { skipped: 'already_alerted', stats }
  setState(db, seenKey, String(stats.newestId))

  if (cfg.autoDisarm) {
    setPhaseFlag(db, 'autotrade_enabled', 'false', {
      actor: 'performance_breaker',
      reason: `profit factor ${stats.profitFactor.toFixed(2)} below floor ${cfg.pfThreshold} over last ${stats.trades} trades`,
    })
  }

  const msg = `🚨 ALL HANDS ON DECK: last ${stats.trades} closed trades — profit factor ${stats.profitFactor.toFixed(2)} (floor ${cfg.pfThreshold}), ${stats.winRate}% win rate, expectancy ${stats.expectancy >= 0 ? '+' : ''}${stats.expectancy}/trade, net ${stats.net >= 0 ? '+' : ''}${stats.net}.${cfg.autoDisarm ? ' Autotrade DISARMED pending review.' : ' Autotrade left running — arm auto-disarm in Tune if you want this to pause it automatically.'}`
  try {
    db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
      .run('PERF_BREAKER', '/performance', JSON.stringify({ stats, autoDisarm: cfg.autoDisarm }).slice(0, 2000))
  } catch { /* audit best-effort */ }
  try { notify?.(msg) } catch { /* non-fatal */ }

  return { triggered: true, stats, autoDisarmed: cfg.autoDisarm, message: msg }
}
