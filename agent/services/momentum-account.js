// ---------------------------------------------------------------------------
// agent/services/momentum-account.js — the momentum system on EVERY enabled
// account (PR-B, owner principle 9, 11-09-2026: "setups are for all accounts
// and not hardcoded"; first built for one account, owner 07-09-2026: "use
// ACCT-DEMO-3 for momentum, 10% vol target, shorts in shadow. Build
// §7,386·D1"). `accountId: "_all"` in config/momentum-account.json means
// every enabled registry account runs the daily pass, each sized from ITS
// OWN equity (buildUniverse reads deps.equity(accountId)); a specific id
// still names one account.
//
// First principles this file carries (№ 7,386):
//   1. HORIZON IS THE DESIGN VARIABLE — the momentum account's book decides
//      once per day, after the daily close, not per loop.
//   3. SIZE BY VOLATILITY TARGET — position notional = (equity × target vol /
//      max positions) / asset vol, asset vol read from ATR; the per-trade
//      risk budget is NOT the sizing model on this account.
//   4. BREADTH IS THE FUEL — the universe is data (config/momentum-universe.json),
//      pre-filtered per account by min-lot affordability at universe build,
//      so a name the account cannot hold is excluded once a day with a
//      reason, not refused every hour.
//   5. ONE SYSTEM PER HORIZON — the evidence gate admits tsmom_long on a
//      momentum account by construction. (The 07-09 one-account-per-system
//      veto, `momentum_account_only`, and its `exclusive` switch are gone
//      since PR-B: the rest of the stack trades alongside on every account.)
//
// What it does NOT change: the trailing stop (3×ATR, only in the trade's
// favour), the keeper pause on book rows, the weekend-bank exemption (#851),
// the shadow's ranking. PR-D (11-09-2026, owner principle 8): the pass is
// TWO-SIDED — a shadow short holding is taken only when direction-policy.js
// says ok (conviction ≥ the 9/10 floor, no up-trend reading); the row's
// side is 'short' and the order's SELL. Every broker call is injected.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { getState, setState } from '../db.js'
import { weekAnchorMs } from '../shared/formulas.js'
import { lotsToVolume } from '../lib/lot-sizing.js'
import { bookCloseVolume } from './book-close-volume.js'
import { notionalUsd } from '../lib/contracts.js'
import { loadMomentumShadow, MOMENTUM_SHADOW_STATE_KEY } from './momentum-shadow.js'
// PR-K (16-09-2026): the minimum hold a rank exit must respect. Its own module
// because momentum-book.js applies the SAME rule and importing it here would
// close a cycle (that is why buildEntrySynth is injected).
import { heldLongEnough, heldHours } from './book-hold-age.js'
import { directionFor, trendReadingFor } from './direction-policy.js'
import { checkRegimeGate } from './regime-gate.js'
import { recordDecision } from './decision-log.js'
import { recordPositionEvent } from './position-events.js'
import { assetClassOf } from './strategy-asset-cross.js'

export const MOMENTUM_ACCOUNT_KEY = 'momentum_account_json'
export const MOMENTUM_ACCOUNT_STATE_KEY = 'momentum_account_state_json'
export const MOMENTUM_UNIVERSE_KEY = 'momentum_universe_json'
export const TSMOM_STRATEGY = 'tsmom_long'
export const TRADING_DAYS = 252

/** The config value that means "every enabled registry account". */
export const ALL_ACCOUNTS = '_all'

export const DEFAULT_MOMENTUM_ACCOUNT = Object.freeze({
  accountId: null,          // null → the momentum system runs nowhere; '_all' → every enabled account; an id → that one
  volTargetPct: 10,         // annualised portfolio volatility target, percent of equity
  maxPositions: 8,          // the vol target is split evenly across this many slots
  dailyRunAfterUtc: '21:05', // one pass per UTC day, after the NY close (20:00) and the FX day close (21:00)
  cadence: 'daily',         // 'daily' | 'loop' (loop = every book pass, for tests and the owner's override)
})

const clamp = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d)

export function momentumAccountConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const d = DEFAULT_MOMENTUM_ACCOUNT
  const hhmm = typeof r.dailyRunAfterUtc === 'string' && /^\d{2}:\d{2}$/.test(r.dailyRunAfterUtc) ? r.dailyRunAfterUtc : d.dailyRunAfterUtc
  const id = r.accountId != null && String(r.accountId).trim() ? String(r.accountId).trim() : null
  return {
    accountId: id == null ? null : id.toLowerCase() === ALL_ACCOUNTS ? ALL_ACCOUNTS : id,
    volTargetPct: clamp(r.volTargetPct, 1, 100, d.volTargetPct),
    maxPositions: Math.round(clamp(r.maxPositions, 1, 50, d.maxPositions)),
    dailyRunAfterUtc: hhmm,
    cadence: r.cadence === 'loop' ? 'loop' : 'daily',
  }
}

