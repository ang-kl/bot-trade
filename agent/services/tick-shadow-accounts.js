// ---------------------------------------------------------------------------
// agent/services/tick-shadow-accounts.js — §2 PR-2a: the ACCOUNT EXECUTION
// SIMULATION, beside the shared market-signal simulation, not instead of it.
//
// WHAT WAS THERE BEFORE, AND STAYS. `services/tick-shadow.js` holds the SHARED
// simulation: the sidecar's shadow book fills the strategy's signals by the
// replayer's rules on the live quotes, and `tick_shadow_trades` records the
// result per (side, profile) with NO account column. That table is the
// market-signal record and this module does not add a single account field to
// it. `shadowPortfolio`'s per-account block is a 1R RESCALE — `stats.netR ×
// risk.usdPerR` — and it is untouched, still carrying its own `projectionNote`
// ("ignores minimum lots, margin, per-symbol caps and the position cap; a
// display, not evidence"). Retained, and labelled.
//
// WHAT THIS ADDS. For each shared shadow trade × each enabled account on that
// side, whether THAT account could actually have executed it, under its own:
//
//   · stamped balance — `acct:<id>:account_balance_usd`, the scoped key ONLY
//   · perTradeRiskPct / perTradeRiskUsd / maxRiskCapPct, via `riskBudgetUsd`
//   · THE REAL `drawdownDeriskFactor`. The rescale hard-codes ddFactor = 1
//     (tick-shadow.js:182) and so reports an account that the anti-tilt layer
//     has halved as though it were sizing normally. This reads the factor.
//   · `sharedSignalRiskSplit` — ONE signal fanned to N accounts splits the
//     budget, it does not multiply it (risk.js E·2)
//   · the broker's minimum lot AND lot increment (lib/lot-size-registry.js),
//     snapped in that order: step first, then the minimum test
//   · margin: the account's own `portfolioMarginStatus` cap and used margin,
//     plus the margin this simulation's own still-open positions hold
//   · existing exposure: `openPositionsForAccount`
//   · open and pending intents: `pendingExposure` (entry-ledger.js:335, which
//     until now nothing called)
//   · the position cap `maxOpenPositions` — read, never changed
//
// A REFUSED SIGNAL IS A ROW. Every (trade, account) pair produces a row, with
// a first-class `reason` when it could not execute. The question "why could
// this account not take a signal the market gave" is answered from the table,
// not from an absence.
//
// ────────────────────────────────────────────────────────────────────────────
// THE COUNTING RULE — shared observations are counted ONCE.
//
// The evidence count is the number of DISTINCT SHARED SHADOW TRADES in the
// window. The rows this module writes are EXECUTIONS of those same
// observations by different accounts; they are never summed into an evidence
// total. Projecting one trade onto five accounts is one observation, five
// projections — not five observations. Summing them would multiply a sample by
// the number of accounts and manufacture independent evidence that does not
// exist, which is precisely what the owner's instruction forbids.
//
// It is enforced here and not merely written down: `evidenceCount()` returns
// the shared count and nothing else, the summary carries `sharedObservations`
// alongside `accountRows` with the rule on the record, and
// `tick-shadow-accounts.test.js` pins it by name.
// ────────────────────────────────────────────────────────────────────────────
//
// Account ids appear in output as the last four digits only.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import {
  drawdownDeriskFactor, getAccountLeverage, loadRiskConfig, marginRateFor,
  openPositionsForAccount, portfolioMarginStatus, requiredMargin, riskBudgetUsd, scanRates,
} from './risk.js'
import { pendingExposure } from './entry-ledger.js'
import { sharedShadowTrades, sideAccounts, sideCostSchedule } from './tick-shadow.js'
import { brokerLotStep, brokerMinLots, unitsPerLot } from '../lib/lot-size-registry.js'
import { usdLossPerLot } from '../lib/contracts.js'
import { accountSymbolMapKey } from '../lib/ctrader-creds.js'
import {
  costsForClass, loadSizedCommission, repriceNetR, scheduleHash,
  sizedCommissionUsdRoundTrip, WIRE_PER_PRICE,
} from '../lib/tick-cost-schedule.js'
import { costBasis } from '../lib/tick-exec-measurements.js'

