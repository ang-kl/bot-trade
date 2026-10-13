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

/**
 * Codex P1 on #1354 (owner: "Both"): the sheet's close, as a flow with its
 * effects injected. A partial asks the route for a PREVIEW first (the lots
 * stepped to the symbol's step, nothing sent), confirms THAT figure — saying
 * so when it differs from what was typed — and sends exactly it. Returns
 * { body } to post, or { error } / { cancelled: true }.
 *   preview(body) → POST /actions/position-close with preview:true; its reply (throws on a refusal)
 *   confirm(text) → boolean
 */
export async function closeFlow({ input, heldLots, heldText, symbol, side, positionId, preview, confirm }) {
  const req = closeRequest(input, heldLots)
  if (req.error) return { error: req.error }
  if (!req.partial) return confirm(`Close ${symbol} ${side} ${heldText} lots at market?`) ? { body: { positionId } } : { cancelled: true }
  let pv
  try { pv = await preview({ positionId, lots: req.lots }) } catch (err) { return { error: err?.message || String(err) } }
  if (!pv?.ok || !pv.preview) return { error: pv?.error || 'the close preview did not answer' }
  if (!pv.partial) return confirm(`Close ${symbol} ${side} ${heldText} lots at market? (${req.lots} reaches the whole position)`) ? { body: { positionId } } : { cancelled: true }
  const note = pv.lots !== req.lots ? `\n\n${req.lots} is not on the symbol's volume step: ${pv.lots} will close.` : ''
  return confirm(`Close ${symbol} ${side} ${pv.lots} of ${heldText} lots at market?${note}`) ? { body: { positionId, lots: pv.lots } } : { cancelled: true }
}
