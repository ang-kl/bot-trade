// Claude · № 14,050 13-Oct (owner: "build the partial close lots field"; claude-builder).
// The position sheet's Close with an optional lots field. Empty = the whole
// position (the route closes all of it with no `lots`). A figure below the
// held lots is a partial close; at or above, the whole position. Bad input is
// refused here with a reason and never sent.
export function closeRequest(input, heldLots) {
  const raw = String(input ?? '').trim()
  if (raw === '') return { lots: null, partial: false, error: null }
  const lots = /^\d*\.?\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isFinite(lots) || lots <= 0) return { lots: null, partial: false, error: 'lots to close must be a positive number' }
  const held = Number(heldLots)
  if (Number.isFinite(held) && held > 0 && lots >= held) return { lots: null, partial: false, error: null }
  return { lots, partial: true, error: null }
}
