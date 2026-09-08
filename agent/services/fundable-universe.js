// ---------------------------------------------------------------------------
// agent/services/fundable-universe.js — sizing that reaches the goal or says
// why (§7,437·B·3, owner order 08-09-2026 18:40 SGT).
//
// The risk gate answered "insufficient_equity min_lot=0.01 computed=0
// risk_budget=$0.55 usd_per_lot=$98.79" every hour on names an account can
// never fund, and "below_min_volume" on the rest — measured 08-09 on
// ACCT-LIVE-1: LLY.US, GD.US, JPM.US, 0005.HK, hourly, forever. Each refusal
// was correct and none of them was information: the answer was known the
// moment the account's balance and the symbol's minimum lot were.
//
// This is the pre-trade budget planner: once a day per account, for every
// symbol on that account's watchlist, at the MINIMUM lot — what would one
// lot-step risk at a reference stop (1 ATR from the regime table, else
// refStopPct of price), what margin would it lock, and does the account's
// risk budget and margin headroom cover both? The answer is a table the owner
// can act on (fundable / needs risk raised to X% / margin-bound), written as
// this account's record, and the gates read it BEFORE building an order: an
// unfundable name is skipped by name with a decision row, not analysed,
// sized and refused an hour later again.
//
// Unknown is never a block: no record, a stale record, or a symbol the record
// never saw all dispatch exactly as before and the risk gate decides.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { readWatchlist } from './watchlists.js'
import { loadRiskConfig, riskBudgetUsd, requiredMargin, marginRateFor, getAccountBalance, getAccountLeverage, accountMarginPool } from './risk.js'
import { usdLossPerLot } from '../lib/contracts.js'

export const FUNDABLE_KEY = (accountId) => `acct:${accountId}:fundable_universe_json`
export const FUNDABLE_LAST_KEY = 'fundable_universe_last_json'
export const FUNDABLE_REBUILD_KEY = 'fundable_universe_rebuild_requested_ms'
export const DEFAULT_REF_STOP_PCT = 1.0
export const FUNDABLE_MAX_AGE_MS = 24 * 3600_000
export const FUNDABLE_STALE_MS = 3 * FUNDABLE_MAX_AGE_MS

const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }
const r2 = (v) => Math.round(v * 100) / 100

/**
 * One symbol, one account, at the minimum lot. Pure.
 *
 * @returns {{ok:boolean, reason:string|null, minLot:number|null, price:number|null, stopDist:number|null, stopSource:string,
 *            minLotRiskUsd:number|null, minLotMarginUsd:number|null, neededRiskPct:number|null, lotsAtBudget:number|null}}
 */
export function planFundability({ symbol, price, minLot, balance, riskBudgetUsd: budget, headroomUsd = null, atr = null, refStopPct = DEFAULT_REF_STOP_PCT, leverage = 100, rates = null, marginRate = null } = {}) {
  const out = { ok: false, reason: null, minLot: num(minLot), price: num(price), stopDist: null, stopSource: 'none', minLotRiskUsd: null, minLotMarginUsd: null, neededRiskPct: null, lotsAtBudget: null }
  if (!(out.price > 0)) { out.reason = 'no_price'; return out }
  if (!(out.minLot > 0)) { out.reason = 'no_lot_meta'; return out }
  if (!(balance > 0)) { out.reason = 'no_balance'; return out }
  const a = num(atr)
  out.stopDist = a > 0 ? a : out.price * (Number(refStopPct) > 0 ? Number(refStopPct) : DEFAULT_REF_STOP_PCT) / 100
  out.stopSource = a > 0 ? 'atr_14' : `ref_${Number(refStopPct) > 0 ? refStopPct : DEFAULT_REF_STOP_PCT}pct`
  const perLot = usdLossPerLot(String(symbol).toUpperCase(), out.stopDist, out.price, rates)
  if (!(perLot > 0)) { out.reason = 'usd_per_lot_unknown'; return out }
  out.minLotRiskUsd = r2(perLot * out.minLot)
  out.lotsAtBudget = budget > 0 ? Math.floor((budget / perLot) * 100) / 100 : 0
  let margin = null
  try { margin = requiredMargin(String(symbol).toUpperCase(), out.minLot, out.price, leverage, rates, null, marginRate).marginRequired } catch { margin = null }
  out.minLotMarginUsd = margin != null && Number.isFinite(margin) ? r2(margin) : null
  if (!(budget > 0) || out.minLotRiskUsd > budget) {
    out.neededRiskPct = r2((out.minLotRiskUsd / balance) * 100)
    out.reason = `risk_budget: min lot risks $${out.minLotRiskUsd} at ${out.stopSource} vs budget $${r2(budget || 0)} — needs per-trade risk ≥ ${out.neededRiskPct}%`
    return out
  }
  if (headroomUsd != null && out.minLotMarginUsd != null && out.minLotMarginUsd > headroomUsd) {
    out.reason = `margin: min lot locks $${out.minLotMarginUsd} vs headroom $${r2(headroomUsd)}`
    return out
  }
  out.ok = true
  return out
}

