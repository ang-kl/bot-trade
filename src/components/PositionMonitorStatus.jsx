export default function PositionMonitorStatus({ readStatus, lastCheckAt, lastCheckAction, thesisStatus, monitorSl, nowMs }) {
  const verified = readStatus === 'verified'
  const at = Date.parse(lastCheckAt || '')
  const age = Number.isFinite(at) && at <= nowMs ? Math.round((nowMs - at) / 60000) : null
  const text = !verified ? 'monitor read unverified' : age == null ? 'not yet reviewed'
    : `reviewed ${age === 0 ? 'just now' : `${age}m ago`}${lastCheckAction ? ` · ${String(lastCheckAction).toUpperCase()}` : ''}${thesisStatus ? ` · thesis ${thesisStatus}` : ''}`
  const color = !verified || age > 15 ? 'var(--color-warning-text)' : age == null ? 'var(--color-down)' : 'var(--color-up)'
  return <div className="mt-1 pt-1 border-t border-[var(--color-border)] text-(length:--fs-body) leading-tight flex items-center justify-between gap-1">
    <span style={{ color }} className="truncate" title={!verified ? 'Monitor records could not be verified' : lastCheckAt ? `Last monitor review at ${lastCheckAt}` : 'The monitor has not reviewed this position yet'}>● {text}</span>
    <span className="shrink-0 tabular-nums text-[var(--color-text-sub)]" title={!verified ? 'Broker protection is shown separately; monitor ownership is unverified' : monitorSl != null ? 'Stop-loss recorded by the monitor' : 'No stop-loss recorded by the monitor'}>
      {!verified ? 'monitor SL unverified' : monitorSl != null ? `SL ${Number(monitorSl).toLocaleString(undefined, { maximumFractionDigits: 5 })}` : 'no tracked SL'}
    </span>
  </div>
}
