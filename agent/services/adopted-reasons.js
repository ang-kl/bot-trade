// ---------------------------------------------------------------------------
// agent/services/adopted-reasons.js — a bot fill the reconciler adopted gets
// its reason back, from EVIDENCE only (V3 B4c; owner principle 4: every trade
// has a reason; principle 6: no fake result).
//
// MEASURED, production 26-09-2026 01:10 UTC, after B4 deployed:
// /state/goal-table trade_reasons 254, of which 106 `adopted_ours_unreasoned`
// — positions wearing OUR label (PRE|v1|VP|HI|NYC|15m|-, AP|v1|DON|…) whose
// trade row carries no strategy, plan or approval id.
//
// WHY THEY LOST THEIR REASON (read from the code, file:line on 77da158):
//   · reconciler.js reconcilePositions, the adoption INSERT: the label's
//     strategy goes to `label_strategy`, never to `strategy`, the origin is
//     `reconciler_adopted`, and no approval or plan is linked. The only
//     writer that could supply them is stampAdoptedFromIntent, and it runs
//     only for a label carrying an entry-intent tag `|i<id>`.
//   · The tag exists only since P2a (#881, 11-09-2026 01:06 UTC) and the
//     stamp only since PR-E (#898, 11-09-2026 14:40:58 UTC). Every earlier
//     adoption had no link at all; four fills adopted between the two
//     (#1577, #1585–#1587) carry a tag whose intent was never read.
//   · Pre-open limits (source PRE, closed-market-limits.js) were adopted as
//     `external` until isOurs learned PRE (29-08-2026), and the closed-market
//     sweep then linked a fill to its resting row by "the first trade on this
//     symbol since placement" — stamping the approval id (and, from 09-09,
//     a plan) but never the strategy or the origin. L2a (#1114) replaced that
//     heuristic with evidence, for rows still working; the settled rows were
//     never revisited.
//
// WHAT THIS DOES. For one trade row: the fields that are EMPTY and that a
// deterministic record names are filled, each written once and each with
// its evidence in `trade_reason_evidence`:
//
//   strategy       our own encoder's code in the label (lib/trade-labels.js
//                  STRATEGIES), or, for a label with no strategy field, the
//                  producer of the matched intent (the tick firer)
//   intent_id      the label's tag, the trade's own intent_id, or the one
//                  intent whose broker_position_id is this position — on this
//                  account, from an automatic producer, on this side, holding
//                  no other trade, and naming this position when it recorded
//                  one
//   origin         only with such an intent: bot_market_dispatch for a market
//                  order, bot_pending_fill otherwise (stampAdoptedFromIntent's
//                  own rule); never from the label alone
//   risk_event_id  the matched intent's approval, else the resting order row
//                  that placed the intent's broker order on this account
//                  (pending_orders: its approval recorded at placement), else
//                  the one approval every clean bot row for this same broker
//                  position on this account carries — each checked against
//                  the risk event itself (approved, same account, side and
//                  symbol)
//
// WHAT THIS NEVER DOES: invent a plan (none is written here), invent or
// guess an approval id (no time window, no "nearest" event), overwrite a
// value already on the row, promote an origin on the label alone (label
// evidence names a strategy, not a decision — lib/trade-origin.js), or
// delete anything. An approval a deterministic record contradicts is not
// replaced; the disagreement is recorded as its own evidence row. A row left
// incomplete stays counted in trade_reasons, and says why.
//
// Idempotent: every write is COALESCE / "only when still adopted", and a
// second pass over the same rows finds nothing left to write.
// ---------------------------------------------------------------------------

import { isOurs, parseLabel, labelIntentId } from '../lib/trade-labels.js'
import { CLEAN_BOT_ORIGINS } from '../lib/trade-origin.js'
import { ENTRY_PRODUCERS } from '../lib/entry-producers.js'
import { normPosId } from '../lib/pos-id.js'

// PRODUCER → STRATEGY, for a label that carries no strategy field of its own
// (20-09-2026, moved here from reconciler.js unchanged). The sidecar's tick
// firer writes `tick:<profileHash>|…|i<id>`: field 2 is empty, so
// parseLabel().strategy is null. The intent row names the producer, and the
// producer names exactly one strategy, so the fact is recoverable.
// `parsed.strategy` still wins wherever the label has one.
export const PRODUCER_STRATEGY = Object.freeze({
  tick_momentum: 'tick_momentum_breakout',
})