export function loadMomentumAccount(db) {
  try { return momentumAccountConfig(JSON.parse(getState(db, MOMENTUM_ACCOUNT_KEY) || 'null')) } catch { return momentumAccountConfig(null) }
}

/**
 * The shadow's holdings, or NULL when the shadow state cannot be read.
 *
 * WHY THIS EXISTS (checker, 16-09-2026). `loadShadowState` swallows a missing
 * or corrupt blob and returns `{ holdings: {} }`, and the daily pass read that
 * as "the ranking holds nothing" — which makes EVERY open book row a dropped
 * holding and closes the whole book. A ranking that cannot be read is not an
 * instruction to close everything. An empty-but-READABLE holdings map is a
 * real ranking and still exits rows, as before.
 */
export function shadowHoldingsOrNull(db) {
  let raw = null
  try { raw = getState(db, MOMENTUM_SHADOW_STATE_KEY) } catch { return null }
  if (raw == null || String(raw).trim() === '') return null
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object') return null
  if (!parsed.holdings || typeof parsed.holdings !== 'object') return null
  return parsed.holdings
}

/**
 * Apply the owner's declaration from agent/config/momentum-account.json at
 * boot (08-09-2026: the switching route needs the bearer token, lost on
 * 07-09; the file is the durable declaration and survives a database
 * reset). Only the keys the file names are applied, over what is stored;
 * idempotent; a differing stored value is overwritten by the file.
 * @returns {{applied:boolean, effective:object|null, error:string|null}}
 */
export function seedMomentumAccountFromConfig(db, { file = null, log = () => {} } = {}) {
  let cfg = null
  try {
    cfg = JSON.parse(readFileSync(file || new URL('../config/momentum-account.json', import.meta.url), 'utf8'))
  } catch (err) {
    return { applied: false, effective: null, error: `momentum-account.json unreadable: ${err.message}` }
  }
  if (!cfg || typeof cfg !== 'object') return { applied: false, effective: null, error: 'momentum-account.json is not an object' }
  const stored = loadMomentumAccount(db)
  migrateLegacyPassCursor(db, stored, log)
  const patch = {}
  for (const k of ['accountId', 'volTargetPct', 'maxPositions', 'dailyRunAfterUtc', 'cadence']) if (k in cfg) patch[k] = cfg[k]
  const next = momentumAccountConfig({ ...stored, ...patch })
  const same = JSON.stringify(next) === JSON.stringify(stored)
  if (!same) {
    setState(db, MOMENTUM_ACCOUNT_KEY, JSON.stringify(next))
    log(`[boot] momentum account ${next.accountId === ALL_ACCOUNTS ? 'every enabled account' : `…${String(next.accountId || '').slice(-4) || 'none'}`}: volTarget ${next.volTargetPct}% maxPositions ${next.maxPositions} after ${next.dailyRunAfterUtc}Z cadence ${next.cadence} (from config/momentum-account.json)`)
  }
  return { applied: !same, effective: next, error: null }
}

/**
 * ONE-TIME MIGRATION (PR-B checker, 11-09-2026): before the per-account
 * cursor the single global `momentum_account_state_json` held the previously
 * named account's lastRunMs. Copied to that account's own key once, at the
 * first boot after deploy — read BEFORE the file patches the config, while
 * the stored config still names the account — so the first pass does not
 * re-run the same UTC day; then the legacy key is cleared. Idempotent: no
 * legacy key, nothing to do; an existing per-account key is never overwritten.
 */
export function migrateLegacyPassCursor(db, storedCfg, log = () => {}) {
  let legacy = null
  try { legacy = JSON.parse(getState(db, MOMENTUM_ACCOUNT_STATE_KEY) || 'null') } catch { legacy = null }
  if (!legacy || typeof legacy !== 'object') return { migrated: false, reason: 'no_legacy_key' }
  const id = storedCfg?.accountId && storedCfg.accountId !== ALL_ACCOUNTS ? String(storedCfg.accountId) : null
  if (id && getState(db, momentumAccountStateKey(id)) == null) {
    setState(db, momentumAccountStateKey(id), JSON.stringify(legacy))
    log(`[boot] momentum account …${id.slice(-4)}: pass cursor migrated to its own key (lastRun ${legacy.lastRunMs ? new Date(Number(legacy.lastRunMs)).toISOString() : 'none'})`)
  }
  setState(db, MOMENTUM_ACCOUNT_STATE_KEY, null)
  return { migrated: !!id, accountId: id, reason: id ? null : 'legacy_cursor_named_no_account' }
}

/**
 * Does the momentum system run on this account? Null/unknown → false. Under
 * `_all` every ENABLED registry account qualifies (a disabled or unknown row
 * never does); a specific id qualifies only itself.
 */
