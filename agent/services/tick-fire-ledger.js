// agent/services/tick-fire-ledger.js — PR-1b (20-09-2026): the tick fill's
// REASON, written from the sidecar's own fire ring.
//
// THE MEASURED DEFECT. PR-1a makes a tick fill owned by the bot: the
// reconciler adopts it as source='autopilot', strategy='tick_momentum_breakout',
// origin='bot_market_dispatch' from its FILLED intent. Its CLOSE still cannot
// produce a complete `position_history` row, because `direction_reason` is in
// REQUIRED_FIELDS (position-history.js:77-85) and is readable from exactly one
// place — `risk_events.proposal_json`, via `trades.risk_event_id`
// (directionReasonFor). The tick path writes NO risk_events row: signal → order
// is in-process on the sidecar (cpp-exec/src/tick_firer.cpp). So the capture
// queue burns its MAX_ATTEMPTS=6 / MAX_REVERIFY=3 on every tick close and gives
// up with `missing: direction_reason` — which is what happened to COIN.US on
// …0949.
//
// The one place the direction FACT exists is the firer's ring line. PR-1b
// extends the `fire_result` detail with the breakout the ShadowFill held
// (entry/stop/target/side) and this pass turns each OK fire into ONE approved
// risk_events row, linked to its intent.
//
// BOUNDED BY FILLS, NOT BY FEEDER PASSES. One row per fire that the broker
// accepted — not one per permit, not one per veto. That is why this is not the
// veto-noise shape owner principle 7 is aimed at: the feeder reserves standing
// permits minutes-to-hours before any fill and writes nothing here.
//
// WHY A WINDOW LOOKUP CANNOT DO THIS. stampAdoptedFromIntent's ±5-minute search
// is anchored on the INTENT's created_at, and a standing tick permit is created
// by the feeder pass (tick-permits.js reserveStandingPermits) long before its
// fill — the window misses by construction. So the link is written here, on
// `entry_intents.risk_event_id`, and the reconciler prefers it.
//
// THE REASON IS A STATEMENT OF WHAT MOVED — `tick:breakout_BUY_entry=…_stop=…
// _target=…`, the same shape as vwap-trend.js's 'vwap:close>rising_vwap'. A
// reason that just said "tick" would be the tautology position-history.js:93-107
// refuses ("long because the strategy is a long strategy"), so a fire_result
// whose detail carries no prices (an older sidecar) writes NO risk event and is
// counted as unattributed instead of being filled in with a guess.
import { getState, setState } from '../db.js'

export const TICK_FIRE_LEDGER_CURSOR_KEY = 'tick_fire_ledger_cursor_json'
// THE COUNT OUTLIVES THE PASS (20-09-2026, checker round). A lost window
// visible only in a log line is this repo's protection-audit shape: the sweep
// fired every 50 seconds while its RECORD sat a week stale, and nobody reads a
// log after the fact. The ring is bounded and OVERWRITTEN, so a fire this pass
// could not attribute is gone for good — so each pass stores its own figures,
// and the unattributed counts accumulate BY REASON with the span they cover.
// Nothing reads these yet; the readiness view is a later PR. The record exists
// first, because a count that was never written cannot be shown later.
export const TICK_FIRE_LEDGER_LAST_KEY = 'tick_fire_ledger_last_json'
export const TICK_FIRE_LEDGER_TOTALS_KEY = 'tick_fire_ledger_totals_json'
export const TICK_FIRE_KINDS = Object.freeze(['fire', 'fire_result', 'fire_reject', 'fire_refused'])
const STRATEGY = 'tick_momentum_breakout'
const PRODUCER = 'tick_momentum'
const MAX_ROWS = 1000

/** `a=1 b=2` → { a: '1', b: '2' } — the same reading tick-readiness.js does. */
export function parseDetail(detail) {
  return Object.fromEntries([...String(detail || '').matchAll(/([A-Za-z_]\w*)=([^\s]+)/g)].map(m => [m[1], m[2]]))
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }

/**
 * The direction reason for one OK fire. Null when the ring line does not carry
 * the breakout — absent is reported, never invented.
 */
export function reasonFor({ side, entry, stop, target }) {
  const s = String(side || '').toUpperCase()
  if (s !== 'BUY' && s !== 'SELL') return null
  if (entry == null || stop == null) return null
  const t = target == null ? '' : `_target=${target}`
  return `tick:breakout_${s}_entry=${entry}_stop=${stop}${t}`
}

/**
 * Store this pass's own figures and fold its unattributed counts into the
 * running totals. Best-effort: an unwritable agent_state must not lose the
 * risk events the pass already wrote.
 */
function persist(db, out, now) {
  const at = new Date(now).toISOString()
  try {
    setState(db, TICK_FIRE_LEDGER_LAST_KEY, JSON.stringify({
      at, scanned: out.scanned, written: out.written, skipped: out.skipped,
      unattributed: out.unattributed, rejects: out.rejects,
      reasons: [...new Set(out.reasons)], cursor: out.cursor,
    }))
  } catch { /* state unwritable */ }
  try {
    let t = null
    try { t = JSON.parse(getState(db, TICK_FIRE_LEDGER_TOTALS_KEY) || 'null') } catch { t = null }
    const totals = {
      firstAt: t?.firstAt || at,
      lastAt: at,
      passes: Number(t?.passes || 0) + 1,
      written: Number(t?.written || 0) + out.written,
      skipped: Number(t?.skipped || 0) + out.skipped,
      rejects: Number(t?.rejects || 0) + out.rejects,
      unattributedTotal: Number(t?.unattributedTotal || 0) + out.unattributed,
      unattributed: { ...(t?.unattributed && typeof t.unattributed === 'object' ? t.unattributed : {}) },
    }
    // BY REASON, because "3 unattributed" and "3 intent_missing" answer
    // different questions: a pruned intent is a retention problem, a missing
    // breakout is a sidecar that predates the fire-detail change.
    for (const why of out.reasons) totals.unattributed[why] = Number(totals.unattributed[why] || 0) + 1
    setState(db, TICK_FIRE_LEDGER_TOTALS_KEY, JSON.stringify(totals))
  } catch { /* state unwritable */ }
}

