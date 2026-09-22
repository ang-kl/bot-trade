import { groupControllers, needsAttention } from '../../agent/shared/controller-groups.js'

const stamp = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Unobserved'
function Job({ row }) {
  const completion = row.detail?.lastCompletedAt
  return <li className="py-1 border-b border-[var(--color-border)]">
    <div><strong>{row.label}</strong> — {row.status?.toUpperCase() || 'UNVERIFIED'}
      {row.detail?.busy && ' · BUSY: overlap skipped; no completed pass'}</div>
    {row.retired || row.status === 'retired' ? <p>{row.note || 'Retired; retained for history.'}</p> : <>
      <p>Last heartbeat: {stamp(row.last_run_at)} · {row.runs ?? 0} timer/job runs · expected heartbeat: {row.expected_sec == null ? 'Unspecified' : `${row.expected_sec}s`}</p>
      <p>Completed work: {stamp(completion)}{row.detail?.checked != null ? ` · ${row.detail.checked} positions evaluated in that pass` : ''}</p>
      {row.work_product && <p>Work evidence: {row.work_product.summary || row.verdict || 'Available in diagnostics'}{row.work_product.fresh === false ? ' · STALE / UNAVAILABLE' : ''}</p>}
      {row.last_error && <p>{row.error_is_current === false ? 'Previous error (resolved)' : 'Current error'}: {row.last_error}</p>}
      {row.dormant && <p>Dormant: {row.dormant.reason || row.last_error || 'No applicable accounts'}</p>}
    </>}
  </li>
}

export default function ControllerGroups({ controllers }) {
  const view = groupControllers(controllers)
  if (!view) return <p role="status">Controller inventory unavailable.</p>
  return <div className="text-(length:--fs-body) space-y-2">
    {view.exceptions.length > 0 && <div role="status">
      <strong>Controllers needing attention</strong>
      <ul>{view.exceptions.map(r => <li key={r.name}>{r.label}: {r.status.toUpperCase()}{r.error_is_current && r.last_error ? ` — ${r.last_error}` : ''}</li>)}</ul>
    </div>}
    {view.groups.map(g => <details key={g.key} open={g.rows.some(needsAttention)}>
      <summary>{g.label} · {g.rows.length} jobs · {g.rows.filter(needsAttention).length} exceptions</summary>
      <ul>{g.rows.map(row => <Job key={row.name} row={row} />)}</ul>
    </details>)}
    {view.unmapped.length > 0 && <details open><summary>Unmapped jobs — inventory review required</summary><ul>{view.unmapped.map(row => <Job key={row.name} row={row} />)}</ul></details>}
    <details><summary>Retired history · {view.retired.length}</summary><ul>{view.retired.map(row => <Job key={row.name} row={row} />)}</ul></details>
    <p>Heartbeat timing describes process activity. Completed-work timestamps require an explicit receipt; a successful heartbeat alone is not proof of coverage. Detailed work and account evidence remain above.</p>
  </div>
}
