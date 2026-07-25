// ---------------------------------------------------------------------------
// agent/services/broker-history-import.js — import cTrader's own deal history
// into the broker_deals table.
//
// Owner (2026-07-25): "read historical trades" — panel first, then this. The
// DB only knows the trades the bot itself placed and successfully recorded.
// Anything else the account ever did is invisible to us: fills from before
// the DB existed, manual trades taken in cTrader, and anything lost when a
// submission wrote at the broker but the process died before persistTrade.
//
// WHY NOT INSERT INTO `trades`
// perf-ledger, edge-health, the metrics snapshot and the lessons tuner all
// count every closed trades row that has a net_pnl, and NONE of them filter
// on source (verified: the only source filters in the codebase are in
// loss-guardian, profit-keeper, session-open-guard and label-backfill, all on
// monitored_positions or label work). Writing imported history there would
// silently move the win rate, profit factor, strategy attribution and the
// lessons decay keys, and the owner would have no way to tell that a stat
// changed because of an import rather than because of trading. So broker
// truth lands in its own table, joined to a local row by position id where
// one exists. Feeding imported rows into the performance numbers is a
// separate, deliberate decision that needs the owner's word.
//
// Idempotent: deal_id is the broker's own primary key and the write is an
// INSERT .. ON CONFLICT DO UPDATE, so re-importing an overlapping window
// refreshes rather than duplicates. Nothing is ever fabricated — a field the
// broker does not give us stays NULL (notably opened_at, when the position's
// opening deal falls outside the requested window).
// ---------------------------------------------------------------------------

const WEEK = 7 * 24 * 3_600_000
const SIDE_NAME = { 1: 'BUY', 2: 'SELL' }

function log(...args) {
  console.log('[broker-import]', ...args)
}

const iso = (ms) => (ms == null ? null : new Date(Number(ms)).toISOString().replace('T', ' ').slice(0, 19))
const r2 = (v) => (v == null ? null : Math.round(Number(v) * 100) / 100)

/**
 * Page the broker's deal list across a window. cTrader caps one request at a
 * week, so this walks week by week exactly like /actions/broker-history.
 */
export async function fetchDeals(getDeals, fromMs, toMs) {
  const deals = []
  for (let t0 = fromMs; t0 < toMs; t0 += WEEK) {
    const chunk = await getDeals(t0, Math.min(t0 + WEEK, toMs))
    deals.push(...(chunk?.deal || []))
  }
  return deals
}

/**
 * Shape raw deals into broker_deals rows.
 *
 * A position produces at least two deals: one opening, one (or more) closing.
 * Only closing deals carry closePositionDetail and therefore realised P&L, so
 * those become the rows; the matching opening deal, when it is inside the
 * window, supplies opened_at and nothing else.
 *
 * @param {Array} deals raw DEAL_LIST_RES deals
 * @param {Record<number, {symbolName?: string, lotSize?: number}>} symMeta
 * @param {string|number|null} accountId
 */
export function shapeDeals(deals, symMeta = {}, accountId = null) {
  // Earliest execution per position = its open, when we can see it.
  const openMsByPosition = new Map()
  for (const d of deals) {
    if (d.closePositionDetail) continue
    const pid = d.positionId != null ? String(d.positionId) : null
    if (!pid || d.executionTimestamp == null) continue
    const prev = openMsByPosition.get(pid)
    if (prev == null || d.executionTimestamp < prev) openMsByPosition.set(pid, d.executionTimestamp)
  }

  const rows = []
  for (const d of deals) {
    const cpd = d.closePositionDetail
    if (!cpd) continue
    const meta = symMeta[d.symbolId] || {}
    const money = (v) => (v == null ? null : v / Math.pow(10, cpd.moneyDigits ?? 2))
    const gross = money(cpd.grossProfit)
    const swap = money(cpd.swap)
    const commission = money(cpd.commission)
    // The deal's tradeSide is the CLOSING side — the position was the other
    // way round. Same inversion /actions/broker-history applies.
    const closeSide = SIDE_NAME[d.tradeSide] || String(d.tradeSide ?? '')
    const side = closeSide === 'BUY' ? 'SELL' : closeSide === 'SELL' ? 'BUY' : (closeSide || null)
    const pid = d.positionId != null ? String(d.positionId) : null
    rows.push({
      deal_id: String(d.dealId),
      position_id: pid,
      account_id: accountId != null ? String(accountId) : null,
      symbol: meta.symbolName ? String(meta.symbolName).toUpperCase() : (d.symbolId != null ? `#${d.symbolId}` : null),
      side,
      lots: meta.lotSize ? Math.round((d.volume / meta.lotSize) * 100) / 100 : null,
      entry_price: cpd.entryPrice ?? null,
      close_price: d.executionPrice ?? null,
      opened_at: pid ? iso(openMsByPosition.get(pid) ?? null) : null,
      closed_at: iso(d.executionTimestamp ?? null),
      gross_pnl: r2(gross),
      swap: r2(swap),
      commission: r2(commission),
      net_pnl: r2((gross || 0) + (swap || 0) + (commission || 0)),
    })
  }
  return rows
}

