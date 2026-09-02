// ---------------------------------------------------------------------------
// agent/services/position-events.js — P10 tweak-journal timeline
// (docs/cockpit-data-endpoint-spec.md §4).
//
// monitored_positions keeps current flags (be_moved, scaled_out) and the
// LATEST review, not a timeline; action_log is a generic HTTP log;
// decision_log covers decisions upstream of the risk gate. Nothing records
// the sequence of amendments made to a live position after entry — this
// module is that record.
//
// Rules (same discipline as decision-log.js):
//   - recording NEVER throws (a logging failure must not touch trading)
//   - rows carry the account when the caller knows it, NULL otherwise
//   - a retention sweep keeps the table bounded — these are diagnostic,
//     not bookkeeping (trades/monitored_positions remain the durable record)
// ---------------------------------------------------------------------------

import { getState } from '../db.js'

export const POSITION_EVENTS_RETENTION_DAYS = 90

/**
 * Record one position amendment/lifecycle event.
 * `kind` is one of: sl_moved | tp_moved | scale_out | close | trail_armed
 * | trail_tightened | lot_trimmed | paused | resumed | authority_override
 *
 * `authority_override` is the odd one out: it records an OBSERVATION rather
 * than an amendment. minute-review.js writes it when a lower-authority writer
 * moved a stop the owner placed by hand (§41), and the row's presence is also
 * what stops the same override being reported twice.
 */
/**
 * Management states, in lifecycle order. The journal stamps the state a
 * position was in BEFORE an event and the state the event moved it TO
 * (owner plan, 02-09-2026: "stamp the management state on every position
 * event so the journal carries the state sequence explicitly"). Terminal
 * states are `closed:<kind>` so an exit's cause rides on the row.
 */
export const MANAGEMENT_STATES = Object.freeze(['opened', 'be_moved', 'scaled_out', 'trail_armed', 'trail_tightened'])

/** Kinds that end a position — their state_to is `closed:<kind>`. */
const TERMINAL_KINDS = new Set(['close', 'loss_cap_close', 'position_reversed'])

/**
 * The state a position is in NOW, read from its own journal: the latest
 * event's state_to, or `opened` when the journal is empty. Pure read.
 */
export function currentManagementState(db, { tradeId = null, positionId = null } = {}) {
  try {
    const row = tradeId != null
      ? db.prepare(`SELECT state_to FROM position_events WHERE trade_id = ? AND state_to IS NOT NULL ORDER BY id DESC LIMIT 1`).get(Number(tradeId))
      : positionId != null
        ? db.prepare(`SELECT state_to FROM position_events WHERE position_id = ? AND state_to IS NOT NULL ORDER BY id DESC LIMIT 1`).get(String(positionId))
        : null
    return row?.state_to || 'opened'
  } catch { return 'opened' }
}

/**
 * Where an event moves the lifecycle. Pure: `from` is the current state,
 * `entry`/`side` decide whether a stop move is a break-even move (stop at
 * or beyond entry in the trade's favour). Unknown kinds keep the state.
 */
export function nextManagementState(from, { kind, toValue = null, entry = null, side = null } = {}) {
  const cur = MANAGEMENT_STATES.includes(from) ? from : (String(from || '').startsWith('closed:') ? from : 'opened')
  if (cur.startsWith('closed:')) return cur
  const k = String(kind || '')
  if (TERMINAL_KINDS.has(k)) return `closed:${k}`
  const rank = (s) => MANAGEMENT_STATES.indexOf(s)
  const advance = (to) => (rank(to) > rank(cur) ? to : cur)
  if (k === 'trail_tightened') return advance('trail_tightened')
  if (k === 'trail_armed') return advance('trail_armed')
  if (k === 'scale_out' || k === 'lot_trimmed') return advance('scaled_out')
  if (k === 'sl_moved') {
    const e = Number(entry), t = Number(toValue)
    const s = String(side || '').toLowerCase()
    const dir = s === 'long' || s === 'buy' ? 1 : s === 'short' || s === 'sell' ? -1 : 0
    if (dir !== 0 && Number.isFinite(e) && Number.isFinite(t) && (t - e) * dir >= 0) return advance('be_moved')
    return cur
  }
  return cur
}

export function recordPositionEvent(db, {
  accountId = null,
  positionId = null,
  tradeId = null,
  symbol,
  kind,
  fromValue = null,
  toValue = null,
  rAt = null,
  priceAt = null,
  reason = null,
  source = null,
  detail = null,
}) {
  try {
    const acct = accountId != null
      ? String(accountId)
      : (getState(db, 'ctrader_account_id') || null)
    // The state sequence, derived from the journal itself plus the row's own
    // entry/side for the break-even judgement. Never fatal: a row with NULL
    // states is still a row.
    let stateFrom = null, stateTo = null
    try {
      stateFrom = currentManagementState(db, { tradeId, positionId })
      let entry = null, side = null
      if (tradeId != null) {
        const mp = db.prepare(`SELECT entry_price, side FROM monitored_positions WHERE trade_id = ? ORDER BY id DESC LIMIT 1`).get(Number(tradeId))
        entry = mp?.entry_price ?? null; side = mp?.side ?? null
      }
      stateTo = nextManagementState(stateFrom, { kind, toValue, entry, side })
    } catch { stateFrom = null; stateTo = null }
    db.prepare(`
      INSERT INTO position_events (account_id, position_id, trade_id, symbol, kind, from_value, to_value, r_at, price_at, reason, source, detail_json, state_from, state_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      acct,
      positionId != null ? String(positionId) : null,
      tradeId != null ? Number(tradeId) : null,
      String(symbol),
      String(kind),
      fromValue != null ? Number(fromValue) : null,
      toValue != null ? Number(toValue) : null,
      rAt != null ? Number(rAt) : null,
      priceAt != null ? Number(priceAt) : null,
      reason != null ? String(reason).slice(0, 500) : null,
      source != null ? String(source) : null,
      detail != null ? JSON.stringify(detail).slice(0, 4000) : null,
      stateFrom, stateTo,
    )
  } catch { /* the journal must never block trading */ }
}

/**
 * The last management state a trade reached BEFORE its exit, and the R the
 * journal recorded at that transition — the two numbers a state-conditioned
 * exit model would key on. `opened` with null R when the journal is silent.
 */
export function lastStateBeforeExit(db, tradeId) {
  try {
    const row = db.prepare(
      `SELECT state_to, r_at FROM position_events
        WHERE trade_id = ? AND state_to IS NOT NULL AND state_to NOT LIKE 'closed:%'
        ORDER BY id DESC LIMIT 1`
    ).get(Number(tradeId))
    return { state: row?.state_to || 'opened', rAtTransition: row?.r_at ?? null }
  } catch { return { state: 'opened', rAtTransition: null } }
}

/** Retention sweep — call from the loop's housekeeping, never fatal. */
export function prunePositionEvents(db, retentionDays = POSITION_EVENTS_RETENTION_DAYS) {
  try {
    return db.prepare(
      `DELETE FROM position_events WHERE at < datetime('now', ?)`
    ).run(`-${Math.max(1, Math.round(retentionDays))} days`).changes
  } catch { return 0 }
}
