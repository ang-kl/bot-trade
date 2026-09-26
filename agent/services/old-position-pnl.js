import { getState, setState } from '../db.js'
import { normPosId } from '../lib/pos-id.js'
import { POSITION_HISTORY_REFUSED } from '../lib/position-deal-history.js'
import { backfillClosedPnl, noteTradeAttempts, LIVE_GAP_MAX_ATTEMPTS, POSITION_LEDGER_IDENTITY } from './pnl-backfill.js'
import {
  markUnresolvable, UNRESOLVED_NO_EVIDENCE, BROKER_DEAL_NOT_SETTLEABLE, BROKER_POSITION_STILL_OPEN, BROKER_NEVER_FILLED, BROKER_HISTORY_NOT_SETTLEABLE,
} from './mark-unresolvable.js'
import { sweepReadRecently } from './position-lifecycle-evidence.js'

// One old, attributed position per account pass. The durable pacing cursor
// also records failures, but a failed read is not an exhausted trade attempt.
// This consumes the caller's existing deadline and WS lock.
//
// BOUNDED, THEN TERMINAL (V3 I1, owner 25-09-2026 21:30 SGT write-off rule).
// Production 25-09: pnl_reconcile in error for four days, 1,776 consecutive
// failures, on two rows (#774 AVY.US, #775 GEV.US, …3489) whose broker
// positions the ledger also holds as written-off rows #372/#373. Every pass
// reached them, backfillClosedPnl refused the ambiguous identity, and this
// module swallowed the refusal as 'failed' without counting an attempt — so the
// rows stayed "never attempted" for ever, nothing could write them off, and the
// heartbeat reported a stall that was really one un-reconcilable record.
//
// Now: a refusal on EVIDENCE (the local identity contradiction, or a broker
// history that arrived and cannot be settled) is an attempt at the row; a
// failed READ still is not. An ambiguous identity is settled row-scoped from
// the complete position history when exactly one row can claim the money
// (R3). After OLD_POSITION_MAX_ATTEMPTS evidence attempts without money the
// row is marked terminal with the evidence — "unresolved: no broker evidence"
// when there is none, otherwise a label naming the broker evidence it could
// not be settled from (a closing deal on file, a position the broker still
// holds open, an order that never filled, a complete history the reader
// refused): net_pnl stays NULL (excluded from money), the row stays in the
// ledger and on every read route, and the pass moves on. Rows written off before the
// per-position reader existed get ONE position-history re-read (R4): settled
// if the broker has the close, otherwise their reason is corrected.
export const OLD_POSITION_MAX_ATTEMPTS = LIVE_GAP_MAX_ATTEMPTS
const REREAD_KEEP = 2000
// THE RULES A REMEMBERED READ WAS JUDGED UNDER (V3 B1). A written-off or
// terminal row is re-read once; that memory is keyed by this version, so rows
// judged before the lifecycle rules (whole unique lifecycle, rejected twins
// not counted, the false-close rule) get ONE read under them — #372/#774 AVY
// and #373/#775 GEV on …3489 were all remembered before those rules existed.
//
// Rule 3 (V3 B2): the broker lifecycle verdicts. Every read now leaves a
// verdict row (position-lifecycle-evidence.js, recorded by the account pass
// from this reader's own response), and a history made only of rejected deals
// is labelled "never filled" instead of "no broker evidence". Rows remembered
// under rule 2 get ONE read under rule 3, so each written-off row carries a
// verdict — about 20 reads, once, at the existing pacing.
export const LIFECYCLE_RULES = 3

