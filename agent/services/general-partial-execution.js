// Codex · №12,637 · 2026-10-09; codex-footprint: verified-general-partial.
// General PM partials only. Commit before send; an uncertain close is never
// resent. Receipt, residual, volume, latch and journal are separate from SL.
import { partialClosingEvidence, partialAcceptedEvidence, partialPositionPresence,
  classifyCloseFailure, MAX_CLOCK_SKEW_MS } from './momentum-broker-evidence.js'
import { recordPositionEvent } from './position-events.js'

const initialized = new WeakSet()
const id = x => /^(?:[1-9]\d*)$/.test(String(x ?? '')) ? String(x) : null
const side = x => ['BUY', 'long', 1].includes(x) ? 'BUY' : ['SELL', 'short', 2].includes(x) ? 'SELL' : null
const integer = x => Number.isSafeInteger(x) && x > 0
const pending = new Set(['SENDING', 'AMBIGUOUS', 'RECEIVED'])
function schema(db) {
  if (initialized.has(db)) return
  db.exec(`CREATE TABLE IF NOT EXISTS general_partial_attempts (
    id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, position_id TEXT NOT NULL,
    trade_id INTEGER NOT NULL, monitor_id INTEGER NOT NULL, state TEXT NOT NULL,
    attempted_at INTEGER NOT NULL, plan_json TEXT NOT NULL, raw_json TEXT,
    receipt_json TEXT, residual_json TEXT, reason TEXT, confirmed_at INTEGER, checked_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_general_partial_owner ON general_partial_attempts(account_id,position_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_general_partial_state ON general_partial_attempts(state,id);`)
  initialized.add(db)
}
function unpack(row) {
  return row && { ...row, plan: JSON.parse(row.plan_json), receipt: row.receipt_json && JSON.parse(row.receipt_json),
    raw: row.raw_json && JSON.parse(row.raw_json) }
}
export function readGeneralPartial(db, accountId, positionId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='general_partial_attempts'").get()) return null
  return unpack(db.prepare('SELECT * FROM general_partial_attempts WHERE account_id=? AND position_id=? ORDER BY id DESC LIMIT 1')
    .get(String(accountId), String(positionId)))
}
export function pendingGeneralPartialPositions(db) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='general_partial_attempts'").get()) return []
  return db.prepare(`SELECT m.* FROM general_partial_attempts a JOIN monitored_positions m ON m.id=a.monitor_id
    WHERE a.state IN ('SENDING','AMBIGUOUS','RECEIVED') AND m.status='active'
    ORDER BY COALESCE(a.checked_at,0),a.id LIMIT 1`).all()
}
// The evaluator proposes latches; it cannot attest an execution. Shared by
// both real monitoring callers, while all non-partial metrics stay unchanged.
export function recordEvaluationMetrics(s, pos, evaluation) {
  const u = evaluation.updates || {}, partial = evaluation.action === 'PARTIAL_EXIT'
  s.updatePositionMetrics.run(u.mfe_r ?? pos.mfe_r ?? 0, u.mae_r ?? pos.mae_r ?? 0,
    partial ? pos.be_moved ?? 0 : u.be_moved ?? pos.be_moved ?? 0,
    partial ? pos.scaled_out ?? 0 : u.scaled_out ?? pos.scaled_out ?? 0, pos.id)
}
function ownedRows(db, x) {
  const row = db.prepare(`SELECT m.id,m.trade_id,m.account_id,m.symbol,m.side,m.status,m.source,
    t.account_id trade_account,t.ctrader_position_id,t.symbol trade_symbol,t.side trade_side,t.status trade_status
    FROM monitored_positions m JOIN trades t ON t.id=m.trade_id WHERE m.id=?`).get(x.monitorId)
  return row && row.trade_id === x.tradeId && id(row.account_id) === x.accountId && id(row.trade_account) === x.accountId
    && id(row.ctrader_position_id) === x.positionId && row.symbol === x.symbol && row.trade_symbol === x.symbol
    && side(row.side) === x.side && side(row.trade_side) === x.side ? row : null
}
const held = reason => ({ skipped: true, pending: true, reason })