export function isMomentumAccount(db, accountId) {
  if (accountId == null) return false
  const cfg = loadMomentumAccount(db)
  if (cfg.accountId == null) return false
  if (cfg.accountId !== ALL_ACCOUNTS) return String(accountId) === cfg.accountId
  try { return !!db.prepare('SELECT 1 FROM accounts WHERE account_id = ? AND enabled = 1').get(String(accountId)) } catch { return false }
}

/** The accounts the momentum system runs on right now, in registry order. */
export function momentumAccountIds(db) {
  const cfg = loadMomentumAccount(db)
  if (cfg.accountId == null) return []
  if (cfg.accountId !== ALL_ACCOUNTS) return [cfg.accountId]
  try { return db.prepare('SELECT account_id FROM accounts WHERE enabled = 1 ORDER BY account_id').all().map(r => String(r.account_id)) } catch { return [] }
}

/** Per-account pass state key (PR-B: one cursor per account, so two accounts' daily passes never share a lastRunMs). */
export function momentumAccountStateKey(accountId) { return `${MOMENTUM_ACCOUNT_STATE_KEY}:${String(accountId)}` }

// ---------------------------------------------------------------------------
// Universe — data, not code.
// ---------------------------------------------------------------------------

let fileUniverse = null
function readFileUniverse() {
  if (fileUniverse) return fileUniverse
  try {
    const j = JSON.parse(readFileSync(new URL('../config/momentum-universe.json', import.meta.url), 'utf8'))
    const out = []
    for (const [cls, list] of Object.entries(j)) {
      if (cls.startsWith('_') || !Array.isArray(list)) continue
      for (const s of list) out.push({ symbol: String(s), class: cls })
    }
    fileUniverse = out
  } catch { fileUniverse = [] }
  return fileUniverse
}

/** The configured universe: the state override when present (replaces), else the file. */
export function momentumUniverse(db) {
  try {
    const o = JSON.parse(getState(db, MOMENTUM_UNIVERSE_KEY) || 'null')
    if (o && Array.isArray(o.symbols) && o.symbols.length) {
      return o.symbols.map(s => ({ symbol: String(s), class: assetClassOf(String(s)) }))
    }
  } catch { /* file */ }
  return readFileUniverse()
}

/** Just the names, upper-cased, de-duplicated — for the shadow's ranking pass. */
export function momentumUniverseSymbols(db) {
  return [...new Set(momentumUniverse(db).map(u => u.symbol.toUpperCase()))]
}

// ---------------------------------------------------------------------------
// Volatility-target sizing — pure.
// ---------------------------------------------------------------------------

/**
 * Lots for one slot of the vol target.
 *   assetVolAnnual = (atr / price) × √252          (ATR as the daily σ proxy)
 *   targetVolUsd   = equity × volTargetPct/100 / maxPositions
 *   notionalUsd    = targetVolUsd / assetVolAnnual
 *   lots           = notionalUsd / notional-per-lot
 * `meta` is the broker's symbol record (lotSize in cents of units, minVolume,
 * stepVolume). The result is snapped DOWN to the step; `affordable` is false
 * when the snapped size is below the minimum lot.
 */
export function volTargetLots({ equity, volTargetPct, maxPositions, atr, price, symbol, meta, rates = null }) {
  const E = Number(equity), a = Number(atr), p = Number(price)
  if (!(E > 0) || !(a > 0) || !(p > 0) || !meta || !(meta.lotSize > 0)) return { lots: 0, volume: 0, notionalUsd: 0, affordable: false, note: 'unsized: missing equity, ATR, price or lot meta' }
  const assetVol = (a / p) * Math.sqrt(TRADING_DAYS)
  const targetVolUsd = E * (Number(volTargetPct) / 100) / Math.max(1, Number(maxPositions))
  const notional = targetVolUsd / assetVol
  const unitsPerLot = meta.lotSize / 100
  const perLotUsd = notionalUsd(symbol, 1, p, rates, unitsPerLot)
  if (!(perLotUsd > 0)) return { lots: 0, volume: 0, notionalUsd: notional, affordable: false, note: 'unsized: notional per lot unknown' }
  const rawLots = notional / perLotUsd
  const snapped = lotsToVolume(rawLots, meta)
  return {
    lots: Math.floor(snapped.lots * 100) / 100,
    volume: snapped.volume,
    notionalUsd: Math.round(notional),
    assetVolPct: Math.round(assetVol * 10000) / 100,
    affordable: !snapped.belowMin && snapped.lots > 0,
    note: snapped.belowMin
      ? `below_min_lot: vol-target size ${rawLots.toFixed(4)} lots < min ${(meta.minVolume ?? 0) / meta.lotSize} (notional $${Math.round(notional)} at ${Math.round(assetVol * 100)}% vol)`
      : `vol_target: ${(Number(volTargetPct))}%/${maxPositions} slots → $${Math.round(targetVolUsd)} vol/yr ÷ ${Math.round(assetVol * 100)}% = $${Math.round(notional)} notional = ${snapped.lots.toFixed(2)} lots`,
  }
}

