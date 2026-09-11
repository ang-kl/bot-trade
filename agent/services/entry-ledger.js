// ---------------------------------------------------------------------------
// agent/services/entry-ledger.js — the durable entry-intent ledger and its
// one-use execution permits. Phase P2a of docs/tick-momentum/plan.md (§3
// steps 1/2/4, §9; register rows TM-13, TM-17). 11-09-2026.
//
// THE PROBLEM IT REPLACES. exec-engine.placeOrder held an in-memory 60 s
// idempotency lock, and an ambiguous send (the request went out, no answer
// came back) left a `risk_events` veto row that lib/submission-dedupe.js
// read for a window. Both are records of a refusal, not of an outcome, and
// the lock died with the process — the 9x 0066.HK duplicate was that gap.
//
// THE RECORD. One `entry_intents` row per attempt to open new risk:
//   RESERVED    — capacity claimed, permit issued, nothing sent
//   DISPATCHING — the permit was redeemed (exactly once); about to send
//   SENT        — the request was written towards the broker
//   ACCEPTED    — the broker holds a resting order for it
//   FILLED      — the broker opened a position for it
//   REJECTED    — the broker refused it: provably nothing opened
//   UNKNOWN     — the outcome was never learned. This state SURVIVES A
//                 RESTART and blocks a new intent on the same account /
//                 symbol / side until the broker's evidence resolves it —
//                 "a timeout is not proof that the order failed" (plan §3.4)
//   RELEASED    — never sent: the mode epoch moved, or the caller gave up
//   EXPIRED     — a permit nobody redeemed before its expiry
//
// THE RULES. reserveEntry() runs in ONE immediate transaction: the P1b fence
// (admitEntry) on the current epoch, then "no open intent for the same
// account / symbol / side" — the duplicate authority. redeemPermit() moves
// RESERVED → DISPATCHING exactly once (an UPDATE whose changes() must be 1)
// and refuses an expired, consumed or stale-epoch permit. Every transition
// out of an open state is recorded with its source: the broker's response,
// the reconcile snapshot (the intent tag in the position's label), the
// sidecar's decision ring, a timeout, or an operator with a reason.
// Nothing here is estimated: an intent no evidence resolves stays UNKNOWN.
// ---------------------------------------------------------------------------

import { randomBytes } from 'node:crypto'
import { admitEntry, engineStatusFor } from './entry-mode.js'
import { labelIntentId } from '../lib/trade-labels.js'

export const INTENT_STATES = Object.freeze(['RESERVED', 'DISPATCHING', 'SENT', 'ACCEPTED', 'FILLED', 'REJECTED', 'UNKNOWN', 'RELEASED', 'EXPIRED'])
export const OPEN_STATES = Object.freeze(['RESERVED', 'DISPATCHING', 'SENT', 'UNKNOWN'])
const IN_FLIGHT = Object.freeze(['DISPATCHING', 'SENT'])
export const DEFAULT_PERMIT_TTL_MS = 30_000
export const DEFAULT_SENT_TIMEOUT_MS = 60_000

const iso = (ms) => new Date(ms).toISOString()

export function newIntentId() {
  // 'i' + 12 base36 chars: fits the label's 8th field with room to spare.
  let s = ''
  while (s.length < 12) s += randomBytes(9).readBigUInt64BE(0).toString(36)
  return 'i' + s.slice(0, 12)
}

function sameKeySql(symbolId) {
  return symbolId != null ? 'symbol_id = ?' : 'symbol = ?'
}

export const VPO_PRODUCER = 'vpo_cpp_direct'
export const VPO_PERMIT_TTL_MS = 5 * 60 * 1000 // the sidecar store's maxAgeMs; refreshed by every push

function openConflict(db, { accountId, symbolId, symbol, side, producerId = null }) {
  const key = symbolId != null ? Number(symbolId) : String(symbol || '')
  // A STANDING VPO reservation (issued with each push, redeemed only if the
  // tier fires) is capacity held in advance, not a commitment: it never
  // blocks another producer. Everything else open blocks everyone, the VPO
  // producer included.
  return db.prepare(`SELECT id, state, producer_id, created_at FROM entry_intents
    WHERE account_id = ? AND ${sameKeySql(symbolId)} AND side = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})
      AND NOT (state = 'RESERVED' AND producer_id = ? AND ? <> ?)
    ORDER BY id LIMIT 1`).get(String(accountId), key, String(side), ...OPEN_STATES, VPO_PRODUCER, String(producerId || ''), VPO_PRODUCER) || null
}

