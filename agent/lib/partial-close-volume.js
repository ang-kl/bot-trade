// Claude · № 14,050 13-Oct (owner: "build the partial close lots field"; claude-builder).
// The volume a manual close sends, in the broker's protocol units. With no
// lots, the whole position. With lots, round(lots × lotSize) stepped DOWN to
// the symbol's stepVolume (cTrader refuses an off-step volume), capped at the
// position, and refused below the symbol's minVolume. `meta` is the symbol
// record from getVolumeMeta.
export function partialCloseVolume({ positionVolume, lots, meta }) {
  const pos = Number(positionVolume)
  if (lots == null || !(Number(lots) > 0)) return { volume: pos, partial: false, error: null }
  let v = Math.round(Number(lots) * Number(meta?.lotSize))
  const step = Number(meta?.stepVolume)
  if (step > 0) v = Math.floor(v / step) * step
  if (v >= pos) return { volume: pos, partial: false, error: null }
  const min = Number(meta?.minVolume)
  if (!(v > 0) || (min > 0 && v < min)) {
    const minLots = min > 0 && Number(meta?.lotSize) > 0 ? min / Number(meta.lotSize) : null
    return { volume: null, partial: false, error: `lots to close are below the symbol's minimum${minLots != null ? ` (${minLots} lots)` : ''}` }
  }
  return { volume: v, partial: true, error: null }
}
