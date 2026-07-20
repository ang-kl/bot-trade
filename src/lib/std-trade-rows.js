// Shared helpers + broker-snapshot adapters for the STANDARD trade table
// (src/components/StdTradeTable.jsx). Lives outside the component file so
// react-refresh stays happy and non-React code can import the helpers.

// SQLite/ISO datetimes are UTC (sometimes without a zone marker); broker
// snapshots may pass epoch-ms numbers. Normalise both.
export function dateTimeParts(v) {
  if (!v) return null
  const d = typeof v === 'number'
    ? new Date(v)
    : new Date(String(v).includes('T') ? v : String(v).replace(' ', 'T') + (String(v).includes('Z') ? '' : 'Z'))
  if (!Number.isFinite(d.getTime())) return null
  return {
    day: d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }),
    time: d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
  }
}

export function toMs(v) {
  if (!v) return null
  if (typeof v === 'number') return v
  const t = Date.parse(String(v).includes('T') ? v : String(v).replace(' ', 'T') + 'Z')
  return Number.isFinite(t) ? t : null
}

/**
 * Next-market-open label in the DEVICE timezone (owner spec): same month →
 * "(dd hh:mm)", different month → "(dd-m hh:mm)".
 */
export function nextOpenLabel(iso, now = new Date()) {
  if (!iso) return null
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  const sameMonth = d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()
  const stamp = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return sameMonth ? `(${pad(d.getDate())} ${stamp})` : `(${pad(d.getDate())}-${d.getMonth() + 1} ${stamp})`
}