// ---------------------------------------------------------------------------
// Daily cadence — pure.
// ---------------------------------------------------------------------------

/** Ms of today's `HH:MM` UTC threshold for the day containing `nowMs`. */
export function thresholdMs(nowMs, afterUtc) {
  const [hh, mm] = String(afterUtc).split(':').map(Number)
  const d = new Date(nowMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, 0, 0)
}

/** Due when now is past today's threshold and the last run was before it. */
export function dailyDue({ nowMs, lastRunMs = 0, afterUtc = '21:05', cadence = 'daily' }) {
  if (cadence === 'loop') return true
  const t = thresholdMs(nowMs, afterUtc)
  return nowMs >= t && !(Number(lastRunMs) >= t)
}

export function loadMomentumAccountState(db, accountId = null) {
  try {
    const s = JSON.parse(getState(db, accountId == null ? MOMENTUM_ACCOUNT_STATE_KEY : momentumAccountStateKey(accountId)) || 'null')
    if (s && typeof s === 'object') return { lastRunMs: Number(s.lastRunMs) || 0, universe: s.universe && typeof s.universe === 'object' ? s.universe : {}, universeBuiltAt: s.universeBuiltAt || null, lastPass: s.lastPass || null }
  } catch { /* fresh */ }
  return { lastRunMs: 0, universe: {}, universeBuiltAt: null, lastPass: null }
}

// ---------------------------------------------------------------------------
// Universe build — per account, once per pass: tradability + affordability.
// ---------------------------------------------------------------------------

/**
 * For every universe name on THIS account: resolve the id, read the lot
 * meta, read ATR + price, size one slot. Returns { SYMBOL: { ok, reason,
 * lots, notionalUsd, assetVolPct, class, atr, price, symbolId } }.
 * deps: symbolIdFor(creds, symbol) → id|null, volumeMeta(creds, id) → meta,
 *       bars(creds, id) → bars, spot(creds, id) → {bid,ask}|null,
 *       equity(accountId) → number|null, rates() → map|null, atrOf(bars) → number|null
 */
/**
 * Wave 1 (19-09-2026, audit §K·3): ONE cap, not three. The book's slot count
 * is the smaller of its own maxPositions and the risk gate's maxOpenPositions
 * for this account (deps.maxOpenPositions, wired from loop.js) — so the vol
 * target never divides equity across slots the gate will not let exist.
 * Unknown → the book's own number, as before.
 */
export function effectiveSlots(cfg, deps, accountId) {
  let riskCap = null
  try { const v = Number(deps?.maxOpenPositions?.(accountId)); riskCap = Number.isFinite(v) && v > 0 ? v : null } catch { riskCap = null }
  return riskCap != null ? Math.max(1, Math.min(cfg.maxPositions, riskCap)) : cfg.maxPositions
}

export async function buildUniverse(db, { accountId, creds, cfg, deps }) {
  const slots = effectiveSlots(cfg, deps, accountId)
  const out = {}
  const equity = deps.equity ? deps.equity(accountId) : null
  const rates = deps.rates ? deps.rates() : null
  for (const u of momentumUniverse(db)) {
    const symbol = u.symbol.toUpperCase()
    const row = { class: u.class, ok: false, reason: null, lots: 0, notionalUsd: 0, assetVolPct: null, atr: null, price: null, bid: null, symbolId: null }
    out[symbol] = row
    try {
      const id = deps.symbolIdFor ? await deps.symbolIdFor(creds, symbol) : null
      if (id == null) { row.reason = 'unknown_symbol'; continue }
      row.symbolId = id
      if (!(equity > 0)) { row.reason = 'no_equity'; continue }
      const meta = deps.volumeMeta ? await deps.volumeMeta(creds, id) : null
      if (!meta) { row.reason = 'no_lot_meta'; continue }
      const bars = deps.bars ? await deps.bars(creds, id) : []
      const atr = deps.atrOf ? deps.atrOf(bars) : null
      const q = deps.spot ? await deps.spot(creds, id) : null
      const price = Number(q?.ask) > 0 ? Number(q.ask) : Number(bars[bars.length - 1]?.c)
      if (!(atr > 0) || !(price > 0)) { row.reason = 'no_bars'; continue }
      row.atr = atr; row.price = price
      row.bid = Number(q?.bid) > 0 ? Number(q.bid) : null // a short is priced at the bid (checker item c)
      const s = volTargetLots({ equity, volTargetPct: cfg.volTargetPct, maxPositions: slots, atr, price, symbol, meta, rates })
      row.lots = s.lots; row.notionalUsd = s.notionalUsd; row.assetVolPct = s.assetVolPct ?? null
      if (!s.affordable) { row.reason = s.note; continue }
      row.ok = true
    } catch (err) { row.reason = `error: ${err.message}` }
  }
  return { equity, universe: out }
}

