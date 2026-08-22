// ---------------------------------------------------------------------------
// agent/services/minute-review.js — Operating Goal Plan §70.4, the per-minute
// management policy loop. §41's level 5.
//
// WHY IT EXISTS. §41 names eight authority levels. Level 5 — "per-minute
// management policy" — is the only one with no code behind it at all;
// docs/position-write-authority.md marks it **does not exist**. §43 says each
// authority must have "its own functioning and observable path", so this gets
// its own ticker, its own overlap guard and its own heartbeat rather than a
// seat on somebody else's timer. A review that only runs when the fast monitor
// is idle is a review that stops exactly when things are busy.
//
// WHAT IT DOES NOT DO. It does not write. Not a stop, not a close, not a
// broker call of any kind. §36.2.3 — "two components must not unknowingly
// write the same stop" — is why: adding a fifth writer to a system whose four
// existing writers are kept apart only by convention would make the problem it
// is meant to observe strictly worse. This loop reads the journal the writers
// already keep and reports what it finds.
//
// FIRST POLICY: THE OWNER-STOP OVERRIDE NOTICE (owner, 2026-08-04).
// The owner settled the §41.1-vs-§41.2 contradiction in favour of the numbered
// list: the automated managers DO outrank a hand-placed stop, so a profit
// keeper may move one. What they asked for instead of a veto is to be told:
// "highlight/telegram if bot want to move the hand-placed stop". That is the
// right shape. A block would trade one silent failure for another — a position
// stuck on a stop nobody is maintaining — whereas a notice keeps the machinery
// working and puts the human in the loop.
//
// The notice distinguishes the two cases, because they are not equally
// contentious:
//   · capital safety (§41 levels 1-2) overrode you — both readings of the plan
//     agree this is allowed, and it means an account-level limit fired,
//   · an automated manager (levels 3, 4, 6) overrode you — permitted ONLY by
//     §41.1's numbered list. This is the contested case, and the one worth
//     looking at.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { recordPositionEvent } from './position-events.js'
import { authorityForSource, isOwnerSource, isCapitalSafetySource } from './management-state.js'

/** agent_state cursor: the highest position_events id this loop has examined. */
export const CURSOR_KEY = 'minute_review_last_event_id'

/** Rows examined per pass. A backlog drains over several passes rather than in one long one. */
export const BATCH = 500

/**
 * Pure detector: which of these stop moves overrode a standing owner stop?
 *
 * `events` must be chronological (ascending id) and must include the owner's
 * standing instruction for each position, not only the new rows — otherwise a
 * batch boundary would hide the very thing being looked for.
 *
 * One report per owner instruction. After an override is reported the owner's
 * stop stops being "standing": the machine has taken it, and the next notice
 * waits for the owner to place another. Without that, one profit keeper
 * trailing a stop every minute would produce an alert every minute, and an
 * alert that arrives every minute is one nobody reads.
 */
export function detectOwnerStopOverrides(events) {
  const standing = new Map() // position id → the owner's most recent sl_moved
  const out = []
  for (const e of events || []) {
    const pid = e?.position_id != null ? String(e.position_id) : ''
    if (!pid || e.kind !== 'sl_moved') continue
    if (isOwnerSource(e.source)) { standing.set(pid, e); continue }
    const own = standing.get(pid)
    if (!own) continue
    // A no-op amend is not an override. Writers re-assert the same stop
    // routinely; only a CHANGED value took the owner's decision away.
    if (e.from_value != null && e.to_value != null && Number(e.from_value) === Number(e.to_value)) continue
    if (own.to_value != null && e.to_value != null && Number(own.to_value) === Number(e.to_value)) continue
    standing.delete(pid)
    out.push({
      eventId: e.id,
      positionId: pid,
      accountId: e.account_id ?? null,
      symbol: e.symbol,
      ownerSl: own.to_value ?? null,
      ownerAt: own.at ?? null,
      ownerSource: own.source ?? null,
      ownerEventId: own.id,
      newSl: e.to_value ?? null,
      by: e.source ?? null,
      authority: authorityForSource(e.source),
      capitalSafety: isCapitalSafetySource(e.source),
      reason: e.reason ?? null,
      at: e.at ?? null,
    })
  }
  return out
}

/** The owner-facing text for one override. */
export function overrideMessage(o) {
  const sl = (v) => (v == null ? '—' : String(v))
  const who = o.by || 'an unregistered writer'
  const head = o.capitalSafety
    ? `🛡️ Capital safety moved your stop`
    : `✋ The bot moved a stop you placed by hand`
  const why = o.capitalSafety
    ? `That layer overrides you under both readings of §41 — it fires on an account-level limit, not a view about this position.`
    : `Under §41.1's numbered list this is allowed: ${o.authority || 'unknown authority'} sits above human owner instruction. Flagging it because you asked to see it, not because it failed.`
  return [
    `${head} — ${o.symbol} (position ${o.positionId})`,
    `Your stop ${sl(o.ownerSl)} → ${sl(o.newSl)}, moved by ${who}.`,
    o.reason ? `Reason given: ${o.reason}` : null,
    why,
  ].filter(Boolean).join('\n')
}

/**
 * One pass. Never throws — a review that can crash the ticker is worse than no
 * review. Deps injectable for tests: { notify, now }.
 */