/**
 * Why an account could not execute a signal the shared book took. Ordered as
 * the checks run — the FIRST reason that bites is the one recorded, so a row
 * names the binding constraint rather than the last one tested.
 *
 * `symbol_unmapped` is not in the owner's list and is added deliberately: a
 * shadow row carries a symbol ID and no name, and without a name there is no
 * lot size, no margin rate and no cost class. Dropping those rows would hide
 * them, which is the one thing this table exists to prevent.
 */
export const REFUSAL_REASONS = Object.freeze([
  'balance_not_read', 'symbol_unmapped', 'symbol_already_held', 'intent_open',
  'position_cap', 'below_min_lot', 'margin_insufficient', 'unpriceable',
])

const last4 = (id) => `…${String(id).slice(-4)}`
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }

/** Wire units → the symbol's own price. */
const priceOf = (wire) => (Number.isFinite(Number(wire)) ? Number(wire) / WIRE_PER_PRICE : null)

/** symbolId → NAME, from the account's own map first, then the global one. */
function symbolNameResolver(db, accountId) {
  const inv = new Map()
  const add = (obj) => {
    if (!obj || typeof obj !== 'object') return
    for (const [name, id] of Object.entries(obj)) if (id != null && !inv.has(String(id))) inv.set(String(id), String(name))
  }
  // The GLOBAL map is added first and the account's own map second, so the
  // account's own answer wins where the two disagree (per-account symbol ids
  // are real in this repo — #838).
  try { add(JSON.parse(getState(db, 'symbol_id_map') || '{}')) } catch { /* unreadable → account map alone */ }
  try {
    const own = JSON.parse(getState(db, accountSymbolMapKey(accountId)) || 'null')
    const m = own && typeof own === 'object' ? (own.map ?? own) : null
    if (m) for (const [name, id] of Object.entries(m)) if (id != null) inv.set(String(id), String(name))
  } catch { /* unreadable → global map alone */ }
  return (symbolId) => (symbolId == null ? null : inv.get(String(symbolId)) || null)
}

/** Snap DOWN to the broker's lot increment; an unknown step leaves the size alone. */
export function snapToStep(lots, stepLots) {
  const L = Number(lots), s = Number(stepLots)
  if (!(L > 0)) return 0
  if (!(s > 0)) return Math.floor(L * 100) / 100   // the repo's 2dp convention when the broker has not said
  return Math.floor(L / s) * s
}

/**
 * The static, per-account context one pass over the shared trades runs under.
 * Everything here is READ — nothing is changed, and no limit is moved.
 */
export function accountContext(db, accountId, { sharedAccounts = 1, rates = null } = {}) {
  const id = String(accountId)
  const raw = getState(db, `acct:${id}:account_balance_usd`)
  const balance = raw == null || String(raw).trim() === '' ? null : num(raw)
  const cfg = loadRiskConfig(db, id)
  if (!(balance > 0)) {
    return { accountId: id, balance: null, config: cfg, blocked: 'balance_not_read' }
  }
  // THE FIX THE RESCALE DOES NOT HAVE: the real anti-tilt factor, not 1.
  const ddFactor = drawdownDeriskFactor(db, balance, cfg, id)
  const budget = riskBudgetUsd(balance, cfg, ddFactor)
  // E·2: one signal, N accounts — the budget is SPLIT, not multiplied.
  const n = Number(sharedAccounts)
  const sharedSplit = cfg.sharedSignalRiskSplit !== 'off' && Number.isFinite(n) && n > 1 ? 1 / n : 1
  const leverage = getAccountLeverage(db, cfg, id)
  const open = openPositionsForAccount(db, id)
  const openCount = openPositionsForAccount(db, id, { countOnly: true }).length
  const margin = portfolioMarginStatus(db, cfg, { balance, leverage, rates, accountId: id })
  const intents = pendingExposure(db, id)
  return {
    accountId: id,
    balance,
    config: cfg,
    ddFactor,
    riskBudgetUsd: +(budget * sharedSplit).toFixed(2),
    baseBudgetUsd: +budget.toFixed(2),
    sharedSplit,
    leverage,
    maxOpenPositions: cfg.maxOpenPositions,
    heldSymbols: new Set(open.map(p => String(p.symbol || '').toUpperCase()).filter(Boolean)),
    openCount,
    intentSymbols: new Set(intents.map(i => String(i.symbol || '').toUpperCase()).filter(Boolean)),
    intentSymbolIds: new Set(intents.map(i => (i.symbolId == null ? null : String(i.symbolId))).filter(Boolean)),
    marginUsedUsd: margin ? margin.usedMargin : null,
    marginCapUsd: margin ? margin.cap : null,
    marginSource: margin ? margin.source : null,
    blocked: null,
  }
}

