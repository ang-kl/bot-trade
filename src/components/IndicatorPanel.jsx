// IndicatorPanel — compact toggle strip for chart overlays.
// Shown only on the full (non-grid, non-historical) chart. Choices persist
// in localStorage 'chart_indicators_v1'. Colour-blind owner rule: state is
// carried by aria-pressed + filled/outline shape, never red/green.
import { useEffect, useState } from 'react'

const STORAGE_KEY = 'chart_indicators_v1'

// Order matters: this is the render order of the strip.
// eslint-disable-next-line react-refresh/only-export-components -- tiny id list, belongs with the panel
export const INDICATOR_IDS = ['sma20', 'sma50', 'sma200', 'ema20', 'ema50', 'vwap', 'avwap', 'fvg', 'vp']
const LABELS = {
  sma20: 'SMA20', sma50: 'SMA50', sma200: 'SMA200',
  ema20: 'EMA20', ema50: 'EMA50',
  vwap: 'VWAP', avwap: 'AVWAP', fvg: 'FVG', vp: 'VP',
}
const VP_TYPES = ['session', 'visible', 'fixed', 'composite']

// eslint-disable-next-line react-refresh/only-export-components -- prefs loader shared with PositionChart
export function loadIndicatorPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')
    return {
      indicators: Array.isArray(raw.indicators) ? raw.indicators.filter(i => INDICATOR_IDS.includes(i)) : [],
      vpType: VP_TYPES.includes(raw.vpType) ? raw.vpType : 'session',
    }
  } catch {
    return { indicators: [], vpType: 'session' }
  }
}

// value: { indicators: string[], vpType }, onChange(next)
// avwapArmed/onArmAvwap: parent-owned "click the chart to set anchor" flow.
export default function IndicatorPanel({ value, onChange, avwapArmed = false, onArmAvwap }) {
  const [prefs, setPrefs] = useState(value)
  useEffect(() => { setPrefs(value) }, [value])

  const commit = (next) => {
    setPrefs(next)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* private mode: prefs just don't persist */ }
    onChange?.(next)
  }
  const toggle = (id) => {
    const on = prefs.indicators.includes(id)
    commit({ ...prefs, indicators: on ? prefs.indicators.filter(i => i !== id) : [...prefs.indicators, id] })
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-1.5" role="group" aria-label="Chart indicators">
      {INDICATOR_IDS.map(id => {
        const on = prefs.indicators.includes(id)
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(id)}
            // ≥28px touch target via min-height; state = fill + aria, not hue pair
            className={`rounded-full px-2 min-h-[28px] text-[11px] font-semibold cursor-pointer ${
              on ? 'bg-[var(--color-accent)] text-white' : 'glass-inset text-[var(--color-text-sub)]'
            }`}
          >{LABELS[id]}</button>
        )
      })}
      {prefs.indicators.includes('vp') && (
        <select
          aria-label="Volume profile type"
          value={prefs.vpType}
          onChange={e => commit({ ...prefs, vpType: e.target.value })}
          className="glass-inset rounded-full px-2 min-h-[28px] text-[11px] text-[var(--color-text-sub)] bg-transparent cursor-pointer"
        >
          {VP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      )}
      {prefs.indicators.includes('avwap') && (
        <button
          type="button"
          aria-pressed={avwapArmed}
          onClick={() => onArmAvwap?.()}
          className={`rounded-full px-2 min-h-[28px] text-[11px] font-semibold cursor-pointer ${
            avwapArmed ? 'bg-[var(--orange,#c2410c)] text-white' : 'glass-inset text-[var(--color-text-sub)]'
          }`}
        >{avwapArmed ? 'click chart…' : 'set AVWAP anchor'}</button>
      )}
    </div>
  )
}
