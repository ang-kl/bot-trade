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
import { getAccountBalance } from './risk.js'
import { roundToDigits } from './trade-guard.js'
import { recordPositionEvent } from './position-events.js'
import { singleFlight, authorisedAccountId, accountFilterSql, scopeToAccount } from './acting-layer.js'

// P10: last-seen broker SL per position, as reported by the C++ TrailEngine's
// GET /trail-status (a full snapshot, not a delta stream). Diffed each pass
// so a NEW ratchet becomes exactly one position_event — in-memory only, so a
// process restart can at worst re-log one ratchet as if it were new, never
// lose one silently.
const lastSeenTrailSl = new Map()

export const DEFAULT_PROFIT_KEEPER = {
  on: true,               // manual positions are managed by default — disarm for hands-off
  scope: 'external',      // 'external' = manual/imported positions only · 'all' = bot positions too
  mode: 'adaptive',       // 'adaptive' (ATR/balance units) · 'fixed' (dollar thresholds)
  // adaptive mode
  atrTimeframe: '1h',
  atrPeriod: 14,
  armAtrMult: 1,          // arm once peak profit ≥ this × the position's ATR-value…
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
  // fixed mode
  armProfitUsd: 50,
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

const ATR_CACHE = new Map()   // `${symbolId}|${tf}` → { atr, bars, at }

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

export function writeAtrCache(symbolId, timeframe, { atr, bars }, now = Date.now()) {
  if (ATR_CACHE.size >= ATR_CACHE_MAX) {
    // Drop the oldest rather than clearing: a full flush would make every
    // symbol refetch at once, which is the burst the concurrency cap avoids.
    let oldK = null, oldAt = Infinity
    for (const [k, v] of ATR_CACHE) if (v.at < oldAt) { oldAt = v.at; oldK = k }
    if (oldK) ATR_CACHE.delete(oldK)
  }
  ATR_CACHE.set(`${symbolId}|${timeframe}`, { atr, bars, at: now })
}

/** Test seam — the cache is process-level, so a test must be able to clear it. */
export function clearAtrCache() { ATR_CACHE.clear() }

export function atrFromBars(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null
  const trs = []
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]
    const prevC = bars[i - 1].c
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC)))
  }
  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }
  return atr
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
  atr = null, balance = null, scaledOut = false, bars = null,
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
    const armUsd = Math.max(armUsdAtr, armUsdBal)
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
    const slTarget = roundToDigits(peakPrice - dir * trailMult * atr, digits)
    const breached = dir === 1 ? price <= slTarget : price >= slTarget
    if (breached) {
      out.action = { close: true, reason: `chandelier peak=${out.newPeak.toFixed(2)} trail=${slTarget} now=${price}` }
      return out
    }
    // Armed and not breached: expose the live trail parameters so the
    // caller can hand them to the C++ tick-level ratchet (option 4). This
    // is the POLICY output — distance already reflects spike tightening.
    out.trail = { distance: trailMult * atr, peakPrice }

    const action = {}
    if (Number(cfg.scaleOutFrac) > 0 && !scaledOut) action.scaleOutFrac = Math.min(0.9, Number(cfg.scaleOutFrac))
    if (tighter(slTarget)) {
      action.sl = slTarget
      action.lockUsd = Math.round(q.toUsd((slTarget - entry) * dir * lots * unitsPerLot) * 100) / 100
      if (spiked) action.spike = true // for the notify message — policy, not extra risk
    }
    out.action = Object.keys(action).length ? action : null
    return out
  }

  // FIXED mode (also the fallback when no ATR is available).
  if (!(Number(cfg.armProfitUsd) > 0) || out.newPeak < Number(cfg.armProfitUsd)) return out

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

/**
 * One keeper pass: broker-truth positions in scope → decide → act through
 * the exec engine. Never throws; returns a summary.
 */
export function runProfitKeeper(db, creds, deps = {}) {
  return singleFlight('profit_keeper', () => profitKeeperPass(db, creds, deps))
}