// ---------------------------------------------------------------------------
// The daily pass for the momentum account.
// ---------------------------------------------------------------------------

/**
 * Target portfolio = the shadow's holdings (long, and — PR-D — short where
 * the direction policy admits them) ∩ the tradable universe.
 * Exits: open book rows on this account the shadow no longer holds.
 * Entries: target names with no open row, best entry rank first, up to
 * cfg.maxPositions, each sized by the vol target and dispatched through
 * autoTrade with sizing 'vol_target' (marketOnly false: a closed market
 * gets a resting limit at the proposal entry, which the adopt pass turns
 * into a book row when it fills).
 *
 * `bookCfg` is the book's own config (timeframe, atrPeriod, stopAtr);
 * `buildEntrySynth` is injected from momentum-book.js to avoid the cycle.
 */
export async function runMomentumAccountPass(db, { acct, creds, bookCfg, buildEntrySynth, deps = {}, now = Date.now(), log = () => {}, marginExhausted = false, entryBrake = null }) {
  const cfg = loadMomentumAccount(db)
  const accountId = String(acct.accountId)
  const slots = effectiveSlots(cfg, deps, accountId)
  const state = loadMomentumAccountState(db, accountId)
  const summary = { account: accountId, ran: false, entries: 0, exits: 0, rankExitsDeferred: 0, skipped: [], universe: null }
  if (!dailyDue({ nowMs: now, lastRunMs: state.lastRunMs, afterUtc: cfg.dailyRunAfterUtc, cadence: cfg.cadence })) {
    summary.why = 'not due (daily cadence)'
    return summary
  }
  // THE SAME GATES THE ROW-CURSOR PATH APPLIES (checker, 11-09-2026): an
  // account whose margin pool is exhausted takes NO entries this pass (owner
  // §7,453·B) — its exits still run below, and the cursor is NOT advanced,
  // so the day's pass is retried once headroom frees rather than forfeited.
  if (marginExhausted) {
    summary.why = 'margin exhausted — no entries this pass'
    summary.skipped.push('margin exhausted — no entries this pass')
    summary.exits = await exitDroppedHoldings(db, { accountId, creds, deps, now, log, summary, bookCfg })
    return summary
  }
  summary.ran = true

  const built = await buildUniverse(db, { accountId, creds, cfg, deps })
  const tradable = Object.entries(built.universe).filter(([, u]) => u.ok).map(([s]) => s)
  const byReason = {}
  for (const u of Object.values(built.universe)) if (!u.ok) byReason[String(u.reason).split(':')[0]] = (byReason[String(u.reason).split(':')[0]] || 0) + 1
  summary.universe = { total: Object.keys(built.universe).length, tradable: tradable.length, byReason, equity: built.equity }

  // NULL = the shadow state could not be read. Not "holds nothing" (checker,
  // 16-09-2026): the exits below would close every open row on a corrupt blob.
  const held = shadowHoldingsOrNull(db)
  const shadowCfg = loadMomentumShadow(db)
  // Best rank first: strongest longs (rank → 1) and weakest shorts (rank → 0)
  // sort by their own side's strength.
  const wanted = Object.entries(held || {}).filter(([s, h]) => (h?.side === 'long' || h?.side === 'short') && tradable.includes(String(s).toUpperCase()))
    .map(([s, h]) => ({ symbol: String(s).toUpperCase(), side: h.side, rank: Number(h.entryRank) || 0, conviction: h.entryConviction ?? null }))
    .sort((a, b) => (b.side === 'short' ? 1 - b.rank : b.rank) - (a.side === 'short' ? 1 - a.rank : a.rank))

  // EXITS FIRST: the shadow no longer holds it (or holds the other side).
  summary.exits += await exitDroppedHoldings(db, { accountId, creds, deps, now, log, summary, held, bookCfg })
  // The open set is read AFTER the exits (checker item a): a same-day flip
  // has its long row exited above and its short entered below.
  const openRows = db.prepare(`SELECT * FROM momentum_book WHERE status = 'open' AND account_id = ?`).all(accountId)
  const openSyms = new Set(openRows.map(r => String(r.symbol).toUpperCase()))

  // ENTRIES: best rank first, up to the slot count.
  const insBook = db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`)
  const tradeRowFor = db.prepare(`SELECT id, ctrader_position_id, entry_price, sl_price FROM trades WHERE symbol = ? AND account_id = ? AND label_strategy = ? AND status = 'open' ORDER BY id DESC LIMIT 1`)
  const workingLimit = db.prepare(`SELECT id FROM pending_orders WHERE account_id = ? AND symbol = ? AND status = 'working' AND strategy = ? LIMIT 1`)
  let open = openSyms.size
  // PR-P (16-09-2026): THE PER-ACCOUNT ENTRY BRAKE, decided in
  // momentum-book.js by book-open-drawdown.js and handed in here. THIS is the
  // path that trades — `accountId: "_all"` routes every enabled account
  // through this daily pass — so a brake enforced only on the row-cursor path
  // would be on, configured and out of reach of what it guards (failure mode
  // #3, the exact defect the checker found in PR-K's first draft).
  //
  // WHEN IT WAS MEASURED (corrected, checker MINOR 5 — the first draft's
  // comment here claimed the opposite of what the code does, and this repo's
  // history is that a false comment gets believed later). The verdict is
  // computed in momentum-book.js ABOVE the `isMomentumAccount` branch, so it
  // reads the account's open rows BEFORE `exitDroppedHoldings` has run on
  // this pass — the book as it stood at the start of the pass, exits
  // included. That is the conservative direction (an account that is about to
  // exit its losers is still judged on having held them) and it is the order
  // the tests exercise: the same pass that refuses the entry sends both
  // exits. The ORDER is deliberate; only the comment was wrong.
  //
  // The brake never reads or delays an exit. A braked account still exits,
  // still trails, still retries an owed exit — it only stops ADDING.
  //
  // The REASON and the NOTICE are pushed by momentum-book.js for every
  // account on every pass, not here: this function returns early on `not due`
  // — which is most passes for most accounts — so a line emitted from here
  // would appear once a day. It is recorded in this account's own durable
  // state below instead, so the daily record says why it added nothing.
  //
  // `entryBrake` null = no brake was computed by the caller (a direct test
  // call). Unknown is not a breach; the pass runs as before.
  if (entryBrake?.block) {
    summary.entryBraked = true
    summary.entryBrakeReason = entryBrake.reason || null
    summary.entryBrakeRead = entryBrake.read || null
  }
  for (const w of wanted) {
    if (entryBrake?.block) break
    if (open >= slots) { summary.skipped.push(`at maxPositions ${slots}${slots !== cfg.maxPositions ? ` (risk maxOpenPositions caps the book's ${cfg.maxPositions})` : ''}`); break }
    if (openSyms.has(w.symbol)) continue
    try { if (workingLimit.get(accountId, w.symbol, TSMOM_STRATEGY)) { summary.skipped.push(`${w.symbol}: limit already working`); continue } } catch { /* no table */ }
    // The account's daily fundable universe (§7,437·B·3), exactly as the
    // row-cursor tryEnter applies it: a name this account cannot fund is
    // skipped by name. Unknown is not a block.
    if (deps.fundable) {
      const fu = deps.fundable(accountId, w.symbol)
      if (fu && fu.ok === false) { summary.skipped.push(`${w.symbol}: ${fu.reason}`); continue }
    }
    const u = built.universe[w.symbol]
    const may = deps.mayTrade ? deps.mayTrade(accountId, w.symbol) : { ok: true, item: null }
    if (!may.ok) { summary.skipped.push(`${w.symbol}: ${may.reason}`); continue }
    // PR-D: the direction policy and the regime gate — the same calls the
    // row-cursor book makes (a short's conviction must be a number).
    const dp = directionFor({ side: w.side, conviction: w.side === 'short' ? w.conviction : (w.conviction ?? bookCfg.conviction), trendDirection: trendReadingFor(db, w.symbol), cfg: shadowCfg })
    if (!dp.ok) { summary.skipped.push(`${w.symbol}: ${dp.reason}`); continue }
    const rg = checkRegimeGate(db, TSMOM_STRATEGY, w.side, w.symbol)
    if (rg.block) {
      try { recordDecision(db, { accountId, symbol: w.symbol, strategy: TSMOM_STRATEGY, stage: 'regime_gate', decision: 'skip', reason: rg.reason }) } catch { /* provenance never blocks */ }
      summary.skipped.push(`${w.symbol}: ${rg.reason}`); continue
    }
    try {
      const entryPrice = w.side === 'short' && u.bid > 0 ? u.bid : u.price
      const synth = buildEntrySynth({ symbol: w.symbol, price: entryPrice, atr: u.atr, cfg: bookCfg, conviction: w.conviction, rankPct: w.rank, side: w.side, directionReason: dp.reason })
      if (!synth) { summary.skipped.push(`${w.symbol}: no usable price/ATR`); continue }
      Object.assign(synth, {
        marketOnly: false,             // closed market → resting limit at this price; the adopt pass books the fill
        sizing: 'vol_target',
        sizedVolume: u.lots,
        source: 'momentum_account',
        synthesis: `${synth.synthesis} Sized by the ${cfg.volTargetPct}% vol target: ${u.lots} lots ($${u.notionalUsd} notional at ${u.assetVolPct}% asset vol).`,
      })
      const result = await deps.autoTrade(db, w.symbol, synth, may.item || null, { accountId, isLive: !!acct.isLive, producerId: 'daily_momentum_account', sharedAccounts: acct.sharedAccounts ?? null })
      if (!result) { summary.skipped.push(`${w.symbol}: not filled (gate, closed market, or broker)`); continue }
      const t = tradeRowFor.get(w.symbol, accountId, TSMOM_STRATEGY)
      insBook.run(t?.id ?? null, accountId, w.symbol, t?.ctrader_position_id != null ? String(t.ctrader_position_id) : null, w.side,
        t?.entry_price ?? synth.entry, t?.sl_price ?? synth.sl, u.atr, w.rank, new Date(now).toISOString(), `daily pass: vol-target ${u.lots} lots`)
      if (t?.id != null) db.prepare(`UPDATE monitored_positions SET paused = 1, current_tp = NULL WHERE trade_id = ?`).run(t.id)
      openSyms.add(w.symbol); open++
      summary.entries++
      log(`momentum account: ${w.side} ${w.symbol} on …${accountId.slice(-4)} @ ${synth.entry} stop ${synth.sl.toFixed(5)} ${u.lots} lots (vol target; ${dp.reason})`)
    } catch (err) { summary.skipped.push(`${w.symbol}: ${err.message}`) }
  }

  setState(db, momentumAccountStateKey(accountId), JSON.stringify({
    lastRunMs: now, universeBuiltAt: new Date(now).toISOString(), universe: built.universe,
    // PR-P: the brake is part of the daily record, not only of the loop log —
    // "why did this account add nothing today?" must have a durable answer.
    lastPass: { at: new Date(now).toISOString(), entries: summary.entries, exits: summary.exits, skipped: summary.skipped.slice(0, 20), universe: summary.universe, entryBrake: summary.entryBraked ? { reason: summary.entryBrakeReason, read: summary.entryBrakeRead } : null },
  }))
  return summary
}

/**
 * Close the account's open book rows the shadow no longer holds ON THAT
 * SIDE (a row's side flipping in the shadow is an exit too). Shared by the
 * full pass and the margin-exhausted pass (exits run regardless of
 * headroom). Returns the number of exits sent.
 */
async function exitDroppedHoldings(db, { accountId, creds, deps, now, log, summary, held = undefined, bookCfg = null }) {
  const holdings = held === undefined ? shadowHoldingsOrNull(db) : held
  // FAIL CLOSED (checker, 16-09-2026): an unreadable ranking closes nothing.
  if (holdings == null) {
    summary.skipped.push('shadow state unreadable — no rank exits this pass (a missing ranking is not an instruction to close the book)')
    return 0
  }
  const openRows = db.prepare(`SELECT * FROM momentum_book WHERE status = 'open' AND account_id = ?`).all(accountId)
  let exits = 0
  for (const row of openRows) {
    const rowSide = row.side === 'short' ? 'short' : 'long'
    if (holdings[row.symbol]?.side === rowSide || holdings[String(row.symbol).toUpperCase()]?.side === rowSide) continue // still held on this side — keep (untradable-now names included)
    // THE MINIMUM HOLD (PR-K, 16-09-2026 — THIS is the path that trades:
    // `accountId: "_all"` routes every enabled account through the daily pass,
    // so the row-cursor path in momentum-book.js carries none of them). The
    // cadence half of PR-K is already satisfied here by construction — this
    // function only runs inside the daily pass, on its own lastRunMs cursor —
    // so what is added is the floor on how long a position is held before a
    // RANKING OPINION may close it. The stop is untouched and still bounds the
    // position; `bookExitCadence: 'every_pass'` (or bookMinHoldHours 0) lifts
    // this, which is the pre-PR-K behaviour on this path exactly.
    if (!heldLongEnough(db, row, now, bookCfg)) {
      summary.rankExitsDeferred = (summary.rankExitsDeferred || 0) + 1
      summary.skipped.push(`${row.symbol}: rank exit held — held ${heldHours(db, row, now)}h < bookMinHoldHours ${bookCfg?.bookMinHoldHours} — reconsidered on the next daily pass`)
      continue
    }
    try {
      if (row.position_id && deps.close) {
        // Same rule as the row-cursor exit (09-09-2026): no volume, no close.
        const volume = await bookCloseVolume(db, creds, row, deps)
        if (volume == null) throw new Error('unknown volume — close not sent')
        await deps.close(creds, { positionId: row.position_id, volume })
      }
      db.prepare(`UPDATE momentum_book SET status = 'exit_sent', exited_at = ?, note = 'rank exit (daily pass)' WHERE id = ?`).run(new Date(now).toISOString(), row.id)
      // Same journal line as the row-cursor exit (fix-the-exits BA).
      if (row.position_id) {
        recordPositionEvent(db, {
          accountId, positionId: row.position_id, tradeId: row.trade_id, symbol: row.symbol, kind: 'close',
          reason: 'rank exit (daily pass)', source: 'momentum_account',
        })
      }
      exits++
      log(`momentum account: rank exit ${row.symbol} on …${accountId.slice(-4)}`)
    } catch (err) { summary.skipped.push(`${row.symbol}: close failed — ${err.message}`) }
  }
  return exits
}

/**
 * The read: config, cadence, and PER ACCOUNT the universe tradability, the
 * last pass and the open rows. The top-level `universe` / `lastPass` /
 * `lastRunAt` / `open` aggregate every momentum account (built and tradable
 * summed, reasons merged, the newest pass) so the goal table keeps one
 * figure; `accounts` carries each account's own.
 */
/** Closes and net for this strategy on this account since the FX week anchor (Wave 2, §K·7). */
export function weekToDateFor(db, accountId, nowMs = Date.now()) {
  try {
    const anchor = weekAnchorMs(nowMs)
    const since = new Date(anchor).toISOString().replace('T', ' ').slice(0, 19)
    const r = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(net_pnl), 0) AS net, COALESCE(SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END), 0) AS wins
         FROM trades
        WHERE status = 'closed' AND net_pnl IS NOT NULL AND account_id = ?
          AND COALESCE(label_strategy, strategy) = ?
          AND REPLACE(closed_at, 'T', ' ') >= ?`
    ).get(String(accountId), TSMOM_STRATEGY, since)
    return { since: new Date(anchor).toISOString(), closes: Number(r?.n) || 0, wins: Number(r?.wins) || 0, net: Number((Number(r?.net) || 0).toFixed(2)) }
  } catch { return { since: null, closes: 0, wins: 0, net: 0 } }
}

