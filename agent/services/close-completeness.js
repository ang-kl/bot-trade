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

import { CLEAN_BOT_ORIGINS } from '../lib/trade-origin.js'
import { isOurs } from '../lib/trade-labels.js'
import { UNKNOWN_MAX_AGE_MS } from './entry-ledger.js'

const HOUR_MS = 3_600_000

// PR-E (owner principle 4, 11-09-2026): the origin column's first write —
// every entry path stamps `origin` at creation from this date, so a bot
// trade since it with no origin, no strategy, no plan, no approval id or no
// close reason is a trade without a stated reason, not a pre-column row.
export const TRADE_REASONS_CUTOFF_ISO = '2026-08-17'

export const UNREASONED_KINDS = Object.freeze([
  'origin_missing',      // origin NULL on a row opened after the cutoff
  'origin_unknown',      // origin = 'unknown' — written when nothing could be established
  'strategy_missing',    // a clean bot origin with no strategy
  'plan_missing',        // a clean bot origin with no trade_plans row
  'risk_event_missing',  // a clean bot origin with no approval id
  'close_reason_missing', // closed with no close_reason
  'plan_unscored',       // closed, has a plan, the plan was never scored
  'backfilled_after_cutoff', // M3: legacy_unattributed / manual_broker written by the BACKFILL on a post-cutoff row — a write path should have stamped it
  'adopted_ours_unreasoned', // M4: reconciler_adopted with OUR label and no strategy, plan or approval id — a bot fill whose record was lost
  'intent_unknown_stale', // an entry_intents UNKNOWN older than UNKNOWN_MAX_AGE_MS
])

/**
 * The invariant: every trade the bot decided to take since the cutoff has a
 * reason on record, and no send is left UNKNOWN past the resolver's age.
 * Population: `trades` opened at or after `sinceIso` with status open or
 * closed (a refused or cancelled submission never became a trade). External
 * origins (reconciler_adopted, manual_broker, external_system) carry no
 * strategy by design and are outside the population; an origin NULL or
 * 'unknown' since the cutoff is itself the violation.
 *
 * @returns {{ sinceIso: string, trades: number, violations: Array<{tradeId?:number, intentId?:string, kind:string, detail:string}>, counts: { total:number, byKind: Record<string, number> } }}
 */
export function findUnreasonedTrades(db, { sinceIso = TRADE_REASONS_CUTOFF_ISO, now = Date.now(), unknownMaxAgeMs = UNKNOWN_MAX_AGE_MS } = {}) {
  const clean = CLEAN_BOT_ORIGINS.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT t.id, t.symbol, t.side, t.status, t.origin, t.origin_source, t.label_raw, t.strategy, t.risk_event_id, t.close_reason, t.opened_at,
           p.trade_id AS plan_id, p.scored_at
      FROM trades t LEFT JOIN trade_plans p ON p.trade_id = t.id
     WHERE t.status IN ('open', 'closed')
       AND t.opened_at IS NOT NULL
       AND REPLACE(t.opened_at, 'T', ' ') >= ?
       AND (t.origin IS NULL OR t.origin = 'unknown' OR t.origin IN (${clean})
            OR (t.origin_source = 'backfill' AND t.origin IN ('legacy_unattributed', 'manual_broker'))
            OR t.origin = 'reconciler_adopted')
     ORDER BY t.id
  `).all(sinceIso, ...CLEAN_BOT_ORIGINS)
  const violations = []
  const push = (tradeId, kind, detail) => violations.push({ tradeId, kind, detail })
  for (const r of rows) {
    const who = `#${r.id} ${r.symbol} ${r.side}`
    if (r.origin == null) { push(r.id, 'origin_missing', `${who}: origin NULL on a row opened ${r.opened_at}`); continue }
    if (r.origin === 'unknown') { push(r.id, 'origin_unknown', `${who}: origin 'unknown'`); continue }
    if (r.origin_source === 'backfill' && (r.origin === 'legacy_unattributed' || r.origin === 'manual_broker')) {
      // M3: the backfill is bounded to pre-cutoff rows (origin-backfill.js);
      // a post-cutoff row carrying its stamp was laundered, not explained.
      push(r.id, 'backfilled_after_cutoff', `${who}: origin '${r.origin}' written by the backfill on a row opened ${r.opened_at} — after the cutoff a write path should have stamped it`)
      continue
    }
    if (r.origin === 'reconciler_adopted') {
      // M4: an adopted position wearing OUR label is a bot fill whose local
      // record was lost; it needs the same reasons as any bot trade.
      let ours = false
      try { ours = isOurs(r.label_raw || '') } catch { ours = false }
      if (ours && (r.strategy == null || String(r.strategy).trim() === '' || r.plan_id == null || r.risk_event_id == null)) {
        const missing = [(r.strategy == null || String(r.strategy).trim() === '') && 'strategy', r.plan_id == null && 'plan', r.risk_event_id == null && 'approval id'].filter(Boolean).join(', ')
        push(r.id, 'adopted_ours_unreasoned', `${who}: adopted with our label (${String(r.label_raw).slice(0, 40)}) and no ${missing}`)
      }
      continue
    }
    if (r.strategy == null || String(r.strategy).trim() === '') push(r.id, 'strategy_missing', `${who}: no strategy`)
    if (r.plan_id == null) push(r.id, 'plan_missing', `${who}: no trade_plans row`)
    if (r.risk_event_id == null) push(r.id, 'risk_event_missing', `${who}: no risk_event_id`)
    if (r.status === 'closed') {
      if (r.close_reason == null || String(r.close_reason).trim() === '') push(r.id, 'close_reason_missing', `${who}: closed with no close_reason`)
      if (r.plan_id != null && r.scored_at == null) push(r.id, 'plan_unscored', `${who}: closed, plan never scored`)
    }
  }
  let stale = []
  try {
    stale = db.prepare(`SELECT id, account_id, symbol, side, created_at FROM entry_intents WHERE state = 'UNKNOWN' AND created_at <= ? ORDER BY id`)
      .all(new Date(now - unknownMaxAgeMs).toISOString())
  } catch { stale = [] }
  for (const it of stale) {
    const ageH = Math.round((now - Date.parse(it.created_at)) / HOUR_MS)
    violations.push({ intentId: it.id, kind: 'intent_unknown_stale', detail: `${it.id} …${String(it.account_id).slice(-4)} ${it.symbol} ${it.side}: UNKNOWN for ${ageH}h` })
  }
  const byKind = {}
  for (const v of violations) byKind[v.kind] = (byKind[v.kind] || 0) + 1
  // `trades` = the bot's own rows (clean origins, or NULL/'unknown' since
  // the cutoff); `considered` adds the adopted and backfilled rows read for
  // the M3/M4 kinds, which are not bot trades unless a stamp made them one.
  const bot = rows.filter(r => r.origin == null || r.origin === 'unknown' || CLEAN_BOT_ORIGINS.includes(r.origin)).length
  return { sinceIso, trades: bot, considered: rows.length, violations, counts: { total: violations.length, byKind } }
}

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
