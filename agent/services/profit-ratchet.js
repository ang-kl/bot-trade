// ---------------------------------------------------------------------------
// agent/services/profit-ratchet.js — equity high-water ratchet, v2.
//
// v1 (owner-approved A4, 2026-07-28) protected banked profit by disarming the
// MASTER autotrade switch and flattening when equity touched the floor. On
// 2026-08-01 06:39 UTC it did exactly that off ONE 60-second equity read
// during a weekend crypto drift — and because master-off vetoes every
// account's switch, the owner found the whole bot dark ("each time i change
// browser or return - autotrade is off"). v2 keeps the staircase idea and
// removes every one of those failure modes (owner: "can it better than
// this?", then "build v2"):
//
//   1. PER-ACCOUNT staircases. Each enabled account tracks its own
//      baseline/high-water/floor from its OWN equity (M1c balance seam +
//      per-account P&L read). A trip halts and flattens THAT account only.
//   2. NEVER touches the S.A.T. keys. The halt lives in its own state key
//      (acct:<id>:ratchet_halt) enforced at the dispatch gate — the owner's
//      switches stay exactly as the owner set them, per the ironclad rule.
//   3. TWO STAGES. At floor + softFraction·step: one warning, new entries
//      pause (acct:<id>:ratchet_soft), nothing is closed. Only at the floor
//      itself does the hard action fire.
//   4. HYSTERESIS. The hard trigger needs `confirmReads` CONSECUTIVE
//      breaching reads (~3 minutes at the 60s cadence) — one bad mark or a
//      spread spike cannot flatten a book.
//   5. AUTO RE-ARM. After a trip, equity holding above haltFloor +
//      softFraction·step for rearmHoldMin minutes clears the halt
//      automatically (announced) — unless the owner tapped [Keep off].
//
// Config: agent_state `profit_ratchet_json` over DEFAULT_PROFIT_RATCHET.
// State:  agent_state `acct:<id>:profit_ratchet_state_json` per account —
//         { baseline, hwm, floor, startedAt, lastTriggerAt, breachStreak,
//           softAlertedFloor, halt, haltAt, haltFloor, keepOff, rearmSince,
//           lastEquity }. The v1 global `profit_ratchet_state_json` is left
//         in place, ignored — per-account staircases start fresh (floor null
//         until a step is banked, so migration cannot cause a trip).
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { getAccountBalance } from './risk.js'