/** Where each recovered value came from — the vocabulary of trade_reason_evidence.evidence. */
export const REASON_EVIDENCE = Object.freeze({
  label: "our own encoder's strategy code in the broker label (lib/trade-labels.js STRATEGIES)",
  intent_producer: 'the matched entry intent\'s producer, which names exactly one strategy',
  intent_tag: 'the |i<id> tag on the broker label names an entry intent on this account, automatic producer, same side, holding no other trade',
  trade_intent: 'the trade row\'s own intent_id names an entry intent on this account, automatic producer, same side',
  intent_position: 'the entry ledger recorded this broker position id on this account (entry_intents.broker_position_id), one intent only',
  intent_approval: 'the approval the matched entry intent was reserved under (entry_intents.risk_event_id)',
  resting_row: 'the resting order row that placed the matched intent\'s broker order on this account (pending_orders, approval recorded at placement)',
  sibling_trade: 'the one approval every clean bot row for this same broker position on this account carries',
})

/** What the fields left empty are waiting on — why they are NOT recovered. */
export const UNRECOVERABLE = Object.freeze({
  plan: 'no plan was recorded when the fill was adopted, and none is invented after the fact',
  'approval id': 'no entry intent, resting order row or same-position bot row names the approval — and none is guessed from a time window',
  strategy: 'the label carries no strategy code this encoder knows, and no matched intent names one',
})

export function ensureReasonEvidenceTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS trade_reason_evidence (
    trade_id     INTEGER NOT NULL,
    field        TEXT NOT NULL,      -- strategy | intent_id | origin | risk_event_id | risk_event_id_conflict
    before_value TEXT,
    value        TEXT NOT NULL,
    evidence     TEXT NOT NULL,      -- a REASON_EVIDENCE key
    detail       TEXT,
    writer       TEXT NOT NULL,      -- adoption | backfill
    at           TEXT NOT NULL,
    PRIMARY KEY (trade_id, field)
  )`)
}

const sideWord = (v) => {
  const u = String(v ?? '').trim().toUpperCase()
  return u === 'BUY' || u === 'LONG' ? 'BUY' : u === 'SELL' || u === 'SHORT' ? 'SELL' : null
}
const up = (v) => String(v ?? '').trim().toUpperCase()
const blank = (v) => v == null || String(v).trim() === ''
const automatic = (producerId) => {
  const p = ENTRY_PRODUCERS.find(x => x.id === String(producerId || ''))
  return !!p && p.family === 'automatic'
}

/**
 * The entry intent a trade row came from, or why none is accepted. Every
 * check is a fact on record; a failed check is a refusal with its reason,
 * never a weaker match.
 */
export function matchTradeIntent(db, t) {
  const acct = t.account_id != null ? String(t.account_id) : null
  if (acct == null) return { intent: null, why: 'the trade row names no account' }
  const tag = labelIntentId(String(t.label_raw || ''))
  const stored = blank(t.intent_id) ? null : String(t.intent_id)
  if (tag && stored && tag !== stored) return { intent: null, why: `the label's tag ${tag} and the row's intent_id ${stored} disagree` }
  let it = null, via = null
  const id = stored || tag
  const pid = normPosId(t.ctrader_position_id)
  try {
    if (id) {
      it = db.prepare('SELECT * FROM entry_intents WHERE id = ?').get(id) || null
      via = stored ? 'trade_intent' : 'intent_tag'
      if (!it) return { intent: null, why: `intent ${id} is not in the entry ledger` }
    } else {
      if (pid == null) return { intent: null, why: 'no intent tag and no broker position id' }
      const rows = db.prepare('SELECT * FROM entry_intents WHERE account_id = ? AND broker_position_id IN (?, ?)').all(acct, pid, `${pid}.0`)
      if (rows.length === 0) return { intent: null, why: 'no intent tag, and the entry ledger recorded no intent for this position' }
      if (rows.length > 1) return { intent: null, why: `${rows.length} intents recorded this position — ambiguous` }
      it = rows[0]
      via = 'intent_position'
    }
  } catch (err) {
    return { intent: null, why: `entry ledger unreadable: ${String(err?.message || err).slice(0, 80)}` }
  }
  if (String(it.account_id) !== acct) return { intent: null, why: `intent ${it.id} is on another account` }
  if (!automatic(it.producer_id)) return { intent: null, why: `intent ${it.id} was not placed by an automatic producer (${it.producer_id ?? '?'})` }
  const ts = sideWord(t.side), is = sideWord(it.side)
  if (ts && is && ts !== is) return { intent: null, why: `intent ${it.id} is ${is}, the trade ${ts}` }
  const ip = normPosId(it.broker_position_id)
  if (ip != null && pid != null && ip !== pid) return { intent: null, why: `intent ${it.id} recorded position ${ip}, the trade holds ${pid}` }
  try {
    const other = db.prepare(`SELECT id FROM trades WHERE intent_id = ? AND id <> ? AND status IN ('open', 'closed') LIMIT 1`).get(String(it.id), t.id)
    if (other) return { intent: null, why: `intent ${it.id} already belongs to trade #${other.id}` }
  } catch { /* the check is a guard; an unreadable guard refuses */ return { intent: null, why: 'intent ownership unreadable' } }
  return { intent: it, via }
}

