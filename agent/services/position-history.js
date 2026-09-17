// agent/services/position-history.js — one complete record per closed
// position (owner, 17-09-2026).
//
// THE PROBLEM THIS EXISTS FOR, in the owner's words: two months in, the bot
// still cannot read its own historical positions to tell what worked from
// what did not, unless a statement is downloaded per account. The data is not
// missing — it is scattered across five tables, each written by a different
// path, none of which is a record of a POSITION.
//
//   trade_plans     what was intended at entry
//   risk_events     why the direction was taken (proposal_json)
//   trades          what this process believes happened
//   position_events every stop move, trail and scale-out in between
//   broker_deals    what the broker actually reports
//
// This module joins them into one row per (account, position), and REFUSES to
// write a row that is not whole.
//
// COMPLETENESS IS A GATE, NOT A COERCION. The owner's rule is that the record
// carries no null field. The tempting reading is "fill the blanks" — default
// the commission to 0, take the plan's entry when the fill is missing, call
// an unlabelled close 'unknown'. That produces a table that is complete and
// false, which is worse than one that is short and honest: every number in it
// would look like a measurement. So a record missing any REQUIRED field goes
// to `position_history_incomplete` with each missing field NAMED, and the
// clean table stays clean.
//
// ABSENT IS NOT ZERO. Every read goes through `num()` / `str()`, which return
// null for absent and undefined and keep a real 0. `Number(null) === 0` has
// cost this project three separate defects (lot-size-registry.js), and here it
// would turn "we never recorded the commission" into "the commission was
// nothing" — silently, on a field that changes the P&L.
//
// NOTHING IS RECOMPUTED FROM A PRICE MOVE. net_pnl, commission and swap are
// copied from the broker's own figures. Deriving them from entry and exit is
// precisely the calculation cpp-verify exists to check, and a record that
// derived them would agree with itself by construction.

const num = (v) => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
const str = (v) => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s === '' ? null : s
}
const ms = (v) => {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) : null
  const t = Date.parse(String(v).includes('T') ? String(v) : String(v).replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : null
}

/**
 * The fields a record must carry to be counted as whole.
 *
 * WHAT IS ON THIS LIST AND WHAT IS NOT is the whole design decision. A field
 * is required when a missing value would make an ANALYSIS wrong rather than
 * merely less detailed:
 *
 *   - `direction_reason` is required because principle 8 says trade direction
 *     is key and principle 4 says every trade has a reason. A record that
 *     cannot say why the direction was chosen cannot answer the question this
 *     table exists for.
 *   - `commission` and `swap` are required because they are subtracted from
 *     the money. Absent, the net is overstated.
 *   - `planned_tp` is NOT required: a runner with no fixed target is a
 *     deliberate design (PR-J), not a gap.
 *   - `family`, `timeframe`, `conviction`, `symbol_id` are not required:
 *     their absence narrows what can be grouped, it does not make any figure
 *     wrong.
 */
export const REQUIRED_FIELDS = Object.freeze([
  'account_id', 'ctrader_position_id', 'symbol',
  'direction', 'direction_reason', 'strategy', 'origin',
  'planned_entry', 'planned_sl', 'risk_dist',
  'entry_price', 'exit_price', 'volume',
  'opened_at_ms', 'closed_at_ms', 'hold_ms',
  'gross_pnl', 'commission', 'swap', 'net_pnl', 'realised_r',
  'close_reason', 'sl_moves', 'tp_moves', 'scale_outs',
])

const DIRECTION = { BUY: 'long', LONG: 'long', SELL: 'short', SHORT: 'short' }
const normDirection = (v) => DIRECTION[String(v ?? '').trim().toUpperCase()] ?? null

/**
 * Why this direction was taken, from the risk event that approved it.
 *
 * PR-D put `direction_reason` in `risk_events.proposal_json`. It is read from
 * there and NOT invented: a record whose reason is "long because the strategy
 * is a long strategy" is the tautology principle 4 is aimed at, so an absent
 * reason stays absent and the record goes to the refused stream, where it is
 * countable.
 */
