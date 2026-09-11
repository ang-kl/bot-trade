// Pure readings for the engine status surfaces (tested directly; the
// components render them). One vocabulary for every page, straight from the
// server's record: requested vs effective mode, the transition state, how
// old the answer is, and the readiness blockers grouped by the plan's five
// classes. Nothing here guesses a mode from a flag.

export const MODE_LABEL = Object.freeze({ TIME_BASED: 'Time-based', TICK_MOMENTUM: 'Tick momentum', STOPPED: 'Stopped' })
export const STALE_AFTER_MS = 60_000

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
  const eff = MODE_LABEL[row.effectiveEntryMode] || row.effectiveEntryMode
  const req = MODE_LABEL[row.requestedEntryMode] || row.requestedEntryMode
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
  const c = { active: 0, stopped: 0, warming: 0, switching: 0, blocked: 0, unknown: 0, total: rows.length }
  for (const r of rows) c[engineState(r)]++
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
  return `${g.side || 'executor'} acknowledged ${acked} epoch${acked === 1 ? '' : 's'} → ${r.status?.transitionState || '?'} / effective ${MODE_LABEL[r.status?.effectiveEntryMode] || r.status?.effectiveEntryMode || '?'}`
}
