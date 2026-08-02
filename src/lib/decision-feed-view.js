// Presentation helpers for the decision feed. Separate from the component so
// the component file exports only a component, and so the wording — which is
// the substance of this panel — can be tested without rendering.

export const WINDOWS = [6, 24, 72]

export const DECISION_TONE = {
  proceed: 'on',
  skip: 'warning',
  veto: 'down',
}

/**
 * The one-line reading of a stage's repeat ratio.
 *
 * This is the panel's whole reason for existing. 800 rows across 3 symbols and
 * 800 rows across 200 symbols look identical in a raw log and are completely
 * different problems: the first is a handful of setups retrying every cycle,
 * the second is a filter rejecting the entire universe. The threshold is
 * deliberately loose and the wording deliberately hedged — this is a reading
 * offered to the operator, not a diagnosis.
 */
export function repeatReading(stage) {
  const r = stage?.repeatRatio
  if (r == null || !(stage.distinctSymbols > 0)) return null
  if (stage.distinctSymbols === 1) return 'one instrument, retried every cycle'
  if (r >= 5) return `${stage.distinctSymbols} instruments, each retried ~${Math.round(r)}× — a few setups waiting, not a wide rejection`
  if (r <= 1.5) return `${stage.distinctSymbols} instruments, barely repeated — this is rejecting across the universe, not retrying`
  return `${stage.distinctSymbols} instruments, ~${r}× each`
}

/** Short relative age from a SQLite space-form or ISO timestamp. */
export function ago(stamp, nowMs = Date.now()) {
  if (!stamp) return '—'
  const raw = String(stamp).replace(' ', 'T')
  const t = Date.parse(raw.endsWith('Z') || raw.includes('+') ? raw : `${raw}Z`)
  if (!Number.isFinite(t)) return '—'
  const mins = Math.floor((nowMs - t) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

/** Copy-to-clipboard form: the summary first, then the instances. */
export function toText(d) {
  const head = [
    `Decision feed — last ${d.windowHours}h · ${d.total.toLocaleString()} decisions`
      + `${d.accountId ? ` · account ${d.accountId}` : ' · all accounts'}`
      + `${d.unstamped ? ` · ${d.unstamped} not stamped to an account` : ''}`,
    `proceed ${d.totals.proceed} · skip ${d.totals.skip} · veto ${d.totals.veto}`
      + (d.totals.other ? ` · other ${d.totals.other}` : ''),
    '',
  ]
  const stages = d.stages.flatMap(s => [
    `${s.stage} — ${s.count.toLocaleString()} (${s.distinctSymbols} symbols)${repeatReading(s) ? ` · ${repeatReading(s)}` : ''}`,
    ...s.reasons.map(r => `    ${r.decision}: ${r.reason ?? '(no reason recorded)'} × ${r.count}`),
    ...(s.moreReasons ? [`    … and ${s.moreReasons} more reasons`] : []),
  ])
  const rows = d.rows.length
    ? ['', `Newest ${d.rows.length}${d.truncated ? ' (capped)' : ''}`,
       ...d.rows.map(r => `${r.created_at} · ${r.symbol || '—'} · ${r.stage}/${r.decision} · ${r.reason ?? ''}`)]
    : []
  return [...head, ...stages, ...rows].join('\n')
}
