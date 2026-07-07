// FolioTabs — Chrome-style folder tab strip. One panel visible at a time.
// Active tab reads by SHAPE (raised, joined to the panel, bold), never by
// colour alone — colour-blind safe. Keyboard: ← → Home End move focus+selection.
// Panel is a .glass-panel so it matches the Ultra Neo Glass cards.
import { useRef } from 'react'

export default function FolioTabs({ tabs, active, onChange, children }) {
  const refs = useRef({})

  const onKeyDown = (e) => {
    const idx = tabs.findIndex(t => t.id === active)
    let next = null
    if (e.key === 'ArrowRight') next = tabs[(idx + 1) % tabs.length]
    else if (e.key === 'ArrowLeft') next = tabs[(idx - 1 + tabs.length) % tabs.length]
    else if (e.key === 'Home') next = tabs[0]
    else if (e.key === 'End') next = tabs[tabs.length - 1]
    if (next) {
      e.preventDefault()
      onChange(next.id)
      refs.current[next.id]?.focus()
    }
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label="Tune sections"
        onKeyDown={onKeyDown}
        className="flex items-end gap-1 overflow-x-auto px-2 relative z-10 -mb-[1px]"
      >
        {tabs.map(t => {
          const on = t.id === active
          return (
            <button
              key={t.id}
              ref={el => { refs.current[t.id] = el }}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={on}
              aria-controls={`panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              type="button"
              onClick={() => onChange(t.id)}
              className={`shrink-0 rounded-t-[12px] border border-b-0 px-4 text-[13px] cursor-pointer transition-colors min-h-[44px] ${
                on
                  ? 'bg-[var(--color-surface)] border-[var(--color-border)] font-bold text-[var(--color-text)] pt-2.5 pb-3'
                  : 'bg-transparent border-transparent font-medium text-[var(--color-text-sub)] pt-3 pb-2.5 hover:text-[var(--color-text)]'
              }`}
            >
              {t.label}
            </button>
          )
        })}
      </div>
      <div
        role="tabpanel"
        id={`panel-${active}`}
        aria-labelledby={`tab-${active}`}
        className="glass-panel rounded-tl-none px-4 py-3.5 text-[var(--color-text)]"
      >
        {children}
      </div>
    </div>
  )
}
