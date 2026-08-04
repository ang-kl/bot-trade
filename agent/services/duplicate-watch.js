// ---------------------------------------------------------------------------
// agent/services/duplicate-watch.js — tell somebody the FIRST time a duplicate
// cluster appears, and again when it clears.
//
// WHY (#144, "flag any new same-second duplicate pair during the soak"):
// findOpenDuplicates already detects them correctly, and it detected both real
// incidents — the nine 0066.HK on 2026-08-03 and the six 0005.HK on
// 2026-08-04, each nine or six rows sharing an account, symbol, side, entry
// and second. Neither was noticed by the detector. They were noticed by the
// owner, from a phone, a day later.
//
// The gap is not detection, it is that nothing CALLS the detector. It is a
// route: it answers when asked, and nobody was asking. So this is a watch, and
// the only interesting design questions in a watch are about repetition.
//
// ALERT ONCE PER CLUSTER, NOT ONCE PER PASS. The obvious version alerts every
// cycle while the cluster is open, which on a five-minute loop is 288 messages
// a day about one already-known fact. That is how the targetless-position
// alert became a flood the owner complained about ("SO MANY POSITIONS WITH NO
// TARGET SET"), and the same fix applies: a stable cluster identity, stored,
// with a re-alert only after the ESCALATION window and only if the cluster
// grew.
//
// THE STORE IS PER ACCOUNT, for the reason PR #625 fixed in the naked-position
// guard: the pass runs per account, so a single global mute map has each
// account's prune deleting the other's stamps, and the mute stops working for
// everybody.
//
// AND IT SAYS WHEN A CLUSTER CLEARS. A watch that only ever reports bad news
// leaves the owner unable to tell "fixed" from "the watch stopped working" —
// and the 0066.HK nine did in fact clear on their own, at the broker,
// overnight. That was worth knowing and nothing said it.
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { findOpenDuplicates } from './trade-integrity.js'

/** Re-alert about a still-open cluster no more often than this. */
export const ESCALATE_AFTER_MS = 6 * 60 * 60 * 1000   // 6h

/** Stamps older than this are pruned — a cluster gone this long is history. */
export const FORGET_AFTER_MS = 7 * 24 * 60 * 60 * 1000

const stateKey = (accountId) =>
  accountId == null || accountId === ''
    ? 'duplicate_watch_seen_json'
    : `acct:${String(accountId)}:duplicate_watch_seen_json`

/**
 * A cluster's identity, stable across passes.
 *
 * Deliberately NOT the row ids: the same real cluster gains and loses local
 * rows as the reconciler adopts and closes them, and an id-based key would
 * read every such change as a brand-new cluster and alert again. Account +
 * symbol + side + kind is what an operator would call "the same problem".
 */
export function clusterKey(g) {
  return [g?.kind ?? 'unknown', g?.accountId ?? '', g?.symbol ?? '', g?.side ?? ''].join('|')
}

function readSeen(db, accountId) {
  try {
    const raw = JSON.parse(getState(db, stateKey(accountId)) || '{}')
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

/**
 * One pass for ONE account.
 *
 * Pure-ish: takes the clock and the notifier, so the repetition rules are
 * testable without waiting six hours or sending a message.
 *
 * @returns {{ newClusters, escalated, cleared, open, alerts: string[] }}
 */
export function duplicateWatchPass(db, { accountId = null, nowMs = Date.now() } = {}) {
  // `scope` is an OBJECT ({ accountId }), not a bare id — accountWhere reads
  // scope.accountId and treats anything else as "no filter". Passing the
  // string silently returned EVERY account's clusters under whichever account
  // happened to be asking, which is both a false alarm and wrong about whose
  // exposure it is. Caught by the per-account test on the first run.
  const found = findOpenDuplicates(db, { scope: accountId == null ? null : { accountId } })
  const groups = found?.groups || []

  const seen = readSeen(db, accountId)
  const alerts = []
  const newClusters = []
  const escalated = []
  const cleared = []

  const liveKeys = new Set()

  for (const g of groups) {
    const key = clusterKey(g)
    liveKeys.add(key)
    const size = g.count ?? 0
    const prev = seen[key]

    // A cluster that CLEARED and came back is news again, not a continuation.
    // Without this the stamp survives the clear, `grew` is false because the
    // size matches, `stale` is false because the clear was recent — and the
    // recurrence is silent. That is the exact shape of what happened here:
    // nine 0066.HK cleared overnight and six 0005.HK appeared the next day.
    // Caught by the clears-and-returns test on the first run.
    if (!prev || prev.clearedAt) {
      newClusters.push({ key, size, kind: g.kind, recurrence: !!prev })
      alerts.push(describe(g, prev ? 'RETURNED' : 'NEW'))
      seen[key] = { firstAt: nowMs, lastAlertAt: nowMs, size, kind: g.kind }
      continue
    }

    // Growing is news even inside the quiet window: nine positions is a
    // different problem from two, and the 0066.HK cluster grew over minutes.
    const grew = size > (prev.size ?? 0)
    const stale = nowMs - (prev.lastAlertAt ?? 0) >= ESCALATE_AFTER_MS
    if (grew || stale) {
      escalated.push({ key, size, from: prev.size ?? 0, reason: grew ? 'grew' : 'still_open' })
      alerts.push(describe(g, grew ? `GREW from ${prev.size}` : 'STILL OPEN'))
      prev.lastAlertAt = nowMs
    }
    prev.size = size
    prev.kind = g.kind
  }

  // Anything stamped but no longer found has cleared. Say so once, then prune.
  for (const [key, rec] of Object.entries(seen)) {
    if (liveKeys.has(key)) continue
    if (!rec.clearedAt) {
      rec.clearedAt = nowMs
      cleared.push({ key, size: rec.size ?? 0 })
      const [kind, account, symbol, side] = key.split('|')
      alerts.push(`✅ duplicate cluster CLEARED: ${symbol} ${side} on ${account || 'unstamped'} (${kind}) — ${rec.size ?? 0} position(s) no longer duplicated`)
    }
    if (nowMs - (rec.clearedAt ?? nowMs) >= FORGET_AFTER_MS) delete seen[key]
  }

  setState(db, stateKey(accountId), JSON.stringify(seen))
  return { newClusters, escalated, cleared, open: groups.length, alerts }
}

function describe(g, prefix) {
  // The detector's own `note` states the severity in words; repeating it here
  // rather than re-deriving keeps one description of what a kind means.
  const ids = (g.brokerPositionIds?.length ? g.brokerPositionIds : g.tradeIds || []).slice(0, 8).join(', ')
  return [
    `⚠️ duplicate cluster ${prefix}: ${g.count ?? 0} × ${g.symbol ?? '?'} ${g.side ?? ''}`,
    `account ${g.accountId ?? 'unstamped'} · entry ${g.entryPrice ?? '?'} · ${g.extraLegs ?? 0} extra leg(s), ${g.extraVolume ?? 0} extra volume`,
    g.note || null,
    ids ? `ids: ${ids}` : null,
  ].filter(Boolean).join('\n')
}
