// OPPORTUNITY IDENTITY — §70.8's missing primitive.
//
// THE MEASUREMENT THAT FORCED THIS (05-08-2026, production, 75-minute window):
//
//     500 risk-gate evaluations  →  63 distinct account|symbol|side
//                                   = 7.9x re-evaluation
//
// Every scan cycle re-scores the SAME setup and writes another risk_events
// row. So `proposalsApproved` has never counted opportunities — it counts
// evaluations — and any funnel built by subtracting one from the other is
// comparing two different units.
//
// That is exactly how "276 approved, 59 opened, 217 went nowhere" was
// produced. It was wrong, and it was wrong in the same shape as the earlier
// "96 approved, 79 orders, 17 went nowhere" that decision-audit.js's own
// header records. Twice now the aggregate has looked alarming because nothing
// downstream could say WHICH approval was which.
//
// §70.9 already carries lineage FORWARD (risk_events.id lands on the trade or
// pending order it produced) and §70.8 already carries terminal disposition.
// Neither can collapse the eight rows that describe one setup into one thing.
// This module is that collapse, and it is the last piece.
//
// WHAT AN OPPORTUNITY IS. One tradeable setup on one account:
//
//     account | symbol | side | strategy
//
// and it stays the same opportunity while the scanner keeps seeing it. When
// re-evaluation stops for longer than `gapMs`, the setup is gone; the next
// evaluation of that tuple is a NEW opportunity.
//
// WHY A GAP RULE RATHER THAN A TIME BUCKET. A fixed bucket (per hour, per
// bar) splits one setup across a boundary and merges two genuinely different
// setups that happen to share one. The gap rule follows the thing being
// measured — continuous attention — rather than the clock.
//
// WHY NOT INCLUDE THE PRICE LEVEL. Entry, SL and TP drift a few pips between
// evaluations as the quote moves; keying on them would make every evaluation
// its own opportunity, which is the bug this exists to fix.
//
// THE KEY IS DERIVED, NOT RANDOM. Same inputs, same key, in any process, with
// no coordination — so a backfill over historical rows produces exactly what
// the live path would have produced.

/** Two evaluations more than this far apart are different opportunities. */
export const DEFAULT_GAP_MS = 30 * 60 * 1000

const norm = (v) => (v == null || v === '' ? '' : String(v).trim().toUpperCase())

/**
 * The stable part of an opportunity's identity — everything except WHICH
 * occurrence it is. Two separate visits to the same setup share this.
 */
export function opportunityTuple(proposal = {}, accountId = null) {
  const acct = accountId != null ? accountId : proposal.accountId
  return [
    acct == null || acct === '' ? '-' : String(acct),
    norm(proposal.symbol) || '-',
    norm(proposal.side) || '-',
    // Strategy is part of identity on purpose: the same symbol and side found
    // by two different strategies are two opportunities, and merging them
    // would hide a strategy that never reaches the market behind one that
    // does — which is the Strategy Liveness question.
    norm(proposal.strategy) || '-',
  ].join('|')
}

/**
 * The full key: the tuple plus the epoch-ms of the occurrence's FIRST
 * evaluation. Readable on purpose — this ends up in an audit table and in a
 * support conversation, and a hash would make both worse.
 */
export function opportunityKey(proposal, accountId, startedAtMs) {
  return `${opportunityTuple(proposal, accountId)}@${Math.trunc(startedAtMs)}`
}

/** The tuple half of a key, for grouping without re-deriving from a proposal. */
export function tupleOf(key) {
  if (typeof key !== 'string') return null
  const at = key.lastIndexOf('@')
  return at <= 0 ? null : key.slice(0, at)
}

/** When this occurrence started, in epoch ms — or null if the key is malformed. */
export function startedAtOf(key) {
  if (typeof key !== 'string') return null
  const at = key.lastIndexOf('@')
  if (at <= 0) return null
  const n = Number(key.slice(at + 1))
  return Number.isFinite(n) ? n : null
}

/**
 * Decide which opportunity an evaluation belongs to, given the most recent
 * evaluation of the same tuple.
 *
 * `previous` is `{ opportunity_key, created_at }` or null/undefined.
 *
 * Returns `{ key, isNew, gapMs }`. `isNew` is what a caller counts to get a
 * true opportunity count without a GROUP BY.
 */
export function resolveOpportunity(proposal, {
  accountId = null, now = Date.now(), previous = null, gapMs = DEFAULT_GAP_MS,
} = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now)
  const prevKey = previous?.opportunity_key ?? null
  // Number(null) is 0 and Date.parse(null) is NaN — both would silently make
  // a missing timestamp look like the epoch, i.e. an infinite gap, i.e. every
  // evaluation its own opportunity. Checked explicitly.
  const prevAtRaw = previous?.created_at
  const prevAt = prevAtRaw == null || prevAtRaw === '' ? NaN : Date.parse(prevAtRaw)

  if (!prevKey || !Number.isFinite(prevAt)) {
    return { key: opportunityKey(proposal, accountId, nowMs), isNew: true, gapMs: null }
  }
  // A previous row whose tuple does not match ours is not ours — a caller that
  // queried loosely must not be able to graft this evaluation onto it.
  if (tupleOf(prevKey) !== opportunityTuple(proposal, accountId)) {
    return { key: opportunityKey(proposal, accountId, nowMs), isNew: true, gapMs: null }
  }
  const elapsed = nowMs - prevAt
  // A clock that went backwards (NTP step, a replayed row) must not open a new
  // opportunity — negative elapsed means "at the same time", not "long ago".
  if (elapsed > gapMs) {
    return { key: opportunityKey(proposal, accountId, nowMs), isNew: true, gapMs: elapsed }
  }
  return { key: prevKey, isNew: false, gapMs: elapsed }
}

