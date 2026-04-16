// News tab - Market Rundown configuration (replaces the X-API config).
// Two-step prompt flow: (1) build a structure outline, (2) generate today's
// briefing against that structure. The API lives at api/rundown.js.

import { useState } from 'react'
import Card from '../common/Card.jsx'
import Button from '../common/Button.jsx'
import {
  useStrategy,
  BRIEFING_WINDOWS,
  SOURCE_OPTIONS,
} from '../../lib/strategy-store.js'

async function callRundown(action, body = {}) {
  const res = await fetch('/api/rundown', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `rundown ${action} ${res.status}`)
  return data
}

export default function NewsTab() {
  const { state, dispatch } = useStrategy()
  const { briefingWindow, sources, structure, latestRundown, lastGeneratedAt } = state.news
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const onBuildStructure = async () => {
    setBusy('structure'); setError(null)
    try {
      const data = await callRundown('structure')
      dispatch({ type: 'NEWS_SET_STRUCTURE', structure: data.markdown ?? null })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  const onGenerate = async () => {
    setBusy('generate'); setError(null)
    try {
      const data = await callRundown('generate', { window: briefingWindow, sources, structure })
      dispatch({ type: 'NEWS_SET_RUNDOWN', rundown: data.markdown ?? null })
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="t-label mb-2">Market Rundown configuration</h2>
        <p className="t-sub text-[var(--color-text-sub)] mb-3">
          Generates a daily trading briefing from reputable sources (OSINet + wires).
          Replaces the X / Twitter feed used in v1.
        </p>
        <fieldset className="mb-3">
          <legend className="t-meta mb-1">Briefing window</legend>
          <div className="flex gap-4">
            {BRIEFING_WINDOWS.map((w) => (
              <label key={w} className="t-sub flex items-center gap-1 capitalize">
                <input
                  type="radio"
                  name="briefingWindow"
                  value={w}
                  checked={briefingWindow === w}
                  onChange={() => dispatch({ type: 'NEWS_SET_WINDOW', window: w })}
                />
                {w}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="t-meta mb-1">Sources</legend>
          <div className="flex gap-4 flex-wrap">
            {SOURCE_OPTIONS.map((s) => (
              <label key={s} className="t-sub flex items-center gap-1 capitalize">
                <input
                  type="checkbox"
                  checked={sources.includes(s)}
                  onChange={() => dispatch({ type: 'NEWS_TOGGLE_SOURCE', source: s })}
                />
                {s}
              </label>
            ))}
          </div>
        </fieldset>
      </Card>

      <Card>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="t-label flex-1">Structure (Prompt 1)</h2>
          <Button size="sm" variant="ghost" onClick={onBuildStructure} disabled={busy === 'structure'}>
            {busy === 'structure' ? 'Building...' : 'Rebuild'}
          </Button>
        </div>
        {structure ? (
          <pre className="t-meta whitespace-pre-wrap max-h-48 overflow-auto bg-[var(--color-bg)] p-2 rounded border border-[var(--color-border)]">{structure}</pre>
        ) : (
          <p className="t-sub text-[var(--color-text-sub)]">No structure cached. Click Rebuild to generate the markdown outline that every daily rundown will follow.</p>
        )}
      </Card>

      <Card>
        <div className="flex items-center gap-2 mb-2">
          <h2 className="t-label flex-1">Today's rundown (Prompt 2)</h2>
          <Button size="sm" onClick={onGenerate} disabled={busy === 'generate'}>
            {busy === 'generate' ? 'Generating...' : 'Generate'}
          </Button>
        </div>
        {error && <p className="t-sub text-[var(--color-down)] mb-2">{error}</p>}
        {lastGeneratedAt && (
          <p className="t-meta text-[var(--color-text-sub)] mb-2">
            Last generated {new Date(lastGeneratedAt).toLocaleString()}
          </p>
        )}
        {latestRundown ? (
          <pre className="t-meta whitespace-pre-wrap max-h-96 overflow-auto bg-[var(--color-bg)] p-2 rounded border border-[var(--color-border)]">{latestRundown}</pre>
        ) : (
          <p className="t-sub text-[var(--color-text-sub)]">No rundown yet. Click Generate to produce today's briefing.</p>
        )}
      </Card>
    </div>
  )
}
