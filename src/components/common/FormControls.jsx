// FormControls — proper inputs per the design-system reference the owner
// supplied (labeled states, styled menus, editable values everywhere):
//
// SliderInput  — editable number box (type any value) + slider in one field.
// PresetSelect — styled dropdown menu (NOT the native <select>) whose last
//                row is a "Custom…" input, so every choice can be keyed in.
//
// Both: 12px label, glass-inset resting state, accent focus ring, 40px
// min target, keyboard accessible (Esc closes menus, Enter commits).
import { useEffect, useRef, useState } from 'react'

export function SliderInput({ label, value, onChange, min, max, step, display = v => String(v), parse = v => v, toInput = v => v, unit = '' }) {
  // toInput: model→editable text (e.g. fraction→percent); parse: text→model
  const [text, setText] = useState(null) // null = mirror the model
  const num = Number(value)
  const shown = text != null ? text : (Number.isFinite(num) ? String(toInput(num)) : '')
  const commit = () => {
    if (text == null) return
    const v = parse(Number(text))
    if (Number.isFinite(v)) onChange(v)
    setText(null)
  }
  return (
    <label className="block text-[12px]">
      <span className="flex items-baseline justify-between text-[var(--color-text-sub)]">
        {label}
        <span className="inline-flex items-center gap-1">
          <input
            type="number" step="any" value={shown}
            onChange={e => setText(e.target.value)}
            onBlur={commit}
            onKeyDown={e => e.key === 'Enter' && (commit(), e.target.blur())}
            className="glass-inset w-20 rounded-[8px] px-2 py-1 text-right text-[13px] font-semibold text-[var(--color-text)] focus:outline-2 focus:outline-[var(--color-accent)] bg-transparent"
            aria-label={`${label} value`}
          />
          {unit && <span className="text-[12px]">{unit}</span>}
        </span>
      </span>
      <input
        type="range" min={min} max={max} step={step}
        value={Number.isFinite(num) ? num : min}
        onChange={e => { setText(null); onChange(Number(e.target.value)) }}
        className="w-full accent-[var(--color-accent)] cursor-pointer mt-2"
      />
      <span className="flex justify-between text-[10px] text-[var(--color-text-sub)]">
        <span>{display(min)}</span><span>{display(max)}</span>
      </span>
    </label>
  )
}

export function PresetSelect({ label, value, onChange, options, display = v => String(v), parse = v => v, unit = '' }) {
  const [open, setOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const boxRef = useRef(null)
  const num = Number(value)
  const current = options.find(([v]) => Number(v) === num)

  useEffect(() => {
    if (!open) return undefined
    const close = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    const esc = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  const commitCustom = () => {
    const v = parse(Number(custom))
    if (Number.isFinite(v)) { onChange(v); setCustom(''); setOpen(false) }
  }

  return (
    <div className="block text-[12px] relative" ref={boxRef}>
      <span className="text-[var(--color-text-sub)]">{label}</span>
      <button
        type="button" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="glass-inset mt-1 w-full rounded-[9px] px-3 py-2 text-left text-[13px] min-h-[40px] cursor-pointer flex items-center justify-between gap-2 focus:outline-2 focus:outline-[var(--color-accent)]"
      >
        <span className="font-semibold text-[var(--color-text)]">{current ? current[1] : `${display(num)} (custom)`}</span>
        <span aria-hidden="true" className={`text-[10px] text-[var(--color-text-sub)] transition-transform ${open ? 'rotate-180' : ''}`}>▼</span>
      </button>
      {open && (
        <div role="listbox" className="glass-panel absolute z-30 mt-1 w-full rounded-[12px] p-1.5 shadow-xl">
          {options.map(([v, text]) => {
            const active = Number(v) === num
            return (
              <button
                key={v} type="button" role="option" aria-selected={active}
                onClick={() => { onChange(Number(v)); setOpen(false) }}
                className={`w-full text-left rounded-[8px] px-3 py-2 text-[13px] cursor-pointer flex items-center justify-between ${
                  active ? 'bg-[var(--color-accent)] text-white font-semibold' : 'hover:bg-[var(--color-accent-soft)] text-[var(--color-text)]'
                }`}
              >
                {text}{active && <span aria-hidden="true">✓</span>}
              </button>
            )
          })}
          <div className="border-t border-[var(--color-border)] mt-1 pt-1.5 px-1 pb-0.5 flex items-center gap-1.5">
            <input
              type="number" step="any" value={custom} placeholder="Custom…"
              onChange={e => setCustom(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && commitCustom()}
              className="glass-inset flex-1 min-w-0 rounded-[8px] px-2 py-1.5 text-[13px] bg-transparent focus:outline-2 focus:outline-[var(--color-accent)]"
              aria-label={`Custom ${label}`}
            />
            {unit && <span className="text-[12px] text-[var(--color-text-sub)]">{unit}</span>}
            <button type="button" onClick={commitCustom} className="rounded-[8px] bg-[var(--color-accent)] text-white text-[12px] font-semibold px-2.5 py-1.5 cursor-pointer">Set</button>
          </div>
        </div>
      )}
    </div>
  )
}
