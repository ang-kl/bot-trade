// ---------------------------------------------------------------------------
// agent/services/profit-ratchet.js — equity high-water ratchet (owner-approved
// A4, 2026-07-28: "we cannot keep win and loss and hover around the same
// balance ... have a buffer to 'keep profit margin' like every $500 min. /
// 1% min. move up the balance").
//
// The staircase: track the account's equity high-water mark (balance +
// broker-truth floating P&L). Every time it climbs one STEP above the
// baseline, the PROTECTED FLOOR moves up one step — and never moves down.
// Equity touching the floor triggers the floor action ONCE: entries halt
// (autotrade disarmed) and, in 'flatten' mode (the default, per the § 1,791·E
// proposal), open BOT positions are closed to lock the banked profit in.
// After a trigger the staircase re-baselines at current equity, so it never
// fires repeatedly — and re-arming autotrade is deliberately the owner's
// manual decision, announced in the Telegram alert.
//
// Step sizing (owner: "formulated by the account balance as some as low as
// $300 should be careful"): fixed `stepUsd` when set, otherwise AUTO =
// 1% of balance clamped to [$25, $500] — $500 steps at the current ~$48k,
// ~$25 steps on a $300 account.
//
// Config: agent_state `profit_ratchet_json` over DEFAULT_PROFIT_RATCHET.
// State:  agent_state `profit_ratchet_state_json` { baseline, hwm, floor,
//         startedAt, lastTriggerAt } — survives restarts; visible to the
//         Risk page (A2 will render the staircase).
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { getAccountBalance } from './risk.js'

export const DEFAULT_PROFIT_RATCHET = {
  on: true,
  stepUsd: null,          // fixed step $; null = auto (1% of balance, clamped 25..500)
  floorAction: 'flatten', // 'flatten' = close BOT positions + disarm autotrade · 'halt' = disarm autotrade only
}

export function loadProfitRatchetConfig(db) {
  try {
    const saved = JSON.parse(getState(db, 'profit_ratchet_json') || 'null')
    return { ...DEFAULT_PROFIT_RATCHET, ...(saved || {}) }
  } catch {
    return { ...DEFAULT_PROFIT_RATCHET }
  }
}

/** Pure: the auto step for a balance — 1% clamped to [$25, $500]. */
export function autoStepUsd(balance) {
  if (!(balance > 0)) return null
  return Math.min(500, Math.max(25, balance * 0.01))
}

/**
 * Pure: the protected floor for a (baseline, hwm, step) staircase.
 * null until the FIRST full step is banked (a dip below the enable-time
 * equity is normal trading, not a give-back); after N banked steps the
 * floor sits one step below the highest banked level:
 *   baseline 48,000, step 500 → hwm 48,500 banks step 1, floor 48,000;
 *   hwm 49,020 banks step 2, floor 48,500. Never moves down.
 */
export function computeFloor(baseline, hwm, step) {
  if (!(step > 0) || !Number.isFinite(baseline) || !Number.isFinite(hwm)) return null
  const steps = Math.floor((hwm - baseline) / step)
  if (steps < 1) return null
  return baseline + (steps - 1) * step
}

/**
 * The live staircase — { baseline, hwm, floor, startedAt, lastTriggerAt } or
 * null before the first run. Exported for GET /state/profit-ratchet: when
 * autotrade disarms itself with no manual action and no PERF_BREAKER row, the
 * ratchet is the prime suspect and there was previously no way to look at it
 * without opening the database (owner, serial 1,807).
 */
export function loadRatchetState(db) {
  try { return JSON.parse(getState(db, 'profit_ratchet_state_json') || 'null') } catch { return null }
}
function saveRatchetState(db, st) {
  setState(db, 'profit_ratchet_state_json', JSON.stringify(st))
}

/**
 * One pass (fast-monitor 60s cadence). Deps injectable: { exec, ws, notify, now }.
 * Returns { equity, hwm, floor, triggered, closes, errors: [] } (or {skipped}).
 */