/**
 * One shared shadow trade against one account, at one point in that account's
 * simulated state. Returns the row that will be recorded — executed or not.
 *
 * `state` carries what the pass has done so far on this account: the
 * still-open simulated positions (each `{symbol, exitMs, marginUsd}`). The
 * caller retires the ones this trade's entry has already outlived BEFORE
 * calling, so the cap and the margin are read at the moment of the entry.
 */
export function decideOne(db, trade, ctx, state, cost) {
  const base = {
    shadowTradeId: trade.id ?? null,
    side: trade.side ?? null,
    profileHash: trade.profile_hash ?? null,
    symbolId: trade.symbol_id ?? null,
    symbol: null,
    executed: false,
    reason: null,
    lots: null, lotStep: null, minLots: null,
    riskBudgetUsd: ctx.riskBudgetUsd ?? null,
    ddFactor: ctx.ddFactor ?? null,
    sharedSplit: ctx.sharedSplit ?? null,
    usdPerR: null,
    marginRequiredUsd: null, marginUsedUsd: null, marginCapUsd: ctx.marginCapUsd ?? null,
    commissionUsd: null, grossUsd: null, netUsd: null, netR: null,
    costClass: null, costBasis: null, scheduleHash: cost.hash,
    sensitivityUsd: null,
  }
  if (ctx.blocked) return { ...base, reason: ctx.blocked }

  const symbol = ctx.nameOf(trade.symbol_id)
  if (!symbol) return { ...base, reason: 'symbol_unmapped' }
  base.symbol = symbol
  const SYM = symbol.toUpperCase()

  // Existing exposure: a real open position on the symbol, or one this
  // simulation already holds. Same direction or not — the repo's duplicate
  // guard is per symbol, and so is this.
  if (ctx.heldSymbols.has(SYM) || state.open.some(p => p.symbol === SYM)) return { ...base, reason: 'symbol_already_held' }
  // An open or pending intent on the symbol: the permit ledger already has
  // this account trying to open risk there.
  if (ctx.intentSymbols.has(SYM) || (trade.symbol_id != null && ctx.intentSymbolIds.has(String(trade.symbol_id)))) return { ...base, reason: 'intent_open' }
  // The position cap — its value is read, never moved.
  if (ctx.openCount + state.open.length >= ctx.maxOpenPositions) return { ...base, reason: 'position_cap' }

  const entryPrice = priceOf(trade.entry)
  const exitPrice = priceOf(trade.exit)
  const stopPriceDistance = priceOf(trade.stop_distance)
  if (!(entryPrice > 0) || !(exitPrice > 0) || !(stopPriceDistance > 0)) return { ...base, reason: 'unpriceable' }

  const per = unitsPerLot(db, symbol)
  const usdPerLot = usdLossPerLot(symbol, stopPriceDistance, entryPrice, ctx.rates, per.unitsPerLot)
  if (!Number.isFinite(usdPerLot) || !(usdPerLot > 0)) return { ...base, reason: 'unpriceable' }

  // Size: the account's own budget (de-risked and split) ÷ what one lot loses
  // at this stop, snapped DOWN to the broker's step, THEN tested against the
  // broker's minimum. Step first: snapping after the minimum test turns a
  // refusable order into an apparently fillable one.
  const bMin = brokerMinLots(db, symbol)
  const bStep = brokerLotStep(db, symbol)
  const minLots = bMin.minLots ?? ctx.config.minLotSize
  const lots = snapToStep(ctx.riskBudgetUsd / usdPerLot, bStep.stepLots)
  base.lots = +lots.toFixed(6); base.lotStep = bStep.stepLots; base.minLots = minLots
  if (!(lots > 0) || lots < minLots) return { ...base, reason: 'below_min_lot' }

  const marginRate = marginRateFor(ctx.config, symbol)
  const { marginRequired } = requiredMargin(symbol, lots, entryPrice, ctx.leverage, ctx.rates, per.unitsPerLot, marginRate)
  const used = (ctx.marginUsedUsd ?? 0) + state.marginUsd
  base.marginRequiredUsd = num(marginRequired) != null ? +marginRequired.toFixed(2) : null
  base.marginUsedUsd = +used.toFixed(2)
  if (ctx.marginCapUsd != null && Number.isFinite(marginRequired) && used + marginRequired > ctx.marginCapUsd) {
    return { ...base, reason: 'margin_insufficient' }
  }

  // ---- executed ----------------------------------------------------------
  // The shared row's `gross_r` already carries whatever slippage that book
  // filled at (rowChargedUnder: net = gross − commission), so the account's
  // P&L starts from GROSS and pays the SIZE-AWARE commission — charging the
  // row's own size-free commission as well would bill the same trade twice.
  const usdPerR = lots * usdPerLot
  const grossR = num(trade.gross_r)
  const rowClass = trade.cost_class || cost.classOfSymbol(trade.symbol_id) || null
  const classRow = costsForClass(cost.schedule, rowClass)
  const comm = sizedCommissionUsdRoundTrip(classRow, classRow.class, {
    entryUsd: entryPrice, exitUsd: exitPrice, lots, unitsPerLot: per.unitsPerLot, sized: cost.sized, multiple: 1,
  })
  const grossUsd = grossR != null ? grossR * usdPerR : null
  const netUsd = grossUsd != null ? grossUsd - comm.usd : null

  // COST SENSITIVITY, on every executed row (PR-2c). The slippage term is a
  // PLACEHOLDER, so a single 1x figure is an assumption wearing a decimal
  // point. 0x / 1x / 2x: slippage re-priced through the shared machinery
  // (`repriceNetR` with commission zeroed, which strips the row's own
  // slippage and re-applies the schedule's at the multiple), commission
  // charged size-aware at the same multiple.
  const slipOnly = { ...classRow, commissionWirePerSide: 0, commissionBpsPerSide: 0 }
  const sensitivityUsd = {}
  for (const k of [0, 1, 2]) {
    const rK = repriceNetR(trade, slipOnly, k)
    const cK = sizedCommissionUsdRoundTrip(classRow, classRow.class, {
      entryUsd: entryPrice, exitUsd: exitPrice, lots, unitsPerLot: per.unitsPerLot, sized: cost.sized, multiple: k,
    })
    sensitivityUsd[k] = rK == null ? null : +(rK * usdPerR - cK.usd).toFixed(2)
  }

  return {
    ...base,
    executed: true,
    reason: null,
    usdPerR: +usdPerR.toFixed(2),
    commissionUsd: +comm.usd.toFixed(4),
    grossUsd: grossUsd != null ? +grossUsd.toFixed(2) : null,
    netUsd: netUsd != null ? +netUsd.toFixed(2) : null,
    netR: netUsd != null && usdPerR > 0 ? +(netUsd / usdPerR).toFixed(4) : null,
    costClass: classRow.class,
    costBasis: comm.basis,
    sensitivityUsd,
    _sim: { symbol: SYM, exitMs: num(trade.exit_ms), marginUsd: Number.isFinite(marginRequired) ? marginRequired : 0 },
  }
}

