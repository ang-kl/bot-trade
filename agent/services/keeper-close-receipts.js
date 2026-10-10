// Codex · №13,025 · 2026-10-10; codex-footprint: keeper-owned-close-receipts.
// Keeper policy remains in its caller. Only owned execution bookkeeping lives
// here: persist before send, prove the actual fill and fresh residual, commit
// once. Uncertainty never authorizes resubmission or a successful latch.
import { partialClosingEvidence, partialAcceptedEvidence, partialPositionPresence,
  classifyCloseFailure, MAX_CLOCK_SKEW_MS } from './momentum-broker-evidence.js'
import { sameTicks } from './momentum-target-policy.js'
import { recordPositionEvent } from './position-events.js'

const id = value => typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0) ? null
  : /^(?:[1-9]\d{0,19})$/.test(String(value ?? '')) ? String(value) : null
const side = value => ['BUY', 'LONG', '1'].includes(String(value).toUpperCase()) ? 'BUY'
  : ['SELL', 'SHORT', '2'].includes(String(value).toUpperCase()) ? 'SELL' : null
const positiveInteger = value => Number.isSafeInteger(value) && value > 0
const pending = new Set(['SENDING', 'AMBIGUOUS', 'RECEIVED'])
const initialized = new WeakSet()
const held = reason => ({ pending: true, reason })
function schema(db) {
  if (initialized.has(db)) return
  db.exec(`CREATE TABLE IF NOT EXISTS keeper_close_attempts (
    id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, position_id TEXT NOT NULL,
    trade_id INTEGER NOT NULL, monitor_id INTEGER NOT NULL, state TEXT NOT NULL,
    attempted_at INTEGER NOT NULL, plan_json TEXT NOT NULL, raw_json TEXT,
    receipt_json TEXT, residual_json TEXT, reason TEXT, confirmed_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_keeper_close_owner ON keeper_close_attempts(account_id,position_id,id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_keeper_close_pending ON keeper_close_attempts(account_id,position_id)
      WHERE state IN ('SENDING','AMBIGUOUS','RECEIVED');`)
  initialized.add(db)
}
function unpack(row) {
  return row && { ...row, plan: JSON.parse(row.plan_json),
    raw: row.raw_json && JSON.parse(row.raw_json), receipt: row.receipt_json && JSON.parse(row.receipt_json) }
}
export function readKeeperClose(db, accountId, positionId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='keeper_close_attempts'").get()) return null
  return unpack(db.prepare('SELECT * FROM keeper_close_attempts WHERE account_id=? AND position_id=? ORDER BY id DESC LIMIT 1')
    .get(String(accountId), String(positionId)))
}
// Ordinary reconciliation may close the monitor before a retained full-close
// receipt can commit. These are bookkeeping candidates, never new decisions.
export function pendingKeeperClosedMonitorIds(db, accountId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='keeper_close_attempts'").get()) return []
  return db.prepare(`SELECT a.monitor_id,a.plan_json FROM keeper_close_attempts a
    JOIN monitored_positions m ON m.id=a.monitor_id AND (m.account_id IS NULL OR m.account_id=a.account_id)
    WHERE a.account_id=? AND m.status='closed' AND a.state IN ('SENDING','AMBIGUOUS','RECEIVED')`)
    .all(String(accountId)).filter(row => {
      try { return JSON.parse(row.plan_json).kind === 'close' && positiveInteger(row.monitor_id) }
      catch { return false }
    }).map(row => row.monitor_id)
}
function owner(db, x) {
  const row = db.prepare(`SELECT m.id,m.trade_id,m.account_id,m.symbol,m.side,m.status,m.scaled_out,
    t.account_id trade_account,t.ctrader_position_id,t.symbol trade_symbol,t.side trade_side,t.status trade_status
    FROM monitored_positions m JOIN trades t ON t.id=m.trade_id WHERE m.id=?`).get(x.monitorId)
  // The existing acting boundary admits unstamped legacy rows only with this
  // account's fresh broker proof. Retain that eligibility; reject any stamp
  // that contradicts the attempt, and never invent/rewrite a ledger stamp.
  return row && row.trade_id === x.tradeId && (row.account_id == null || id(row.account_id) === x.accountId)
    && (row.trade_account == null || id(row.trade_account) === x.accountId) && id(row.ctrader_position_id) === x.positionId
    && row.symbol === x.symbol && row.trade_symbol === x.symbol
    && side(row.side) === x.side && side(row.trade_side) === x.side ? row : null
}
function bindings(raw, p) {
  for (const record of [raw, raw?.order, raw?.position, raw?.deal]) {
    if (!record) continue
    for (const field of ['ctidTraderAccountId', 'accountId']) {
      if (record[field] != null && id(record[field]) !== p.accountId) return false
    }
    if (record.host != null && record.host !== p.host) return false
    if (record.positionId != null && id(record.positionId) !== p.positionId) return false
    if (record.symbolId != null && id(record.symbolId) !== p.identity.symbolId) return false
  }
  if (raw?.order?.tradeData?.symbolId != null && id(raw.order.tradeData.symbolId) !== p.identity.symbolId) return false
  if (raw?.position?.tradeData?.symbolId != null && id(raw.position.tradeData.symbolId) !== p.identity.symbolId) return false
  if (raw?.position?.tradeData?.tradeSide != null && side(raw.position.tradeData.tradeSide) !== p.side) return false
  return true
}
function presence(raw, p, nowMs) {
  if (!bindings(raw, p)) return null
  for (const position of Array.isArray(raw?.position) ? raw.position : []) {
    if (id(position?.positionId) === p.positionId && !bindings({ position }, p)) return null
  }
  return partialPositionPresence(raw, { identity: p.identity, positionId: p.positionId, nowMs })
}
function decode(raw, attempt, nowMs) {
  const p = attempt.plan, d = raw?.deal, n = d?.filledVolume, close = d?.closePositionDetail
  if (!positiveInteger(n) || n > p.requested || raw.error || raw.errorCode || !bindings(raw, p)) return null
  if (raw.order?.orderId != null && id(raw.order.orderId) !== id(d.orderId)) return null
  const context = { identity: p.identity, positionId: p.positionId, side: p.side,
    entry: p.before.entry, digits: p.digits, closeVolume: n,
    attemptedAtMs: attempt.attempted_at - MAX_CLOCK_SKEW_MS, nowMs: nowMs + MAX_CLOCK_SKEW_MS }
  const exact = partialClosingEvidence(raw, context)
  if (exact) return exact
  // A completed underfill can retain requested quantity as d.volume. It is
  // only an upper bound; filledVolume and closePositionDetail must agree.
  if (id(raw.ctidTraderAccountId) !== p.accountId || raw.alreadyClosed || ![3, 'ORDER_FILLED'].includes(raw.executionType)
    || !id(d.dealId) || !id(d.orderId) || id(d.positionId) !== p.positionId || id(d.symbolId) !== p.identity.symbolId
    || ![2, 'FILLED'].includes(d.dealStatus) || side(d.tradeSide) !== (p.side === 'BUY' ? 'SELL' : 'BUY')
    || !positiveInteger(d.volume) || d.volume < n || d.volume > p.requested || close?.closedVolume !== n
    || !(typeof d.executionPrice === 'number' && Number.isFinite(d.executionPrice) && d.executionPrice > 0)
    || !sameTicks(close.entryPrice, p.before.entry, p.digits) || !Number.isSafeInteger(d.executionTimestamp)
    || d.executionTimestamp < context.attemptedAtMs || d.executionTimestamp > context.nowMs) return null
  return { ...p.identity, positionId: p.positionId, dealId: id(d.dealId), orderId: id(d.orderId),
    closedVolume: n, price: d.executionPrice, executedAtMs: d.executionTimestamp }
}

