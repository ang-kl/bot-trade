// Shared helpers + broker-snapshot adapters for the STANDARD trade table
// (src/components/StdTradeTable.jsx). Lives outside the component file so
// react-refresh stays happy and non-React code can import the helpers.
import { notionalUsd, usdLossPerLot } from '../../agent/lib/contracts.js'

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
// Bracket money — what the SL and TP are actually WORTH (owner 2026-07-29:
// "adding [SL Loss in $] to existing Stop Loss ... and [TP Profit in $] to
// Take Profit"). A price level tells you nothing about the damage; the
// money does.
//
// SIGN IS REAL, not assumed. slMoney is negative for a stop below entry on a
// long (the usual case) but POSITIVE once the stop has been trailed past
// entry — that is locked-in profit, and printing it as a loss would be a lie.
// Same logic for a TP the market has already run past.
//
// Units: USD, via agent/lib/contracts.js — the one place that knows contract
// sizes and the USD conversion path per instrument. `rates` is the live
// price map (SYMBOL → price) the callers already build; crosses need it to
// convert their quote-currency loss, and return null without it rather than
// guessing. qty is LOTS everywhere in this app (agent/services/reconciler.js
// converts broker units on the way in).
// ---------------------------------------------------------------------------
function levelMoney(symbol, side, lots, entry, level, ref, rates) {
  const e = Number(entry)
  const l = Number(level)
  const q = Number(lots)
  if (!Number.isFinite(e) || !Number.isFinite(l) || !Number.isFinite(q) || q === 0) return null
  const dir = String(side || '').toUpperCase() === 'BUY' ? 1 : -1
  // usdLossPerLot takes the magnitude; the direction decides the sign.
  const perLot = usdLossPerLot(symbol, l - e, Number.isFinite(Number(ref)) ? Number(ref) : e, rates)
  if (!Number.isFinite(perLot)) return null
  const sign = (l - e) * dir >= 0 ? 1 : -1
  return sign * perLot * Math.abs(q)
}

/**
 * { slMoney, tpMoney } in USD for one row. tpMoney sums a TP ladder using
 * each leg's own lots when the ladder carries them, so a scale-out plan
 * reports what the WHOLE plan is worth rather than just leg #1.
 */
export function bracketMoney({ symbol, side, qty, entry, sl, tp, tps, ref, rates }) {
  const slMoney = sl == null ? null : levelMoney(symbol, side, qty, entry, sl, ref, rates)
  let tpMoney = null
  if (tps?.length) {
    let sum = 0
    let any = false
    for (const t of tps) {
      const m = levelMoney(symbol, side, t.lots ?? qty, entry, t.price, ref, rates)
      if (m != null) { sum += m; any = true }
    }
    tpMoney = any ? sum : null
  } else if (tp != null) {
    tpMoney = levelMoney(symbol, side, qty, entry, tp, ref, rates)
  }
  return { slMoney, tpMoney }
}

/**
 * Margin an already-closed / never-placed row WOULD have used, from notional
 * ÷ leverage (owner: Margin Used on Recent trades and the Order log too).
 * Broker truth is always preferred where it exists — this only fills rows the
 * broker no longer reports, and callers mark it estimated so it is never
 * mistaken for the real figure.
 */