/**
 * THE EVIDENCE COUNT — shared observations, counted ONCE.
 *
 * This is the ONLY function in this module that returns a count fit to be read
 * as evidence, and it returns the number of distinct shared shadow trades. It
 * does not take the account rows as an argument, because there is no correct
 * way to add them into it.
 */
export function evidenceCount(sharedTrades) {
  const ids = new Set()
  for (const t of sharedTrades || []) ids.add(t.id ?? `${t.side}:${t.boot_id}:${t.seq}`)
  return ids.size
}

/**
 * The account execution simulation for one side / profile / window.
 *
 * @param {object} db
 * @param {{side:string, profilePrefix?:string|null, sinceMs?:number|null, persist?:boolean, limit?:number}} opts
 */
export function accountExecutionSim(db, { side, profilePrefix = null, sinceMs = null, persist = false, limit = 5000 } = {}) {
  const shared = sharedShadowTrades(db, { side, profilePrefix, sinceMs, limit })
    // The shared read orders by EXIT; an execution simulation has to run in
    // ENTRY order, because the cap and the margin are read when a position is
    // opened, not when it closes.
    .filter(t => (t.reason || '') !== 'lost_restart')
    .sort((a, b) => (Number(a.entry_ms) || 0) - (Number(b.entry_ms) || 0) || (a.id || 0) - (b.id || 0))

  // WHICH ACCOUNTS BELONG TO THIS SIDE is a ROUTING question, and it is asked
  // through tick-shadow.js's `sideAccounts` — the one reader of `is_live` in
  // this stack (owner principle 1). Nothing here gates on it: every decision
  // below reads balance, limits and evidence.
  const accounts = sideAccounts(db, side, { enabledOnly: true })

  const sideCost = sideCostSchedule(db, side)
  const cost = {
    schedule: sideCost.schedule,
    classOfSymbol: sideCost.classOfSymbol,
    sized: loadSizedCommission(),
    hash: Object.keys(sideCost.schedule.classes).length ? scheduleHash(sideCost.schedule) : null,
  }
  const rates = scanRates(db)

  const perAccount = []
  const allRows = []
  for (const id of accounts) {
    const ctx = accountContext(db, id, { sharedAccounts: accounts.length, rates })
    ctx.rates = rates
    ctx.nameOf = symbolNameResolver(db, id)
    const state = { open: [], marginUsd: 0 }
    const rows = []
    for (const t of shared) {
      const entryMs = Number(t.entry_ms)
      // Retire the simulated positions this entry has already outlived, so the
      // cap and the margin are read at the moment of THIS entry.
      if (Number.isFinite(entryMs)) {
        for (let i = state.open.length - 1; i >= 0; i--) {
          if (Number.isFinite(state.open[i].exitMs) && state.open[i].exitMs <= entryMs) {
            state.marginUsd -= state.open[i].marginUsd
            state.open.splice(i, 1)
          }
        }
        if (state.marginUsd < 0) state.marginUsd = 0
      }
      const row = decideOne(db, t, ctx, state, cost)
      if (row.executed && row._sim) { state.open.push(row._sim); state.marginUsd += row._sim.marginUsd }
      delete row._sim
      rows.push(row)
      allRows.push({ ...row, accountId: id })
    }
    const refusals = {}
    let executed = 0, netUsd = 0
    const sens = { 0: 0, 1: 0, 2: 0 }
    for (const r of rows) {
      if (r.executed) {
        executed++
        if (r.netUsd != null) netUsd += r.netUsd
        for (const k of [0, 1, 2]) if (r.sensitivityUsd?.[k] != null) sens[k] += r.sensitivityUsd[k]
      } else refusals[r.reason] = (refusals[r.reason] || 0) + 1
    }
    perAccount.push({
      accountId: last4(id),
      balance: ctx.balance,
      ddFactor: ctx.ddFactor ?? null,
      baseBudgetUsd: ctx.baseBudgetUsd ?? null,
      riskBudgetUsd: ctx.riskBudgetUsd ?? null,
      sharedSplit: ctx.sharedSplit ?? null,
      maxOpenPositions: ctx.maxOpenPositions ?? null,
      openPositionsNow: ctx.openCount ?? null,
      openIntentsNow: ctx.intentSymbols ? ctx.intentSymbols.size : null,
      marginUsedUsd: ctx.marginUsedUsd != null ? +ctx.marginUsedUsd.toFixed(2) : null,
      marginCapUsd: ctx.marginCapUsd != null ? +ctx.marginCapUsd.toFixed(2) : null,
      marginSource: ctx.marginSource ?? null,
      // `signalsOffered` is the SHARED count seen by this account — it is the
      // same observations, not more of them.
      signalsOffered: shared.length,
      executed,
      refused: shared.length - executed,
      refusals,
      netUsd: +netUsd.toFixed(2),
      costSensitivityUsd: { 0: +sens[0].toFixed(2), 1: +sens[1].toFixed(2), 2: +sens[2].toFixed(2) },
      rows: rows.slice(-50),
    })
  }

  if (persist) persistFills(db, allRows)

  const sharedObservations = evidenceCount(shared)
  return {
    side,
    profile: profilePrefix,
    since: sinceMs != null ? new Date(sinceMs).toISOString() : null,
    // ---- THE COUNTING RULE, on the record with the figures it governs ----
    evidence: {
      sharedObservations,
      accountRows: allRows.length,
      accounts: accounts.length,
      rule: 'the evidence count is sharedObservations. The per-account rows are EXECUTIONS of those same shared observations by different accounts; they are never summed into an evidence total. Projecting one shadow trade onto N accounts is one observation with N projections, not N observations.',
    },
    accounts: perAccount,
    costBasis: costBasis(db, { side }),
    scheduleHash: cost.hash,
    sizedCommission: cost.sized,
    note: 'the ACCOUNT EXECUTION simulation: each account\'s own balance, risk budget (with the real drawdown de-risk factor and the shared-signal split), broker minimum lot and lot increment, margin headroom, existing exposure, open/pending intents and position cap, applied to the SHARED shadow trades. Distinct from shadowPortfolio\'s per-account block, which is a 1R rescale and says so.',
  }
}

