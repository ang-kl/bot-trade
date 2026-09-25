// agent/services/position-capture.js — the close-triggered half of the
// position record (owner, 17-09-2026: "every position close, and after 30
// seconds should have the whole closed position history in cTrader to extract
// and store in volume storage for analysis").
//
// THE SHAPE, AND WHY IT IS A QUEUE.
//
//   1. the reconciler detects a close → enqueue, due 30 s later
//   2. a later loop pass drains what is due: pull that account's deals for
//      the position's window, persist them, then build the record
//   3. a complete record is appended to a JSONL archive on the volume
//   4. and offered to cpp-verify, whose answer is written back
//
// The 30 seconds are the owner's, and they are not arbitrary: the broker's
// deal history does not carry the closing deal the instant the position
// vanishes from the open list. Building immediately would produce a record
// with no broker figures — which the completeness gate would refuse, and the
// refusal would be OUR timing rather than a real gap in the data.
//
// A TIMER WOULD NOT DO. setTimeout dies with the process, so a position
// closed 20 seconds before a redeploy would never be captured — and nothing
// would say so, because that failure looks identical to a capture that went
// fine. The queue is a table: it survives a restart, and a row that keeps
// failing stays visible with its last error instead of disappearing.
//
// NOTHING HERE IS SILENT. A capture that runs out of attempts is marked
// `gave_up` and KEPT, because a position this system could not record is a
// fact worth counting. Deleting it would make the queue read permanently
// healthy — the exact shape CLAUDE.md's failure mode #3 describes.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { capturePosition, recordVerdict, accountSymbolMap } from './position-history.js'
import { pageDeals } from '../lib/deal-paging.js'
import { VERDICT_CONTRACT_VERSION } from '../lib/verify-contract.js'
import { unitsPerLot, rememberVolumeMeta, withBrokerLotSizes } from '../lib/lot-size-registry.js'

/**
 * The record plus `lot_size`: the broker's declared lotSize for the symbol
 * (cents of units per lot), or nothing. The registry's table fallback
 * carries NO lotSize by construction (lot-size-registry.js `unitsPerLot`
 * returns `lotSize: null` for `source: 'table'`), and that is what is read
 * here — never `unitsPerLot × 100`, which would hand the verifier a guessed
 * lot to scale the broker's own volume by and call the result a verdict.
 */
export async function withBrokerLotSize (db, record, { lotSizeFor = null } = {}) {
  try {
    const u = unitsPerLot(db, record?.symbol)
    if (Number(u.lotSize) > 0) return { ...record, lot_size: Number(u.lotSize) }
  } catch { /* no registry, no lot */ }
  // B6 (18-09-2026): a symbol the registry has never seen — the order path
  // learns lot sizes only for symbols it has SIZED, so a position adopted or
  // opened by hand leaves the verifier with `uncompared: ["volume"]` for
  // ever. Ask the broker once (the same ProtoOASymbolsByIds read the sizing
  // path uses), remember the declaration, and send it. A failed read sends
  // nothing — the verifier then says so rather than guessing.
  if (typeof lotSizeFor === 'function' && record?.symbol) {
    try {
      const meta = await lotSizeFor(record.symbol)
      if (meta && Number(meta.lotSize) > 0) {
        try { rememberVolumeMeta(db, record.symbol, meta) } catch { /* learning must never fail a capture */ }
        return { ...record, lot_size: Number(meta.lotSize), lot_size_source: 'broker_read' }
      }
    } catch { /* the broker read failed — no lot travels */ }
  }
  return { ...record, lot_size: null }
}

/** The owner's 30 seconds. */
export const CAPTURE_DELAY_MS = 30_000
/** Re-attempt spacing after a failure: 1, 2, 4, 8, 16 minutes. */
export const RETRY_BASE_MS = 60_000
export const MAX_ATTEMPTS = 6
/** How far either side of the position's life to ask the broker for deals. */
export const DEAL_WINDOW_SLACK_MS = 10 * 60_000

