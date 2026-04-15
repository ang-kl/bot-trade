// Modal for adjusting a position's stop-loss. Wiring to the actual
// api/ctrader.js amend-position action lives in Feed.jsx, which passes
// onConfirm(nextSL, story).

import { useState } from 'react'
import Card from '../common/Card.jsx'
import Input from '../common/Input.jsx'
import Button from '../common/Button.jsx'

export default function TightenSLDialog({ story, onConfirm, onCancel }) {
  const [value, setValue] = useState(
    story.stopLoss != null && Number.isFinite(story.stopLoss) ? String(story.stopLoss) : ''
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const apply = async () => {
    const next = Number(value)
    if (!Number.isFinite(next)) {
      setError('Enter a valid number')
      return
    }
    setBusy(true); setError(null)
    try {
      await onConfirm?.(next, story)
    } catch (e) {
      setError(e?.message || 'failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Tighten stop loss for ${story.symbol}`}
      className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-20"
    >
      <Card className="w-full max-w-sm">
        <h3 className="font-semibold mb-2">Tighten SL — {story.symbol}</h3>
        <p className="text-xs text-[var(--color-fg-subtle)] mb-3">
          Current SL: {story.stopLoss ?? '—'} · Entry: {story.entryPrice ?? '—'}
        </p>
        <label className="block text-xs mb-1" htmlFor="tighten-sl-value">New stop-loss</label>
        <Input
          id="tighten-sl-value"
          type="number"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mb-3"
        />
        {error && <p className="text-sm text-[var(--color-down)] mb-2">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={apply} disabled={busy}>
            {busy ? 'Applying…' : 'Apply'}
          </Button>
        </div>
      </Card>
    </div>
  )
}
