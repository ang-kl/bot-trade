// ---------------------------------------------------------------------------
// agent/services/session-open-guard.js — lock profit through session opens.
//
// Owner (2026-07-20, after XAUUSD went +$218 → −$261 across a session open):
// "when markets open, XAUUSD went from profit to loss" → "build the
// session-open guard". The normal profit ladder only locks breakeven at
// +0.7R, so a position sitting at +0.3…0.6R has NO protection exactly when
// reversals hit hardest — the first minutes after a major session opens.
//
// Rule: during the first `windowMin` minutes after any major session opens
// (Tokyo/Sydney/Singapore/London/Frankfurt/New York — lib/sessions.js is the
// single source of truth for open hours), any ACTIVE bot-managed position
// already in profit by ≥ `minR` gets its SL moved to breakeven (entry) —
// only ever TIGHTENING, never loosening, and at most once per position per
// session open. Outside the window this is a no-op costing nothing.
//
// Runs from the fast-monitor's 30s ticker (not the 5-minute loop) because a
// session-open reversal is precisely the thing a 5-minute cadence misses.
// External/manual positions stay observe-only, same as the fast monitor.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { SESSIONS } from '../lib/sessions.js'
import { currentR } from './position-manager.js'

export const DEFAULT_SESSION_OPEN_GUARD = { on: true, windowMin: 30, minR: 0.3 }

export function loadSessionOpenGuardConfig(db) {
  try {
    const parsed = JSON.parse(getState(db, 'session_open_guard_json') || 'null')
    if (parsed && typeof parsed === 'object') {
      return {
        on: parsed.on !== false,
        windowMin: Math.min(120, Math.max(5, Math.round(Number(parsed.windowMin) || DEFAULT_SESSION_OPEN_GUARD.windowMin))),
        minR: Math.min(0.69, Math.max(0.05, Number(parsed.minR) || DEFAULT_SESSION_OPEN_GUARD.minR)),
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...DEFAULT_SESSION_OPEN_GUARD }
}

/**
 * Which major session opened within the last `windowMin` minutes?
 * Pure UTC math over lib/sessions.js. Returns { id, label, openedAgoMin }
 * for the MOST RECENTLY opened matching session, or null.
 */
export function sessionJustOpened(now, windowMin) {
  const minsNow = now.getUTCHours() * 60 + now.getUTCMinutes()
  let best = null
  for (const s of SESSIONS) {
    const diff = (minsNow - s.open * 60 + 1440) % 1440
    if (diff < windowMin && (!best || diff < best.openedAgoMin)) {
      best = { id: s.id, label: s.label, openedAgoMin: diff }
    }
  }
  return best
}

// Acted-once memory: position id × session × UTC day. In-memory on purpose —
// a restart just re-evaluates, and the tighten-only check makes a repeat
// harmless (SL already at breakeven → nothing to do).
const acted = new Set()

/** Test hook: clear the acted-once memory (fresh :memory: DBs reuse row ids). */
export function resetSessionOpenGuardMemory() { acted.clear() }

/** One pass. Deps injectable for tests: { ws, loop, now, notify }. */
export async function runSessionOpenGuard(db, creds, deps = {}) {
  const cfg = loadSessionOpenGuardConfig(db)
  if (!cfg.on) return { skipped: 'off' }
  if (!creds?.ready) return { skipped: 'no creds' }

  const now = deps.now ?? (() => Date.now())
  const nowDate = new Date(now())
  const sess = sessionJustOpened(nowDate, cfg.windowMin)
  if (!sess) return { skipped: 'no session opening' }

  const positions = db.prepare(
    `SELECT * FROM monitored_positions
      WHERE status = 'active' AND paused IS NOT 1
        AND (source IS NULL OR source != 'external')`
  ).all().filter(p => p.entry_price != null && p.initial_risk > 0 && !p.be_moved)
  if (positions.length === 0) return { skipped: 'no eligible positions', session: sess.id }

  const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
  const loopMod = deps.loop ?? await import('../loop.js')
  const s = loopMod.prepareStatements(db)
  const symbolMap = (() => { try { return JSON.parse(getState(db, 'symbol_id_map') || '{}') } catch { return {} } })()
  const day = nowDate.toISOString().slice(0, 10)

  let locked = 0
  for (const pos of positions) {
    try {
      const key = `${pos.id}|${sess.id}|${day}`
      if (acted.has(key)) continue
      const symbolId = symbolMap[String(pos.symbol).toUpperCase()]
      if (!symbolId) continue

      const q = await ws.wsGetSpotOnce(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolId)
      const mid = q?.bid != null && q?.ask != null ? (q.bid + q.ask) / 2 : null
      if (mid == null) continue // symbol's own market closed / no feed

      // Below the profit threshold: DON'T mark acted — price can still climb
      // into the threshold later in the same window and deserve the lock.
      const r = currentR(pos, mid)
      if (r == null || r < cfg.minR) continue

      // Breakeven must TIGHTEN — for a long the new SL must sit above the
      // current one, for a short below. Never loosen a stop.
      const long = pos.side === 'long' || pos.side === 'BUY'
      const newSL = pos.entry_price
      const tightens = pos.current_sl == null || (long ? newSL > pos.current_sl : newSL < pos.current_sl)
      acted.add(key)
      if (!tightens) continue

      const reason = `session_open_guard: ${sess.label} opened ${sess.openedAgoMin}m ago at +${r.toFixed(2)}R — SL locked to breakeven`
      const outcome = await loopMod.executeBrokerAction(db, s, pos, { action: 'MOVE_SL', newSL, reason })
      if (!outcome.error) {
        s.updatePositionCheck.run('GUARD:BE', reason, new Date(now()).toISOString(), 'intact', pos.id)
        locked++
        console.log(`[session-open-guard] ${pos.symbol}: ${reason}`)
        try { deps.notify?.(`🛡 SESSION-OPEN GUARD: ${pos.symbol} +${r.toFixed(2)}R at ${sess.label} open — SL moved to breakeven ${newSL}.`) } catch { /* best effort */ }
      }
    } catch (err) {
      console.error('[session-open-guard]', pos.symbol, err.message)
    }
  }
  return { session: sess.id, considered: positions.length, locked }
}
