// ---------------------------------------------------------------------------
// agent/services/book-close-volume.js — the volume a momentum-book close sends.
//
// Measured 09-09-2026 17:00 SGT: the book's rank exit on LLY.US (ACCT-DEMO-1)
// failed with `Message missing required fields: volume` (INVALID_REQUEST).
// Both book exit paths sent `{ positionId }` alone; cTrader's close request
// needs the volume, and the loop's own close paths (executeBrokerAction)
// resolve it from the broker's position first and the trade's lots × lot
// size second. This is that rule, shared by both book paths.
//
// Returns units (the broker's integer volume) or null when nothing can say —
// and a null is a close NOT sent, the row left open to retry next pass, with
// the reason in the summary. Guessing a volume here is a partial close or an
// oversized one; neither is what "exit" means.
// ---------------------------------------------------------------------------

export async function bookCloseVolume(db, creds, row, deps = {}) {
  // 1. The broker's own volume for this position — the authority.
  if (row?.position_id != null && typeof deps.positionVolume === 'function') {
    try {
      const v = Number(await deps.positionVolume(creds, row.position_id))
      if (Number.isFinite(v) && v > 0) return Math.round(v)
    } catch { /* fall through to the trade row */ }
  }
  // 2. The trade row's lots × the symbol's lot size.
  const t = row?.trade_id != null
    ? db.prepare('SELECT volume, symbol FROM trades WHERE id = ?').get(row.trade_id)
    : null
  const lots = Number(t?.volume)
  if (!(lots > 0) || typeof deps.symbolIdFor !== 'function' || typeof deps.volumeMeta !== 'function') return null
  try {
    const id = await deps.symbolIdFor(creds, String(row.symbol || t.symbol || '').toUpperCase())
    if (id == null) return null
    const meta = await deps.volumeMeta(creds, id)
    const lotSize = Number(meta?.lotSize)
    if (!(lotSize > 0)) return null
    const units = Math.round(lots * lotSize)
    return units > 0 ? units : null
  } catch { return null }
}
