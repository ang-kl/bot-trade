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
  maxLossPctOfBalance: 1,    // % of balance per position (owner 2026-08-03: 1%); null = off
  // FLOOR under the % cap. 1% of a $1,440 account is $14.40 — tight enough
  // that ordinary noise closes everything, which is not a risk control, it is
  // an off switch with extra steps. The floor keeps the cap usable on small
  // accounts while the % keeps it proportionate on large ones. Owner set $50.
  minCapUsd: 50,
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
  if (!caps.length) return null
  const cap = Math.min(...caps)
  // The floor is applied LAST, after the tightest cap is chosen, so it lifts
  // whichever rule produced the number. It never LOWERS a cap — a floor that
  // could tighten would be a second, silent limit.
  const floor = Number(cfg.minCapUsd)
  if (cfg.minCapUsd != null && Number.isFinite(floor) && floor > 0) return Math.max(cap, floor)
  return cap
}

/**
 * One sweep. Deps injectable for tests: { exec, ws, notify, now }.
 * Returns { checked, breaches, closes, errors: [] }.
 */
export async function runLossCap(db, creds, deps = {}) {
  const out = { checked: 0, breaches: 0, closes: 0, errors: [] }
  const cfg = loadLossCapConfig(db)
  if (!cfg.on || !creds?.ready) return out
  // Per-account balance, not the global one: a 1% cap computed from the
  // SELECTED account's balance would be the wrong number for every other
  // account it is applied to.
  const balance = getAccountBalance(db, creds?.accountId ?? null)
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

/**
 * THE SWEEP, ACROSS EVERY ENABLED ACCOUNT.
 *
 * WHY THIS EXISTS. Owner, 2026-08-03, after a USDZAR position reached
 * −$2,186.29 against a configured, enabled, action:'close' cap of $800:
 * "no safety net to curb more than 1% losses".
 *
 * The cap was not off and was not misconfigured. It ran — for ONE account.
 * `runLossCap` takes `creds`, and creds carry a single `accountId` resolved
 * from `ctrader_account_id` (lib/ctrader-creds.js). `wsGetUnrealizedPnl` is
 * then asked about that one account. `scope: 'all'` means "every position ON
 * THAT ACCOUNT" — it reads like "every account" and is not.
 *
 * So every account except whichever happened to be selected ran with no
 * per-position loss cap at all. That is the gap M2 left behind: EXECUTION was
 * made multi-account (the sidecar receives a roster of every enabled account),
 * and the PROTECTIVE sweep was not. The profit ratchet beside it in
 * fast-monitor was reworked per-account on 01-08; this one was missed in the
 * same pass.
 *
 * Accounts are swept SEQUENTIALLY, not in parallel: each pass is a reconcile
 * plus an unrealized-P&L read, and firing them at once against one broker
 * connection is the 2026-07-28 throttling incident. One slow or failing
 * account must not stop the others, so each is caught individually and
 * reported — a sweep that dies on account 1 and silently skips 2..N would
 * recreate this bug in a new shape.
 *
 * @returns {{checked, breaches, closes, errors: string[], accounts: number}}
 */
export async function runLossCapAllAccounts(db, baseCreds, deps = {}) {
  const out = { checked: 0, breaches: 0, closes: 0, errors: [], accounts: 0 }
  if (!baseCreds?.ready) return out

  const { getEnabledAccounts } = await import('./account-registry.js')

  let roster = []
  try {
    // Same live/demo side only — one credential set reaches one host, and a
    // demo token cannot read a live account's positions.
    const isLive = !!baseCreds.isLive
    roster = getEnabledAccounts(db)
      .filter(a => (a.is_live === 1) === isLive)
      .map(a => String(a.account_id))
  } catch { roster = [] }

  // The selected account leads, and a registry that does not list it still
  // gets it swept — never let a registry gap silently drop the account the
  // operator is actually looking at.
  const primary = baseCreds.accountId != null ? String(baseCreds.accountId) : null
  const ids = [...new Set([...(primary ? [primary] : []), ...roster])]
  if (!ids.length) return out

  for (const id of ids) {
    try {
      // Same credentials, different account id. One cTrader access token
      // authorises every account under its cTID (wsGetAccountsByToken proves
      // it), so re-deriving creds per account would re-read the same token
      // and only add a way for the roster to come back not-ready and silently
      // skip an account — which is the failure being fixed here.
      const creds = id === primary ? baseCreds : { ...baseCreds, accountId: id }
      if (!creds?.ready) continue
      const r = await runLossCap(db, creds, deps)
      out.accounts++
      out.checked += r.checked
      out.breaches += r.breaches
      out.closes += r.closes
      if (r.errors.length) out.errors.push(...r.errors)
    } catch (err) {
      out.errors.push(`account ${id}: ${err?.message || err}`)
    }
  }
  return out
}

/**
 * ONE-TIME rewrite of the stored config to the owner's 2026-08-03 decision:
 * 1% of balance with a $50 floor.
 *
 * Why a migration and not just a new default: `loadLossCapConfig` spreads the
 * SAVED config over the defaults, so a stored `maxLossPctOfBalance: 2` wins
 * over any default this file declares. Production is carrying exactly that —
 * {on:true, maxLossUsd:800, maxLossPctOfBalance:2, retryMinutes:3} — so
 * changing DEFAULT_LOSS_CAP alone would have looked done and changed nothing.
 *
 * Keyed and idempotent: it fires once, ever. If the owner later moves the cap
 * from the Risk page, this must not quietly drag it back — a migration that
 * re-applies is a setting the operator cannot actually change.
 *
 * Only the two fields the owner named are touched. `maxLossUsd`, `scope`,
 * `action` and `retryMinutes` are preserved exactly as stored.
 */
export const LOSS_CAP_MIGRATION_KEY = 'loss_cap_1pct_floor50_applied'

export function migrateLossCapConfig(db, { getState: gs = getState, setState: ss = setState } = {}) {
  try {
    if (gs(db, LOSS_CAP_MIGRATION_KEY) === 'true') return { applied: false, reason: 'already applied' }
    let saved = null
    try { saved = JSON.parse(gs(db, 'loss_cap_json') || 'null') } catch { saved = null }
    const next = { ...DEFAULT_LOSS_CAP, ...(saved || {}), maxLossPctOfBalance: 1, minCapUsd: 50 }
    ss(db, 'loss_cap_json', JSON.stringify(next))
    ss(db, LOSS_CAP_MIGRATION_KEY, 'true')
    return { applied: true, config: next }
  } catch (err) {
    // A migration failure must never stop the process from booting — the cap
    // keeps running on whatever is stored, which is the previous behaviour.
    return { applied: false, reason: err?.message || String(err) }
  }
}
