// ---------------------------------------------------------------------------
// agent/services/loss-guardian.js — the loss-side mirror of profit-keeper.
//
// Owner (AUDUSD down $200, unmanaged 10h): "shouldn't you be mindful." A
// LOSING position is never touched by the Profit-Keeper (it only protects
// gains), and a MANUAL position is observe-only — so a naked manual loser can
// ride with nothing bounding the worst case. This guardian closes that gap.
//
// It is deliberately CONSERVATIVE, because the armed edge is mean-reversion:
// those setups EXPECT to go underwater before the bounce, so cutting a red
// position early would destroy the edge. The guardian therefore does NOT
// tighten a position that already has a stop — it only:
//
//   1. PROTECTS a naked position (no stop-loss) — places a broker stop a
//      generous maxAtrMult×ATR from entry (fallbackAdversePct of price if ATR
//      is unavailable). If price has ALREADY blown past where that stop would
//      sit, the max tolerable loss is already exceeded → close at market.
//   2. Enforces an optional hard TIME CAP (maxHoldHours) for positions that
//      carry no time cap of their own — no idea sits unmanaged forever.
//
// It never widens risk, never moves an existing stop, and honours the same
// owner overrides as the keeper (guard_json, keeper_opt_out). Every action
// goes through the exec engine and lands in action_log + Telegram.
// ---------------------------------------------------------------------------

import { loadWithOverlay } from './account-overlay.js'
import { roundToDigits } from './trade-guard.js'

export const DEFAULT_LOSS_GUARDIAN = {
  on: true,                 // safety net on by default — no naked losers
  scope: 'all',             // 'all' = bot + manual/external · 'external' = manual only
  atrTimeframe: '1h',
  atrPeriod: 14,
  maxAtrMult: 3,            // protective stop distance for a NAKED position (wide — mean-reversion room)
  fallbackAdversePct: 0.02, // if ATR is unavailable, cap adverse at 2% of entry price
  maxHoldHours: null,       // optional hard time cap for positions without one (null = off)
}

export const LOSS_GUARDIAN_KEY = 'loss_guardian_json'

/**
 * @param {string|number|null} accountId  null = the shared config; an id
 *   returns it with THAT account's overlay merged on top (partial).
 */
export function loadLossGuardianConfig(db, accountId = null) {
  return loadWithOverlay(db, DEFAULT_LOSS_GUARDIAN, LOSS_GUARDIAN_KEY, accountId)
}

/**
 * decideLossGuardian(cfg, ctx) → { action, reason } | { action: null }
 * Pure. ctx: { side, entry, price, currentSl, atr, digits, ageHours,
 *              hasOwnTimeCap }.
 *   · time cap breached (and no own time_cap_at) → close
 *   · naked & price past the cap  → close (max loss already exceeded)
 *   · naked & still inside        → place protective stop
 *   · has a stop / inside cap      → HOLD (never touch a valid mean-rev stop)
 */
export function decideLossGuardian(cfg, ctx) {
  const { side, entry, price, currentSl, atr, digits, ageHours, hasOwnTimeCap } = ctx
  const long = String(side).toUpperCase() === 'BUY'

  // 1) Hard time cap — but ONLY for positions carrying no time cap of their
  // own (hardening 6d). The header always promised this; the code never
  // checked it, so both mechanisms ran at once and the guardian's blunt
  // maxHoldHours could close a position hours before the position-manager's
  // per-setup time_cap_at (the authoritative cap, sized to the setup's own
  // timeframe) would have. A position with time_cap_at set is the
  // position-manager's to time out; the guardian defers.
  if (!hasOwnTimeCap
    && cfg.maxHoldHours != null && Number.isFinite(ageHours) && ageHours >= cfg.maxHoldHours) {
    return { action: { close: true }, reason: `time_cap ${ageHours.toFixed(1)}h ≥ ${cfg.maxHoldHours}h` }
  }

  // 2) Only NAKED positions get a protective stop — never touch an existing one.
  if (currentSl != null) return { action: null }
  if (entry == null || price == null) return { action: null }

  const dist = (Number.isFinite(atr) && atr > 0)
    ? cfg.maxAtrMult * atr
    : cfg.fallbackAdversePct * entry
  if (!(dist > 0)) return { action: null }

  const level = long ? entry - dist : entry + dist
  // Already blown past where the protective stop would sit → the max tolerable
  // loss is already exceeded; don't set a stop the broker would reject, close.
  const past = long ? price <= level : price >= level
  if (past) {
    return { action: { close: true }, reason: `naked position already beyond max loss (${cfg.maxAtrMult}×ATR)` }
  }
  const sl = roundToDigits(level, digits)
  return { action: { sl }, reason: `protective stop on a naked position (${cfg.maxAtrMult}×ATR from entry)` }
}

function atrFromBars(bars, period) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null
  let sum = 0
  for (let i = bars.length - period; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc))
  }
  return sum / period
}

/**
 * One guardian pass: broker-truth positions in scope → decide → act through
 * the exec engine. Never throws; returns a summary.
 */