export function runMinuteReview(db, deps = {}) {
  const notify = deps.notify ?? (() => {})
  try {
    const maxRow = db.prepare('SELECT MAX(id) AS m FROM position_events').get()
    const maxId = Number(maxRow?.m ?? 0)

    const raw = getState(db, CURSOR_KEY)
    if (raw == null || raw === '') {
      // FIRST SIGHTING ARMS, IT DOES NOT FIRE — the same discipline as the
      // fast monitor's cadence gate. Starting with no cursor and alerting on
      // everything would greet the operator with every override in ninety days
      // of journal, which is how a useful alert becomes a muted one on day one.
      setState(db, CURSOR_KEY, String(maxId))
      return { armed: true, cursor: maxId, reviewed: 0, overrides: [] }
    }
    const cursor = Number(raw) || 0
    if (maxId <= cursor) return { reviewed: 0, cursor, overrides: [] }

    const fresh = db.prepare(
      `SELECT * FROM position_events
        WHERE id > ? AND id <= ? AND kind = 'sl_moved'
        ORDER BY id LIMIT ?`
    ).all(cursor, maxId, BATCH)

    // Advance only as far as we actually looked. A batch that stops short must
    // not skip the rows it did not read.
    const nextCursor = fresh.length === BATCH ? fresh[fresh.length - 1].id : maxId

    if (fresh.length === 0) {
      setState(db, CURSOR_KEY, String(nextCursor))
      return { reviewed: 0, cursor: nextCursor, overrides: [] }
    }

    // The owner's standing instruction lives BEFORE this batch, so fetch it
    // per position. Without this the detector could only see overrides where
    // both halves happened to land in the same 500 rows.
    const priorOwner = db.prepare(
      `SELECT * FROM position_events
        WHERE position_id = ? AND kind = 'sl_moved' AND id <= ?
          AND source IN ('manual','telegram')
        ORDER BY id DESC LIMIT 1`
    )
    // Dedupe across passes with the journal itself rather than more state: an
    // override already reported left an `authority_override` row behind, so an
    // owner instruction that already has one is spent.
    const alreadyReported = db.prepare(
      `SELECT 1 FROM position_events
        WHERE position_id = ? AND kind = 'authority_override' AND id > ? LIMIT 1`
    )

    const context = []
    const seen = new Set()
    for (const e of fresh) {
      const pid = e.position_id != null ? String(e.position_id) : ''
      if (!pid || seen.has(pid)) continue
      seen.add(pid)
      try {
        const own = priorOwner.get(pid, cursor)
        if (own) context.push(own)
      } catch { /* a missing context row costs one notice, not the pass */ }
    }

    const merged = [...context, ...fresh].sort((a, b) => a.id - b.id)
    const overrides = detectOwnerStopOverrides(merged).filter(o => {
      try { return !alreadyReported.get(o.positionId, o.ownerEventId) } catch { return true }
    })

    for (const o of overrides) {
      // Recording FIRST is deliberate. The row is what stops the next pass
      // re-reporting the same override, so a Telegram outage must not be able
      // to turn one notice into an endless one.
      recordPositionEvent(db, {
        accountId: o.accountId,
        positionId: o.positionId,
        symbol: o.symbol,
        kind: 'authority_override',
        fromValue: o.ownerSl,
        toValue: o.newSl,
        reason: `${o.by || 'unknown'} moved an owner-placed stop`,
        source: 'minute_review',
        detail: {
          by: o.by,
          authority: o.authority,
          capitalSafety: o.capitalSafety,
          ownerEventId: o.ownerEventId,
          overrideEventId: o.eventId,
          writerReason: o.reason,
        },
      })
      try { notify(overrideMessage(o)) } catch { /* notification is best-effort */ }
      console.warn(`[minute-review] ${o.symbol}: ${o.by} moved owner stop ${o.ownerSl} → ${o.newSl} (position ${o.positionId})`)
    }

    setState(db, CURSOR_KEY, String(nextCursor))
    return { reviewed: fresh.length, cursor: nextCursor, overrides }
  } catch (err) {
    return { error: err.message, reviewed: 0, overrides: [] }
  }
}

/**
 * Start the per-minute review ticker. Returns a stop() handle.
 *
 * §38.3's overlap guard, for the same reason the fast monitor has one: a pass
 * that overruns must skip ticks rather than stack copies of itself. This pass
 * is pure SQLite and short, so an overrun means something is badly wrong — the
 * guard exists so that "badly wrong" degrades into "runs less often" instead of
 * "runs concurrently against the cursor it is about to advance".
 */
export function startMinuteReview(db, deps = {}) {
  const tickMs = deps.tickMs ?? Math.max(15_000, Number(process.env.MINUTE_REVIEW_MS) || 60_000)
  let reviewRunning = false
  let skipped = 0
  const t = setInterval(async () => {
    if (reviewRunning) {
      skipped++
      // console.LOG, not warn (2026-08-22). Overlap protection working is not
      // an error: this is the ticker declining to start a second pass while
      // the first is still going, which is the guard doing its job. At `warn`
      // it was the single most frequent line in production and it drowned the
      // real errors around it — a log nobody can scan is a log nobody reads.
      if (skipped === 1 || skipped % 20 === 0) console.log(`[minute-review] previous pass still running — skipped ${skipped} tick(s)`)
      return
    }
    reviewRunning = true
    try {
      const res = runMinuteReview(db, {
        notify: (text) => import('./telegram-control.js').then(m => m.notifyOwner(text)).catch(() => {}),
        ...deps,
      })
      const hb = deps.heartbeat ?? await import('./heartbeat.js')
      hb.beat(db, 'minute_review', { ok: !res.error, error: res.error ?? null })
      skipped = 0
    } catch (err) {
      console.error('[minute-review] tick failed:', err.message)
      try {
        const hb = deps.heartbeat ?? await import('./heartbeat.js')
        hb.beat(db, 'minute_review', { ok: false, error: err.message })
      } catch { /* heartbeat is best-effort */ }
    } finally {
      reviewRunning = false
    }
  }, tickMs)
  t.unref?.()
  return () => clearInterval(t)
}
