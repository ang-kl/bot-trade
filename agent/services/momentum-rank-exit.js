import { randomUUID } from 'node:crypto'
import { credsForRegisteredAccount } from '../lib/ctrader-creds.js'
import { wsReconcile, wsGetPositionDeals } from '../lib/ctrader-ws.js'
import { marketIdentityKey } from '../lib/market-identity.js'
import { readPartialPlan, addMissingColumns } from './momentum-partial-manager.js'
import { readPartialOwnership, ownershipMatchesPlan } from './momentum-partial-ownership.js'
import { planMomentumTargets, sameTicks } from './momentum-target-policy.js'
import { partialPositionEvidence, partialPositionPresence, partialClosingEvidence, partialAcceptedEvidence,
  partialDealHistoryEvidence, matchClosingDeal, closingDealsSince, classifyCloseFailure,
  TRANSPORT_HORIZON_MS, MAX_CLOCK_SKEW_MS } from './momentum-broker-evidence.js'

const parse = value => { try { return JSON.parse(value) } catch { return null } }
// T2: the broker order id, the count of sends that may have reached the
// broker (carried across re-reservations; it bounds them), the last outcome
// and its evidence.
const RANK_COLUMNS = [['order_id', 'TEXT'], ['attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_outcome', 'TEXT'], ['evidence_json', 'TEXT'], ['resolved_at', 'INTEGER']]
/** The rank claim table, and its T2 columns on a table created before T2. */
export function rankExitSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS momentum_rank_exits (
    account_id TEXT NOT NULL, trade_id INTEGER NOT NULL, position_id TEXT NOT NULL,
    token TEXT NOT NULL, prior_state TEXT NOT NULL, state TEXT NOT NULL,
    created_at INTEGER NOT NULL, attempted_at INTEGER, volume INTEGER NOT NULL,
    receipt_json TEXT, reason TEXT, PRIMARY KEY(account_id,trade_id)
  )`)
  addMissingColumns(db, 'momentum_rank_exits', RANK_COLUMNS)
}

// A rank close proven not executed gets ONE more reservation (principle 3:
// an owed exit is never left unretried); the bound is on sends that may have
// reached the broker, so a refusal before transport never spends it.
export const RANK_EXIT_MAX_SENDS = 2
// Plan states a rank reservation may start from, and the volume each owns.
const RESERVABLE = ['ARMED', 'CONFIRMED', 'REJECTED', 'NOT_EXECUTED']

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
  const log = deps.log || (message => console.log(message))
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
    const o = deps.readOwnership ? deps.readOwnership(accountId, tradeId, positionId) : readPartialOwnership(db, accountId, tradeId, positionId, p.digits)
    return ownershipMatchesPlan(o, { accountId, tradeId, positionId, plan: p })
  }
  const reconcile = () => {
    const c = credentials()
    return (deps.rankReconcile || wsReconcile)(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId, 4000, 0)
  }
  const readDeals = async () => {
    try {
      const raw = await bounded(() => {
        const c = credentials()
        return (deps.rankDeals || wsGetPositionDeals)(c.host, c.clientId, c.clientSecret, c.accessToken, c.accountId,
          positionId, now() + MAX_CLOCK_SKEW_MS, 4000)
      })
      return partialDealHistoryEvidence(raw, { identity: stored.identity, positionId, nowMs: now() })
    } catch { return null }
  }
  rankExitSchema(db)
  const readClaim = () => db.prepare('SELECT * FROM momentum_rank_exits WHERE account_id=? AND trade_id=?').get(accountId, tradeId)
  const updateBoth = (claim, from, to, patch = {}) => db.transaction(() => {
    const changed = db.prepare(`UPDATE momentum_rank_exits SET state=?,attempted_at=COALESCE(?,attempted_at),receipt_json=COALESCE(?,receipt_json),reason=?,
      order_id=COALESCE(?,order_id),attempts=attempts+?,last_outcome=COALESCE(?,last_outcome),evidence_json=COALESCE(?,evidence_json),resolved_at=COALESCE(?,resolved_at)
      WHERE account_id=? AND trade_id=? AND token=? AND state=?`)
      .run(to, patch.attemptedAt ?? null, patch.receipt ?? null, patch.reason ?? null, patch.orderId ?? null,
        patch.attemptDelta ?? 0, patch.outcome ?? null, patch.evidence ? JSON.stringify(patch.evidence) : null,
        patch.resolvedAt ?? null, accountId, tradeId, claim.token, from)
    if (!changed.changes) return false
    const plan = db.prepare('UPDATE momentum_partial_plans SET state=?,reason=? WHERE account_id=? AND trade_id=? AND state=?')
      .run(patch.planState ?? `RANK_${to}`, patch.reason ?? null, accountId, tradeId, `RANK_${from}`)
    if (plan.changes !== 1) throw Error('rank exit plan claim changed')
    return true
  })()
  const validReceipt = (r, claim) => {
    const skew = r?.source === 'deal_history' ? MAX_CLOCK_SKEW_MS : 0
    return claim?.account_id === accountId && claim.trade_id === tradeId
      && claim.position_id === positionId && RESERVABLE.includes(claim.prior_state)
      && claim.volume === (claim.prior_state === 'CONFIRMED' ? p.runnerVolume : p.volume)
      && marketIdentityKey(r) === marketIdentityKey(stored.identity)
      && r?.accountId === accountId && r.positionId === positionId
      && typeof r.dealId === 'string' && /^[1-9]\d*$/.test(r.dealId) && r.closedVolume === claim.volume
      && Number.isFinite(r.price) && r.price > 0 && Number.isSafeInteger(r.executedAtMs)
      && Number.isSafeInteger(claim.attempted_at) && r.executedAtMs >= claim.attempted_at - skew && r.executedAtMs <= now() + skew
  }
  const finish = async claim => {
    if (!claim || !validReceipt(parse(claim.receipt_json), claim)) throw Error('rank exit stored receipt invalid')
    const raw = await bounded(reconcile)
    // One absence rule with every other read here: this account's own
    // answer, no row for the id. ProtoJSON omits an empty list, so the
    // account's last position closing is read as absent, not unconfirmed.
    const read = partialPositionPresence(raw, { identity: stored.identity, positionId, nowMs: now() })
    if (read?.absent !== true) throw Error('rank exit absence not confirmed')
    if (!updateBoth(claim, 'RECEIVED', 'CONFIRMED', { resolvedAt: now(), outcome: 'confirmed' })) throw Error('rank exit claim changed during readback')
    return { handled: true, state: 'CONFIRMED' }
  }
  const closedExternally = () => Error('rank exit: position closed externally; nothing to close (the reconciler records the close)')
  // A rank attempt whose request may not have ended, or ended without a
  // proven fill (T2). The attempt's own order id in deal history proves it;
  // that it never executed is proven only after the whole transport window.
  // Returns a result, throws to leave the exit owed, or returns 'reserve'
  // for the one bounded re-reservation.
  const resolveRank = async claim => {
    const unresolved = why => Error(`partial or rank exit unresolved (${why}); no competing close`)
    if (!claim || !['SENDING', 'AMBIGUOUS'].includes(claim.state) || !Number.isSafeInteger(claim.attempted_at)) throw unresolved('stored attempt invalid')
    const history = await readDeals()
    if (!history) throw unresolved('deal history unavailable')
    if (claim.order_id) {
      const found = matchClosingDeal(history, { orderId: claim.order_id, side: p.side, entry: p.entry, digits: p.digits,
        closeVolume: claim.volume, attemptedAtMs: claim.attempted_at, nowMs: now() })
      if (found.count > 1) throw unresolved('closing deal not unique')
      if (found.receipt) {
        const receipt = { ...stored.identity, ...found.receipt }
        if (!validReceipt(receipt, claim) || !updateBoth(claim, claim.state, 'RECEIVED', { receipt: JSON.stringify(receipt), outcome: 'deal_history' })) throw unresolved('receipt claim changed')
        return finish(readClaim())
      }
    }
    const since = closingDealsSince(history, claim.attempted_at)
    if (claim.order_id && since.some(d => d.orderId === claim.order_id)) throw unresolved('order deals inexact')
    let raw
    try { raw = await bounded(reconcile) } catch { throw unresolved('position read unavailable') }
    const checkedAt = now()
    const read = partialPositionPresence(raw, { identity: stored.identity, positionId, nowMs: checkedAt })
    if (!read) throw unresolved('position unverified')
    const evidence = { observedAtMs: checkedAt, absent: read.absent, observedVolume: read.absent ? 0 : read.volume,
      closingDealIds: (read.absent ? history.closing : since).map(d => d.dealId).filter(Boolean),
      orderId: claim.order_id ?? null, attemptedAtMs: claim.attempted_at, source: 'broker_reconcile+deal_history' }
    const pastHorizon = checkedAt - claim.attempted_at > TRANSPORT_HORIZON_MS
    if (read.absent) {
      // An accepted rank close is expected to leave the position absent: its
      // own deal is waited for until the window has passed.
      if (claim.order_id && !pastHorizon) throw unresolved('awaiting the accepted order\'s deal')
      if (!history.closing.length) throw unresolved('absence without a closing deal')
      // With the claim's order id and no deal of it, another close closed the
      // position. With no order id (a timed-out send) this rank close may be
      // what closed it: the attribution is unproven, and says so.
      updateBoth(claim, claim.state, 'CLOSED_EXTERNALLY', { reason: claim.order_id
        ? 'position closed without this rank close\'s order' : 'position closed; attribution to this rank close unproven',
      outcome: 'closed_externally', evidence, resolvedAt: checkedAt })
      throw closedExternally()
    }
    if (read.side !== p.side || !sameTicks(read.entry, p.entry, p.digits)) throw unresolved('position unverified')
    if (!pastHorizon) throw unresolved('awaiting transport horizon')
    if (read.volume === claim.volume && since.length === 0) {
      if ((claim.attempts ?? 0) < RANK_EXIT_MAX_SENDS) {
        // Proven never executed: back to the plan's prior state, then one
        // re-reservation in this same pass. Logged; bounded by attempts.
        const released = db.transaction(() => {
          const c = db.prepare(`UPDATE momentum_rank_exits SET state='NOT_EXECUTED',reason=?,last_outcome='not_executed',evidence_json=?,resolved_at=?
            WHERE account_id=? AND trade_id=? AND token=? AND state=?`)
            .run('no closing deal after the transport horizon', JSON.stringify(evidence), checkedAt, accountId, tradeId, claim.token, claim.state)
          if (!c.changes) return false
          const plan = db.prepare('UPDATE momentum_partial_plans SET state=?,reason=? WHERE account_id=? AND trade_id=? AND state=?')
            .run(claim.prior_state, 'rank close not executed; re-reserved once', accountId, tradeId, `RANK_${claim.state}`)
          if (plan.changes !== 1) throw Error('rank exit plan claim changed')
          return true
        })()
        if (!released) throw unresolved('claim changed')
        log(`momentum rank exit: …${accountId.slice(-4)} trade ${tradeId} close proven not executed (send ${claim.attempts} of ${RANK_EXIT_MAX_SENDS}); one re-reservation`)
        return 'reserve'
      }
      updateBoth(claim, claim.state, 'NOT_EXECUTED', { reason: 'not executed after its one re-reservation; owner review', outcome: 'not_executed', evidence, resolvedAt: checkedAt })
      throw Error('rank exit not executed after its one re-reservation; owner review (no further send)')
    }
    if (read.volume !== claim.volume && since.length) {
      updateBoth(claim, claim.state, 'VOLUME_CHANGED', { reason: 'volume changed by another close', outcome: 'volume_changed', evidence, resolvedAt: checkedAt })
      return { handled: false, state: 'VOLUME_CHANGED' }
    }
    throw unresolved('closing deal unattributed')
  }

  let state = stored.state
  if (state === 'RANK_CONFIRMED') {
    const claim = readClaim()
    if (claim?.state !== 'CONFIRMED' || !validReceipt(parse(claim.receipt_json), claim)) throw Error('rank exit stored receipt invalid')
    return { handled: true, state: 'CONFIRMED' }
  }
  if (state === 'RANK_RECEIVED') return finish(readClaim())
  if (state === 'CLOSED_EXTERNALLY' || state === 'RANK_CLOSED_EXTERNALLY') throw closedExternally()
  if (state === 'RANK_NOT_EXECUTED') throw Error('rank exit not executed after its one re-reservation; owner review (no further send)')
  // The plan's volumes no longer describe the position: the caller's own
  // close of the broker's volume applies, as it does with no plan at all.
  if (state === 'VOLUME_CHANGED' || state === 'RANK_VOLUME_CHANGED') return { handled: false, state }
  if (state === 'RANK_SENDING' || state === 'RANK_AMBIGUOUS') {
    const resolved = await resolveRank(readClaim())
    if (resolved !== 'reserve') return resolved
    state = readPartialPlan(db, accountId, tradeId).state
  }
  if (![...RESERVABLE, 'RANK_RESERVED'].includes(state)) throw Error('partial or rank exit unresolved; no competing close')
  if (!owned()) throw Error('rank exit preflight ownership mismatch')
  const claim = db.transaction(() => {
    const current = readPartialPlan(db, accountId, tradeId), previous = readClaim()
    const prior = current.state === 'RANK_RESERVED' ? previous?.prior_state : current.state
    if (!RESERVABLE.includes(prior) || ![...RESERVABLE, 'RANK_RESERVED'].includes(current.state)) throw Error('rank exit reservation unavailable')
    const token = randomUUID(), volume = prior === 'CONFIRMED' ? p.runnerVolume : p.volume
    // attempts and last_outcome survive a re-reservation: they bound it.
    db.prepare(`INSERT INTO momentum_rank_exits(account_id,trade_id,position_id,token,prior_state,state,created_at,volume)
      VALUES(?,?,?,?,?,'RESERVED',?,?) ON CONFLICT(account_id,trade_id) DO UPDATE SET
      token=excluded.token,prior_state=excluded.prior_state,state='RESERVED',created_at=excluded.created_at,
      volume=excluded.volume,attempted_at=NULL,receipt_json=NULL,reason=NULL,order_id=NULL,evidence_json=NULL,resolved_at=NULL`)
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
  // A send that provably did not execute (refused before transport, or a
  // definite broker rejection) returns the plan to its prior state and does
  // not count against the bound; the book's owed exit retries it.
  const unsend = (outcome, reason) => db.transaction(() => {
    const c = db.prepare(`UPDATE momentum_rank_exits SET state=?,reason=?,last_outcome=?,attempts=MAX(attempts-1,0),resolved_at=?
      WHERE account_id=? AND trade_id=? AND token=? AND state='SENDING'`)
      .run(outcome === 'rejected' ? 'REJECTED' : 'RELEASED', reason, outcome, now(), accountId, tradeId, claim.token)
    if (!c.changes) return
    db.prepare("UPDATE momentum_partial_plans SET state=?,reason=? WHERE account_id=? AND trade_id=? AND state='RANK_SENDING'")
      .run(claim.prior_state, `rank close ${outcome}: ${reason}`.slice(0, 200), accountId, tradeId)
  })()
  let c
  try {
    const raw = await bounded(reconcile), checkedAt = now()
    const position = partialPositionEvidence(raw, { identity: stored.identity, positionId, nowMs: checkedAt })
    if (!position || !sameTicks(position.entry, p.entry, p.digits) || position.side !== p.side || position.volume !== claim.volume
      || !sameTicks(position.takeProfit, p.brokerTarget, p.digits) || !owned() || typeof deps.close !== 'function') throw Error('rank exit preflight mismatch')
    c = credentials()
    claim.attempted_at = now()
    if (!updateBoth(claim, 'RESERVED', 'SENDING', { attemptedAt: claim.attempted_at, attemptDelta: 1 })) throw Error('rank exit preflight reservation superseded')
  } catch (error) { release(); throw Error(`rank exit preflight: ${error.message}`) }
  const context = () => ({ identity: stored.identity, positionId, side: p.side, entry: p.entry, digits: p.digits,
    closeVolume: claim.volume, attemptedAtMs: claim.attempted_at, nowMs: now() })
  const receive = raw => {
    if (raw?.alreadyClosed === true) return 'already_closed'
    const accepted = partialAcceptedEvidence(raw, context())
    if (accepted) {
      // The order id alone: stored on the SENDING (or, late, AMBIGUOUS) claim
      // so its deal can be found in history. It proves no fill.
      db.prepare(`UPDATE momentum_rank_exits SET order_id=? WHERE account_id=? AND trade_id=? AND token=?
        AND state IN ('SENDING','AMBIGUOUS') AND order_id IS NULL`).run(accepted.orderId, accountId, tradeId, claim.token)
      return 'accepted'
    }
    const receipt = partialClosingEvidence(raw, context())
    if (!receipt) throw Error('rank exit receipt unconfirmed')
    const patch = { receipt: JSON.stringify(receipt), orderId: receipt.orderId, outcome: 'execution_event' }
    if (!updateBoth(claim, 'SENDING', 'RECEIVED', patch)) {
      if (!updateBoth(claim, 'AMBIGUOUS', 'RECEIVED', patch)) throw Error('rank exit receipt claim changed')
    }
    return 'received'
  }
  let outcome
  try {
    // Keep receipt handling on this one request after our wait expires.
    outcome = await bounded(() => Promise.resolve(deps.close(c, { positionId, volume: claim.volume })).then(receive))
  } catch (error) {
    const failure = classifyCloseFailure(error)
    if (failure.kind === 'not_sent' || failure.kind === 'rejected') {
      unsend(failure.kind, failure.code)
      throw Error(`rank exit ${failure.kind === 'rejected' ? `rejected by the broker (${failure.code})` : `not sent (${failure.code})`}; the exit stays owed`)
    }
    if (failure.kind === 'already_closed') outcome = 'already_closed'
    else {
      updateBoth(claim, 'SENDING', 'AMBIGUOUS', { reason: String(error.message).slice(0, 200), outcome: 'ambiguous' })
      throw Error('rank exit unconfirmed; no retry authorized')
    }
  }
  if (outcome === 'already_closed' || outcome === 'accepted') {
    // Resolve from the broker's reads now; an unproven outcome stays
    // AMBIGUOUS (with its order id when accepted) for the next pass.
    if (outcome === 'already_closed') updateBoth(claim, 'SENDING', 'AMBIGUOUS', { reason: 'position not found at close', outcome: 'already_closed' })
    const resolved = await resolveRank(readClaim())
    if (resolved === 'reserve') throw Error('rank exit not executed; re-reserved for the next pass')
    return resolved
  }
  return finish(readClaim())
}