export function momentumAccountReport(db) {
  const cfg = loadMomentumAccount(db)
  const ids = momentumAccountIds(db)
  const accounts = {}
  const agg = { built: 0, tradable: 0, byReason: {}, builtAt: null, lastRunMs: 0, lastPass: null, open: [] }
  for (const id of ids) {
    const state = loadMomentumAccountState(db, id)
    const universe = state.universe || {}
    const byReason = {}
    for (const u of Object.values(universe)) if (!u.ok) { const k = String(u.reason).split(':')[0]; byReason[k] = (byReason[k] || 0) + 1; agg.byReason[k] = (agg.byReason[k] || 0) + 1 }
    let open = []
    try { open = db.prepare(`SELECT symbol, side, entry_price, stop, atr, entry_rank, entered_at, status, note FROM momentum_book WHERE status IN ('open','exit_sent') AND account_id = ? ORDER BY entered_at`).all(id) } catch { open = [] }
    const built = Object.keys(universe).length, tradable = Object.values(universe).filter(u => u.ok).length
    accounts[id] = {
      account: `…${id.slice(-4)}`,
      lastRunAt: state.lastRunMs ? new Date(state.lastRunMs).toISOString() : null,
      universe: { built, tradable, byReason, builtAt: state.universeBuiltAt, symbols: universe },
      lastPass: state.lastPass,
      open,
      // Wave 2 (§K·7): the momentum family is accounted by the WEEK, its
      // horizon's unit — closes and net since the FX week anchor, this
      // account, this strategy. Reported here and on the goal table; the
      // daily cap and the loss streak no longer read these closes.
      weekToDate: weekToDateFor(db, id),
    }
    agg.built += built; agg.tradable += tradable
    agg.open.push(...open.map(o => ({ ...o, account: `…${id.slice(-4)}` })))
    if (state.lastRunMs > agg.lastRunMs) { agg.lastRunMs = state.lastRunMs; agg.lastPass = state.lastPass; agg.builtAt = state.universeBuiltAt }
  }
  return {
    reportOnly: true,
    config: { ...cfg, account: cfg.accountId == null ? null : cfg.accountId === ALL_ACCOUNTS ? 'every enabled account' : `…${cfg.accountId.slice(-4)}`, accounts: ids.map(id => `…${id.slice(-4)}`) },
    nextDueAfterUtc: cfg.dailyRunAfterUtc,
    lastRunAt: agg.lastRunMs ? new Date(agg.lastRunMs).toISOString() : null,
    universe: { configured: momentumUniverseSymbols(db).length, built: agg.built, tradable: agg.tradable, byReason: agg.byReason, builtAt: agg.builtAt },
    lastPass: agg.lastPass,
    open: agg.open,
    accounts,
    note: 'The momentum system on every configured account: tsmom_long sized by the vol target from each account\'s own equity, decided once per day after the daily close; the rest of the stack trades alongside. Two-sided since PR-D: a shadow short is taken only at conviction ≥ the short floor (9/10 on the defaults) and never against an up-trend reading.',
  }
}
