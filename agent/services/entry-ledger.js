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
import { pageDeals } from '../lib/deal-paging.js'

export const INTENT_STATES = Object.freeze(['RESERVED', 'DISPATCHING', 'SENT', 'ACCEPTED', 'FILLED', 'REJECTED', 'UNKNOWN', 'RELEASED', 'EXPIRED'])
export const OPEN_STATES = Object.freeze(['RESERVED', 'DISPATCHING', 'SENT', 'UNKNOWN'])
const IN_FLIGHT = Object.freeze(['DISPATCHING', 'SENT'])
export const DEFAULT_PERMIT_TTL_MS = 30_000
export const DEFAULT_SENT_TIMEOUT_MS = 60_000
// How long a RELEASED standing row stays visible to the ring path (a fire
// that beat the mode switch; see reconcileIntents).
export const RELEASED_RING_WINDOW_MS = 60 * 60 * 1000

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
// P6b: the tick producer's permits are STANDING too — pre-issued per
// account / symbol / side with each feeder push, redeemed in-process by the
// sidecar's firer at the shadow book's fill (cpp-exec/src/tick_firer.cpp).
export const TICK_PRODUCER = 'tick_momentum'
export const TICK_PERMIT_TTL_MS = VPO_PERMIT_TTL_MS
export const STANDING_PRODUCERS = Object.freeze([VPO_PRODUCER, TICK_PRODUCER])

function openConflict(db, { accountId, symbolId, symbol, side, producerId = null }) {
  const key = symbolId != null ? Number(symbolId) : String(symbol || '')
  // A STANDING reservation (issued with each push, redeemed only if the
  // sidecar's tier fires) is capacity held in advance, not a commitment: it
  // never blocks ANOTHER producer. It does block its own producer (one
  // standing permit per account/symbol/side), and everything else open
  // blocks everyone, the standing producers included.
  const standing = STANDING_PRODUCERS.map(() => '?').join(',')
  return db.prepare(`SELECT id, state, producer_id, created_at FROM entry_intents
    WHERE account_id = ? AND ${sameKeySql(symbolId)} AND side = ? AND state IN (${OPEN_STATES.map(() => '?').join(',')})
      AND NOT (state = 'RESERVED' AND producer_id IN (${standing}) AND producer_id <> ?)
    ORDER BY id LIMIT 1`).get(String(accountId), key, String(side), ...OPEN_STATES, ...STANDING_PRODUCERS, String(producerId || '')) || null
}

