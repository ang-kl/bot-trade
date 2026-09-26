// Pure readings for the engine status surfaces (tested directly; the
// components render them). One vocabulary for every page, straight from the
// server's record: requested vs effective mode, the transition state, how
// old the answer is, and the readiness blockers grouped by the plan's five
// classes. Nothing here guesses a mode from a flag.

export const MODE_LABEL = Object.freeze({ TIME_BASED: 'Time-based', TICK_MOMENTUM: 'Tick momentum', STOPPED: 'Stopped' })
export const STALE_AFTER_MS = 60_000

// WP-A (dual admission, 25-09-2026): the four selections the website offers,
// each the exact body the server's POST /actions/entry-mode takes. "Time +
// tick" is not a mode — it is TIME_BASED with both bases admitted — so every
// reading below goes through the bases, never the mode string alone.
export const SELECTIONS = Object.freeze({
  stopped: Object.freeze({ mode: 'STOPPED' }),
  time: Object.freeze({ mode: 'TIME_BASED' }),
  tick: Object.freeze({ mode: 'TICK_MOMENTUM' }),
  'time+tick': Object.freeze({ mode: 'TIME_BASED', admittedBases: Object.freeze(['bar', 'tick']) }),
})
export const SELECTION_LABEL = Object.freeze({ stopped: 'Stopped', time: 'Time-based', tick: 'Tick momentum', 'time+tick': 'Time + tick' })
const MODE_BASIS = Object.freeze({ TIME_BASED: 'bar', TICK_MOMENTUM: 'tick', STOPPED: null })

/**
 * The server's basesFor (agent/services/entry-mode.js), mirrored: STOPPED
 * admits nothing; a non-empty admittedBases is the whole answer; otherwise
 * the mode's own basis. Absent fields read as null (older fixtures and
 * payloads carry no admittedBases).
 */
export function basesFor(st) {
  if (!st || st.effectiveEntryMode === 'STOPPED') return []
  if (Array.isArray(st.admittedBases) && st.admittedBases.length) return [...st.admittedBases]
  const b = MODE_BASIS[st.effectiveEntryMode]
  return b ? [b] : []
}

/** The selection a set of bases is, order-insensitive; null when it is none of the four. */
function selectionOfBases(bases) {
  const set = new Set(bases || [])
  if (set.size === 0) return 'stopped'
  if (set.size === 2 && set.has('bar') && set.has('tick')) return 'time+tick'
  if (set.size === 1 && set.has('bar')) return 'time'
  if (set.size === 1 && set.has('tick')) return 'tick'
  return null
}

/**
 * What the account was ASKED to admit, as one of the four selections — from
 * the requested mode plus the stored set (null / absent is the mode's own
 * basis). TIME_BASED+['tick'] reads as Tick, TICK_MOMENTUM+['bar','tick'] as
 * Time + tick: the set is the whole answer, exactly as the server's basesFor.
 */
export function requestedSelection(row) {
  if (!row) return null
  if (!(row.requestedEntryMode in MODE_BASIS)) return null
  return selectionOfBases(basesFor({ ...row, effectiveEntryMode: row.requestedEntryMode }))
}

/** 'bar + tick', 'bar', 'nothing' — the bases as a reader sees them. */
export function basesLabel(bases) {
  if (!Array.isArray(bases)) return 'unknown'
  return bases.length ? bases.join(' + ') : 'nothing'
}

/** The POST body for a selection. */
export function selectionBody(key, accountId, expectedRevision) {
  const sel = SELECTIONS[key]
  if (!sel) throw new Error(`unknown selection: ${key}`)
  return { accountId, mode: sel.mode, ...(sel.admittedBases ? { admittedBases: [...sel.admittedBases] } : {}), expectedRevision }
}

/**
 * Whether a bulk action skips this row as "already requested" (WP-A checker
 * nit 2): the requested SELECTION, read from the requested bases — never the
 * mode string. A Time + tick row is TIME_BASED too, so a skip keyed on the
 * mode would leave tick admitted under "Time-based all".
 */
