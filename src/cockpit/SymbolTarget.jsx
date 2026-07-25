// symbol-click-spec §1–§3 — one component owns the click contract so
// behaviour can never drift per surface. Renders the child as-is and attaches
// the contract: role=button, tabIndex 0, Enter/Space open, hover/focus
// affordance, ?trade=<positionId> pushState (in-place swaps use replaceState
// via swapCockpit). Aggregate rows simply don't get wrapped.
import { useCallback } from 'react'
import { openCockpit, toast } from './cockpit-nav.js'

export default function SymbolTarget({ symbol, positionId, source, children }) {
  const open = useCallback(() => {
    if (positionId != null) { openCockpit(positionId); return }
    // symbol-only resolution (spec §2 steps 2–5) needs /api/symbols/:symbol/positions,
    // which the agent does not expose yet (open question in the PR). Until it
    // exists, unknown resolution honestly shows the §2.5 toast.
    toast(`no position history for ${symbol}`)
  }, [positionId, symbol])
  return (
    <span role="button" tabIndex={0} data-symbol-target={source}
      onClick={open}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--acs)'; e.currentTarget.style.cursor = 'pointer' }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
      onFocus={e => { e.currentTarget.style.outline = '1px solid var(--acc)'; e.currentTarget.style.outlineOffset = '2px' }}
      onBlur={e => { e.currentTarget.style.outline = 'none' }}>
      {children}
    </span>
  )
}