export function directionReasonFor(db, riskEventId) {
  if (riskEventId == null) return null
  let row
  try { row = db.prepare('SELECT proposal_json FROM risk_events WHERE id = ?').get(riskEventId) } catch { return null }
  if (!row?.proposal_json) return null
  try {
    const p = JSON.parse(row.proposal_json)
    return str(p?.direction_reason ?? p?.directionReason)
  } catch { return null }
}

/**
 * The broker's numeric symbol id for a symbol name, from the map the loop
 * already keeps. `trades` has no symbol_id column — reading one off it would
 * quietly yield null forever — so it is resolved here, and stays null when
 * the map has no entry rather than being guessed.
 */
export function symbolIdFor(db, symbol) {
  const name = str(symbol)
  if (name == null) return null
  try {
    const raw = db.prepare(`SELECT value FROM agent_state WHERE key = 'symbol_id_map'`).get()?.value
    const map = JSON.parse(raw || '{}') || {}
    return num(map[name])
  } catch { return null }
}

/** The management history: what was done to the position while it was open. */
export function managementFor(db, { accountId, positionId, tradeId }) {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT at, kind, from_value, to_value, r_at, price_at, reason, source
        FROM position_events
       WHERE (position_id = ? AND (account_id = ? OR account_id IS NULL))
          OR (? IS NOT NULL AND trade_id = ?)
       ORDER BY id ASC
    `).all(String(positionId), accountId == null ? null : String(accountId), tradeId ?? null, tradeId ?? null)
  } catch { rows = [] }

  const count = (kind) => rows.filter(r => r.kind === kind).length
  return {
    // A position with no recorded management is a real and common outcome —
    // it opened and hit its stop. Zero here is a READING, which is why these
    // three are required fields: an absent count would be a different fact
    // (we did not look) and must not read as "nothing happened".
    sl_moves: count('sl_moved') + count('trail_tightened'),
    tp_moves: count('tp_moved'),
    scale_outs: count('scale_out') + count('lot_trimmed'),
    events: rows.map(r => ({
      at: r.at, kind: r.kind, from: num(r.from_value), to: num(r.to_value),
      r: num(r.r_at), price: num(r.price_at), reason: str(r.reason), source: str(r.source),
    })),
  }
}

/**
 * Build the record for one closed position from whatever the tables hold.
 *
 * Returns `{ record, missing, sources }`. `missing` is the list of REQUIRED
 * fields that came back null — the caller decides which stream it lands in,
 * so this function has no opinion and no side effect.
 */
export function buildPositionRecord(db, { accountId, positionId }) {
  const acct = str(accountId)
  const pid = str(positionId)
  const sources = {}

  const trade = (() => {
    try {
      return db.prepare(`
        SELECT * FROM trades
         WHERE ctrader_position_id = ? AND (account_id = ? OR ? IS NULL)
         ORDER BY id DESC LIMIT 1
      `).get(pid, acct, acct)
    } catch { return null }
  })()
  if (trade) sources.trade = 'trades'

  const plan = trade?.id != null ? (() => {
    try { return db.prepare('SELECT * FROM trade_plans WHERE trade_id = ?').get(trade.id) } catch { return null }
  })() : null
  if (plan) sources.plan = 'trade_plans'

  // BROKER TRUTH WINS ON THE BROKER'S OWN FIELDS. Where `broker_deals` has a
  // figure it is used; the local row is the fallback, and which one supplied
  // each group is recorded rather than left to be guessed later.
  const deal = (() => {
    try {
      return db.prepare(`
        SELECT position_id, symbol, side, lots, entry_price, close_price, opened_at, closed_at,
               gross_pnl, swap, commission, net_pnl
          FROM broker_deals WHERE position_id = ? AND (account_id = ? OR ? IS NULL)
         ORDER BY closed_at DESC LIMIT 1
      `).get(pid, acct, acct)
    } catch { return null }
  })()
  sources.money = deal ? 'broker_deals' : (trade ? 'trades' : null)

  const mgmt = managementFor(db, { accountId: acct, positionId: pid, tradeId: trade?.id ?? null })
  sources.management = 'position_events'

  const riskEventId = trade?.risk_event_id ?? null
  const directionReason = directionReasonFor(db, riskEventId)
  if (directionReason != null) sources.direction_reason = 'risk_events.proposal_json'

  const openedMs = ms(deal?.opened_at) ?? ms(trade?.opened_at)
  const closedMs = num(trade?.closed_at_ms) ?? ms(deal?.closed_at) ?? ms(trade?.closed_at)
  const entry = num(deal?.entry_price) ?? num(trade?.entry_price)
  const exit = num(deal?.close_price) ?? num(trade?.exit_price)
  const plannedEntry = num(plan?.planned_entry) ?? num(trade?.proposal_entry_price)
  const plannedSl = num(plan?.planned_sl) ?? num(trade?.sl_price)
  const riskDist = num(plan?.risk_dist) ?? (
    plannedEntry != null && plannedSl != null ? Math.abs(plannedEntry - plannedSl) : null
  )
  const net = num(deal?.net_pnl) ?? num(trade?.net_pnl)

  // realised_r is a RATIO OF THINGS WE MEASURED, not a re-derivation of the
  // money: (exit - entry) signed by direction, over the planned risk
  // distance. It is null when either input is, rather than 0.
  const direction = normDirection(trade?.side ?? deal?.side ?? plan?.side)
  const realisedR = num(trade?.realised_rr) ?? (
    entry != null && exit != null && riskDist ? ((direction === 'short' ? entry - exit : exit - entry) / riskDist) : null
  )

  const record = {
    account_id: acct ?? str(trade?.account_id),
    ctrader_position_id: pid,
    symbol: str(trade?.symbol) ?? str(deal?.symbol),
    symbol_id: symbolIdFor(db, str(trade?.symbol) ?? str(deal?.symbol)),
    trade_id: trade?.id ?? null,

    direction,
    direction_reason: directionReason,
    strategy: str(plan?.strategy) ?? str(trade?.strategy) ?? str(trade?.label_strategy),
    family: str(plan?.family),
    timeframe: str(plan?.timeframe) ?? str(trade?.label_timeframe),
    origin: str(trade?.origin) ?? str(trade?.source),
    risk_event_id: riskEventId,
    conviction: num(trade?.conviction),
    planned_entry: plannedEntry,
    planned_sl: plannedSl,
    planned_tp: num(plan?.planned_tp) ?? num(trade?.tp_price),
    planned_r: num(plan?.planned_r),
    risk_dist: riskDist,
    planned_hold_min: num(plan?.planned_hold_min),
    exit_rule: str(plan?.exit_rule),

    entry_price: entry,
    exit_price: exit,
    volume: num(deal?.lots) ?? num(trade?.volume),
    opened_at_ms: openedMs,
    closed_at_ms: closedMs,
    hold_ms: num(trade?.hold_duration_ms) ?? (openedMs != null && closedMs != null ? closedMs - openedMs : null),
    gross_pnl: num(deal?.gross_pnl) ?? num(trade?.gross_pnl),
    commission: num(deal?.commission) ?? num(trade?.commission),
    swap: num(deal?.swap) ?? num(trade?.swap),
    net_pnl: net,
    realised_r: realisedR,

    close_reason: str(trade?.close_reason) ?? str(plan?.exit_reason),
    sl_moves: mgmt.sl_moves,
    tp_moves: mgmt.tp_moves,
    scale_outs: mgmt.scale_outs,
    events_json: JSON.stringify(mgmt.events),

    sources_json: JSON.stringify(sources),
  }

  const missing = REQUIRED_FIELDS.filter(f => record[f] === null || record[f] === undefined)
  return { record, missing, sources }
}

/**
 * Build and store one record, in whichever stream it belongs.
 *
 * A position is written to exactly ONE of the two tables: promoting a record
 * out of the refused stream deletes its row there, and a record that stops
 * being complete (a source row edited by a backfill) moves the other way. A
 * position present in both would make every count ambiguous.
 */
export function capturePosition(db, { accountId, positionId }) {
  const { record, missing } = buildPositionRecord(db, { accountId, positionId })
  const acct = record.account_id
  const pid = record.ctrader_position_id
  if (acct == null || pid == null) return { ok: false, reason: 'no_identity', missing }

  if (missing.length) {
    db.prepare(`
      INSERT INTO position_history_incomplete (account_id, ctrader_position_id, symbol, closed_at_ms, missing_json, partial_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, ctrader_position_id) DO UPDATE SET
        symbol = excluded.symbol, closed_at_ms = excluded.closed_at_ms,
        missing_json = excluded.missing_json, partial_json = excluded.partial_json,
        built_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(acct, pid, record.symbol, record.closed_at_ms, JSON.stringify(missing), JSON.stringify(record))
    db.prepare('DELETE FROM position_history WHERE account_id = ? AND ctrader_position_id = ?').run(acct, pid)
    return { ok: false, reason: 'incomplete', missing, stream: 'incomplete' }
  }

  const cols = [
    'account_id', 'ctrader_position_id', 'symbol', 'symbol_id', 'trade_id',
    'direction', 'direction_reason', 'strategy', 'family', 'timeframe', 'origin',
    'risk_event_id', 'conviction', 'planned_entry', 'planned_sl', 'planned_tp',
    'planned_r', 'risk_dist', 'planned_hold_min', 'exit_rule',
    'entry_price', 'exit_price', 'volume', 'opened_at_ms', 'closed_at_ms', 'hold_ms',
    'gross_pnl', 'commission', 'swap', 'net_pnl', 'realised_r',
    'close_reason', 'sl_moves', 'tp_moves', 'scale_outs', 'events_json', 'sources_json',
  ]
  // A REBUILD MUST NOT ERASE THE VERIFIER'S ANSWER on fields it already
  // checked, nor keep a stale one when the figures changed. So the verdict is
  // reset to 'unverified' only when a MONEY OR PRICE field actually moved —
  // otherwise re-running the backfill would silently un-verify the whole
  // table, and a table that is never verified is the same as one with no
  // verification at all.
  const prior = db.prepare('SELECT * FROM position_history WHERE account_id = ? AND ctrader_position_id = ?').get(acct, pid)
  const WATCHED = ['entry_price', 'exit_price', 'volume', 'gross_pnl', 'commission', 'swap', 'net_pnl', 'opened_at_ms', 'closed_at_ms']
  const figuresMoved = prior ? WATCHED.some(f => Number(prior[f]) !== Number(record[f])) : false

  db.prepare(`
    INSERT INTO position_history (${cols.join(', ')})
    VALUES (${cols.map(() => '?').join(', ')})
    ON CONFLICT(account_id, ctrader_position_id) DO UPDATE SET
      ${cols.filter(c => c !== 'account_id' && c !== 'ctrader_position_id').map(c => `${c} = excluded.${c}`).join(', ')},
      built_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(...cols.map(c => record[c]))

  if (figuresMoved) {
    db.prepare(`
      UPDATE position_history
         SET verification_state = 'unverified', verified_at = NULL, verifier_host = NULL, disputes_json = NULL
       WHERE account_id = ? AND ctrader_position_id = ?
    `).run(acct, pid)
  }
  db.prepare('DELETE FROM position_history_incomplete WHERE account_id = ? AND ctrader_position_id = ?').run(acct, pid)
  return { ok: true, stream: 'history', reverified: figuresMoved, record }
}

/**
 * Build records for every closed position since `sinceMs`.
 *
 * This is the writer that makes the table real rather than a schema nobody
 * fills — CLAUDE.md failure mode #4, a repair nothing calls.
 */
export function backfillPositionHistory(db, { sinceMs = 0, limit = 5000 } = {}) {
  const rows = db.prepare(`
    SELECT DISTINCT ctrader_position_id AS pid, account_id AS acct
      FROM trades
     WHERE status = 'closed'
       AND ctrader_position_id IS NOT NULL
       AND COALESCE(closed_at_ms, strftime('%s', closed_at) * 1000) >= ?
     ORDER BY COALESCE(closed_at_ms, strftime('%s', closed_at) * 1000) DESC
     LIMIT ?
  `).all(Number(sinceMs) || 0, Number(limit) || 5000)

  const out = { seen: rows.length, complete: 0, incomplete: 0, skipped: 0, missingCounts: {} }
  for (const r of rows) {
    const res = capturePosition(db, { accountId: r.acct, positionId: r.pid })
    if (res.ok) { out.complete++; continue }
    if (res.reason === 'no_identity') { out.skipped++; continue }
    out.incomplete++
    for (const f of res.missing || []) out.missingCounts[f] = (out.missingCounts[f] || 0) + 1
  }
  return out
}

/** Record cpp-verify's answer. Written only from the verifier's reply. */
export function recordVerdict(db, { accountId, positionId, state, disputes = [], host = null, at = null }) {
  if (!['unverified', 'verified', 'disputed', 'absent'].includes(state)) return { ok: false, reason: `bad_state: ${state}` }
  const r = db.prepare(`
    UPDATE position_history
       SET verification_state = ?, verified_at = ?, verifier_host = ?, disputes_json = ?
     WHERE account_id = ? AND ctrader_position_id = ?
  `).run(state, at ?? new Date().toISOString(), host, disputes.length ? JSON.stringify(disputes) : null,
    String(accountId), String(positionId))
  return r.changes === 1 ? { ok: true } : { ok: false, reason: 'no_such_record' }
}

/**
 * What the table can say about itself — for `GET /state/position-history`.
 *
 * The refused stream is reported ALONGSIDE the clean one, with the missing
 * fields ranked. That ranking is the actionable output: it names, in order,
 * what this system does not record about its own trades.
 */
export function positionHistoryView(db, { limit = 100, accountId = null } = {}) {
  const acct = accountId == null ? null : String(accountId)
  const where = acct ? 'WHERE account_id = ?' : ''
  const args = acct ? [acct] : []

  const totals = db.prepare(`
    SELECT COUNT(*) AS n,
           SUM(CASE WHEN verification_state = 'verified' THEN 1 ELSE 0 END) AS verified,
           SUM(CASE WHEN verification_state = 'disputed' THEN 1 ELSE 0 END) AS disputed,
           SUM(CASE WHEN verification_state = 'absent'   THEN 1 ELSE 0 END) AS absent,
           SUM(CASE WHEN verification_state = 'unverified' THEN 1 ELSE 0 END) AS unverified
      FROM position_history ${where}
  `).get(...args)

  const incomplete = db.prepare(`SELECT COUNT(*) AS n FROM position_history_incomplete ${where}`).get(...args)
  const missingRows = db.prepare(`SELECT missing_json FROM position_history_incomplete ${where}`).all(...args)
  const missingCounts = {}
  for (const row of missingRows) {
    let fields = []
    try { fields = JSON.parse(row.missing_json) || [] } catch { fields = [] }
    for (const f of fields) missingCounts[f] = (missingCounts[f] || 0) + 1
  }

  const recent = db.prepare(`
    SELECT account_id, ctrader_position_id, symbol, direction, strategy, origin,
           net_pnl, realised_r, close_reason, closed_at_ms, verification_state
      FROM position_history ${where}
     ORDER BY closed_at_ms DESC LIMIT ?
  `).all(...args, Number(limit) || 100)

  return {
    complete: totals?.n || 0,
    incomplete: incomplete?.n || 0,
    verification: {
      verified: totals?.verified || 0,
      disputed: totals?.disputed || 0,
      absent: totals?.absent || 0,
      unverified: totals?.unverified || 0,
    },
    // Descending, so the first entry is the field most often missing — the
    // one worth fixing first.
    missingFields: Object.entries(missingCounts).sort((a, b) => b[1] - a[1]).map(([field, n]) => ({ field, n })),
    recent,
  }
}
