// ---------------------------------------------------------------------------
// agent/services/trade-integrity.js — detect duplicate CLOSED trade records.
//
// Owner spotted it in the Trade-lessons panel: several "different" trades
// sharing the exact same symbol/side/entry/exit/net_pnl to the cent, at the
// same timestamp (e.g. 7 AUDUSD SELL rows all -$508.37/-1.01R at the exact
// same minute). trade_postmortems.trade_id is UNIQUE, so those are NOT the
// same trade re-classified — they are genuinely separate rows in `trades`
// with identical values, which is essentially impossible for independent
// real fills. The likely cause is the same class of bug the reconciler's
// "duplicate-adoption guard" and "dedup sweep" already fix for STILL-OPEN
// trades (agent/services/reconciler.js) — but those only ever look at
// status='open' rows, so a duplicate that already got closed independently
// (e.g. via the orphan sweep) is invisible to that cleanup.
//
// This is read-only and deliberately conservative: it REPORTS candidate
// duplicate groups (and how much of net P&L they'd double-count) so a human
// can decide what to do, rather than silently deleting trade history.
// ---------------------------------------------------------------------------

/**
 * Group CLOSED trades sharing symbol+side+entry+exit+net_pnl. Real
 * independent fills essentially never match on all four to the cent, so
 * any group with >1 row is a duplicate-record candidate.
 *
 * exit_price is NOT required (Codex review, PR #266): a broker-side SL/TP/
 * manual close gets net_pnl backfilled by pnl-backfill.js, which updates
 * ONLY net_pnl/gross_pnl and never touches exit_price — that trade stays
 * closed with exit_price NULL forever. Requiring it here would make the
 * audit blind to exactly the duplicate class most likely to exist (broker-
 * side closes), since Performance/Edge-health already count these trades by
 * status='closed' + net_pnl regardless of exit_price.
 */