export async function recoverOldPositionPnl(db, creds, { now, isCurrent, getPositionDeals, handoff = [] }) {
  const accountId = String(creds.accountId), key = `position_pnl_recovery:${accountId}`
  const rereadKey = `position_pnl_reread:${accountId}`
  let prior = {}
  try { prior = JSON.parse(getState(db, key) || '{}') } catch { /* no valid cursor */ }
  const attempts = Object.fromEntries(Object.entries(prior.attempts || {})
    .filter(([, at]) => Number.isSafeInteger(at) && at <= now && now - at < 900_000).slice(-128))
  if (Number.isSafeInteger(prior.lastReadAt) && prior.lastReadAt <= now && now - prior.lastReadAt < 30_000) return { state: 'paced' }
  // V3 B2 checker N1: the evidence sweep reads position histories on the same
  // account; the 30 s pacing is shared both ways, not only sweep-after-reader.
  if (sweepReadRecently(db, accountId, now)) return { state: 'paced' }
  const reread = readJson(db, rereadKey)
  const judged = Object.fromEntries(Object.entries(reread).filter(([, v]) => Number(v?.rule) >= LIFECYCLE_RULES))
  // Live rows first; written-off rows only until their one re-read under the
  // current rules is on record.
  //
  // THE 14-DAY opened_at FILTER NO LONGER HIDES WHAT THE WINDOW HANDS OFF
  // (V3 B1, PR-1(d)). It kept rows opened inside the window for the window
  // path alone. The window path now DEFERS a position whose opening deal it
  // cannot see and refuses an ambiguous identity (pnl-backfill.js), and both
  // need this reader's complete position history — a re-adopted row's local
  // opened_at is the adoption, not the broker's open. `handoff` is those
  // positions, from the same account pass. Rows the window can still settle
  // stay the window's: reading them here as well would count two attempts a
  // pass and halve the time to a write-off. Same pacing as before: one
  // position per account per 30 s, each position at most once per 15 min.
  const handed = JSON.stringify((Array.isArray(handoff) ? handoff : []).map(String).filter(id => /^[1-9]\d*$/.test(id)).slice(0, 200))
  const candidates = db.prepare(`SELECT id, ctrader_position_id, COALESCE(pnl_unresolvable, 0) AS written_off,
      pnl_unresolvable_reason AS written_off_reason, pnl_unresolvable_at AS written_off_at
    FROM trades WHERE account_id = ?
    AND status = 'closed' AND net_pnl IS NULL
    AND (COALESCE(pnl_unresolvable, 0) = 0 OR id NOT IN (SELECT CAST(key AS INTEGER) FROM json_each(?)))
    AND (julianday(opened_at) IS NULL OR julianday(opened_at) < julianday(?) OR julianday(opened_at) > julianday(?)
      OR CAST(ctrader_position_id AS INTEGER) IN (SELECT CAST(value AS INTEGER) FROM json_each(?)))
    ORDER BY COALESCE(pnl_unresolvable, 0), (id <= ?), id LIMIT 128`)
    .all(accountId, JSON.stringify(judged), new Date(now - 14 * 86400_000).toISOString(), new Date(now).toISOString(), handed,
      Number.isSafeInteger(prior.lastTradeId) ? prior.lastTradeId : 0)
  const candidate = candidates.find(row => {
    const id = normPosId(row.ctrader_position_id)
    return /^[1-9]\d*$/.test(id || '') && Number.isSafeInteger(Number(id)) && !attempts[id]
  })
  if (!candidate) return { state: candidates.length ? 'paced' : 'no_old_gap' }
  if (!isCurrent()) return { state: 'deadline' }
  const positionId = normPosId(candidate.ctrader_position_id), tradeId = Number(candidate.id)
  const writtenOff = Number(candidate.written_off) === 1
  const state = { lastReadAt: now, lastTradeId: candidate.id, positionId, attempts: { ...attempts, [positionId]: now }, state: 'collecting' }
  setState(db, key, JSON.stringify(state))
  const read = rowScoped => backfillClosedPnl(db, creds, { accountId, positionId, ...(rowScoped ? { tradeId } : {}),
    strictAccount: true, now, isCurrent, getPositionDeals })
  const settled = result => ({ positionId, tradeId, state: result.backfilled ? 'recovered' : 'no_matching_close', result })
  const refusedOrFailed = (error, extra = {}) => [POSITION_LEDGER_IDENTITY, POSITION_HISTORY_REFUSED].includes(error?.code)
    ? { positionId, tradeId, state: 'refused', reason: error.message, refusal: error.code, ...(error.openAtBroker === true ? { openAtBroker: true } : {}),
        ...(error.neverFilled === true ? { neverFilled: true } : {}), ...extra }
    : { positionId, tradeId, state: 'failed', reason: error?.message || String(error), ...extra }
  let out
  try {
    out = settled(await read(false))
  } catch (error) {
    if (error?.code === POSITION_LEDGER_IDENTITY) {
      // R3: the ledger holds this broker position more than once. Settle THIS
      // row from the complete position history when it is the only row that
      // can claim the money; the duplicate-row decision stays an operator's.
      const ambiguity = ledgerPeers(db, accountId, positionId)
      try { out = { ...settled(await read(true)), identity: 'row_scoped', ambiguity } } catch (scoped) { out = refusedOrFailed(scoped, { ambiguity }) }
    } else out = refusedOrFailed(error)
  }
  if (out.state === 'refused') {
    // The same refusal recurs every pass until something changes: an attempt.
    noteTradeAttempts(db, { accountId, positionId, tradeId, includeUnattributed: false, at: new Date(now).toISOString() })
  }
  try { classify(db, { out, candidate, writtenOff, accountId, positionId, tradeId, now, reread, rereadKey }) } catch (error) {
    out.classifyError = error.message
  }
  setState(db, key, JSON.stringify({ ...state, ...out, completedAt: Date.now() }))
  return out
}

