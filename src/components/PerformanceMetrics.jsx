// Codex · №11,784 · 2026-10-07; codex-footprint: performance-essentials.
import { Fragment } from 'react'
import Collapse from './common/Collapse.jsx'
import { historicalMetricNotes } from '../lib/performance-metrics.js'

export default function PerformanceMetrics({ analytics, groups }) {
  return <Collapse id="Performance_1944" label="Historical metric rows">
    <div className="space-y-1 mb-2 text-(length:--fs-body) text-[var(--color-text-sub)]">
      {historicalMetricNotes(analytics).map(note => <p key={note}>{note}</p>)}
    </div>
    <div data-testid="performance-metrics" style={{ overflowX: 'auto', maxWidth: '100%' }}>
      <table className="w-full text-left tabular-nums" style={{ minWidth: 640 }}>
        <thead><tr><th className="px-2 py-2">Metric</th><th className="px-2 py-2">All recorded history</th><th className="px-2 py-2">What it measures</th></tr></thead>
        <tbody>{groups.map(([group, items]) => <Fragment key={group}>
          <tr><th colSpan={3} className="px-2 pt-3 pb-1 text-left uppercase text-[var(--color-muted)]">{group}</th></tr>
          {items.map(([label, value, tone, note]) => <tr key={label} className="border-t border-[var(--glass-edge)]">
            <th scope="row" className="px-2 py-2 font-medium" style={{ minWidth: 150 }}>{label}</th>
            <td className="px-2 py-2" style={{ minWidth: 140, color: tone === 'up' ? 'var(--color-up)' : tone === 'down' ? 'var(--color-down)' : undefined }}>{value}</td>
            <td className="px-2 py-2 text-[var(--color-text-sub)]" style={{ minWidth: 300, whiteSpace: 'normal' }}>{note}</td>
          </tr>)}
        </Fragment>)}</tbody>
      </table>
    </div>
  </Collapse>
}
