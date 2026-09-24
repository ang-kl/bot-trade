import { randomUUID } from 'node:crypto'
import { credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { wsReconcile } from '../lib/ctrader-ws.js'
import { marketIdentityKey } from '../lib/market-identity.js'
import { readPartialPlan } from './momentum-partial-manager.js'
import { readPartialOwnership } from './momentum-partial-ownership.js'
import { planMomentumTargets } from './momentum-target-policy.js'
import { partialPositionEvidence, partialClosingEvidence } from './momentum-broker-evidence.js'

const parse = value => { try { return JSON.parse(value) } catch { return null } }
function schema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS momentum_rank_exits (
    account_id TEXT NOT NULL, trade_id INTEGER NOT NULL, position_id TEXT NOT NULL,
    token TEXT NOT NULL, prior_state TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, attempted_at INTEGER, volume INTEGER NOT NULL,
    receipt_json TEXT, reason TEXT, PRIMARY KEY(account_id,trade_id)
  )`)
}

/** The two book rank-exit paths share this boundary. Plans absent means the
 * established caller still owns its old behavior. No producer is activated.
 */
export async function runMomentumRankExit(db, supplied, book, deps = {}) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='momentum_partial_plans'").get()) return { handled: false }
  const accountId = String(supplied?.accountId ?? ''), tradeId = book?.trade_id
  const stored = readPartialPlan(db, accountId, tradeId)
  if (!stored) return { handled: false }
  const p = stored.plan, positionId = stored.position_id
  if (!p || p.mode !== 'partial_runner' || !marketIdentityKey(stored.identity) || supplied.host !== stored.identity.host
    || book.account_id !== accountId || String(book.position_id) !== positionId
    || JSON.stringify(planMomentumTargets(p)) !== JSON.stringify(p)) throw Error('rank exit plan identity invalid')
  const now = deps.now || Date.now, timeoutMs = deps.timeoutMs ?? 5000
  if (!Number.isSafeInteger(now()) || !(timeoutMs > 0) || timeoutMs > 5000) throw Error('rank exit request budget invalid')
  const bounded = async work => {
    let timer
    try { return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('rank exit deadline exceeded')), timeoutMs)
    })]) } finally { clearTimeout(timer) }
  }
  const credentials = () => {
    const current = deps.readCredentials ? deps.readCredentials(accountId) : credsForRegisteredAccount(db, accountId)
    if (!current?.ready || String(current.accountId) !== accountId || current.host !== stored.identity.host
      || ['host', 'clientId', 'clientSecret', 'accessToken'].some(k => current[k] !== supplied[k])) throw Error('rank exit credentials changed')
    return current
  }
  const owned = () => {
    const o = deps.readOwnership ? deps.readOwnership(accountId, tradeId, positionId) : readPartialOwnership(db, accountId, tradeId, positionId)
    return o?.accountId === accountId && o.tradeId === tradeId && o.positionId === positionId
      && o.side === p.side && o.entry === p.entry && o.initialRisk === p.initialRisk
      && o.owner === 'momentum_book' && o.status === 'open' && o.guardActive === false
  }
  const reconcile = () => {
    const c = credentials()
    return (deps.rankReconcile || wsReconcile)(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, 4000, 0)
  }
  schema(db)
  const readClaim = () => db.prepare('SELECT * FROM momentum_rank_exits WHERE account_id=? AND trade_id=?').get(accountId, tradeId)
  const updateBoth = (claim, from, to, patch = {}) => db.transaction(() => {
    const changed = db.prepare(`UPDATE momentum_rank_exits SET state=?,attempted_at=COALESCE(?,attempted_at),receipt_json=COALESCE(?,receipt_json),reason=?
      WHERE account_id=? AND trade_id=? AND token=? AND state=?`)
      .run(to, patch.attemptedAt ?? null, patch.receipt ?? null, patch.reason ?? null, accountId, tradeId, claim.token, from)
    if (!changed.changes) return false
    const plan = db.prepare('UPDATE momentum_partial_plans SET state=?,reason=? WHERE account_id=? AND trade_id=? AND state=?')
      .run(`RANK_${to}`, patch.reason ?? null, accountId, tradeId, `RANK_${from}`)
    if (plan.changes !== 1) throw Error('rank exit plan claim changed')
    return true
  })()
  const validReceipt = (r, claim) => claim?.account_id === accountId && claim.trade_id === tradeId
    && claim.position_id === positionId && ['ARMED', 'CONFIRMED'].includes(claim.prior_state)
    && claim.volume === (claim.prior_state === 'CONFIRMED' ? p.runnerVolume : p.volume)
    && marketIdentityKey(r) === marketIdentityKey(stored.identity)
    && r?.accountId === accountId && r.positionId === positionId
    && typeof r.dealId === 'string' && /^[1-9]\d*$/.test(r.dealId) && r.closedVolume === claim.volume
    && Number.isFinite(r.price) && r.price > 0 && Number.isSafeInteger(r.executedAtMs)
    && Number.isSafeInteger(claim.attempted_at) && r.executedAtMs >= claim.attempted_at && r.executedAtMs <= now()
  const finish = async claim => {
    if (!claim || !validReceipt(parse(claim.receipt_json), claim)) throw Error('rank exit stored receipt invalid')
    const raw = await bounded(reconcile)
    if (String(raw?.ctidTraderAccountId) !== accountId || !Array.isArray(raw.position)
      || raw.position.some(r => String(r.positionId) === positionId)) throw Error('rank exit absence not confirmed')
    if (!updateBoth(claim, 'RECEIVED', 'CONFIRMED')) throw Error('rank exit claim changed during readback')
    return { handled: true, state: 'CONFIRMED' }
  }
  if (stored.state === 'RANK_CONFIRMED') {
    const claim = readClaim()
    if (claim?.state !== 'CONFIRMED' || !validReceipt(parse(claim.receipt_json), claim)) throw Error('rank exit stored receipt invalid')
    return { handled: true, state: 'CONFIRMED' }
  }
  if (stored.state === 'RANK_RECEIVED') return finish(readClaim())
  if (!['ARMED', 'CONFIRMED', 'RANK_RESERVED'].includes(stored.state)) throw Error('partial or rank exit unresolved; no competing close')
  if (!owned()) throw Error('rank exit preflight ownership mismatch')
  const claim = db.transaction(() => {
    const current = readPartialPlan(db, accountId, tradeId), previous = readClaim()
    const prior = current.state === 'RANK_RESERVED' ? previous?.prior_state : current.state
    if (!['ARMED', 'CONFIRMED'].includes(prior) || !['ARMED', 'CONFIRMED', 'RANK_RESERVED'].includes(current.state)) throw Error('rank exit reservation unavailable')
    const token = randomUUID(), volume = prior === 'CONFIRMED' ? p.runnerVolume : p.volume
    db.prepare(`INSERT INTO momentum_rank_exits(account_id,trade_id,position_id,token,prior_state,state,created_at,volume)
      VALUES(?,?,?,?,?,'RESERVED',?,?) ON CONFLICT(account_id,trade_id) DO UPDATE SET
      token=excluded.token,prior_state=excluded.prior_state,state='RESERVED',created_at=excluded.created_at,
      volume=excluded.volume,attempted_at=NULL,receipt_json=NULL,reason=NULL`)
      .run(accountId, tradeId, positionId, token, prior, now(), volume)
    db.prepare("UPDATE momentum_partial_plans SET state='RANK_RESERVED',reason=NULL WHERE account_id=? AND trade_id=?")
      .run(accountId, tradeId)
    return readClaim()
  })()
  // Releasing is possible only while no financial request has been issued.
  // The token prevents a delayed, superseded reservation from releasing or sending.
  const release = () => db.transaction(() => {
    if (readClaim()?.token !== claim.token || readClaim()?.state !== 'RESERVED') return
    db.prepare("UPDATE momentum_rank_exits SET state='RELEASED' WHERE account_id=? AND trade_id=? AND token=?")
      .run(accountId, tradeId, claim.token)
    db.prepare("UPDATE momentum_partial_plans SET state=?,reason=NULL WHERE account_id=? AND trade_id=? AND state='RANK_RESERVED'")
      .run(claim.prior_state, accountId, tradeId)
  })()
  let c
  try {
    const raw = await bounded(reconcile), checkedAt = now()
    const position = partialPositionEvidence(raw, { identity: stored.identity, positionId, nowMs: checkedAt })
    if (!position || position.entry !== p.entry || position.side !== p.side || position.volume !== claim.volume
      || position.takeProfit !== p.brokerTarget || !owned() || typeof deps.close !== 'function') throw Error('rank exit preflight mismatch')
    c = credentials()
    claim.attempted_at = now()
    if (!updateBoth(claim, 'RESERVED', 'SENDING', { attemptedAt: claim.attempted_at })) throw Error('rank exit preflight reservation superseded')
  } catch (error) { release(); throw Error(`rank exit preflight: ${error.message}`) }
  const receive = raw => {
    const receipt = partialClosingEvidence(raw, { identity: stored.identity, positionId, side: p.side,
      entry: p.entry, closeVolume: claim.volume, attemptedAtMs: claim.attempted_at, nowMs: now() })
    if (!receipt) throw Error('rank exit receipt unconfirmed')
    if (!updateBoth(claim, 'SENDING', 'RECEIVED', { receipt: JSON.stringify(receipt) })) {
      if (!updateBoth(claim, 'AMBIGUOUS', 'RECEIVED', { receipt: JSON.stringify(receipt) })) throw Error('rank exit receipt claim changed')
    }
    return receipt
  }
  try {
    // Keep receipt handling on this one request after our wait expires.
    await bounded(() => Promise.resolve(deps.close(c, { positionId, volume: claim.volume })).then(receive))
  } catch (error) {
    updateBoth(claim, 'SENDING', 'AMBIGUOUS', { reason: String(error.message).slice(0, 200) })
    throw Error('rank exit unconfirmed; no retry authorized')
  }
  return finish(readClaim())
}
