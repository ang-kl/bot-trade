// CupHandleFunnelCard — the answer to "why doesn't Cup & Handle fire", read
// from data the scanner has been writing for weeks and nobody ever looked at.
//
// Owner, 05-08-2026: "why strategies are not traded". cup_handle and
// inv_cup_handle produced ZERO signals in seven days while the other armed
// strategies produced ~62,000 between them. StrategyLivenessCard can say the
// strategy is silent; it cannot say WHY. This can, because every scan has been
// running a diagnostic twin of the search alongside the real one and recording
// which gate stopped the best candidate. Production held 2,598,961 of those
// rows with no route to read them.
//
// READ IT DOWNWARDS. Each row is reached only by what survived the row above,
// so the first big drop is the binding constraint. That ordering is the entire
// value of the card: a flat list of gate counts cannot distinguish "this gate
// rarely blocks anything" from "almost nothing ever gets here", and those two
// call for opposite fixes — loosen the gate, versus stop wasting effort on it
// because the real problem is three rows higher.
//
// THE ROW THAT MEANS A BUG. "Cleared every gate" counts traces where a
// candidate passed everything. If that is above zero while the strategy shows
// no signals, the diagnostic twin has drifted from the search it mirrors —
// that is a code defect, not a market condition, and the card says so in words
// rather than leaving a suggestive number on screen.
import { useEffect, useState } from 'react'
import { agentGet } from '../lib/agent-api.js'
import Badge from './common/Badge.jsx'
import Segmented from './common/Segmented.jsx'

const BIAS = [
  { value: 'both', label: 'Both' },
  { value: 'long', label: 'Cup & Handle' },
  { value: 'short', label: 'Inverted' },
]
const DAYS = [
  { value: '1', label: '1d' },
  { value: '7', label: '7d' },
  { value: '30', label: '30d' },
]

// The three funnel rows that are not gates — they are the context every gate
// sits inside, and they are where the answer usually is.
const PRELUDE = new Set(['scanned', 'trend_context', 'cup_candidate'])

export default function CupHandleFunnelCard() {
  const [bias, setBias] = useState('both')
  const [days, setDays] = useState('7')
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let alive = true
    const q = `/state/cup-handle-funnel?days=${days}${bias === 'both' ? '' : `&bias=${bias}`}`
    // The error clears on SUCCESS, not at request time — clearing it up front
    // would blank a real failure for the length of the next request and make
    // an unreachable agent look like a slow one.
    agentGet(q)
      .then(r => { if (alive) { setData(r); setErr(null) } })
      .catch(e => { if (alive) setErr(e.message || String(e)) })
    return () => { alive = false }
  }, [bias, days])

  const stages = data?.stages || []
  const top = stages[0]?.reached || 0
  // The biggest single drop, so the eye lands on it without arithmetic.
  const worst = stages.reduce((a, b) => (b.stopped > (a?.stopped || 0) ? b : a), null)

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h3 className="t-h3">Cup &amp; Handle Silence table</h3>
        <Segmented label="Pattern direction" size="md" options={BIAS} value={bias} onChange={setBias} />
        <Segmented size="md" options={DAYS} value={days} onChange={setDays} />
        {data?.traces > 0 && (
          <span className="t-meta text-[var(--color-text-sub)]">
            {data.traces.toLocaleString()} traces · {data.symbols.toLocaleString()} symbols
          </span>
        )}
      </div>

      {err && <div className="t-body text-[var(--color-warning-text)]">Could not read the traces: {err}</div>}
      {!err && !data && <div className="t-body text-[var(--color-text-sub)]">Reading traces…</div>}

      {data && data.traces === 0 && (
        <div className="t-body text-[var(--color-text-sub)]">{data.verdict}</div>
      )}

      {data && data.traces > 0 && (
        <>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Reached</th>
                  <th>Stopped here</th>
                  <th>Share of the top</th>
                </tr>
              </thead>
              <tbody>
                {stages.map(s => {
                  const share = top ? (100 * s.reached) / top : 0
                  const dead = s.reached === 0
                  return (
                    <tr key={s.key} className={s === worst && s.stopped > 0 ? 'bg-[var(--color-warning-bg)]' : ''}>
                      <td className="py-1 pr-2">
                        {/* Gates are indented under the context rows they depend on —
                            the shape of the funnel should be visible, not inferred. */}
                        <span style={{ paddingLeft: PRELUDE.has(s.key) ? 0 : 12 }}>{s.label}</span>
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums">{s.reached.toLocaleString()}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">
                        {s.stopped ? s.stopped.toLocaleString() : <span className="text-[var(--color-text-sub)]">—</span>}
                      </td>
                      <td className="py-1 pr-2">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <div style={{
                            height: 6, width: 80, flexShrink: 0, borderRadius: 3,
                            background: 'var(--glass-bg)', overflow: 'hidden',
                          }}>
                            <div style={{
                              height: '100%', width: `${Math.max(0, Math.min(100, share))}%`,
                              background: dead ? 'var(--color-text-sub)' : 'var(--color-accent)',
                            }} />
                          </div>
                          <span className="t-meta tabular-nums text-[var(--color-text-sub)]">
                            {share >= 0.1 || share === 0 ? share.toFixed(1) : '<0.1'}%
                          </span>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            {data.wouldHaveFired > 0
              ? <Badge tone="down">{data.wouldHaveFired.toLocaleString()} cleared every gate</Badge>
              : <Badge tone="off">0 cleared every gate</Badge>}
            {data.deepestReached
              ? <Badge tone="info">Deepest reached: {data.deepestReached}</Badge>
              : <Badge tone="off">No gate was ever reached</Badge>}
          </div>
          <div className="mt-1 t-body text-[var(--color-text-sub)]">{data.verdict}</div>
        </>
      )}
    </div>
  )
}
