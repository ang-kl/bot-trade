// ---------------------------------------------------------------------------
// agent/services/profit-keeper.js — automatic profit protection for
// MANUAL / EXTERNAL positions (ON by default; disarm to go hands-off).
//
// A manual position is NOT hands-off: the moment it shows real profit the
// keeper arms a tighten-only broker stop behind it, so an unattended winner
// (e.g. the JPN225 that gave back $725) is protected without you watching.
// It never touches a losing position and never widens risk — turning it OFF
// (profit_keeper_json.on = false) is the only way back to fully manual.
//
// Two modes:
//
// ADAPTIVE (default) — thresholds in volatility units, not dollars, so the
// policy self-scales across instruments, position sizes and regimes:
//   · arm once peak floating profit ≥ max(armAtrMult × ATR-value of the
//     position, armBalancePct% of balance)
//   · then RATCHET a broker-side stop `trailAtrMult × ATR` behind the peak
//     price (Chandelier exit) — tighten-only
//   · optional scale-out: close `scaleOutFrac` of the position once armed
//     (bank some, let the rest run)
//   · if price has already fallen through the trail, close at market
//
// FIXED — the original dollar policy: arm at +$X peak, close when profit
// gives back more than givebackPct% of the peak, SL ratchet at the lock.
//
// Both modes: optional takeProfitUsd closes outright at +$X. The stop lives
// AT THE BROKER — tick-level protection between loop cycles, not polling.
//
// Safety by construction:
//   · on by default (profit_keeper_json.on), scope 'external' (default) or 'all'
//   · a stop only ever TIGHTENS; the keeper never widens risk
//   · losing positions are untouched — nothing happens until profit arms
//   · positions with owner-armed guard rules (guard_json) are skipped
//   · volumes/prices come from the live broker reconcile, never stale rows
//   · every action goes through the exec engine (C++ sidecar when
//     EXEC_ENGINE=cpp) and lands in action_log + Telegram
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { instrumentType } from '../lib/contracts.js'
import { earlyTrimConfig, earlyTrimDecision, earlyTrimShadowRow } from './early-trim.js'
import { getAccountBalance } from './risk.js'
import { atrFromBars, registerAtrSource } from '../lib/stop-floor.js'
import { makeBookHeldCheck } from './book-held.js'
import { roundToDigits } from './trade-guard.js'
import { recordPositionEvent } from './position-events.js'
import { sinceEntryTrailSpec } from './mae-chandelier-observe.js'
import { singleFlight, authorisedAccountId, accountFilterSql, scopeToAccount } from './acting-layer.js'
import { measureAmend } from './protection-latency.js'
import { protectiveExitDeferral } from './momentum-exit-coordination.js'
// Codex · №13,025 · 2026-10-10; codex-footprint: keeper-owned-close-receipts.
import { readKeeperClose, runKeeperClose, pendingKeeperClosedMonitorIds } from './keeper-close-receipts.js'

// P10: last-seen broker SL per position, as reported by the C++ TrailEngine's
// GET /trail-status (a full snapshot, not a delta stream). Diffed each pass
// A changed snapshot becomes an observation, not proof of a ratchet. A
// restart can repeat a baseline observation, never a claimed amendment.
// Codex · №12,048 · 2026-10-08; codex-footprint: collection-retention.
// Cursors belong to a DB and an account/host, not just a position number.
const lastSeenTrailSl = new WeakMap()

export const DEFAULT_PROFIT_KEEPER = {
  on: true,               // manual positions are managed by default — disarm for hands-off
  scope: 'external',      // 'external' = manual/imported positions only · 'all' = bot positions too
  mode: 'adaptive',       // 'adaptive' (ATR/balance units) · 'fixed' (dollar thresholds)
  // adaptive mode
  atrTimeframe: '1h',
  atrPeriod: 14,
  // Arming. The aligned plan (§2.5.4) asks for "≥ +1.2R". This module protects
  // MANUAL/EXTERNAL positions, which have no `initial_risk` to divide by — an
  // imported position arrives with a size and a price and nothing that says
  // what its owner was risking. The unit that exists here is the position's
  // own ATR-value, which is what R is measured in when the stop was set from
  // volatility. So 1.2R is implemented as 1.2 ATR-values, and the honest
  // statement of that is this comment, not a variable named `armR`.
  armAtrMult: 1.2,        // arm once peak profit ≥ this × the position's ATR-value…
  armBalancePct: 0.1,     // …and at least this % of balance (noise floor)
  trailAtrMult: 2.5,      // Chandelier: SL trails this × ATR behind the peak price
  scaleOutFrac: 0,        // fraction closed once armed (0 = off, 0.5 = half)
  // Spike-aware tightening (owner, 2026-07-24, after the EUSTX50 trade
  // where a vertical spike ran while the trail sat a full 2.5 ATR back):
  // when a recent bar's range blows past spikeRangeAtrMult × ATR, the move
  // IS the peak more often than not — hug it with a tighter trail while the
  // spike condition holds. Ratchet-only semantics are unchanged: when the
  // spike passes the distance relaxes again but the stop never widens.
  spikeTightenEnabled: true,
  spikeRangeAtrMult: 2,   // a bar with range ≥ this × ATR counts as a spike
  spikeTrailAtrMult: 1,   // trail distance (× ATR) while the spike holds
  spikeBars: 3,           // how many recent bars are checked for a spike
  // Structure trailing (aligned plan §2.5.4): trail behind the last CONFIRMED
  // swing on the protective side instead of a fixed distance from the peak.
  // Bars are the ATR timeframe's own bars (default 1h) — already fetched and
  // cached, so this costs no extra broker call. Falls back to the Chandelier
  // whenever no pivot qualifies, and never widens an existing stop.
  structureTrailEnabled: true,
  structurePivotBars: 2,      // bars either side that must be higher/lower
  structureBufferAtrMult: 0.25, // slack beyond the swing, in ATR
  structureMaxAtrMult: 4,     // giveback from the peak stays bounded by this
  // fixed mode
  armProfitUsd: 50,
  // OWNER ORDER 18-09-2026 ("set the arm to +0.5R"): the keeper does not
  // engage before the position has earned half its own risk. The arm is
  // max(the mode's own threshold, armR × the position's initial risk in
  // dollars) — the R term only ever RAISES the arm, in both modes. Measured
  // reason: on …0949 the adaptive arm (1.2 × 1h-ATR, or 0.1 % of balance)
  // engaged the chandelier on moves of a few tenths of an R and the trail
  // then cut winners at +0.30R average; avg win +0.40R vs avg loss −0.72R
  // is the exit shape that produced. Rows with no `initial_risk` on record
  // (adopted / manual positions) keep the mode's own threshold — no R is
  // invented for them. null/0 switches the R term off.
  armR: 0.5,
  givebackPct: 40,
  // both modes
  takeProfitUsd: null,    // optional hard close at +$X (null = off)
}