function classify(db, { out, candidate, writtenOff, accountId, positionId, tradeId, now, reread, rereadKey }) {
  const at = new Date(now).toISOString()
  if (out.state === 'recovered') {
    // V3 B1: the settling read may have marked earlier records of the
    // position as false closes (status rejected, evidence in close_reason);
    // pnl-backfill audits them. A candidate among them was not settled — it
    // was shown to be a false record — so it is remembered as such.
    const falseCloses = out.result?.falseCloses ?? []
    if (falseCloses.includes(tradeId)) remember(db, rereadKey, reread, tradeId, at, 'false_close')
    // The row that took the money is the one whose write-off (if any) no
    // longer describes it — the candidate, or the true row of its position.
    const filled = Number(out.result?.filledRowId ?? tradeId)
    const row = db.prepare(`SELECT pnl_unresolvable_reason AS reason, pnl_unresolvable_at AS at FROM trades
      WHERE id = ? AND net_pnl IS NOT NULL AND COALESCE(pnl_unresolvable, 0) = 1`).get(filled)
    if (!row) return
    // The broker had the close after all: the money landed, so the write-off
    // no longer describes the row. The history of the write-off is kept.
    const cleared = db.prepare(`UPDATE trades SET pnl_unresolvable = 0, pnl_unresolvable_reason = ?
      WHERE id = ? AND net_pnl IS NOT NULL AND COALESCE(pnl_unresolvable, 0) = 1`)
      .run(bounded(`settled from the broker's complete position history ${at}; had been written off ${row.at ?? '?'}: ${row.reason ?? ''}`), filled).changes
    out.writeOffCleared = cleared > 0
    remember(db, rereadKey, reread, filled, at, 'settled')
    audit(db, 'PNL_WRITE_OFF_SETTLED', { tradeId: filled, accountId, positionId, at, backfilled: out.result?.backfilled ?? 0, source: 'broker position history',
      oldAt: row.at ?? null, oldReason: auditText(row.reason) })
    return
  }
  if (!['no_matching_close', 'refused'].includes(out.state)) return
  const { label, text: evidence } = evidenceOf(db, out, { accountId, positionId, at })
  if (writtenOff) {
    // R4: the one re-read of a row written off before this reader existed.
    // The row's text is bounded, so the evidence gives way to the old reason
    // (checker N1), and the old reason is ALSO kept whole in an audit row: a
    // rewritten reason is a write like the settled and terminal outcomes.
    const changed = db.prepare(`UPDATE trades SET pnl_unresolvable_reason = ? WHERE id = ? AND net_pnl IS NULL AND COALESCE(pnl_unresolvable, 0) = 1`)
      .run(rereadReason(label, at, evidence, candidate), tradeId).changes
    out.reread = true
    remember(db, rereadKey, reread, tradeId, at, out.state)
    audit(db, 'PNL_WRITE_OFF_REREAD', { tradeId, accountId, positionId, at, outcome: out.state, changed, label,
      oldAt: candidate.written_off_at ?? null, oldReason: auditText(candidate.written_off_reason) })
    return
  }
  const n = Number(db.prepare('SELECT pnl_attempts AS n FROM trades WHERE id = ?').get(tradeId)?.n) || 0
  out.attempts = n
  if (n < OLD_POSITION_MAX_ATTEMPTS) return
  const reason = bounded(`${label}: ${evidence}; ${n} attempt(s), last ${at}; net_pnl stays NULL, excluded from P&L, shown`)
  if (markUnresolvable(db, tradeId, reason)) {
    out.terminal = reason
    remember(db, rereadKey, reread, tradeId, at, 'terminal')
    audit(db, 'PNL_UNRESOLVABLE', { marked: 1, ids: [tradeId], accountId, positionId, at, reason, note: 'old-position-pnl bounded attempts (V3 I1); net_pnl stays NULL, nothing was computed' })
  }
}