function permitOf(row, expiresAtMs) {
  return {
    id: row.permit_id, intentId: row.id, accountId: row.account_id, environment: row.environment,
    symbolId: row.symbol_id, symbol: row.symbol, side: row.side, volume: row.volume, epoch: row.mode_epoch,
    expiresAt: iso(expiresAtMs), expiresAtMs,
  }
}

/**
 * P2a-2: the VPO tier's permits, pre-issued with each /vpo-config push — one
 * per armed strategy and side, bound to the account, symbol, sized volume
 * and current epoch, five minutes long and refreshed by the next push. A
 * standing permit whose volume or epoch changed is RELEASED and re-issued;
 * a strategy with no usable sizing keeps none. Refusals (the fence) are
 * reported, never hidden.
 */
export function reserveVpoPermits(db, { accountId, entries = [], ttlMs = VPO_PERMIT_TTL_MS, now = Date.now() } = {}) {
  const id = String(accountId)
  const st = engineStatusFor(db, id)
  const out = { permits: [], reused: 0, issued: 0, released: 0, refused: [] }
  const standing = db.prepare(`SELECT * FROM entry_intents WHERE account_id = ? AND producer_id = ? AND state = 'RESERVED' AND signal_ref = ? AND side = ? ORDER BY id`)
  const extend = db.prepare(`UPDATE entry_intents SET permit_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'RESERVED'`)
  const release = db.prepare(`UPDATE entry_intents SET state = 'RELEASED', error_code = ?, resolution_source = 'epoch', resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'RESERVED'`)
  db.transaction(() => {
    for (const e of entries) {
      const { key, symbol, symbolId, volume } = e || {}
      if (!key || !symbol) continue
      const usable = Number(volume) > 0
      for (const side of ['BUY', 'SELL']) {
        let kept = null
        for (const r of standing.all(id, VPO_PRODUCER, String(key), side)) {
          const same = usable && r.mode_epoch === st.modeEpoch && Number(r.volume) === Number(volume) && Number(r.symbol_id) === Number(symbolId)
          if (same && !kept) { kept = r; continue }
          release.run(usable ? 'vpo_permit_superseded' : 'vpo_no_sizing', iso(now), iso(now), r.id)
          out.released++
        }
        if (!usable) continue
        if (kept) {
          extend.run(iso(now + ttlMs), iso(now), kept.id)
          out.reused++
          out.permits.push({ key, symbol, side, permit: permitOf(kept, now + ttlMs) })
          continue
        }
        const r = reserveEntry(db, { accountId: id, producerId: VPO_PRODUCER, basis: 'bar', symbol, symbolId, side, orderType: 'MARKET', volume, signalRef: String(key), ttlMs, now })
        if (!r.ok) { out.refused.push({ key, symbol, side, reason: r.reason }); continue }
        out.issued++
        out.permits.push({ key, symbol, side, permit: r.permit })
      }
    }
  }).immediate()
  return out
}

/** The disarm's counterpart: standing VPO permits are released, never left to expire. */
export function releaseVpoReservations(db, accountId, reason = 'vpo_disarmed', { now = Date.now() } = {}) {
  const r = db.prepare(`UPDATE entry_intents SET state = 'RELEASED', error_code = ?, resolution_source = 'epoch', resolved_at = ?, updated_at = ?
    WHERE account_id = ? AND producer_id = ? AND state = 'RESERVED'`).run(String(reason), iso(now), iso(now), String(accountId), VPO_PRODUCER)
  return { released: r.changes }
}

function audit(db, path, body, accountId) {
  try {
    db.prepare('INSERT INTO action_log (method, path, body, account_id) VALUES (?, ?, ?, ?)')
      .run('LEDGER', path, JSON.stringify(body), accountId != null ? String(accountId) : null)
  } catch { /* audit best-effort */ }
}

/**
 * Claim capacity for one entry and issue its permit. Refuses when the P1b
 * fence refuses, or when an open intent already exists for the same
 * account / symbol / side (whatever its producer — one entry, one owner).
 */
