// agent/services/stop-placement.js
//
// Claude · № 14,945 15-Oct (owner order § 14,741·A PR-3, "PR-3 Merge when
// Green" § 14,932·C·1; claude-builder). GET /state/stop-placement: a
// read-only review of where the bot's stops were placed and what followed,
// from stored records only. No rule changes here; the output is the evidence
// the owner decides stop rules from.
//
// Per closed BOT trade (origin bot_market_dispatch / bot_pending_fill):
// strategy, timeframe, the stop at entry measured in 1h ATRs at approval,
// MAE and MFE in R, the outcome in R from that stop (gross price move, and
// net of costs), and slippage past the stop for stop exits. Buckets by
// stop/ATR (<0.75, 0.75–1, 1–1.5, >1.5): n, win rate, average win and loss,
// PF, mean net R and its bootstrap 5th-percentile lower bound
// (tick-replay-sim expectancyLowerR), and the share of losers that never
// went more than 0.05R into profit. A bucket under 30 scored trades reads
// INSUFFICIENT. Runs in the report worker (performance-populations.js) on a
// read-only connection: no state reads through db.js, no writes.
import { closedAtMs } from '../shared/formulas.js'
import { CLEAN_BOT_ORIGINS } from '../lib/trade-origin.js'
import { strategyAttrSql } from '../lib/strategy-attribution.js'
import { expectancyLowerR } from '../lib/tick-replay-sim.js'
import { classifyOutcome } from './perf-ledger.js'
import { isSuperseded } from './scoreboard.js'

export const STOP_PLACEMENT_DEFAULT_DAYS = 30
// risk_events (the only record of the 1h ATR at approval) are kept 90 days.
export const STOP_PLACEMENT_MAX_DAYS = 90
export const STOP_PLACEMENT_MIN_SAMPLE = 30
export const STOP_PLACEMENT_ROW_CAP = 1000
/** A loser whose peak stayed at or below this never went into profit (§ 14,716·D·1). */
export const NEVER_IN_PROFIT_R = 0.05
// A stop the risk gate widened to its 1.0 × ATR floor sits at 1 ATR to
// floating-point noise; it belongs to 1–1.5, not 0.75–1.
const EDGE_EPS = 1e-6
export const STOP_ATR_BUCKETS = Object.freeze([
  { key: '<0.75', lo: -Infinity, hi: 0.75 },
  { key: '0.75-1', lo: 0.75, hi: 1 - EDGE_EPS },
  { key: '1-1.5', lo: 1 - EDGE_EPS, hi: 1.5 + EDGE_EPS },
  { key: '>1.5', lo: 1.5 + EDGE_EPS, hi: Infinity },
])
/** The per-trade fields the report may return; nothing else leaves the worker. */
export const STOP_PLACEMENT_ROW_FIELDS = Object.freeze([
  'id', 'accountId', 'symbol', 'side', 'strategy', 'timeframe', 'closedAt',
  'stopSource', 'stopAtr', 'atrSource', 'outcomeR', 'netR', 'maeR', 'mfeR',
  'excursionBasis', 'exitKind', 'slippageR',
])

