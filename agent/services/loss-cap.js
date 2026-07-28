// ---------------------------------------------------------------------------
// agent/services/loss-cap.js — hard per-position loss cap in ACCOUNT DOLLARS
// (owner, 2026-07-28, after a GOOGL long ran to −$900 untouched: "I was
// unhappy ... you didn't do anything to prevent lost earlier").
//
// The audit that followed found NO layer closes a position on its floating
// dollar loss: entry sizing caps the PLANNED risk, the loss guardian ignores
// any position that already has a broker stop (however far away), pnl-watch
// only messages Telegram, the equity stop counts only REALIZED P&L, and the
// profit keeper never touches losers. This service is that missing layer:
//
// - BROKER truth only: every open broker position (external/manual included
//   by default — the GOOGL case) against wsGetUnrealizedPnl's net $.
// - Two caps, BOTH kept (owner: "don't remove percentage loss-cap"):
//   `maxLossUsd` absolute and `maxLossPctOfBalance` — whichever is TIGHTER
//   applies; either can be null to disable it.
// - On breach: close at market through the exec engine (or alert-only when
//   `action: 'alert'`), Telegram + position_events record either way.
// - Runs from the fast-monitor tick (~60s cadence, same as pnl-watch), so a
//   breach acts within about a minute — not at the next 5-minute loop.
//
// Config: agent_state `loss_cap_json` over DEFAULT_LOSS_CAP.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { getAccountBalance } from './risk.js'

export const DEFAULT_LOSS_CAP = {
  on: true,
  maxLossUsd: null,          // absolute $ floor per position; null = this cap off
  maxLossPctOfBalance: 2,    // % of balance per position (2% of $48k ≈ $960 — would have caught the GOOGL −$900); null = off
  scope: 'all',              // 'all' = every broker position · 'bot' = ledger positions only
  action: 'close',           // 'close' = flatten the breaching position · 'alert' = Telegram only
  retryMinutes: 10,          // re-attempt a failed/ignored breach after this long
}

export function loadLossCapConfig(db) {
  try {
    const saved = JSON.parse(getState(db, 'loss_cap_json') || 'null')
    return { ...DEFAULT_LOSS_CAP, ...(saved || {}) }
  } catch {
    return { ...DEFAULT_LOSS_CAP }
  }
}

/**
 * Pure: the effective dollar cap for one position — the TIGHTER of the two
 * configured caps, or null when both are off/unusable. balance may be null
 * (then only the absolute cap can apply — the % cap never guesses).
 */
export function effectiveCapUsd(cfg, balance) {
  const caps = []
  const usd = Number(cfg.maxLossUsd)
  if (cfg.maxLossUsd != null && Number.isFinite(usd) && usd > 0) caps.push(usd)
  const pct = Number(cfg.maxLossPctOfBalance)
  if (cfg.maxLossPctOfBalance != null && Number.isFinite(pct) && pct > 0 && balance > 0) {
    caps.push(balance * (pct / 100))
  }
  return caps.length ? Math.min(...caps) : null
}

/**
 * One sweep. Deps injectable for tests: { exec, ws, notify, now }.
 * Returns { checked, breaches, closes, errors: [] }.
 */
export async function runLossCap(db, creds, deps = {}) {
  const out = { checked: 0, breaches: 0, closes: 0, errors: [] }
  const cfg = loadLossCapConfig(db)
  if (!cfg.on || !creds?.ready) return out
  const balance = getAccountBalance(db)
  const cap = effectiveCapUsd(cfg, balance)
  if (cap == null) return out

  const exec = deps.exec ?? await import('../lib/exec-engine.js')
  const ws = deps.ws ?? await import('../lib/ctrader-ws.js')
  const notify = deps.notify ?? (async (text) => {
    try { const { sendMessage } = await import('./telegram.js') ; await sendMessage(text) } catch { /* non-fatal */ }
  })
  const nowMs = deps.now ?? Date.now()

  const [rec, pnlMap] = await Promise.all([
    exec.reconcile(creds),
    ws.wsGetUnrealizedPnl(creds.host, creds.clientId, creds.clientSecret, creds.accessToken, creds.accountId),
  ])
  const positions = rec?.position || []
  if (!positions.length) return out

  // symbolId → name for readable alerts; ledger set for scope 'bot'.
  let idToSymbol = {}
  try {
    const map = JSON.parse(getState(db, 'symbol_id_map') || '{}')
    idToSymbol = Object.fromEntries(Object.entries(map).map(([sym, id]) => [String(id), sym]))
  } catch { /* names degrade to ids */ }
  const ledgerPids = new Set(
    db.prepare(
      `SELECT t.ctrader_position_id AS pid FROM monitored_positions m
        JOIN trades t ON t.id = m.trade_id
       WHERE m.status = 'active' AND t.ctrader_position_id IS NOT NULL`
    ).all().map(r => String(r.pid))
  )

  for (const bp of positions) {
    const pid = bp.positionId != null ? String(bp.positionId) : null
    if (!pid) continue
    if (cfg.scope === 'bot' && !ledgerPids.has(pid)) continue
    const net = pnlMap?.[pid]?.net
    if (!Number.isFinite(net)) continue
    out.checked++
    if (net > -cap) continue

    out.breaches++
    // Once-per-breach with a bounded retry: a close that failed (or an
    // alert-only breach) re-fires after retryMinutes, never every minute.
    const key = `loss_cap_fired_${pid}`
    const lastMs = Number(getState(db, key)) || 0
    if (nowMs - lastMs < Math.max(1, Number(cfg.retryMinutes) || 10) * 60_000) continue
    setState(db, key, String(nowMs))

    const td = bp.tradeData || {}
    const symbol = idToSymbol[String(td.symbolId)] || `symbolId ${td.symbolId}`
    const side = td.tradeSide || ''
    const capNote = `cap $${cap.toFixed(2)}${cfg.maxLossPctOfBalance != null ? ` (${cfg.maxLossPctOfBalance}% of balance / $${cfg.maxLossUsd ?? '—'})` : ''}`

    if (cfg.action !== 'close') {
      await notify(`⛔ Loss cap BREACHED (alert-only mode): ${symbol} ${side} floating −$${Math.abs(net).toFixed(2)} ≥ ${capNote}. Set loss_cap action to 'close' to auto-flatten.`)
      continue
    }
    try {
      await exec.closePosition(creds, { positionId: parseInt(pid), volume: td.volume })
      out.closes++
      try {
        const { recordPositionEvent } = await import('./position-events.js')
        recordPositionEvent(db, {
          positionId: pid, symbol, kind: 'loss_cap_close',
          toValue: net, reason: `floating loss $${Math.abs(net).toFixed(2)} breached ${capNote}`,
          source: 'loss_cap',
        })
      } catch { /* visibility only */ }
      await notify(`⛔ Loss cap: CLOSED ${symbol} ${side} at −$${Math.abs(net).toFixed(2)} floating loss — breached ${capNote}. (Per-position hard stop in account dollars; tune in loss_cap_json / Risk page.)`)
    } catch (err) {
      out.errors.push(`${symbol}: ${err.message}`)
      await notify(`⛔ Loss cap: FAILED to close ${symbol} ${side} at −$${Math.abs(net).toFixed(2)} (${err.message}) — will retry in ${cfg.retryMinutes} min. Check the position manually.`)
    }
  }
  return out
}