const log = (...a) => console.log('[position-capture]', ...a)

/**
 * Where the archive lives.
 *
 * DERIVED FROM DB_PATH RATHER THAN A NEW VARIABLE. The Node service already
 * mounts its Railway volume at the directory holding the database
 * (`DB_PATH=/data/agent.db`), so the archive belongs beside it and needs
 * nothing set. Asking the owner for one more variable to point at a disk the
 * process is already writing to would be a config step that can be got wrong
 * for no gain — and if DB_PATH is unset, the boot already warns loudly that
 * the volume is missing, so this follows that one signal instead of adding a
 * second.
 */
export function archiveDir(env = process.env) {
  const dbPath = String(env.DB_PATH || '').trim()
  if (!dbPath) return null
  return join(dirname(dbPath), 'position-history')
}

/** One file per month, so a year of history is twelve readable files. */
export function archivePathFor(record, env = process.env) {
  const dir = archiveDir(env)
  if (!dir) return null
  const d = new Date(Number(record.closed_at_ms) || Date.now())
  const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  return join(dir, `${month}.jsonl`)
}

/**
 * Append one record to the archive.
 *
 * BEST-EFFORT ON PURPOSE, and it says so when it fails. The database row is
 * the record; the archive is the copy that outlives the database. A disk
 * error must not lose the capture — but it must not be swallowed either, or
 * the archive would quietly stop growing while every count kept rising.
 */
export function archiveRecord(record, { env = process.env } = {}) {
  const path = archivePathFor(record, env)
  if (!path) return { ok: false, reason: 'no_db_path' }
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(record) + '\n')
    return { ok: true, path }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

/** A close was detected: queue it for capture once the broker has settled. */
export function enqueueCapture(db, { accountId, positionId, symbol = null, now = Date.now(), delayMs = CAPTURE_DELAY_MS }) {
  const acct = accountId == null ? null : String(accountId)
  const pid = positionId == null ? null : String(positionId)
  if (!acct || !pid) return { ok: false, reason: 'no_identity' }
  // A re-detected close must not reset a row that already captured, nor
  // restart the attempt count of one still trying: the reconciler can report
  // the same close on two consecutive passes.
  db.prepare(`
    INSERT INTO position_capture_queue (account_id, position_id, symbol, due_at_ms)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, position_id) DO NOTHING
  `).run(acct, pid, symbol == null ? null : String(symbol), now + delayMs)
  return { ok: true }
}

/** How many times one row may be re-armed to chase a missing verdict. */
export const MAX_REVERIFY = 3
/** How many backlog rows one pass may re-arm. */
export const REVERIFY_BATCH = 10

/**
 * PR-AP — RE-ARM COMPLETE RECORDS THAT NEVER GOT A VERDICT.
 *
 * WHY THERE IS A BACKLOG AT ALL. `position_history` rows built before
 * cpp-verify was reachable are complete and correct as records, and carry
 * `verification_state = 'unverified'` — which is exactly what they are. The
 * queue row that produced them is already terminal (`captured`), and
 * `enqueueCapture` is `ON CONFLICT DO NOTHING` by design, so nothing will
 * ever look at them again. Left alone they stay unverified for ever: sixty
 * closed trades whose figures no independent source has ever checked.
 *
 * WHAT THIS DOES NOT TOUCH:
 *
 *   `gave_up` rows. Those are terminal because the record could not be BUILT,
 *   which is a different failure and a fact worth keeping. Re-arming one
 *   would restart a fight with a structural gap AND erase the count of trades
 *   this system could not describe — the failure mode #3 shape the queue's
 *   own comment warns about.
 *
 *   Rows already `verified` or `disputed`. A dispute is an ANSWER, not a
 *   pending question; re-running it would eventually overwrite a real
 *   disagreement with a later agreement and lose the finding.
 *
 * WHY IT TERMINATES. Each arming increments `reverify_attempts`, and a row at
 * MAX_REVERIFY is skipped for good. So a verifier that is down, or an account
 * it was never authorized on, costs at most three re-captures per row instead
 * of one per loop pass for ever. The cap is the whole reason the column
 * exists (see db.js).
 *
 * WHY IT IS GATED ON A CONFIGURED VERIFIER. Without one, `drainCaptureQueue`
 * re-captures and writes back no verdict, so the row stays `unverified` and
 * is armed again next pass: broker traffic bought nothing. The caller passes
 * `armed: false` when `VERIFY_URL` is unset.
 */
