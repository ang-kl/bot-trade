// ---------------------------------------------------------------------------
// agent/services/margin-pool-journal.js — the margin pool's state-change
// journal (19-09-2026, the veto boundary).
//
// The loop's marginPoolForCycle used to journal every EXHAUSTED account every
// loop cycle as a risk_events veto under symbol 'PORTFOLIO'. Measured
// 18/19-09-2026: 1,235 such rows in 24 h — 100 % of the gate's vetoes —
// while zero proposals were refused at the gate, so the veto goal read
// 0.996 for an idle gate. A veto is a refusal of a trade the bot would
// otherwise have taken; an exhausted account is a cycle-stable, per-account
// state, which is a decision_log SKIP — and a state is recorded when it
// CHANGES, not once per cycle it persists.
//
// One row per account per transition: exhausted → a 'skip' row with the
// `portfolio_margin_exhausted …` reason the veto-breakdown already keys on;
// recovered → a 'proceed' row (`portfolio_margin_recovered …`), so the
// audit's skip count carries only the refusals. The per-cycle "Margin pool
// …" log line in loop.js is unchanged. The last-state map is in memory and
// starts empty on boot, so the first exhausted reading after a restart is
// journaled once.
// ---------------------------------------------------------------------------

import { recordDecision } from './decision-log.js'

export const MARGIN_POOL_STAGE = 'margin_pool'

const lastExhausted = new Map() // accountId → boolean

/** Forget every account's last state (boot; tests). */
export function resetMarginPoolJournal() {
  lastExhausted.clear()
}

/**
 * Journal the pool's state changes. `pool` is marginPoolForCycle's list:
 * `{ accountId, status, exhausted }` per account. Returns the rows written.
 */
export function journalMarginPoolState(db, pool, { loopId = null } = {}) {
  const written = []
  for (const p of pool || []) {
    const id = String(p.accountId)
    const now = !!p.exhausted
    const was = lastExhausted.get(id)
    if (was === now) continue
    // A first reading that is NOT exhausted is not a transition worth a row:
    // nothing was refused and nothing recovered.
    if (was === undefined && !now) { lastExhausted.set(id, now); continue }
    lastExhausted.set(id, now)
    const st = p.status || {}
    const usedN = Number.isFinite(Number(st.usedMargin)) ? Number(Number(st.usedMargin).toFixed(2)) : null
    const capN = Number.isFinite(Number(st.cap)) ? Number(Number(st.cap).toFixed(2)) : null
    const used = usedN == null ? 'na' : usedN.toFixed(2)
    const cap = capN == null ? 'na' : capN.toFixed(2)
    const source = st.source ?? 'na'
    const row = now
      ? {
        accountId: id, symbol: null, stage: MARGIN_POOL_STAGE, decision: 'skip', loopId,
        reason: `portfolio_margin_exhausted used=${used} cap=${cap} source=${source}`,
        detail: { margin_used_usd: usedN, margin_cap_usd: capN, margin_source: source, account_id: id, transition: 'exhausted' },
      }
      : {
        accountId: id, symbol: null, stage: MARGIN_POOL_STAGE, decision: 'proceed', loopId,
        reason: `portfolio_margin_recovered used=${used} cap=${cap} source=${source}`,
        detail: { margin_used_usd: usedN, margin_cap_usd: capN, margin_source: source, account_id: id, transition: 'recovered' },
      }
    try { recordDecision(db, row) } catch { /* journaling is best-effort */ }
    written.push(row)
  }
  return written
}
