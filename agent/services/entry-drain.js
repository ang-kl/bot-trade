// ---------------------------------------------------------------------------
// agent/services/entry-drain.js — phase P1c of docs/tick-momentum/plan.md
// (§3 steps 1–5, register row TM-14). 11-09-2026.
//
// When an account is switched to STOPPED its RESTING entry orders are
// cancelled by their STORED broker ids, and the transition state settles
// QUIESCING → RECONCILING → STABLE on evidence, never on a timer.
//
// WHAT IS TOUCHED. Only pending_orders rows with status 'working' AND
// account_id = this account, each cancelled by its own order_id. Never by
// symbol, never by a label guess, never a row with no account — legacy NULL
// rows are reported as `unattributed`, not cancelled with somebody else's
// credentials (the wrong-credentials defect closed-market-limits.js records) —
// and never an order at the broker without one of pending-orders.js's
// BOT_MARKERS: the owner's manual orders are untouchable by construction,
// exactly as in the broker sweep.
//
// THE RACE. A cancel that fails leaves its row 'working' and the state
// RECONCILING; the next pass retries. A cancel that fails because the order
// already FILLED is resolved by the passes that own that question —
// managePendingOrders marks the row 'filled' and adopts the position through
// persistFilledTrade, reconcileStaleClosedMarketLimits does the same for
// closed-market rows — so the drain converges on the ledger's word and never
// invents a fill or a death. `unknown` is what the broker still shows resting
// with a bot marker that no working row explains: a cancel in flight, or an
// orphan the broker sweep removes on its pass. STABLE needs unknown == 0 and,
// under STOPPED, resting == 0 — measured on a snapshot fetched AFTER this
// pass's cancels, because a snapshot from before them shows what was just
// removed. No snapshot is no evidence: the state cannot settle on it.
//
// Under an active mode (TIME_BASED) a RECONCILING account is only recounted:
// its resting rows are legitimate entries there, and nothing is cancelled.
// A pass on a STABLE account returns before any broker call, so the loop can
// run it every cycle at no cost.
// ---------------------------------------------------------------------------

import { engineStatusFor, writeEngineStatus } from './entry-mode.js'
import { isBotOrderLabel, brokerOrderFields } from './pending-orders.js'

const DRAINING = new Set(['QUIESCING', 'RECONCILING'])

/**
 * One drain pass for one account. `creds` must carry the account's own id
 * (exec.cancelOrder stamps the account from them). deps: { exec,
 * brokerOrders } — a pre-fetched snapshot is used only when nothing was
 * cancelled in this pass.
 */