export function enqueueVerifyBacklog(db, { accountId, now = Date.now(), limit = REVERIFY_BATCH, maxReverify = MAX_REVERIFY } = {}) {
  const acct = accountId == null ? null : String(accountId)
  if (!acct) return { armed: 0, reason: 'no_identity' }

  // Oldest closes first: the further back a record is, the less likely
  // anything else will ever revisit it.
  const rows = db.prepare(`
    SELECT h.ctrader_position_id AS pid, h.symbol AS symbol,
           q.state AS qstate, COALESCE(q.reverify_attempts, 0) AS rv,
           CASE WHEN h.rebuilt_at IS NOT NULL AND h.rebuilt_at > COALESCE(q.settled_at, '') THEN 1 ELSE 0 END AS rebuilt
      FROM position_history h
      LEFT JOIN position_capture_queue q
        ON q.account_id = h.account_id AND q.position_id = h.ctrader_position_id
     WHERE h.account_id = ?
       -- PR-AY: A STALE VERDICT IS RE-ASKED, not carried for ever.
       --
       -- unverified was the whole predicate, which made disputed
       -- TERMINAL. Measured 18-09-2026: cpp-verify compared cTrader's money
       -- integer against this keeper's dollars and disputed ten records by
       -- exactly 100x; PR-AW fixed the comparison and could reach none of
       -- them, because nothing would ever ask again. The tally would have sat
       -- at verified: 0 with a correct verifier and no way to show it.
       --
       -- So a disputed record judged under an OLDER contract is eligible
       -- again — once, because answering it stamps the current version. A
       -- record re-disputed under the current contract is a real finding and
       -- stays put. verified and absent are not re-asked: an agreement
       -- does not become a disagreement by the rules getting stricter, and
       -- re-opening one would eventually overwrite it.
       AND (h.verification_state = 'unverified'
            OR (h.verification_state = 'disputed'
                AND (h.verifier_version IS NULL OR h.verifier_version < ?)))
       AND (q.state IS NULL OR q.state = 'captured')
       -- B1 (18-09-2026): THE CAP COUNTS ASKS OF ONE RECORD. A record whose
       -- watched figures moved since its last ask (rebuilt_at newer than the
       -- queue's settled_at) has been asked zero times about what it now
       -- says — #951's boot rebuild changed volume and close time on 18
       -- capped …0949 records and the cap would have kept them unasked for
       -- ever. Same shape as PR-AU and PR-AY: a rule right in general, wrong
       -- for records changed after it was applied. The cap itself stands.
       AND (COALESCE(q.reverify_attempts, 0) < ?
            OR (h.rebuilt_at IS NOT NULL AND h.rebuilt_at > COALESCE(q.settled_at, '')))
     ORDER BY h.closed_at_ms ASC
     LIMIT ?
  `).all(acct, VERDICT_CONTRACT_VERSION, maxReverify, limit)

  let armed = 0
  for (const r of rows) {
    if (r.qstate === 'captured') {
      // `attempts` is reset because this is a fresh try at building the
      // record, and the previous build SUCCEEDED — carrying the old count
      // would push a healthy row toward `gave_up` for no reason.
      // A rebuilt record starts its count again at 1: this ask is the first
      // about the record as it now stands.
      db.prepare(`
        UPDATE position_capture_queue
           SET state = 'pending', due_at_ms = ?, attempts = 0, last_error = NULL,
               settled_at = NULL, reverify_attempts = CASE WHEN ? THEN 1 ELSE reverify_attempts + 1 END
         WHERE account_id = ? AND position_id = ?
      `).run(now, r.rebuilt ? 1 : 0, acct, r.pid)
    } else {
      // No queue row at all: a record built by an importer rather than by a
      // detected close. Due immediately — the broker settled long ago, so the
      // owner's 30 seconds do not apply.
      db.prepare(`
        INSERT INTO position_capture_queue (account_id, position_id, symbol, due_at_ms, reverify_attempts)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(account_id, position_id) DO NOTHING
      `).run(acct, r.pid, r.symbol == null ? null : String(r.symbol), now)
    }
    armed++
  }

  // THE ZERO MUST EXPLAIN ITSELF.
  //
  // The first cut returned { armed, scanned } and loop.js logged only
  // `if (backlog.armed)`. So a zero was indistinguishable from the pass not
  // running, from a failed query, from a genuinely empty backlog — and when
  // it started arming zero on 18-09-2026 with 41 eligible-looking records
  // sitting there, four theories were produced and none could be confirmed,
  // because nothing exposed the counts.
  //
  // That is the same shape as the swallowed `skipped` reason in
  // verify-client.js, written hours after fixing it. A pass that reports only
  // when it succeeds cannot be debugged from its logs.
  //
  // So every zero now carries the breakdown that accounts for it. The four
  // buckets are exhaustive against `unverified`: a record is either eligible,
  // blocked by its re-verify cap, terminal, or already queued and waiting to
  // drain. If they do not sum, that itself is the finding.
  const counts = db.prepare(`
    SELECT
      COUNT(*) AS unverified,
      SUM(CASE WHEN (q.state IS NULL OR q.state = 'captured')
                AND (COALESCE(q.reverify_attempts, 0) < ?
                     OR (h.rebuilt_at IS NOT NULL AND h.rebuilt_at > COALESCE(q.settled_at, ''))) THEN 1 ELSE 0 END) AS eligible,
      SUM(CASE WHEN COALESCE(q.reverify_attempts, 0) >= ?
                AND NOT (h.rebuilt_at IS NOT NULL AND h.rebuilt_at > COALESCE(q.settled_at, '')) THEN 1 ELSE 0 END) AS blockedByAttempts,
      SUM(CASE WHEN q.state = 'gave_up' THEN 1 ELSE 0 END) AS terminal,
      SUM(CASE WHEN q.state = 'pending' THEN 1 ELSE 0 END) AS alreadyQueued
      FROM position_history h
      LEFT JOIN position_capture_queue q
        ON q.account_id = h.account_id AND q.position_id = h.ctrader_position_id
     WHERE h.account_id = ?
       AND (h.verification_state = 'unverified'
            OR (h.verification_state = 'disputed'
                AND (h.verifier_version IS NULL OR h.verifier_version < ?)))
  `).get(maxReverify, maxReverify, acct, VERDICT_CONTRACT_VERSION) || {}

  const out = {
    armed,
    scanned: rows.length,
    unverified: counts.unverified || 0,
    eligible: counts.eligible || 0,
    blockedByAttempts: counts.blockedByAttempts || 0,
    terminal: counts.terminal || 0,
    alreadyQueued: counts.alreadyQueued || 0,
  }
  out.report = backlogReport(acct, out)
  return out
}

