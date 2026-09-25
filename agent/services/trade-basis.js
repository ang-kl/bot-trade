// ---------------------------------------------------------------------------
// agent/services/trade-basis.js — which ENTRY BASIS opened a closed trade
// (plan P1, docs/dual-environment-plan-2026-09-25.md; owner principle 4:
// "every trade has a reason", so the answer is never 'unknown').
//
// Resolved when a report is read, not stored: entry_intents and
// tick_shadow_trades are never pruned, so the answer is reproducible.
//
// The order, and the name of the evidence each step used (`basisSource`):
//
//   1. 'intent'        — an entry_intents row on THIS account whose
//                         broker_position_id is the trade's position. Every
//                         state is keyed, not only FILLED: the basis is a
//                         property of the intent, and a tick fill whose intent
//                         stayed ACCEPTED / SENT / UNKNOWN (the breach states
//                         the reconciler adopts) must not fall through to a
//                         weaker source. The intent's state is carried.
//   2. 'label_intent'  — the `i<id>` tag in the label (trade-labels.js
//                         labelIntentId), looked up on the SAME account.
//   3. 'label'         — a label starting 'tick:' (the sidecar firer's own).
//   4. 'trade_source' / 'label_source' — a trade the system did not open by
//                         strategy: manual, external or pre-open. Each is its
//                         OWN basis, never 'bar': that a trade is not tick
//                         (tick_firer.cpp:137 — no tick fill without a permit)
//                         does not make it a bar strategy's trade.
//   5. 'no_intent_bar' — an autopilot/copilot trade (by source or label) with
//                         no tick evidence: basis 'bar'.
//   6. 'no_owner_evidence' — nothing says the system opened it: counted as
//                         'external', named, never folded into 'bar'.
// ---------------------------------------------------------------------------

import { labelIntentId, parseLabel } from '../lib/trade-labels.js'

/** The non-strategy classes, each reported in its own row. */
export const NON_STRATEGY_BASES = Object.freeze(['manual', 'external', 'preopen'])

/**
 * Every entry intent that can answer for a trade, read once:
 *   byPos — `${account_id}:${broker_position_id}` → intent
 *   byId  — intent id → intent (the caller checks the account)
 * A position matched by more than one intent keeps the FILLED one, else the
 * newest — the same position is one entry.
 */
export function intentMaps(db) {
  const byPos = new Map(), byId = new Map()
  let rows = []
  try {
    rows = db.prepare(`SELECT id, account_id, producer_id, basis, state, broker_position_id, created_at
                         FROM entry_intents ORDER BY created_at, id`).all()
  } catch { rows = [] }
  for (const r of rows) {
    byId.set(String(r.id), r)
    if (r.broker_position_id == null || String(r.broker_position_id) === '') continue
    const k = `${String(r.account_id)}:${String(r.broker_position_id)}`
    const prev = byPos.get(k)
    if (!prev || prev.state !== 'FILLED' || r.state === 'FILLED') byPos.set(k, r)
  }
  return { byPos, byId }
}

/**
 * The basis of one closed trade row (needs account_id, ctrader_position_id,
 * label_raw, source). Pure over the two maps.
 *
 * @returns {{basis: string, basisSource: string, intentId?: string, intentState?: string}}
 */
export function basisOfTrade(row, byPos, byId) {
  const acct = row?.account_id == null ? null : String(row.account_id)
  const pos = row?.ctrader_position_id == null || String(row.ctrader_position_id) === '' ? null : String(row.ctrader_position_id)
  if (acct != null && pos != null) {
    const it = byPos?.get(`${acct}:${pos}`)
    if (it && it.basis) return { basis: String(it.basis), basisSource: 'intent', intentId: String(it.id), intentState: it.state ?? null }
  }
  const label = row?.label_raw == null ? '' : String(row.label_raw)
  const tag = labelIntentId(label)
  if (tag && acct != null) {
    const it = byId?.get(tag)
    if (it && String(it.account_id) === acct && it.basis) return { basis: String(it.basis), basisSource: 'label_intent', intentId: String(it.id), intentState: it.state ?? null }
  }
  if (label.startsWith('tick:')) return { basis: 'tick', basisSource: 'label' }
  const src = row?.source == null ? '' : String(row.source).toLowerCase()
  if (NON_STRATEGY_BASES.includes(src)) return { basis: src, basisSource: 'trade_source' }
  const lsrc = parseLabel(label).source
  if (lsrc === 'manual' || lsrc === 'preopen') return { basis: lsrc, basisSource: 'label_source' }
  if (src === 'autopilot' || src === 'copilot' || lsrc === 'autopilot' || lsrc === 'copilot') return { basis: 'bar', basisSource: 'no_intent_bar' }
  return { basis: 'external', basisSource: 'no_owner_evidence' }
}