export async function runLossGuardian(db, creds, deps = {}) {
  const summary = { checked: 0, stops: 0, closes: 0, errors: [] }
  try {
    // PER-ACCOUNT CONFIG (04-08-2026). `scope` and the on switch used to come
    // from one shared key and were baked into the SQL, so one account could
    // not guard external-only while another guarded everything.
    //
    // The query now fetches the WIDEST candidate set — every naked-eligible
    // position with its account — and each row is judged against ITS OWN
    // account's config below. A row whose account has the guardian off, or
    // whose scope excludes its source, is dropped there.
    const cfgCache = new Map()
    const cfgFor = (accountId) => {
      const k = accountId == null ? '' : String(accountId)
      if (!cfgCache.has(k)) cfgCache.set(k, loadLossGuardianConfig(db, k || null))
      return cfgCache.get(k)
    }
    const allRows = db.prepare(
      `SELECT mp.id, mp.symbol, mp.side, mp.entry_price, mp.current_sl,
              mp.time_cap_at, mp.source AS source,
              t.ctrader_position_id AS position_id, t.account_id AS account_id
       FROM monitored_positions mp
       JOIN trades t ON t.id = mp.trade_id
       WHERE mp.status = 'active' AND mp.guard_json IS NULL
         AND (mp.keeper_opt_out IS NULL OR mp.keeper_opt_out != 1)
         AND t.ctrader_position_id IS NOT NULL
         AND (mp.source IS NULL OR mp.source IN ('autopilot', 'external', 'manual'))`
    ).all()
    const rows = allRows.filter(r => {
      const c = cfgFor(r.account_id)
      if (!c.on) return false
      // 'external' scope guards only positions this bot did not open. An
      // UNSTAMPED source is treated as bot-owned, which is the conservative
      // read: it keeps the narrower scope narrow.
      if (c.scope !== 'all') return r.source === 'external' || r.source === 'manual'
      return true
    })
    if (rows.length === 0) return summary

    const exec = deps.exec ?? await import('../lib/exec-engine.js')
    const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
    const sizing = deps.sizing ?? await import('../lib/lot-sizing.js')
    const notify = deps.notify ?? (() => {})
    const nowMs = deps.now ?? Date.now()

    const rec = await exec.reconcile(creds)
    const live = new Map()
    for (const p of (rec.position || [])) {
      if (p.positionId != null) live.set(String(p.positionId), p)
    }

    const involved = rows
      .map(r => ({ r, bp: live.get(String(r.position_id)) }))
      .filter(x => x.bp)
    const symbolIds = [...new Set(involved.map(x => x.bp.tradeData?.symbolId).filter(Boolean))]
    if (symbolIds.length === 0) return summary
    const prices = await ws.wsGetLastCloses(
      creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, symbolIds
    )

    // ATR per symbol — only needed to size a protective stop for a naked position.
    // ATR per symbol AND per (timeframe, period) — those two are config, and
    // config is now per account, so two accounts holding the same symbol with
    // different ATR settings must not share one cached number. Keyed by the
    // parameters that actually determine the value.
    const atrCache = new Map()
    const atrKey = (symbolId, c) => `${symbolId}|${c.atrTimeframe}|${c.atrPeriod}`
    const naked = involved.filter(x => (x.bp.stopLoss ?? x.r.current_sl) == null)
    for (const x of naked) {
      const id = x.bp.tradeData?.symbolId
      if (!id) continue
      const c = cfgFor(x.r.account_id)
      const key = atrKey(id, c)
      if (atrCache.has(key)) continue
      try {
        const bars = await ws.wsGetTrendbarsBatch(
          creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId,
          id, [c.atrTimeframe], Math.max(c.atrPeriod * 3, 50)
        )
        atrCache.set(key, atrFromBars(bars?.[c.atrTimeframe] || [], c.atrPeriod))
      } catch { atrCache.set(key, null) }
    }

    const updAct = db.prepare(
      `UPDATE monitored_positions
       SET current_sl = COALESCE(?, current_sl), last_check_action = ?, last_check_at = datetime('now')
       WHERE id = ?`
    )

    for (const { r, bp } of involved) {
      const td = bp.tradeData || {}
      const price = prices[td.symbolId]
      if (price == null) continue
      let meta
      try {
        meta = await sizing.getVolumeMeta(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId, td.symbolId)
      } catch (err) { summary.errors.push(`${r.symbol}: ${err.message}`); continue }
      summary.checked++

      const openMs = td.openTimestamp ? Number(td.openTimestamp) : null
      const ageHours = openMs != null ? (nowMs - openMs) / 3_600_000 : null
      // THIS position's account decides: stop distance, fallback and time cap.
      const rowCfg = cfgFor(r.account_id)
      const decision = decideLossGuardian(rowCfg, {
        side: r.side,
        entry: bp.price ?? r.entry_price,
        price,
        currentSl: bp.stopLoss ?? r.current_sl,
        atr: atrCache.get(atrKey(td.symbolId, rowCfg)) ?? null,
        digits: meta.digits,
        ageHours,
        hasOwnTimeCap: r.time_cap_at != null,
      })
      if (!decision.action) continue

      if (decision.action.close) {
        try {
          await exec.closePosition(creds, { positionId: parseInt(r.position_id), volume: td.volume })
          updAct.run(null, 'loss_guardian_close', r.id)
          summary.closes++
          notify(`🛟 Loss Guardian closed ${r.symbol} (${r.side}) at ~${price}: ${decision.reason}`)
        } catch (err) { summary.errors.push(`${r.symbol} close: ${err.message}`) }
        continue
      }
      if (decision.action.sl != null) {
        try {
          await exec.amendPosition(creds, { positionId: parseInt(r.position_id), stopLoss: decision.action.sl })
          updAct.run(decision.action.sl, 'loss_guardian_stop', r.id)
          summary.stops++
          notify(`🛟 Loss Guardian: ${r.symbol} had NO stop — protective SL set at ${decision.action.sl} (${decision.reason})`)
        } catch (err) { summary.errors.push(`${r.symbol} SL: ${err.message}`) }
      }
    }

    if (summary.stops || summary.closes) {
      try {
        db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
          .run('GUARDIAN', '/loss-guardian', JSON.stringify(summary).slice(0, 2000))
      } catch { /* action_log appears after first boot */ }
    }
  } catch (err) {
    summary.errors.push(err.message)
  }
  return summary
}
