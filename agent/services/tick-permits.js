// ---------------------------------------------------------------------------
// agent/services/tick-permits.js — P6b: the tick producer through the
// reservation authority (docs/tick-momentum/plan.md §3, §9, §13; register
// TM-09, TM-10, TM-11, TM-40; the 11-09-2026 whole-plan audit's tick gaps).
//
// The sidecar's shadow book fills at the strategy's signal; the firer beside
// it (cpp-exec/src/tick_firer.cpp) places ONE real order per account the
// keeper has put in TICK_MOMENTUM on that executor — with a permit THIS
// feeder pre-issued through the same ledger every other entry uses
// (entry_intents, reserveStandingPermits: the P1b fence on the current
// epoch, one open intent per account/symbol/side, the epoch the sidecar
// checks at the send boundary). Nothing is placed for an account that is
// not listed in `tickEntryAccounts`, and the list is derived here from the
// EFFECTIVE entry mode — the one the sidecar acknowledged — never from the
// requested one.
//
// Sizing is the sidecar's at fire time, from figures this feeder puts on
// the permit: the account's OWN R in dollars (its scoped balance × its own
// per-trade risk; a balance never read issues no permit), the symbol's
// dollar loss per lot per wire price unit, and the broker's lot geometry.
// The cached-minimum-stop sizing the audit named on the VPO tier (B01/B04)
// has no counterpart here: the stop distance is the signal's own.
//
// TM-40: while the account's readiness reports the recorder not RECORDING,
// the mount's reserve reached or the feed dropping events, this feeder
// releases the account's standing permits and pushes none — new tick
// entries pause; the exit owners (trail engine, monitors) are untouched.
// The sidecar refuses on the same condition at fire time, so both layers
// hold it.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { execBaseFor, setExecGuard } from '../lib/exec-engine.js'
import { usdLossPerLot } from '../lib/contracts.js'
import { unitsPerLot } from '../lib/lot-size-registry.js'
import { getState, setState } from '../db.js'
import { engineStatusFor, basesFor } from './entry-mode.js'
import { reserveStandingPermits, releaseStandingReservations, pendingExposure, STANDING_PRODUCERS, TICK_PRODUCER, TICK_PERMIT_TTL_MS } from './entry-ledger.js'
import { accountRiskPerTrade } from './tick-shadow.js'
import { tickSymbolNames, resolveTickSymbolIds } from './exec-guard-sync.js'
import { scanRates, loadRiskConfig, accountMarginPool } from './risk.js'
import { accountPregateVerdict } from './account-pregate.js'
import { permittedSides, trendReadingFor } from './direction-policy.js'

export const TICK_ENTRY_FILE = new URL('../config/tick-entry.json', import.meta.url)
export const DEFAULT_OVERSHOOT_FRACTION = 0.25
// The feed's wire price is 1e-5 of a price unit; cTrader's relative stop
// shares the scale, and so does the sidecar's stopDistance.
export const WIRE_UNIT = 1e-5
// The readiness checks whose failure pauses NEW tick entries (TM-40).
export const PAUSE_CHECKS = Object.freeze(['recorder_recording', 'disk_reserve_clear', 'feed_continuity'])

export const DEFAULT_MIN_STOP_FRACTION = 0.0015 // plan §14 line 212: a 0.15 % minimum stop
export const DEFAULT_MAX_FIRE_DELAY_MS = 5000
export const PAUSED_KEY = 'tick_entry_paused_json'

