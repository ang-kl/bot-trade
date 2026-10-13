// Claude · № 14,050 13-Oct (owner: "build the partial close lots field"; claude-builder).
// The volume a manual close sends, in the broker's protocol units. With no
// lots, the whole position. With lots, round(lots × lotSize) stepped DOWN to
// the symbol's stepVolume (cTrader refuses an off-step volume), capped at the
// position, and refused below the symbol's minVolume. `meta` is the symbol
// record from getVolumeMeta.
//
// Codex P1 on #1354 (owner: "Both"): the confirm showed the typed figure while
// this stepped it down silently. `lots` in every reply is what the volume
// closes, so the sheet's preview can show it; with `strict` (the real close)
// a figure off the symbol's step is refused, naming the two valid figures
// either side, instead of being rounded.
export function partialCloseVolume({ positionVolume, lots, meta, strict = false }) {
  const pos = Number(positionVolume)
  const lotSize = Number(meta?.lotSize)
  const toLots = u => lotSize > 0 && Number.isFinite(u) ? Number((u / lotSize).toFixed(8)) : null
  if (lots == null || !(Number(lots) > 0)) return { volume: pos, lots: toLots(pos), partial: false, error: null }
  const raw = Math.round(Number(lots) * lotSize)
  let v = raw
  const step = Number(meta?.stepVolume)
  if (step > 0) v = Math.floor(v / step) * step
  if (v >= pos) return { volume: pos, lots: toLots(pos), partial: false, error: null }
  if (strict && step > 0 && v !== raw) {
    return { volume: null, lots: null, partial: false, error: `lots to close must be on the symbol's step of ${toLots(step)} lots: ${toLots(v)} or ${toLots(v + step)}` }
  }
  const min = Number(meta?.minVolume)
  if (!(v > 0) || (min > 0 && v < min)) {
    const minLots = min > 0 && Number(meta?.lotSize) > 0 ? min / Number(meta.lotSize) : null
    return { volume: null, lots: null, partial: false, error: `lots to close are below the symbol's minimum${minLots != null ? ` (${minLots} lots)` : ''}` }
  }
  return { volume: v, lots: toLots(v), partial: true, error: null }
}
