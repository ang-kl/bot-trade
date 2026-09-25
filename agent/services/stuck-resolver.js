// ---------------------------------------------------------------------------
// agent/services/stuck-resolver.js — V3 I3: the stuck-record resolver
// (LIFECYCLE-SPEC §7 resolver fixes R1, R2, R5, R6, R7) under the owner's
// write-off rule of 25-09-2026 21:30 SGT:
//
//   settle each stuck record from broker evidence where it exists; otherwise
//   mark it terminal "unresolved: no broker evidence" with reason + evidence
//   + timestamp, EXCLUDED from P&L and money totals, STILL SHOWN, and no
//   longer counted as stuck (a visible notice instead). Never delete a record.
//
// WHAT IT READS — local broker evidence only, the reads the code already has:
// broker_deals (the broker's deal history, imported), broker_orders (the
// broker's resting-order book, synced every reconcile), trades rows the
// reconciler adopted from the broker's open positions, entry_intents and the
// intent tag the broker echoes on a fill's label, trade_plans and the risk
// event behind a trade. No network call is made here.
//
// WHAT IT WRITES — never an order. It never places, amends, cancels or closes
// anything at the broker. It writes one `stuck_resolutions` row per record it
// ends (lib/stuck-resolutions.js) and, only where the broker evidence says
// what the record should read, the record itself:
//   R2  an in-flight trade whose fill is a broker closing deal no ledger row
//       carries becomes that closed trade (status, position, broker money —
//       NULL where any deal lacks it, never a partial sum);
//   R5  an in-flight trade whose fill the reconciler adopted as another row
//       is a duplicate of that row: ended by its resolution row, not deleted;
//   R1  a resting-order row whose fill a trade carries reads 'filled' (also a
//       terminal row stored 'expired'/'cancelled' against that evidence);
//       one whose order left the broker's book with no fill reads 'expired',
//       the table's own "gone at broker" meaning (pending-orders.js:353);
//   R6  a capture that gave up is re-queued ONCE when every field it lacked
//       now exists upstream; a second give-up is written off;
//   R7  a targetless open position whose trade row has no target gets the
//       target the bot recorded for it (the approval's tp1, the resting
//       order's tp, the plan's planned_tp — side- and scale-checked) written
//       to trades.tp_price, where target-restore (its own switch and checks)
//       reads it. Nothing recorded → written off.
// Everything else past its age bound is written off: the record keeps what it
// said, and its resolution row carries the verdict, reason and evidence.
//
// OFF THE HOT PATH, BOUNDED, IDEMPOTENT. It runs on the order_lifecycle
// ticker's own unref'd timer (order-lifecycle-ticker.js), before the snapshot
// is built, never on the trading loop. Every population read has a LIMIT, at
// most MAX_WRITES_PER_KIND records are ended per kind per pass, each in its
// own transaction, and a subject already resolved is never judged again
// (stuck_resolutions.subject is the primary key; ON CONFLICT DO NOTHING).
// ---------------------------------------------------------------------------

import { labelIntentId } from '../lib/trade-labels.js'
import {
  subjectFor, UNRESOLVED_NO_EVIDENCE, UNRESOLVED_AMBIGUOUS, UNRESOLVED_NO_RECORD, UNRESOLVED_NO_TARGET,
} from '../lib/stuck-resolutions.js'
import { stampRealisedAudit } from './trade-consistency.js'
import { directionReasonFor } from './position-history.js'

export const RESOLVER_VERSION = 1
/** A record with no broker evidence is written off only this long after it began: the reconciler adopts and the deal import lands well inside it. */
export const WRITE_OFF_AGE_MS = 24 * 3_600_000
/** At most this many records of one kind are ended per pass. */
export const MAX_WRITES_PER_KIND = 25
/** Every population read is bounded. */
export const READ_LIMIT = 500
/** A broker fill counts as this submission's when its open time is within [-60 s, +5 min] of the submission (a market order fills in seconds). */
export const FILL_BEFORE_MS = 60_000
export const FILL_AFTER_MS = 5 * 60_000
/** An adopted row with no deal carries the adoption stamp, which follows the fill by up to a reconcile pass or two. */
export const ADOPT_AFTER_MS = 15 * 60_000
/** A stop/target further than this fraction of the entry is not in price units (order-lifecycle ABSURD_RISK_FRACTION). */
export const ABSURD_DISTANCE_FRACTION = 0.5
export const ENABLED_KEY = 'stuck_resolver_enabled'
export const LAST_KEY = 'stuck_resolver_last_json'
/** The protection audit logs one POSITION_NO_TARGET row per position per this (naked-position-guard.js LOG_MUTE_MS). */
const LOG_MUTE_MS = Math.max(60_000, Number(process.env.PROTECTION_LOG_MUTE_MS) || 3_600_000)
const ACTION_LOG_WINDOW_IDS = 5_000

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000
const ADOPTION_ORIGINS = ['reconciler_adopted', 'unknown', 'legacy_unattributed']

