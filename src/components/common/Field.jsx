// The uniform labelled field: label left, fixed-width input right, optional
// unit chip and an ℹ️ that expands the explanation under the row.
//
// EXTRACTED FROM Risk.jsx (UI-6, 2026-07-29) so the Tune page's controls can
// look and behave the same way instead of each one inventing its own
// label+input pair. Nothing about the Risk page's rendering changed in the
// move — the same markup, the same classes, the same widths.
//
// Two behaviours live here because two pages need different ones:
//
//   · Risk edits into local state and commits with a Save button, so it
//     passes onChange only.
//   · Tune's controls post to their action route the moment you leave the
//     field, so they pass onChange (to track the draft) AND onCommit (fired
//     on blur). Without that split, a Tune field wired to onChange alone
//     would POST on every keystroke — "5" on the way to "50" would be sent
//     as a real setting.
import { useState } from 'react'
import Input from './Input.jsx'
import { parseDurationToMinutes, formatMinutesShort } from '../../lib/duration-input.js'

// EVERY entry field is the SAME fixed width (owner 2026-07-24: "the size of
// field-entry must be uniform as I am OCD"), 26px tall on desktop and 44px
// on a phone. Those classes — including the load-bearing `!important`
// prefixes that beat Input's own `w-full` and the unlayered input font-size
// rule — now live in Input's `density="compact"` variant (contract §6), so
// this file no longer repeats them per call site. `FIELD_W` stays exported
// for any external caller composing the same width by hand.
export const FIELD_W = '!w-[76px]'

// `unit` renders a fixed chip after the input ($, %, min, ×SL, h…) so every
// number on the page declares what it is measured in (owner 2026-07-28: the
// mixed decimals/percentages/dollars were unreadable without labels).
export function Unit({ children }) {
  return <span className="text-[8px] text-[var(--color-text-sub)] border border-[var(--glass-edge)] rounded-[1px] px-1 py-px min-w-[24px] text-center shrink-0">{children}</span>
}

// UI-4 — the "(default)" suffix was TEN characters on ~19 labels, in columns
// whose label budget is roughly 19-30 characters at 9px. It, not the wording,
// was what pushed labels onto a second line. It is now a single dimmed dot
// with the meaning in its tooltip.
//
// It travels as a suffix on the label STRING rather than a prop because
// `mark()` is called inside template literals at ~19 sites and `Field` is
// declared outside the component that knows which values are overridden.
// Field strips the sentinel and renders it properly styled.
export const DEFAULT_MARK = ' ·'   // thin space + middle dot

// The text box behind Field's `duration` mode. Stores plain MINUTES — the
// unit every consumer already expects (risk.js: cooldownMinutes * 60_000) —
// and only ever emits a parsed value, so a half-typed "5" on the way to "5h"
// cannot commit 5 minutes as if it were the answer.
function DurationField({ value, onChange, onCommit, placeholder }) {
  const [text, setText] = useState(() => formatMinutesShort(value))
  const [invalid, setInvalid] = useState(false)
  const [lastEmitted, setLastEmitted] = useState(value)
  if (value !== lastEmitted) {
    setLastEmitted(value)
    setText(formatMinutesShort(value))
    setInvalid(false)
  }
  return (
    <Input type="text" value={text} placeholder={placeholder} density="compact"
      aria-invalid={invalid || undefined}
      title="Type a number of minutes, or a duration like 90s / 5m / 2h"
      className={invalid ? 'border-[var(--color-down)]' : ''}
      onBlur={() => { if (!invalid && onCommit) onCommit() }}
      onChange={e => {
        const raw = e.target.value
        setText(raw)
        if (raw === '') { setInvalid(false); setLastEmitted(null); onChange(null); return }
        const mins = parseDurationToMinutes(raw)
        if (mins == null) { setInvalid(true); return }
        setInvalid(false)
        setLastEmitted(mins)
        onChange(mins)
      }} />
  )
}

/**
 * @param pct       edit in % but store the fraction
 * @param duration  accept "90s"/"5m"/"2h" and store minutes
 * @param onCommit  fired on blur — for fields that POST directly rather than
 *                  waiting for a Save button. Omit for Save-button pages.
 */
/**
 * `applied` — this field's value was just written by a Re-Risk apply (owner
 * 2026-08-01: "highlight in the field below it to show which one applied").
 * Renders an APPLIED tag on the label and an accent edge on the input, so the
 * confirmation lives on the real setting, not only in the proposals table.
 */
export default function Field({
  label, value, onChange, onCommit = null, pct = false, unit, hint, recommend,
  placeholder = 'not set', duration = false, min, max, step = 'any', applied = false,
}) {
  const [showHint, setShowHint] = useState(false)
  const display = value == null ? '' : pct ? Number((value * 100).toFixed(4)) : value
  const isDefault = typeof label === 'string' && label.endsWith(DEFAULT_MARK)
  const text = isDefault ? label.slice(0, -DEFAULT_MARK.length) : label
  return (
    <div className="text-[9px]">
      <label className="flex items-center justify-between gap-2">
        <span className="text-[var(--color-text-sub)] min-w-0 leading-tight">
          {text}
          {applied && (
            <span className="ml-1 text-[8px] font-semibold uppercase text-[var(--color-accent)]"
              title="This value was set by the last Re-Risk apply">applied</span>
          )}
          {isDefault && (
            <span className="opacity-40 ml-0.5" title="Still on the built-in default — this value has not been changed">·</span>
          )}
          {hint && (
            <button type="button" aria-label={`Explain: ${label}`} title={hint}
              onClick={e => { e.preventDefault(); setShowHint(s => !s) }}
              className="info-i">ℹ️</button>
          )}
        </span>
        <span className="flex items-center gap-1 shrink-0">
          {duration
            ? <DurationField value={value} onChange={onChange} onCommit={onCommit} placeholder={placeholder} />
            : <Input type="number" step={step} min={min} max={max} value={display} placeholder={placeholder}
                aria-label={typeof label === 'string' ? text : undefined}
                density="compact"
                className={applied ? '!border-[var(--color-accent)]' : ''}
                onBlur={() => { if (onCommit) onCommit() }}
                onChange={e => {
                  const raw = e.target.value
                  if (raw === '') { onChange(null); return }
                  const n = Number(raw)
                  if (!Number.isFinite(n)) return
                  onChange(pct ? n / 100 : n)
                }} />}
          {(pct || unit) && !duration && <Unit>{pct ? '%' : unit}</Unit>}
        </span>
      </label>
      {showHint && (
        <p className="text-[9px] text-[var(--color-text-sub)] mt-0.5 leading-snug">
          {hint}
          {recommend && <><br /><span className="text-[var(--color-accent)]">bot-trade recommends: {recommend}</span></>}
        </p>
      )}
    </div>
  )
}