export function loadProfitKeeperConfig(db) {
  try {
    const saved = JSON.parse(getState(db, 'profit_keeper_json') || 'null')
    return { ...DEFAULT_PROFIT_KEEPER, ...(saved || {}) }
  } catch {
    return { ...DEFAULT_PROFIT_KEEPER }
  }
}

/**
 * Wilder's ATR from OHLC bars [{h,l,c}…] oldest→newest. Returns null when
 * there are not enough bars for the period.
 */
/**
 * How long an ATR stays good for: one bar of its own timeframe.
 *
 * Not a guess at "long enough" — it is exactly the interval at which the input
 * can change. A 1h ATR recomputed at 09:15 and again at 09:20 is the same
 * number, because the same completed bars produced it.
 */
export const ATR_TF_MS = Object.freeze({
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
})

const ATR_CACHE = new Map()   // `${symbolId}|${tf}` → { atr, bars, fullBars, barHost, barAccountId, at }

/** Bounded so a long-running process with a wide symbol universe cannot grow it forever. */
const ATR_CACHE_MAX = 500

export function readAtrCache(symbolId, timeframe, now = Date.now()) {
  const ttl = ATR_TF_MS[timeframe]
  // An unrecognised timeframe is never served from cache: better one extra
  // fetch than an ATR held past the data that produced it.
  if (!ttl) return null
  const hit = ATR_CACHE.get(`${symbolId}|${timeframe}`)
  if (!hit || (now - hit.at) >= ttl) return null
  return hit
}

export function writeAtrCache(symbolId, timeframe, { atr, bars, fullBars, barHost, barAccountId }, now = Date.now()) {
  if (ATR_CACHE.size >= ATR_CACHE_MAX) {
    // Drop the oldest rather than clearing: a full flush would make every
    // symbol refetch at once, which is the burst the concurrency cap avoids.
    let oldK = null, oldAt = Infinity
    for (const [k, v] of ATR_CACHE) if (v.at < oldAt) { oldAt = v.at; oldK = k }
    if (oldK) ATR_CACHE.delete(oldK)
  }
  ATR_CACHE.set(`${symbolId}|${timeframe}`, { atr, bars, fullBars, barHost, barAccountId, at: now })
}

/** Test seam — the cache is process-level, so a test must be able to clear it. */
export function clearAtrCache() { ATR_CACHE.clear() }

/**
 * The cached ATR for a SYMBOL, or null.
 *
 * Added for PR-J, whose two trails are specified in ATR multiples. It is a
 * READ of what the keeper has already fetched — never a fetch of its own, so
 * it costs nothing on the monitor's path and can return null. Null is the
 * normal case when the keeper is not in adaptive mode or has not seen this
 * symbol this bar, and the caller falls back to the position's own 1R
 * distance rather than skipping the rule.
 */
export function cachedAtrForSymbol(db, symbol, now = Date.now()) {
  try {
    const cfg = loadProfitKeeperConfig(db)
    const map = JSON.parse(getState(db, 'symbol_id_map') || '{}')
    const id = map[String(symbol || '').toUpperCase()]
    if (!id) return null
    const hit = readAtrCache(id, cfg.atrTimeframe, now)
    return Number(hit?.atr) > 0 ? Number(hit.atr) : null
  } catch { return null }
}

// E·1: the ATR maths moved to lib/stop-floor.js so the risk gate's stop
// floor and the keeper read one implementation; re-exported unchanged.
export { atrFromBars }

/**
 * The most recent CONFIRMED swing pivot on the protective side of the trade,
 * as a stop level. Pure and tested.
 *
 * A Chandelier stop is a distance; a structure stop is a place. The
 * difference matters on the way up: a trail measured from the peak moves with
 * every new high, so an ordinary pullback into the last higher low — the one
 * the trend is supposed to make — can take the position out at a level the
 * market never treated as broken. Trailing behind the swing instead means the
 * position survives everything except the thing that actually invalidates it.
 *
 * A pivot is CONFIRMED, never live: index i qualifies only when `pivotBars`
 * bars on BOTH sides are higher (for a low). The most recent `pivotBars` bars
 * therefore cannot produce a pivot, which is the point — an unconfirmed low
 * is a guess about a bar that has not finished being a bar.
 *
 * @param {Array<{h:number,l:number}>} bars oldest→newest
 * @param {{dir:number, pivotBars?:number, atr?:number, bufferAtrMult?:number,
 *          maxAtrMult?:number, peakPrice?:number|null, price?:number|null}} opt
 * @returns {number|null} stop level, or null when no pivot qualifies
 */
export function swingTrailLevel(bars, {
  dir, pivotBars = 2, atr = 0, bufferAtrMult = 0.25, maxAtrMult = null,
  peakPrice = null, price = null,
} = {}) {
  if (!Array.isArray(bars) || bars.length < pivotBars * 2 + 1) return null
  const n = Number(pivotBars)
  if (!Number.isFinite(n) || n < 1) return null
  const long = dir === 1

  let level = null
  // newest→oldest: the FIRST qualifying pivot is the most recent one.
  for (let i = bars.length - 1 - n; i >= n; i--) {
    const b = bars[i]
    if (!b || !Number.isFinite(b.h) || !Number.isFinite(b.l)) continue
    let ok = true
    for (let k = 1; k <= n && ok; k++) {
      const a = bars[i - k], c = bars[i + k]
      if (!a || !c) { ok = false; break }
      ok = long ? (a.l > b.l && c.l > b.l) : (a.h < b.h && c.h < b.h)
    }
    if (!ok) continue
    const candidate = long ? b.l - bufferAtrMult * atr : b.h + bufferAtrMult * atr
    // A pivot on the wrong side of price is history, not a stop: taking it
    // would place the stop where the trade is already beaten.
    if (Number.isFinite(price)) {
      if (long ? candidate >= price : candidate <= price) continue
    }
    level = candidate
    break
  }
  if (level == null) return null

  // Structure gives room; it must not give unlimited room. The giveback from
  // the peak stays bounded by maxAtrMult, so a swing that happens to sit far
  // below cannot quietly turn a protected winner back into a scratch.
  if (maxAtrMult != null && Number.isFinite(peakPrice) && atr > 0) {
    const bound = long ? peakPrice - maxAtrMult * atr : peakPrice + maxAtrMult * atr
    level = long ? Math.max(level, bound) : Math.min(level, bound)
  }
  return level
}