/** Upsert shaped rows, linking each to a local trades row by position id. */
export function persistDeals(db, rows) {
  const localByPosition = new Map()
  const pids = [...new Set(rows.map(r => r.position_id).filter(Boolean))]
  if (pids.length) {
    // Chunked — SQLite's default parameter limit is 999.
    for (let i = 0; i < pids.length; i += 500) {
      const slice = pids.slice(i, i + 500)
      const placeholders = slice.map(() => '?').join(',')
      for (const t of db.prepare(
        `SELECT id, ctrader_position_id FROM trades WHERE ctrader_position_id IN (${placeholders})`,
      ).all(...slice)) {
        localByPosition.set(String(t.ctrader_position_id), t.id)
      }
    }
  }

  const up = db.prepare(`
    INSERT INTO broker_deals (
      deal_id, position_id, account_id, symbol, side, lots, entry_price, close_price,
      opened_at, closed_at, gross_pnl, swap, commission, net_pnl, matched_trade_id
    ) VALUES (
      @deal_id, @position_id, @account_id, @symbol, @side, @lots, @entry_price, @close_price,
      @opened_at, @closed_at, @gross_pnl, @swap, @commission, @net_pnl, @matched_trade_id
    )
    ON CONFLICT(deal_id) DO UPDATE SET
      symbol = excluded.symbol, side = excluded.side, lots = excluded.lots,
      entry_price = excluded.entry_price, close_price = excluded.close_price,
      -- Never overwrite a known open time with a NULL from a narrower window.
      opened_at = COALESCE(excluded.opened_at, broker_deals.opened_at),
      closed_at = excluded.closed_at, gross_pnl = excluded.gross_pnl,
      swap = excluded.swap, commission = excluded.commission, net_pnl = excluded.net_pnl,
      matched_trade_id = COALESCE(excluded.matched_trade_id, broker_deals.matched_trade_id),
      imported_at = datetime('now')
  `)
  const before = db.prepare('SELECT COUNT(*) AS c FROM broker_deals').get().c
  const write = db.transaction(() => {
    for (const r of rows) {
      up.run({ ...r, matched_trade_id: r.position_id ? (localByPosition.get(r.position_id) ?? null) : null })
    }
  })
  write()
  const after = db.prepare('SELECT COUNT(*) AS c FROM broker_deals').get().c
  const matched = rows.filter(r => r.position_id && localByPosition.has(r.position_id)).length
  return {
    seen: rows.length,
    inserted: after - before,
    updated: rows.length - (after - before),
    matchedToLocalTrades: matched,
    // The interesting number: broker fills the bot has no record of.
    unmatched: rows.length - matched,
  }
}

/**
 * Import `days` of broker deal history.
 *
 * @param {object} db
 * @param {{days?: number, nowMs?: number, deps: {getDeals: Function, getSymbolMeta?: Function, accountId?: string|number}}} opts
 */
export async function importBrokerHistory(db, { days = 30, nowMs = Date.now(), deps } = {}) {
  if (!deps?.getDeals) throw new Error('importBrokerHistory needs deps.getDeals')
  const span = Math.min(190, Math.max(1, Number(days) || 30))
  const from = nowMs - span * 24 * 3_600_000
  const deals = await fetchDeals(deps.getDeals, from, nowMs)
  const symbolIds = [...new Set(deals.map(d => d.symbolId).filter(v => v != null))]
  let symMeta = {}
  if (symbolIds.length && deps.getSymbolMeta) {
    // Symbol names are cosmetic here — a failure leaves '#<id>', which is
    // still a stable key, rather than aborting the whole import.
    try { symMeta = await deps.getSymbolMeta(symbolIds) } catch (e) { log('symbol metadata failed:', e.message) }
  }
  const rows = shapeDeals(deals, symMeta, deps.accountId ?? null)
  const result = persistDeals(db, rows)
  log(`${span}d: ${deals.length} deals → ${result.seen} closes · ${result.inserted} new · ${result.unmatched} with no local trade row`)
  return { days: span, from: iso(from), to: iso(nowMs), deals: deals.length, ...result }
}