/**
 * A line worth logging, or null.
 *
 * WHY THIS IS DEDUPED RATHER THAN ALWAYS-ON. The pass runs per account on
 * every loop, so logging every zero would be roughly sixty lines an hour
 * saying the same thing — and a log nobody can read is as useless as one that
 * says nothing. So the breakdown is printed when it CHANGES: once when the
 * backlog enters a state, and again when it leaves. Silence then means
 * "unchanged since the last line", which is a fact rather than an absence.
 *
 * A non-zero arming ALWAYS prints, because that is an event and not a state.
 */
const lastBacklogSig = new Map()
export function backlogReport (acct, o) {
  if (o.armed > 0) {
    lastBacklogSig.delete(acct)
    return `re-armed ${o.armed} unverified record(s) for a verdict `
      + `(${o.eligible} eligible, ${o.blockedByAttempts} at the re-verify cap, `
      + `${o.terminal} terminal, ${o.alreadyQueued} already queued)`
  }
  // Nothing armed AND nothing to arm is the healthy steady state: say nothing.
  if (!o.unverified) { lastBacklogSig.delete(acct); return null }

  const sig = `${o.unverified}/${o.eligible}/${o.blockedByAttempts}/${o.terminal}/${o.alreadyQueued}`
  if (lastBacklogSig.get(acct) === sig) return null
  lastBacklogSig.set(acct, sig)
  return `backlog: 0 armed of ${o.unverified} unverified — ${o.eligible} eligible, `
    + `${o.blockedByAttempts} at the re-verify cap (${MAX_REVERIFY}), ${o.terminal} terminal, `
    + `${o.alreadyQueued} already queued`
}