export function loadTickEntryConfig(file = TICK_ENTRY_FILE) {
  let raw = {}
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { raw = {} }
  const frac = Number(raw.overshootFraction)
  const maxLots = raw.maxLots == null ? null : Number(raw.maxLots)
  const minStop = Number(raw.minStopFraction)
  const delay = Number(raw.maxFireDelayMs)
  return {
    overshootFraction: Number.isFinite(frac) && frac >= 0 ? frac : DEFAULT_OVERSHOOT_FRACTION,
    maxLots: Number.isFinite(maxLots) && maxLots > 0 ? maxLots : null,
    // RACE CHECKER 11-09-2026: without a floor the strategy's stop can be one
    // spread, and the R budget then buys a lot far beyond the account. The
    // sidecar refuses a fill whose stop distance is below this fraction of
    // the entry price (plan §3: the greatest of the volatility distance, the
    // broker's minimum and the account's policy floor).
    minStopFraction: Number.isFinite(minStop) && minStop >= 0 ? minStop : DEFAULT_MIN_STOP_FRACTION,
    // A queued fire older than this at the send is refused (the price bound
    // was judged at the fill, on the worker; the fire thread may lag).
    maxFireDelayMs: Number.isFinite(delay) && delay > 0 ? delay : DEFAULT_MAX_FIRE_DELAY_MS,
  }
}

/** The account's open positions the keeper knows (trades + monitored rows), by symbol. */
export function openPositionsFor(db, accountId) {
  const symbols = new Map()
  const bump = (sym) => { const k = String(sym || '').toUpperCase(); if (k) symbols.set(k, (symbols.get(k) || 0) + 1) }
  try { for (const r of db.prepare(`SELECT symbol FROM trades WHERE account_id = ? AND status IN ('open', 'submitting', 'unconfirmed')`).all(String(accountId))) bump(r.symbol) } catch { /* table absent */ }
  try {
    for (const r of db.prepare(`SELECT symbol, ctrader_position_id FROM monitored_positions WHERE account_id = ? AND status = 'active'`).all(String(accountId))) {
      // a monitored row for a position the trades table already counts is the same position
      let dup = false
      try { dup = r.ctrader_position_id != null && !!db.prepare(`SELECT 1 FROM trades WHERE account_id = ? AND ctrader_position_id = ? AND status IN ('open', 'submitting', 'unconfirmed')`).get(String(accountId), String(r.ctrader_position_id)) } catch { dup = false }
      if (!dup) bump(r.symbol)
    }
  } catch { /* table absent */ }
  let total = 0
  for (const n of symbols.values()) total += n
  return { symbols, total }
}

/** The pause map (PAUSED_KEY): accounts whose tick entries are held, keyed by id. Unreadable reads as none paused. */
export function pausedTickAccounts(db) {
  try { const m = JSON.parse(getState(db, PAUSED_KEY) || '{}'); return m && typeof m === 'object' ? m : {} } catch { return {} }
}

/**
 * The enabled accounts on `side` that ADMIT tick now: basesFor() includes
 * 'tick' — an effective TICK_MOMENTUM, or TIME_BASED + ['bar','tick'] (WP-A
 * "time + tick") — and the record is STABLE (the gateway echoed the epoch).
 * PR-B: every account on the same evidence bar; `side` is routing only.
 */
export function tickEntryAccountsFor(db, side = { isLive: null }, { excludePaused = false } = {}) {
  const paused = excludePaused ? pausedTickAccounts(db) : {}
  let rows = []
  try {
    rows = db.prepare('SELECT account_id FROM accounts WHERE enabled = 1' + (side?.isLive == null ? '' : ' AND is_live = ?'))
      .all(...(side?.isLive == null ? [] : [side.isLive ? 1 : 0]))
  } catch { return [] }
  const out = []
  for (const r of rows) {
    const st = engineStatusFor(db, r.account_id)
    // PR-3: "admits tick" is basesFor, not a mode string — an account on
    // ['bar','tick'] is a tick account too. exec-guard-sync.js's placing list
    // asks the same function; the two MUST move together (see the pause map
    // note below: they used to oscillate).
    if (!basesFor(st).includes('tick') || st.transitionState !== 'STABLE') continue
    // PR-B (owner principle 1): the bases, STABLE and the pause map are the whole
    // test — the environment is not read here. `side` above is routing (which
    // sidecar), never a policy.
    if (paused[String(r.account_id)]) continue
    out.push(String(r.account_id))
  }
  return out.sort()
}

