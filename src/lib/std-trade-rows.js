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

// ---------------------------------------------------------------------------
// Broker-snapshot adapters (the /actions/broker-positions and broker-history
// shapes used by Desk and Accounts). Money strings keep their sign so a loss
// is unmistakable even inside the muted Reason column.
// ---------------------------------------------------------------------------
const money = (n) => (n == null ? '—' : `${Number(n) >= 0 ? '+' : '−'}${Math.abs(Number(n)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const px = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 5 }))

/** Live broker positions → standard rows. manageable=true arms the panel. */
export function brokerPositionRows(positions, { manageable = false } = {}) {
  return (positions || []).map(p2 => {
    const net = p2.estNetPnl ?? p2.estPnlQuote
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
      tp: p2.tp,
      reason: `now ${px(p2.currentPrice)} · P&L ${money(net)}${p2.estNetPnl == null && net != null ? '*' : ''}`,
      reasonTitle: `now ${px(p2.currentPrice)} · P&L ${money(net)} · swap ${money(p2.swap)} · commission ${money(p2.commission)} · margin ${money(p2.usedMargin)}${p2.label || p2.comment ? ` · ${p2.label || p2.comment}` : ''}`,
      chart: { symbol: p2.symbol, timeframe: '1h', lines: { entry: p2.entry, sl: p2.sl, tp: p2.tp } },
      panel: manageable,
      raw: p2,
    }
  })
}

/** Resting (set) broker orders → standard rows. */
export function brokerOrderRows(orders) {
  return (orders || []).map(o => ({
    id: `bo-${o.orderId}`,
    at: null,
    symbol: o.symbol,
    result: { text: 'PENDING', tone: 'warning' },
    source: { text: o.label ? 'BOT' : 'MANUAL', tone: o.label ? 'special' : 'neutral' },
    side: String(o.side || '').toUpperCase() || null,
    qty: o.lots,
    entry: o.limitPrice ?? o.stopPrice,
    sl: o.sl,
    tp: o.tp,
    reason: `${o.type || 'LIMIT'} · now ${px(o.currentPrice)}${o.expiresAt ? ` · expires ${dateTimeParts(o.expiresAt)?.day ?? ''} ${dateTimeParts(o.expiresAt)?.time ?? ''}` : ''}`,
    reasonTitle: `${o.type || 'LIMIT'} · now ${px(o.currentPrice)}${o.label || o.comment ? ` · ${o.label || o.comment}` : ''}`,
    chart: { symbol: o.symbol, timeframe: '1h', lines: { entry: o.limitPrice ?? o.stopPrice, sl: o.sl, tp: o.tp } },
    raw: o,
  }))
}

/** Closed broker deals (history) → standard rows. */
export function brokerDealRows(deals) {
  return (deals || []).map((d, i) => ({
    id: `bd-${d.dealId ?? `${d.positionId}-${i}`}`,
    at: d.closedAt ?? null,
    symbol: d.symbol,
    result: { text: 'CLOSED', tone: (Number(d.netPnl) || 0) >= 0 ? 'up' : 'down' },
    source: { text: d.label ? 'BOT' : 'MANUAL', tone: d.label ? 'special' : 'neutral' },
    side: String(d.side || '').toUpperCase() || null,
    qty: d.lots,
    entry: d.entryPrice,
    sl: null,
    tp: null,
    reason: `out ${px(d.closePrice)} · net ${money(d.netPnl)}`,
    chart: {
      symbol: d.symbol,
      timeframe: '1h',
      lines: { entry: d.entryPrice },
      at: toMs(d.closedAt),
      markers: { exitT: toMs(d.closedAt) },
    },
    raw: d,
  }))
}