export function findDuplicateTrades(db, { windowDays = 90 } = {}) {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT id, symbol, side, entry_price, exit_price, net_pnl, closed_at,
             ctrader_position_id, label_strategy
      FROM trades
      WHERE status = 'closed' AND closed_at >= datetime('now', ?)
        AND entry_price IS NOT NULL AND net_pnl IS NOT NULL
    `).all(`-${windowDays} days`)
  } catch { return { groups: [], totalExtraRows: 0, totalExtraPnl: 0 } }

  const byKey = new Map()
  for (const r of rows) {
    const key = [r.symbol, r.side, r.entry_price, r.exit_price, r.net_pnl].join('|')
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(r)
  }

  const priceGroups = [...byKey.values()].filter(g => g.length > 1)

  // Second, independent signal (Codex review's alternative): several CLOSED
  // trades sharing one broker position id at all — a healthy account maps
  // one broker position to exactly one closed trade, so >1 is suspicious
  // even when a price field doesn't line up (e.g. one row's exit_price is
  // NULL from the backfill gap above and the other's isn't).
  const byPosId = new Map()
  for (const r of rows) {
    if (r.ctrader_position_id == null) continue
    if (!byPosId.has(r.ctrader_position_id)) byPosId.set(r.ctrader_position_id, [])
    byPosId.get(r.ctrader_position_id).push(r)
  }
  const posIdGroups = [...byPosId.values()].filter(g => g.length > 1)

  // Merge: a price-match group already covers its rows; only add a
  // position-id group if its trade ids aren't already fully represented.
  const seenIds = new Set(priceGroups.flatMap(g => g.map(x => x.id)))
  const extraPosIdGroups = posIdGroups.filter(g => g.some(x => !seenIds.has(x.id)))

  const toEntry = (g) => ({
    symbol: g[0].symbol,
    side: g[0].side,
    entry_price: g[0].entry_price,
    exit_price: g[0].exit_price,
    net_pnl: g[0].net_pnl,
    strategy: g[0].label_strategy || null,
    count: g.length,
    // If every row in the group shares one broker position id, that's
    // near-certain confirmation it's the SAME broker fill recorded
    // multiple times locally, not a coincidence.
    samePositionId: g[0].ctrader_position_id != null && g.every(x => x.ctrader_position_id === g[0].ctrader_position_id),
    tradeIds: g.map(x => x.id),
    closedAts: [...new Set(g.map(x => x.closed_at))],
  })

  const groups = [...priceGroups.map(toEntry), ...extraPosIdGroups.map(toEntry)]
    .sort((a, b) => b.count - a.count)

  return {
    groups,
    // "Extra" = the rows beyond the first legitimate one in each group —
    // this is exactly how much net P&L / trade-count these duplicates are
    // artificially adding to Performance/Edge-health stats.
    totalExtraRows: groups.reduce((s, g) => s + (g.count - 1), 0),
    totalExtraPnl: Math.round(groups.reduce((s, g) => s + (g.count - 1) * (Number(g.net_pnl) || 0), 0) * 100) / 100,
  }
}

// ---------------------------------------------------------------------------
// Owner (2026-07-25): "investigate double or triple trading symbols for past
// EU and NY market sessions. I suspect it is our coding/algo."
//
// findDuplicateTrades above cannot see that class. It keys on IDENTICAL
// values (same entry/exit/net_pnl, or one broker position id recorded twice)
// — bookkeeping duplicates. What the owner is describing is the opposite:
// several GENUINELY DISTINCT fills, different prices and different broker
// position ids, stacked on one symbol inside one session. Each row is a real
// separate trade; the defect is that they were ever opened.
//
// This groups by account + symbol inside a rolling window and reports the
// cluster with the LABEL/STRATEGY of every leg, because the label is what
// identifies the responsible code path:
//   'vpo:<key>'   → the C++ sidecar's VpoDispatcher fired (per-strategy arm,
//                    no per-symbol cap — N armed strategies on one symbol can
//                    each fire on the same tick)
//   'pending-fib' → a resting fib LIMIT filled
//   autopilot     → the Node loop's market-order path (risk gate + 3-minute
//                    ledger idempotency)
//   manual        → a human action route
// A cluster mixing paths is a cross-path hole; a cluster of one path repeated
// is that path's own dedupe failing.
//
// Read-only and deliberately non-judgemental: legitimate hedges and scale-ins
// look the same from the outside, so this REPORTS clusters with the evidence
// a human needs, and never deletes or closes anything.
// ---------------------------------------------------------------------------

/** Which code path opened this row, from its label/source/strategy columns. */
function pathOf(r) {
  const raw = String(r.label_raw || '')
  if (/^vpo:/i.test(raw) || /^vpo:/i.test(String(r.strategy || ''))) return 'vpo-sidecar'
  if (/pending-fib/i.test(raw)) return 'pending-fib'
  const src = String(r.source || '').toLowerCase()
  if (src === 'broker-import') return 'broker-import'
  if (src === 'manual') return 'manual'
  if (src) return src
  return 'unknown'
}

/**
 * Clusters of 2+ trades on the SAME account+symbol whose opens fall within
 * `windowMinutes` of each other. Covers open AND closed rows — an open
 * cluster is the live version of the same defect.
 *
 * @param {object} db
 * @param {{days?: number, windowMinutes?: number, minCluster?: number}} opts
 */
export function findSameSymbolClusters(db, { days = 14, windowMinutes = 60, minCluster = 2, includeImported = true } = {}) {
  let rows = []
  try {
    rows = db.prepare(`
      SELECT id, account_id, symbol, side, volume, entry_price, net_pnl, status,
             opened_at, closed_at, ctrader_position_id,
             label_raw, source, COALESCE(label_strategy, strategy) AS strategy,
             label_session
      FROM trades
      WHERE opened_at IS NOT NULL AND opened_at >= datetime('now', ?)
      ORDER BY symbol, opened_at
    `).all(`-${days} days`)
  } catch { return { clusters: [], byPath: {}, worst: null } }

  // Broker fills the bot never recorded (imported by
  // services/broker-history-import.js) join the same analysis, or a cluster
  // that mixes a bot entry with an untracked one would look like a single
  // clean trade. matched_trade_id IS NULL only — a matched deal is already
  // represented by its trades row above. Marked source 'broker-import' so
  // pathOf files it under its own bucket and it can never be mistaken for
  // one of our code paths.
  if (includeImported) {
    try {
      rows = rows.concat(db.prepare(`
        SELECT NULL AS id, account_id, symbol, side, lots AS volume, entry_price, net_pnl,
               'closed' AS status, opened_at, closed_at, position_id AS ctrader_position_id,
               NULL AS label_raw, 'broker-import' AS source, NULL AS strategy, NULL AS label_session
        FROM broker_deals
        WHERE matched_trade_id IS NULL AND opened_at IS NOT NULL
          AND opened_at >= datetime('now', ?)
      `).all(`-${days} days`))
    } catch { /* table absent on an older DB — bot rows still cluster */ }
  }

  const windowMs = windowMinutes * 60_000
  const keyed = new Map()
  for (const r of rows) {
    const k = `${r.account_id ?? 'unscoped'}|${String(r.symbol || '').toUpperCase()}`
    if (!keyed.has(k)) keyed.set(k, [])
    keyed.get(k).push(r)
  }

  const clusters = []
  for (const [k, list] of keyed) {
    const [accountId, symbol] = k.split('|')
    // Walk opens in time order, breaking a cluster whenever the next open is
    // further than the window from the PREVIOUS one (a chain of scale-ins
    // 20 minutes apart is one cluster, which is what we want to see).
    const sorted = list
      .map(r => ({ ...r, ms: Date.parse(String(r.opened_at).replace(' ', 'T') + 'Z') }))
      .filter(r => Number.isFinite(r.ms))
      .sort((a, b) => a.ms - b.ms)
    let run = []
    const flush = () => {
      if (run.length >= minCluster) {
        const paths = run.map(pathOf)
        clusters.push({
          accountId, symbol,
          count: run.length,
          firstOpenedAt: run[0].opened_at,
          lastOpenedAt: run[run.length - 1].opened_at,
          spanMinutes: Math.round((run[run.length - 1].ms - run[0].ms) / 60_000),
          sides: [...new Set(run.map(r => r.side))],
          hedged: new Set(run.map(r => r.side)).size > 1,
          // Distinct broker position ids prove these are separate real fills
          // and not one fill recorded N times (which findDuplicateTrades owns).
          distinctPositionIds: new Set(run.map(r => r.ctrader_position_id).filter(v => v != null)).size,
          paths: [...new Set(paths)],
          crossPath: new Set(paths).size > 1,
          sessions: [...new Set(run.map(r => r.label_session).filter(Boolean))],
          strategies: [...new Set(run.map(r => r.strategy).filter(Boolean))],
          totalVolume: run.reduce((s, r) => s + (Number(r.volume) || 0), 0),
          netPnl: Math.round(run.reduce((s, r) => s + (Number(r.net_pnl) || 0), 0) * 100) / 100,
          openLegs: run.filter(r => r.status === 'open').length,
          tradeIds: run.map(r => r.id).filter(v => v != null),
          // Imported legs have no trades row, so the broker's position id is
          // the only handle on them.
          positionIds: run.map(r => r.ctrader_position_id).filter(v => v != null).map(String),
          importedLegs: run.filter(r => r.source === 'broker-import').length,
        })
      }
      run = []
    }
    for (const r of sorted) {
      if (run.length && r.ms - run[run.length - 1].ms > windowMs) flush()
      run.push(r)
    }
    flush()
  }

  clusters.sort((a, b) => b.count - a.count || Math.abs(b.netPnl) - Math.abs(a.netPnl))

  // Per-path tally of the EXTRA legs (count - 1 per cluster) — the answer to
  // "which part of our code is doing this", ranked.
  const byPath = {}
  for (const c of clusters) {
    for (const p of c.paths) byPath[p] = (byPath[p] || 0) + (c.count - 1) / c.paths.length
  }
  for (const p of Object.keys(byPath)) byPath[p] = Math.round(byPath[p] * 100) / 100

  return { clusters, byPath, worst: clusters[0] || null }
}