/** Latest ATR(14) on record for a symbol, from the quant phase's regime table. */
export function atrOnRecord(db, symbol) {
  try {
    const row = db.prepare(`SELECT atr_14, atr_pct FROM regimes WHERE symbol = ? ORDER BY computed_at DESC LIMIT 1`).get(String(symbol).toUpperCase())
    return num(row?.atr_14)
  } catch { return null }
}

/**
 * Build this account's record over its watchlist. Broker calls: one symbol
 * lookup, one lot-meta read and one spot per enabled symbol, once a day.
 *
 * deps: symbolIdFor(creds, symbol), volumeMeta(creds, symbolId) → {lotSize, minVolume},
 *       spot(creds, symbolId) → {bid, ask}, rates() → scan rates, headroomOf(accountId) → $|null,
 *       balanceOf(accountId) → $|null, atrOf(symbol) → ATR|null
 */
export async function buildFundableUniverse(db, { accountId, creds, deps = {}, now = Date.now(), config = null } = {}) {
  const id = String(accountId)
  const cfg = config || loadRiskConfig(db)
  const balance = deps.balanceOf ? deps.balanceOf(id) : getAccountBalance(db, id)
  const budget = balance > 0 ? riskBudgetUsd(balance, cfg) : 0
  const leverage = getAccountLeverage(db, cfg, id)
  let headroom = null
  try {
    headroom = deps.headroomOf ? deps.headroomOf(id) : (accountMarginPool(db, cfg, [id], { rates: deps.rates ? deps.rates() : null })[0]?.status?.headroom ?? null)
  } catch { headroom = null }
  const rates = deps.rates ? deps.rates() : null
  const rows = {}
  const byReason = {}
  const items = readWatchlist(db, id).filter(i => i.enabled !== false)
  for (const item of items) {
    const symbol = String(item.symbol).toUpperCase()
    let row
    try {
      const sid = deps.symbolIdFor ? await deps.symbolIdFor(creds, symbol) : null
      if (sid == null) { row = planFundability({ symbol, price: null }); row.reason = 'unknown_symbol' } else {
        const meta = deps.volumeMeta ? await deps.volumeMeta(creds, sid) : null
        const minLot = meta && meta.lotSize > 0 && meta.minVolume > 0 ? meta.minVolume / meta.lotSize : (meta ? Number(cfg.minLotSize) || 0.01 : null)
        const q = deps.spot ? await deps.spot(creds, sid) : null
        const price = Number(q?.ask) > 0 ? Number(q.ask) : (Number(q?.bid) > 0 ? Number(q.bid) : null)
        const atr = deps.atrOf ? deps.atrOf(symbol) : atrOnRecord(db, symbol)
        row = planFundability({ symbol, price, minLot, balance, riskBudgetUsd: budget, headroomUsd: headroom, atr, refStopPct: cfg.fundableRefStopPct ?? DEFAULT_REF_STOP_PCT, leverage, rates, marginRate: marginRateFor(cfg, symbol) })
      }
    } catch (err) {
      row = { ok: false, reason: `error: ${String(err?.message || err).slice(0, 120)}` }
    }
    rows[symbol] = row
    const key = row.ok ? 'fundable' : String(row.reason || 'unknown').split(':')[0]
    byReason[key] = (byReason[key] || 0) + 1
  }
  const record = {
    at: new Date(now).toISOString(), accountId: id, balance: balance > 0 ? balance : null, riskBudgetUsd: r2(budget), headroomUsd: headroom != null ? r2(headroom) : null,
    perTradeRiskPct: cfg.perTradeRiskPct ?? null, rows,
    summary: { total: items.length, fundable: Object.values(rows).filter(r => r.ok).length, byReason },
  }
  setState(db, FUNDABLE_KEY(id), JSON.stringify(record))
  let last = {}
  try { last = JSON.parse(getState(db, FUNDABLE_LAST_KEY) || '{}') || {} } catch { last = {} }
  const accounts = { ...(last.accounts || {}), [id]: { at: record.at, fundable: record.summary.fundable, total: record.summary.total } }
  setState(db, FUNDABLE_LAST_KEY, JSON.stringify({ at: record.at, accounts }))
  return record
}