export const DEFAULT_PROFIT_RATCHET = {
  on: true,
  stepUsd: null,          // fixed step $; null = auto (1% of balance, clamped 25..500)
  floorAction: 'flatten', // 'flatten' = close the account's BOT positions + halt entries · 'halt' = halt entries only
  softFraction: 0.5,      // stage-1 warning line: floor + softFraction·step
  confirmReads: 3,        // consecutive breaching reads before the hard action
  autoRearm: true,        // clear the halt automatically on sustained recovery
  rearmHoldMin: 15,       // minutes equity must hold above the recovery line
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
 * null until the FIRST full step is banked; after N banked steps the floor
 * sits one step below the highest banked level. Never moves down.
 */
export function computeFloor(baseline, hwm, step) {
  if (!(step > 0) || !Number.isFinite(baseline) || !Number.isFinite(hwm)) return null
  const steps = Math.floor((hwm - baseline) / step)
  if (steps < 1) return null
  return baseline + (steps - 1) * step
}

const stateKey = (accountId) => `acct:${accountId}:profit_ratchet_state_json`
export const haltKey = (accountId) => `acct:${accountId}:ratchet_halt`
export const softKey = (accountId) => `acct:${accountId}:ratchet_soft`

/** One account's staircase state, or null before its first run. */
export function loadRatchetState(db, accountId) {
  try { return JSON.parse(getState(db, stateKey(accountId)) || 'null') } catch { return null }
}
function saveRatchetState(db, accountId, st) {
  setState(db, stateKey(accountId), JSON.stringify(st))
}

/** Is this account's ratchet holding entries right now (either stage)? */
export function ratchetGate(db, accountId) {
  const halt = getState(db, haltKey(accountId)) === 'true'
  const soft = !halt && getState(db, softKey(accountId)) === 'true'
  return { blocked: halt || soft, stage: halt ? 'halt' : soft ? 'soft' : null }
}

/**
 * Owner action (Telegram [Re-arm] button or a future UI control): clear the
 * halt and the entry pause for one account, keeping the staircase state.
 */
export function rearmRatchet(db, accountId) {
  const st = loadRatchetState(db, accountId) || {}
  st.halt = false
  st.keepOff = false
  st.rearmSince = null
  saveRatchetState(db, accountId, st)
  setState(db, haltKey(accountId), 'false')
  setState(db, softKey(accountId), 'false')
  return { ok: true, accountId: String(accountId) }
}

/** Owner action ([Keep off]): stay halted; auto re-arm stops watching. */
export function keepRatchetOff(db, accountId) {
  const st = loadRatchetState(db, accountId) || {}
  st.keepOff = true
  st.rearmSince = null
  saveRatchetState(db, accountId, st)
  return { ok: true, accountId: String(accountId) }
}

/** The enabled accounts this pass covers; the creds account as fallback so a
 *  box with no registry rows (old single-account setups, most tests) still
 *  gets its one staircase. */
function accountsToWatch(db, creds) {
  try {
    const rows = db.prepare('SELECT account_id FROM accounts WHERE enabled = 1').all()
    if (rows.length) return rows.map(r => String(r.account_id))
  } catch { /* registry absent */ }
  return creds?.accountId != null ? [String(creds.accountId)] : []
}

/**
 * One pass over every enabled account (fast-monitor 60s cadence).
 * Deps injectable: { exec, ws, notify, now }.
 * Returns { accounts: [{accountId, equity, hwm, floor, stage, triggered,
 * rearmed, closes, errors}], skipped? }.
 */
export async function runProfitRatchet(db, creds, deps = {}) {
  const cfg = loadProfitRatchetConfig(db)
  if (!cfg.on || !creds?.ready) return { skipped: 'off_or_no_creds', accounts: [] }

  const exec = deps.exec ?? await import('../lib/exec-engine.js')
  const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
  const notify = deps.notify ?? (async (text, opts) => {
    try { const { sendMessage } = await import('./telegram.js'); await sendMessage(text, opts) } catch { /* non-fatal */ }
  })
  const nowMs = deps.now ?? Date.now()

  const out = { accounts: [] }
  for (const accountId of accountsToWatch(db, creds)) {
    try {
      const res = await ratchetOneAccount(db, { ...creds, accountId }, accountId, cfg, { exec, ws, notify, nowMs })
      if (res) out.accounts.push(res)
    } catch (err) {
      out.accounts.push({ accountId, error: err.message })
    }
  }
  return out
}

async function ratchetOneAccount(db, creds, accountId, cfg, { exec, ws, notify, nowMs }) {
  const balance = getAccountBalance(db, accountId)
  if (!(balance > 0)) return { accountId, skipped: 'no_balance' }

  // Equity = this account's stamped balance + ITS broker-truth floating P&L.
  let floating = 0
  try {
    const pnlMap = await ws.wsGetUnrealizedPnl(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId)
    for (const v of Object.values(pnlMap || {})) if (Number.isFinite(v?.net)) floating += v.net
  } catch { /* no read → treat as flat rather than skip: the floor must not go blind on a P&L hiccup */ }
  const equity = Number((balance + floating).toFixed(2))

  const step = cfg.stepUsd != null && Number(cfg.stepUsd) > 0 ? Number(cfg.stepUsd) : autoStepUsd(balance)
  if (!(step > 0)) return { accountId, skipped: 'no_step' }
  const softBand = cfg.softFraction * step
  const who = `account ${accountId}`

  let st = loadRatchetState(db, accountId)
  if (!st || !Number.isFinite(st.baseline)) {
    st = {
      baseline: equity, hwm: equity, floor: null,
      startedAt: new Date(nowMs).toISOString(), lastTriggerAt: null,
      breachStreak: 0, softAlertedFloor: null,
      halt: false, haltAt: null, haltFloor: null, keepOff: false, rearmSince: null,
    }
  }
  st.lastEquity = equity

  const res = { accountId, equity, stage: null, triggered: false, rearmed: false, closes: 0, errors: [] }

  // ------------------------------------------------------------------ HALTED
  if (st.halt) {
    res.stage = 'halt'
    // Auto re-arm (¶A·4): sustained recovery above haltFloor + softBand.
    const recoveryLine = (st.haltFloor ?? st.baseline) + softBand
    if (cfg.autoRearm && !st.keepOff && Number.isFinite(recoveryLine) && equity >= recoveryLine) {
      if (!st.rearmSince) st.rearmSince = nowMs
      if (nowMs - st.rearmSince >= cfg.rearmHoldMin * 60_000) {
        st.halt = false; st.rearmSince = null
        setState(db, haltKey(accountId), 'false')
        setState(db, softKey(accountId), 'false')
        res.rearmed = true; res.stage = null
        await notify(`🪜🔵 Profit ratchet re-armed on ${who}: equity $${equity.toFixed(2)} held above $${recoveryLine.toFixed(2)} for ${cfg.rearmHoldMin} min. Entries resume; the staircase continues from its new baseline.`)
      }
    } else {
      st.rearmSince = null
    }
    if (st.halt) { // still halted — track the staircase but take no action
      if (equity > st.hwm) st.hwm = equity
      saveRatchetState(db, accountId, st)
      res.hwm = st.hwm; res.floor = st.floor
      return res
    }
  }

  // ------------------------------------------------------- STAIRCASE ADVANCE
  if (equity > st.hwm) st.hwm = equity
  const prevFloor = st.floor
  const floor = computeFloor(st.baseline, st.hwm, step)
  st.floor = floor != null && (prevFloor == null || floor > prevFloor) ? floor : prevFloor // never down
  if (st.floor != null && st.floor !== prevFloor) {
    await notify(`🪜 Profit ratchet (${who}): floor moved UP to $${st.floor.toFixed(2)} (high-water $${st.hwm.toFixed(2)}, step $${step.toFixed(0)}). Banked gains below this level are now protected.`)
  }
  res.hwm = st.hwm; res.floor = st.floor

  if (st.floor == null) { // nothing banked yet — nothing to protect
    st.breachStreak = 0
    setState(db, softKey(accountId), 'false')
    saveRatchetState(db, accountId, st)
    return res
  }

  // ------------------------------------------------------------ STAGE 1: SOFT
  // Inside the warning band: pause NEW entries on this account, warn once per
  // floor level, close nothing. Fully reversible the moment equity recovers.
  if (equity > st.floor && equity <= st.floor + softBand) {
    res.stage = 'soft'
    st.breachStreak = 0
    setState(db, softKey(accountId), 'true')
    if (st.softAlertedFloor !== st.floor) {
      st.softAlertedFloor = st.floor
      await notify(`🪜⚠️ Profit ratchet warning (${who}): equity $${equity.toFixed(2)} is within $${softBand.toFixed(0)} of the protected floor $${st.floor.toFixed(2)}. New entries paused on this account; open positions untouched. Entries resume on their own if equity recovers above $${(st.floor + softBand).toFixed(2)}.`)
    }
    saveRatchetState(db, accountId, st)
    return res
  }

  // ------------------------------------------------------------ STAGE 2: HARD
  if (equity <= st.floor) {
    st.breachStreak = (st.breachStreak || 0) + 1
    if (st.breachStreak < cfg.confirmReads) {
      // Breaching but not yet confirmed (¶A·3) — entries stay paused.
      res.stage = 'confirming'
      setState(db, softKey(accountId), 'true')
      saveRatchetState(db, accountId, st)
      return res
    }

    // Confirmed. Halt THIS account and (flatten mode) close ITS bot positions.
    res.triggered = true
    res.stage = 'halt'
    const trippedFloor = st.floor
    st.lastTriggerAt = new Date(nowMs).toISOString()
    st.halt = true; st.haltAt = st.lastTriggerAt; st.haltFloor = trippedFloor
    st.keepOff = false; st.rearmSince = null
    setState(db, haltKey(accountId), 'true')
    setState(db, softKey(accountId), 'false')

    if (cfg.floorAction === 'flatten') {
      const rows = db.prepare(
        `SELECT t.ctrader_position_id AS pid, m.symbol AS symbol
           FROM monitored_positions m JOIN trades t ON t.id = m.trade_id
          WHERE m.status = 'active' AND t.ctrader_position_id IS NOT NULL
            AND (m.source IS NULL OR m.source = 'autopilot')
            AND m.account_id = ?`
      ).all(String(accountId))
      let brokerVol = {}
      try {
        const rec = await exec.reconcile(creds)
        brokerVol = Object.fromEntries((rec.position || []).map(p => [String(p.positionId), p.tradeData?.volume]))
      } catch { /* volume unknown → still attempt close without it */ }
      for (const r of rows) {
        try {
          await exec.closePosition(creds, { positionId: parseInt(r.pid), volume: brokerVol[String(r.pid)] })
          res.closes++
        } catch (err) {
          res.errors.push(`${r.symbol}: ${err.message}`)
        }
      }
    }

    await notify(
      `🪜⛔ Profit ratchet TRIGGERED on ${who}: equity $${equity.toFixed(2)} held at/below the protected floor $${trippedFloor.toFixed(2)} for ${cfg.confirmReads} consecutive reads. ` +
      (cfg.floorAction === 'flatten'
        ? `Closed ${res.closes} bot position(s) on this account${res.errors.length ? ` (${res.errors.length} failed — check manually)` : ''}. `
        : 'Entries halted on this account; open positions left to their SL/TP. ') +
      `Other accounts and your switches are untouched. ` +
      (DEFAULT_PROFIT_RATCHET.autoRearm && cfg.autoRearm
        ? `Auto re-arm when equity holds above $${(trippedFloor + softBand).toFixed(2)} for ${cfg.rearmHoldMin} min, or use the buttons.`
        : 'Re-arm with the button below when ready.'),
      { buttons: [[
        { text: `Re-arm ${accountId} now`, callback_data: `ratchetarm|${accountId}` },
        { text: 'Keep off', callback_data: `ratchetkeep|${accountId}` },
      ]] },
    )

    // Restart the staircase from what was actually kept.
    st.baseline = equity; st.hwm = equity; st.floor = null
    st.breachStreak = 0; st.softAlertedFloor = null
    st.startedAt = new Date(nowMs).toISOString()
    saveRatchetState(db, accountId, st)
    return res
  }

  // ---------------------------------------------------------------- ALL CLEAR
  st.breachStreak = 0
  setState(db, softKey(accountId), 'false')
  saveRatchetState(db, accountId, st)
  return res
}