// Quote-ccy ⇄ USD conversion for the P&L math — exact for USD-quoted
// symbols (incl. commodities/indices via instrumentType, which knows that
// NATGAS is energy, not an FX pair) and USD-base pairs; crosses with no
// USD leg are skipped rather than mis-protected.
function quoteInfo(symbol, price) {
  const t = instrumentType(symbol)
  if (t === 'fx (USD-base)') return price > 0 ? { toUsd: (q) => q / price, toQuote: (u) => u * price } : null
  if (t === 'fx cross') return null
  return { toUsd: (q) => q, toQuote: (u) => u }
}

/**
 * Pure decision for one position. `action` is null or an object that may
 * combine { close, reason } | { sl, lockUsd } | { scaleOutFrac }.
 */
export function decideProfitKeeper(cfg, {
  side, entry, price, lots, unitsPerLot, symbol, peak, currentSl, digits,
  atr = null, balance = null, scaledOut = false, bars = null, initialRisk = null,
}) {
  const out = { newPeak: peak || 0, profitUsd: null, action: null }
  if (!cfg?.on || !(price > 0) || !(entry > 0) || !(lots > 0) || !(unitsPerLot > 0)) return out
  const q = quoteInfo(symbol, price)
  if (!q) return out // cross with no USD leg — cannot convert honestly
  const s = String(side || '').toUpperCase()
  const dir = s === 'LONG' || s === 'BUY' ? 1 : -1

  const profitQuote = (price - entry) * dir * lots * unitsPerLot
  const profitUsd = q.toUsd(profitQuote)
  out.profitUsd = Math.round(profitUsd * 100) / 100
  // The position's own 1R in dollars (initial stop distance × size), and the
  // arm floor `armR` of it demands — 0 when the risk is not on record.
  const riskUsd = Number(initialRisk) > 0 ? q.toUsd(Number(initialRisk) * lots * unitsPerLot) : 0
  const armUsdR = Number(cfg.armR) > 0 && riskUsd > 0 ? Number(cfg.armR) * riskUsd : 0
  out.riskUsd = riskUsd > 0 ? Math.round(riskUsd * 100) / 100 : null
  out.newPeak = Math.max(peak || 0, out.profitUsd)

  if (Number(cfg.takeProfitUsd) > 0 && profitUsd >= Number(cfg.takeProfitUsd)) {
    out.action = { close: true, reason: `take_profit_usd ${out.profitUsd} >= ${cfg.takeProfitUsd}` }
    return out
  }

  const tighter = (candidate) =>
    currentSl == null || (dir === 1 ? candidate > currentSl : candidate < currentSl)

  if (cfg.mode === 'adaptive' && atr > 0) {
    // Arm threshold in volatility units with a balance-relative noise floor.
    const armUsdAtr = q.toUsd(Number(cfg.armAtrMult) * atr * lots * unitsPerLot)
    const armUsdBal = balance > 0 ? balance * (Number(cfg.armBalancePct) / 100) : 0
    const armUsd = Math.max(armUsdAtr, armUsdBal, armUsdR)
    if (!(armUsd > 0) || out.newPeak < armUsd) return out

    // Chandelier trail: SL sits trailAtrMult × ATR behind the PEAK price —
    // unless a recent bar spiked, in which case the tighter spike trail
    // applies while the condition holds (see config comment above).
    let trailMult = Number(cfg.trailAtrMult)
    let spiked = false
    if (cfg.spikeTightenEnabled !== false && Array.isArray(bars) && bars.length > 0) {
      const look = Math.max(1, Math.floor(Number(cfg.spikeBars) || 3))
      spiked = bars.slice(-look).some(b =>
        b && Number.isFinite(b.h) && Number.isFinite(b.l) &&
        (b.h - b.l) >= Number(cfg.spikeRangeAtrMult || 2) * atr)
      if (spiked) trailMult = Math.min(trailMult, Number(cfg.spikeTrailAtrMult || 1))
    }
    const peakPrice = entry + dir * q.toQuote(out.newPeak) / (lots * unitsPerLot)
    const chandelier = peakPrice - dir * trailMult * atr

    // Structure trail: the last confirmed swing wins when one exists, EXCEPT
    // while a spike is tightening — a spike says the peak is probably the
    // move, and honouring a swing four bars back would give the whole spike
    // away. Ratchet-only semantics are untouched either way: `tighter()`
    // below is what actually decides whether the stop moves.
    let level = chandelier
    let viaStructure = false
    if (cfg.structureTrailEnabled !== false && !spiked && Array.isArray(bars) && bars.length) {
      const swing = swingTrailLevel(bars, {
        dir,
        pivotBars: Number(cfg.structurePivotBars) || 2,
        atr,
        bufferAtrMult: Number(cfg.structureBufferAtrMult ?? 0.25),
        // An explicit null means "unbounded" — an ABSENT key must not, or a
        // partial config silently buys unlimited giveback.
        maxAtrMult: cfg.structureMaxAtrMult === null ? null : Number(cfg.structureMaxAtrMult ?? 4),
        peakPrice,
        price,
      })
      if (swing != null) { level = swing; viaStructure = true }
    }

    const slTarget = roundToDigits(level, digits)
    const breached = dir === 1 ? price <= slTarget : price >= slTarget
    if (breached) {
      out.action = {
        close: true,
        reason: `${viaStructure ? 'structure' : 'chandelier'} peak=${out.newPeak.toFixed(2)} trail=${slTarget} now=${price}`,
      }
      return out
    }
    // Armed and not breached: expose the live trail parameters so the
    // caller can hand them to the C++ tick-level ratchet (option 4). This
    // is the POLICY output — the distance is measured from the level that
    // actually applies, so the sidecar trails the structure stop rather than
    // a Chandelier the policy has already stopped using.
    out.trail = { distance: Math.abs(peakPrice - level), peakPrice }

    const action = {}
    if (Number(cfg.scaleOutFrac) > 0 && !scaledOut) action.scaleOutFrac = Math.min(0.9, Number(cfg.scaleOutFrac))
    if (tighter(slTarget)) {
      action.sl = slTarget
      action.lockUsd = Math.round(q.toUsd((slTarget - entry) * dir * lots * unitsPerLot) * 100) / 100
      if (spiked) action.spike = true // for the notify message — policy, not extra risk
      if (viaStructure) action.structure = true // ditto: which trail set this level
    }
    out.action = Object.keys(action).length ? action : null
    return out
  }

  // FIXED mode (also the fallback when no ATR is available).
  const armFixed = Math.max(Number(cfg.armProfitUsd) || 0, armUsdR)
  if (!(armFixed > 0) || out.newPeak < armFixed) return out

  const lockUsd = out.newPeak * (1 - Math.min(95, Math.max(0, Number(cfg.givebackPct))) / 100)
  if (profitUsd <= lockUsd) {
    out.action = { close: true, reason: `giveback peak=${out.newPeak.toFixed(2)} now=${out.profitUsd} lock=${lockUsd.toFixed(2)}` }
    return out
  }
  const moveQuote = q.toQuote(lockUsd) / (lots * unitsPerLot)
  const slTarget = roundToDigits(entry + dir * moveQuote, digits)
  if (tighter(slTarget)) out.action = { sl: slTarget, lockUsd: Math.round(lockUsd * 100) / 100 }
  return out
}

