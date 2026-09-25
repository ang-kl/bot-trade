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
//   1. The ledger intent — an entry_intents row on THIS account whose
//      broker_position_id is the trade's position ('intent'), else the
//      `i<id>` tag in the label (trade-labels.js labelIntentId) looked up on
//      the SAME account ('label_intent'). Every state is keyed, not only
//      FILLED: the basis is a property of the intent, and a tick fill whose
//      intent stayed ACCEPTED / SENT / UNKNOWN (the breach states the
//      reconciler adopts) must not fall through to a weaker source. The
//      intent's id, state and own basis are carried.
//        a. A 'tick' intent is authoritative: basis 'tick'.
//        b. Any other intent basis yields to POSITIVE non-strategy evidence
//           on the trade first — source 'manual' / 'preopen', else the
//           label's source MAN / PRE — reported under that evidence
//           ('trade_source' / 'label_source') with the intent still carried.
//           Without this a pre-open fill that has a ledger intent read 'bar'
//           (WP-A keeps closed_market_limits at 'bar', and manual-route
//           intents written before WP-A carry 'bar'), while the SAME kind of
//           trade without an intent read 'preopen': the bar PF and win rate
//           blended pre-open fills in (checker, PR #1086 blocker 1). 'external'
//           is NOT such evidence: it means "no owner evidence at adoption",
//           and an intent on this account is owner evidence.
//        c. Else the PRODUCER answers ('intent_producer'): the scan's
//           closed_market_limits → 'preopen'; a manual or manual_assisted
//           family producer → 'manual'.
//        d. Else the intent's own basis, with 'manual_assisted' folded into
//           'manual' (below).
//   2. 'label'         — a label starting 'tick:' (the sidecar firer's own).
//   3. 'trade_source' / 'label_source' — a trade the system did not open by
//                         a bar or tick strategy: manual, external or
//                         pre-open. Each is its OWN basis, never 'bar': that
//                         a trade is not tick (tick_firer.cpp:137 — no tick
//                         fill without a permit) does not make it a bar
//                         strategy's trade. Pre-open IS a system strategy's
//                         entry, but a separate bet — a limit rested on the
//                         previous session's close (trade-labels.js SOURCES).
//   4. 'no_intent_bar' — an autopilot/copilot trade (by source or label) with
//                         no tick evidence: basis 'bar'.
//   5. 'no_owner_evidence' — nothing says the system opened it: counted as
//                         'external', named, never folded into 'bar'.
//
// MANUAL_ASSISTED IS FOLDED INTO MANUAL. On main (WP-A) a manual-family
// intent is recorded with basis 'manual' or 'manual_assisted'
// (entry-producers.js producerBasis). Both are a human's decision to enter
// now — trade-now, validation-fill and execute-trade are buttons, not a
// schedule — and neither is a bar or tick strategy's automatic entry, so for
// the question this report answers (does each ENTRY BASIS earn?) they are one
// class. The distinction is kept, not lost: `intentBasis` carries the
// intent's own word on every intent-resolved row.
// ---------------------------------------------------------------------------

import { labelIntentId, parseLabel } from '../lib/trade-labels.js'
import { ENTRY_PRODUCERS } from '../lib/entry-producers.js'

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
 * @returns {{basis: string, basisSource: string, intentId?: string, intentState?: string|null, intentBasis?: string}}
 */
export function basisOfTrade(row, byPos, byId) {
  const acct = row?.account_id == null ? null : String(row.account_id)
  const pos = row?.ctrader_position_id == null || String(row.ctrader_position_id) === '' ? null : String(row.ctrader_position_id)
  const label = row?.label_raw == null ? '' : String(row.label_raw)
  const src = row?.source == null ? '' : String(row.source).toLowerCase()
  const lsrc = parseLabel(label).source
  let it = null, via = null
  if (acct != null && pos != null) {
    const hit = byPos?.get(`${acct}:${pos}`)
    if (hit && hit.basis) { it = hit; via = 'intent' }
  }
  if (!it) {
    const tag = labelIntentId(label)
    const hit = tag && acct != null ? byId?.get(tag) : null
    if (hit && String(hit.account_id) === acct && hit.basis) { it = hit; via = 'label_intent' }
  }
  if (it) return fromIntent(it, via, src, lsrc)
  if (label.startsWith('tick:')) return { basis: 'tick', basisSource: 'label' }
  if (NON_STRATEGY_BASES.includes(src)) return { basis: src, basisSource: 'trade_source' }
  if (lsrc === 'manual' || lsrc === 'preopen') return { basis: lsrc, basisSource: 'label_source' }
  if (src === 'autopilot' || src === 'copilot' || lsrc === 'autopilot' || lsrc === 'copilot') return { basis: 'bar', basisSource: 'no_intent_bar' }
  return { basis: 'external', basisSource: 'no_owner_evidence' }
}

/** Positive evidence that a trade is not a bar/tick strategy's entry ('external' is not: see the header). */
const POSITIVE_NON_STRATEGY = Object.freeze(['manual', 'preopen'])

/** The scan's own producer whose every fill is a pre-open resting limit. */
const PREOPEN_PRODUCERS = Object.freeze(['closed_market_limits'])

const familyOfProducer = (id) => ENTRY_PRODUCERS.find(p => p.id === id)?.family ?? null

function fromIntent(it, via, src, lsrc) {
  const intentBasis = String(it.basis)
  const carry = { intentId: String(it.id), intentState: it.state ?? null, intentBasis }
  if (intentBasis === 'tick') return { basis: 'tick', basisSource: via, ...carry }
  if (POSITIVE_NON_STRATEGY.includes(src)) return { basis: src, basisSource: 'trade_source', ...carry }
  if (POSITIVE_NON_STRATEGY.includes(lsrc)) return { basis: lsrc, basisSource: 'label_source', ...carry }
  const producer = it.producer_id == null ? null : String(it.producer_id)
  if (producer && PREOPEN_PRODUCERS.includes(producer)) return { basis: 'preopen', basisSource: 'intent_producer', ...carry }
  const fam = producer ? familyOfProducer(producer) : null
  if (fam === 'manual' || fam === 'manual_assisted') return { basis: 'manual', basisSource: 'intent_producer', ...carry }
  if (intentBasis === 'manual_assisted') return { basis: 'manual', basisSource: via, ...carry }
  return { basis: intentBasis, basisSource: via, ...carry }
}