/**
 * The permit's sizing figures for one account and symbol. Pure over its
 * inputs; `meta` is the broker's symbol record (lot-sizing.getVolumeMeta).
 * Returns { ok:false, reason } when any figure cannot be established — the
 * sidecar then holds no permit and refuses the fill (never a guess).
 */
export function permitSizing({ risk, symbol, meta, price = null, rates = null, cfg = loadTickEntryConfig(), perLot = null }) {
  if (!risk || !(risk.usdPerR > 0)) return { ok: false, reason: `balance_not_read: ${risk?.source || 'no risk figure'}` }
  if (!meta || !(Number(meta.lotSize) > 0)) return { ok: false, reason: 'no_lot_size: the broker returned no lotSize for this symbol' }
  const volumePerLot = Number(meta.lotSize)
  const lotStep = meta.stepVolume > 0 ? Number(meta.stepVolume) / volumePerLot : 0.01
  const minLots = meta.minVolume > 0 ? Number(meta.minVolume) / volumePerLot : lotStep
  let maxLots = meta.maxVolume > 0 ? Number(meta.maxVolume) / volumePerLot : null
  if (cfg.maxLots != null) maxLots = maxLots == null ? cfg.maxLots : Math.min(maxLots, cfg.maxLots)
  const units = perLot != null && perLot > 0 ? perLot : volumePerLot / 100 // cTrader volume is cents of units
  const usdPerLotPerUnit = usdLossPerLot(symbol, WIRE_UNIT, price, rates, units)
  if (!Number.isFinite(usdPerLotPerUnit) || !(usdPerLotPerUnit > 0)) return { ok: false, reason: `no_usd_conversion: ${symbol} needs a price or an FX rate the keeper does not hold` }
  return {
    ok: true,
    fields: {
      usdRisk: +Number(risk.usdPerR).toFixed(2),
      usdPerLotPerUnit,
      volumePerLot,
      lotStep,
      minLots,
      maxLots,
      overshootFraction: Number.isFinite(Number(cfg.overshootFraction)) ? Number(cfg.overshootFraction) : DEFAULT_OVERSHOOT_FRACTION,
      minStopFraction: Number.isFinite(Number(cfg.minStopFraction)) ? Number(cfg.minStopFraction) : DEFAULT_MIN_STOP_FRACTION,
      maxFireDelayMs: Number(cfg.maxFireDelayMs) > 0 ? Number(cfg.maxFireDelayMs) : DEFAULT_MAX_FIRE_DELAY_MS,
    },
  }
}

const pausedLogged = new Map() // accountId → reason last logged

// PR-3: accounts whose book just changed on the bar side (a fill the loop
// placed). The heartbeat's feeder runs for a marked account's side even when
// it would otherwise skip the pass, so the sidecar's standing permit on the
// filled symbol is withdrawn on the NEXT heartbeat — the companion of
// account-pregate.js invalidateAccountPregate, on the tick side.
const repushDue = new Set()
/**
 * Mark an account for a re-push. BOUNDED (checker, 21-09-2026): only an
 * account that currently admits tick is marked. The loop marks EVERY bar
 * fill on every account, and `takeTickRepush(want)` clears only ids on that
 * side's tick roster — so a pure-bar account's mark would never be taken and
 * `tickRepushPending()` would read true for ever, growing one id per account.
 */
export function markTickRepush(db, accountId) {
  if (accountId == null) return false
  try { if (!basesFor(engineStatusFor(db, accountId)).includes('tick')) return false } catch { return false }
  repushDue.add(String(accountId))
  return true
}
/** Take (and clear) the marks; `accountIds` narrows to one side's roster, null takes every mark. */
export function takeTickRepush(accountIds = null) {
  const out = []
  for (const id of [...repushDue]) {
    if (accountIds == null || accountIds.map(String).includes(id)) { out.push(id); repushDue.delete(id) }
  }
  return out
}
/** Peek: which marks are due, without clearing any (the heartbeat asks before its credentials resolve). */
export function peekTickRepush(accountIds = null) {
  return [...repushDue].filter(id => accountIds == null || accountIds.map(String).includes(id))
}
export function tickRepushPending() { return repushDue.size > 0 }
export function _resetTickRepushForTests() { repushDue.clear() }