const fin = v => (v == null || v === '' || typeof v === 'boolean' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
const round = (v, dp = 4) => (v == null ? null : Number(v.toFixed(dp)))
const dirOf = side => {
  const s = String(side || '').toUpperCase()
  return s === 'BUY' || s === 'LONG' ? 1 : s === 'SELL' || s === 'SHORT' ? -1 : 0
}
const parseJson = s => { try { return s ? JSON.parse(s) : null } catch { return null } }

/**
 * The stop at entry, and where it came from. Order: the stop the broker first
 * held (broker_sl_initial, fill-anchored, floor included); the risk gate's
 * floored stop (checks.stop_floor.to, when it widened); the proposal's stop;
 * the monitor's recorded initial risk; and sl_price only for a trade the
 * momentum book never trailed (the book overwrites it). The same order as
 * loss-postmortem.js initialRiskOf, with the floor's stop ahead of the
 * proposal's — the proposal's is the stop BEFORE the floor widened it, not
 * the one the trade carried.
 * @returns {{ stop:number|null, risk:number|null, source:string|null }}
 */
export function stopAtEntryOf(t) {
  const entry = fin(t?.entry_price), dir = dirOf(t?.side)
  if (!(entry > 0) || !dir) return { stop: null, risk: null, source: null }
  // A stop on the loss side of the entry; anything else is not a stop at entry.
  const asStop = v => {
    const sl = fin(v)
    return sl > 0 && (entry - sl) * dir > 0 ? sl : null
  }
  const floor = t?.stop_floor && typeof t.stop_floor === 'object' ? t.stop_floor : null
  for (const [source, v] of [['broker_sl_initial', t?.broker_sl_initial], ['stop_floor', floor?.to], ['proposal_sl', t?.proposal_sl]]) {
    const stop = asStop(v)
    if (stop != null) return { stop, risk: Math.abs(entry - stop), source }
  }
  const ir = fin(t?.initial_risk)
  if (ir > 0) return { stop: entry - dir * ir, risk: ir, source: 'initial_risk' }
  if (!Number(t?.book_trailed)) {
    const stop = asStop(t?.sl_price)
    if (stop != null) return { stop, risk: Math.abs(entry - stop), source: 'sl_price' }
  }
  return { stop: null, risk: null, source: null }
}

/** The 1h ATR the risk gate saw at approval, from checks_json.stop_floor; null when it found none. */
export function atrAtApprovalOf(checks) {
  const sf = checks?.stop_floor
  if (!sf || typeof sf !== 'object') return { atr: null, source: sf === 'no_atr' ? 'no_atr' : null }
  const atr = fin(sf.atr1h)
  return { atr: atr > 0 ? atr : null, source: typeof sf.source === 'string' ? sf.source : null }
}

export function stopAtrBucket(stopAtr) {
  if (stopAtr == null || !Number.isFinite(stopAtr)) return 'no_atr'
  return STOP_ATR_BUCKETS.find(b => stopAtr >= b.lo && stopAtr < b.hi)?.key ?? 'no_atr'
}

/**
 * One trade's review row, or `{ excluded: reason }`. Outcome R is the price
 * move from the entry to the exit over the stop at entry. Net R scales the
 * net money by the money one R was worth on this trade (gross ÷ outcome R),
 * so costs count in R without a currency conversion; it is withheld when
 * the money and the price move disagree in sign (a record defect, not a
 * result) or the trade exited at its entry with gross money of zero.
 */
export function reviewRow(t) {
  if (isSuperseded(t)) return { excluded: 'superseded' }
  if (Number(t.exit_price_suspect) === 1) return { excluded: 'exit_price_suspect' }
  const entry = fin(t.entry_price), exit = fin(t.exit_price), dir = dirOf(t.side)
  if (!(entry > 0) || !(exit > 0) || !dir) return { excluded: 'no_prices' }
  const { stop, risk, source: stopSource } = stopAtEntryOf(t)
  if (!(risk > 0)) return { excluded: 'no_stop_at_entry' }
  const outcomeR = ((exit - entry) * dir) / risk
  const gross = fin(t.gross_pnl), net = fin(t.net_pnl)
  let netR = null
  if (Number(t.pnl_price_mismatch) !== 1 && net != null) {
    if (gross != null && gross !== 0 && Math.abs(outcomeR) > 1e-9 && Math.sign(gross) === Math.sign(outcomeR)) netR = net / (gross / outcomeR)
    else if (gross === 0 && Math.abs(outcomeR) <= 1e-9 && net === 0) netR = 0
  }
  const { atr, source: atrSource } = atrAtApprovalOf(t.checks)
  const stopAtr = atr > 0 ? risk / atr : null
  // MAE/MFE: the monitor's record, exit side where kept (13-10 on), else mid;
  // both in R of the monitor's initial risk, rescaled to this stop's R.
  const mpRisk = fin(t.mp_initial_risk)
  const scale = mpRisk > 0 ? mpRisk / risk : null
  const exitSide = fin(t.mfe_exit_r) != null || fin(t.mae_exit_r) != null
  const rawMae = exitSide ? fin(t.mae_exit_r) : fin(t.mae_r)
  const rawMfe = exitSide ? fin(t.mfe_exit_r) : fin(t.mfe_r)
  const maeR = scale != null && rawMae != null ? rawMae * scale : null
  const mfeR = scale != null && rawMfe != null ? rawMfe * scale : null
  const exitKind = classifyOutcome(t)
  // Slippage past the stop, stop exits only: the last stop the bot knew the
  // broker held (it may have been moved after entry), else the stop at entry.
  let slippageR = null
  if (exitKind === 'sl') {
    const held = fin(t.mp_broker_sl) ?? fin(t.mp_current_sl) ?? stop
    if (held > 0) slippageR = Math.max(0, (held - exit) * dir) / risk
  }
  return {
    row: {
      id: Number(t.id),
      accountId: t.account_id == null ? null : String(t.account_id),
      symbol: t.symbol ?? null,
      side: dir === 1 ? 'long' : 'short',
      strategy: t.strategy_attr ?? null,
      timeframe: t.timeframe ?? null,
      closedAt: closedAtMs(t) != null ? new Date(closedAtMs(t)).toISOString() : null,
      stopSource,
      stopAtr: round(stopAtr),
      atrSource,
      outcomeR: round(outcomeR),
      netR: round(netR),
      maeR: round(maeR),
      mfeR: round(mfeR),
      excursionBasis: maeR == null && mfeR == null ? null : exitSide ? 'exit' : 'mid',
      exitKind,
      slippageR: round(slippageR),
    },
  }
}

/** n, win rate, average win/loss, PF, mean and lower-bound net R, never-in-profit losers; INSUFFICIENT under 30. */
export function bucketStats(rows) {
  const scored = rows.filter(r => r.netR != null)
  const wins = scored.filter(r => r.netR > 0), losses = scored.filter(r => r.netR < 0)
  const sum = xs => xs.reduce((s, r) => s + r.netR, 0)
  const grossWin = sum(wins), grossLoss = -sum(losses)
  const losersWithPeak = losses.filter(r => r.mfeR != null)
  const never = losersWithPeak.filter(r => r.mfeR <= NEVER_IN_PROFIT_R).length
  const slips = rows.filter(r => r.slippageR != null)
  const n = scored.length
  return {
    n,
    unscored: rows.length - n,
    verdict: n < STOP_PLACEMENT_MIN_SAMPLE ? 'INSUFFICIENT' : 'MEASURED',
    winRate: n ? round(wins.length / n) : null,
    avgWinR: wins.length ? round(grossWin / wins.length) : null,
    avgLossR: losses.length ? round(-grossLoss / losses.length) : null,
    profitFactor: losses.length ? round(grossWin / grossLoss) : null,
    lossless: n > 0 && losses.length === 0,
    expectancyR: n ? round(sum(scored) / n) : null,
    expectancyLowerR: expectancyLowerR(scored.map(r => r.netR)),
    losersNeverInProfit: { n: never, of: losersWithPeak.length, share: losersWithPeak.length ? round(never / losersWithPeak.length) : null },
    stopExits: slips.length,
    avgSlippageR: slips.length ? round(slips.reduce((s, r) => s + r.slippageR, 0) / slips.length) : null,
  }
}

function bucketed(rows) {
  const keys = [...STOP_ATR_BUCKETS.map(b => b.key), 'no_atr']
  return keys.map(key => ({ bucket: key, ...bucketStats(rows.filter(r => stopAtrBucket(r.stopAtr) === key)) }))
}

/**
 * @param {import('better-sqlite3').Database} db  a read-only connection is enough
 * @param {{ account?: string, days?: number, now?: number }} opts  `account` 'all' or a validated id
 */
export function stopPlacementReport(db, { account = 'all', days = STOP_PLACEMENT_DEFAULT_DAYS, now = Date.now() } = {}) {
  const cutoffMs = now - days * 86_400_000
  const scoped = account !== 'all'
  const origins = CLEAN_BOT_ORIGINS.map(() => '?').join(', ')
  const raw = db.prepare(`
    SELECT t.id, t.account_id, t.symbol, t.side, t.origin, t.status, t.close_reason,
           t.entry_price, t.exit_price, t.sl_price, t.tp_price, t.broker_sl_initial,
           t.gross_pnl, t.net_pnl, t.pnl_price_mismatch, t.exit_price_suspect,
           t.closed_at, t.closed_at_ms,
           ${strategyAttrSql('t.label_strategy', 't.strategy')} AS strategy_attr,
           COALESCE(NULLIF(t.label_timeframe, ''),
             (SELECT CASE WHEN json_valid(re.proposal_json) THEN json_extract(re.proposal_json, '$.timeframe') END
                FROM risk_events re WHERE re.id = t.risk_event_id)) AS timeframe,
           (SELECT CASE WHEN json_valid(re.proposal_json) THEN json_extract(re.proposal_json, '$.sl') END
              FROM risk_events re WHERE re.id = t.risk_event_id) AS proposal_sl,
           (SELECT CASE WHEN json_valid(re.checks_json) THEN re.checks_json END
              FROM risk_events re WHERE re.id = t.risk_event_id) AS checks_json,
           mp.initial_risk AS mp_initial_risk, mp.mae_r, mp.mfe_r, mp.mae_exit_r, mp.mfe_exit_r,
           mp.broker_sl AS mp_broker_sl, mp.current_sl AS mp_current_sl,
           EXISTS (SELECT 1 FROM momentum_book b WHERE b.trade_id = t.id) AS book_trailed
    FROM trades t
    LEFT JOIN monitored_positions mp ON mp.id = (SELECT MAX(id) FROM monitored_positions WHERE trade_id = t.id)
    WHERE t.status = 'closed'
      AND t.origin IN (${origins})
      ${scoped ? 'AND t.account_id = ?' : ''}
      AND COALESCE(t.closed_at_ms, CAST(strftime('%s', t.closed_at) AS INTEGER) * 1000) >= ?
    ORDER BY t.id DESC`).all(...CLEAN_BOT_ORIGINS, ...(scoped ? [account] : []), cutoffMs)
  const excluded = {}
  const rows = []
  for (const t of raw) {
    const checks = parseJson(t.checks_json)
    const r = reviewRow({ ...t, checks, stop_floor: checks?.stop_floor })
    if (r.excluded) { excluded[r.excluded] = (excluded[r.excluded] || 0) + 1; continue }
    rows.push(r.row)
  }
  const strategies = [...new Set(rows.map(r => r.strategy ?? 'unknown'))].sort()
  return {
    report: 'stop-placement',
    account,
    days,
    method: {
      population: `closed trades with origin ${CLEAN_BOT_ORIGINS.join(' / ')}, closed in the last ${days} days`,
      stopAtEntry: 'broker_sl_initial → the risk gate\'s floored stop → the proposal\'s stop → the monitor\'s initial risk → sl_price (never for a book-trailed trade)',
      atr: '1h ATR the risk gate recorded at approval (risk_events.checks_json.stop_floor.atr1h); none recorded → bucket no_atr',
      outcomeR: '(exit − entry) × direction ÷ stop at entry',
      netR: 'net P&L ÷ (gross P&L ÷ outcome R); withheld when money and price move disagree in sign',
      excursion: 'the monitor\'s MAE/MFE (exit side where recorded, else mid), rescaled to this stop\'s R',
      losersNeverInProfit: `losers whose peak (MFE) stayed at or below ${NEVER_IN_PROFIT_R}R`,
      slippage: 'stop exits only: past the last stop the broker was known to hold, in R',
      sample: `a bucket with fewer than ${STOP_PLACEMENT_MIN_SAMPLE} scored trades reads INSUFFICIENT`,
    },
    population: { considered: raw.length, included: rows.length, excluded },
    buckets: bucketed(rows),
    byStrategy: strategies.map(strategy => {
      const own = rows.filter(r => (r.strategy ?? 'unknown') === strategy)
      return { strategy, ...bucketStats(own), buckets: bucketed(own) }
    }),
    rows: rows.slice(0, STOP_PLACEMENT_ROW_CAP),
    rowsTruncated: rows.length > STOP_PLACEMENT_ROW_CAP,
  }
}