/** Test seam: forget what was last reported, so a fresh state prints again. */
export function resetBacklogReports () { lastBacklogSig.clear() }

/** Rows whose time has come. */
export function dueCaptures(db, { now = Date.now(), limit = 50, accountId = null } = {}) {
  return db.prepare(`
    SELECT * FROM position_capture_queue
     WHERE state = 'pending' AND due_at_ms <= ? AND (? IS NULL OR account_id = ?) -- V3 V1: one account per drain
     ORDER BY due_at_ms ASC LIMIT ?
  `).all(now, accountId == null ? null : String(accountId), accountId == null ? null : String(accountId), limit)
}

/**
 * Pull this position's deals from the broker and persist them, so the record
 * has the broker's own figures rather than only what this process believes.
 *
 * The window is the position's life plus slack on both sides, from the local
 * row — not "the last N days", which would re-pull the same history for every
 * capture. An INCOMPLETE pull is reported and the deals are NOT persisted as
 * if whole: `lib/deal-paging.js` exists for that distinction.
 */
export async function refreshDealsFor(db, { accountId, positionId, getDeals, now = Date.now() }) {
  if (typeof getDeals !== 'function') return { ok: false, reason: 'no_getter' }
  const row = db.prepare(`
    SELECT opened_at, closed_at, closed_at_ms FROM trades
     WHERE ctrader_position_id = ? AND (account_id = ? OR ? IS NULL)
     ORDER BY (status = 'closed') DESC, id DESC LIMIT 1 -- V3 L2b W17: the closed row's life, not a newer duplicate's
  `).get(String(positionId), String(accountId), String(accountId))

  const openedMs = row?.opened_at ? Date.parse(String(row.opened_at).replace(' ', 'T') + (String(row.opened_at).endsWith('Z') ? '' : 'Z')) : NaN
  const closedMs = Number(row?.closed_at_ms) || (row?.closed_at ? Date.parse(String(row.closed_at).replace(' ', 'T') + 'Z') : NaN)
  const from = (Number.isFinite(openedMs) ? openedMs : now - 24 * 3_600_000) - DEAL_WINDOW_SLACK_MS
  const to = (Number.isFinite(closedMs) ? closedMs : now) + DEAL_WINDOW_SLACK_MS

  const pull = await pageDeals(getDeals, from, Math.max(to, from + 1))
  if (!pull.deals.length) return { ok: pull.complete, reason: pull.complete ? 'no_deals' : pull.reason, complete: pull.complete }

  const { shapeDeals, persistDeals } = await import('./broker-history-import.js')
  let symMeta = {}
  try {
    const idMap = accountSymbolMap(db, accountId) // V3 V1: THIS account's names — ids are per environment
    for (const [name, id] of Object.entries(idMap)) symMeta[id] = { symbolName: name }
  } catch { symMeta = {} }
  const persisted = persistDeals(db, shapeDeals(pull.deals, withBrokerLotSizes(db, symMeta), accountId)) // V3 L2b W10: lots stored
  return { ok: pull.complete, complete: pull.complete, reason: pull.complete ? null : pull.reason, deals: pull.deals.length, persisted: persisted?.seen || 0 }
}