function permitOf(row, expiresAtMs) {
  return {
    // RACE CHECKER 11-09-2026: the sidecar's validatePermit reads accountId
    // with asNumber and does not coerce a string — a TEXT id here would
    // refuse every in-process fire as permit_mismatch. Numeric on the wire.
    id: row.permit_id, intentId: row.id, accountId: Number(row.account_id), environment: row.environment,
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
export function reserveVpoPermits(db, opts = {}) {
  return reserveStandingPermits(db, { ...opts, producerId: VPO_PRODUCER, basis: 'bar', ttlMs: opts.ttlMs ?? VPO_PERMIT_TTL_MS })
}

/**
 * P6b: the same standing-permit rule for any in-process sidecar producer.
 * `entries` are { key, symbol, symbolId, volume } — volume null means the
 * sidecar sizes at fire time from the permit's risk figures (the tick
 * producer); the permit's volume is then null and the send boundary skips
 * the volume match (order_guard.cpp validatePermit) while the keeper's
 * maxOrderVolume cap still binds. A standing row is reused only when its
 * epoch, volume and symbol id are unchanged.
 */
export function reserveStandingPermits(db, { accountId, producerId, basis = 'bar', entries = [], sizeRequired = true, ttlMs = VPO_PERMIT_TTL_MS, now = Date.now(), admit = admitEntry } = {}) {
  const id = String(accountId)
  if (!STANDING_PRODUCERS.includes(producerId)) throw new Error(`reserveStandingPermits: ${producerId} is not a standing producer`)
  const st = engineStatusFor(db, id)
  const out = { permits: [], reused: 0, issued: 0, released: 0, refused: [] }
  const standing = db.prepare(`SELECT * FROM entry_intents WHERE account_id = ? AND producer_id = ? AND state = 'RESERVED' AND signal_ref = ? AND side = ? ORDER BY id`)
  const extend = db.prepare(`UPDATE entry_intents SET permit_expires_at = ?, updated_at = ? WHERE id = ? AND state = 'RESERVED'`)
  const release = db.prepare(`UPDATE entry_intents SET state = 'RELEASED', error_code = ?, resolution_source = 'epoch', resolved_at = ?, updated_at = ? WHERE id = ? AND state = 'RESERVED'`)
  db.transaction(() => {
    // Keys this pass does not carry (a symbol dropped, a position now open on
    // it, the cap reached) have their standing rows withdrawn now, not left
    // to expire while the sidecar could still spend a copy it holds.
    const carried = new Set(entries.filter(e => e && e.key && e.symbol).map(e => String(e.key)))
    for (const r of db.prepare(`SELECT id, signal_ref FROM entry_intents WHERE account_id = ? AND producer_id = ? AND state = 'RESERVED'`).all(id, producerId)) {
      if (!carried.has(String(r.signal_ref))) { release.run((producerId === VPO_PRODUCER ? 'vpo_' : 'tick_') + 'permit_withdrawn', iso(now), iso(now), r.id); out.released++ }
    }
    for (const e of entries) {
      const { key, symbol, symbolId, volume, sides = null } = e || {}
      if (!key || !symbol) continue
      const usable = sizeRequired ? Number(volume) > 0 : (volume == null || Number(volume) > 0)
      const sameVolume = (r) => (volume == null ? r.volume == null : Number(r.volume) === Number(volume))
      for (const side of ['BUY', 'SELL']) {
        // PR-D: an entry may name the sides it carries (the tick feeder
        // withholds the against-trend side); a side not named has its
        // standing rows released now, not left for the sidecar to spend.
        if (Array.isArray(sides) && !sides.includes(side)) {
          for (const r of standing.all(id, producerId, String(key), side)) { release.run((producerId === VPO_PRODUCER ? 'vpo_' : 'tick_') + 'direction_against_trend', iso(now), iso(now), r.id); out.released++ }
          continue
        }
        let kept = null
        for (const r of standing.all(id, producerId, String(key), side)) {
          const same = usable && r.mode_epoch === st.modeEpoch && sameVolume(r) && Number(r.symbol_id) === Number(symbolId)
          if (same && !kept) { kept = r; continue }
          release.run((producerId === VPO_PRODUCER ? 'vpo_' : 'tick_') + (usable ? 'permit_superseded' : 'no_sizing'), iso(now), iso(now), r.id)
          out.released++
        }
        if (!usable) continue
        if (kept) {
          extend.run(iso(now + ttlMs), iso(now), kept.id)
          out.reused++
          out.permits.push({ key, symbol, side, permit: permitOf(kept, now + ttlMs) })
          continue
        }
        const r = reserveEntry(db, { accountId: id, producerId, basis, symbol, symbolId, side, orderType: 'MARKET', volume, signalRef: String(key), ttlMs, now, admit })
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
  return releaseStandingReservations(db, accountId, VPO_PRODUCER, reason, { now })
}
/** P6b: the same release for any standing producer (the tick feeder on a mode change or a readiness failure). */
export function releaseStandingReservations(db, accountId, producerId, reason, { now = Date.now() } = {}) {
  const r = db.prepare(`UPDATE entry_intents SET state = 'RELEASED', error_code = ?, resolution_source = 'epoch', resolved_at = ?, updated_at = ?
    WHERE account_id = ? AND producer_id = ? AND state = 'RESERVED'`).run(String(reason), iso(now), iso(now), String(accountId), String(producerId))
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
  // THE FENCE IS INJECTABLE (20-09-2026). The VPO producer is retired in
  // lib/entry-producers.js, so its standing-permit logic is unreachable from
  // a test through the real fence. The tests used to lift the retirement mark
  // on the shared inventory object, which another test file can observe —
  // under `--experimental-test-isolation=none` that made the retirement
  // invariant vacuous. The DEFAULT is the real fence; the refusal it produces
  // is asserted at the end of this module's test file.
  admit = admitEntry,
} = {}) {
  const id = accountId != null ? String(accountId) : null
  if (id == null) return { ok: false, reason: 'no_account' }
  if (!side || !['BUY', 'SELL'].includes(String(side).toUpperCase())) return { ok: false, reason: `bad_side: ${side}` }
  if (symbolId == null && !symbol) return { ok: false, reason: 'no_symbol' }
  const sideU = String(side).toUpperCase()
  const tx = db.transaction(() => {
    const a = admit(db, { accountId: id, producerId, basis })
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
        id: permitId, intentId, accountId: Number(id), environment: st.environment,
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
export function resolveIntent(db, intentId, { state, brokerOrderId = null, positionId = null, errorCode = null, clientMsgId = null, source, now = Date.now(), from: fromOverride = null } = {}) {
  if (!INTENT_STATES.includes(state) || OPEN_STATES.includes(state) && state !== 'UNKNOWN' && state !== 'SENT') return { ok: false, reason: `bad_state: ${state}` }
  if (state === 'SENT' && !['ring', 'event'].includes(source)) return { ok: false, reason: 'SENT needs the sidecar\'s evidence' }
  // `from` may name RELEASED only from the ring path (a standing permit the
  // sidecar spent as the epoch moved) — never from a response or an operator.
  if (fromOverride && !(fromOverride.length === 1 && fromOverride[0] === 'RELEASED' && source === 'ring')) return { ok: false, reason: 'bad_from' }
  const from = fromOverride || (state === 'SENT' ? ['RESERVED', 'DISPATCHING'] : OPEN_STATES)
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
  const standingSql = STANDING_PRODUCERS.map(() => '?').join(',')
  const open = db.prepare(`SELECT * FROM entry_intents WHERE account_id = ?
    AND (state IN ('DISPATCHING', 'SENT', 'UNKNOWN') OR (state = 'RESERVED' AND producer_id IN (${standingSql}))
      OR (state = 'RELEASED' AND producer_id IN (${standingSql}) AND resolved_at >= ?)) ORDER BY id`)
    .all(String(accountId), ...STANDING_PRODUCERS, ...STANDING_PRODUCERS, iso(now - RELEASED_RING_WINDOW_MS))
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
      // RACE CHECKER 11-09-2026: the engine rings a TIMEOUT as order_reject
      // (r.ok is false for both). A timeout is not a refusal (plan §3.4):
      // the order may well have filled, so the intent is UNKNOWN — it keeps
      // its key blocked until the event journal or the reconcile settles it —
      // never REJECTED, which would free the key for a second order.
      if (it.state === 'RELEASED' && !rec) { out.stillOpen--; continue } // a released row nothing names is not open
      if (rec?.kind === 'order_reject' && String(rec.code || '').toUpperCase() === 'TIMEOUT') r = resolveIntent(db, it.id, { state: 'UNKNOWN', errorCode: 'TIMEOUT', source: 'ring', now, from: it.state === 'RELEASED' ? ['RELEASED'] : null })
      else if (rec?.kind === 'order_reject') r = resolveIntent(db, it.id, { state: 'REJECTED', errorCode: rec.code || 'rejected', source: 'ring', now, from: it.state === 'RELEASED' ? ['RELEASED'] : null })
      else if (rec?.kind === 'order_result') {
        const pos = /pos=(\d+)/.exec(rec.detail || '')?.[1] ?? null
        const ord = /order=(\d+)/.exec(rec.detail || '')?.[1] ?? null
        r = resolveIntent(db, it.id, { state: pos ? 'FILLED' : 'ACCEPTED', positionId: pos, brokerOrderId: ord, source: 'ring', now, from: it.state === 'RELEASED' ? ['RELEASED'] : null })
      } else if (rec?.kind === 'order_submit' && (it.state === 'RESERVED' || it.state === 'DISPATCHING' || it.state === 'RELEASED')) {
        // RACE CHECKER 11-09-2026: a fire that passed the boundary as the
        // mode switched has a RELEASED row and a real order; the ring is
        // the only thing that names it, so the row is reopened as SENT.
        r = resolveIntent(db, it.id, { state: 'SENT', source: 'ring', now, from: it.state === 'RELEASED' ? ['RELEASED'] : null })
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

// PR-E (owner principle 4, 11-09-2026): an UNKNOWN older than this is
// STALE — listed by the reasons invariant (intent_unknown_stale) and the
// Unknowns block for an operator. It is never auto-REJECTED: the checker's
// finding (B1) is that a deal-history pull is capped (wsGetDeals maxRows
// 500) and a truncated pull would have "proved" absence for a position that
// exists, freeing the key for a duplicate. Absence of evidence is never a
// verdict here; only a matching deal (FILLED) or an operator with a reason
// moves an UNKNOWN.
export const UNKNOWN_MAX_AGE_MS = 4 * 60 * 60 * 1000
// The send window: from the intent's creation to its last transition plus
// the send timeout plus five minutes of broker clock slack. The window
// STARTS at created_at, not updated_at — updated_at is the moment the row
// became UNKNOWN (>= 60 s after the send), and the deal, if there was one,
// executed at the send.
export const DEAL_WINDOW_SLACK_MS = 5 * 60 * 1000
// How many hasMore pages one settle may follow before it reports the pull
// truncated (coverage null). Bounded so a runaway history cannot hold the
// reconcile pass.
export const DEAL_PULL_MAX_PAGES = 20
const DEAL_SIDE = { 1: 'BUY', 2: 'SELL', BUY: 'BUY', SELL: 'SELL' }
// ProtoOADealStatus: FILLED 2, PARTIALLY_FILLED 3 (REJECTED 4,
// INTERNALLY_REJECTED 5, ERROR 6, MISSED 7). A deal that did not fill opened
// nothing; an absent status (an older shape) is not held against it.
const DEAL_STATUS_OK = new Set([2, 3, 'FILLED', 'PARTIALLY_FILLED'])

const dealField = (d, key) => d?.[key] ?? d?.tradeData?.[key]
const dealMs = (d) => { const v = Number(dealField(d, 'executionTimestamp') ?? dealField(d, 'createTimestamp')); return Number.isFinite(v) ? v : null }
const dealLabel = (d) => String(dealField(d, 'label') || dealField(d, 'comment') || '')
const dealFilled = (d) => { const st = dealField(d, 'dealStatus'); return st == null || DEAL_STATUS_OK.has(typeof st === 'string' ? st.toUpperCase() : Number(st)) }
const dealVolume = (d) => { const v = Number(dealField(d, 'filledVolume') ?? dealField(d, 'volume')); return Number.isFinite(v) ? v : null }

/**
 * Resolve UNKNOWN intents from the broker's DEAL HISTORY — the array
 * ProtoOAGetDealListReq returns (`wsGetDeals(...).deal`; the same shape
 * pnl-backfill.js pulls: dealId, orderId, positionId, symbolId, tradeSide
 * 1|2, volume / filledVolume, executionTimestamp ms, executionPrice,
 * dealStatus, closePositionDetail on a closing deal). Only OPENING deals
 * that FILLED (dealStatus FILLED / PARTIALLY_FILLED, or absent) can settle
 * an entry. Two matchers, in order:
 *   1. the intent tag in the deal's label/comment (labelIntentId) — a deal
 *      annotated by a caller that carries the order label; ProtoOADeal
 *      itself has no label field, so this is the exact path when present;
 *   2. account + symbol (symbol_id, else symbol name) + side + a deal
 *      executed inside the intent's send window, whose orderId is not
 *      another intent's broker_order_id on this account (a limit's later
 *      fill is that limit's, never a market intent's), and whose position's
 *      opening volume (summed over partial fills) equals the intent's
 *      volume when the intent carries one.
 * A match → FILLED with the position id, resolution_source 'deal_history'.
 * No match → the row STAYS UNKNOWN, whatever its age; the pull's window,
 * count and coverage are written into error_code after the original
 * reason ("…; deal_history: …") so the Unknowns block and the ledger view
 * say what was looked at. `coverage` ({ fromMs, toMs } of a COMPLETE pull,
 * null when truncated) is recorded, never acted on.
 */
export function resolveUnknownFromDeals(db, { accountId, deals = [], coverage = null, now = Date.now(), sentTimeoutMs = DEFAULT_SENT_TIMEOUT_MS } = {}) {
  const out = { checked: 0, filled: [], stillUnknown: 0, noted: 0 }
  const id = accountId != null ? String(accountId) : null
  if (id == null) return out
  const unknown = db.prepare(`SELECT * FROM entry_intents WHERE account_id = ? AND state = 'UNKNOWN' ORDER BY id`).all(id)
  if (!unknown.length) return out
  const all = Array.isArray(deals) ? deals : []
  const opening = all.filter(d => d && !d.closePositionDetail && dealFilled(d))
  // A position another intent already claimed is not evidence for this one,
  // and a deal filled for another intent's ORDER (a resting limit that
  // filled later) belongs to that intent.
  const claimed = new Set(db.prepare(`SELECT broker_position_id AS pid FROM entry_intents WHERE account_id = ? AND broker_position_id IS NOT NULL`).all(id).map(r => String(r.pid)))
  const foreignOrders = new Set(db.prepare(`SELECT id, broker_order_id AS oid FROM entry_intents WHERE account_id = ? AND broker_order_id IS NOT NULL`).all(id).map(r => `${r.id}:${String(r.oid)}`))
  const orderOfAnother = (intentId, oid) => oid != null && [...foreignOrders].some(k => k.endsWith(`:${String(oid)}`) && !k.startsWith(`${intentId}:`))
  const openVolumeByPosition = new Map()
  for (const d of opening) { const pid = dealField(d, 'positionId'); const v = dealVolume(d); if (pid != null && v != null) openVolumeByPosition.set(String(pid), (openVolumeByPosition.get(String(pid)) || 0) + v) }
  const byTag = new Map()
  for (const d of opening) { const t = labelIntentId(dealLabel(d)); if (t && !byTag.has(t)) byTag.set(t, d) }
  const covFrom = Number(coverage?.fromMs), covTo = Number(coverage?.toMs)
  const covered = (from, to) => Number.isFinite(covFrom) && Number.isFinite(covTo) && covFrom <= from && covTo >= to
  const note = db.prepare(`UPDATE entry_intents SET error_code = ? WHERE id = ? AND state = 'UNKNOWN'`)
  for (const it of unknown) {
    out.checked++
    const createdMs = Date.parse(it.created_at)
    const updatedMs = Date.parse(it.updated_at)
    const winFrom = Number.isFinite(createdMs) ? createdMs : updatedMs
    const winTo = (Number.isFinite(updatedMs) ? updatedMs : winFrom) + sentTimeoutMs + DEAL_WINDOW_SLACK_MS
    let hit = byTag.get(it.id) || null
    let inWindow = 0
    if (!hit) {
      const candidates = opening.filter(d => {
        const pid = dealField(d, 'positionId')
        if (pid == null || claimed.has(String(pid))) return false
        const sideOk = DEAL_SIDE[dealField(d, 'tradeSide')] === String(it.side)
        const symOk = it.symbol_id != null
          ? Number(dealField(d, 'symbolId')) === Number(it.symbol_id)
          : (it.symbol != null && String(dealField(d, 'symbolName') || dealField(d, 'symbol') || '').toUpperCase() === String(it.symbol).toUpperCase())
        const t = dealMs(d)
        if (!(sideOk && symOk && t != null && t >= winFrom && t <= winTo)) return false
        inWindow++
        if (orderOfAnother(it.id, dealField(d, 'orderId'))) return false
        if (it.volume != null && Number(openVolumeByPosition.get(String(pid))) !== Number(it.volume)) return false
        return true
      }).sort((a, b) => (dealMs(a) ?? 0) - (dealMs(b) ?? 0))
      hit = candidates[0] || null
    }
    if (hit) {
      const pid = dealField(hit, 'positionId')
      const r = resolveIntent(db, it.id, { state: 'FILLED', positionId: pid, brokerOrderId: dealField(hit, 'orderId'), source: 'deal_history', now })
      if (r.ok) { claimed.add(String(pid)); out.filled.push({ intentId: it.id, positionId: pid != null ? String(pid) : null, dealId: dealField(hit, 'dealId') != null ? String(dealField(hit, 'dealId')) : null }); continue }
    }
    // m4: what was looked at, on the row — the original reason kept in front.
    const base = String(it.error_code || '').split('; deal_history:')[0]
    const cov = coverage == null ? 'truncated or none' : covered(winFrom, winTo) ? 'complete' : 'partial'
    const text = `${base}; deal_history: ${all.length} deal(s) pulled, ${inWindow} on this key in window ${iso(winFrom)}–${iso(winTo)}, none matched, coverage ${cov}, read ${iso(now)}`
    try { if (note.run(text.slice(0, 500), it.id).changes === 1) out.noted++ } catch { /* the note is a record, never a reason to fail the pass */ }
    out.stillUnknown++
  }
  return out
}

/**
 * The reconcile pass's caller: pulls the deal history ONLY when the account
 * holds an UNKNOWN (one pull per pass, never per intent), covering every
 * open window, and hands it to resolveUnknownFromDeals with the coverage the
 * pull actually achieved. `getDeals(fromMs, toMs)` resolves to
 * ProtoOAGetDealListRes ({ deal: [...], hasMore }) — wsGetDeals in
 * production (maxRows 500), a fake in tests. A page that says hasMore is
 * followed from its last deal's timestamp; past DEAL_PULL_MAX_PAGES the pull
 * is reported TRUNCATED and coverage is null — a fact, not an assertion. A
 * pull that throws settles nothing.
 */
export async function settleUnknownsFromDealHistory(db, { accountId, getDeals, now = Date.now(), sentTimeoutMs = DEFAULT_SENT_TIMEOUT_MS, maxPages = DEAL_PULL_MAX_PAGES } = {}) {
  const id = accountId != null ? String(accountId) : null
  if (id == null || typeof getDeals !== 'function') return { checked: 0, filled: [], stillUnknown: 0, noted: 0, pulled: 0, skipped: 'no_account_or_getter' }
  const oldest = db.prepare(`SELECT MIN(created_at) AS at, COUNT(*) AS n FROM entry_intents WHERE account_id = ? AND state = 'UNKNOWN'`).get(id)
  if (!oldest?.n) return { checked: 0, filled: [], stillUnknown: 0, noted: 0, pulled: 0, skipped: 'no_unknown' }
  const oldestMs = Date.parse(oldest.at)
  const fromMs = (Number.isFinite(oldestMs) ? oldestMs : now) - DEAL_WINDOW_SLACK_MS
  // THE WALK MOVED TO lib/deal-paging.js, which this loop was the model for —
  // the other two callers in the repo never read `hasMore` at all. Two things
  // changed in the move, both fixes:
  //
  //   - the cursor lands ON the last deal's timestamp instead of `last + 1`,
  //     so deals sharing that millisecond (a partial fill) are no longer
  //     skipped; the overlap is dropped by dealId instead;
  //   - the page budget is per WINDOW rather than per walk, so one busy week
  //     early in a long span no longer starves every week after it.
  const pull = await pageDeals(getDeals, fromMs, now, { maxPages })
  const deals = pull.deals
  const pages = pull.pages
  const truncated = !pull.complete
  const coverage = truncated ? null : { fromMs, toMs: now }
  const r = resolveUnknownFromDeals(db, { accountId: id, deals, coverage, now, sentTimeoutMs })
  return { ...r, pulled: deals.length, pages, truncated, coverage: coverage ? { from: iso(fromMs), to: iso(now) } : null }
}

/** An operator's word, with a reason, is the last resolver of an UNKNOWN intent. */
export function operatorResolve(db, intentId, { state, reason, positionId = null, actor = 'owner', now = Date.now() } = {}) {
  if (!['FILLED', 'ACCEPTED', 'REJECTED', 'RELEASED'].includes(state)) return { ok: false, reason: `bad_state: ${state}` }
  if (!reason || String(reason).trim().length < 3) return { ok: false, reason: 'reason_required' }
  const row = db.prepare('SELECT * FROM entry_intents WHERE id = ?').get(String(intentId))
  if (!row) return { ok: false, reason: 'intent_unknown' }
  // m1: a FILLED verdict may name the position the operator read at the
  // broker; it rides onto the row like the reconcile's would.
  const pid = state === 'FILLED' && positionId != null && String(positionId).trim() !== '' ? String(positionId).trim() : null
  const r = resolveIntent(db, intentId, { state, positionId: pid, errorCode: `operator: ${String(reason).slice(0, 200)}`, source: 'operator', now })
  if (r.ok) audit(db, '/entry-intents/resolve', { intentId, from: row.state, to: state, reason, positionId: pid, actor }, row.account_id)
  return r.ok ? { ok: true, from: row.state, to: state, ...(pid ? { positionId: pid } : {}) } : { ok: false, reason: `not_open: ${row.state}` }
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