export async function runKeeperClose(db, input, deps) {
  const x = { ...input, accountId: id(input.accountId), positionId: id(input.positionId), side: side(input.side) }
  if (!x.accountId || !x.positionId || !x.side || !positiveInteger(x.tradeId) || !positiveInteger(x.monitorId))
    return held('keeper_owner_unverified')
  let attempt = readKeeperClose(db, x.accountId, x.positionId)
  if (attempt && (attempt.trade_id !== x.tradeId || attempt.monitor_id !== x.monitorId
    || attempt.plan.symbol !== x.symbol || attempt.plan.side !== x.side || attempt.plan.host !== x.host))
    return held('keeper_attempt_identity_conflict')
  const recovery = !!attempt && pending.has(attempt.state)
  // A later genuine full exit is still allowed after a confirmed keeper
  // partial. No unresolved attempt can open that second submission.
  const nextClose = attempt?.state === 'CONFIRMED' && attempt.plan.kind === 'scale_out' && input.kind === 'close'
  if (attempt?.state === 'CONFIRMED' && !nextClose) return { skipped: true, confirmed: true }
  if (attempt && !recovery && attempt.state !== 'REJECTED' && !nextClose) return held('keeper_attempt_state_unverified')
  if (!recovery) {
    if (input.recoverOnly) return { skipped: true }
    if (!['scale_out', 'close'].includes(input.kind)) return held('keeper_action_unverified')
    const owned = owner(db, x)
    if (!owned || owned.status !== 'active' || owned.trade_status !== 'open') return held('keeper_owner_changed')
    if (input.kind === 'scale_out' && owned.scaled_out === 1) return { skipped: true }
    const meta = input.meta, now = deps.now || Date.now
    const identity = { accountId: x.accountId, host: x.host, symbolId: id(input.symbolId) }
    if (!identity.symbolId || !positiveInteger(meta?.lotSize) || !Number.isInteger(meta.brokerDigits)
      || meta.brokerDigits < 0 || meta.brokerDigits > 10) return held('keeper_metadata_unverified')
    const before = presence(await deps.reconcile(), { ...x, identity }, now())
    if (!before || before.absent || before.side !== x.side || before.entry !== input.entry
      || before.volume !== input.beforeVolume) return held('keeper_pre_submit_basis_changed')
    const requested = input.volume
    if (!positiveInteger(requested) || requested > before.volume
      || input.kind === 'scale_out' && requested >= before.volume
      || input.kind === 'close' && requested !== before.volume) return held('keeper_request_unverified')
    const plan = { accountId: x.accountId, positionId: x.positionId, tradeId: x.tradeId,
      monitorId: x.monitorId, symbol: x.symbol, side: x.side, host: x.host,
      kind: input.kind, reason: input.reason, identity, before, requested,
      lotSize: meta.lotSize, digits: meta.brokerDigits }
    schema(db)
    const claimed = db.transaction(() => {
      const previous = readKeeperClose(db, x.accountId, x.positionId), currentOwner = owner(db, x)
      if ((previous?.id ?? null) !== (attempt?.id ?? null) || previous && pending.has(previous.state)
        || !currentOwner || currentOwner.status !== 'active' || currentOwner.trade_status !== 'open'
        || input.kind === 'scale_out' && currentOwner.scaled_out === 1) return null
      const result = db.prepare(`INSERT INTO keeper_close_attempts(account_id,position_id,trade_id,monitor_id,state,attempted_at,plan_json)
        VALUES(?,?,?,?,'SENDING',?,?)`).run(x.accountId,x.positionId,x.tradeId,x.monitorId,now(),JSON.stringify(plan))
      return unpack(db.prepare('SELECT * FROM keeper_close_attempts WHERE id=?').get(result.lastInsertRowid))
    })()
    if (!claimed) return held('keeper_claim_changed')
    attempt = claimed
    let raw
    try { raw = await deps.close({ positionId: x.positionId, volume: requested }) }
    catch (error) {
      const failure = classifyCloseFailure(error), rejected = ['not_sent', 'rejected'].includes(failure.kind)
      db.prepare("UPDATE keeper_close_attempts SET state=?,reason=? WHERE id=? AND state='SENDING'")
        .run(rejected ? 'REJECTED' : 'AMBIGUOUS', failure.code || 'close_outcome_unknown', attempt.id)
      return held(rejected ? 'keeper_close_rejected' : 'keeper_close_outcome_unknown')
    }
    // If retention fails, SENDING remains durable. Even a broker fill cannot
    // make the next delivery submit again without its retained receipt.
    db.prepare("UPDATE keeper_close_attempts SET raw_json=?,state='AMBIGUOUS' WHERE id=? AND state='SENDING'")
      .run(JSON.stringify(raw ?? null), attempt.id)
    attempt = readKeeperClose(db, x.accountId, x.positionId)
  }
  const now = deps.now || Date.now, p = attempt.plan
  const unresolved = reason => {
    db.prepare('UPDATE keeper_close_attempts SET reason=? WHERE id=? AND (reason IS NULL OR reason<>?)')
      .run(reason, attempt.id, reason)
    return held(reason)
  }
  const context = { identity: p.identity, positionId: p.positionId, side: p.side,
    entry: p.before.entry, digits: p.digits, closeVolume: p.requested,
    attemptedAtMs: attempt.attempted_at, nowMs: now() }
  let receipt = attempt.receipt || decode(attempt.raw, attempt, now())
  if (attempt.receipt && (id(receipt.accountId) !== p.accountId || receipt.host !== p.host
    || id(receipt.positionId) !== p.positionId || id(receipt.symbolId) !== p.identity.symbolId
    || !id(receipt.dealId) || !id(receipt.orderId) || !positiveInteger(receipt.closedVolume)
    || receipt.closedVolume > p.requested || !(receipt.price > 0) || !Number.isFinite(receipt.price)
    || !Number.isSafeInteger(receipt.executedAtMs) || receipt.executedAtMs < attempt.attempted_at - MAX_CLOCK_SKEW_MS
    || receipt.executedAtMs > now() + MAX_CLOCK_SKEW_MS)) return unresolved('keeper_stored_receipt_unverified')
  const accepted = bindings(attempt.raw, p) && partialAcceptedEvidence(attempt.raw, context)
  if (!receipt && accepted?.orderId) {
    const history = await deps.deals(p.positionId)
    if (id(history?.ctidTraderAccountId) === x.accountId && history.hasMore === false
      && !history.error && !history.errorCode && bindings(history, p) && Array.isArray(history.deal)) {
      const matching = history.deal.filter(d => id(d?.orderId) === accepted.orderId)
      if (matching.length === 1) receipt = decode({ ctidTraderAccountId: history.ctidTraderAccountId,
        executionType: 3, deal: matching[0] }, attempt, now())
    }
  }
  if (!receipt) return unresolved('keeper_fill_unconfirmed')
  if (!attempt.receipt) {
    db.prepare("UPDATE keeper_close_attempts SET state='RECEIVED',receipt_json=?,reason=NULL WHERE id=? AND state IN ('SENDING','AMBIGUOUS')")
      .run(JSON.stringify(receipt), attempt.id)
  }
  const residual = presence(await deps.reconcile(), p, now())
  if (!residual || p.kind === 'close' && (!residual.absent || receipt.closedVolume !== p.before.volume)
    || p.kind === 'scale_out' && (residual.absent || residual.side !== p.side || residual.entry !== p.before.entry
      || residual.volume !== p.before.volume - receipt.closedVolume)) return unresolved('keeper_residual_unconfirmed')
  return db.transaction(() => {
    const current = readKeeperClose(db, x.accountId, x.positionId), currentOwner = owner(db, x)
    if (current?.id !== attempt.id || current.state !== 'RECEIVED') return held('keeper_confirmation_changed')
    if (!currentOwner || (p.kind === 'close' ? !['active','closed'].includes(currentOwner.status)
      : currentOwner.status !== 'active' || currentOwner.trade_status !== 'open')) return held('keeper_owner_changed')
    if (p.kind === 'scale_out') {
      if (db.prepare('UPDATE trades SET volume=? WHERE id=? AND (account_id IS NULL OR account_id=?) AND ctrader_position_id=?')
        .run(residual.volume / p.lotSize, p.tradeId, p.accountId, p.positionId).changes !== 1) throw Error('keeper_trade_write_failed')
      if (db.prepare(`UPDATE monitored_positions SET scaled_out=1,broker_volume_units=?,
        last_check_action='profit_keeper_scaleout',last_check_at=datetime('now') WHERE id=? AND (account_id IS NULL OR account_id=?) AND trade_id=?`)
        .run(residual.volume / 100, p.monitorId, p.accountId, p.tradeId).changes !== 1) throw Error('keeper_monitor_write_failed')
    } else {
      if (db.prepare("UPDATE monitored_positions SET last_check_action='profit_keeper_close',last_check_at=datetime('now') WHERE id=? AND (account_id IS NULL OR account_id=?) AND trade_id=?")
        .run(p.monitorId, p.accountId, p.tradeId).changes !== 1) throw Error('keeper_monitor_write_failed')
    }
    if (!recordPositionEvent(db, { accountId: p.accountId, positionId: p.positionId, tradeId: p.tradeId,
      symbol: p.symbol, kind: p.kind, toValue: receipt.closedVolume, priceAt: receipt.price,
      reason: p.reason, source: 'profit_keeper', detail: { attemptId: attempt.id,
        requestedVolume: p.requested, receipt, residual } })) throw Error('keeper_journal_not_committed')
    if (db.prepare("UPDATE keeper_close_attempts SET state='CONFIRMED',residual_json=?,confirmed_at=?,reason=NULL WHERE id=? AND state='RECEIVED'")
      .run(JSON.stringify(residual), now(), attempt.id).changes !== 1) throw Error('keeper_attempt_write_failed')
    return { committed: true, kind: p.kind, receipt, residual, totalUnits: p.before.volume, recovered: recovery }
  })()
}
