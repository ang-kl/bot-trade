// Per-symbol strategy picker — which of the armed strategies may trade a row.
//
// Owner (2026-07-29): "Does each watchlist symbol has certain strategy? …
// Are you saying right now there are 12 strategies in the backtest and in
// performance page, and each symbol can only store two"
//
// It could not, until now: `enabled_strategies_json` is a single GLOBAL list,
// so every symbol ran the same armed set. The "two" on a row was
// `allowed_styles` — scalp/day/swing/mid-term — which is a holding-period
// bucket, not a strategy.
//
// A pick here can only NARROW the armed set. Arming happens in Tune >
// Strategies and nowhere else: a row that could arm a globally-disarmed
// strategy would be a back door for an unproven edge to reach capital, which
// is precisely why fvg_retrace ships disarmed. Disarmed entries are shown
// anyway — greyed, with the reason — because hiding them would make "why
// isn't this one listed" a mystery.
import { useState } from 'react'
import Button from '../common/Button.jsx'

export default function StrategyPicker({ all = [], value = null, onChange, onCancel, label = '' }) {
  // null = follow the global set. An empty Set is a REAL, different state:
  // "nothing may trade this symbol". The two must not collapse into one.
  const [sel, setSel] = useState(() => (Array.isArray(value) && value.length ? new Set(value) : null))
  const armed = all.filter(s => s.on)
  const following = sel === null

  const toggle = (key) => setSel(prev => {
    // First tick starts from the armed set, so picking is subtractive from
    // what is running today rather than starting at nothing — otherwise one
    // tap would silently disable every other strategy on the symbol.
    const next = new Set(prev === null ? armed.map(s => s.key) : prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  const effective = following ? armed.map(s => s.key) : armed.filter(s => sel.has(s.key)).map(s => s.key)

  return (
    <div className="text-[9px]">
      <div className="flex flex-wrap items-center gap-2 mb-1.5">
        <span className="font-semibold">{label} — strategies allowed to trade it</span>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input type="checkbox" checked={following} onChange={() => setSel(following ? new Set(armed.map(s => s.key)) : null)} />
          <span>Follow Tune &gt; Strategies ({armed.length} armed)</span>
        </label>
      </div>

      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {all.map(s => {
          const on = following ? s.on : sel.has(s.key)
          return (
            <label key={s.key} className={`flex items-center gap-1.5 ${s.on ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
              <input
                type="checkbox"
                checked={on && s.on}
                disabled={!s.on || following}
                onChange={() => toggle(s.key)}
                aria-label={s.name}
              />
              <span className={s.on ? '' : 'text-[var(--color-text-sub)]'}>{s.name}</span>
              {!s.on && <span className="text-[var(--color-text-sub)]" title="Disarmed in Tune > Strategies — a symbol cannot arm it">(disarmed)</span>}
            </label>
          )
        })}
      </div>

      {!following && effective.length === 0 && (
        <p className="mt-1.5 font-bold text-[var(--color-down)]">
          Nothing selected is armed — saving this stops {label} trading entirely.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="sm" className="!px-2 !py-0.5 !min-h-0 text-[9px]"
          onClick={() => onChange(following ? null : [...sel])}>
          Save
        </Button>
        <Button size="sm" variant="subtle" className="!px-2 !py-0.5 !min-h-0 text-[9px]" onClick={onCancel}>Cancel</Button>
        <span className="text-[var(--color-text-sub)]">
          {following
            ? `Following the global set — ${armed.length} strategies may trade ${label}.`
            : `${effective.length} of ${armed.length} armed strategies may trade ${label}.`}
        </span>
      </div>
    </div>
  )
}
