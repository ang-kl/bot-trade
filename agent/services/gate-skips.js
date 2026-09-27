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

/**
 * A RETIRED producer asked to open new risk and was refused at the fence
 * (services/entry-mode.js admitEntry; owner order 20-09-2026, the intraday
 * retirement). One decision_log SKIP, never a risk_events veto — the
 * boundary drawn by the veto-boundary PR: a refusal that is stable for the
 * whole cycle and the same for every proposal on the account is a skip.
 *
 * The proposal rides in detail_json in the SAME shape the evidence shadow
 * and the gate_redirect row use, so the refusal ledger scores the retired
 * stack's proposals for forgone R at zero risk — the scan keeps producing
 * evidence and, if it recovers, the owner has the record.
 */
export const PRODUCER_RETIRED_STAGE = 'producer_retired'

export function recordProducerRetired(db, { accountId, producerId, reason, basis = null, proposal = null, loopId = null }) {
  const p = proposal || null
  recordDecision(db, {
    accountId,
    symbol: p?.symbol ?? null, timeframe: p?.timeframe ?? null, strategy: p?.strategy ?? null,
    stage: PRODUCER_RETIRED_STAGE, decision: 'skip',
    reason: `producer_retired: ${producerId}`, loopId,
    detail: {
      reason, producerId, basis,
      proposal: p
        ? {
          symbol: p.symbol ?? null, side: p.side ?? null, entry: p.entry ?? null, sl: p.sl ?? null,
          tp1: p.tp1 ?? null, tp2: p.tp2 ?? null, requestedVolume: p.requestedVolume ?? null,
          strategy: p.strategy || null, timeframe: p.timeframe ?? null,
          conviction: p.conviction ?? null, source: p.source || 'auto_signal', accountId,
        }
        : null,
    },
  })
}

/**
 * V3 S-8: the entry's own account calendar reads UNKNOWN, so no order and no
 * resting limit went out (services/entry-hours.js — UNKNOWN never reads
 * open). One decision_log SKIP carrying the proposal and the calendar's
 * reason, never a risk_events veto: the risk gate was not asked. The caller
 * dedupes to one row per (account, symbol) until the calendar is known again.
 */
export const MARKET_HOURS_UNKNOWN_STAGE = 'market_hours_unknown'

export function recordMarketHoursUnknown(db, { accountId, symbol, side, synth = {}, requestedVolume = null, gate = {}, producerId = null, loopId = null }) {
  recordDecision(db, {
    accountId,
    symbol, timeframe: synth.timeframe ?? null, strategy: synth.strategy ?? null,
    stage: MARKET_HOURS_UNKNOWN_STAGE, decision: 'skip',
    reason: `market_hours_unknown: ${gate.calendarReason ?? 'unknown'}`, loopId,
    detail: {
      hoursSource: gate.hoursSource ?? null, calendarReason: gate.calendarReason ?? null,
      refresh: gate.refresh ?? null, observedAt: gate.observedAt ?? null, producerId,
      proposal: {
        symbol, side, entry: synth.entry ?? null, sl: synth.sl ?? null, tp1: synth.tp1 ?? null, tp2: synth.tp2 ?? null,
        requestedVolume, strategy: synth.strategy || null, timeframe: synth.timeframe ?? null,
        conviction: synth.overall_conviction ?? null, source: synth.source || 'auto_signal', accountId,
      },
    },
  })
}
