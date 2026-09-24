// Read-model only: the registry's ordinary families use scan_dispatch; the
// momentum family uses the daily/account and cross-sectional book paths.
// This describes those automatic bar paths, NOT manual orders or tick-entry
// readiness. Retirement reasons come from entry-producers.js, never a second
// on/off flag. A new family must be mapped explicitly instead of reading ready.
const FAMILY_PRODUCERS = Object.freeze({
  mean_reversion: ['scan_dispatch'],
  breakout: ['scan_dispatch'],
  trend: ['scan_dispatch'],
  momentum: ['daily_momentum_account', 'cross_sectional_book'],
})

export function automaticProducerAvailability(family, inventory) {
  const ids = Object.hasOwn(FAMILY_PRODUCERS, family) ? FAMILY_PRODUCERS[family] : []
  const source = Array.isArray(inventory) ? inventory : []
  const producers = ids.map(id => {
    const matches = source.filter(p => p?.id === id && p.family === 'automatic' && p.basis === 'bar')
    const found = matches.length === 1
    return { id, found, retired: found ? !!matches[0].retired : null,
      reason: found ? matches[0].retired || null : 'producer inventory missing or ambiguous' }
  })
  const known = producers.length > 0 && producers.every(p => p.found)
  const available = known && producers.some(p => !p.retired)
  const state = !known ? 'unknown' : available ? 'available' : 'retired'
  const reason = !known ? 'Automatic bar producer mapping is not verifiable'
    : available ? null : producers.map(p => `${p.id}: ${p.reason}`).join('; ')
  return { scope: 'automatic_bar_producers', state, available, reason, producers }
}
