// ---------------------------------------------------------------------------
// agent/services/gate-skips.js — upstream refusals recorded as SKIPS.
//
// PR-C (owner principle 7). The regime gate and the evidence gate sit
// UPSTREAM of the risk gate — one is a market-state read, the other a
// strategy's live record on an account — yet both used to write risk_events
// vetoes, so they were counted as gate refusals in every veto total and
// re-written every cycle for as long as the condition held. They belong in
// decision_log beside the other upstream skips (style filter, stage matrix,
// lesson decay, watchlist gates), which is where "why didn't it trade?" is
// answered from and where the audit already counts them as `skipped`.
//
// WHAT READ THE OLD ROWS, and where the same information goes now:
//   · evidenceGateReport (evidence-gate.js) counted `evidence_gate:` rows for
//     its shadowRefusals7d — it now counts decision_log rows of stage
//     `evidence_gate` as well, so the number survives the move.
//   · src/lib/veto-words.js humanises `regime_block …` and `evidence_gate:` —
//     reasons keep the same head, so the same words apply to the skip rows.
//   · the refusal ledger scores risk_events by opportunity_key. Evidence-gate
//     refusals carried the FULL proposal for that reason ("the refusal IS its
//     shadow record"); the proposal now rides in detail_json on the skip row.
//     The ledger does not read decision_log — flagged in the PR-C follow-up
//     (docs/plan-execution-audit-2026-09-11.md) rather than widened here.
//   · no Telegram alert existed for either block; none is added.
// ---------------------------------------------------------------------------

import { recordDecision } from './decision-log.js'

export const REGIME_BLOCK_STAGE = 'regime_block'
export const EVIDENCE_GATE_STAGE = 'evidence_gate'

/** The regime gate refused this symbol's strategy/bias: one skip, no veto. */
export function recordRegimeBlock(db, { symbol, synth = {}, signal = null, reason, loopId = null }) {
  recordDecision(db, {
    symbol, timeframe: synth.timeframe ?? null, strategy: synth.strategy ?? null,
    stage: REGIME_BLOCK_STAGE, decision: 'skip', reason, loopId,
    detail: {
      bias: synth.consensus_bias ?? null,
      side: synth.consensus_bias === 'short' ? 'SELL' : 'BUY',
      entry: signal?.entry ?? synth.entry ?? null,
    },
  })
}

/**
 * The evidence gate refused this strategy on this account: one skip carrying
 * the full proposal (its shadow record), no veto.
 */
export function recordEvidenceShadow(db, { symbol, side, synth = {}, accountId, requestedVolume = null, gate = {}, loopId = null }) {
  recordDecision(db, {
    accountId,
    symbol, timeframe: synth.timeframe ?? null, strategy: synth.strategy ?? null,
    stage: EVIDENCE_GATE_STAGE, decision: 'skip',
    reason: `evidence_gate: ${gate.reason}`, loopId,
    detail: {
      via: gate.via ?? null, record: gate.record ?? null, bar: gate.bar ?? null,
      proposal: {
        symbol, side, entry: synth.entry ?? null, sl: synth.sl ?? null, tp1: synth.tp1 ?? null, tp2: synth.tp2 ?? null,
        requestedVolume, strategy: synth.strategy || null, timeframe: synth.timeframe ?? null,
        conviction: synth.overall_conviction ?? null, source: synth.source || 'auto_signal', accountId,
      },
    },
  })
}
