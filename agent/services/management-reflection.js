// ---------------------------------------------------------------------------
// agent/services/management-reflection.js — what the MANAGEMENT of a trade did,
// and what that says about how the desk manages trades.
//
// §70.10: "Connect management history to reflection and controlled adaptation."
//
// THE GAP. P10 gave every stop move, scale-out, trail arm and close its own row
// in `position_events`. Reflection, meanwhile, reads `trades` — entry, exit,
// net P&L — and produces lessons about ENTRIES. So the entire middle of a
// trade, the part WS-05 exists for, has been written down for weeks and read by
// nobody. A trade that entered well, was managed badly and closed flat is
// indistinguishable in the lesson stream from a trade that never had an edge.
//
// WHAT THIS PRODUCES, and what it deliberately does not. It produces the
// management NARRATIVE of a closed trade and a small set of observations over
// many of them. It does not tune anything. §70.10 says "and controlled
// adaptation", and the control is that a human — or the existing lessons tuner,
// deliberately — decides what to do with an observation. An analysis module
// that also changed thresholds would be adapting on its own evidence with no
// step in between, which is the opposite of controlled.
//
// EVERY OBSERVATION CARRIES ITS SAMPLE SIZE, for the reason this codebase keeps
// relearning: `n` is what separates a finding from a coincidence, and an
// observation quoted without it reads as settled. Below `MIN_SAMPLE` an
// observation is still returned, flagged `provisional`, rather than hidden —
// suppressing it would leave the reader thinking nothing was seen.
// ---------------------------------------------------------------------------

/** Under this many trades, an observation is labelled provisional, not hidden. */
export const MIN_SAMPLE = 12

/** Event kinds that constitute MANAGEMENT, as opposed to the trade's own life. */
const MANAGEMENT_KINDS = new Set(['sl_moved', 'tp_moved', 'scale_out', 'trail_armed'])

/**
 * The management story of ONE closed trade: what touched it, in order, and by
 * whose authority.
 *
 * Returns null when the trade has no management events at all — which is itself
 * a fact worth having, and the caller reports it as `unmanaged` rather than
 * silently skipping the trade.
 */
export function managementNarrative(db, { tradeId = null, positionId = null } = {}) {
  if (tradeId == null && positionId == null) return null
  let rows = []
  try {
    rows = db.prepare(`
      SELECT kind, source, reason, from_value, to_value, r_at, at
        FROM position_events
       WHERE ${tradeId != null ? 'trade_id = ?' : 'position_id = ?'}
       ORDER BY id
    `).all(tradeId != null ? tradeId : String(positionId))
  } catch { return null }
  if (!rows.length) return null

  const touches = rows.filter(r => MANAGEMENT_KINDS.has(r.kind))
  return {
    events: rows.length,
    managementTouches: touches.length,
    // WHO managed it. A trade touched by four different writers is a different
    // object from one touched four times by the same writer, and the §41
    // authority question ("who was allowed to") starts here.
    sources: [...new Set(rows.map(r => r.source).filter(Boolean))],
    kinds: [...new Set(rows.map(r => r.kind))],
    stopMoves: rows.filter(r => r.kind === 'sl_moved').length,
    targetMoves: rows.filter(r => r.kind === 'tp_moved').length,
    scaleOuts: rows.filter(r => r.kind === 'scale_out').length,
    trailArmed: rows.some(r => r.kind === 'trail_armed'),
    firstAt: rows[0]?.at ?? null,
    lastAt: rows[rows.length - 1]?.at ?? null,
  }
}

/**
 * Observations across recently closed trades, each with its sample size.
 *
 * The three questions asked here are the ones WS-05's own record can answer and
 * the entry-focused lesson stream cannot:
 *
 *   1. How many closed trades were MANAGED AT ALL? A high unmanaged share means
 *      the layers exist and are not reaching positions — which is exactly what
 *      "the 5-minute loop is the sole protector" looks like from the outside.
 *   2. Does management correlate with outcome? Stated as a comparison of means
 *      with both counts shown, never as a cause: a trade that ran far enough to
 *      be trailed was already winning, and this module must not let that read
 *      as "trailing causes wins".
 *   3. Which writers actually touch positions? A writer that has never appeared
 *      is either dead or unreachable, and both are worth knowing before the
 *      next incident rather than after.
 *
 * @param {{days?: number, accountId?: string|null, limit?: number}} opts
 */