/** A risk event usable as this trade's approval: approved, and not contradicting the trade. */
function approvalRow(db, id, t) {
  if (id == null) return null
  let ev = null
  try { ev = db.prepare('SELECT id, approved, account_id, symbol, side FROM risk_events WHERE id = ?').get(Number(id)) } catch { ev = null }
  if (!ev || Number(ev.approved) !== 1) return null
  if (ev.account_id != null && t.account_id != null && String(ev.account_id) !== String(t.account_id)) return null
  const es = sideWord(ev.side), ts = sideWord(t.side)
  if (es && ts && es !== ts) return null
  if (!blank(ev.symbol) && !blank(t.symbol) && up(ev.symbol) !== up(t.symbol)) return null
  return ev
}

/**
 * The approval a deterministic record names for this trade, strongest
 * first, or null. Never a time window, never "the nearest event".
 */
export function evidencedApproval(db, t, intent) {
  if (intent) {
    const own = approvalRow(db, intent.risk_event_id, t)
    if (own) return { id: own.id, evidence: 'intent_approval', detail: `intent ${intent.id}` }
    try {
      const rows = db.prepare(`SELECT id, risk_event_id, symbol, dir FROM pending_orders
                                WHERE account_id = ? AND (intent_id = ? OR (? IS NOT NULL AND order_id = ?))`)
        .all(String(t.account_id), String(intent.id), intent.broker_order_id ?? null, intent.broker_order_id != null ? String(intent.broker_order_id) : null)
      const ts = sideWord(t.side)
      const fit = rows.filter(r => r.risk_event_id != null && (blank(r.symbol) || up(r.symbol) === up(t.symbol))
        && (ts == null || Number(r.dir) === 0 || r.dir == null || (Number(r.dir) > 0 ? 'BUY' : 'SELL') === ts))
      const ids = [...new Set(fit.map(r => Number(r.risk_event_id)))]
      if (ids.length === 1) {
        const ev = approvalRow(db, ids[0], t)
        if (ev) return { id: ev.id, evidence: 'resting_row', detail: `pending order row #${fit[0].id} (intent ${intent.id}${intent.broker_order_id ? `, order ${intent.broker_order_id}` : ''})` }
      }
    } catch { /* no resting row is readable: fall through to the next record */ }
  }
  const pid = normPosId(t.ctrader_position_id)
  if (pid != null && t.account_id != null) {
    try {
      const clean = CLEAN_BOT_ORIGINS.map(() => '?').join(',')
      const sib = db.prepare(`SELECT id, risk_event_id FROM trades
                               WHERE ctrader_position_id IN (?, ?) AND account_id = ? AND id <> ? AND origin IN (${clean})`)
        .all(pid, `${pid}.0`, String(t.account_id), t.id, ...CLEAN_BOT_ORIGINS)
      const ids = [...new Set(sib.map(s => s.risk_event_id))]
      if (sib.length > 0 && ids.length === 1 && ids[0] != null) {
        const ev = approvalRow(db, ids[0], t)
        if (ev) return { id: ev.id, evidence: 'sibling_trade', detail: `trade #${sib.map(s => s.id).join(', #')} holds position ${pid} on this account` }
      }
    } catch { /* no sibling readable */ }
  }
  return null
}

const TRADE_COLUMNS = 'id, account_id, symbol, side, status, origin, origin_source, label_raw, strategy, label_strategy, risk_event_id, intent_id, ctrader_position_id, opened_at'

/**
 * Recover what evidence can give back to one trade row, and write it.
 *
 * In scope: a `reconciler_adopted` row whose label is ours (or whose intent
 * matches), and a clean bot row with no approval id. Anything else is
 * returned untouched. Never throws: a failure is returned as `error` and
 * writes nothing (one transaction).
 *
 * @returns {{ tradeId, inScope, wrote: Record<string,{value,evidence,detail}>, conflicts: Array, stillMissing: string[], why: Record<string,string>, error?: string }}
 */