async function profitKeeperPass(db, creds, deps = {}) {
  const summary = { checked: 0, slMoves: 0, closes: 0, scaleOuts: 0, refused: 0, errors: [] }
  try {
    const cfg = loadProfitKeeperConfig(db)
    if (!cfg.on) return summary

    const accountId = authorisedAccountId(creds)
    const scopeSql = cfg.scope === 'all'
      ? "mp.source IS NULL OR mp.source IN ('autopilot', 'external', 'manual')"
      : "mp.source IN ('external', 'manual')"
    const rows = db.prepare(
      `SELECT mp.id, mp.symbol, mp.side, mp.entry_price, mp.current_sl, mp.peak_profit_usd,
              mp.scaled_out, mp.trade_id, mp.account_id, t.ctrader_position_id AS position_id
       FROM monitored_positions mp
       JOIN trades t ON t.id = mp.trade_id
       WHERE mp.status = 'active' AND mp.guard_json IS NULL
         AND (mp.keeper_opt_out IS NULL OR mp.keeper_opt_out != 1)
         AND t.ctrader_position_id IS NOT NULL AND (${scopeSql})
         AND ${accountFilterSql('mp.account_id')}`
    ).all(accountId)
    if (rows.length === 0) return summary

    const exec = deps.exec ?? await import('../lib/exec-engine.js')
    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const sizing = deps.sizing ?? await import('../lib/lot-sizing.js')
    const notify = deps.notify ?? (() => {})
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

    const scoped = scopeToAccount(rows, { accountId, live })
    summary.refused = scoped.foreign.length
    if (scoped.foreign.length) {
      summary.errors.push(`${scoped.foreign.length} position(s) belong to another account and were not touched`)
    }
    const involved = scoped.owned
      .map(r => ({ r, bp: live.get(String(r.position_id)) }))
      .filter(x => x.bp)
    const symbolIds = [...new Set(involved.map(x => x.bp.tradeData?.symbolId).filter(Boolean))]
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
    if (cfg.mode === 'adaptive') {
      const stale = []
      for (const id of symbolIds) {
        const hit = readAtrCache(id, cfg.atrTimeframe)
        if (hit) { atrBySymbolId[id] = hit.atr; barsBySymbolId[id] = hit.bars; continue }
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
            // Only a REAL answer is cached. Caching a failed fetch would make
            // one bad round-trip suppress retries for a whole bar, and the
            // fallback (fixed thresholds) is looser than the adaptive one.
            if (atr != null) writeAtrCache(id, cfg.atrTimeframe, { atr, bars: tail })
          } catch { atrBySymbolId[id] = null /* falls back to fixed thresholds */ }
        }))
      }
    }

    const updPeak = db.prepare('UPDATE monitored_positions SET peak_profit_usd = ? WHERE id = ?')
    const updAct = db.prepare(
      `UPDATE monitored_positions
       SET current_sl = COALESCE(?, current_sl), last_check_action = ?, last_check_at = datetime('now')
       WHERE id = ?`
    )
    const updScaled = db.prepare('UPDATE monitored_positions SET scaled_out = 1 WHERE id = ?')

    // Option 4: trail specs for the sidecar's tick-level ratchet, collected
    // as we decide. Pushed even when EMPTY — /trail-config is full-replace,
    // so an empty push clears positions that closed or disarmed.
    const trailSpecs = []

    for (const { r, bp } of involved) {
      const td = bp.tradeData || {}
      const price = prices[td.symbolId]
      if (price == null) continue
      let meta
      try {
        meta = await sizing.getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, td.symbolId)
      } catch (err) { summary.errors.push(`${r.symbol}: ${err.message}`); continue }
      summary.checked++

      const lots = td.volume && meta.lotSize ? td.volume / meta.lotSize : null
      const decision = decideProfitKeeper(cfg, {
        side: r.side,
        entry: bp.price ?? r.entry_price,
        price,
        lots,
        unitsPerLot: meta.lotSize / 100,
        symbol: r.symbol,
        peak: r.peak_profit_usd,
        currentSl: bp.stopLoss ?? r.current_sl,
        digits: meta.digits,
        atr: atrBySymbolId[td.symbolId] ?? null,
        balance,
        scaledOut: !!r.scaled_out,
        bars: barsBySymbolId[td.symbolId] ?? null,
      })
      if (decision.newPeak !== (r.peak_profit_usd || 0)) updPeak.run(decision.newPeak, r.id)
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
            digits: meta.digits,
          })
        }
      }
      if (!decision.action) continue

      if (decision.action.close) {
        try {
          await exec.closePosition(creds, { positionId: parseInt(r.position_id), volume: td.volume })
          updAct.run(null, 'profit_keeper_close', r.id)
          summary.closes++
          notify(`💰 Profit Keeper closed ${r.symbol} (${r.side}) at ~${price}: ${decision.action.reason}`)
          recordPositionEvent(db, {
            accountId: r.account_id, positionId: r.position_id, tradeId: r.trade_id,
            symbol: r.symbol, kind: 'close', priceAt: price,
            reason: decision.action.reason, source: 'profit_keeper',
          })
        } catch (err) { summary.errors.push(`${r.symbol} close: ${err.message}`) }
        continue
      }
      if (decision.action.scaleOutFrac) {
        const vol = Math.round(td.volume * decision.action.scaleOutFrac)
        if (meta.minVolume == null || vol >= meta.minVolume) {
          try {
            await exec.closePosition(creds, { positionId: parseInt(r.position_id), volume: vol })
            updScaled.run(r.id)
            updAct.run(null, 'profit_keeper_scaleout', r.id)
            summary.scaleOuts++
            notify(`💰 Profit Keeper banked ${Math.round(decision.action.scaleOutFrac * 100)}% of ${r.symbol} at ~${price} — the rest runs with the trail`)
            recordPositionEvent(db, {
              accountId: r.account_id, positionId: r.position_id, tradeId: r.trade_id,
              symbol: r.symbol, kind: 'scale_out', toValue: vol, priceAt: price,
              reason: `scaleOutFrac ${decision.action.scaleOutFrac}`, source: 'profit_keeper',
            })
          } catch (err) { summary.errors.push(`${r.symbol} scale-out: ${err.message}`) }
        }
      }
      if (decision.action.sl != null) {
        try {
          await exec.amendPosition(creds, { positionId: parseInt(r.position_id), stopLoss: decision.action.sl })
          updAct.run(decision.action.sl, 'profit_keeper_lock', r.id)
          summary.slMoves++
          notify(`🔒 Profit Keeper: ${r.symbol} SL ratcheted to ${decision.action.sl}${decision.action.lockUsd != null ? ` (locks ~$${decision.action.lockUsd})` : ''}${decision.action.spike ? ' — spike detected, trail tightened' : ''}`)
          recordPositionEvent(db, {
            accountId: r.account_id, positionId: r.position_id, tradeId: r.trade_id,
            symbol: r.symbol, kind: 'sl_moved',
            fromValue: bp.stopLoss ?? r.current_sl ?? null, toValue: decision.action.sl,
            priceAt: price, reason: decision.action.spike ? 'spike_tighten' : 'chandelier_ratchet',
            source: 'profit_keeper',
          })
        } catch (err) {
          summary.errors.push(`${r.symbol} SL: ${err.message}`)
          // Broker refused the stop (too close to market?) — retried next
          // cycle; the breach/giveback close paths handle the retraced case.
        }
      }
    }

    // Hand the armed set to the C++ tick ratchet (best-effort by contract).
    try {
      summary.trailPushed = exec.pushTrailConfig && await exec.pushTrailConfig(creds, trailSpecs) ? trailSpecs.length : null
    } catch { summary.trailPushed = null }

    // P10: read back what the sidecar actually ratcheted to and journal any
    // change since the last pass. Best-effort — getTrailStatus never throws
    // (returns {enabled:false} on any failure) and a diff miss just means the
    // next pass catches it.
    try {
      if (exec.getTrailStatus) {
        const byPositionId = new Map(involved.map(x => [String(x.r.position_id), x.r]))
        const status = await exec.getTrailStatus(creds)
        if (status?.enabled && Array.isArray(status.positions)) {
          for (const p of status.positions) {
            if (p?.positionId == null || !(p.lastSl > 0)) continue
            const key = String(p.positionId)
            const prev = lastSeenTrailSl.get(key)
            lastSeenTrailSl.set(key, p.lastSl)
            if (prev === p.lastSl) continue // unchanged since the last pass — nothing to journal
            const r = byPositionId.get(key)
            if (!r) continue
            recordPositionEvent(db, {
              accountId: r.account_id, positionId: key, tradeId: r.trade_id, symbol: r.symbol,
              kind: 'trail_tightened', fromValue: prev, toValue: p.lastSl,
              source: 'cpp_trail_engine',
            })
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
  }
  return summary
}
