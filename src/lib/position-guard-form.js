// PR-F (owner principle 6): PositionManager's trailing / break-even pip
// fields used to START at 10 / 15 / 3 and were shown as the position's
// settings whether or not a guard existed — a reader saw "break-even 15/3"
// on a position that had no break-even rule at all. The form now starts
// EMPTY and fills only from what /actions/position-guard-get returns; a
// field with no stored value is labelled "not set" and an apply with a
// switched-on rule whose pips are empty is refused, never written as 0.
//
// Pure: the sheet's state is derived here so it can be tested without
// rendering effects.

export const EMPTY_TPS = () => [
  { on: false, price: '', lots: '' },
  { on: false, price: '', lots: '' },
  { on: false, price: '', lots: '' },
]

export const EMPTY_GUARD_FORM = () => ({
  trailOn: false, trailPips: '',
  beOn: false, beTrigger: '', beOffset: '',
  extraTps: EMPTY_TPS(),
})

const str = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : String(v))

/**
 * Map the guard-get response to form state.
 * @returns {{ status: 'not_set'|'stored'|'not_monitored', form }}
 *   status 'not_monitored' — the agent has no monitored row for this position
 *   (r.monitored === false); 'not_set' — monitored but no guard stored;
 *   'stored' — a guard exists (fields carry ONLY the values it holds).
 */
export function guardFormState(r) {
  const form = EMPTY_GUARD_FORM()
  if (!r || typeof r !== 'object') return { status: 'not_set', form }
  if (r.monitored === false) return { status: 'not_monitored', form }
  const g = r.guard
  if (!g || typeof g !== 'object') return { status: 'not_set', form }
  if (g.breakEven && typeof g.breakEven === 'object') {
    form.beOn = !!g.breakEven.on
    form.beTrigger = str(g.breakEven.triggerPips)
    form.beOffset = str(g.breakEven.offsetPips)
  }
  if (g.trailing && typeof g.trailing === 'object') {
    form.trailOn = !!g.trailing.on
    form.trailPips = str(g.trailing.distancePips)
  }
  if (Array.isArray(g.takeProfits)) {
    form.extraTps = [0, 1, 2].map(i => (g.takeProfits[i]
      ? { on: !g.takeProfits[i].done, price: str(g.takeProfits[i].price), lots: str(g.takeProfits[i].lots) }
      : { on: false, price: '', lots: '' }))
  }
  return { status: 'stored', form }
}

/** Why an apply must be refused, or null when every switched-on rule has its pips. */
export function guardApplyBlocker({ trailOn, trailPips, beOn, beTrigger, beOffset }) {
  if (trailOn && !(Number(trailPips) > 0)) return 'trailing stop is ON but its distance is not set'
  if (beOn && !(Number(beTrigger) > 0)) return 'break-even is ON but its trigger is not set'
  // Number('') is 0, so an empty offset must be caught by name — 0 is a valid offset.
  if (beOn && (beOffset === '' || beOffset == null || !(Number(beOffset) >= 0))) return 'break-even is ON but its offset is not set'
  return null
}
