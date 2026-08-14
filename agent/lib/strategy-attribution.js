// ---------------------------------------------------------------------------
// agent/lib/strategy-attribution.js — one true reading of "which strategy is
// this row", shared by every module that used to compute it separately.
//
// `trades` carries two columns: `strategy` (written by the loop from
// synth.strategy at open) and `label_strategy` (parsed back out of the BROKER
// LABEL after encodeLabel round-trips it — lib/trade-labels.js). A strategy
// key with no code in that vocabulary encodes to 'other', which is not NULL —
// so `COALESCE(label_strategy, strategy)` and `label_strategy ?? strategy`
// both prefer 'other' over a real value sitting one column away.
//
// 'other' is the ABSENCE of an answer. It must never shadow one. This module
// is the one place that rule is encoded, for both JS row objects and SQL
// queries — so a caller cannot reintroduce the bug by writing the comparison
// out again slightly differently.
//
// Found via /state/go-live-readiness reporting 629 of 882 closed rows (71.3%)
// unattributed when the ledger's `strategy` column had the answer for most of
// them. The SAME COALESCE shape sat in strategyPerfStats (risk.js) feeding
// the Kelly gate — which meant a strategy with no label code always read
// total_trades=0 there too, and kellyVolume "skips" a thin sample rather than
// vetoing it, so the Kelly veto for negative expectancy could never fire for
// that strategy no matter how it actually performed.
// ---------------------------------------------------------------------------

/**
 * The strategy a row can actually be attributed to, or null.
 *
 * @param {{label_strategy?:string|null, strategy?:string|null}} row
 * @returns {string|null}
 */
export function strategyOf(row) {
  const pick = (v) => {
    const s = v == null ? '' : String(v).trim()
    return s === '' || s.toLowerCase() === 'other' ? null : s
  }
  return pick(row?.label_strategy) ?? pick(row?.strategy)
}

/**
 * SQL CASE expression mirroring strategyOf(), for queries that filter or
 * group in the database rather than loading rows into JS.
 *
 * @param {string} labelCol table-qualified column, e.g. 't.label_strategy'
 * @param {string} strategyCol table-qualified column, e.g. 't.strategy'
 * @returns {string} a CASE expression yielding NULL where strategyOf() would
 */
export function strategyAttrSql(labelCol = 'label_strategy', strategyCol = 'strategy') {
  return `CASE
    WHEN ${labelCol} IS NOT NULL AND TRIM(${labelCol}) <> '' AND LOWER(${labelCol}) <> 'other' THEN ${labelCol}
    WHEN ${strategyCol} IS NOT NULL AND TRIM(${strategyCol}) <> '' AND LOWER(${strategyCol}) <> 'other' THEN ${strategyCol}
    ELSE NULL
  END`
}