/**
 * PR-3: ONE budget for both bases. The positions the keeper knows plus the
 * account's pending (open, unfilled) intents — a bar entry RESERVED, SENT or
 * UNKNOWN is capacity already spoken for — EXCLUDING standing RESERVED rows
 * (a standing permit is capacity held in advance, not exposure; counting it
 * would refuse the tick side its own permits). The position cap itself is
 * unchanged (owner): this only makes both sides spend from the same count.
 *
 * IT CAN DOUBLE-COUNT, IN THE SAFE DIRECTION (checker, 21-09-2026): a bar
 * intent still SENT whose trade row already reads `submitting` is counted
 * twice — measured 3 for 2 real orders — because the two sides settle at
 * different moments. The error only ever refuses the tick side EARLY; it can
 * never over-permit, which is why it is left as it is rather than joined on
 * a broker id the intent does not yet have.
 */
export function heldWithPending(db, accountId) {
  const held = openPositionsFor(db, accountId)
  let pending = []
  try { pending = pendingExposure(db, accountId).filter(r => !(r.state === 'RESERVED' && STANDING_PRODUCERS.includes(r.producerId))) } catch { pending = [] }
  return { ...held, positions: held.total, pending: pending.length, total: held.total + pending.length }
}


/**
 * One feeder pass for one side: derive the TICK_MOMENTUM accounts, refresh
 * their standing permits (one per carried symbol and side), attach the
 * sizing figures, and push `{ tickEntryAccounts, tickPermits }` to the
 * side's sidecar. Accounts that left the mode have their standing
 * reservations released. Returns what was pushed and every refusal.
 */