export function reserveEntry(db, {
  accountId, producerId, basis = 'bar', symbol = null, symbolId = null, side, orderType = 'MARKET',
  volume = null, sl = null, tp = null, signalRef = null, ttlMs = DEFAULT_PERMIT_TTL_MS, now = Date.now(),
  gatewayInstance = null,
} = {}) {
  const id = accountId != null ? String(accountId) : null
  if (id == null) return { ok: false, reason: 'no_account' }
  if (!side || !['BUY', 'SELL'].includes(String(side).toUpperCase())) return { ok: false, reason: `bad_side: ${side}` }
  if (symbolId == null && !symbol) return { ok: false, reason: 'no_symbol' }
  const sideU = String(side).toUpperCase()
  const tx = db.transaction(() => {
    const a = admitEntry(db, { accountId: id, producerId, basis })
    if (!a.ok) return { ok: false, reason: a.reason, modeEpoch: a.modeEpoch }
    const st = engineStatusFor(db, id)
    const clash = openConflict(db, { accountId: id, symbolId, symbol, side: sideU, producerId })
    if (clash) return { ok: false, reason: `intent_open: ${clash.state} ${clash.id} (${clash.producer_id}, ${clash.created_at})`, intent: clash }
    const intentId = newIntentId()
    const permitId = 'p' + newIntentId().slice(1)
    const expiresAt = iso(now + ttlMs)
    db.prepare(`INSERT INTO entry_intents
      (id, account_id, environment, symbol, symbol_id, side, order_type, volume, sl, tp, producer_id, basis, signal_ref,
       mode_epoch, config_revision, permit_id, permit_expires_at, state, gateway_instance, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RESERVED', ?, ?, ?)`)
      .run(intentId, id, st.environment, symbol ?? null, symbolId != null ? Number(symbolId) : null, sideU, orderType ?? null,
        volume != null ? Number(volume) : null, sl != null ? Number(sl) : null, tp != null ? Number(tp) : null,
        String(producerId), String(basis), signalRef != null ? String(signalRef) : null,
        st.modeEpoch, st.configRevision, permitId, expiresAt, gatewayInstance, iso(now), iso(now))
    return {
      ok: true, intentId,
      permit: {
        id: permitId, intentId, accountId: id, environment: st.environment,
        symbolId: symbolId != null ? Number(symbolId) : null, symbol: symbol ?? null, side: sideU,
        volume: volume != null ? Number(volume) : null, epoch: st.modeEpoch, expiresAt, expiresAtMs: now + ttlMs,
      },
    }
  })
  return tx.immediate()
}

/** RESERVED → DISPATCHING, exactly once. */
export function redeemPermit(db, permitId, { now = Date.now() } = {}) {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM entry_intents WHERE permit_id = ?').get(String(permitId || ''))
    if (!row) return { ok: false, reason: 'permit_unknown' }
    if (row.state !== 'RESERVED') return { ok: false, reason: `permit_consumed: ${row.state}`, intent: row }
    if (Date.parse(row.permit_expires_at) <= now) {
      db.prepare(`UPDATE entry_intents SET state = 'EXPIRED', resolution_source = 'timeout', resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'RESERVED'`)
        .run(iso(now), iso(now), row.id)
      return { ok: false, reason: 'permit_expired', intent: row }
    }
    const st = engineStatusFor(db, row.account_id)
    if (st.modeEpoch !== row.mode_epoch) {
      db.prepare(`UPDATE entry_intents SET state = 'RELEASED', error_code = 'epoch_stale', resolution_source = 'epoch', resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'RESERVED'`)
        .run(iso(now), iso(now), row.id)
      return { ok: false, reason: `permit_epoch_stale: permit epoch ${row.mode_epoch}, account epoch ${st.modeEpoch}`, intent: row }
    }
    const r = db.prepare(`UPDATE entry_intents SET state = 'DISPATCHING', updated_at = ? WHERE id = ? AND state = 'RESERVED'`).run(iso(now), row.id)
    if (r.changes !== 1) return { ok: false, reason: 'permit_consumed: raced', intent: row }
    return { ok: true, intent: { ...row, state: 'DISPATCHING' } }
  })
  return tx.immediate()
}