export async function drainEntryOrders(db, creds, deps = {}) {
  const exec = deps.exec ?? await import('../lib/exec-engine.js')
  const id = creds?.accountId != null ? String(creds.accountId) : null
  if (id == null) return { ok: false, skipped: 'no_account' }
  const cur = engineStatusFor(db, id)
  if (!DRAINING.has(cur.transitionState)) return { ok: true, skipped: 'stable', accountId: id, transitionState: cur.transitionState }

  const out = {
    ok: true, accountId: id, epoch: cur.modeEpoch, mode: cur.effectiveEntryMode, from: cur.transitionState,
    cancelled: [], failures: [], unattributed: 0, resting: 0, unknown: 0, snapshotError: null, transitionState: null,
  }

  // 1. cancel by stored id — only under STOPPED. Rows are read fresh each
  // pass, so a row the fill pass has since marked 'filled' is not here.
  // The REQUESTED mode decides whether resting rows are ours to cancel: an
  // active mode's effective reading is STOPPED while its transition is in
  // progress (11-09-2026), and its resting rows are legitimate there.
  if (cur.requestedEntryMode === 'STOPPED') {
    const rows = db.prepare(`SELECT id, order_id, symbol, note FROM pending_orders WHERE status = 'working' AND account_id = ? ORDER BY id`).all(id)
    const mark = db.prepare(`UPDATE pending_orders SET status = 'cancelled', note = ? WHERE id = ? AND status = 'working'`)
    for (const row of rows) {
      if (row.order_id == null) {
        // Never got a broker id (a failed or ambiguous submission): nothing to
        // cancel by id. The pass that placed it retires it against the
        // broker's book; until then it is reported as a failure, not guessed.
        out.failures.push({ id: row.id, orderId: null, symbol: row.symbol, error: 'no stored order id' })
        continue
      }
      try {
        await exec.cancelOrder(creds, { orderId: row.order_id })
        mark.run(`cancelled by entry_mode drain (epoch ${cur.modeEpoch}, was ${row.note || 'pending-fib'})`, row.id)
        out.cancelled.push({ id: row.id, orderId: String(row.order_id), symbol: row.symbol })
      } catch (err) {
        out.failures.push({ id: row.id, orderId: String(row.order_id), symbol: row.symbol, error: err?.message || String(err) })
      }
    }
  }
  try {
    out.unattributed = db.prepare(`SELECT COUNT(*) AS n FROM pending_orders WHERE status = 'working' AND account_id IS NULL`).get()?.n ?? 0
  } catch { out.unattributed = 0 }

  // 2. the broker's word, fetched after the cancels
  let snapshot = null
  try {
    snapshot = (out.cancelled.length === 0 && Array.isArray(deps.brokerOrders))
      ? deps.brokerOrders
      : ((await exec.reconcile(creds))?.order || [])
  } catch (err) {
    out.snapshotError = err?.message || String(err)
  }
  const working = new Set(
    db.prepare(`SELECT order_id FROM pending_orders WHERE status = 'working' AND account_id = ? AND order_id IS NOT NULL`)
      .all(id).map(r => String(r.order_id)),
  )
  out.resting = db.prepare(`SELECT COUNT(*) AS n FROM pending_orders WHERE status = 'working' AND account_id = ?`).get(id)?.n ?? 0
  if (snapshot) {
    for (const o of snapshot) {
      const f = brokerOrderFields(o)
      if (!isBotOrderLabel(f.label)) continue // the owner's order: not ours to count or touch
      if (f.orderId != null && working.has(String(f.orderId))) continue // explained by a working row (its cancel failed above; retried next pass)
      out.unknown++
    }
  } else {
    out.unknown = cur.entryCounts.unknown // no evidence either way: carry what was last measured
  }

  // 3. settle — on evidence only. AUDIT 11-09-2026 (plan §3.4/§3.6): an
  // ACTIVE requested mode whose effective mode is still STOPPED becomes
  // effective here only once the unknowns are gone AND the sidecar has
  // echoed this epoch (fenceAckEpoch); with the unknowns gone but the fence
  // not yet bound the state is WARMING, not STABLE.
  const activeRequested = cur.requestedEntryMode !== 'STOPPED'
  const quiesced = cur.requestedEntryMode !== 'STOPPED' || out.resting === 0
  const evidenceClean = snapshot != null && out.unknown === 0 && quiesced
  const fenceBound = cur.fenceAckEpoch === cur.modeEpoch
  out.transitionState = !evidenceClean ? 'RECONCILING' : (activeRequested && !fenceBound) ? 'WARMING' : 'STABLE'
  const effectiveEntryMode = out.transitionState === 'STABLE' ? cur.requestedEntryMode : (activeRequested ? 'STOPPED' : cur.effectiveEntryMode)
  writeEngineStatus(db, {
    ...cur,
    transitionState: out.transitionState,
    effectiveEntryMode,
    entryCounts: { ...cur.entryCounts, resting: out.resting, unknown: out.unknown },
    updatedAt: new Date().toISOString(),
  })
  if (out.cancelled.length || out.failures.length || out.transitionState !== cur.transitionState) {
    try {
      db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)').run(
        'LOOP', '/entry-mode/drain',
        JSON.stringify({
          accountId: id, epoch: cur.modeEpoch, mode: cur.effectiveEntryMode, cancelled: out.cancelled, failures: out.failures,
          unattributed: out.unattributed, resting: out.resting, unknown: out.unknown, snapshotError: out.snapshotError,
          from: cur.transitionState, to: out.transitionState,
        }),
        id,
      )
    } catch { /* audit best-effort */ }
  }
  return out
}

/**
 * The loop's pass: every registry account in QUIESCING or RECONCILING is
 * drained with ITS OWN credentials; the rest are not visited. deps:
 * { exec, credsFor } for tests.
 */
export async function drainEntryOrdersPass(db, deps = {}) {
  const credsFor = deps.credsFor ?? (await import('../lib/ctrader-creds.js')).getCtraderCreds
  let rows = []
  try { rows = db.prepare('SELECT account_id, is_live FROM accounts ORDER BY is_live, account_id').all() } catch { rows = [] }
  const out = { checked: 0, drained: [], skipped: [] }
  for (const r of rows) {
    const id = String(r.account_id)
    if (!DRAINING.has(engineStatusFor(db, id).transitionState)) continue
    out.checked++
    let creds = null
    try { creds = credsFor(db, { accountId: id, isLive: Number(r.is_live) === 1 }) } catch (err) {
      out.skipped.push({ accountId: id, reason: err?.message || String(err) }); continue
    }
    if (!creds?.ready) { out.skipped.push({ accountId: id, reason: 'credentials not ready' }); continue }
    try { out.drained.push(await drainEntryOrders(db, creds, { exec: deps.exec })) } catch (err) {
      out.skipped.push({ accountId: id, reason: err?.message || String(err) })
    }
  }
  return out
}