export function recoverTradeReason(db, tradeId, { writer = 'backfill', at = new Date().toISOString() } = {}) {
  const out = { tradeId, inScope: false, wrote: {}, conflicts: [], stillMissing: [], why: {} }
  let t = null
  try { t = db.prepare(`SELECT ${TRADE_COLUMNS} FROM trades WHERE id = ?`).get(tradeId) } catch (err) { return { ...out, error: String(err?.message || err) } }
  if (!t || !['open', 'closed'].includes(String(t.status))) return out
  const adopted = t.origin === 'reconciler_adopted'
  const clean = CLEAN_BOT_ORIGINS.includes(String(t.origin))
  let labelOurs = false
  try { labelOurs = isOurs(String(t.label_raw || '')) } catch { labelOurs = false }
  const m = (adopted || clean) ? matchTradeIntent(db, t) : { intent: null, why: 'not a bot or adopted row' }
  const intent = m.intent
  if (!(adopted && (labelOurs || intent)) && !(clean && t.risk_event_id == null)) return out
  out.inScope = true

  const plan = {}
  // STRATEGY: the label's own code (not 'other'), else the intent's producer.
  if (blank(t.strategy)) {
    let parsed = null
    try { parsed = parseLabel(String(t.label_raw || '')) } catch { parsed = null }
    const code = parsed?.strategy && parsed.strategy !== 'other' ? parsed.strategy : null
    if (code && (labelOurs || intent)) plan.strategy = { value: code, evidence: 'label', detail: String(t.label_raw).slice(0, 90) }
    else if (intent && PRODUCER_STRATEGY[String(intent.producer_id || '')]) plan.strategy = { value: PRODUCER_STRATEGY[String(intent.producer_id)], evidence: 'intent_producer', detail: `intent ${intent.id} (${intent.producer_id})` }
  }
  if (intent && blank(t.intent_id)) plan.intent_id = { value: String(intent.id), evidence: m.via, detail: `producer ${intent.producer_id}` }
  if (intent && adopted) {
    const origin = up(intent.order_type || 'MARKET') === 'MARKET' ? 'bot_market_dispatch' : 'bot_pending_fill'
    plan.origin = { value: origin, evidence: m.via, detail: `intent ${intent.id} (${intent.producer_id}, ${intent.order_type || 'MARKET'})` }
  }
  const approval = evidencedApproval(db, t, intent)
  if (approval && t.risk_event_id == null) plan.risk_event_id = { value: approval.id, evidence: approval.evidence, detail: approval.detail }
  else if (approval && Number(t.risk_event_id) !== Number(approval.id)) {
    out.conflicts.push({ field: 'risk_event_id', stored: Number(t.risk_event_id), evidenced: approval.id, evidence: approval.evidence, detail: approval.detail })
  }

  if (Object.keys(plan).length || out.conflicts.length) try {
    ensureReasonEvidenceTable(db)
    const ev = db.prepare(`INSERT OR IGNORE INTO trade_reason_evidence (trade_id, field, before_value, value, evidence, detail, writer, at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    db.transaction(() => {
      const r = db.prepare(`UPDATE trades SET
          strategy = CASE WHEN strategy IS NULL OR TRIM(strategy) = '' THEN COALESCE(?, strategy) ELSE strategy END,
          intent_id = COALESCE(intent_id, ?),
          risk_event_id = COALESCE(risk_event_id, ?),
          origin_source = CASE WHEN ? IS NOT NULL AND origin = 'reconciler_adopted' THEN 'intent_link' ELSE origin_source END,
          origin = CASE WHEN ? IS NOT NULL AND origin = 'reconciler_adopted' THEN ? ELSE origin END
        WHERE id = ?`)
      r.run(plan.strategy?.value ?? null, plan.intent_id?.value ?? null, plan.risk_event_id?.value ?? null,
        plan.origin?.value ?? null, plan.origin?.value ?? null, plan.origin?.value ?? null, t.id)
      if (plan.strategy) db.prepare(`UPDATE monitored_positions SET strategy = COALESCE(strategy, ?) WHERE trade_id = ?`).run(plan.strategy.value, t.id)
      const before = { strategy: t.strategy, intent_id: t.intent_id, origin: t.origin, risk_event_id: t.risk_event_id }
      // Recorded only where the row now holds the value this pass wrote — a
      // value another writer put there first keeps its own provenance.
      const after = db.prepare('SELECT strategy, intent_id, origin, risk_event_id FROM trades WHERE id = ?').get(t.id) || {}
      for (const [field, p] of Object.entries(plan)) {
        if (String(after[field] ?? '') !== String(p.value) || String(before[field] ?? '') === String(p.value)) continue
        ev.run(t.id, field, before[field] == null ? null : String(before[field]), String(p.value), p.evidence, p.detail ?? null, writer, at)
        out.wrote[field] = p
      }
      for (const c of out.conflicts) {
        ev.run(t.id, `${c.field}_conflict`, String(c.stored), String(c.evidenced), c.evidence, `stored approval #${c.stored} kept; ${c.detail} names #${c.evidenced}`, writer, at)
      }
    })()
  } catch (err) {
    return { ...out, wrote: {}, error: String(err?.message || err).slice(0, 200) }
  }

  // What stays missing, and why (the goal counts these rows by their kind).
  const has = (f) => (out.wrote[f] != null) || (f === 'strategy' ? !blank(t.strategy) : t[f] != null)
  if (!has('strategy')) { out.stillMissing.push('strategy'); out.why.strategy = UNRECOVERABLE.strategy }
  if (!has('risk_event_id')) { out.stillMissing.push('approval id'); out.why['approval id'] = intent ? UNRECOVERABLE['approval id'] : `${UNRECOVERABLE['approval id']} (${m.why})` }
  let planned = false
  try { planned = !!db.prepare('SELECT 1 FROM trade_plans WHERE trade_id = ?').get(t.id) } catch { planned = false }
  if (!planned) { out.stillMissing.push('plan'); out.why.plan = UNRECOVERABLE.plan }
  return out
}

