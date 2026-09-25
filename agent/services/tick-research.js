// agent/services/tick-research.js — P4: the trial ledger (plan §6, §7).
// A trial is one replay run: strategy id + version + profile hash, the data
// manifest (which segments, how many events, decoder version), the cost
// and latency assumptions, and the results per chronological block. Every
// run is recorded, including failures — the ledger is what the evidence
// importer (P6) and the owner judge, and a run that was never written
// cannot be judged.
//
// PR-Q1 (V3 P6/P7, 25-09-2026) — replay honesty:
//   * every row says where it came from (`origin`): a keeper job or in-thread
//     run (verified: this keeper replayed the bytes its manifest names), or a
//     client import through POST /actions/tick-trials (UNVERIFIED — nothing
//     proves it was replayed over the segments it names);
//   * every opening of a TEST block is on `tick_test_openings`, through
//     whichever door it came, and a second opening of the same holdout is
//     refused;
//   * rows written before the leak fix (statisticsVersion not v2) printed a
//     summary over the test block while calling it withheld — they are
//     CONSULTED, and the view says so row by row and per profile.
import { createHash } from 'node:crypto'
import { STATISTICS_VERSION } from '../lib/tick-replay-sim.js'

/** PR-Q1: the holdout a test-block opening consumes until PR-Q2 declares a future-only window. */
export const HOLDOUT_UNDECLARED = 'undeclared'
/** Opening statuses that CONSUME a holdout (a replay whose result someone could see). */
const CONSUMING = ['opened']

export function trialIdFor(trial) {
  const canon = JSON.stringify({ p: trial.profileHash, m: trial.manifest, s: trial.sim })
  return createHash('sha256').update(canon).digest('hex').slice(0, 20)
}

const parseOr = (text, fallback = null) => { if (text == null) return fallback; try { return JSON.parse(text) } catch { return fallback } }
const profile16 = (h) => String(h || '').trim().toLowerCase().slice(0, 16)

/** Whether a stored trial's summary may cover its test block: written before v2, or run with includeTest. */
export function summaryScopeOf(sim) {
  const s = sim || {}
  if (s.includeTest === true) return 'all_blocks'
  if (s.statisticsVersion === STATISTICS_VERSION) return 'train_validation'
  return 'all_blocks_legacy_leak'
}

/**
 * Insert (or ignore, when the same trial exists) one trial from a replay
 * result. PR-Q1: `origin` and the trial's `parity` record are stored beside
 * it (neither is part of the content key); when the row already existed, the
 * reply names the origin it already carries, so a keeper replay whose content
 * matches an earlier client import is not reported as if it had verified it.
 */