export function estimateMargin({ symbol, qty, price, leverage, rates }) {
  const lev = Number(leverage)
  const q = Number(qty)
  const p = Number(price)
  if (!Number.isFinite(lev) || lev <= 0 || !Number.isFinite(q) || q === 0 || !Number.isFinite(p)) return null
  const notional = notionalUsd(symbol, q, p, rates)
  return Number.isFinite(notional) ? notional / lev : null
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

// DB↔broker cross-check for one position (owner: "check individually the 18
// positions" after the LLM-monitor broker-close bug). dbRow is the matching
// /state/positions record (by ctrader_position_id) or null if the broker
// holds a position no ACTIVE DB row maps to. A small side/SL/TP epsilon
// tolerates float noise, not real drift.
const SIDE_LONG = new Set(['long', 'buy'])
function integrityOf(p2, dbRow) {
  if (!dbRow) return 'untracked in DB'
  const dbSide = SIDE_LONG.has(String(dbRow.side || '').toLowerCase()) ? 'BUY' : 'SELL'
  if (dbSide !== String(p2.side || '').toUpperCase()) return 'side drift'
  const near = (a, b) => a == null || b == null ? a == null && b == null : Math.abs(Number(a) - Number(b)) <= Math.max(1e-9, Math.abs(Number(b)) * 1e-4)
  if (!near(dbRow.current_sl, p2.sl)) return 'SL drift'
  if (!near(dbRow.current_tp, p2.tp)) return 'TP drift'
  return 'OK'
}

/** Live broker positions → standard rows. manageable=true arms the panel.
 * dbByPid: optional Map<String(ctrader_position_id), dbRow> — when passed,
 * each row gets an `integrity` field cross-checking DB vs broker truth. */
export function brokerPositionRows(positions, { manageable = false, dbByPid = null, rates = null } = {}) {
  return (positions || []).map(p2 => {
    // Broker-truth net P&L first (cTrader's own figure, every asset class);
    // the client-side estimate only fills the gap and is marked as such.
    const net = p2.netPnl ?? p2.estNetPnl ?? p2.estPnlQuote
    // The server already computes what each bracket is worth in the DEPOSIT
    // currency, net of swap and commission (actions.js:3028-3031). That beats
    // any client-side estimate, so it wins; bracketMoney only fills a gap.
    const slTruth = p2.slNetImpact ?? p2.slGrossImpact ?? null
    const tpTruth = p2.tpNetImpact ?? p2.tpGrossImpact ?? null
    const bracket = (slTruth != null && tpTruth != null) ? { slMoney: null, tpMoney: null } : bracketMoney({
      symbol: p2.symbol, side: p2.side, qty: p2.lots, entry: p2.entry,
      sl: p2.sl, tp: p2.tp, tps: p2.tps, ref: p2.currentPrice, rates,
    })
    return {
      slMoney: slTruth ?? bracket.slMoney,
      tpMoney: tpTruth ?? bracket.tpMoney,
      moneyEst: slTruth == null && tpTruth == null,
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
      exit: null, // still open — nothing to fall back to
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
      // Segment by what opened the trade (owner spec) — parsed from the
      // structured label server-side; null for manual/external.
      timeframe: p2.timeframe ?? null,
      strategy: p2.strategy ?? null,
      integrity: dbByPid ? integrityOf(p2, dbByPid.get(String(p2.positionId)) ?? null) : null,
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
    timeframe: o.timeframe ?? null,
    strategy: o.strategy ?? null,
    reason: `${o.type || 'LIMIT'} · now ${px(o.currentPrice)}${o.expiresAt ? ` · expires ${dateTimeParts(o.expiresAt)?.day ?? ''} ${dateTimeParts(o.expiresAt)?.time ?? ''}` : ''}`,
    reasonTitle: `${o.type || 'LIMIT'} · now ${px(o.currentPrice)}${o.label || o.comment ? ` · ${o.label || o.comment}` : ''}`,
    chart: { symbol: o.symbol, timeframe: '1h', lines: { entry: o.limitPrice ?? o.stopPrice, sl: o.sl, tp: o.tp } },
    panel: manageable,
    raw: o,
  }))
}

/** Closed broker deals (history) → standard rows. */
export function brokerDealRows(deals, { rates = null, leverage = null } = {}) {
  return (deals || []).map((d, i) => {
    // Provenance comes from OUR OWN ledger (agent/routes/actions.js joins
    // the local trades table by positionId) — cTrader deals themselves
    // carry no label/comment. A position we never opened (imported history,
    // or older than the local DB) reads MANUAL, same as the broker itself
    // would show for an untracked position.
    const isBot = !!d.source && d.source !== 'manual' && d.source !== 'external'
    const bracket = bracketMoney({
      symbol: d.symbol, side: d.side, qty: d.lots, entry: d.entryPrice,
      sl: d.sl, tp: d.tp, ref: d.closePrice, rates,
    })
    return {
      slMoney: bracket.slMoney,
      tpMoney: bracket.tpMoney,
      moneyEst: true,
      // The broker stops reporting margin the moment a position closes, so
      // this is the at-entry estimate (notional ÷ leverage), flagged as such
      // in the cell rather than passed off as broker truth.
      margin: estimateMargin({ symbol: d.symbol, qty: d.lots, price: d.entryPrice, leverage, rates }),
      marginEst: true,
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
      // Pushback (owner): "To TP/SL" doesn't need a LIVE price — once a
      // trade closes, the exit price IS the final reference point, so
      // "how close did the exit come to TP/SL" is real, computable data,
      // not a column that should just go blank. StdTradeTable falls back
      // to this whenever `current` is absent.
      exit: d.closePrice ?? null,
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
