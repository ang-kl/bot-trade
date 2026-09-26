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
import { reserveStandingPermits, releaseStandingReservations, pendingExposure, unsettledTickFires, STANDING_PRODUCERS, TICK_PRODUCER, TICK_PERMIT_TTL_MS, TICK_RESTART_HOLD } from './entry-ledger.js'
import { accountsHolding, DEFAULT_MAX_ACCOUNTS_PER_SYMBOL } from './book-symbol-cap.js'
import { lastReconcileAt } from './account-engineering.js'
import { accountRiskPerTrade } from './tick-shadow.js'
import { tickSymbolNames, resolveTickSymbolIds } from './exec-guard-sync.js'
import { scanRates, loadRiskConfig, accountMarginPool } from './risk.js'
import { accountPregateVerdict } from './account-pregate.js'
import { permittedSides, trendReadingFor } from './direction-policy.js'
import { inflightLiveSql } from '../lib/stuck-resolutions.js'

export const TICK_ENTRY_FILE = new URL('../config/tick-entry.json', import.meta.url)
export const DEFAULT_OVERSHOOT_FRACTION = 0.25
// The feed's wire price is 1e-5 of a price unit; cTrader's relative stop
// shares the scale, and so does the sidecar's stopDistance.
export const WIRE_UNIT = 1e-5
// The readiness checks whose failure pauses NEW tick entries (TM-40).
export const PAUSE_CHECKS = Object.freeze(['recorder_recording', 'disk_reserve_clear', 'feed_continuity'])
// C9 (SEQUENCE PR-9, WP-D gap 5): the checks re-read on EVERY feeder pass.
// PAUSE_CHECKS plus the two that can turn false after admission and were
// read only when tick was first added: the recorder status going stale
// (tick-readiness.js RECORDER_STATUS_MAX_AGE_MS, 10 min — so this fires only
// after about five failed status pulls, and then releases every standing
// row) and the sidecar's running profile no longer matching the pin. The
// stage and the pin need no re-read: the contract self-heals them
// (entry-contracts.js). PAUSE_CHECKS stays exported unchanged.
export const REVALIDATE_CHECKS = Object.freeze([...PAUSE_CHECKS, 'recorder_status_fresh', 'profile_matches_sidecar'])
// C9 (WP-D gap 4): the book-wide tick grants, computed ONCE per heartbeat
// cycle for both sidecars and persisted with a generation number (the record
// of what was granted); the heartbeat hands the same record to the demo and
// the live pass, so both read one decision (review blocker: two independent
// passes could hand permits to three accounts under cap 2).
export const TICK_GRANTS_KEY = 'tick_grants_json'
// C9 (WP-D gap 6): when this keeper first saw each sidecar boot, on NODE's
// clock, and how long an account's tick entries wait for a reconcile after it.
export const TICK_BOOT_SEEN_KEY = 'tick_sidecar_boot_seen_json'
export const RESTART_RECONCILE_WAIT_MS = 10 * 60_000
const PENDING_FIRED_STATES = Object.freeze(['DISPATCHING', 'SENT', 'UNKNOWN'])
const SERVED_STATES = Object.freeze(['DISPATCHING', 'SENT', 'ACCEPTED', 'FILLED', 'UNKNOWN'])

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
  // V3 I3: an in-flight row the stuck resolver ended (settled onto the row
  // that carries its fill, or written off with no broker evidence) is not a
  // position — it stops taking a slot here, as in the symbol cap.
  const live = inflightLiveSql(db)
  try { for (const r of db.prepare(`SELECT symbol FROM trades WHERE account_id = ? AND status IN ('open', 'submitting', 'unconfirmed')${live}`).all(String(accountId))) bump(r.symbol) } catch { /* table absent */ }
  try {
    // C9: monitored_positions has NO ctrader_position_id column (agent/db.js);
    // the position id lives on its trades row (trade_id). The query used to
    // select it directly, threw into the catch below, and so the tick budget
    // never counted a monitored position — the C8 shape one table over. The
    // id is now read through the link, and the real-schema test pins it.
    for (const r of db.prepare(`SELECT mp.symbol, mp.trade_id, t.ctrader_position_id FROM monitored_positions mp LEFT JOIN trades t ON t.id = mp.trade_id WHERE mp.account_id = ? AND mp.status = 'active'`).all(String(accountId))) {
      // a monitored row for a position the trades table already counts is the
      // same position: its own linked row, or a row carrying its position id
      let dup = false
      try {
        dup = (r.trade_id != null && !!db.prepare(`SELECT 1 FROM trades WHERE id = ? AND account_id = ? AND status IN ('open', 'submitting', 'unconfirmed')${live}`).get(r.trade_id, String(accountId)))
          || (r.ctrader_position_id != null && !!db.prepare(`SELECT 1 FROM trades WHERE account_id = ? AND ctrader_position_id = ? AND status IN ('open', 'submitting', 'unconfirmed')${live}`).get(String(accountId), String(r.ctrader_position_id)))
      } catch { dup = false }
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
export function heldWithPending(db, accountId, { now = Date.now() } = {}) {
  const held = openPositionsFor(db, accountId)
  let pending = []
  try { pending = pendingExposure(db, accountId).filter(r => !(r.state === 'RESERVED' && STANDING_PRODUCERS.includes(r.producerId))) } catch { pending = [] }
  // C9 (WP-D gap 1, review blocker): a tick fire Node knows of but has not
  // adopted is capacity spent. A fired row in DISPATCHING / SENT / UNKNOWN is
  // already in `pending` above; one still RESERVED (the ring was pulled
  // before reconcileIntents moved it), RELEASED, ACCEPTED or FILLED is not, so
  // only those are added — nothing is counted twice. Its symbol is held, so
  // no new permit is issued on it.
  let fires = []
  try { fires = unsettledTickFires(db, accountId, { now }).filter(f => !PENDING_FIRED_STATES.includes(f.state)) } catch { fires = [] }
  const symbols = new Map(held.symbols)
  for (const f of fires) { const k = String(f.symbol || '').toUpperCase(); if (k) symbols.set(k, (symbols.get(k) || 0) + 1) }
  return { ...held, symbols, positions: held.total, pending: pending.length, unsettled: fires.length, total: held.total + pending.length + fires.length }
}

/** The per-account book cap, read as risk.js step 4a-ii reads it (the account's own config; value unchanged). */
export function bookCapFor(riskCfg) {
  const v = riskCfg?.maxAccountsPerSymbol
  return v == null || v === '' ? DEFAULT_MAX_ACCOUNTS_PER_SYMBOL : Number(v)
}

/**
 * The accounts holding SYMBOL|SIDE for the book cap: the bar gate's own
 * reader (positions, in-flight orders, working limits — book-symbol-cap.js)
 * plus the accounts with an unsettled tick fire on it.
 */
export function tickHolders(db, symbol, side, fires = []) {
  const sym = String(symbol || '').toUpperCase()
  const set = new Set(accountsHolding(db, { symbol: sym, direction: side }))
  for (const f of fires) if (String(f.symbol || '').toUpperCase() === sym && f.side === side) set.add(String(f.accountId))
  return set
}

function lastServed(db, accountId, symbol, side) {
  try {
    return db.prepare(`SELECT MAX(created_at) AS at FROM entry_intents WHERE account_id = ? AND producer_id = ? AND UPPER(symbol) = ? AND side = ?
      AND state IN (${SERVED_STATES.map(() => '?').join(',')})`).get(String(accountId), TICK_PRODUCER, String(symbol).toUpperCase(), side, ...SERVED_STATES)?.at || ''
  } catch { return '' }
}

/**
 * Phase 1 of a pass for one account: the pause checks in the feeder's order
 * — readiness (REVALIDATE_CHECKS), then the bar side's account pre-gate (the
 * PURE read) and the margin pool. Returns `{ pause: {reason, detail?} | null,
 * riskCfg, rd }`. Writes nothing.
 */
export function accountTickPause(db, accountId, { readinessFor, now = Date.now(), rates = null } = {}) {
  const rd = readinessFor(db, accountId)
  const failing = (rd?.readiness || []).filter(c => REVALIDATE_CHECKS.includes(c.check) && !c.ok).map(c => c.check)
  if (failing.length) return { pause: { reason: `entry_mode_readiness: ${failing.join(', ')}`, readiness: true }, riskCfg: null, rd }
  let riskCfg = null
  try { riskCfg = loadRiskConfig(db, accountId) } catch { riskCfg = null }
  let pregate = null
  try { pregate = accountPregateVerdict(db, accountId, { config: riskCfg || undefined, nowMs: now }) } catch (err) { pregate = { ok: false, guard: 'unreadable', reason: err?.message || String(err) } }
  let poolStatus = null
  try { poolStatus = accountMarginPool(db, riskCfg || loadRiskConfig(db), [accountId], { rates })[0] || null } catch { poolStatus = null }
  if (!pregate?.ok || poolStatus?.exhausted) {
    const guard = !pregate?.ok ? String(pregate?.guard || 'refused') : 'portfolio_margin_exhausted'
    return { pause: { reason: `account_pregate:${guard}`, detail: !pregate?.ok ? String(pregate?.reason || '') : `headroom $${Number(poolStatus?.status?.headroom ?? 0).toFixed(2)}` }, riskCfg, rd }
  }
  return { pause: null, riskCfg, rd }
}

export function maxOpenOf(riskCfg) {
  const n = Number(riskCfg?.maxOpenPositions)
  return Number.isFinite(n) && n > 0 ? n : 5
}

/**
 * C9 (SEQUENCE PR-9, WP-D gap 4): which tick accounts may hold a permit on
 * each SYMBOL|SIDE, across BOTH sidecars, under the owner's existing book cap
 * (maxAccountsPerSymbol, each account's own config — the source the bar gate
 * reads; value unchanged). One tick signal then reaches at most `cap`
 * accounts book-wide, as one bar signal already does.
 *
 * Two-phase (review correction): the candidates are the accounts admitting
 * tick that pass THIS cycle's pause checks, not the previous pass's pause
 * map. Holders (positions, in-flight orders, working limits, unsettled tick
 * fires) take the cap first; the free places go least-recently-served first
 * (never served, then by account id), so no account is fixed (principle 9).
 * Each granted account is sized R / n in its pass (sharedSignalRiskSplit, E·2).
 *
 * Persisted as TICK_GRANTS_KEY with a generation. A side's pass reads the
 * record it is handed and may only NARROW it (a holder that appeared since),
 * never widen it.
 */
export async function computeTickGrants(db, { now = Date.now(), readiness = null, candidates = null } = {}) {
  const readinessFor = readiness || (await import('./tick-readiness.js')).tickReadinessFor
  const rates = (() => { try { return scanRates(db) } catch { return null } })()
  // Both sidecars: the default side lists every account admitting tick.
  const accounts = (candidates ?? tickEntryAccountsFor(db)).map(String)
  const names = [...new Set(tickSymbolNames(db).map(n => String(n).toUpperCase()))]
  let fires = []
  try { fires = unsettledTickFires(db, null, { now }) } catch { fires = [] }
  const excluded = {}
  const eligible = []
  for (const id of accounts) {
    let p = null
    try { p = accountTickPause(db, id, { readinessFor, now, rates }) } catch (err) { p = { pause: { reason: `unreadable: ${err?.message || err}` } } }
    if (p.pause) { excluded[id] = p.pause.reason; continue }
    const held = heldWithPending(db, id, { now })
    const maxOpen = maxOpenOf(p.riskCfg)
    if (held.total >= maxOpen) { excluded[id] = `max_positions: ${held.total}/${maxOpen} open`; continue }
    eligible.push({ id, cap: bookCapFor(p.riskCfg), held })
  }
  const grants = {}
  for (const sym of names) {
    for (const side of ['BUY', 'SELL']) {
      const holders = tickHolders(db, sym, side, fires)
      const order = eligible.filter(a => !holders.has(a.id) && !a.held.symbols.has(sym))
        .map(a => ({ ...a, served: lastServed(db, a.id, sym, side) }))
        .sort((x, y) => (x.served < y.served ? -1 : x.served > y.served ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      const granted = []
      for (const a of order) if (!(a.cap > 0) || holders.size + granted.length < a.cap) granted.push(a.id)
      grants[`${sym}|${side}`] = { granted, holders: [...holders].sort(), n: granted.length }
    }
  }
  let prev = 0
  try { prev = Number(JSON.parse(getState(db, TICK_GRANTS_KEY) || 'null')?.generation) || 0 } catch { prev = 0 }
  const record = { generation: prev + 1, computedAtMs: now, accounts, excluded, grants }
  try { setState(db, TICK_GRANTS_KEY, JSON.stringify(record)) } catch { /* state unwritable: the caller still holds the record */ }
  return record
}

/**
 * When this keeper first saw `bootId` on `sideName`, on Node's clock; a boot
 * the store does not hold is recorded as seen now. A boot never seen before
 * (the first pass after this ships included) counts as a change: every tick
 * account on the side waits for one reconcile — the conservative reading. ONE clock on purpose
 * (review correction: the synthetic sidecar_restart row mixes the sidecar's
 * ts_ms with Node's, and is absent on a first-seen boot). The boot began
 * before Node first saw it, so a reconcile stamped after this moment read
 * the account's positions after the boot began. GW-1 (SEQUENCE PR-10) may
 * tighten T to the sidecar's own startedAtMs; this bound is the safe side.
 */
export function bootFirstSeen(db, sideName, bootId, now = Date.now()) {
  let m = {}
  try { m = JSON.parse(getState(db, TICK_BOOT_SEEN_KEY) || '{}') || {} } catch { m = {} }
  const cur = m[sideName]
  if (cur && cur.bootId === bootId && Number.isFinite(Number(cur.firstSeenAtMs))) return Number(cur.firstSeenAtMs)
  m[sideName] = { bootId, firstSeenAtMs: now }
  try { setState(db, TICK_BOOT_SEEN_KEY, JSON.stringify(m)) } catch { /* state unwritable */ }
  return now
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
  readiness = null,          // (db, accountId) → { ready, readiness:[{check, ok}], profileHash? }
  volumeMeta = null,         // (creds, accountId, symbolId) → meta
  resolveSymbolId = null,
  push = null,               // (creds, body) → reply
  now = Date.now(),
  // C9: the boot of the sidecar this pass pushes to (the probe's /health
  // bootId). null — an older sidecar or a caller that does not know it —
  // keeps the pre-C9 behaviour: no boot binding, no restart quarantine.
  bootId = null,
  // C9: this cycle's grants (computeTickGrants, once per heartbeat cycle);
  // null computes a fresh generation for this pass.
  grants = null,
  log = (...a) => console.warn('[tick-permits]', ...a),
} = {}) {
  // V3 C4: `work` and `carried` feed the tick work receipt
  // (tick-entry-work.js). `work` names each account by its FULL id with its
  // outcome; everything else here stays masked (…1234) for the logs.
  const out = { side: side?.name || 'exec', accounts: [], permits: 0, refused: [], released: 0, pushed: false, paused: [], budget: {}, work: [], carried: [], slots: {}, grantsGeneration: null }
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
  out.carried = [...symbolById.values()]
  const rates = (() => { try { return scanRates(db) } catch { return null } })()
  // C9 (gap 4): this cycle's book-wide grants. The heartbeat computes ONE
  // generation per cycle and hands the same record to both sides' passes; a
  // caller outside the heartbeat gets a fresh generation computed here.
  let gen = grants
  if (!gen && accounts.length) gen = await computeTickGrants(db, { now, readiness: readinessFor })
  out.grantsGeneration = gen?.generation ?? null
  let fires = []
  try { fires = unsettledTickFires(db, null, { now }) } catch { fires = [] }
  const holdersFor = new Map()
  const holdersOf = (sym, s) => { const k = `${sym}|${s}`; if (!holdersFor.has(k)) holdersFor.set(k, tickHolders(db, sym, s, fires)); return holdersFor.get(k) }
  // C9 (gap 6): Node's first sight of this boot — the quarantine's T.
  const seenAt = bootId ? bootFirstSeen(db, out.side, String(bootId), now) : null
  const selectedId = (() => { try { return getState(db, 'ctrader_account_id') } catch { return null } })()
  const tickPermits = []
  const maxOpenBy = new Map()
  const pauseAccount = (accountId, reason, detail = null, { release = true, urgent = false } = {}) => {
    out.paused.push({ accountId: `…${accountId.slice(-4)}`, reason, ...(detail != null ? { detail } : {}) })
    if (release) out.released += releaseStandingReservations(db, accountId, TICK_PRODUCER, reason, { now }).released
    if (pausedLogged.get(accountId) !== reason) {
      pausedLogged.set(accountId, reason)
      const line = `…${accountId.slice(-4)}: new tick entries PAUSED — ${reason} (exits keep running)`
      if (urgent) console.error(`[tick-permits] URGENT ${line}`)
      log(line)
    }
    out.work.push({ accountId, permits: 0, paused: reason, firstRefusal: null, refused: [], budget: null })
  }
  for (const accountId of accounts) {
    const refusedFrom = out.refused.length, before = tickPermits.length
    // C9 (WP-D gap 6): NO PERMIT CROSSES A GATEWAY BOOT. Standing rows bound
    // to another boot (or to none — rows from before C9) are the permits a
    // restarted gateway may already have spent in its previous life, its
    // decision ring lost. They stay RESERVED — so a fill from the old boot is
    // still FILLED by its tag and adopted as the bot's, not a FENCE BREACH —
    // until a reconcile of THIS account read its positions after the new boot
    // was first seen; then they are released and fresh ids are issued. This
    // runs BEFORE the readiness branch, which releases every standing row.
    // Bounded: after RESTART_RECONCILE_WAIT_MS without that reconcile the
    // pause turns into the urgent refusal `tick_sidecar_restart_unreconciled`.
    //
    // FIX ROUND (checker, 26-09-2026): the hold is keyed on the BOOT CHANGE
    // and this account's own reconcile after it — never on whether old-boot
    // RESERVED rows still exist. The first cut asked the rows, and the loop's
    // global expireStale turned them EXPIRED after the 5-min TTL: the hold
    // lifted with no reconcile, and the rows sat in EXPIRED, a fence-breach
    // state for a late fill. So: every tick account on a side whose boot
    // Node has not yet seen reconciled waits, whatever rows it holds; and its
    // held rows are marked TICK_RESTART_HOLD, which expireStale skips, so
    // they stay RESERVED — FILLED by their tag if the old boot spent them —
    // until the hold lifts and releases them.
    if (bootId) {
      const rec = lastReconcileAt(db, accountId, selectedId).at
      const recMs = rec ? Date.parse(rec) : NaN
      const oldWhere = `WHERE account_id = ? AND producer_id = ? AND state = 'RESERVED' AND (sidecar_boot_id IS NULL OR sidecar_boot_id <> ?)`
      if (!(recMs > seenAt)) {
        // No catch here on purpose: a mark that failed silently would let the
        // loop's expireStale EXPIRE the rows — the defect this hold exists for
        // (a first cut of this very query was wrong and a catch hid it).
        const held = db.prepare(`UPDATE entry_intents SET error_code = ?, updated_at = ? ${oldWhere}`).run(TICK_RESTART_HOLD, new Date(now).toISOString(), accountId, TICK_PRODUCER, String(bootId)).changes
        const late = now - seenAt > RESTART_RECONCILE_WAIT_MS
        const reason = late
          ? `tick_sidecar_restart_unreconciled: no reconcile of this account in ${Math.round((now - seenAt) / 60_000)} min since boot ${bootId} was first seen`
          : 'tick_sidecar_restart: waiting for a reconcile after the sidecar restart'
        pauseAccount(accountId, reason, `${held} standing row(s) from another boot held RESERVED`, { release: false, urgent: late })
        continue
      }
      const nowIso = new Date(now).toISOString()
      out.released += db.prepare(`UPDATE entry_intents SET state = 'RELEASED', error_code = 'tick_sidecar_restart', resolution_source = 'epoch', resolved_at = ?, updated_at = ? ${oldWhere}`)
        .run(nowIso, nowIso, accountId, TICK_PRODUCER, String(bootId)).changes
    }
    // TM-40 + C9 (gap 5): readiness re-read every pass (REVALIDATE_CHECKS);
    // PR-3: the bar side's account-level guards (balance scope, daily loss,
    // loss streak, position cap — account-pregate.js, the PURE read) and the
    // margin pool apply to tick capacity too. A refused account gets no
    // permit and its standing rows go now, the guard named on `paused` — the
    // same pause map the guard sync reads, so the two pushes agree.
    const phase = accountTickPause(db, accountId, { readinessFor, now, rates })
    if (phase.pause) { pauseAccount(accountId, phase.pause.reason, phase.pause.detail ?? null); continue }
    if (pausedLogged.has(accountId)) { pausedLogged.delete(accountId); log(`…${accountId.slice(-4)}: tick entries resume — readiness checks clear`) }
    const riskCfg = phase.riskCfg
    const rd = phase.rd
    const risk = accountRiskPerTrade(db, accountId)
    // RACE CHECKER 11-09-2026 (pyramiding): a FILLED intent frees its key
    // while the real position is still open, so the keeper — the only side
    // that knows the account's positions — issues no permit for a symbol the
    // account already holds, and none at all at the account's position cap.
    // PR-3: the count includes the account's pending bar intents (ONE budget).
    // C9: and its unadopted tick fires.
    const held = heldWithPending(db, accountId, { now })
    const maxOpen = maxOpenOf(riskCfg)
    maxOpenBy.set(accountId, maxOpen)
    out.budget[`…${accountId.slice(-4)}`] = { positions: held.positions, pending: held.pending, total: held.total, cap: maxOpen }
    const bookCap = bookCapFor(riskCfg)
    const splitOn = riskCfg?.sharedSignalRiskSplit !== 'off'
    // C9 (gap 5): the pinned profile the permit is for, and the boot it is
    // pushed to (the firer's checks ride GW-1; the fields are built here).
    const profileHash = typeof rd?.profileHash === 'string' && rd.profileHash ? rd.profileHash : null
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
      // PR-D (owner principle 8): when the regime table holds a fresh trend
      // reading for the symbol, the against-trend side gets NO permit — an
      // up-trend withholds SELL, a down-trend withholds BUY; no reading (or
      // a stale one) leaves both, the same fail-open as the regime gate.
      const trendSides = permittedSides(trendReadingFor(db, symbol))
      for (const withheld of ['BUY', 'SELL']) {
        if (!trendSides.includes(withheld)) out.refused.push({ accountId: `…${accountId.slice(-4)}`, symbol, side: withheld, reason: `direction_against_trend: ${withheld} withheld under a ${trendSides[0] === 'BUY' ? 'up' : 'down'}-trend reading` })
      }
      // C9 (gap 4): the book-wide cap on tick. The account needs the
      // generation's grant for SYMBOL|SIDE. The grant is only ever NARROWED:
      // if a holder appeared since the generation was computed (a fill
      // between the demo and the live pass), the key gets no permit on this
      // pass — the other side may already have pushed its granted accounts,
      // so any new grant here could make holders + permits exceed the cap.
      // A holder that went away never widens it; the next generation does.
      const sym = String(symbol).toUpperCase()
      const sides = []
      const withheldWhy = {}
      for (const sd of trendSides) {
        const g = gen?.grants?.[`${sym}|${sd}`] || null
        const holders = holdersOf(sym, sd)
        const known = new Set((g?.holders || []).map(String))
        const granted = (g?.granted || []).map(String)
        const appeared = [...holders].filter(h => !known.has(h) && !granted.includes(h))
        let why = null
        if (!g && gen?.failed) why = `book_symbol_cap: no grants this cycle — the generation was not computed (${gen.failed})`
        else if (!g) why = `book_symbol_cap: no grant for ${sym} ${sd} in generation ${gen?.generation ?? 'none'}`
        else if (!granted.includes(accountId)) why = `book_symbol_cap: ${g.holders.length} hold, ${g.n} granted in generation ${gen.generation}, cap ${bookCap}`
        else if (appeared.length) why = `book_symbol_cap: ${appeared.length} holder(s) appeared since generation ${gen.generation}; no new permit until the next one`
        if (why) {
          withheldWhy[sd] = 'book_symbol_cap'
          out.refused.push({ accountId: `…${accountId.slice(-4)}`, symbol, side: sd, reason: why })
          continue
        }
        sides.push(sd)
        // E·2 on tick: ONE signal granted to n accounts risks R / n on each,
        // unless the account's sharedSignalRiskSplit is 'off'. n is the
        // generation's, so the demo and the live pass size alike.
        const n = Number(g.n) || 1
        const fields = { ...s.fields }
        if (splitOn && n > 1) fields.usdRisk = +(Number(s.fields.usdRisk) / n).toFixed(2)
        sizing.set(`${Number(symbolId)}|${sd}`, fields)
      }
      entries.push({ key: `tick:${symbolId}`, symbol, symbolId, volume: null, sides, withheld: withheldWhy })
    }
    const r = reserveStandingPermits(db, { accountId, producerId: TICK_PRODUCER, basis: 'tick', entries, sizeRequired: false, ttlMs: TICK_PERMIT_TTL_MS, now, bootId: bootId != null ? String(bootId) : null })
    out.released += r.released
    for (const x of r.refused) out.refused.push({ accountId: `…${accountId.slice(-4)}`, symbol: x.symbol, reason: x.reason })
    for (const p of r.permits) {
      const fields = sizing.get(`${Number(p.permit.symbolId)}|${p.side}`)
      if (!fields) continue
      tickPermits.push({ accountId: Number(accountId), symbolId: Number(p.permit.symbolId), side: p.side, permit: { ...p.permit, ...fields, profileHash, bootId: bootId != null ? String(bootId) : null } })
    }
    out.accounts.push(`…${accountId.slice(-4)}`)
    const mine = out.refused.slice(refusedFrom).map(x => { const own = { ...x }; delete own.accountId; return own })
    out.work.push({ accountId, permits: tickPermits.length - before, paused: null, firstRefusal: mine[0]?.reason ?? null, refused: mine, budget: out.budget[`…${accountId.slice(-4)}`] ?? null })
  }
  out.permits = tickPermits.length
  const placing = accounts.filter(id => !out.paused.some(p => p.accountId === `…${id.slice(-4)}`))
  // The guard sync's tickEntryAccounts reads this so the two pushes agree on
  // a paused account (RACE CHECKER 11-09-2026: they used to oscillate).
  try { setState(db, PAUSED_KEY, JSON.stringify(Object.fromEntries(accounts.filter(id => !placing.includes(id)).map(id => [id, out.paused.find(p => p.accountId === `…${id.slice(-4)}`)?.reason || 'paused'])))) } catch { /* state unwritable */ }
  // C9 (WP-D gap 1): the per-fire cap's Node half. For each placing account,
  // the slots left under its own position cap — positions, pending bar
  // intents and unadopted tick fires counted, AFTER this pass's reserves —
  // and `firesSeen`, the tick fires of THIS boot Node has pulled, so the
  // gateway can subtract the fires it made after Node's ring pull
  // (slots − max(0, fires − firesSeen), SEQUENCE PR-10). Today's gateway
  // ignores the field; it binds when GW-1 ships the counter.
  const tickSlots = placing.map(id => {
    const h = heldWithPending(db, id, { now })
    const maxOpen = maxOpenBy.get(id) ?? 5
    let firesSeen = 0
    if (bootId) {
      try { firesSeen = db.prepare(`SELECT COUNT(*) AS n FROM cpp_decisions WHERE side = ? AND boot_id = ? AND component = 'tick' AND kind = 'fire' AND CAST(account_id AS TEXT) = ?`).get(out.side, String(bootId), id)?.n ?? 0 } catch { firesSeen = 0 }
    }
    const slot = { accountId: Number(id), slots: Math.max(0, maxOpen - h.total), firesSeen, bootId: bootId != null ? String(bootId) : null }
    out.slots[`…${id.slice(-4)}`] = slot.slots
    return slot
  })
  const body = { tickEntryAccounts: placing.map(Number), tickPermits, tickSlots }
  const send = push || ((c, b) => setExecGuard(c, b))
  try {
    const reply = await send(creds, body)
    out.pushed = reply?.ok !== false
    if (!out.pushed) out.error = String(reply?.error || 'sidecar refused the tick permit push')
  } catch (err) { out.pushed = false; out.error = err?.message || String(err) }
  out.base = (() => { try { return execBaseFor(creds) } catch { return null } })()
  return out
}