/**
 * Work the queue.
 *
 * `deps.getDeals(from, to)` is the broker pull; `deps.verify(record)` is
 * cpp-verify, and BOTH ARE OPTIONAL. Without a deal getter the capture still
 * runs off local rows — it will usually be refused by the completeness gate,
 * which is the honest outcome rather than a fabricated one. Without a
 * verifier the record simply stays `unverified`, which is exactly what it is.
 */
export async function drainCaptureQueue(db, { getDeals = null, verify = null, lotSizeFor = null, now = Date.now(), limit = 50, env = process.env, accountId = null, stopOnDealError = false, deadline = null, clock = Date.now } = {}) {
  // V3 V1: `accountId` drains ONE account's rows — the deal reader and the
  // verifier credentials a caller hands over belong to one account, and an
  // unscoped read would pull account B's positions through account A's deal
  // history. Without it, the drain is exactly as before (tests and tools).
  const rows = dueCaptures(db, { now, limit, accountId })
  const out = { due: rows.length, captured: 0, incomplete: 0, gaveUp: 0, archived: 0, verified: 0, answered: 0, skipped: 0, errors: [], stopped: null }

  for (const row of rows) {
    // V3 V1: a pass has a time budget across every account. A row not
    // started is not attempted — its count is untouched and it is simply
    // first in line next pass.
    if (deadline != null && clock() > deadline) { out.stopped = 'pass_budget'; break }
    const attempts = (row.attempts || 0) + 1
    let dealNote = null
    let dealThrew = false
    try {
      if (getDeals) {
        const r = await refreshDealsFor(db, { accountId: row.account_id, positionId: row.position_id, getDeals, now })
        if (!r.ok && r.reason) dealNote = `deals: ${r.reason}`
      }
    } catch (e) {
      dealNote = `deals threw: ${e.message}`
      dealThrew = true
    }

    const res = capturePosition(db, { accountId: row.account_id, positionId: row.position_id })

    if (res.ok) {
      out.captured++
      const arch = archiveRecord(res.record, { env })
      if (arch.ok) out.archived++
      else out.errors.push(`archive ${row.position_id}: ${arch.reason}`)

      if (verify) {
        try {
          // The symbol's lotSize rides with the record so the verifier can
          // compare lots (contract 3) — from the broker's declaration only.
          const v = await verify(await withBrokerLotSize(db, res.record, { lotSizeFor }))
          // A SKIPPED VERDICT IS SAID OUT LOUD. verify() already knows exactly
          // why it could not answer — http_409, connect_no_accounts, timeout,
          // bad_reply, no_host — and the first version of this block dropped
          // that on the floor with `if (v && v.state)`. The result was four
          // passes reporting "10 captured · 0 verified" with no error line and
          // no way to tell a verifier that is down from one that disagrees.
          // Failure mode #3 inside the verification path itself.
          if (v && !v.state && v.skipped) out.errors.push(`verify ${row.position_id}: skipped ${v.skipped}`)
          // V3 V1 fix round: `unverified` with fetchComplete false is the
          // verifier saying it READ NOTHING from the broker — "not connected"
          // once its broker socket drops, which it never re-opens by itself
          // (verify_session.cpp). That is a reply about the verifier, not a
          // verdict about this record: it is counted as unanswered (so the
          // account's verify streak can fire) and NOT stored, because storing
          // it would stamp a verdict time on nothing and overwrite whatever
          // the record last held — a dispute under an older contract, say.
          // `=== false` on purpose: the client always sets the flag, and a
          // verifier that does not say is judged as before.
          const noRead = !!v && v.state === 'unverified' && v.fetchComplete === false
          if (noRead) out.errors.push(`verify ${row.position_id}: no broker read (${v.reason || 'fetch incomplete'})`)
          // V3 V1: an ask the verifier did not answer is COUNTED, so a
          // verifier that keeps refusing one account shows as that account's
          // failure rather than as a quiet `0 verified`.
          if (!v || !v.state || noRead) out.skipped++
          if (v && v.state && !noRead) {
            out.answered++
            recordVerdict(db, {
              accountId: row.account_id, positionId: row.position_id,
              state: v.state, disputes: v.disputes || [], host: v.host || null,
              contractVersion: v.contractVersion ?? null,
            })
            if (v.state === 'verified') out.verified++
            // A DISPUTE IS LOUD. It means the broker and this system disagree
            // about a closed trade, which is the condition the verifier was
            // built to surface — not a line in a summary count.
            if (v.state === 'disputed') {
              log(`DISPUTED ${row.symbol || ''} position ${row.position_id}: ${(v.disputes || []).map(d => `${d.field} ours=${d.keeper} broker=${d.broker}`).join('; ')}`)
            }
          }
        } catch (e) {
          out.skipped++
          out.errors.push(`verify ${row.position_id}: ${e.message}`)
        }
      }

      db.prepare(`
        UPDATE position_capture_queue
           SET state = 'captured', attempts = ?, last_error = NULL,
               settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE account_id = ? AND position_id = ?
      `).run(attempts, row.account_id, row.position_id)
      continue
    }

    // Not complete yet. Retry with a widening gap — a broker row can arrive
    // minutes late — and stop after MAX_ATTEMPTS rather than retrying forever
    // against a gap that is structural (no plan row was ever written, say).
    out.incomplete++
    const why = [dealNote, `missing: ${(res.missing || []).join(', ') || res.reason}`].filter(Boolean).join(' · ')
    if (attempts >= MAX_ATTEMPTS) {
      out.gaveUp++
      db.prepare(`
        UPDATE position_capture_queue
           SET state = 'gave_up', attempts = ?, last_error = ?,
               settled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE account_id = ? AND position_id = ?
      `).run(attempts, why.slice(0, 500), row.account_id, row.position_id)
      // Said out loud, once, naming the position and what was missing. The
      // record stays in position_history_incomplete, so this is not a loss of
      // data — it is the end of trying to complete it automatically.
      log(`GAVE UP on ${row.symbol || ''} position ${row.position_id} after ${attempts} attempts — ${why}`)
    } else {
      db.prepare(`
        UPDATE position_capture_queue
           SET attempts = ?, last_error = ?, due_at_ms = ?
         WHERE account_id = ? AND position_id = ?
      `).run(attempts, why.slice(0, 500), now + RETRY_BASE_MS * Math.pow(2, attempts - 1), row.account_id, row.position_id)
    }
    // V3 V1: an account whose deal read THREW (transport, auth) stops here
    // for this pass instead of spending one attempt on every due row — six
    // failed reads would otherwise mark six good captures gave_up in one
    // pass for a connection fault, not a gap in the record.
    if (stopOnDealError && dealThrew) { out.stopped = 'deal_read_failed'; break }
  }
  return out
}

/** For the state route and the daily report. */
export function captureQueueView(db) {
  const counts = db.prepare(`
    SELECT state, COUNT(*) AS n FROM position_capture_queue GROUP BY state
  `).all()
  const byState = Object.fromEntries(counts.map(r => [r.state, r.n]))
  const gaveUp = db.prepare(`
    SELECT account_id, position_id, symbol, attempts, last_error, settled_at
      FROM position_capture_queue WHERE state = 'gave_up'
     ORDER BY settled_at DESC LIMIT 50
  `).all()
  return {
    pending: byState.pending || 0,
    captured: byState.captured || 0,
    gaveUp: byState.gave_up || 0,
    // Named, not just counted: each one is a closed trade this system could
    // not describe, and the reason is the actionable part.
    gaveUpRows: gaveUp,
    archive: archiveDir() || 'unconfigured (DB_PATH not set — see the boot warning)',
  }
}