export function bulkSkips(row, key) {
  return requestedSelection(row) === key
}

/**
 * The label of what is running now: from the effective bases the server
 * sent, else from the local basesFor mirror over the effective mode and the
 * stored set (checker nit 4: a payload with admittedBases but no `bases`
 * must not read "Time-based" while the buttons treat it as Time + tick),
 * else the effective mode.
 */
function effectiveLabel(row) {
  const k = selectionOfBases(Array.isArray(row.bases) ? row.bases : basesFor(row))
  if (k && k !== 'stopped') return SELECTION_LABEL[k]
  return MODE_LABEL[row.effectiveEntryMode] || row.effectiveEntryMode
}

/** The label of what was asked: the requested selection, else the requested mode. */
export function requestedLabel(row) {
  const k = requestedSelection(row)
  return k ? SELECTION_LABEL[k] : (MODE_LABEL[row.requestedEntryMode] || row.requestedEntryMode)
}

/** Actions require the exact identity supplied beside the engine revision. */
export function engineAccountId(row) {
  const id = row?.routingAccountId
  if (typeof id !== 'string' || !/^[1-9]\d*$/.test(id)) return null
  return row.accountId === id || row.accountId === `…${id.slice(-4)}` ? id : null
}

/** Refuse duplicate routing records, including a temporarily mixed read. */
export function engineAccountBindings(rows) {
  const ids = rows.map(engineAccountId)
  return ids.map(id => id && ids.filter(other => other === id).length === 1 ? id : null)
}

/**
 * GET /state/tick-readiness answers in TWO shapes from the same route
 * (agent/routes/state.js): the roster form `{ accounts: [...] }`, or — when a
 * caller narrows with `?account=` (agent-api.js's viewed-account wiring,
 * S3) — ONE record with no `accounts` field at all (tickReadinessFor, not
 * tickReadinessView). A reader that only ever looked for `.accounts` read
 * every row as having no readiness the moment the lens was on ANY other
 * account — not a missing record, a shape mismatch. A bare array is also
 * accepted, for a caller that already extracted the list.
 */
function readinessRows(readiness) {
  if (Array.isArray(readiness)) return readiness
  if (!readiness) return []
  if (Array.isArray(readiness.accounts)) return readiness.accounts
  return readiness.accountId != null ? [readiness] : []
}

/**
 * `readiness` is whatever GET /state/tick-readiness returned (either shape
 * above, or a plain array). Returns null — "no record" — when this account's
 * readiness was not part of what came back, which is honest: a `?account=`
 * narrowed read genuinely carries no data for any other account.
 */
export function engineReadinessFor(readiness, accountId) {
  if (!accountId) return null
  const matches = readinessRows(readiness).filter(row => engineAccountId(row) === accountId)
  return matches.length === 1 ? matches[0] : null
}

/**
 * S1b (checker BLOCKER 3, W1.4 fix round; OD-30 "fix the label now"): the
 * sidebar's readiness suffix, built from three real facts instead of the
 * stored SETTING alone — the owner flagged "· shadow" printing straight from
 * `tickObservation` regardless of whether anything was actually running.
 *
 *   - `row.stored === false` (agent/services/entry-mode.js's
 *     engineStatusFor): this account has never had an engine record
 *     written — "no record" is the whole answer, unprefixed, because there
 *     is no policy to attribute either (a default record's policy would be
 *     invented, not read).
 *   - `readiness.shadowReady` / `shadowBlockers` (agent/services/
 *     tick-readiness.js): whether the shadow strategy is OBSERVED running,
 *     never merely declared. Only consulted when `tickObservation` is
 *     'SHADOW' — "declared" is the word for exactly that stored setting.
 *   - `row.entryModePolicy` (manual/auto — src/lib/entry-mode-policy.js):
 *     prefixed on every answer that carries real data, so who may switch
 *     this account sits on the same line as what it is doing.
 *
 * `row.readiness` may be null — the S1a join found no matching record for
 * this account (a `?account=` narrowed read for a different account, or no
 * answer yet) — and reads as "no record" for the shadow/blocker half too,
 * the same honesty engineReadinessFor already applies.
 */