/**
 * Read the fire ring rows above the stored high-water mark and write one
 * approved risk_events row per accepted fire.
 *
 * Idempotent BY INTENT ID: an intent that already carries a risk_event_id is
 * skipped, so a re-pull of the same ring (a cursor reset, a sidecar restart
 * that replays the whole ring) writes zero. Returns counts; never throws.
 */
export function runTickFireLedger(db, { now = Date.now(), limit = MAX_ROWS } = {}) {
  const out = { scanned: 0, written: 0, skipped: 0, unattributed: 0, rejects: 0, reasons: [], cursor: null }
  let cur = null
  try { cur = JSON.parse(getState(db, TICK_FIRE_LEDGER_CURSOR_KEY) || 'null') } catch { cur = null }
  const lastId = Number(cur?.lastId) > 0 ? Number(cur.lastId) : 0

  let rows = []
  try {
    rows = db.prepare(
      `SELECT id, side, boot_id, seq, ts_ms, component, kind, account_id, symbol_id, code, detail
         FROM cpp_decisions
        WHERE component = 'tick' AND kind IN ('fire', 'fire_result', 'fire_reject', 'fire_refused') AND id > ?
        ORDER BY id LIMIT ?`
    ).all(lastId, Math.max(1, Math.min(MAX_ROWS, limit)))
  } catch { return out }
  if (!rows.length) { out.cursor = cur; return out }

  const intentOf = db.prepare('SELECT * FROM entry_intents WHERE id = ?')
  const insert = db.prepare(
    `INSERT INTO risk_events (symbol, side, approved, veto_reason, checks_json, proposal_json, account_id, created_at)
     VALUES (?, ?, 1, NULL, NULL, ?, ?, ?)`
  )
  const link = db.prepare('UPDATE entry_intents SET risk_event_id = ? WHERE id = ? AND risk_event_id IS NULL')

  for (const r of rows) {
    out.scanned++
    // A refusal or a broker rejection opened NO risk: no risk event, ever.
    if (r.kind !== 'fire_result' || String(r.code || '') !== 'ok') {
      if (r.kind === 'fire_reject' || r.kind === 'fire_refused') out.rejects++
      continue
    }
    const d = parseDetail(r.detail)
    const intentId = d.intent || null
    if (!intentId) { out.unattributed++; out.reasons.push('no_intent_token'); continue }
    let it = null
    try { it = intentOf.get(String(intentId)) } catch { it = null }
    // The ring is bounded and overwritten, and an intent can be pruned: a fire
    // whose intent is gone is COUNTED, so a lost window is visible rather than
    // silent. Nothing is invented for it.
    if (!it) { out.unattributed++; out.reasons.push('intent_missing'); continue }
    if (it.risk_event_id != null) { out.skipped++; continue }
    const side = String(d.side || it.side || '').toUpperCase()
    const entry = num(d.entry), stop = num(d.stop), target = num(d.target)
    const reason = reasonFor({ side, entry, stop, target })
    if (!reason) { out.unattributed++; out.reasons.push('no_breakout_fact'); continue }
    const proposal = {
      direction_reason: reason,
      strategy: STRATEGY,
      producer_id: PRODUCER,
      intent_id: String(intentId),
      symbol: it.symbol ?? null,
      symbol_id: it.symbol_id ?? (r.symbol_id ?? null),
      side,
      entry,
      sl: it.sl ?? stop,
      tp: it.tp ?? target,
      source: 'tick_fire_ledger',
      ring: { side: r.side, bootId: r.boot_id, seq: r.seq },
    }
    const at = Number.isFinite(Number(r.ts_ms)) && Number(r.ts_ms) > 0 ? new Date(Number(r.ts_ms)).toISOString() : new Date(now).toISOString()
    try {
      const info = insert.run(it.symbol ?? null, side, JSON.stringify(proposal), String(it.account_id), at)
      const id = info?.lastInsertRowid ?? null
      if (id != null) { link.run(id, String(intentId)); out.written++ }
    } catch { out.unattributed++; out.reasons.push('write_failed') }
  }

  const last = rows[rows.length - 1]
  const next = { lastId: Number(last.id), bootId: String(last.boot_id || ''), seq: Number(last.seq) || 0 }
  try { setState(db, TICK_FIRE_LEDGER_CURSOR_KEY, JSON.stringify(next)) } catch { /* state unwritable — re-read next pass */ }
  out.cursor = next
  persist(db, out, now)
  if (out.written || out.unattributed) {
    // Account ids by last 4 (repo rule). One line per pass, only when it said
    // something: silence here would hide exactly the lost window this counts.
    console.log(`[tick-fire-ledger] ${out.written} reason(s) written, ${out.skipped} already linked, ${out.unattributed} unattributed${out.reasons.length ? ` (${[...new Set(out.reasons)].join(', ')})` : ''}, cursor id ${next.lastId}`)
  }
  return out
}
