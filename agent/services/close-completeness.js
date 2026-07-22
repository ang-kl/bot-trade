// ---------------------------------------------------------------------------
// agent/services/close-completeness.js — flag a CLOSED trade that never
// finished being processed: no net_pnl backfill, and/or no postmortem.
//
// Two reactive sweeps already exist and both stay unbounded in time with no
// aging alert:
//   · pnl-backfill.js       — fills net_pnl from broker deal history
//   · loss-postmortem.js    — classifies a closed trade into a lesson
// loss-postmortem.js forces a verdict past 24h old (`stale` → `allowPartial`)
// for any row its own query even reaches — but a trade with BOTH net_pnl AND
// exit_price still NULL never enters that query at all (it's excluded on
// purpose, since there's nothing to classify from). That trade can sit
// forever with no signal that anything is wrong. This sweep is the signal:
// deterministic, no LLM, keyed off closed_at_ms (the millisecond-precision
// column closeTradeRow stamps — agent/db.js) so it only ever looks at trades
// closed after that convergence landed.
//
// A trade closed less than `windowHours` ago is never flagged — that's
// exactly loss-postmortem.js's own 24h staleness cutoff plus headroom, so
// nothing genuinely still "waiting for enough bars" (loss-postmortem.js's
// own `waiting` bucket) can reach this sweep before it would have already
// been force-classified.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ windowHours?: number, now?: number }} [opts]
 * @returns {Array<{id:number, symbol:string, side:string, closedAtMs:number, ageHours:number, missingPnl:boolean, missingPostmortem:boolean}>}
 */
export function findIncompleteCloses(db, { windowHours = 48, now = Date.now() } = {}) {
  const cutoff = now - windowHours * HOUR_MS
  const rows = db.prepare(`
    SELECT t.id, t.symbol, t.side, t.closed_at_ms, t.net_pnl,
           (SELECT id FROM trade_postmortems pm WHERE pm.trade_id = t.id) AS pm_id
    FROM trades t
    WHERE t.status = 'closed'
      AND t.closed_at_ms IS NOT NULL
      AND t.closed_at_ms < ?
      AND (t.net_pnl IS NULL OR pm_id IS NULL)
  `).all(cutoff)

  return rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    closedAtMs: r.closed_at_ms,
    ageHours: Math.round((now - r.closed_at_ms) / HOUR_MS),
    missingPnl: r.net_pnl == null,
    missingPostmortem: r.pm_id == null,
  }))
}

/**
 * One Telegram line per stuck trade — visible instead of silently pending
 * forever. No-op (and no import of telegram.js) when there's nothing to
 * report or no bot token is configured.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ windowHours?: number, now?: number }} [opts]
 * @returns {Promise<{ flagged: number }>}
 */
export async function runCloseCompletenessSweep(db, opts = {}) {
  const stuck = findIncompleteCloses(db, opts)
  if (stuck.length === 0 || !process.env.TELEGRAM_BOT_TOKEN) return { flagged: stuck.length }

  const lines = stuck.slice(0, 20).map(t => {
    const gap = [t.missingPnl && 'no P&L', t.missingPostmortem && 'no postmortem'].filter(Boolean).join(', ')
    return `#${t.id} ${t.symbol} ${t.side} — closed ${t.ageHours}h ago, still ${gap}`
  })
  const extra = stuck.length > 20 ? `\n+${stuck.length - 20} more.` : ''
  try {
    const { sendMessage } = await import('./telegram.js')
    await sendMessage(`⚠️ ${stuck.length} closed trade(s) never finished processing:\n${lines.join('\n')}${extra}`)
  } catch { /* alert best-effort — the sweep itself already ran */ }
  return { flagged: stuck.length }
}
