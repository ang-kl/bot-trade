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
// What it does NOT change: the trailing stop (3×ATR, only rises), the
// keeper pause on book rows, the weekend-bank exemption (#851), the shadow's
// ranking (shorts stay in shadow — D2). Every broker call is injected.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { getState, setState } from '../db.js'
import { lotsToVolume } from '../lib/lot-sizing.js'
import { bookCloseVolume } from './book-close-volume.js'
import { notionalUsd } from '../lib/contracts.js'
import { loadShadowState } from './momentum-shadow.js'
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
export async function buildUniverse(db, { accountId, creds, cfg, deps }) {
  const out = {}
  const equity = deps.equity ? deps.equity(accountId) : null
  const rates = deps.rates ? deps.rates() : null
  for (const u of momentumUniverse(db)) {
    const symbol = u.symbol.toUpperCase()
    const row = { class: u.class, ok: false, reason: null, lots: 0, notionalUsd: 0, assetVolPct: null, atr: null, price: null, symbolId: null }
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
      const s = volTargetLots({ equity, volTargetPct: cfg.volTargetPct, maxPositions: cfg.maxPositions, atr, price, symbol, meta, rates })
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
 * Target portfolio = the shadow's LONG holdings ∩ the tradable universe.
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
export async function runMomentumAccountPass(db, { acct, creds, bookCfg, buildEntrySynth, deps = {}, now = Date.now(), log = () => {}, marginExhausted = false }) {
  const cfg = loadMomentumAccount(db)
  const accountId = String(acct.accountId)
  const state = loadMomentumAccountState(db, accountId)
  const summary = { account: accountId, ran: false, entries: 0, exits: 0, skipped: [], universe: null }
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
    summary.exits = await exitDroppedHoldings(db, { accountId, creds, deps, now, log, summary })
    return summary
  }
  summary.ran = true

  const built = await buildUniverse(db, { accountId, creds, cfg, deps })
  const tradable = Object.entries(built.universe).filter(([, u]) => u.ok).map(([s]) => s)
  const byReason = {}
  for (const u of Object.values(built.universe)) if (!u.ok) byReason[String(u.reason).split(':')[0]] = (byReason[String(u.reason).split(':')[0]] || 0) + 1
  summary.universe = { total: Object.keys(built.universe).length, tradable: tradable.length, byReason, equity: built.equity }

  const held = (() => { try { return loadShadowState(db).holdings || {} } catch { return {} } })()
  const wanted = Object.entries(held).filter(([s, h]) => h?.side === 'long' && tradable.includes(String(s).toUpperCase()))
    .map(([s, h]) => ({ symbol: String(s).toUpperCase(), rank: Number(h.entryRank) || 0, conviction: h.entryConviction ?? null }))
    .sort((a, b) => b.rank - a.rank)

  const openRows = db.prepare(`SELECT * FROM momentum_book WHERE status = 'open' AND account_id = ?`).all(accountId)
  const openSyms = new Set(openRows.map(r => String(r.symbol).toUpperCase()))

  // EXITS: the shadow no longer holds it.
  summary.exits += await exitDroppedHoldings(db, { accountId, creds, deps, now, log, summary, held })

  // ENTRIES: best rank first, up to the slot count.
  const insBook = db.prepare(`INSERT INTO momentum_book (trade_id, account_id, symbol, position_id, side, entry_price, stop, atr, entry_rank, entered_at, status, note)
                              VALUES (?, ?, ?, ?, 'long', ?, ?, ?, ?, ?, 'open', ?)`)
  const tradeRowFor = db.prepare(`SELECT id, ctrader_position_id, entry_price, sl_price FROM trades WHERE symbol = ? AND account_id = ? AND label_strategy = ? AND status = 'open' ORDER BY id DESC LIMIT 1`)
  const workingLimit = db.prepare(`SELECT id FROM pending_orders WHERE account_id = ? AND symbol = ? AND status = 'working' AND strategy = ? LIMIT 1`)
  let open = openSyms.size
  for (const w of wanted) {
    if (open >= cfg.maxPositions) { summary.skipped.push(`at maxPositions ${cfg.maxPositions}`); break }
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
    try {
      const synth = buildEntrySynth({ symbol: w.symbol, price: u.price, atr: u.atr, cfg: bookCfg, conviction: w.conviction, rankPct: w.rank })
      if (!synth) { summary.skipped.push(`${w.symbol}: no usable price/ATR`); continue }
      Object.assign(synth, {
        marketOnly: false,             // closed market → resting limit at this price; the adopt pass books the fill
        sizing: 'vol_target',
        sizedVolume: u.lots,
        source: 'momentum_account',
        synthesis: `${synth.synthesis} Sized by the ${cfg.volTargetPct}% vol target: ${u.lots} lots ($${u.notionalUsd} notional at ${u.assetVolPct}% asset vol).`,
      })
      const result = await deps.autoTrade(db, w.symbol, synth, may.item || null, { accountId, isLive: !!acct.isLive, producerId: 'daily_momentum_account' })
      if (!result) { summary.skipped.push(`${w.symbol}: not filled (gate, closed market, or broker)`); continue }
      const t = tradeRowFor.get(w.symbol, accountId, TSMOM_STRATEGY)
      insBook.run(t?.id ?? null, accountId, w.symbol, t?.ctrader_position_id != null ? String(t.ctrader_position_id) : null,
        t?.entry_price ?? synth.entry, t?.sl_price ?? synth.sl, u.atr, w.rank, new Date(now).toISOString(), `daily pass: vol-target ${u.lots} lots`)
      if (t?.id != null) db.prepare(`UPDATE monitored_positions SET paused = 1, current_tp = NULL WHERE trade_id = ?`).run(t.id)
      openSyms.add(w.symbol); open++
      summary.entries++
      log(`momentum account: long ${w.symbol} on …${accountId.slice(-4)} @ ${synth.entry} stop ${synth.sl.toFixed(5)} ${u.lots} lots (vol target)`)
    } catch (err) { summary.skipped.push(`${w.symbol}: ${err.message}`) }
  }

  setState(db, momentumAccountStateKey(accountId), JSON.stringify({
    lastRunMs: now, universeBuiltAt: new Date(now).toISOString(), universe: built.universe,
    lastPass: { at: new Date(now).toISOString(), entries: summary.entries, exits: summary.exits, skipped: summary.skipped.slice(0, 20), universe: summary.universe },
  }))
  return summary
}

/**
 * Close the account's open book rows the shadow no longer holds long. Shared
 * by the full pass and the margin-exhausted pass (exits run regardless of
 * headroom). Returns the number of exits sent.
 */
async function exitDroppedHoldings(db, { accountId, creds, deps, now, log, summary, held = null }) {
  const holdings = held || (() => { try { return loadShadowState(db).holdings || {} } catch { return {} } })()
  const openRows = db.prepare(`SELECT * FROM momentum_book WHERE status = 'open' AND account_id = ?`).all(accountId)
  let exits = 0
  for (const row of openRows) {
    if (holdings[row.symbol]?.side === 'long' || holdings[String(row.symbol).toUpperCase()]?.side === 'long') continue // still held — keep (untradable-now names included)
    try {
      if (row.position_id && deps.close) {
        // Same rule as the row-cursor exit (09-09-2026): no volume, no close.
        const volume = await bookCloseVolume(db, creds, row, deps)
        if (volume == null) throw new Error('unknown volume — close not sent')
        await deps.close(creds, { positionId: row.position_id, volume })
      }
      db.prepare(`UPDATE momentum_book SET status = 'exit_sent', exited_at = ?, note = 'rank exit (daily pass)' WHERE id = ?`).run(new Date(now).toISOString(), row.id)
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
    try { open = db.prepare(`SELECT symbol, entry_price, stop, atr, entry_rank, entered_at, status, note FROM momentum_book WHERE status IN ('open','exit_sent') AND account_id = ? ORDER BY entered_at`).all(id) } catch { open = [] }
    const built = Object.keys(universe).length, tradable = Object.values(universe).filter(u => u.ok).length
    accounts[id] = {
      account: `…${id.slice(-4)}`,
      lastRunAt: state.lastRunMs ? new Date(state.lastRunMs).toISOString() : null,
      universe: { built, tradable, byReason, builtAt: state.universeBuiltAt, symbols: universe },
      lastPass: state.lastPass,
      open,
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
    note: 'The momentum system on every configured account: tsmom_long sized by the vol target from each account\'s own equity, decided once per day after the daily close; the rest of the stack trades alongside. Shorts stay in shadow (D2).',
  }
}