/** Write the decided rows; idempotent on (shadow_trade_id, account_id). */
export function persistFills(db, rows) {
  const stmt = db.prepare(`INSERT INTO tick_shadow_account_fills
    (shadow_trade_id, account_id, side, profile_hash, symbol_id, symbol, executed, reason, lots, lot_step, min_lots,
     risk_budget_usd, dd_factor, shared_split, usd_per_r, margin_required_usd, margin_used_usd, margin_cap_usd,
     commission_usd, gross_usd, net_usd, net_r, cost_class, cost_basis, schedule_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(shadow_trade_id, account_id) DO UPDATE SET
      at = datetime('now'), executed = excluded.executed, reason = excluded.reason, lots = excluded.lots,
      lot_step = excluded.lot_step, min_lots = excluded.min_lots, risk_budget_usd = excluded.risk_budget_usd,
      dd_factor = excluded.dd_factor, shared_split = excluded.shared_split, usd_per_r = excluded.usd_per_r,
      margin_required_usd = excluded.margin_required_usd, margin_used_usd = excluded.margin_used_usd,
      margin_cap_usd = excluded.margin_cap_usd, commission_usd = excluded.commission_usd,
      gross_usd = excluded.gross_usd, net_usd = excluded.net_usd, net_r = excluded.net_r,
      cost_class = excluded.cost_class, cost_basis = excluded.cost_basis, schedule_hash = excluded.schedule_hash`)
  let written = 0
  const run = db.transaction((rs) => {
    for (const r of rs) {
      if (r.shadowTradeId == null) continue
      stmt.run(r.shadowTradeId, String(r.accountId), r.side ?? null, r.profileHash ?? null, r.symbolId ?? null, r.symbol ?? null,
        r.executed ? 1 : 0, r.reason ?? null, r.lots ?? null, r.lotStep ?? null, r.minLots ?? null,
        r.riskBudgetUsd ?? null, r.ddFactor ?? null, r.sharedSplit ?? null, r.usdPerR ?? null,
        r.marginRequiredUsd ?? null, r.marginUsedUsd ?? null, r.marginCapUsd ?? null,
        r.commissionUsd ?? null, r.grossUsd ?? null, r.netUsd ?? null, r.netR ?? null,
        r.costClass ?? null, r.costBasis ?? null, r.scheduleHash ?? null)
      written++
    }
  })
  run(rows)
  return { written }
}

/** GET /state/tick-shadow-accounts: every side, every profile seen. */
export function tickShadowAccountsView(db, { persist = false } = {}) {
  const out = {
    at: new Date().toISOString(),
    sides: [],
    note: 'S2 PR-2a: the account execution simulation, beside the shared market-signal simulation. The shared shadow trades are the observations and are counted once; the per-account rows are executions of those same observations and are never summed into an evidence total.',
  }
  for (const side of ['cpp_exec_demo', 'cpp_exec']) {
    let profiles = []
    try { profiles = db.prepare('SELECT profile_hash AS p, COUNT(*) AS n FROM tick_shadow_trades WHERE side = ? GROUP BY profile_hash ORDER BY n DESC').all(side) } catch { profiles = [] }
    out.sides.push({ side, profiles: profiles.map(pr => accountExecutionSim(db, { side, profilePrefix: pr.p, persist })) })
  }
  return out
}