// ---------------------------------------------------------------------------
// Broker-snapshot adapters (the /actions/broker-positions and broker-history
// shapes used by Desk and Accounts). Money strings keep their sign so a loss
// is unmistakable even inside the muted Reason column.
// ---------------------------------------------------------------------------
const money = (n) => (n == null ? '—' : `${Number(n) >= 0 ? '+' : '−'}${Math.abs(Number(n)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
// Canonical price display precision (owner): scale-aware — 4 dp normally,
// 2 dp for quotes in the hundreds/thousands (USDJPY, XAUUSD), none for
// five-figure quotes and beyond (JPN225, US30, BTCUSD).
export const priceDp = (v) => {
  const a = Math.abs(Number(v))
  if (!Number.isFinite(a)) return 4
  return a >= 10000 ? 0 : a >= 100 ? 2 : 4
}
const px = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: priceDp(n) }))

/** Live broker positions → standard rows. manageable=true arms the panel. */
export function brokerPositionRows(positions, { manageable = false } = {}) {
  return (positions || []).map(p2 => {
    // Broker-truth net P&L first (cTrader's own figure, every asset class);
    // the client-side estimate only fills the gap and is marked as such.
    const net = p2.netPnl ?? p2.estNetPnl ?? p2.estPnlQuote
    return {
      id: `bp-${p2.positionId}`,
      at: p2.openedAt ?? null,
      symbol: p2.symbol,
      result: { text: 'OPEN', tone: 'info' },
      source: { text: p2.label ? 'BOT' : 'MANUAL', tone: p2.label ? 'special' : 'neutral' },
      side: String(p2.side || '').toUpperCase() || null,
      qty: p2.lots,
      entry: p2.entry,
      sl: p2.sl,
      slAt: p2.sl != null ? p2.lastModifiedAt ?? null : null,
      tp: p2.tp,
      tps: p2.tps?.length ? p2.tps : undefined,
      tpAt: (p2.tps?.length || p2.tp != null) ? (p2.tps?.[0]?.at ?? p2.lastModifiedAt ?? null) : null,
      current: p2.currentPrice ?? null,
      pnl: net ?? null,
      // cTrader's compulsory position columns — the standard table shows
      // them whenever rows carry them.
      updatedAt: p2.lastModifiedAt ?? null,
      ccy: p2.quoteCcy ?? null,        // price columns (Entry/SL/TP) quote here
      moneyCcy: p2.depositCcy ?? null, // money columns (P&L/Margin/Comm/Swap)
      margin: p2.usedMargin ?? null,
      bid: p2.bid ?? null,
      ask: p2.ask ?? null,
      commission: p2.commission ?? null,
      swap: p2.swap ?? null,
      positionId: p2.positionId ?? null,
      durationMs: p2.openedAt ? Math.max(0, Date.now() - toMs(p2.openedAt)) : null,
      reason: `now ${px(p2.currentPrice)}${p2.netPnl == null && net != null ? ' (P&L est*)' : ''}`,
      reasonTitle: `now ${px(p2.currentPrice)} · P&L ${money(net)} · swap ${money(p2.swap)} · commission ${money(p2.commission)} · margin ${money(p2.usedMargin)}${p2.label || p2.comment ? ` · ${p2.label || p2.comment}` : ''}`,
      chart: { symbol: p2.symbol, timeframe: '1h', lines: { entry: p2.entry, sl: p2.sl, tp: p2.tp } },
      panel: manageable,
      raw: p2,
    }
  })
}

/** Resting (set) broker orders → standard rows. manageable=true arms the panel. */
export function brokerOrderRows(orders, { manageable = false } = {}) {
  return (orders || []).map(o => ({
    id: `bo-${o.orderId}`,
    at: o.updatedAt ?? null, // last time the order (incl. its SL/TP) was set
    symbol: o.symbol,
    result: { text: 'PENDING', tone: 'warning' },
    source: { text: o.label ? 'BOT' : 'MANUAL', tone: o.label ? 'special' : 'neutral' },
    side: String(o.side || '').toUpperCase() || null,
    qty: o.lots,
    entry: o.limitPrice ?? o.stopPrice,
    sl: o.sl,
    tp: o.tp,
    current: o.currentPrice ?? null,
    reason: `${o.type || 'LIMIT'} · now ${px(o.currentPrice)}${o.expiresAt ? ` · expires ${dateTimeParts(o.expiresAt)?.day ?? ''} ${dateTimeParts(o.expiresAt)?.time ?? ''}` : ''}`,
    reasonTitle: `${o.type || 'LIMIT'} · now ${px(o.currentPrice)}${o.label || o.comment ? ` · ${o.label || o.comment}` : ''}`,
    chart: { symbol: o.symbol, timeframe: '1h', lines: { entry: o.limitPrice ?? o.stopPrice, sl: o.sl, tp: o.tp } },
    panel: manageable,
    raw: o,
  }))
}

/** Closed broker deals (history) → standard rows. */
export function brokerDealRows(deals) {
  return (deals || []).map((d, i) => {
    // Provenance comes from OUR OWN ledger (agent/routes/actions.js joins
    // the local trades table by positionId) — cTrader deals themselves
    // carry no label/comment. A position we never opened (imported history,
    // or older than the local DB) reads MANUAL, same as the broker itself
    // would show for an untracked position.
    const isBot = !!d.source && d.source !== 'manual' && d.source !== 'external'
    return {
      id: `bd-${d.dealId ?? `${d.positionId}-${i}`}`,
      at: d.closedAt ?? null,
      symbol: d.symbol,
      result: { text: 'CLOSED', tone: (Number(d.netPnl) || 0) >= 0 ? 'up' : 'down' },
      source: { text: isBot ? 'BOT' : 'MANUAL', tone: isBot ? 'special' : 'neutral' },
      side: String(d.side || '').toUpperCase() || null,
      qty: d.lots,
      entry: d.entryPrice,
      // SL/TP come from the local ledger (agent side) — the last-known
      // levels before this close, not necessarily what was live at the
      // exact instant of a trailed/scaled-out exit. Null for positions this
      // account never tracked (broker history alone doesn't carry SL/TP).
      sl: d.sl ?? null,
      tp: d.tp ?? null,
      pnl: d.netPnl ?? null,
      ccy: d.quoteCcy ?? null,
      moneyCcy: d.depositCcy ?? null,
      commission: d.commission ?? null,
      swap: d.swap ?? null,
      positionId: d.positionId ?? null,
      durationMs: d.durationMs ?? null,
      reason: `out ${px(d.closePrice)} · net ${money(d.netPnl)}`,
      chart: {
        symbol: d.symbol,
        timeframe: '1h',
        lines: { entry: d.entryPrice, sl: d.sl ?? null, tp: d.tp ?? null },
        at: toMs(d.closedAt),
        markers: { entryT: toMs(d.openedAt), exitT: toMs(d.closedAt) },
      },
      raw: d,
    }
  })
}