export async function runProfitRatchet(db, creds, deps = {}) {
  const cfg = loadProfitRatchetConfig(db)
  if (!cfg.on || !creds?.ready) return { skipped: 'off_or_no_creds' }
  const balance = getAccountBalance(db)
  if (!(balance > 0)) return { skipped: 'no_balance' }

  const exec = deps.exec ?? await import('../lib/exec-engine.js')
  const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
  const notify = deps.notify ?? (async (text) => {
    try { const { sendMessage } = await import('./telegram.js'); await sendMessage(text) } catch { /* non-fatal */ }
  })
  const nowMs = deps.now ?? Date.now()

  // Equity = stamped balance + broker-truth floating P&L across all positions.
  let floating = 0
  try {
    const pnlMap = await ws.wsGetUnrealizedPnl(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)
    for (const v of Object.values(pnlMap || {})) if (Number.isFinite(v?.net)) floating += v.net
  } catch { /* no read → treat as flat rather than skip: the floor must not go blind on a P&L hiccup */ }
  const equity = Number((balance + floating).toFixed(2))

  const step = cfg.stepUsd != null && Number(cfg.stepUsd) > 0 ? Number(cfg.stepUsd) : autoStepUsd(balance)
  if (!(step > 0)) return { skipped: 'no_step' }

  let st = loadRatchetState(db)
  if (!st || !Number.isFinite(st.baseline)) {
    st = { baseline: equity, hwm: equity, floor: null, startedAt: new Date(nowMs).toISOString(), lastTriggerAt: null }
  }
  if (equity > st.hwm) st.hwm = equity
  const prevFloor = st.floor
  const floor = computeFloor(st.baseline, st.hwm, step)
  st.floor = floor != null && (prevFloor == null || floor > prevFloor) ? floor : prevFloor // never down
  if (st.floor != null && st.floor !== prevFloor) {
    await notify(`🪜 Profit ratchet: floor moved UP to $${st.floor.toFixed(2)} (high-water $${st.hwm.toFixed(2)}, step $${step.toFixed(0)}). Banked gains below this level are now protected.`)
  }

  const out = { equity, hwm: st.hwm, floor: st.floor, triggered: false, closes: 0, errors: [] }

  if (st.floor != null && equity <= st.floor) {
    out.triggered = true
    st.lastTriggerAt = new Date(nowMs).toISOString()

    // Entries off — same disarm the equity stop uses; re-arming is manual.
    setState(db, 'autotrade_enabled', 'false')

    if (cfg.floorAction === 'flatten') {
      const rows = db.prepare(
        `SELECT t.ctrader_position_id AS pid, m.symbol AS symbol
           FROM monitored_positions m JOIN trades t ON t.id = m.trade_id
          WHERE m.status = 'active' AND t.ctrader_position_id IS NOT NULL
            AND (m.source IS NULL OR m.source = 'autopilot')`
      ).all()
      let brokerVol = {}
      try {
        const rec = await exec.reconcile(creds)
        brokerVol = Object.fromEntries((rec.position || []).map(p => [String(p.positionId), p.tradeData?.volume]))
      } catch { /* volume unknown → still attempt close without it */ }
      for (const r of rows) {
        try {
          await exec.closePosition(creds, { positionId: parseInt(r.pid), volume: brokerVol[String(r.pid)] })
          out.closes++
        } catch (err) {
          out.errors.push(`${r.symbol}: ${err.message}`)
        }
      }
    }

    await notify(
      `🪜⛔ Profit ratchet TRIGGERED: equity $${equity.toFixed(2)} touched the protected floor $${st.floor.toFixed(2)}. ` +
      (cfg.floorAction === 'flatten'
        ? `Closed ${out.closes} bot position(s)${out.errors.length ? ` (${out.errors.length} failed — check manually)` : ''} and disarmed autotrade. `
        : 'Autotrade disarmed (entries halted); open positions left to their SL/TP. ') +
      'The staircase re-baselines here; re-arm autotrade from the app or /resume when ready.'
    )

    // Restart the staircase from what was actually kept.
    st = { baseline: equity, hwm: equity, floor: null, startedAt: new Date(nowMs).toISOString(), lastTriggerAt: st.lastTriggerAt }
  }

  saveRatchetState(db, st)
  return out
}