export function loadFundableUniverse(db, accountId) {
  try { return JSON.parse(getState(db, FUNDABLE_KEY(String(accountId))) || 'null') } catch { return null }
}

/** Is a rebuild due for this account: no record, a day old, or a rebuild requested since it was written. */
export function fundableDue(db, accountId, now = Date.now()) {
  const rec = loadFundableUniverse(db, accountId)
  const at = Date.parse(rec?.at || '')
  if (!Number.isFinite(at)) return true
  if (now - at >= FUNDABLE_MAX_AGE_MS) return true
  const req = num(getState(db, FUNDABLE_REBUILD_KEY))
  return req != null && req > at
}

/**
 * The gate's read. Unknown is never a block: `known` says whether the record
 * actually had a verdict on this symbol.
 */
export function isFundable(db, accountId, symbol, { now = Date.now() } = {}) {
  const rec = loadFundableUniverse(db, accountId)
  const at = Date.parse(rec?.at || '')
  if (!rec || !Number.isFinite(at)) return { ok: true, known: false, reason: 'no fundable-universe record for this account' }
  if (now - at > FUNDABLE_STALE_MS) return { ok: true, known: false, stale: true, reason: `fundable-universe record ${Math.round((now - at) / 3600_000)}h old — not enforced` }
  const row = rec.rows?.[String(symbol).toUpperCase()]
  if (!row) return { ok: true, known: false, reason: 'symbol not in the record' }
  if (row.ok) return { ok: true, known: true, reason: null }
  return { ok: false, known: true, reason: `unfundable at min lot — ${row.reason}`, row }
}

/** The report: every account's record, summarised, with the unfundable names and what would fund them. */
export function fundableUniverseReport(db, accountIds = [], { now = Date.now() } = {}) {
  const accounts = []
  for (const id of accountIds) {
    const rec = loadFundableUniverse(db, id)
    if (!rec) { accounts.push({ accountId: String(id), record: null, due: true }); continue }
    const ageH = Math.round((now - Date.parse(rec.at)) / 360_000) / 10
    const unfundable = Object.entries(rec.rows || {}).filter(([, r]) => !r.ok)
      .map(([symbol, r]) => ({ symbol, reason: r.reason, minLotRiskUsd: r.minLotRiskUsd ?? null, neededRiskPct: r.neededRiskPct ?? null, minLotMarginUsd: r.minLotMarginUsd ?? null }))
      .sort((a, b) => (a.neededRiskPct ?? Infinity) - (b.neededRiskPct ?? Infinity))
    accounts.push({
      accountId: String(id), at: rec.at, ageHours: ageH, due: fundableDue(db, id, now), balance: rec.balance, riskBudgetUsd: rec.riskBudgetUsd, headroomUsd: rec.headroomUsd,
      summary: rec.summary, fundable: Object.keys(rec.rows || {}).filter(s => rec.rows[s].ok), unfundable,
    })
  }
  return {
    at: new Date(now).toISOString(), accounts,
    note: 'Built once a day per account at the MINIMUM lot against a 1-ATR reference stop (else refStopPct of price). risk_budget rows say the per-trade risk % that would fund the name; margin rows are bound by the pool headroom. The gates skip unfundable names before an order is built; unknown names dispatch as before.',
  }
}