/**
 * The DB half, kept separate from the pure logic above so the rule can be
 * tested without a database and the query can be indexed without touching the
 * rule. Returns the same shape as resolveOpportunity.
 *
 * Scoped by account as well as symbol/side: two accounts evaluating the same
 * symbol are two opportunities, and sharing a key would let one account's
 * order close out the other's row.
 */
export function nextOpportunityKey(db, proposal, {
  accountId = null, now = Date.now(), gapMs = DEFAULT_GAP_MS,
} = {}) {
  const acct = accountId != null ? accountId : proposal?.accountId
  let previous = null
  try {
    previous = db.prepare(
      `SELECT opportunity_key, created_at
         FROM risk_events
        WHERE opportunity_key IS NOT NULL
          AND UPPER(symbol) = ?
          AND UPPER(side) = ?
          AND (account_id = ? OR (account_id IS NULL AND ? IS NULL))
        ORDER BY created_at DESC
        LIMIT 1`
    ).get(
      norm(proposal?.symbol),
      norm(proposal?.side),
      acct == null ? null : String(acct),
      acct == null ? null : String(acct),
    ) || null
  } catch {
    // A missing column (pre-migration DB) must degrade to "every evaluation
    // is new" rather than take the risk gate down with it. The gate decides
    // money; this decides a label.
    previous = null
  }
  return resolveOpportunity(proposal || {}, { accountId: acct, now, previous, gapMs })
}

/**
 * BACKFILL. Without this the funnel describes only rows written after the
 * migration, and `unkeyed` swamps every rate for as long as the window
 * reaches back — which is precisely when the owner wants to read it.
 *
 * The key is DERIVED, so replaying the same rule over history in time order
 * produces exactly the keys the live path would have written. That is the
 * whole reason the key is not a random id.
 *
 * BOUNDED ON PURPOSE. `limit` caps one call so this can ride an existing
 * housekeeping pass instead of blocking boot on a full-table rewrite. It is
 * idempotent — only NULL keys are touched — so repeated calls walk the
 * backlog and then cost one indexed count.
 *
 * Rows are read in (tuple, time) order so each row sees the row before it in
 * ITS OWN tuple. Reading in plain time order would compare a row against
 * whatever unrelated symbol happened to precede it.
 */
export function backfillOpportunityKeys(db, { limit = 5000, gapMs = DEFAULT_GAP_MS } = {}) {
  const pending = db.prepare(
    `SELECT COUNT(*) AS n FROM risk_events WHERE opportunity_key IS NULL`
  ).get()?.n || 0
  if (pending === 0) return { scanned: 0, keyed: 0, opportunities: 0, remaining: 0 }

  // Ordered by the tuple first so one pass can carry "previous in this tuple"
  // in a single variable rather than a map that grows with the table.
  const rows = db.prepare(
    `SELECT id, symbol, side, account_id, proposal_json, created_at
       FROM risk_events
      WHERE opportunity_key IS NULL
      ORDER BY account_id, symbol, side, created_at, id
      LIMIT ?`
  ).all(Math.max(1, Math.min(50_000, Number(limit) || 5000)))

  const set = db.prepare(`UPDATE risk_events SET opportunity_key = ? WHERE id = ?`)
  let keyed = 0
  let opportunities = 0
  let prevTuple = null
  let prevKey = null
  let prevAt = NaN

  const run = db.transaction(() => {
    for (const r of rows) {
      let strategy = null
      try { strategy = JSON.parse(r.proposal_json || '{}')?.strategy ?? null } catch { strategy = null }
      const proposal = { symbol: r.symbol, side: r.side, strategy }
      const tuple = opportunityTuple(proposal, r.account_id)
      const atMs = r.created_at == null || r.created_at === '' ? NaN : Date.parse(r.created_at)
      // A row with no usable timestamp cannot be placed in a sequence. It is
      // left NULL — reported as `unkeyed` — rather than guessed into a
      // neighbouring opportunity it may not belong to.
      if (!Number.isFinite(atMs)) continue

      const sameTuple = tuple === prevTuple
      const previous = sameTuple && prevKey && Number.isFinite(prevAt)
        ? { opportunity_key: prevKey, created_at: new Date(prevAt).toISOString() }
        : null
      const res = resolveOpportunity(proposal, { accountId: r.account_id, now: atMs, previous, gapMs })
      set.run(res.key, r.id)
      keyed += 1
      if (res.isNew) opportunities += 1
      prevTuple = tuple
      prevKey = res.key
      prevAt = atMs
    }
  })
  run()

  return {
    scanned: rows.length,
    keyed,
    opportunities,
    remaining: db.prepare(`SELECT COUNT(*) AS n FROM risk_events WHERE opportunity_key IS NULL`).get()?.n || 0,
  }
}