// Codex · №12,210 · 2026-10-08; codex-footprint: keeper-volume-peak.
// A dollar peak belongs to the quantity that earned it. A smaller remainder
// retains that per-unit peak, not the full position's dollars. Added volume
// or a changed entry/identity starts a new basis; neither proves that the new
// units experienced the old peak. Legacy peaks have no recoverable size basis.
function keeperPeakBasis(row, bp, accountId) {
  const td = bp.tradeData || {}
  const side = ['LONG', 'BUY'].includes(String(row.side).toUpperCase()) ? 1
    : ['SHORT', 'SELL'].includes(String(row.side).toUpperCase()) ? -1 : null
  // Codex · №12,223 · 2026-10-08; codex-footprint: keeper-volume-peak.
  // Same supported broker enum forms as LossGuardian; unknown/conflicting
  // sides still refuse. Number('BUY') must not disable valid protection.
  const brokerSide = td.tradeSide === 1 || td.tradeSide === '1' || td.tradeSide === 'BUY' ? 1
    : td.tradeSide === 2 || td.tradeSide === '2' || td.tradeSide === 'SELL' ? -1 : 0
  const positiveNumber = raw => (typeof raw === 'number'
    || (typeof raw === 'string' && /^[0-9]+(?:\.[0-9]+)?$/.test(raw)))
    && Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : null
  const symbolId = (typeof td.symbolId === 'number'
    || (typeof td.symbolId === 'string' && /^[0-9]+$/.test(td.symbolId))) ? Number(td.symbolId) : null
  const basis = {
    version: 1, accountId: String(accountId), positionId: String(row.position_id),
    symbolId, side, entry: positiveNumber(bp.price ?? row.entry_price),
    volume: positiveNumber(td.volume),
  }
  if (!side || !Number.isSafeInteger(basis.symbolId) || basis.symbolId <= 0
      || !Number.isFinite(basis.entry) || basis.entry <= 0
      || !Number.isFinite(basis.volume) || basis.volume <= 0
      || (!brokerSide || brokerSide !== side)) return null
  let previous
  try { previous = JSON.parse(row.keeper_peak_state) } catch { /* unknown basis */ }
  const same = previous?.version === 1 && ['accountId', 'positionId', 'symbolId', 'side', 'entry']
    .every(key => previous[key] === basis[key])
    && Number.isFinite(previous.volume) && previous.volume > 0
    && Number.isFinite(previous.peakUsd) && previous.peakUsd >= 0
  // Increasing volume cannot give newly added units a peak they never saw.
  const peak = same && basis.volume <= previous.volume
    ? previous.peakUsd * (basis.volume / previous.volume) : 0
  return { basis, peak }
}

/**
 * One keeper pass: broker-truth positions in scope → decide → act through
 * the exec engine. Never throws; returns a summary.
 */
export function runProfitKeeper(db, creds, deps = {}) {
  return singleFlight('profit_keeper', () => profitKeeperPass(db, creds, deps))
}