// The terminal label follows the evidence (checker N2/N3): "unresolved: no
// broker evidence" only when there is none. A closing deal on file for the
// position, or a broker history showing the position still open, is broker
// evidence the row cannot be settled from, and is labelled as such.
function evidenceOf(db, out, { accountId, positionId, at }) {
  if (out.state === 'no_matching_close') {
    return { label: UNRESOLVED_NO_EVIDENCE,
      text: `the broker's complete position history for position ${positionId} on account ${accountId} holds no closing deal (read ${at})` }
  }
  // "Use the local matched deal" (R3): a closing deal already on file for the
  // position is named as evidence. It is not written as the row's P&L on its
  // own: its link was assigned before persistDeals refused duplicate
  // identities, and a local deal list cannot prove the position's closes are
  // complete. The complete position history is what settles a row.
  let local = []
  try {
    local = db.prepare(`SELECT deal_id, net_pnl, matched_trade_id FROM broker_deals WHERE account_id = ?
      AND CAST(position_id AS INTEGER) = CAST(? AS INTEGER) AND net_pnl IS NOT NULL ORDER BY deal_id LIMIT 5`).all(accountId, positionId)
  } catch { /* evidence only */ }
  const deals = local.length ? local.map(d => `${d.deal_id} net ${d.net_pnl}${d.matched_trade_id != null ? ` linked #${d.matched_trade_id}` : ''}`).join(', ') : 'none'
  // A history of rejected deals only is broker evidence of its own (V3 B2):
  // the order never filled. It outranks a local closing deal on file, whose
  // link the complete history just contradicted.
  //
  // A POSITION_HISTORY_REFUSED refusal means the broker's complete answer
  // for this account ARRIVED and could not be settled (V3 B2 checker N2): that
  // is broker evidence, so "no broker evidence" would be false. It is kept
  // only for a refusal that is not about the broker's answer — the ledger's
  // own identity contradiction with no deal on file.
  const label = out.neverFilled ? BROKER_NEVER_FILLED : out.openAtBroker ? BROKER_POSITION_STILL_OPEN
    : local.length ? BROKER_DEAL_NOT_SETTLEABLE : out.refusal === POSITION_HISTORY_REFUSED ? BROKER_HISTORY_NOT_SETTLEABLE : UNRESOLVED_NO_EVIDENCE
  if (!out.ambiguity) {
    return { label, text: `the broker's position history for position ${positionId} on account ${accountId} was refused: ${out.reason} (read ${at})${local.length ? `; local closing deal(s): ${deals}` : ''}` }
  }
  return { label, text: `ledger identity ambiguous for position ${positionId} on account ${accountId} (${out.ambiguity}); ${out.reason.split('; count=')[0]}; local closing deal(s): ${deals}; the duplicate-row decision is left to an operator` }
}

// Head, evidence, then the old reason: when the 900-char bound bites, the
// evidence is clipped first so the reason the row carried stays on the row.
function rereadReason(label, at, evidence, candidate) {
  const head = `${label}: re-read ${at}: `
  const tail = `; written off ${candidate.written_off_at ?? '?'} as: ${candidate.written_off_reason ?? ''}`
  const room = Math.max(80, REASON_MAX - head.length - tail.length)
  return bounded(`${head}${evidence.length <= room ? evidence : `${evidence.slice(0, room - 1)}…`}${tail}`)
}

function ledgerPeers(db, accountId, positionId) {
  try {
    return db.prepare(`SELECT id, status, net_pnl, COALESCE(pnl_unresolvable, 0) AS written_off FROM trades
      WHERE account_id = ? AND CAST(ctrader_position_id AS INTEGER) = CAST(? AS INTEGER) ORDER BY id LIMIT 6`)
      .all(accountId, positionId)
      .map(r => `#${r.id}:${r.status}${Number(r.written_off) === 1 ? '(written off)' : ''}${r.net_pnl != null ? `(net ${r.net_pnl})` : ''}`).join(',')
  } catch { return 'rows unreadable' }
}

function readJson(db, key) {
  try {
    const value = JSON.parse(getState(db, key) || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

// Bounded: integer keys iterate in ascending order, so the lowest trade ids
// drop first; a dropped row is at worst re-read once more.
function remember(db, key, map, tradeId, at, outcome) {
  const entry = { at, outcome, rule: LIFECYCLE_RULES }
  const next = { ...map, [tradeId]: entry }
  const entries = Object.entries(next)
  setState(db, key, JSON.stringify(Object.fromEntries(entries.slice(-REREAD_KEEP))))
  map[tradeId] = entry
}

function audit(db, method, body) {
  try {
    db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)').run(method, '/old-position-pnl', JSON.stringify(body).slice(0, 2000))
  } catch { /* audit best-effort */ }
}

const REASON_MAX = 900
const bounded = text => String(text).slice(0, REASON_MAX)
// audit() cuts the JSON body at 2000 chars; an old reason is kept whole up to
// this, so the audit row stays parseable and carries it.
const auditText = text => text == null ? null : String(text).slice(0, 1500)