// ---------------------------------------------------------------- helpers
export function tsMs(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (/^\d{12,14}$/.test(s)) return Number(s)
  const t = /[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? Date.parse(s) : Date.parse(s.replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : null
}
const iso = ms => (ms == null ? null : new Date(ms).toISOString())
/** SQLite datetime() format — what the ledger's own writers store. */
const spaceTs = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
const num = v => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const blank = v => v == null || (typeof v === 'string' && v.trim() === '')
const upper = v => String(v ?? '').trim().toUpperCase()
const acctOf = v => (blank(v) ? null : String(v).trim())
const tail = a => (a == null ? '(no account)' : `…${String(a).slice(-4)}`)
function dirOf(v) {
  const s = upper(v)
  if (s === 'BUY' || s === 'LONG' || s === '1') return 1
  if (s === 'SELL' || s === 'SHORT' || s === '-1') return -1
  return null
}
const tagOf = label => { try { return labelIntentId(label || '') } catch { return null } }
const parseJson = s => { try { return typeof s === 'string' ? JSON.parse(s) : null } catch { return null } }
const posKey = (acct, pid) => `${acct ?? ''}:${String(pid).replace(/\.0+$/, '')}`

function insertResolution(db, r, nowMs) {
  return db.prepare(`
    INSERT INTO stuck_resolutions (subject, kind, rule_id, account_id, trade_id, position_id, outcome, verdict, reason,
                                   evidence_json, prior_state, resolver_version, resolved_at)
    VALUES (@subject, @kind, @rule_id, @account_id, @trade_id, @position_id, @outcome, @verdict, @reason,
            @evidence_json, @prior_state, @resolver_version, @resolved_at)
    ON CONFLICT(subject) DO NOTHING
  `).run({
    subject: r.subject, kind: r.kind, rule_id: r.ruleId, account_id: r.accountId ?? null, trade_id: r.tradeId ?? null,
    position_id: r.positionId == null ? null : String(r.positionId), outcome: r.outcome, verdict: r.verdict, reason: r.reason,
    evidence_json: JSON.stringify(r.evidence ?? {}), prior_state: r.priorState ?? null,
    resolver_version: RESOLVER_VERSION, resolved_at: iso(nowMs),
  }).changes
}

const resolutionOf = (db, subject) => db.prepare('SELECT * FROM stuck_resolutions WHERE subject = ?').get(subject)
const claimed = (db, acct, pid) => db.prepare(
  `SELECT subject FROM stuck_resolutions WHERE outcome = 'settled' AND account_id = ? AND position_id = ? LIMIT 1`,
).get(acct, String(pid))?.subject ?? null

// ================================================================ R2 + R5
/** The in-flight rows STK-03 counts: 'submitting' past 10 min, 'unconfirmed' past 1 h (loop.js:867, :911). */
export function inflightStuck(row, nowMs) {
  const at = tsMs(row.opened_at) ?? -Infinity
  return (row.status === 'submitting' && at < nowMs - 10 * MIN) || (row.status === 'unconfirmed' && at < nowMs - HOUR)
}

/** Broker fills that could be this submission's: adopted rows (R5) and closing deals no ledger row carries (R2). */
function inflightCandidates(db, row) {
  const acct = acctOf(row.account_id)
  const opened = tsMs(row.opened_at)
  const dir = dirOf(row.side)
  const sym = upper(row.symbol)
  if (acct == null || opened == null || dir == null || !sym) return { strong: [], weak: [], unscoped: true }
  const lo = spaceTs(opened - DAY), hi = spaceTs(opened + 2 * DAY)
  const dealOpen = db.prepare(`SELECT MIN(opened_at) AS o FROM broker_deals WHERE account_id = ? AND CAST(position_id AS INTEGER) = CAST(? AS INTEGER)`)
  const strong = [], weak = []
  // R5: a row the reconciler adopted for the same fill.
  const twins = db.prepare(`
    SELECT id, side, status, origin, ctrader_position_id, opened_at FROM trades
     WHERE account_id = ? AND UPPER(symbol) = ? AND status IN ('open', 'closed') AND ctrader_position_id IS NOT NULL AND id <> ?
       AND (origin IS NULL OR origin IN (${ADOPTION_ORIGINS.map(() => '?').join(', ')}))
       AND opened_at >= ? AND opened_at <= ?
     LIMIT 50`).all(acct, sym, row.id, ...ADOPTION_ORIGINS, lo, hi)
  for (const t of twins) {
    if (dirOf(t.side) !== dir) continue
    const d = tsMs(dealOpen.get(acct, t.ctrader_position_id)?.o)
    const fill = d ?? tsMs(t.opened_at)
    if (fill == null) continue
    const after = d != null ? FILL_AFTER_MS : ADOPT_AFTER_MS
    if (fill - opened < -FILL_BEFORE_MS || fill - opened > after) continue
    strong.push({ via: 'adopted_row', tradeId: t.id, positionId: String(t.ctrader_position_id), status: t.status, origin: t.origin ?? null,
      fillAt: iso(fill), fillSource: d != null ? 'broker_deals.opened_at' : 'trades.opened_at (adoption stamp)', deltaSec: Math.round((fill - opened) / 1000) })
  }
  // R2: a closing deal on the same account, symbol and side that no ledger row carries.
  const deals = db.prepare(`
    SELECT deal_id, position_id, side, entry_price, close_price, opened_at, closed_at, gross_pnl, swap, commission, net_pnl FROM broker_deals
     WHERE account_id = ? AND UPPER(symbol) = ?
       AND ((opened_at >= ? AND opened_at <= ?) OR (opened_at IS NULL AND closed_at >= ? AND closed_at <= ?))
     LIMIT 200`).all(acct, sym, lo, hi, lo, hi)
  const byPos = new Map()
  for (const d of deals) {
    const k = String(d.position_id).replace(/\.0+$/, '')
    const l = byPos.get(k) || []
    l.push(d); byPos.set(k, l)
  }
  const carried = db.prepare(`SELECT id FROM trades WHERE account_id = ? AND CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER) AND id <> ? LIMIT 1`)
  const own = row.ctrader_position_id == null ? null : String(row.ctrader_position_id).replace(/\.0+$/, '')
  for (const [pid, list] of byPos) {
    if (dirOf(list[0].side) !== dir) continue
    if (carried.get(acct, pid, row.id)) continue
    const openMs = Math.min(...list.map(d => tsMs(d.opened_at) ?? Infinity))
    const closeMs = Math.min(...list.map(d => tsMs(d.closed_at) ?? Infinity))
    const cand = { via: 'broker_deal', positionId: pid, dealIds: list.map(d => String(d.deal_id)), openedAt: iso(Number.isFinite(openMs) ? openMs : null), closedAt: iso(Number.isFinite(closeMs) ? closeMs : null) }
    // The row already names this position (the ACK carried it, the promote
    // never landed): its own deal, whatever the timing.
    if (own != null && pid === own) { strong.push({ ...cand, deltaSec: Number.isFinite(openMs) ? Math.round((openMs - opened) / 1000) : null, own: true }); continue }
    if (Number.isFinite(openMs)) {
      if (openMs - opened < -FILL_BEFORE_MS || openMs - opened > FILL_AFTER_MS) continue
      strong.push({ ...cand, deltaSec: Math.round((openMs - opened) / 1000) })
    } else if (Number.isFinite(closeMs) && closeMs >= opened - FILL_BEFORE_MS && closeMs <= opened + DAY) {
      // No opening time on the deal (outside the import window): it could be
      // this fill or another — evidence, but not enough to settle on.
      weak.push({ ...cand, note: 'deal carries no opening time' })
    }
  }
  const unclaimed = c => { const s = claimed(db, acct, c.positionId); return s ? null : c }
  return { strong: strong.map(unclaimed).filter(Boolean), weak: weak.map(unclaimed).filter(Boolean), unscoped: false }
}

/** R2: the in-flight row IS the only ledger record of this closed position — make it read what the broker says. */
function settleFromDeals(db, row, cand) {
  const acct = acctOf(row.account_id)
  const deals = db.prepare(`SELECT * FROM broker_deals WHERE account_id = ? AND CAST(position_id AS INTEGER) = CAST(? AS INTEGER) ORDER BY closed_at`).all(acct, cand.positionId)
  if (!deals.length) return false
  const last = deals[deals.length - 1]
  const sum = f => (deals.every(d => num(d[f]) != null) ? Math.round(deals.reduce((s, d) => s + num(d[f]), 0) * 100) / 100 : null)
  const closeMs = tsMs(last.closed_at)
  const openMs = Math.min(...deals.map(d => tsMs(d.opened_at) ?? Infinity))
  const hold = closeMs != null && Number.isFinite(openMs) ? closeMs - openMs : null
  // Money only when every deal carries it: a partial sum is a wrong number,
  // and NULL leaves the row to the P&L backfill and its flags (STK-05, CLS-02).
  const changed = db.prepare(`
    UPDATE trades SET status = 'closed', ctrader_position_id = ?, entry_price = COALESCE(?, entry_price),
           exit_price = ?, closed_at = ?, closed_at_ms = ?, hold_duration_ms = COALESCE(?, hold_duration_ms),
           net_pnl = ?, gross_pnl = ?, commission = COALESCE(?, commission), swap = COALESCE(?, swap), close_reason = ?
     WHERE id = ? AND status IN ('submitting', 'unconfirmed')`).run(
    cand.positionId, num(deals.find(d => num(d.entry_price) != null)?.entry_price), num(last.close_price),
    closeMs != null ? spaceTs(closeMs) : null, closeMs, hold, sum('net_pnl'), sum('gross_pnl'), sum('commission'), sum('swap'),
    // "closed at the broker" is the reconciler's own wording for a close whose
    // cause is not known (reconciler.js:118): CLS-03 keeps flagging it, which
    // is the truth — the resolver knows THAT it closed, not why.
    `closed at the broker — settled by the stuck resolver from broker deal(s) ${cand.dealIds.join(', ')}; the close cause is not recorded`,
    row.id,
  ).changes
  if (changed !== 1) return false
  // Realised R and the price/P&L consistency verdict, as every money writer
  // re-stamps them (broker-history-import.js applyBrokerHistoryMoney).
  stampRealisedAudit(db, row.id)
  db.prepare(`UPDATE broker_deals SET matched_trade_id = COALESCE(matched_trade_id, ?) WHERE account_id = ? AND CAST(position_id AS INTEGER) = CAST(? AS INTEGER)`).run(row.id, acct, cand.positionId)
  return true
}

export function resolveInflightTrades(db, { nowMs = Date.now(), maxWrites = MAX_WRITES_PER_KIND } = {}) {
  const out = { examined: 0, settledDuplicate: 0, settledFromDeal: 0, writtenOff: 0, waiting: 0, errors: [] }
  const rows = db.prepare(`
    SELECT id, account_id, symbol, side, status, opened_at, ctrader_position_id FROM trades
     WHERE status IN ('submitting', 'unconfirmed')
       AND NOT EXISTS (SELECT 1 FROM stuck_resolutions sr WHERE sr.subject = 'trade:' || trades.id)
     ORDER BY id LIMIT ?`).all(READ_LIMIT)
  const judged = []
  for (const row of rows) {
    if (!inflightStuck(row, nowMs)) continue
    out.examined++
    judged.push({ row, ...inflightCandidates(db, row) })
  }
  // One broker fill can settle at most ONE in-flight row: two stuck rows
  // reaching for the same fill are ambiguous, never both settled on it.
  const claims = new Map()
  for (const j of judged) for (const c of [...j.strong, ...j.weak]) claims.set(posKey(j.row.account_id, c.positionId), (claims.get(posKey(j.row.account_id, c.positionId)) || 0) + 1)
  let writes = 0
  for (const { row, strong, weak, unscoped } of judged) {
    if (writes >= maxWrites) break
    const subject = subjectFor.trade(row.id)
    const opened = tsMs(row.opened_at)
    const ageMs = opened == null ? Infinity : nowMs - opened
    const base = { subject, kind: 'trade_inflight', ruleId: 'STK-03', accountId: acctOf(row.account_id), tradeId: row.id, priorState: row.status }
    const match = { symbol: row.symbol, side: row.side, submittedAt: iso(opened), window: `[-${FILL_BEFORE_MS / 1000} s, +${FILL_AFTER_MS / 60_000} min] of the submission (+${ADOPT_AFTER_MS / 60_000} min for an adoption stamp)` }
    try {
      const only = strong.length === 1 && weak.length === 0 ? strong[0] : null
      const contested = only != null && (claims.get(posKey(row.account_id, only.positionId)) || 0) > 1
      if (only && !contested && only.via === 'adopted_row') {
        db.transaction(() => insertResolution(db, {
          ...base, positionId: only.positionId, outcome: 'settled', verdict: `duplicate of trade #${only.tradeId}`,
          reason: `the fill is recorded on trade #${only.tradeId} (position ${only.positionId}, ${only.origin ?? 'origin NULL'}), which the reconciler adopted ${only.deltaSec} s after this submission; this row never promoted and is ended as its duplicate`,
          evidence: { match, fill: only, rule: 'R5' },
        }, nowMs))()
        out.settledDuplicate++; writes++
        continue
      }
      if (only && !contested && only.via === 'broker_deal') {
        let ok = false
        db.transaction(() => {
          ok = settleFromDeals(db, row, only)
          if (ok) {
            insertResolution(db, {
              ...base, positionId: only.positionId, outcome: 'settled', verdict: 'filled and closed per broker deal',
              reason: `broker deal(s) ${only.dealIds.join(', ')} open position ${only.positionId} ${only.deltaSec} s after this submission on the same account, symbol and side, and no ledger row carried it: the row now reads that closed trade`,
              evidence: { match, fill: only, rule: 'R2' },
            }, nowMs)
          }
        })()
        if (ok) { out.settledFromDeal++; writes++; continue }
      }
      if (ageMs < WRITE_OFF_AGE_MS) { out.waiting++; continue }
      const ambiguous = strong.length + weak.length > 0
      db.transaction(() => insertResolution(db, {
        ...base, outcome: 'unresolved', verdict: ambiguous ? UNRESOLVED_AMBIGUOUS : UNRESOLVED_NO_EVIDENCE,
        reason: unscoped
          ? `${row.status} since ${String(row.opened_at ?? 'an unknown time')}: the row carries no account, time, side or symbol to scope broker evidence by`
          : ambiguous
            ? `${row.status} since ${row.opened_at}: ${strong.length + weak.length} broker fill(s) could be this submission's and none can be tied to it alone (contested, several, or a deal with no opening time) — excluded from P&L, shown as a notice`
            : `${row.status} since ${row.opened_at}: no broker deal, no adopted position and no ledger row on ${tail(row.account_id)} ${row.symbol} ${row.side} within the fill window after ${Math.round(ageMs / HOUR)} h — excluded from P&L, shown as a notice`,
        evidence: { match, candidates: [...strong, ...weak], checked: ['broker_deals', 'trades (reconciler-adopted rows)'], rule: 'R2' },
      }, nowMs))()
      out.writtenOff++; writes++
    } catch (err) {
      out.errors.push(`${subject}: ${String(err?.message || err).slice(0, 160)}`)
    }
  }
  return out
}

// ================================================================ R1
/**
 * Every intent tag a trade or position label carries, read ONCE per pass
 * (trades and monitored_positions are each under 1 MB): tag → carriers.
 */
export function tagCarriers(db) {
  const map = new Map()
  const add = (kind, r) => {
    const t = tagOf(r.label_raw)
    if (!t) return
    const l = map.get(t) || []
    l.push({ kind, id: r.id, symbol: r.symbol ?? null, account: acctOf(r.account_id) })
    map.set(t, l)
  }
  for (const r of db.prepare(`SELECT id, symbol, account_id, label_raw FROM trades WHERE label_raw IS NOT NULL LIMIT 200000`).all()) add('trade', r)
  for (const r of db.prepare(`SELECT id, symbol, account_id, label_raw FROM monitored_positions WHERE label_raw IS NOT NULL LIMIT 200000`).all()) add('position', r)
  return map
}

/** The trade or position carrying the intent that placed this resting order (the tag the broker echoes on a fill's label). */
export function restingFillEvidence(db, row, carriersByTag = tagCarriers(db)) {
  const acct = acctOf(row.account_id)
  let intents = []
  let via = 'broker_order_id'
  if (row.order_id != null) {
    intents = db.prepare(`SELECT id FROM entry_intents WHERE broker_order_id = ? AND (account_id = ? OR ? IS NULL) LIMIT 5`).all(String(row.order_id), acct, acct)
  } else {
    // No broker order id: the limit intent on the same account and side
    // created within 5 s of the placement (order-lifecycle fillForPending).
    const placed = tsMs(row.placed_at)
    const side = Number(row.dir) > 0 ? 'BUY' : Number(row.dir) < 0 ? 'SELL' : null
    if (placed != null && side != null && acct != null) {
      intents = db.prepare(`SELECT id, created_at FROM entry_intents WHERE account_id = ? AND UPPER(side) = ? AND UPPER(COALESCE(order_type, '')) <> 'MARKET' LIMIT 500`).all(acct, side)
        .filter(i => Math.abs((tsMs(i.created_at) ?? Infinity) - placed) <= 5_000)
      via = 'placement_time'
    }
  }
  for (const i of intents) {
    const c = (carriersByTag.get(i.id) || []).find(x => (acct == null || x.account == null || x.account === acct)
      && (!x.symbol || !row.symbol || upper(x.symbol) === upper(row.symbol)))
    if (c) return { intent: i.id, carrier: `${c.kind} ${c.id}`, tradeId: c.kind === 'trade' ? c.id : null, via }
  }
  return null
}

export function resolveRestingOrders(db, { nowMs = Date.now(), maxWrites = MAX_WRITES_PER_KIND } = {}) {
  const out = { examined: 0, filled: 0, expired: 0, rejudged: 0, writtenOff: 0, stillWorkingAtBroker: 0, waiting: 0, errors: [] }
  const note = (db2, id, text, status, from) => db2.prepare(
    `UPDATE pending_orders SET status = ?, note = TRIM(COALESCE(note, '') || ' · ' || ?) WHERE id = ? AND status = ?`,
  ).run(status, text, id, from).changes
  let writes = 0
  let carriers = null
  const fillOf = row => restingFillEvidence(db, row, carriers ??= tagCarriers(db))
  // ---- working rows the retired pending-fib manager left (R1). A
  // 'pending-closed' row has its own resolver (closed-market-limits.js:84);
  // two resolvers on one row would race.
  const rows = db.prepare(`
    SELECT id, account_id, symbol, dir, order_id, note, placed_at, expires_at, status FROM pending_orders
     WHERE status = 'working' AND COALESCE(note, '') <> 'pending-closed'
       AND NOT EXISTS (SELECT 1 FROM stuck_resolutions sr WHERE sr.subject = 'pending:' || pending_orders.id)
     ORDER BY id LIMIT ?`).all(READ_LIMIT)
  for (const row of rows) {
    if (writes >= maxWrites) break
    const subject = subjectFor.pending(row.id)
    try {
      const fill = fillOf(row)
      const order = row.order_id != null ? db.prepare(`SELECT order_id, status, gone_at, last_seen FROM broker_orders WHERE order_id = ?`).get(String(row.order_id)) : null
      const expires = tsMs(row.expires_at), placed = tsMs(row.placed_at)
      const stuck = fill || (expires != null && expires < nowMs - 10 * MIN) || order?.status === 'gone' || (!order && placed != null && placed < nowMs - HOUR)
      if (!stuck) continue
      out.examined++
      const base = { subject, kind: 'resting_order', ruleId: 'STK-01', accountId: acctOf(row.account_id), tradeId: fill?.tradeId ?? null, priorState: row.status }
      const evidence = { order: order ?? null, orderId: row.order_id ?? null, note: row.note ?? null, placedAt: row.placed_at, expiresAt: row.expires_at, rule: 'R1' }
      if (fill) {
        db.transaction(() => {
          if (note(db, row.id, `filled: ${fill.carrier} carries intent ${fill.intent} (stuck resolver)`, 'filled', 'working') !== 1) return
          insertResolution(db, { ...base, outcome: 'settled', verdict: 'filled', reason: `${fill.carrier} carries intent ${fill.intent}, which placed this order (${fill.via})`, evidence: { ...evidence, fill } }, nowMs)
          out.filled++; writes++
        })()
        continue
      }
      if (order?.status === 'working') { out.stillWorkingAtBroker++; continue } // live at the broker: nothing to settle, never cancelled here
      if (order?.status === 'gone') {
        db.transaction(() => {
          if (note(db, row.id, `gone at broker ${order.gone_at ?? '(time not recorded)'}; no fill carries its intent — expired or cancelled, the cause is not recorded (stuck resolver)`, 'expired', 'working') !== 1) return
          insertResolution(db, { ...base, outcome: 'settled', verdict: 'expired (gone at broker, no fill)', reason: `order ${row.order_id} left the broker's book ${order.gone_at ?? ''} and no trade or position carries the intent that placed it`, evidence }, nowMs)
          out.expired++; writes++
        })()
        continue
      }
      // No broker record at all: absence is not evidence of death
      // (closed-market-limits.js:99-111) — past its age bound it is written off.
      const begun = Math.max(placed ?? -Infinity, expires ?? -Infinity)
      if (!(begun < nowMs - WRITE_OFF_AGE_MS)) { out.waiting++; continue }
      db.transaction(() => {
        if (note(db, row.id, `${UNRESOLVED_NO_EVIDENCE} (stuck resolver)`, 'unresolved', 'working') !== 1) return
        insertResolution(db, { ...base, outcome: 'unresolved', verdict: UNRESOLVED_NO_EVIDENCE,
          reason: `order ${row.order_id ?? '(no id returned)'} has no broker_orders record and no fill carries an intent for it; placed ${row.placed_at}, expiry ${row.expires_at ?? 'none'} — no longer counted as resting, shown as a notice`, evidence }, nowMs)
        out.writtenOff++; writes++
      })()
    } catch (err) {
      out.errors.push(`${subject}: ${String(err?.message || err).slice(0, 160)}`)
    }
  }
  // ---- terminal rows stored against their fill (ORD-10; R1 "re-judge the
  // wrong 'expired' rows with the same evidence"). Only the broker order id
  // ties a row to its intent here — a strong link or nothing.
  const terminal = db.prepare(`
    SELECT id, account_id, symbol, dir, order_id, note, placed_at, status FROM pending_orders
     WHERE status IN ('expired', 'cancelled') AND order_id IS NOT NULL AND placed_at >= ?
       AND NOT EXISTS (SELECT 1 FROM stuck_resolutions sr WHERE sr.subject = 'pending:' || pending_orders.id)
     ORDER BY id LIMIT ?`).all(spaceTs(nowMs - 31 * DAY), READ_LIMIT)
  for (const row of terminal) {
    if (writes >= maxWrites) break
    try {
      const fill = fillOf(row)
      if (!fill) continue
      db.transaction(() => {
        if (note(db, row.id, `re-judged: ${fill.carrier} carries intent ${fill.intent} — was '${row.status}' (stuck resolver)`, 'filled', row.status) !== 1) return
        insertResolution(db, { subject: subjectFor.pending(row.id), kind: 'resting_order', ruleId: 'ORD-10', accountId: acctOf(row.account_id), tradeId: fill.tradeId,
          outcome: 'settled', verdict: 'filled', priorState: row.status,
          reason: `stored '${row.status}' but ${fill.carrier} carries intent ${fill.intent}, which placed order ${row.order_id}`,
          evidence: { orderId: row.order_id, note: row.note ?? null, fill, rule: 'R1' } }, nowMs)
        out.rejudged++; writes++
      })()
    } catch (err) {
      out.errors.push(`pending:${row.id}: ${String(err?.message || err).slice(0, 160)}`)
    }
  }
  return out
}

// ================================================================ R6
/** The fields a gave_up capture named as missing (position-capture.js last_error "missing: a, b, c"). */
export function missingFieldsOf(lastError) {
  const m = /missing:\s*([a-z0-9_,\s]+)/i.exec(String(lastError ?? ''))
  return m ? m[1].split(',').map(s => s.trim()).filter(Boolean) : null
}

/** Which of the missing fields now exist upstream of the record builder (position-history.js buildRecord's sources). */
function upstreamFields(db, acct, pid, fields) {
  const trades = db.prepare(`SELECT id, side, origin, risk_event_id, strategy, label_strategy, proposal_entry_price, sl_price FROM trades
                              WHERE account_id = ? AND CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER) LIMIT 10`).all(acct, pid)
  const plans = trades.map(t => db.prepare(`SELECT planned_entry, planned_sl, risk_dist FROM trade_plans WHERE trade_id = ?`).get(t.id) || {})
  const deals = db.prepare(`SELECT lots, entry_price, close_price, gross_pnl, commission, swap, net_pnl, opened_at, closed_at FROM broker_deals
                             WHERE account_id = ? AND CAST(position_id AS INTEGER) = CAST(? AS INTEGER) LIMIT 20`).all(acct, pid)
  const anyTrade = f => trades.some((t, i) => f(t, plans[i]))
  const entryOf = (t, p) => num(p.planned_entry) ?? num(t.proposal_entry_price)
  const slOf = (t, p) => num(p.planned_sl) ?? num(t.sl_price)
  const check = {
    direction_reason: () => anyTrade(t => directionReasonFor(db, t.risk_event_id) != null),
    planned_entry: () => anyTrade((t, p) => entryOf(t, p) != null),
    planned_sl: () => anyTrade((t, p) => slOf(t, p) != null),
    risk_dist: () => anyTrade((t, p) => num(p.risk_dist) != null || (entryOf(t, p) != null && slOf(t, p) != null)),
    strategy: () => anyTrade(t => !blank(t.strategy) || !blank(t.label_strategy)),
    direction: () => anyTrade(t => dirOf(t.side) != null),
    origin: () => anyTrade(t => !blank(t.origin)),
    volume: () => deals.some(d => num(d.lots) != null),
    entry_price: () => deals.some(d => num(d.entry_price) != null),
    exit_price: () => deals.some(d => num(d.close_price) != null),
    gross_pnl: () => deals.some(d => num(d.gross_pnl) != null),
    commission: () => deals.some(d => num(d.commission) != null),
    swap: () => deals.some(d => num(d.swap) != null),
    net_pnl: () => deals.some(d => num(d.net_pnl) != null),
    closed_at_ms: () => deals.some(d => tsMs(d.closed_at) != null),
    opened_at_ms: () => deals.some(d => tsMs(d.opened_at) != null),
  }
  const have = [], absent = [], uncheckable = []
  for (const f of fields) {
    if (!check[f]) { uncheckable.push(f); continue }
    if (check[f]()) have.push(f); else absent.push(f)
  }
  return { have, absent, uncheckable, trades: trades.map(t => t.id) }
}

export function resolveCaptures(db, { nowMs = Date.now(), maxWrites = MAX_WRITES_PER_KIND } = {}) {
  const out = { examined: 0, requeued: 0, writtenOff: 0, errors: [] }
  const rows = db.prepare(`SELECT account_id, position_id, symbol, last_error, attempts, settled_at FROM position_capture_queue
                            WHERE state = 'gave_up' ORDER BY settled_at LIMIT ?`).all(READ_LIMIT)
  let writes = 0
  for (const row of rows) {
    if (writes >= maxWrites) break
    const acct = acctOf(row.account_id)
    const subject = subjectFor.capture(acct, row.position_id)
    try {
      const prior = resolutionOf(db, subject)
      if (prior?.outcome === 'unresolved') continue
      out.examined++
      const fields = missingFieldsOf(row.last_error)
      if (prior) {
        // Re-queued once and gave up again: bounded — written off now.
        db.transaction(() => {
          db.prepare(`UPDATE stuck_resolutions SET outcome = 'unresolved', verdict = ?, reason = ?, evidence_json = ?, resolved_at = ?, resolver_version = ? WHERE subject = ? AND outcome = 'settled'`)
            .run(fields ? UNRESOLVED_NO_RECORD : UNRESOLVED_NO_EVIDENCE,
              `re-queued once (${prior.resolved_at}) and gave up again: ${String(row.last_error ?? '').slice(0, 200)} — the position record stays refused, shown as a notice`,
              JSON.stringify({ ...(parseJson(prior.evidence_json) || {}), secondGiveUp: { lastError: row.last_error, settledAt: row.settled_at } }), iso(nowMs), RESOLVER_VERSION, subject)
        })()
        out.writtenOff++; writes++
        continue
      }
      const base = { subject, kind: 'capture', ruleId: 'STK-06', accountId: acct, positionId: String(row.position_id), priorState: 'gave_up' }
      const up = fields ? upstreamFields(db, acct, row.position_id, fields) : null
      const requeue = !fields || (up.absent.length === 0 && up.uncheckable.length === 0)
      if (requeue) {
        db.transaction(() => {
          const n = db.prepare(`UPDATE position_capture_queue SET state = 'pending', attempts = 0, due_at_ms = ?, settled_at = NULL,
                                  last_error = ? WHERE account_id = ? AND position_id = ? AND state = 'gave_up'`)
            .run(nowMs, `re-queued once by the stuck resolver: ${String(row.last_error ?? '').slice(0, 200)}`, row.account_id, row.position_id).changes
          if (n !== 1) return
          insertResolution(db, { ...base, outcome: 'settled', verdict: 'requeued',
            reason: fields ? `every field the capture lacked now exists upstream (${fields.join(', ')}): re-queued once` : `gave up with no field list (${String(row.last_error ?? '').slice(0, 120)}): re-queued once in case the cause was transient`,
            evidence: { lastError: row.last_error, attempts: row.attempts, upstream: up, rule: 'R6' } }, nowMs)
          out.requeued++; writes++
        })()
        continue
      }
      db.transaction(() => insertResolution(db, { ...base, outcome: 'unresolved', verdict: UNRESOLVED_NO_RECORD,
        reason: `the position record lacks ${[...up.absent, ...up.uncheckable].join(', ')} and no upstream record carries ${up.absent.length ? up.absent.join(', ') : 'them'}${up.uncheckable.length ? ` (${up.uncheckable.join(', ')} not checkable here)` : ''} — re-queueing would give up again; shown as a notice`,
        evidence: { lastError: row.last_error, attempts: row.attempts, upstream: up, rule: 'R6' } }, nowMs))()
      out.writtenOff++; writes++
    } catch (err) {
      out.errors.push(`${subject}: ${String(err?.message || err).slice(0, 160)}`)
    }
  }
  return out
}

// ================================================================ R7
/** The targetless positions STK-09 counts: POSITION_NO_TARGET rows for one open position spanning > 2 h, the newest still recent. */
export function targetlessPositions(db, nowMs) {
  const rows = db.prepare(`SELECT id, at, body FROM action_log
     WHERE id > (SELECT COALESCE(MAX(id), 0) FROM action_log) - ${ACTION_LOG_WINDOW_IDS} AND method = 'POSITION_NO_TARGET' ORDER BY id LIMIT ?`).all(ACTION_LOG_WINDOW_IDS)
  const by = new Map()
  for (const r of rows) {
    const b = parseJson(r.body) || {}
    const pid = b.positionId ?? b.position_id
    if (pid == null) continue
    const g = by.get(String(pid)) || { positionId: String(pid), accountId: acctOf(b.accountId ?? b.account_id), first: Infinity, last: -Infinity, n: 0 }
    const t = tsMs(r.at)
    if (t != null) { g.first = Math.min(g.first, t); g.last = Math.max(g.last, t) }
    g.n++
    by.set(String(pid), g)
  }
  return [...by.values()].filter(g => g.last - g.first > 2 * HOUR && g.last >= nowMs - (2 * LOG_MUTE_MS + 10 * MIN))
}

/** The target the bot recorded for this trade, in price units and on the right side of the entry, or null. */
export function recordedTargetEvidence(db, trade) {
  const entry = num(trade.entry_price)
  const dir = dirOf(trade.side)
  const tried = []
  const valid = (tp, source) => {
    const v = num(tp)
    if (v == null || !(v > 0)) { tried.push({ source, tp: tp ?? null, ok: false, why: 'absent' }); return null }
    if (entry == null || !(entry > 0) || dir == null) { tried.push({ source, tp: v, ok: false, why: 'no entry or side to check it against' }); return null }
    if (dir > 0 ? !(v > entry) : !(v < entry)) { tried.push({ source, tp: v, ok: false, why: `wrong side of the ${entry} entry` }); return null }
    if (Math.abs(v - entry) / entry > ABSURD_DISTANCE_FRACTION) { tried.push({ source, tp: v, ok: false, why: 'not in price units (further than half the entry)' }); return null }
    tried.push({ source, tp: v, ok: true })
    return { tp: v, source }
  }
  // 1. the approval the trade was placed under
  const p = trade.risk_event_id == null ? null
    : parseJson(db.prepare(`SELECT proposal_json FROM risk_events WHERE id = ?`).get(Number(trade.risk_event_id))?.proposal_json)
  let hit = valid(p?.tp1 ?? p?.tp ?? null, `risk_events #${trade.risk_event_id} proposal tp1`)
  // 2. the resting order that filled into it (the tag on the fill's label → the intent → the order it placed)
  if (!hit) {
    const tag = tagOf(trade.label_raw)
    const order = tag ? db.prepare(`SELECT broker_order_id FROM entry_intents WHERE id = ?`).get(tag)?.broker_order_id : null
    const pend = order != null ? db.prepare(`SELECT id, tp FROM pending_orders WHERE order_id = ? AND (account_id = ? OR account_id IS NULL) ORDER BY id DESC LIMIT 1`).get(String(order), acctOf(trade.account_id)) : null
    hit = valid(pend?.tp ?? null, pend ? `pending_orders #${pend.id} tp (order ${order}, intent ${tag})` : `pending order for intent ${tag ?? '(no tag)'}`)
  }
  // 3. the trade's plan
  if (!hit) {
    const plan = db.prepare(`SELECT planned_tp FROM trade_plans WHERE trade_id = ?`).get(trade.id)
    hit = valid(plan?.planned_tp ?? null, 'trade_plans planned_tp')
  }
  return { hit, tried }
}

export function resolveTargetless(db, { nowMs = Date.now(), maxWrites = MAX_WRITES_PER_KIND } = {}) {
  const out = { examined: 0, targetRecorded: 0, writtenOff: 0, recordedAlready: 0, errors: [] }
  let writes = 0
  for (const g of targetlessPositions(db, nowMs)) {
    if (writes >= maxWrites) break
    try {
      const trade = db.prepare(`SELECT id, account_id, symbol, side, entry_price, tp_price, risk_event_id, label_raw FROM trades
                                  WHERE status = 'open' AND CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER)
                                    AND (? IS NULL OR account_id = ?) ORDER BY id LIMIT 1`).get(g.positionId, g.accountId, g.accountId)
      if (!trade) continue
      const acct = acctOf(trade.account_id)
      const subject = subjectFor.target(acct, g.positionId)
      if (resolutionOf(db, subject)) continue
      out.examined++
      // A target on the row already: the record is whole — the gap is at the
      // broker (target-restore refused or does not own it), which a record
      // write cannot settle. Left to STK-09 and the owner.
      if (num(trade.tp_price) > 0) { out.recordedAlready++; continue }
      const base = { subject, kind: 'targetless', ruleId: 'STK-09', accountId: acct, tradeId: trade.id, positionId: g.positionId, priorState: 'tp_price NULL' }
      const { hit, tried } = recordedTargetEvidence(db, trade)
      const seen = { rows: g.n, since: iso(g.first), newest: iso(g.last) }
      if (hit) {
        db.transaction(() => {
          if (db.prepare(`UPDATE trades SET tp_price = ? WHERE id = ? AND tp_price IS NULL`).run(hit.tp, trade.id).changes !== 1) return
          insertResolution(db, { ...base, outcome: 'settled', verdict: 'target recorded',
            reason: `trade #${trade.id} had no target on record; the bot recorded ${hit.tp} for it in ${hit.source} — written to trades.tp_price, where target-restore reads the recorded target (its own switch and checks apply; nothing is sent from here)`,
            evidence: { seen, tried, rule: 'R7' } }, nowMs)
          out.targetRecorded++; writes++
        })()
        continue
      }
      db.transaction(() => insertResolution(db, { ...base, outcome: 'unresolved', verdict: UNRESOLVED_NO_TARGET,
        reason: `position ${g.positionId} (${trade.symbol}, trade #${trade.id}) has had no take profit for ${Math.round((g.last - g.first) / HOUR)} h and no record anywhere holds one in price units on the right side of the entry — nothing can be restored; shown as a notice`,
        evidence: { seen, tried, rule: 'R7' } }, nowMs))()
      out.writtenOff++; writes++
    } catch (err) {
      out.errors.push(`position ${g.positionId}: ${String(err?.message || err).slice(0, 160)}`)
    }
  }
  return out
}

// ================================================================ the pass
/**
 * One resolver pass over every kind. Never throws: each kind's failure is
 * recorded in its own result, so one unreadable table cannot stop the others
 * (and never reads as "nothing stuck").
 */
export function runStuckResolver(db, { nowMs = Date.now(), maxWrites = MAX_WRITES_PER_KIND } = {}) {
  const res = { at: iso(nowMs), version: RESOLVER_VERSION, ok: true }
  const kinds = { trades: resolveInflightTrades, resting: resolveRestingOrders, captures: resolveCaptures, targetless: resolveTargetless }
  for (const [k, fn] of Object.entries(kinds)) {
    try { res[k] = fn(db, { nowMs, maxWrites }) } catch (err) { res[k] = { error: String(err?.message || err).slice(0, 200) }; res.ok = false }
    if (res[k]?.errors?.length) res.ok = false
  }
  return res
}