async function profitKeeperPass(db, creds, deps = {}) {
  const summary = { checked: 0, slMoves: 0, alreadyTighter: 0, closes: 0, scaleOuts: 0, refused: 0, earlyTrimShadow: 0, managedSkipped: 0, bookSkipped: 0, deferred: [], errors: [] }
  try {
    const cfg = loadProfitKeeperConfig(db)
    if (!cfg.on) return summary
    // Read once per sweep, not per position. Unreadable config leaves the
    // shadow OFF — see earlyTrimConfig.
    let trimCfg
    try { trimCfg = earlyTrimConfig(JSON.parse(getState(db, 'early_trim_json') || 'null')) }
    catch { trimCfg = earlyTrimConfig(null) }

    const accountId = authorisedAccountId(creds)
    const bookHolds = makeBookHeldCheck(db, accountId)
    const closedRecoveries = pendingKeeperClosedMonitorIds(db, accountId)
    const scopeSql = cfg.scope === 'all'
      ? "mp.source IS NULL OR mp.source IN ('autopilot', 'preopen', 'external', 'manual')"
      : "mp.source IN ('external', 'manual')"
    const rows = db.prepare(
      `SELECT mp.id, mp.symbol, mp.side, mp.entry_price, mp.current_sl, mp.current_tp, mp.peak_profit_usd, mp.keeper_peak_state,
              mp.scaled_out, mp.trade_id, mp.account_id, mp.status, t.ctrader_position_id AS position_id,
              t.sl_price AS original_sl, mp.early_trimmed, mp.initial_risk
       FROM monitored_positions mp
       JOIN trades t ON t.id = mp.trade_id
       WHERE (mp.status = 'active'${closedRecoveries.length ? ` OR (mp.status='closed' AND mp.id IN (${closedRecoveries.map(() => '?').join(',')}))` : ''}) AND mp.guard_json IS NULL
         AND (mp.keeper_opt_out IS NULL OR mp.keeper_opt_out != 1)
         AND t.ctrader_position_id IS NOT NULL AND (${scopeSql})
         AND ${accountFilterSql('mp.account_id')}`
    ).all(...closedRecoveries, accountId).filter(r => {
      // ONE HORIZON RULE (Wave 2 of the first-principles audit, 19-09-2026,
      // §K·6). A momentum-book row is trailed by the book's 3×ATR daily rule
      // and by nothing else: this keeper's 1h chandelier was a second stop
      // authority on every weeks-horizon runner ("the keeper is paused on
      // these positions" was text, not code — the SELECT never read the
      // book). The same predicate the weekend bank and the protection audit
      // use; counted, never silent.
      if (bookHolds(r.position_id, r.trade_id)) { summary.bookSkipped += 1; return false }
      return true
    })

    // MANAGED-EXIT FENCE (owner "Go", 01-09-2026). On accounts the managed
    // policy governs, the trail is the ONLY exit-timing rule — one-simple-
    // system P4 classes this keeper's spike/structure/arm knobs as
    // "replace", and until this fence nobody had wired that: the keeper kept
    // pushing chandelier trail specs to the sidecar's tick ratchet for every
    // position, a THIRD stop authority beating the managed trail. Measured
    // 01-09: the first four earned-floor cohort closes peaked +0.77R and all
    // exited at the keeper's chandelier for small losses, where the managed
    // trail_0.5R stop would have banked +0.27R each. Same failure class as
    // the 0016.HK two-evaluator hole, at a third evaluator. Filtering HERE
    // removes managed positions from every downstream path in one place —
    // decisions, closes, scale-outs AND the /trail-config push (full-replace,
    // pushed even when empty, so stale sidecar specs for these positions
    // clear on the next pass).
    const { managedExitApplies } = deps.managedExit ?? await import('./managed-exit.js')
    const managedByAcct = new Map()
    const kept = []
    for (const r of rows) {
      const k = String(r.account_id ?? '')
      if (!managedByAcct.has(k)) managedByAcct.set(k, managedExitApplies(db, r.account_id))
      if (managedByAcct.get(k)) summary.managedSkipped += 1
      else kept.push(r)
    }
    // The fence stops here: decisions, closes and scale-outs read `kept`.
    // The since-entry Chandelier spec below reads every non-book row, managed
    // accounts included (owner decision № 10,474, 02-10-2026): with the fence
    // in front of it, `kept` was empty on every registered account and the
    // pass returned before the /trail-config push, so the spec never reached
    // the C++ TrailEngine (0 push lines in 47 passes). The engine only
    // tightens, so on a managed account the tighter of the managed trail and
    // this spec governs — the 01-09 earned-floor cohort is what to watch.
    if (rows.length === 0) return summary
    const keptIds = new Set(kept.map(r => r.id))

    const exec = deps.exec ?? await import('../lib/exec-engine.js')
    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const sizing = deps.sizing ?? await import('../lib/lot-sizing.js')
    const notify = deps.notify ?? (() => {})
    const closeDeps = {
      close: args => exec.closePosition(creds, args),
      // Account-owned fresh broker response, not the gateway's cached snapshot.
      reconcile: () => ws.wsReconcile(creds.host, creds.clientId, creds.clientSecret,
        creds.accessToken, creds.accountId, 4000, 0),
      deals: positionId => ws.wsGetPositionDeals(creds.host, creds.clientId, creds.clientSecret,
        creds.accessToken, creds.accountId, positionId, Date.now(), 4000),
    }
    const closeInput = r => ({ accountId: r.account_id ?? accountId, positionId: r.position_id,
      tradeId: r.trade_id, monitorId: r.id, symbol: r.symbol, side: r.side, host: creds.host })
    const noteClose = (r, outcome) => {
      if (outcome.pending) summary.deferred.push(`${r.symbol}: ${outcome.reason}`)
      if (!outcome.committed) return
      if (outcome.kind === 'close') summary.closes++
      else summary.scaleOuts++
      notify(`💰 Profit Keeper ${outcome.kind === 'close' ? 'closed' : 'banked'} ${r.symbol}: confirmed ${outcome.receipt.closedVolume} protocol units at ${outcome.receipt.price}`)
    }
    // PER-ACCOUNT balance. This read had no accountId, so it resolved to the
    // SELECTED account while the row set spanned every account — arming
    // thresholds and the balance-percent floor were computed from the wrong
    // account's money for every account but one.
    const balance = getAccountBalance(db, accountId)

    // Broker truth: live volume, entry, current SL per position.
    const rec = await exec.reconcile(creds)
    const live = new Map()
    for (const p of (rec.position || [])) {
      if (p.positionId != null) live.set(String(p.positionId), p)
    }

    const scoped = scopeToAccount(rows.filter(r => r.status === 'active'), { accountId, live })
    summary.refused = scoped.foreign.length
    if (scoped.foreign.length) {
      summary.errors.push(`${scoped.foreign.length} position(s) belong to another account and were not touched`)
    }
    // A successful full close is absent from the current position list.
    // Its durable account/episode ownership can still reconcile its receipt.
    const recoveredCloses = new Map()
    for (const r of kept) {
      if (r.account_id != null && String(r.account_id) !== String(accountId)) continue
      try {
        const attempt = readKeeperClose(db, accountId, r.position_id)
        if (!attempt || !['SENDING', 'AMBIGUOUS', 'RECEIVED'].includes(attempt.state)) continue
        const outcome = await runKeeperClose(db, { ...closeInput(r), recoverOnly: true }, closeDeps)
        recoveredCloses.set(r.id, outcome)
        noteClose(r, outcome)
      } catch (err) {
        recoveredCloses.set(r.id, { pending: true })
        summary.errors.push(`${r.symbol} keeper receipt recovery: ${err.message}`)
      }
    }
    // involvedAll: every owned row the broker holds (the spec set);
    // involved: the subset the managed fence left to this keeper (decisions).
    const trailSpecs = []
    summary.trailSpecs = trailSpecs
    summary.trailSpecsComplete = true
    const peakBases = new Map()
    // Codex · №12,232 · 2026-10-08; codex-footprint: keeper-volume-peak.
    // Validate every owned spec/decision row BEFORE quote/meta early exits.
    // Managed rows can still emit since-entry specs, so they share this
    // identity boundary even though their keeper decisions remain fenced.
    const involvedAll = scoped.owned
      .map(r => ({ r, bp: live.get(String(r.position_id)) }))
      .filter(x => x.bp)
      .filter(({r,bp}) => {
        const basis = keeperPeakBasis(r, bp, accountId)
        if (!basis) {
          summary.errors.push(`${r.symbol}: keeper peak basis has missing or conflicting broker identity/quantity`)
          summary.trailSpecsComplete = false
          return false
        }
        peakBases.set(r.id, basis)
        return true
      })
    const involved = involvedAll.filter(x => keptIds.has(x.r.id))
    const symbolIds = [...new Set(involvedAll.map(x => x.bp.tradeData?.symbolId).filter(Boolean))]
    if (symbolIds.length === 0) return summary
    const prices = await ws.wsGetLastCloses(
      creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolIds
    )

    // ATR per symbol (adaptive mode only) — one bar fetch per symbol per
    // pass. The bar tail rides along for the spike-tighten check.
    // §70.6 follow-up: THIS FETCH USED TO BOUND TICK RESPONSE.
    //
    // The whole pass is single-flighted, so everything else the keeper does —
    // the chandelier breach, takeProfitUsd, the giveback rule, all of which need
    // only a price already in hand — waited behind one WS round-trip PER SYMBOL,
    // run one after another. On a busy book that is the difference between a
    // sub-second pass and a multi-second one, and a tick-driven caller arriving
    // mid-pass waits for the whole thing.
    //
    // Two changes, neither of which alters a single decision:
    //
    //   1. CACHED FOR THE BAR. The ATR timeframe is an hour by default, so
    //      refetching it every 60 seconds asked for the same answer sixty times
    //      per bar. The cache expires on the timeframe's own period, so the ATR
    //      is exactly as fresh as the data it is computed from — no staler.
    //   2. FETCHED CONCURRENTLY. Serial was never required; the symbols are
    //      independent. Bounded so a large book cannot turn one pass into a
    //      burst the broker throttles.
    const atrBySymbolId = {}
    const barsBySymbolId = {}
    const fullBarsBySymbolId = {}
    if (cfg.mode === 'adaptive') {
      const stale = []
      for (const id of symbolIds) {
        const hit = readAtrCache(id, cfg.atrTimeframe)
        // /trail-config replaces the whole set, so every warm pass still
        // needs the full window for the since-entry ATR(22). Numeric symbol
        // IDs alone do not establish the broker host/account of those bars.
        if (hit && Array.isArray(hit.fullBars) && hit.barHost === creds.host && String(hit.barAccountId) === String(creds.accountId)) {
          atrBySymbolId[id] = hit.atr
          barsBySymbolId[id] = hit.bars
          fullBarsBySymbolId[id] = hit.fullBars
          continue
        }
        stale.push(id)
      }
      const CONCURRENCY = 4
      for (let i = 0; i < stale.length; i += CONCURRENCY) {
        await Promise.all(stale.slice(i, i + CONCURRENCY).map(async (id) => {
          try {
            const bars = await ws.wsGetTrendbarsBatch(
              creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
              id, [cfg.atrTimeframe], Math.max(cfg.atrPeriod * 3, 50)
            )
            const list = bars?.[cfg.atrTimeframe] || []
            const atr = atrFromBars(list, cfg.atrPeriod)
            const tail = list.slice(-Math.max(1, Math.floor(Number(cfg.spikeBars) || 3)))
            atrBySymbolId[id] = atr
            barsBySymbolId[id] = tail
            fullBarsBySymbolId[id] = list
            // Only a REAL answer is cached. Caching a failed fetch would make
            // one bad round-trip suppress retries for a whole bar, and the
            // fallback (fixed thresholds) is looser than the adaptive one.
            if (atr != null) writeAtrCache(id, cfg.atrTimeframe, {
              atr, bars: tail, fullBars: list, barHost: creds.host, barAccountId: creds.accountId,
            })
          } catch { atrBySymbolId[id] = null /* falls back to fixed thresholds */ }
        }))
      }
    }

    const updPeak = db.prepare(`UPDATE monitored_positions
      SET peak_profit_usd = MAX(COALESCE(peak_profit_usd, 0), ?), keeper_peak_state = ? WHERE id = ?`)
    const updAct = db.prepare(
      `UPDATE monitored_positions
       SET current_sl = COALESCE(?, current_sl), last_check_action = ?, last_check_at = datetime('now')
       WHERE id = ?`
    )

    // Specs and completeness were initialized before identity filtering.
    // The guardian merges this account's validated contribution per gateway.
    const brokerDigitsByPosition = new Map()

    for (const { r, bp } of involved) {
      const td = bp.tradeData || {}
      const price = prices[td.symbolId]
      if (price == null) continue
      let meta
      try {
        meta = await sizing.getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, td.symbolId)
      } catch (err) { summary.errors.push(`${r.symbol}: ${err.message}`); summary.trailSpecsComplete = false; continue }
      summary.checked++
      // Keep the RAW broker value, including absence, separate from sizing.
      // Map.has records a completed lookup; missing precision is not retried
      // or replaced by a manufactured default from another snapshot.
      brokerDigitsByPosition.set(String(parseInt(r.position_id)), meta.brokerDigits)

      const peakBasis = peakBases.get(r.id)
      const lots = td.volume && meta.lotSize ? td.volume / meta.lotSize : null
      const decision = decideProfitKeeper(cfg, {
        side: r.side,
        entry: peakBasis.basis.entry,
        price,
        lots,
        unitsPerLot: meta.lotSize / 100,
        symbol: r.symbol,
        peak: peakBasis.peak,
        currentSl: bp.stopLoss ?? r.current_sl,
        digits: meta.digits,
        atr: atrBySymbolId[td.symbolId] ?? null,
        balance,
        scaledOut: !!r.scaled_out,
        bars: barsBySymbolId[td.symbolId] ?? null,
        initialRisk: r.initial_risk,
      })
      // ── EARLY TRIM, SHADOW ONLY (owner 07-08: "ship T2 log-only now") ──
      // Computed here because this is the one place that already holds broker
      // truth for the position — live volume, live price and the broker's own
      // minimum lot. Recomputing it anywhere else would mean a second source
      // for the same numbers, which is how the two of them start disagreeing.
      //
      // NOTHING IS ACTED ON. No close, no amend, no volume change. The row is
      // written so that in a week there is a live record to set beside Phase
      // 7's offline replay, and the decision to switch it on can be made
      // against two independent readings instead of an intuition.
      try {
        const trimDecision = earlyTrimDecision({
          side: r.side,
          entry: bp.price ?? r.entry_price,
          // The ORIGINAL stop, never bp.stopLoss — the keeper ratchets that,
          // and R measured against a moving stop reaches 1R without the trade
          // going anywhere. See early-trim.js §1.
          originalSl: r.original_sl,
          price,
          volume: td.volume,
          minVolume: meta.minVolume ?? 0,
          alreadyTrimmed: !!r.early_trimmed,
          cfg: trimCfg,
        })
        if (trimDecision.trim) {
          summary.earlyTrimShadow++
          const row = earlyTrimShadowRow(trimDecision, {
            symbol: r.symbol, positionId: r.position_id, tradeId: r.trade_id,
            accountId: r.account_id, price,
          })
          db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
            .run('SHADOW', '/early-trim', JSON.stringify(row), r.account_id ?? null)
        }
      } catch (err) {
        // A shadow observation must never be able to break the keeper. This is
        // the one place a swallowed error is correct: the feature's whole
        // purpose is to change nothing, and that includes failing.
        summary.errors.push(`early-trim shadow ${r.symbol}: ${err.message}`)
      }

      // Commit the current decision basis BEFORE any close/amend. A failed
      // write aborts this pass without acting on an unretained peak. The old
      // high-water mark remains observational; it is never a fallback basis.
      if (decision.profitUsd != null && (decision.newPeak > 0 || r.keeper_peak_state != null)) {
        const state = JSON.stringify({ ...peakBasis.basis, peakUsd: decision.newPeak })
        if (state !== r.keeper_peak_state || decision.newPeak > (r.peak_profit_usd || 0)) {
          updPeak.run(decision.newPeak, state, r.id)
        }
      }
      if (decision.trail && !decision.action?.close) {
        const s = String(r.side || '').toUpperCase()
        // The account is REQUIRED on a trail spec now, not best-effort.
        //
        // This used to be `Number(creds.accountId) || undefined`, which sent no
        // account whenever accountId was absent or unparseable. The C++ trail
        // engine then attached none, and ExecEngine::amendPosition filled one in
        // from its frozen primary — so a stop-loss ratchet for one account could
        // be applied against another. amendPosition now refuses an unstamped
        // payload (owner's decision, 2026-07-30), and TrailEngine::configure
        // drops specs that name no account, so a spec without one would silently
        // stop being ratcheted. Skipping it here instead keeps the reason at the
        // place that can explain it; the keeper's own 3s ratchet still covers
        // the position either way.
        // NOT `continue` — that would skip this position's own close/amend
        // action below. Only the tick-level trail spec is withheld.
        const acct = Number(creds.accountId)
        if (!Number.isFinite(acct) || acct <= 0) {
          summary.errors.push(`${r.symbol}: trail spec skipped — credentials name no usable account (${String(creds.accountId)}); the keeper's own ratchet still applies`)
        } else {
          trailSpecs.push({
            positionId: parseInt(r.position_id),
            ctidTraderAccountId: acct,
            symbolId: td.symbolId,
            dir: s === 'LONG' || s === 'BUY' ? 1 : -1,
            trailDistance: decision.trail.distance,
            peakPrice: decision.trail.peakPrice,
            currentSl: bp.stopLoss ?? r.current_sl ?? null,
            // The sidecar's SL/TP amend replaces both legs. It must re-send
            // the broker target; a targetless spec is rejected fail-closed.
            currentTp: bp.takeProfit ?? r.current_tp ?? null,
            digits: meta.digits,
            // The TrailEngine decides, per amend, whether the stop it sends
            // locks profit (broker-side trailing starts then — stop policy
            // 02-10-2026), so it needs the entry. The broker's own price when
            // it gave one, else the row's.
            entryPrice: Number(bp.price ?? r.entry_price) > 0 ? Number(bp.price ?? r.entry_price) : undefined,
          })
        }
      }
      if (!decision.action) continue

      // V3 F1: the T2 rule (momentum-exit-coordination.js). A momentum partial
      // or rank close claimed within the transport horizon may still be in
      // flight on this position; the keeper's close or scale-out waits for
      // this pass only and is decided again on the next. Past the horizon the
      // deferral ends whatever the plan row says. No plan, no deferral.
      // A scale-out below the symbol's minimum volume is never sent, so it is
      // not a deferred close either: work that out first, and list only a
      // close that would otherwise have gone out.
      const scaleVol = decision.action.scaleOutFrac ? Math.round(td.volume * decision.action.scaleOutFrac) : null
      const scaleSendable = scaleVol != null && (meta.minVolume == null || scaleVol >= meta.minVolume)
      const inFlight = (decision.action.close || scaleSendable)
        ? protectiveExitDeferral(db, { accountId: r.account_id ?? accountId, positionId: r.position_id, nowMs: deps.now ?? Date.now() })
        : null
      if (inFlight) summary.deferred.push(`${r.symbol}: ${decision.action.close ? 'close' : 'scale-out'} deferred — ${inFlight}`)

      if (decision.action.close) {
        if (inFlight || recoveredCloses.get(r.id)?.pending) continue
        try {
          noteClose(r, await runKeeperClose(db, { ...closeInput(r), kind: 'close',
            symbolId: td.symbolId, entry: peakBasis.basis.entry, beforeVolume: td.volume,
            volume: td.volume, meta, reason: decision.action.reason }, closeDeps))
        } catch (err) { summary.errors.push(`${r.symbol} close: ${err.message}`) }
        continue
      }
      if (decision.action.scaleOutFrac && !inFlight && !recoveredCloses.has(r.id)) {
        const vol = scaleVol
        if (scaleSendable) {
          try {
            noteClose(r, await runKeeperClose(db, { ...closeInput(r), kind: 'scale_out',
              symbolId: td.symbolId, entry: peakBasis.basis.entry, beforeVolume: td.volume,
              volume: vol, meta, reason: `scaleOutFrac ${decision.action.scaleOutFrac}` }, closeDeps))
          } catch (err) { summary.errors.push(`${r.symbol} scale-out: ${err.message}`) }
        }
      }
      if (decision.action.sl != null) {
        try {
          // The broker's own target, re-sent: a stop-only amend deletes it.
          // bp is this pass's broker snapshot, so this is what the broker
          // holds right now, not what the book believes it holds.
          // V3 M5: timed on the way through; the payload is untouched.
          const res = await measureAmend({ path: 'profit_keeper', source: 'profit_keeper', accountId: r.account_id ?? creds?.accountId, positionId: r.position_id }, () => exec.amendPosition(creds, {
            positionId: parseInt(r.position_id), stopLoss: decision.action.sl,
            takeProfit: Number(bp.takeProfit) > 0 ? Number(bp.takeProfit) : (Number(r.current_tp) > 0 ? Number(r.current_tp) : null),
            // What the stop MEANS, for the stop policy (02-10-2026): it decides
            // whether this lock earns the broker-side trailing flag. The keeper
            // already excludes momentum-book rows, so this is never one.
            stopContext: { side: r.side, entry: Number(bp.price ?? r.entry_price) || null, book: false },
            // Claude · № 11,690 07-Oct (Codex P1 on #1246): a ratchet transaction.
            // The sidecar re-reads the broker's stop under the position's lock
            // (the lock the TrailEngine's tick amends take) and refuses to
            // widen it: `decision.action.sl` was judged tighter against THIS
            // PASS'S snapshot, and the engine may have moved the stop since.
            // The identity fields make a wrong-position amend a refusal. (Last
            // in the object: amend-callsites.test.js reads the first 420 chars
            // of every amend call for its stop/target intent.)
            ratchetOnly: true,
            expectedDirection: ['LONG', 'BUY'].includes(String(r.side || '').toUpperCase()) ? 1 : -1,
            expectedSymbolId: td.symbolId,
          }))
          // Claude · № 11,690 07-Oct: `unchanged` means the broker already held
          // a stop at least as tight — the TrailEngine got there between this
          // pass's snapshot and its amend — so nothing moved: no count, no
          // notice. Either way current_sl takes the broker's CONFIRMED stop,
          // never this pass's target, so the row cannot read looser than the
          // broker (the divergence Codex named).
          const landed = Number(res?.protection?.stopLoss) > 0 ? Number(res.protection.stopLoss) : decision.action.sl
          if (res?.unchanged === true) {
            updAct.run(landed, 'profit_keeper_already_tighter', r.id)
            summary.alreadyTighter++
            continue
          }
          updAct.run(landed, 'profit_keeper_lock', r.id)
          summary.slMoves++
          notify(`🔒 Profit Keeper: ${r.symbol} SL ratcheted to ${landed}${decision.action.lockUsd != null ? ` (locks ~$${decision.action.lockUsd})` : ''}${decision.action.spike ? ' — spike detected, trail tightened' : ''}${decision.action.structure ? ' — trailing the last swing' : ''}`)
          recordPositionEvent(db, {
            accountId: r.account_id, positionId: r.position_id, tradeId: r.trade_id,
            symbol: r.symbol, kind: 'sl_moved',
            fromValue: bp.stopLoss ?? r.current_sl ?? null, toValue: landed,
            priceAt: price, reason: decision.action.spike ? 'spike_tighten'
              : decision.action.structure ? 'structure_ratchet' : 'chandelier_ratchet',
            source: 'profit_keeper',
          })
        } catch (err) {
          summary.errors.push(`${r.symbol} SL: ${err.message}`)
          // Broker refused the stop (too close to market?) — retried next
          // cycle; the breach/giveback close paths handle the retraced case.
        }
      }
    }

    // Since-entry Chandelier on the same tick ratchet. One push, so this does
    // not replace the keeper's specs and does not add a service. A position
    // the keeper already trails is left to that spec. TrailEngine still
    // refuses a target that does not improve the stop.
    const already = new Set(trailSpecs.map(s => String(s.positionId)))
    for (const { r, bp } of involvedAll) {
      const td = bp.tradeData || {}
      // involvedAll already passed the shared broker-identity boundary.
      if (already.has(String(parseInt(r.position_id)))) continue
      const bars = fullBarsBySymbolId[td.symbolId]
      // A row the fence kept from the decision step has no digits yet (the
      // decision step is where getVolumeMeta ran); read them here, cached.
      if (!brokerDigitsByPosition.has(String(parseInt(r.position_id))) && td.symbolId) {
        try {
          const meta = await sizing.getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, td.symbolId)
          brokerDigitsByPosition.set(String(parseInt(r.position_id)), meta?.brokerDigits)
        } catch { /* no digits → sinceEntryTrailSpec drops this row, as before */ }
      }
      const spec = sinceEntryTrailSpec({
        positionId: r.position_id,
        accountId: creds.accountId,
        symbolId: td.symbolId,
        side: r.side,
        entry: r.entry_price,
        bars,
        currentSl: bp.stopLoss ?? r.current_sl ?? null,
        currentTp: bp.takeProfit ?? r.current_tp ?? null,
        digits: brokerDigitsByPosition.get(String(parseInt(r.position_id))),
      })
      if (!spec) continue
      trailSpecs.push(spec)
    }
    console.log(`[since-entry-trail] trail-config ${trailSpecs.length} spec(s) for account ${creds.accountId}`)

    // Hand the armed set to the C++ tick ratchet (best-effort by contract).
    // Claude · № 11,596·D·1: POST /trail-config is one full replace PER
    // GATEWAY (trail_engine.cpp configure: byPosition_.swap), so when the
    // guardian sweeps every account it defers this push, merges each side's
    // specs and sends one union per side; `trailPushed: 'deferred'` says so.
    if (deps.deferTrailPush) {
      summary.trailPushed = 'deferred'
    } else {
      try {
        summary.trailPushed = exec.pushTrailConfig && await exec.pushTrailConfig(creds, trailSpecs) ? trailSpecs.length : null
      } catch { summary.trailPushed = null }
    }

    // lastSl may be seeded by config or an unchanged/already-tighter read;
    // retain the observation, but it alone proves no native amendment.
    // Actual amend_ok decisions remain in cpp_decisions with native identity.
    try {
      if (exec.getTrailStatus) {
        const byPositionId = new Map(involvedAll.map(x => [String(x.r.position_id), x]))
        const seen = lastSeenTrailSl.get(db) || new Map()
        lastSeenTrailSl.set(db, seen)
        const status = await exec.getTrailStatus(creds)
        if (status?.enabled && Array.isArray(status.positions)) {
          for (const p of status.positions) {
            if (p?.positionId == null || typeof p.lastSl !== 'number' || !Number.isFinite(p.lastSl) || !(p.lastSl > 0)) continue
            const key = String(p.positionId)
            // Codex P2 on #1243 (Claude · after № 11,614): /trail-status is the
            // whole gateway, every account's positions. The cursor is advanced
            // only for THIS pass's own rows; another account's position is
            // observed by its own pass without consuming another account's cursor.
            const own = byPositionId.get(key)
            if (!own || String(p.accountId) !== String(creds.accountId)
              || p.symbolId !== own.bp.tradeData?.symbolId
              || p.dir !== (own.bp.tradeData?.tradeSide === 1 ? 1 : own.bp.tradeData?.tradeSide === 2 ? -1 : 0)) continue
            const r = own.r, cursorKey = `${creds.host}|${creds.accountId}|${key}`
            const prev = seen.get(cursorKey)
            if (prev === p.lastSl) continue // unchanged since the last pass — nothing to journal
            const recorded = recordPositionEvent(db, {
              accountId: creds.accountId, positionId: key, tradeId: r.trade_id, symbol: r.symbol,
              kind: 'trail_observed', fromValue: prev, toValue: p.lastSl,
              source: 'cpp_trail_status', detail: { host: creds.host, symbolId: p.symbolId, direction: p.dir,
                protectionCheckedAtMs: Number.isSafeInteger(p.protectionCheckedAtMs) ? p.protectionCheckedAtMs : null },
            })
            if (recorded) seen.set(cursorKey, p.lastSl)
          }
        }
      }
    } catch { /* diagnostic only — never blocks the keeper */ }

    if (summary.slMoves || summary.closes || summary.scaleOuts) {
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('KEEPER', '/profit-keeper', JSON.stringify(summary).slice(0, 2000))
      } catch { /* action_log appears after first boot */ }
    }
  } catch (err) {
    summary.errors.push(err.message)
    if (summary.trailSpecsComplete) summary.trailSpecsComplete = false // Codex P1 on #1245: an aborted pass is not a complete list
  }
  return summary
}

// E·1: the keeper's ATR cache is the fallback hourly-ATR source for the
// risk gate's stop floor (the scan's cached 1h bars answer first).
registerAtrSource('keeper_cache', (db, symbol) => cachedAtrForSymbol(db, symbol))