export function managementObservations(db, { days = 14, accountId = null, limit = 500 } = {}) {
  const d = Number.isFinite(Number(days)) && Number(days) > 0 ? Number(days) : 14
  const acct = accountId != null ? String(accountId) : null
  let trades = []
  try {
    trades = db.prepare(`
      SELECT id, symbol, net_pnl, closed_at
        FROM trades
       WHERE status = 'closed'
         AND closed_at IS NOT NULL
         AND REPLACE(closed_at, 'T', ' ') >= datetime('now', ?)
         ${acct == null ? '' : 'AND (account_id = ? OR account_id IS NULL)'}
       ORDER BY closed_at DESC
       LIMIT ?
    `).all(...(acct == null ? [`-${d} days`, limit] : [`-${d} days`, acct, limit]))
  } catch {
    // A failed read is reported as such. Returning empty observations would say
    // "management was never involved", which is a claim, not an absence.
    return { ok: false, error: 'query failed', days: d, trades: 0, observations: [] }
  }

  let touchedIds = new Set()
  const sourceCounts = new Map()
  try {
    const rows = db.prepare(`
      SELECT trade_id, source FROM position_events
       WHERE trade_id IS NOT NULL
         AND REPLACE(at, 'T', ' ') >= datetime('now', ?)
    `).all(`-${d} days`)
    for (const r of rows) {
      touchedIds.add(Number(r.trade_id))
      if (r.source) sourceCounts.set(r.source, (sourceCounts.get(r.source) || 0) + 1)
    }
  } catch { touchedIds = new Set() }

  const managed = trades.filter(t => touchedIds.has(Number(t.id)))
  const unmanaged = trades.filter(t => !touchedIds.has(Number(t.id)))
  // Trades with no realised P&L are excluded from the COMPARISON and counted
  // separately. Reading a NULL as zero is the defect this codebase has already
  // paid for twice; it would drag both means towards nothing here.
  const withPnl = (list) => list.filter(t => t.net_pnl != null).map(t => Number(t.net_pnl))
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
  const mPnl = withPnl(managed)
  const uPnl = withPnl(unmanaged)

  const obs = []
  const note = (id, text, n, extra = {}) =>
    obs.push({ id, text, n, provisional: n < MIN_SAMPLE, ...extra })

  note(
    'management_coverage',
    `${managed.length} of ${trades.length} closed trades were touched by a management writer; ${unmanaged.length} closed with no management event at all.`,
    trades.length,
    { managed: managed.length, unmanaged: unmanaged.length },
  )

  if (mPnl.length && uPnl.length) {
    note(
      'managed_vs_unmanaged',
      `Managed trades averaged ${mean(mPnl).toFixed(2)} over ${mPnl.length}; unmanaged averaged ${mean(uPnl).toFixed(2)} over ${uPnl.length}. This is an ASSOCIATION, not a cause — a trade that ran far enough to be trailed was already winning when it was touched.`,
      Math.min(mPnl.length, uPnl.length),
      { managedMean: mean(mPnl), unmanagedMean: mean(uPnl), managedN: mPnl.length, unmanagedN: uPnl.length },
    )
  }

  const unknownPnl = trades.filter(t => t.net_pnl == null).length
  if (unknownPnl > 0) {
    note(
      'unknown_pnl_excluded',
      `${unknownPnl} closed trade(s) in the window have no realised P&L and are excluded from every average above — they are unknown, not zero.`,
      trades.length,
      { unknownPnl },
    )
  }

  const sources = [...sourceCounts.entries()].sort((a, b) => b[1] - a[1])
  note(
    'active_writers',
    sources.length
      ? `${sources.length} writer(s) touched positions: ${sources.map(([s, n]) => `${s} (${n})`).join(', ')}.`
      : 'No writer touched any position in this window — every management layer was silent, which is worth checking against the WS-05 health readout.',
    trades.length,
    { sources: Object.fromEntries(sources) },
  )

  return {
    ok: true,
    days: d,
    accountId: acct,
    trades: trades.length,
    managed: managed.length,
    unmanaged: unmanaged.length,
    observations: obs,
  }
}