/** DISPATCHING → SENT: the request is being written towards the broker. */
export function markSent(db, intentId, { clientMsgId = null, sidecarBootId = null, now = Date.now() } = {}) {
  const r = db.prepare(`UPDATE entry_intents SET state = 'SENT', client_msg_id = COALESCE(?, client_msg_id), sidecar_boot_id = COALESCE(?, sidecar_boot_id), updated_at = ?
    WHERE id = ? AND state = 'DISPATCHING'`).run(clientMsgId, sidecarBootId, iso(now), String(intentId))
  return { ok: r.changes === 1 }
}

/**
 * Any open state → a terminal one, with the evidence named. UNKNOWN is itself
 * "open". SENT is accepted only from RESERVED / DISPATCHING and only on the
 * sidecar's own evidence (ring / event): a VPO permit is redeemed inside the
 * sidecar, so the keeper learns of the send after the fact.
 */
export function resolveIntent(db, intentId, { state, brokerOrderId = null, positionId = null, errorCode = null, clientMsgId = null, source, now = Date.now() } = {}) {
  if (!INTENT_STATES.includes(state) || OPEN_STATES.includes(state) && state !== 'UNKNOWN' && state !== 'SENT') return { ok: false, reason: `bad_state: ${state}` }
  if (state === 'SENT' && !['ring', 'event'].includes(source)) return { ok: false, reason: 'SENT needs the sidecar\'s evidence' }
  const from = state === 'SENT' ? ['RESERVED', 'DISPATCHING'] : OPEN_STATES
  const terminal = state !== 'UNKNOWN' && state !== 'SENT'
  const r = db.prepare(`UPDATE entry_intents SET state = ?, broker_order_id = COALESCE(?, broker_order_id), broker_position_id = COALESCE(?, broker_position_id),
      error_code = COALESCE(?, error_code), client_msg_id = COALESCE(?, client_msg_id), resolution_source = ?, resolved_at = ?, updated_at = ?
    WHERE id = ? AND state IN (${from.map(() => '?').join(',')})`)
    .run(state, brokerOrderId != null ? String(brokerOrderId) : null, positionId != null ? String(positionId) : null,
      errorCode, clientMsgId != null ? String(clientMsgId) : null, String(source || 'unspecified'), terminal ? iso(now) : null, iso(now), String(intentId), ...from)
  if (r.changes === 1 && state === 'UNKNOWN') {
    const row = db.prepare('SELECT account_id, symbol, side, producer_id FROM entry_intents WHERE id = ?').get(String(intentId))
    audit(db, '/entry-intents/unknown', { intentId, ...row, errorCode, source }, row?.account_id)
  }
  return { ok: r.changes === 1 }
}

/** RESERVED intents of an older epoch are never sent (plan §3 step 1). */
export function releaseOldEpoch(db, accountId, epoch, { now = Date.now() } = {}) {
  const r = db.prepare(`UPDATE entry_intents SET state = 'RELEASED', error_code = 'epoch_stale', resolution_source = 'epoch', resolved_at = ?, updated_at = ?
    WHERE account_id = ? AND state = 'RESERVED' AND mode_epoch < ?`).run(iso(now), iso(now), String(accountId), Number(epoch))
  return { released: r.changes }
}

/**
 * Time is evidence only of absence: an unredeemed permit past its expiry is
 * EXPIRED (nothing was sent); a DISPATCHING or SENT intent past the send
 * timeout with no verdict becomes UNKNOWN — not failed, not filled.
 */
export function expireStale(db, { now = Date.now(), sentTimeoutMs = DEFAULT_SENT_TIMEOUT_MS } = {}) {
  const expired = db.prepare(`UPDATE entry_intents SET state = 'EXPIRED', resolution_source = 'timeout', resolved_at = ?, updated_at = ?
    WHERE state = 'RESERVED' AND permit_expires_at <= ?`).run(iso(now), iso(now), iso(now)).changes
  const stale = db.prepare(`SELECT id FROM entry_intents WHERE state IN ('DISPATCHING', 'SENT') AND updated_at <= ?`).all(iso(now - sentTimeoutMs))
  let unknown = 0
  for (const { id } of stale) if (resolveIntent(db, id, { state: 'UNKNOWN', source: 'timeout', errorCode: 'no verdict within the send timeout', now }).ok) unknown++
  return { expired, unknown }
}