export async function runTickPermitFeeder(db, side, {
  creds = null,
  readiness = null,          // (db, accountId) → { ready, readiness:[{check, ok}] }
  volumeMeta = null,         // (creds, accountId, symbolId) → meta
  resolveSymbolId = null,
  push = null,               // (creds, body) → reply
  now = Date.now(),
  log = (...a) => console.warn('[tick-permits]', ...a),
} = {}) {
  const out = { side: side?.name || 'exec', accounts: [], permits: 0, refused: [], released: 0, pushed: false, paused: [], budget: {} }
  const accounts = tickEntryAccountsFor(db, side)
  // Accounts no longer in the mode: their standing permits go now, not at expiry.
  try {
    const stale = db.prepare(`SELECT DISTINCT account_id FROM entry_intents WHERE producer_id = ? AND state = 'RESERVED'`).all(TICK_PRODUCER).map(r => String(r.account_id))
    for (const id of stale) if (!accounts.includes(id)) out.released += releaseStandingReservations(db, id, TICK_PRODUCER, 'tick_mode_left', { now }).released
  } catch { /* ledger absent */ }
  if (!creds?.ready) { out.reason = 'no_creds'; return out }
  const readinessFor = readiness || (await import('./tick-readiness.js')).tickReadinessFor
  const metaFor = volumeMeta || (async (c, accountId, symbolId) => {
    const { getVolumeMeta } = await import('../lib/lot-sizing.js')
    return getVolumeMeta(c.host, c.clientId, c.clientSecret, c.accessToken, accountId, symbolId)
  })
  const cfg = loadTickEntryConfig()
  const names = tickSymbolNames(db)
  let ids = []
  try { ids = accounts.length ? await resolveTickSymbolIds(db, creds, side, { resolveSymbolId }) : [] } catch { ids = [] }
  // resolveTickSymbolIds returns ids only; pair them back with names by
  // resolving each name once more through the same (cached) resolver.
  const symbolById = new Map()
  if (accounts.length && names.length) {
    const resolve = resolveSymbolId || (await import('../lib/ctrader-creds.js')).resolveSymbolId
    for (const name of names) {
      try { const r = await resolve(db, creds, name); const id = Number(r?.id ?? r?.symbolId ?? r); if (Number.isFinite(id) && id > 0 && ids.includes(id)) symbolById.set(id, name) } catch { /* unresolvable: not carried */ }
    }
  }
  const rates = (() => { try { return scanRates(db) } catch { return null } })()
  const tickPermits = []
  for (const accountId of accounts) {
    const rd = readinessFor(db, accountId)
    const failing = (rd?.readiness || []).filter(c => PAUSE_CHECKS.includes(c.check) && !c.ok).map(c => c.check)
    if (failing.length) {
      const reason = `entry_mode_readiness: ${failing.join(', ')}`
      out.paused.push({ accountId: `…${accountId.slice(-4)}`, reason })
      out.released += releaseStandingReservations(db, accountId, TICK_PRODUCER, reason, { now }).released
      if (pausedLogged.get(accountId) !== reason) { pausedLogged.set(accountId, reason); log(`…${accountId.slice(-4)}: new tick entries PAUSED — ${reason} (exits keep running; TM-40)`) }
      continue
    }
    if (pausedLogged.has(accountId)) { pausedLogged.delete(accountId); log(`…${accountId.slice(-4)}: tick entries resume — readiness checks clear`) }
    // PR-3: the bar side's account-level guards (balance scope, daily loss,
    // loss streak, position cap — account-pregate.js, the PURE read; the
    // memoising one writes a decision row per cycle and this is not the
    // loop) and the margin pool apply to tick capacity too. A refused
    // account gets no permit and its standing rows go now, the guard named
    // on `paused` — the same pause machinery as TM-40, so the guard sync's
    // placing list agrees. The pool is not journaled here (the loop does).
    let riskCfg = null
    try { riskCfg = loadRiskConfig(db, accountId) } catch { riskCfg = null }
    let pregate = null
    try { pregate = accountPregateVerdict(db, accountId, { config: riskCfg || undefined, nowMs: now }) } catch (err) { pregate = { ok: false, guard: 'unreadable', reason: err?.message || String(err) } }
    let poolStatus = null
    try { poolStatus = accountMarginPool(db, riskCfg || loadRiskConfig(db), [accountId], { rates })[0] || null } catch { poolStatus = null }
    if (!pregate?.ok || poolStatus?.exhausted) {
      const guard = !pregate?.ok ? String(pregate?.guard || 'refused') : 'portfolio_margin_exhausted'
      const reason = `account_pregate:${guard}`
      out.paused.push({ accountId: `…${accountId.slice(-4)}`, reason, detail: !pregate?.ok ? String(pregate?.reason || '') : `headroom $${Number(poolStatus?.status?.headroom ?? 0).toFixed(2)}` })
      out.released += releaseStandingReservations(db, accountId, TICK_PRODUCER, reason, { now }).released
      if (pausedLogged.get(accountId) !== reason) { pausedLogged.set(accountId, reason); log(`…${accountId.slice(-4)}: new tick entries PAUSED — ${reason} (the bar side's account guard; exits keep running)`) }
      continue
    }
    const risk = accountRiskPerTrade(db, accountId)
    // RACE CHECKER 11-09-2026 (pyramiding): a FILLED intent frees its key
    // while the real position is still open, so the keeper — the only side
    // that knows the account's positions — issues no permit for a symbol the
    // account already holds, and none at all at the account's position cap.
    // PR-3: the count includes the account's pending bar intents (ONE budget).
    const held = heldWithPending(db, accountId)
    let maxOpen = 5
    try { const n = Number(riskCfg?.maxOpenPositions); if (Number.isFinite(n) && n > 0) maxOpen = n } catch { /* default cap */ }
    out.budget[`…${accountId.slice(-4)}`] = { positions: held.positions, pending: held.pending, total: held.total, cap: maxOpen }
    const entries = []
    const sizing = new Map()
    for (const [symbolId, symbol] of symbolById) {
      if (held.total >= maxOpen) { out.refused.push({ accountId: `…${accountId.slice(-4)}`, symbol, reason: `max_positions: ${held.total}/${maxOpen} open` }); continue }
      if (held.symbols.has(String(symbol).toUpperCase())) { out.refused.push({ accountId: `…${accountId.slice(-4)}`, symbol, reason: 'position_open: the account already holds this symbol' }); continue }
      let meta = null
      try { meta = await metaFor(creds, accountId, symbolId) } catch (err) { out.refused.push({ accountId: `…${accountId.slice(-4)}`, symbol, reason: `no_lot_size: ${err?.message || err}` }); continue }
      const { unitsPerLot: units } = unitsPerLot(db, symbol)
      const s = permitSizing({ risk, symbol, meta, rates, cfg, perLot: units })
      if (!s.ok) { out.refused.push({ accountId: `…${accountId.slice(-4)}`, symbol, reason: s.reason }); continue }
      sizing.set(symbolId, s.fields)
      // PR-D (owner principle 8): when the regime table holds a fresh trend
      // reading for the symbol, the against-trend side gets NO permit — an
      // up-trend withholds SELL, a down-trend withholds BUY; no reading (or
      // a stale one) leaves both, the same fail-open as the regime gate.
      const sides = permittedSides(trendReadingFor(db, symbol))
      for (const withheld of ['BUY', 'SELL']) {
        if (!sides.includes(withheld)) out.refused.push({ accountId: `…${accountId.slice(-4)}`, symbol, side: withheld, reason: `direction_against_trend: ${withheld} withheld under a ${sides[0] === 'BUY' ? 'up' : 'down'}-trend reading` })
      }
      entries.push({ key: `tick:${symbolId}`, symbol, symbolId, volume: null, sides })
    }
    const r = reserveStandingPermits(db, { accountId, producerId: TICK_PRODUCER, basis: 'tick', entries, sizeRequired: false, ttlMs: TICK_PERMIT_TTL_MS, now })
    out.released += r.released
    for (const x of r.refused) out.refused.push({ accountId: `…${accountId.slice(-4)}`, symbol: x.symbol, reason: x.reason })
    for (const p of r.permits) {
      const fields = sizing.get(Number(p.permit.symbolId))
      if (!fields) continue
      tickPermits.push({ accountId: Number(accountId), symbolId: Number(p.permit.symbolId), side: p.side, permit: { ...p.permit, ...fields } })
    }
    out.accounts.push(`…${accountId.slice(-4)}`)
  }
  out.permits = tickPermits.length
  const placing = accounts.filter(id => !out.paused.some(p => p.accountId === `…${id.slice(-4)}`))
  // The guard sync's tickEntryAccounts reads this so the two pushes agree on
  // a paused account (RACE CHECKER 11-09-2026: they used to oscillate).
  try { setState(db, PAUSED_KEY, JSON.stringify(Object.fromEntries(accounts.filter(id => !placing.includes(id)).map(id => [id, out.paused.find(p => p.accountId === `…${id.slice(-4)}`)?.reason || 'paused'])))) } catch { /* state unwritable */ }
  const body = { tickEntryAccounts: placing.map(Number), tickPermits }
  const send = push || ((c, b) => setExecGuard(c, b))
  try {
    const reply = await send(creds, body)
    out.pushed = reply?.ok !== false
    if (!out.pushed) out.error = String(reply?.error || 'sidecar refused the tick permit push')
  } catch (err) { out.pushed = false; out.error = err?.message || String(err) }
  out.base = (() => { try { return execBaseFor(creds) } catch { return null } })()
  return out
}