export function entryStatusNote(row) {
  if (!row || row.stored === false) return 'no record'
  const policy = row.entryModePolicy === 'auto' ? 'auto' : 'manual'
  const readiness = row.readiness
  if (row.tickObservation === 'SHADOW') {
    if (!readiness) return 'no record'
    if (readiness.shadowReady) return `${policy} · shadow running`
    const first = readiness.shadowBlockers?.[0]
    return `${policy} · shadow declared, not running${first ? `: ${first}` : ''}`
  }
  if (!readiness) return 'no record'
  const obs = row.tickObservation === 'RECORD' ? 'record · ' : ''
  if (readiness.ready) return `${policy} · ${obs}tick-ready`
  const n = readiness.blockedReasons?.length || 0
  return `${policy} · ${obs}${n} blocker${n === 1 ? '' : 's'}`
}

/** 'stopped' | 'active' | 'warming' | 'switching' | 'blocked' | 'unknown' */
export function engineState(row) {
  if (!row) return 'unknown'
  if (row.invalid) return 'blocked'
  const t = row.transitionState
  if (t === 'BLOCKED') return 'blocked'
  if (t === 'WARMING') return 'warming'
  if (t === 'QUIESCING' || t === 'RECONCILING') return 'switching'
  if (t && t !== 'STABLE') return 'switching'
  if (row.effectiveEntryMode === 'STOPPED') return 'stopped'
  if (row.requestedEntryMode !== row.effectiveEntryMode) return 'switching'
  return 'active'
}

export const STATE_TONE = Object.freeze({ active: 'on', stopped: 'off', warming: 'warning', switching: 'warning', blocked: 'down', unknown: 'neutral', stale: 'neutral' })

/** The one line every page shows: what was asked, what the gateway acknowledged, and the transition. */
export function engineReading(row, { now = Date.now(), at = null } = {}) {
  if (!row) return { state: 'unknown', label: 'engine status unknown', tone: 'neutral', detail: 'the agent has not answered /state/entry-engines yet' }
  const state = engineState(row)
  const eff = effectiveLabel(row)
  const req = requestedLabel(row)
  const stale = at != null && now - at > STALE_AFTER_MS
  let label, detail
  if (row.invalid) {
    label = 'record invalid'
    detail = `the stored engine record fails the contract: ${row.invalid.join('; ')}`
  } else if (state === 'active') {
    label = `${eff} entries`
    detail = `entries run ${eff.toLowerCase()}; acknowledged (revision ${row.configRevision}, epoch ${row.modeEpoch})`
  } else if (state === 'stopped' && row.requestedEntryMode === 'STOPPED') {
    label = 'Entries stopped'
    detail = `no automatic entries; manual orders still admitted (revision ${row.configRevision}, epoch ${row.modeEpoch})`
  } else if (state === 'warming') {
    label = `${req} · warming`
    detail = `requested ${req}; entries stay stopped until the executor echoes epoch ${row.modeEpoch}`
  } else if (state === 'blocked') {
    label = `${req} · blocked`
    detail = `requested ${req}; the executor did not acknowledge — entries stay stopped${row.blockedReason ? ` (${row.blockedReason})` : ''}`
  } else {
    label = `${req} · ${String(row.transitionState || 'switching').toLowerCase()}`
    detail = `requested ${req}, effective ${eff}; ${row.transitionState === 'QUIESCING' ? 'cancelling resting entry orders' : 'reconciling old entries'} (resting ${row.entryCounts?.resting ?? '?'}, unknown ${row.entryCounts?.unknown ?? '?'})`
  }
  if (stale) detail += ` — STALE: last answer ${Math.round((now - at) / 1000)} s ago`
  return { state, label, tone: stale ? 'neutral' : (STATE_TONE[state] || 'neutral'), detail, stale }
}