/**
 * The backfill: every trade_reasons row an evidence record can still help,
 * since `sinceIso` (the goal's own cutoff). Idempotent; counts returned for
 * the boot line.
 */
export async function backfillAdoptedReasons(db, { sinceIso = null, at = new Date().toISOString(), writer = 'backfill' } = {}) {
  let since = sinceIso
  if (since == null) {
    const { TRADE_REASONS_CUTOFF_ISO } = await import('./close-completeness.js')
    since = TRADE_REASONS_CUTOFF_ISO
  }
  const clean = CLEAN_BOT_ORIGINS.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT id FROM trades
     WHERE status IN ('open', 'closed')
       AND opened_at IS NOT NULL AND REPLACE(opened_at, 'T', ' ') >= ?
       AND ((origin = 'reconciler_adopted'
             AND (strategy IS NULL OR TRIM(strategy) = '' OR risk_event_id IS NULL OR intent_id IS NULL))
         OR (origin IN (${clean}) AND risk_event_id IS NULL))
     ORDER BY id`).all(since, ...CLEAN_BOT_ORIGINS)
  const out = {
    since, considered: 0, rowsWritten: 0, fields: {}, byEvidence: {}, conflicts: [], errors: [],
    stillMissing: {}, stillMissingRows: 0, stillMissingIds: [],
  }
  for (const { id } of rows) {
    const r = recoverTradeReason(db, id, { writer, at })
    if (!r.inScope) continue
    out.considered++
    if (r.error) { out.errors.push({ tradeId: id, error: r.error }); continue }
    const fields = Object.keys(r.wrote)
    if (fields.length) out.rowsWritten++
    for (const f of fields) {
      out.fields[f] = (out.fields[f] || 0) + 1
      const k = `${f}:${r.wrote[f].evidence}`
      out.byEvidence[k] = (out.byEvidence[k] || 0) + 1
    }
    for (const c of r.conflicts) out.conflicts.push({ tradeId: id, ...c })
    if (r.stillMissing.length) {
      out.stillMissingRows++
      if (out.stillMissingIds.length < 200) out.stillMissingIds.push(id)
      for (const f of r.stillMissing) out.stillMissing[f] = (out.stillMissing[f] || 0) + 1
    }
  }
  return out
}

/** The one line the boot and the sweep print: what was recovered, from what, and what stays missing. */
export function adoptedReasonsLine(out) {
  const kv = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k} ${n}`).join(', ')
  return `adopted reasons: ${out.considered} bot row(s) since ${String(out.since).slice(0, 10)} considered · ` +
    `${out.rowsWritten} written (${kv(out.byEvidence) || 'nothing new'})` +
    ` · still without: ${kv(out.stillMissing) || 'nothing'} on ${out.stillMissingRows} row(s) — counted in trade_reasons, never invented` +
    (out.conflicts.length ? ` · ${out.conflicts.length} stored approval id(s) contradicted by evidence, kept and recorded` : '') +
    (out.errors.length ? ` · ${out.errors.length} row(s) failed: ${out.errors.slice(0, 3).map(e => `#${e.tradeId} ${e.error}`).join('; ')}` : '')
}