export function openIntents(db, accountId = null) {
  const where = accountId != null ? 'AND account_id = ?' : ''
  return db.prepare(`SELECT * FROM entry_intents WHERE state IN (${OPEN_STATES.map(() => '?').join(',')}) ${where} ORDER BY id`)
    .all(...OPEN_STATES, ...(accountId != null ? [String(accountId)] : []))
}

/** The EngineStatus entryCounts the P0 contract asks for, measured. */
export function intentCounts(db, accountId) {
  const rows = db.prepare(`SELECT state, COUNT(*) AS n FROM entry_intents WHERE account_id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')}) GROUP BY state`)
    .all(String(accountId), ...OPEN_STATES)
  const by = Object.fromEntries(rows.map(r => [r.state, r.n]))
  return { unsent: by.RESERVED || 0, inFlight: (by.DISPATCHING || 0) + (by.SENT || 0), unknown: by.UNKNOWN || 0 }
}

/** Reserved-but-unfilled volume the margin pre-gate may count as used. */
export function pendingExposure(db, accountId) {
  return db.prepare(`SELECT symbol, symbol_id AS symbolId, side, volume, state FROM entry_intents
    WHERE account_id = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})`).all(String(accountId), ...OPEN_STATES)
}

const posField = (p, key) => p?.tradeData?.[key] ?? p?.[key]

/**
 * Resolve open intents from the broker's own evidence: a position or resting
 * order whose label carries the intent tag, or the sidecar's decision ring
 * (cpp_decisions order_result / order_reject rows naming the intent). An
 * intent nothing names stays as it is.
 */
export function reconcileIntents(db, { accountId, positions = [], orders = [], now = Date.now() } = {}) {
  const out = { checked: 0, resolved: [], stillOpen: 0 }
  // Standing VPO permits are open too: the sidecar redeems them in-process,
  // so the ring's order_submit is how the keeper learns one was sent.
  const open = db.prepare(`SELECT * FROM entry_intents WHERE account_id = ?
    AND (state IN ('DISPATCHING', 'SENT', 'UNKNOWN') OR (state = 'RESERVED' AND producer_id = ?)) ORDER BY id`).all(String(accountId), VPO_PRODUCER)
  const byTag = new Map()
  for (const p of positions) { const t = labelIntentId(String(posField(p, 'label') || '')); if (t) byTag.set(t, { kind: 'position', id: p?.positionId ?? posField(p, 'positionId') }) }
  for (const o of orders) { const t = labelIntentId(String(posField(o, 'label') || posField(o, 'comment') || '')); if (t && !byTag.has(t)) byTag.set(t, { kind: 'order', id: o?.orderId ?? posField(o, 'orderId') }) }
  const ring = db.prepare(`SELECT kind, code, detail FROM cpp_decisions WHERE component = 'engine' AND kind IN ('order_submit', 'order_result', 'order_reject') AND detail LIKE ? ORDER BY id DESC LIMIT 1`)
  // P2b-1: the sidecar's execution-event journal — a late frame after a
  // TIMEOUT, matched by the clientMsgId the sidecar reported, or any event
  // whose order label carries the intent tag.
  let events = null
  try { events = db.prepare(`SELECT payload_type, execution_type, order_id, position_id, error_code FROM cpp_events WHERE (? <> '' AND client_msg_id = ?) OR label LIKE ? ORDER BY id DESC LIMIT 1`) } catch { events = null }
  for (const it of open) {
    out.checked++
    const hit = byTag.get(it.id)
    let r = null
    if (hit?.kind === 'position') r = resolveIntent(db, it.id, { state: 'FILLED', positionId: hit.id, source: 'reconcile', now })
    else if (hit?.kind === 'order') r = resolveIntent(db, it.id, { state: 'ACCEPTED', brokerOrderId: hit.id, source: 'reconcile', now })
    else {
      let rec = null
      try { rec = ring.get(`intent=${it.id}%`) } catch { rec = null }
      if (rec?.kind === 'order_reject') r = resolveIntent(db, it.id, { state: 'REJECTED', errorCode: rec.code || 'rejected', source: 'ring', now })
      else if (rec?.kind === 'order_result') {
        const pos = /pos=(\d+)/.exec(rec.detail || '')?.[1] ?? null
        const ord = /order=(\d+)/.exec(rec.detail || '')?.[1] ?? null
        r = resolveIntent(db, it.id, { state: pos ? 'FILLED' : 'ACCEPTED', positionId: pos, brokerOrderId: ord, source: 'ring', now })
      } else if (rec?.kind === 'order_submit' && (it.state === 'RESERVED' || it.state === 'DISPATCHING')) {
        r = resolveIntent(db, it.id, { state: 'SENT', source: 'ring', now })
      } else if (events && it.state !== 'RESERVED') {
        let ev = null
        try { ev = events.get(it.client_msg_id || '', it.client_msg_id || '', `%|${it.id}`) } catch { ev = null }
        if (ev) {
          const type = String(ev.execution_type || '')
          if (Number(ev.payload_type) === 2132 || ev.error_code || /REJECTED|CANCELLED|EXPIRED/.test(type)) {
            r = resolveIntent(db, it.id, { state: 'REJECTED', errorCode: ev.error_code || type || 'order_error', source: 'event', now })
          } else if (ev.position_id != null || /FILL/.test(type)) {
            r = resolveIntent(db, it.id, { state: 'FILLED', positionId: ev.position_id, brokerOrderId: ev.order_id, source: 'event', now })
          } else if (ev.order_id != null || /ACCEPTED/.test(type)) {
            r = resolveIntent(db, it.id, { state: 'ACCEPTED', brokerOrderId: ev.order_id, source: 'event', now })
          }
        }
      }
    }
    if (r?.ok) out.resolved.push({ intentId: it.id, from: it.state, to: db.prepare('SELECT state FROM entry_intents WHERE id = ?').get(it.id).state })
    else out.stillOpen++
  }
  return out
}