export function importTickTrial(db, trial, { note = null, origin = null } = {}) {
  for (const k of ['strategyId', 'strategyVersion', 'profileHash', 'params', 'sim', 'manifest', 'summary', 'blocks']) {
    if (trial[k] == null) return { ok: false, reason: `missing ${k}` }
  }
  const trialId = trial.trialId || trialIdFor(trial)
  const r = db.prepare(`INSERT OR IGNORE INTO tick_trials (trial_id, strategy_id, version, profile_hash, params_json, sim_json, manifest_json, summary_json, blocks_json, note, origin_json, parity_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(trialId, String(trial.strategyId), String(trial.strategyVersion), String(trial.profileHash), JSON.stringify(trial.params), JSON.stringify(trial.sim), JSON.stringify(trial.manifest), JSON.stringify(trial.summary), JSON.stringify(trial.blocks), note,
      origin == null ? null : JSON.stringify(origin), trial.parity == null ? null : JSON.stringify(trial.parity))
  const out = { ok: true, trialId, inserted: r.changes === 1 }
  if (!out.inserted) {
    const existing = db.prepare('SELECT origin_json FROM tick_trials WHERE trial_id = ?').get(trialId)
    out.existingOrigin = parseOr(existing?.origin_json)?.kind ?? 'unrecorded'
  }
  return out
}

/** PR-Q1: write one test-block opening; returns { id }. */
export function recordTestOpening(db, { profileHash, holdoutKey = HOLDOUT_UNDECLARED, channel, jobId = null, actor = null, status = 'opened', trialIds = null, detail = null }) {
  const r = db.prepare(`INSERT INTO tick_test_openings (profile_hash, holdout_key, channel, job_id, actor, status, trial_ids, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(profile16(profileHash), String(holdoutKey), String(channel), jobId, actor, String(status), trialIds == null ? null : JSON.stringify(trialIds), detail == null ? null : JSON.stringify(detail))
  return { id: Number(r.lastInsertRowid) }
}

/** PR-Q1: settle an opening once its replay reported (or did not). */
export function settleTestOpening(db, id, { status, trialIds = undefined }) {
  if (trialIds === undefined) db.prepare('UPDATE tick_test_openings SET status = ? WHERE id = ?').run(String(status), id)
  else db.prepare('UPDATE tick_test_openings SET status = ?, trial_ids = ? WHERE id = ?').run(String(status), JSON.stringify(trialIds), id)
}

/**
 * PR-Q1: has this profile's holdout been consulted? The recorded openings
 * that consumed it, plus every pre-v2 trial of the profile — those printed
 * the leaking summary (the test block by subtraction), so their test period
 * has been read whatever `blocks` said. A second opening is refused on either.
 */
export function testOpeningsFor(db, profileHash, holdoutKey = HOLDOUT_UNDECLARED) {
  const p = profile16(profileHash)
  let openings = []
  try {
    openings = db.prepare(`SELECT id, at, channel, job_id AS jobId, actor, status FROM tick_test_openings WHERE profile_hash = ? AND holdout_key = ? AND status IN (${CONSUMING.map(() => '?').join(',')}) ORDER BY id`).all(p, String(holdoutKey), ...CONSUMING)
  } catch { openings = [] }
  let legacyConsultedTrials = 0
  // Legacy consultation is a property of the profile's OWN undeclared test
  // block; a declared future-only holdout (PR-Q2) was never in those rows.
  if (holdoutKey === HOLDOUT_UNDECLARED) {
    try {
      for (const r of db.prepare('SELECT sim_json FROM tick_trials WHERE profile_hash = ?').all(p)) {
        if (summaryScopeOf(parseOr(r.sim_json, {})) === 'all_blocks_legacy_leak') legacyConsultedTrials++
      }
    } catch { legacyConsultedTrials = 0 }
  }
  return { profileHash: p, holdout: String(holdoutKey), openings, legacyConsultedTrials, consulted: openings.length > 0 || legacyConsultedTrials > 0 }
}

/**
 * PR-Q1: POST /actions/tick-trials — trials produced OFF the keeper (the
 * script beside the spool). Each is stored as `client_import`, unverified,
 * with the caller. A trial replayed with includeTest has ALREADY opened its
 * test block off-box, so the opening is recorded whatever happens next; when
 * the profile's holdout was already consulted, the opening is recorded as
 * `refused_second_opening` and the trial is not stored.
 */
export function importClientTrials(db, list, { note = null, actor = null } = {}) {
  const origin = { kind: 'client_import', verified: false, actor, note: 'imported through POST /actions/tick-trials; nothing proves it was replayed over the segments its manifest names' }
  const openedNow = new Set()
  const refusedNow = new Map() // profile → the refusal, so one import of 53 symbols writes one refused row, not 53
  return list.map(t => {
    const itNote = note ?? t?.note ?? null
    if (t?.sim?.includeTest === true && t.profileHash) {
      const p = profile16(t.profileHash)
      if (refusedNow.has(p)) return refusedNow.get(p)
      if (!openedNow.has(p)) {
        const prior = testOpeningsFor(db, p)
        if (prior.consulted) {
          recordTestOpening(db, { profileHash: p, channel: 'client_import', actor, status: 'refused_second_opening', trialIds: [t.trialId || null] })
          const refused = { ok: false, reason: 'second_opening', profileHash: p, openings: prior.openings.length, legacyConsultedTrials: prior.legacyConsultedTrials }
          refusedNow.set(p, refused)
          return refused
        }
        const imported = importTickTrial(db, t, { note: itNote, origin })
        recordTestOpening(db, { profileHash: p, channel: 'client_import', actor, status: 'opened', trialIds: [imported.trialId ?? null] })
        openedNow.add(p)
        return { ...imported, origin: 'client_import', opening: 'recorded' }
      }
      // More trials of the same profile in the same import are the same opening (one per symbol).
      return { ...importTickTrial(db, t, { note: itNote, origin }), origin: 'client_import', opening: 'same_import' }
    }
    return { ...importTickTrial(db, t || {}, { note: itNote, origin }), origin: 'client_import' }
  })
}

const hex16 = (v) => { const s = profile16(v); return /^[0-9a-f]{16}$/.test(s) ? s : null }
// The view never loads the parity record (up to PARITY_RECORD_MAX signals and
// trades per row); GET /state/tick-replay-parity reads it.
const VIEW_COLUMNS = 'id, at, trial_id, strategy_id, version, profile_hash, params_json, sim_json, manifest_json, summary_json, blocks_json, note, origin_json, (parity_json IS NOT NULL) AS has_parity'

/**
 * The ledger for GET /state/tick-research: newest first, parsed.
 * PR-Q1: `?profile=` filters by the 16-hex profile hash; `limit` may be
 * 'all'. `ledger` is computed over EVERY row regardless of the page — the
 * per-profile trial count, the includeTest openings and the pre-v2 rows that
 * consulted the test block — because the multiple-testing record is the
 * whole ledger, not the 200 rows a page shows.
 */
export function tickTrialsView(db, { limit = 50, profile = null } = {}) {
  const p = profile == null || profile === '' ? null : hex16(profile)
  if (profile != null && profile !== '' && !p) return { at: new Date().toISOString(), error: 'bad_profile', profile: String(profile), note: 'profile is the 16-hex profile hash (or the 64-hex full hash) GET /state/tick-research prints' }
  const all = limit === 'all' || limit === Infinity
  const n = all ? -1 : Math.max(1, Math.floor(Number(limit) || 50))
  let rows = []
  try {
    rows = p
      ? db.prepare(`SELECT ${VIEW_COLUMNS} FROM tick_trials WHERE profile_hash = ? ORDER BY id DESC LIMIT ?`).all(p, n)
      : db.prepare(`SELECT ${VIEW_COLUMNS} FROM tick_trials ORDER BY id DESC LIMIT ?`).all(n)
  } catch { rows = [] }
  const trials = rows.map(r => {
    const sim = JSON.parse(r.sim_json)
    const origin = parseOr(r.origin_json)
    const scope = summaryScopeOf(sim)
    return {
      trialId: r.trial_id, at: r.at, strategyId: r.strategy_id, version: r.version, profileHash: r.profile_hash,
      params: JSON.parse(r.params_json), sim, manifest: JSON.parse(r.manifest_json),
      summary: JSON.parse(r.summary_json), blocks: JSON.parse(r.blocks_json), note: r.note,
      origin: origin || { kind: 'unrecorded', verified: false, note: 'written before PR-Q1; nobody recorded where it came from' },
      summaryScope: scope,
      testConsulted: scope !== 'train_validation',
      parityRecorded: r.has_parity === 1,
    }
  })
  const byProfile = {}
  let shadowProfiles = []
  try { shadowProfiles = db.prepare("SELECT side, profile_hash AS profileHash, COUNT(*) AS trades FROM tick_shadow_trades WHERE reason <> 'lost_restart' GROUP BY side, profile_hash").all() } catch { /* no shadow evidence */ }
  for (const t of trials) {
    t.evidenceState = t.summary.trades === 0 ? 'EMPTY' : 'OBSERVED'
    t.matchingShadow = shadowProfiles.filter(s => s.profileHash === t.profileHash)
    t.shadowAttribution = t.matchingShadow.length ? 'same_profile_only; data windows and costs still require validation — whether the replay reproduces the shadow is NOT YET COMPARED until GET /state/tick-replay-parity reads ok or mismatch on a comparable window' : 'no_matching_profile; other shadow runs cannot corroborate this trial'
    const validation = t.blocks.find(b => b.name === 'validation') || null
    const test = t.blocks.find(b => b.name === 'test') || null
    // AUDIT 11-09-2026 (plan §7): the test block is WITHHELD on a research
    // trial (blocks[test].withheld); only a trial run with includeTest —
    // the owner's confirmation run — carries test figures, and the profile
    // row says how many of its trials were of which kind.
    byProfile[t.profileHash] ??= { profileHash: t.profileHash, trials: 0, params: t.params, validationTrades: 0, validationNetR: 0, testTrials: 0, testWithheld: 0, testTrades: 0, testNetR: 0 }
    const row = byProfile[t.profileHash]
    row.trials++
    if (validation && validation.trades != null) { row.validationTrades += validation.trades; row.validationNetR = +(row.validationNetR + (validation.netR || 0)).toFixed(4) }
    if (test && test.withheld) row.testWithheld++
    else if (test && test.trades != null) { row.testTrials++; row.testTrades += test.trades; row.testNetR = +(row.testNetR + (test.netR || 0)).toFixed(4) }
  }
  return {
    at: new Date().toISOString(), profile: p, limit: all ? 'all' : n, trials, profiles: Object.values(byProfile),
    emptyTrials: trials.filter(t => t.evidenceState === 'EMPTY').length,
    ledger: ledgerByProfile(db, p),
    note: 'P4: research trials only — no profile here is approved for trading; acceptance (plan §7) needs out-of-sample expectancy with an interval on independent blocks, cost and parameter-neighbourhood robustness, and the multiple-testing adjustment, judged by the owner before P6 imports evidence. PR-Q1: a trial whose summaryScope is all_blocks_legacy_leak was written before the leak fix and printed a summary over its withheld test block — its test period is CONSULTED.',
  }
}

/** PR-Q1: the whole ledger per profile — every row, not the page. */
export function ledgerByProfile(db, profile = null) {
  const out = {}
  let rows = []
  try {
    rows = profile
      ? db.prepare('SELECT profile_hash, sim_json, origin_json FROM tick_trials WHERE profile_hash = ?').all(profile)
      : db.prepare('SELECT profile_hash, sim_json, origin_json FROM tick_trials').all()
  } catch { rows = [] }
  for (const r of rows) {
    const sim = parseOr(r.sim_json, {})
    const kind = parseOr(r.origin_json)?.kind ?? 'unrecorded'
    const o = out[r.profile_hash] ??= { profileHash: r.profile_hash, trials: 0, includeTestTrials: 0, legacyConsultedTrials: 0, byOrigin: {}, openings: 0, refusedOpenings: 0, consulted: false }
    o.trials++
    o.byOrigin[kind] = (o.byOrigin[kind] || 0) + 1
    const scope = summaryScopeOf(sim)
    if (sim.includeTest === true) o.includeTestTrials++
    if (scope === 'all_blocks_legacy_leak') o.legacyConsultedTrials++
  }
  let openings = []
  try {
    openings = profile
      ? db.prepare('SELECT profile_hash, status, COUNT(*) AS n FROM tick_test_openings WHERE profile_hash = ? GROUP BY profile_hash, status').all(profile)
      : db.prepare('SELECT profile_hash, status, COUNT(*) AS n FROM tick_test_openings GROUP BY profile_hash, status').all()
  } catch { openings = [] }
  for (const r of openings) {
    const o = out[r.profile_hash] ??= { profileHash: r.profile_hash, trials: 0, includeTestTrials: 0, legacyConsultedTrials: 0, byOrigin: {}, openings: 0, refusedOpenings: 0, consulted: false }
    if (CONSUMING.includes(r.status)) o.openings += r.n
    else if (r.status === 'refused_second_opening') o.refusedOpenings += r.n
  }
  for (const o of Object.values(out)) o.consulted = o.openings > 0 || o.legacyConsultedTrials > 0
  const profiles = Object.values(out).sort((a, b) => b.trials - a.trials)
  return { totalTrials: rows.length, profiles, holdout: HOLDOUT_UNDECLARED }
}