/** Mixed-account counts for the shared header (plan §13: "mixed-account counts"). */
export function mixedCounts(rows = []) {
  // `tick` (WP-A): ACTIVE accounts whose effective bases — the server's
  // `bases`, what the Node fence admits now — include tick, alone or as Time
  // + tick. A tick request still WARMING is not counted: it admits nothing.
  const c = { active: 0, stopped: 0, warming: 0, switching: 0, blocked: 0, unknown: 0, tick: 0, total: rows.length }
  for (const r of rows) {
    const state = engineState(r)
    c[state]++
    if (state === 'active' && Array.isArray(r.bases) && r.bases.includes('tick')) c.tick++
  }
  return c
}

export function mixedSummary(rows = []) {
  const c = mixedCounts(rows)
  const parts = []
  if (c.active) parts.push(`${c.active} active`)
  if (c.stopped) parts.push(`${c.stopped} stopped`)
  if (c.warming) parts.push(`${c.warming} warming`)
  if (c.switching) parts.push(`${c.switching} switching`)
  if (c.blocked) parts.push(`${c.blocked} blocked`)
  if (c.tick) parts.push(`${c.tick} admitting tick`)
  return parts.join(' · ') || (c.total ? `${c.total} unknown` : 'no accounts')
}

const CLASS_LABEL = Object.freeze({
  operator_policy: 'Operator policy', broker_constraint: 'Broker constraint', missing_evidence: 'Missing evidence', infrastructure: 'Infrastructure', integration_defect: 'Integration defect',
})

/** The readiness blockers grouped by class, each with its remedy — the exact list the server refuses on. */
export function blockerGroups(readiness) {
  if (!readiness?.readiness) return []
  const groups = new Map()
  for (const c of readiness.readiness) {
    if (c.ok) continue
    const k = c.blockClass || 'integration_defect'
    if (!groups.has(k)) groups.set(k, { key: k, label: CLASS_LABEL[k] || k, checks: [] })
    groups.get(k).checks.push({ check: c.check, observed: c.observed, source: c.source, remedy: c.remedy, at: c.at })
  }
  return [...groups.values()]
}

/**
 * The visible line beside the tick selections (WP-A, principle 6). `BLOCKED`
 * only on the server's own ready:false, with its failing checks; while the
 * readiness has not answered, no verdict is claimed. Null when ready.
 */
export function tickSelectionNote(readiness) {
  if (!readiness) return 'tick status unknown — readiness not answered'
  if (readiness.ready) return null
  return `tick BLOCKED — ${tickBlockedReason(readiness)}`
}

/** Why the Tick button is disabled, in one sentence — the server's own list, never a UI guess. */
export function tickBlockedReason(readiness) {
  if (!readiness) return 'readiness not answered yet'
  if (readiness.ready) return null
  const n = readiness.blockedReasons?.length || 0
  return `${n} blocker${n === 1 ? '' : 's'}: ${(readiness.blockedReasons || []).slice(0, 4).join(', ')}${n > 4 ? ', …' : ''}`
}

/** One line per account from a bulk switch, with what the gateway said (TM-33). */
export function ackLine(r) {
  if (!r) return '—'
  if (r.error) return `refused: ${r.error}`
  const g = r.gateway
  if (!g) return `${r.status?.transitionState || 'requested'} (no gateway answer)`
  if (g.error || !g.pushed) return `NOT acknowledged — ${g.error || 'push not made'} → ${r.status?.transitionState || 'BLOCKED'}`
  const acked = Array.isArray(g.acked) ? g.acked.length : 0
  const bases = Array.isArray(r.bases) ? r.bases : Array.isArray(r.status?.bases) ? r.status.bases : null
  return `${g.side || 'executor'} acknowledged ${acked} epoch${acked === 1 ? '' : 's'} → ${r.status?.transitionState || '?'} / effective ${MODE_LABEL[r.status?.effectiveEntryMode] || r.status?.effectiveEntryMode || '?'}${bases ? ` (admits ${basesLabel(bases)})` : ''}`
}