/** An operator's word, with a reason, is the last resolver of an UNKNOWN intent. */
export function operatorResolve(db, intentId, { state, reason, actor = 'owner', now = Date.now() } = {}) {
  if (!['FILLED', 'ACCEPTED', 'REJECTED', 'RELEASED'].includes(state)) return { ok: false, reason: `bad_state: ${state}` }
  if (!reason || String(reason).trim().length < 3) return { ok: false, reason: 'reason_required' }
  const row = db.prepare('SELECT * FROM entry_intents WHERE id = ?').get(String(intentId))
  if (!row) return { ok: false, reason: 'intent_unknown' }
  const r = resolveIntent(db, intentId, { state, errorCode: `operator: ${String(reason).slice(0, 200)}`, source: 'operator', now })
  if (r.ok) audit(db, '/entry-intents/resolve', { intentId, from: row.state, to: state, reason, actor }, row.account_id)
  return r.ok ? { ok: true, from: row.state, to: state } : { ok: false, reason: `not_open: ${row.state}` }
}

/** For GET /state/entry-intents — redacted account ids, no secrets. */
export function ledgerView(db, { limit = 50 } = {}) {
  const redact = (id) => `…${String(id).slice(-4)}`
  const counts = db.prepare(`SELECT account_id, state, COUNT(*) AS n FROM entry_intents GROUP BY account_id, state ORDER BY account_id, state`).all()
  const byAccount = {}
  for (const c of counts) { (byAccount[redact(c.account_id)] ||= {})[c.state] = c.n }
  const open = openIntents(db).slice(0, limit).map(r => ({
    id: r.id, accountId: redact(r.account_id), environment: r.environment, symbol: r.symbol, symbolId: r.symbol_id, side: r.side,
    volume: r.volume, producerId: r.producer_id, state: r.state, modeEpoch: r.mode_epoch, permitExpiresAt: r.permit_expires_at,
    createdAt: r.created_at, updatedAt: r.updated_at, errorCode: r.error_code, brokerOrderId: r.broker_order_id, brokerPositionId: r.broker_position_id,
  }))
  const recent = db.prepare(`SELECT id, account_id, symbol, side, producer_id, state, resolution_source, error_code, resolved_at FROM entry_intents
    WHERE resolved_at IS NOT NULL ORDER BY resolved_at DESC LIMIT ?`).all(limit).map(r => ({ ...r, account_id: redact(r.account_id) }))
  return {
    at: iso(Date.now()), countsByAccount: byAccount, open, recent,
    note: 'P2a: every Node-placed entry is an intent with a one-use permit; UNKNOWN blocks a resend on the same account/symbol/side until the broker\'s evidence, the sidecar ring, or an operator with a reason resolves it.',
  }
}