export async function runGeneralPartial(db, input, deps) {
  const x = { ...input, accountId: id(input.accountId), positionId: id(input.positionId), side: side(input.side) }
  if (!x.accountId || !x.positionId || !x.side || !integer(x.tradeId) || !integer(x.monitorId))
    return { skipped: true, reason: 'partial_identity_unverified' }
  schema(db)
  let attempt = readGeneralPartial(db, x.accountId, x.positionId)
  if (attempt && (attempt.trade_id !== x.tradeId || attempt.monitor_id !== x.monitorId
    || attempt.plan.symbol !== x.symbol || attempt.plan.side !== x.side || attempt.plan.host !== x.host))
    return held('partial_attempt_identity_conflict')
  if (attempt?.state === 'CONFIRMED') return { skipped: true, reason: 'partial_already_confirmed', partialConfirmed: true }
  if (attempt && !pending.has(attempt.state) && attempt.state !== 'REJECTED') return held(attempt.reason || attempt.state)
  const now = deps.now || Date.now
  if (!attempt || attempt.state === 'REJECTED') {
    if (input.recoverOnly) return { skipped: true, reason: 'no_pending_partial' }
    const owner = ownedRows(db, x)
    if (!owner || owner.status !== 'active' || owner.trade_status !== 'open' || owner.source === 'external')
      return { skipped: true, reason: 'partial_owner_changed' }
    const { raw, meta } = await deps.prepare()
    const symbolId = id(meta?.symbolId), identity = { accountId: x.accountId, host: x.host, symbolId }
    const before = partialPositionPresence(raw, { identity, positionId: x.positionId, nowMs: now() })
    if (!before || before.absent || before.side !== x.side || !integer(meta?.lotSize)
      || !Number.isInteger(meta.brokerDigits) || meta.brokerDigits < 0 || meta.brokerDigits > 10)
      return { skipped: true, reason: 'partial_broker_basis_unverified' }
    const fraction = input.fraction ?? 0.5
    if (!(fraction > 0 && fraction < 1)) return { skipped: true, reason: 'partial_fraction_invalid' }
    let requested = Math.round(before.volume * fraction)
    if (meta.stepVolume) requested = Math.floor(requested / meta.stepVolume) * meta.stepVolume
    const unfillable = !integer(requested) ? 'unknown_volume'
      : meta.minVolume != null && requested < meta.minVolume ? 'partial_below_min_volume' : null
    if (unfillable) return { skipped: true, reason: unfillable, unfillable: true }
    if (requested >= before.volume) return { skipped: true, reason: 'partial_has_no_residual' }
    const plan = { ...x, identity, before, requested, lotSize: meta.lotSize, digits: meta.brokerDigits,
      bankPartialAt: input.bankPartialAt ?? null }
    const claimed = db.transaction(() => {
      const prior = readGeneralPartial(db, x.accountId, x.positionId)
      if ((prior?.id ?? null) !== (attempt?.id ?? null) || prior && prior.state !== 'REJECTED') return null
      const fresh = ownedRows(db, x)
      if (!fresh || fresh.status !== 'active' || fresh.trade_status !== 'open' || fresh.source === 'external') return null
      const at = now()
      const row = db.prepare(`INSERT INTO general_partial_attempts(account_id,position_id,trade_id,monitor_id,state,attempted_at,plan_json)
        VALUES(?,?,?,?,'SENDING',?,?)`).run(x.accountId,x.positionId,x.tradeId,x.monitorId,at,JSON.stringify(plan))
      return unpack(db.prepare('SELECT * FROM general_partial_attempts WHERE id=?').get(row.lastInsertRowid))
    })()
    if (!claimed) return held('partial_claim_changed')
    attempt = claimed
    let rawReply
    try { rawReply = await deps.close({ positionId: x.positionId, volume: requested }) }
    catch (error) {
      const failure = classifyCloseFailure(error)
      const rejected = ['not_sent','rejected'].includes(failure.kind)
      db.prepare('UPDATE general_partial_attempts SET state=?,reason=? WHERE id=? AND state=\'SENDING\'')
        .run(rejected ? 'REJECTED' : 'AMBIGUOUS', failure.code || 'close_outcome_unknown', attempt.id)
      return rejected ? { error: error.message } : held('partial_close_outcome_unknown')
    }
    // The broker result is retained before decoding; failed persistence leaves
    // the durable SENDING claim intact, so neither caller can blindly resend.
    db.prepare("UPDATE general_partial_attempts SET raw_json=?,state='AMBIGUOUS' WHERE id=? AND state='SENDING'")
      .run(JSON.stringify(rawReply ?? null), attempt.id)
    attempt = readGeneralPartial(db, x.accountId, x.positionId)
  }
  db.prepare('UPDATE general_partial_attempts SET checked_at=? WHERE id=?').run(now(), attempt.id)
  const unresolved = reason => {
    db.prepare('UPDATE general_partial_attempts SET reason=? WHERE id=? AND (reason IS NULL OR reason<>?)').run(reason, attempt.id, reason)
    return held(reason)
  }
  const p = attempt.plan
  const context = closeVolume => ({ identity: p.identity, positionId: x.positionId, side: p.side,
    entry: p.before.entry, digits: p.digits, closeVolume, attemptedAtMs: attempt.attempted_at,
    nowMs: now(), maxAgeMs: 5000 })
  const decode = raw => {
    const n = raw?.deal?.filledVolume
    if (!integer(n) || n > p.requested) return null
    return partialClosingEvidence(raw, context(n))
  }
  let receipt = attempt.receipt || decode(attempt.raw)
  const accepted = partialAcceptedEvidence(attempt.raw, context(p.requested))
  if (!receipt && accepted?.orderId) {
    const history = await deps.deals(x.positionId)
    if (id(history?.ctidTraderAccountId) === x.accountId && history.hasMore === false
      && !history.error && !history.errorCode && Array.isArray(history.deal)) {
      const matching = history.deal.filter(d => id(d?.orderId) === accepted.orderId)
      // More than one deal needs a complete aggregate contract, not an
      // arbitrary first match. It remains unresolved, without another send.
      if (matching.length === 1) {
        const d = matching[0], at = d.executionTimestamp
        if (Number.isSafeInteger(at) && at >= attempt.attempted_at - MAX_CLOCK_SKEW_MS && at <= now() + MAX_CLOCK_SKEW_MS) {
          const c = context(d.filledVolume)
          receipt = integer(d.filledVolume) && d.filledVolume <= p.requested
            ? partialClosingEvidence({ ctidTraderAccountId: history.ctidTraderAccountId, executionType: 3, deal: d },
              { ...c, attemptedAtMs: attempt.attempted_at - MAX_CLOCK_SKEW_MS, nowMs: now() + MAX_CLOCK_SKEW_MS }) : null
        }
      }
    }
  }
  if (!receipt) return unresolved(accepted ? 'partial_fill_not_confirmed' : 'partial_receipt_unconfirmed')
  if (!attempt.receipt) {
    db.prepare("UPDATE general_partial_attempts SET state='RECEIVED',receipt_json=?,reason=NULL WHERE id=? AND state IN ('SENDING','AMBIGUOUS')")
      .run(JSON.stringify(receipt), attempt.id)
  }
  const rawPosition = await deps.reconcile()
  const residual = partialPositionPresence(rawPosition, context(receipt.closedVolume))
  if (!residual || residual.absent || residual.side !== p.side || residual.entry !== p.before.entry
    || residual.volume !== p.before.volume - receipt.closedVolume) return unresolved('partial_residual_unconfirmed')
  const result = db.transaction(() => {
    const current = readGeneralPartial(db, x.accountId, x.positionId), owner = ownedRows(db, x)
    if (current?.id !== attempt.id || current.state !== 'RECEIVED') return held('partial_confirmation_changed')
    if (!owner || owner.status !== 'active' || owner.trade_status !== 'open') return held('partial_owner_changed')
    db.prepare('UPDATE trades SET volume=? WHERE id=? AND account_id=? AND ctrader_position_id=?')
      .run(residual.volume / p.lotSize, x.tradeId, x.accountId, x.positionId)
    db.prepare(`UPDATE monitored_positions SET scaled_out=1,broker_volume_units=?,
      bank_partial_at=COALESCE(bank_partial_at,?) WHERE id=? AND account_id=? AND trade_id=?`)
      .run(residual.volume, p.bankPartialAt, x.monitorId, x.accountId, x.tradeId)
    const recorded = recordPositionEvent(db, { accountId: x.accountId, positionId: x.positionId,
      tradeId: x.tradeId, symbol: x.symbol, kind: 'scale_out', toValue: receipt.closedVolume,
      priceAt: receipt.price, reason: p.reason, source: p.source,
      detail: { attemptId: attempt.id, receipt, residual, requestedVolume: p.requested } })
    if (!recorded) throw Error('partial_journal_not_committed')
    db.prepare("UPDATE general_partial_attempts SET state='CONFIRMED',residual_json=?,confirmed_at=?,reason=NULL WHERE id=? AND state='RECEIVED'")
      .run(JSON.stringify(residual), now(), attempt.id)
    return { partialConfirmed: true, closedUnits: receipt.closedVolume, totalUnits: p.before.volume,
      remainingUnits: residual.volume, lotSize: p.lotSize, recovered: input.recoverOnly === true }
  })()
  return result
}
