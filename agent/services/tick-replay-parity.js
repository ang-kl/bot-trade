// ---------------------------------------------------------------------------
// agent/services/tick-replay-parity.js — PR-Q1 (V3 P6/P7, 25-09-2026). Does
// the replay reproduce the shadow? Until this report reads `ok` or `mismatch`
// on a comparable window, the answer is NOT YET COMPARED. The review of the
// 20-09 run said "1 trade in 200 visible trials against ~180 shadow trades a
// day": the 200 trials were other grid points, not v1, and they predate the
// current replayer, so that sentence compared different profiles. This is
// the comparison it needed, report only — it gates nothing (making it a
// blocking replay check is the owner's D8, not this PR).
//
// What is compared, for ONE side, ONE profile, ONE symbol and ONE window:
//   * signals — the replay's scoped signal list (stored on the trial) against
//     the sidecar's own `cpp_decisions` tick/signal rows, matched on the quote
//     seq and direction the signal was made at (both engines read the same
//     recorder record: tick_tap.cpp hands the worker the recorded seq and
//     recvMs);
//   * trades — the replay's scoped trades against `tick_shadow_trades`,
//     matched on side and entry time within the sim's latency.
//
// What makes a window NOT COMPARABLE (named, never scored as a mismatch):
//   * the sidecar's lossy sources — the decision ring holds 4,096 slots, is
//     pulled about every 2 minutes and dies with the process (decision_ring;
//     main.cpp:178), and ShadowLedger(4096) loses closed-but-unpulled trades
//     at a restart (main.cpp:247). So a window with a boot change, a
//     cpp_decisions seq gap inside a boot, or a `lost_restart` row is excluded;
//   * no sidecar record at all in the window (nothing pulled, or pruned);
//   * a replay that never settled inside its scope (a replay that starts
//     mid-stream is cold while the live strategy is warm; comparison starts
//     only after `expiryEvents + rearmCooldownEvents` warmed evaluations), or
//     whose stored lists were truncated;
//   * for trades only: a sim that is not the shadow's (targetR, latency,
//     minTargetToCost, the hold caps with 0 normalised to 4N, and the cost
//     terms the shadow rows record) — different fill rules are a different
//     population, not a replayer defect.
// A mismatch inside a window where the RECORDER dropped quotes
// (queue_overflow / reserve_pause: the live strategy saw quotes the segment
// does not hold) is reported as not_comparable with the mismatch attached —
// it cannot be told apart from the drop. Results carry the window's gaps split
// by reason either way.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs'
import { TICK_SHADOW_SIM_FILE, rowCostModel, loadRepoSchedule } from '../lib/tick-cost-schedule.js'
import { normalizeMaxHoldEvents, liveFiltersKey } from '../lib/tick-replay-sim.js'
import { normalizeParams } from '../lib/tick-strategy.js'
import { RECORDER_ONLY_GAPS } from './tick-research-run.js'

export const SIDE_BY_ENVIRONMENT = Object.freeze({ demo: 'cpp_exec_demo', live: 'cpp_exec' })
/** Slack around a window when reading the ring by its own log clock (ts_ms is taken after the quote). */
export const RING_SLACK_MS = 60_000
/** Each unmatched list in a report is capped here; the counts are never capped. */
export const UNMATCHED_LIST_MAX = 20
/**
 * Q1 follow-up (checker B1): the profile form compares at most this many
 * trials per request (newest first) — it runs on the event loop, three indexed
 * reads per trial. It was 60 by default and 200 at most: the checker measured
 * 39.5 s at 2M ring rows before the indexes and 1.5 s for 60 after them
 * (agent/db.js idx_cpp_decisions_side_ts). The reply says how many trials
 * with a record were NOT compared, and `?trialId=` reaches any one of them.
 */
export const PROFILE_TRIALS_MAX = 20
/**
 * The ring reads, exported so a test can ask SQLite for their plan against the
 * real schema (idx_cpp_decisions_tick_signal / idx_cpp_decisions_side_ts).
 */
export const SIGNALS_SQL = `SELECT boot_id, ts_ms, code, detail FROM cpp_decisions WHERE side = ? AND component = 'tick' AND kind = 'signal' AND symbol_id = ? AND ts_ms BETWEEN ? AND ?`
export const BOOTS_SQL = `SELECT boot_id AS bootId, MIN(seq) AS lo, MAX(seq) AS hi, COUNT(*) AS n FROM cpp_decisions WHERE side = ? AND ts_ms BETWEEN ? AND ? GROUP BY boot_id`
/**
 * Q1 follow-up (checker N7): every shadow trade whose holding interval
 * OVERLAPS the read window — entered by its end and exited after its start. It
 * read trades that entered or exited inside the window, so a trade open across
 * the whole window was missed, the busy check could not push the window past
 * it, and the replay's signals there scored a false mismatch. A row with no
 * exit time (a malformed pull) is read as before: only when it entered inside
 * the window.
 */
export const SHADOW_TRADES_SQL = `SELECT * FROM tick_shadow_trades WHERE side = ? AND symbol_id = ? AND profile_hash = ? AND reason <> 'lost_restart' AND entry_ms <= ? AND (exit_ms >= ? OR (exit_ms IS NULL AND entry_ms >= ?))`
/**
 * Q1 follow-up (checker N6, NOT closed here): the sidecar's per-symbol worker
 * queue (cpp-exec tick_workers.cpp) drops events when it is full and marks the
 * next one gapBefore — the LIVE strategy re-warms there while the segment still
 * holds every quote. Those drops are counted only as process-lifetime totals on
 * the sidecar's /tick-status (workers.dropped / gapsMarked); nothing records
 * them per window, so this report cannot see one. Named on every report.
 */
const UNOBSERVED = 'sidecar worker-queue drops (tick_workers.cpp gapBefore: the live strategy re-warms, the segment keeps every quote) are not recorded per window, so a mismatch here cannot rule one out'
const COST_TERMS = ['commissionWirePerSide', 'commissionBpsPerSide', 'slippageWirePerSide', 'slippageBpsPerSide']
const NOT_YET = 'Whether the replay reproduces the shadow is NOT YET COMPARED until this report reads ok or mismatch on a comparable window.'

const parseDetail = (d) => Object.fromEntries([...String(d || '').matchAll(/(\w+)=([^\s]+)/g)].map(m => [m[1], m[2]]))

/**
 * The window a replay and the sidecar can be compared over, before the
 * sidecar's health is read. Starts where the replay has SETTLED (and no book
 * on either side still holds a trade entered before that), ends where the
 * replay's scope ends; intersected with an asked window. Pure.
 */
export function parityWindow(replay, sidecarTrades = [], { fromMs = null, toMs = null } = {}) {
  if (replay?.settledFromMs == null) return { ok: false, reason: 'replay_never_settled' }
  let from = Math.max(replay.fromMs ?? -Infinity, replay.settledFromMs, fromMs ?? -Infinity)
  const to = Math.min(replay.toMs ?? Infinity, toMs ?? Infinity)
  // A trade open at the start on EITHER book makes the next signal "busy"
  // there and free on the other; start once both books are flat.
  const open = [...(replay.trades || []).map(t => ({ entryMs: t.entryMs, exitMs: t.exitMs })), ...sidecarTrades.map(t => ({ entryMs: t.entryMs, exitMs: t.exitMs }))]
  for (;;) {
    const busy = open.filter(t => t.entryMs != null && t.entryMs < from && t.exitMs != null && t.exitMs >= from)
    if (!busy.length) break
    from = Math.max(...busy.map(t => t.exitMs)) + 1
  }
  if (!(Number.isFinite(from) && Number.isFinite(to)) || from > to) return { ok: false, reason: 'no_overlap', fromMs: Number.isFinite(from) ? from : null, toMs: Number.isFinite(to) ? to : null }
  return { ok: true, fromMs: from, toMs: to }
}

/**
 * The sidecar's own record is complete over a window only when it is ONE
 * boot, the ring's seq is contiguous inside it, and no open shadow trade was
 * lost to a restart. `health` is { boots: [{ bootId, lo, hi, n }], lostRestart }.
 */
export function sidecarLossy(health) {
  const reasons = []
  const boots = health?.boots || []
  if (!boots.length || boots.every(b => !b.n)) reasons.push('no_sidecar_record')
  if (boots.length > 1) reasons.push('boot_change')
  const gaps = boots.filter(b => b.n > 0 && (b.hi - b.lo + 1) > b.n).map(b => ({ bootId: b.bootId, missing: (b.hi - b.lo + 1) - b.n }))
  if (gaps.length) reasons.push('decision_seq_gap')
  if ((health?.lostRestart || 0) > 0) reasons.push('shadow_lost_restart')
  return { reasons, seqGaps: gaps, boots: boots.map(b => b.bootId) }
}

/**
 * The replay's fill rules against the shadow's: the non-cost fields against
 * agent/config/tick-shadow-sim.json (the file the keeper pushes), the cost
 * terms against what the shadow rows RECORD they were charged (or, with no
 * row in the window, against the repo schedule's row for the trial's class).
 * The sidecar reports no per-row sim, so a mid-window push of the non-cost
 * fields is not visible here — stated on every report.
 */
export function simComparison(trialSim, params, shadowSim, sidecarTrades = [], schedule = null) {
  const s = trialSim || {}, sh = shadowSim || {}
  const N = normalizeParams(params || {}).rangeEvents
  const diffs = []
  const cmp = (field, replay, shadow) => { if (Number(replay) !== Number(shadow)) diffs.push({ field, replay, shadow }) }
  cmp('targetR', s.targetR, sh.targetR)
  cmp('latencyMs', s.latencyMs, sh.latencyMs)
  cmp('minTargetToCost', s.minTargetToCost, sh.minTargetToCost)
  cmp('maxHoldMs', s.maxHoldMs, sh.maxHoldMs)
  cmp('maxHoldEvents', normalizeMaxHoldEvents(s.maxHoldEventsResolved ?? s.maxHoldEvents, N), normalizeMaxHoldEvents(sh.maxHoldEvents, N))
  // PR-Q3: a trial replayed with the live filters under the 'book' model
  // (sim.liveFilters.model) takes different trades — a refused signal frees
  // the book for the next one — so against a shadow that runs no such block
  // it is a different population, not a replayer defect: named here so the
  // trades read not_comparable rather than a mismatch. Under the 'firer'
  // model the BOOK is the unfiltered one (the parity record carries the
  // refused trades it held, flagged vetoedBy), so it compares as before.
  if (liveFiltersKey(s.liveFilters, { book: true }) !== liveFiltersKey(sh.liveFilters, { book: true })) diffs.push({ field: 'liveFilters', replay: s.liveFilters ?? null, shadow: sh.liveFilters ?? null })
  const replayTerms = Object.fromEntries(COST_TERMS.map(k => [k, Number(s[k]) || 0]))
  if (sidecarTrades.length) {
    for (const t of sidecarTrades) {
      const row = rowCostModel(t.row || t)
      const differs = COST_TERMS.filter(k => Number(row[k]) !== replayTerms[k])
      if (differs.length) { diffs.push({ field: 'costTerms', replay: { class: s.costClass ?? null, ...replayTerms }, shadow: { class: row.class, ...Object.fromEntries(COST_TERMS.map(k => [k, row[k]])) }, basis: 'the shadow row\'s own recorded terms' }); break }
    }
  } else {
    const repo = schedule || loadRepoSchedule()
    const want = s.costSource === 'class' && s.costClass ? repo.classes?.[s.costClass] : null
    if (!want || COST_TERMS.some(k => Number(want[k]) !== replayTerms[k])) diffs.push({ field: 'costTerms', replay: { class: s.costClass ?? null, source: s.costSource ?? null, ...replayTerms }, shadow: want ? { class: s.costClass, ...Object.fromEntries(COST_TERMS.map(k => [k, want[k]])) } : null, basis: 'no shadow row in the window; the repo schedule\'s row for the trial\'s class' })
  }
  return { ok: diffs.length === 0, diffs, basis: 'non-cost fields against agent/config/tick-shadow-sim.json (the sidecar reports no per-row sim, so a mid-window push of these fields is not visible here); cost terms against the shadow rows\' recorded terms' }
}

/**
 * THE COMPARATOR, pure. One symbol. `replay` is a trial's parity record
 * (signals, trades, window, settledFromMs, latencyMs, truncated) plus the
 * manifest's `gaps`; `sidecar` is { signals: [{ seq, recvMs, side }],
 * trades: [{ side, entryMs, exitMs, reason }], health }. Returns
 * { parity: ok | mismatch | not_comparable, reasons, signals, trades, gapsByReason }.
 */
export function compareParity(replay, sidecar, { window = null, sim = { ok: true, diffs: [] } } = {}) {
  const reasons = []
  const w = window || parityWindow(replay, sidecar?.trades || [])
  if (!w.ok) return { parity: 'not_comparable', reasons: [w.reason], window: w, note: NOT_YET }
  if (replay.truncated) reasons.push('replay_record_truncated')
  const lossy = sidecarLossy(sidecar?.health)
  reasons.push(...lossy.reasons)
  const inW = (ms) => ms != null && ms >= w.fromMs && ms <= w.toMs
  const gapsInWindow = (replay.gaps || []).filter(g => inW(g.recvMs))
  const gapsByReason = {}
  for (const g of gapsInWindow) gapsByReason[g.reason] = (gapsByReason[g.reason] || 0) + 1
  const dropped = gapsInWindow.some(g => RECORDER_ONLY_GAPS.has(g.reason))

  // Signals: the same quote (seq) and the same direction on both engines.
  const key = (x) => `${x.seq}|${x.side}`
  const rSig = (replay.signals || []).filter(x => inW(x.recvMs))
  const sSig = (sidecar?.signals || []).filter(x => inW(x.recvMs))
  const sKeys = new Set(sSig.map(key)), rKeys = new Set(rSig.map(key))
  const sigMissingInShadow = rSig.filter(x => !sKeys.has(key(x)))
  const sigMissingInReplay = sSig.filter(x => !rKeys.has(key(x)))
  const signals = {
    replay: rSig.length, shadow: sSig.length, matched: rSig.length - sigMissingInShadow.length,
    missingInShadow: sigMissingInShadow.length, missingInReplay: sigMissingInReplay.length,
    unmatched: { missingInShadow: sigMissingInShadow.slice(0, UNMATCHED_LIST_MAX), missingInReplay: sigMissingInReplay.slice(0, UNMATCHED_LIST_MAX) },
  }
  signals.verdict = signals.missingInShadow || signals.missingInReplay ? 'mismatch' : 'ok'

  // Trades: same side, entry within the latency; greedy in time order.
  const lat = Math.max(0, Number(replay.latencyMs) || 0)
  const rTr = (replay.trades || []).filter(t => inW(t.entryMs)).sort((a, b) => a.entryMs - b.entryMs)
  const sTr = (sidecar?.trades || []).filter(t => inW(t.entryMs)).sort((a, b) => a.entryMs - b.entryMs)
  const used = new Set()
  const trMissingInShadow = [], openAtReplayEnd = []
  for (const t of rTr) {
    const j = sTr.findIndex((u, i) => !used.has(i) && u.side === t.side && Math.abs(u.entryMs - t.entryMs) <= lat)
    if (j >= 0) { used.add(j); continue }
    // A replay trade still open when the replay's data ended may simply not
    // have closed (and so not been pulled) on the sidecar yet; a withheld
    // record's trade open at the test block carries its entry only.
    if (t.reason === 'data_end' || t.reason === 'open_at_scope_end') openAtReplayEnd.push(t)
    else trMissingInShadow.push(t)
  }
  const trMissingInReplay = sTr.filter((_, i) => !used.has(i))
  const trades = {
    replay: rTr.length, shadow: sTr.length, matched: used.size,
    missingInShadow: trMissingInShadow.length, missingInReplay: trMissingInReplay.length, openAtReplayEnd: openAtReplayEnd.length,
    toleranceMs: lat,
    unmatched: { missingInShadow: trMissingInShadow.slice(0, UNMATCHED_LIST_MAX), missingInReplay: trMissingInReplay.slice(0, UNMATCHED_LIST_MAX) },
    sim,
  }
  trades.verdict = !sim.ok ? 'not_comparable' : (trades.missingInShadow || trades.missingInReplay ? 'mismatch' : 'ok')
  if (!sim.ok) trades.reason = 'sim_differs'

  let parity
  if (reasons.length) parity = 'not_comparable'
  else if (signals.verdict === 'mismatch' || trades.verdict === 'mismatch') {
    if (dropped) { parity = 'not_comparable'; reasons.push('recorder_dropped_quotes') } else parity = 'mismatch'
  } else if (trades.verdict === 'not_comparable') { parity = 'not_comparable'; reasons.push('sim_differs') }
  else parity = 'ok'
  return { parity, reasons, window: w, signals, trades, gapsByReason, seqGaps: lossy.seqGaps, boots: lossy.boots, note: parity === 'ok' || parity === 'mismatch' ? null : NOT_YET }
}

// ---- the database reads ------------------------------------------------------

function loadShadowSim(file = TICK_SHADOW_SIM_FILE) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** The sidecar's own record for one side / profile / symbol over [fromMs, toMs]. */
export function sidecarRecord(db, { side, profile, symbolId, fromMs, toMs }) {
  const lo = fromMs - RING_SLACK_MS, hi = toMs + RING_SLACK_MS
  let sigRows = []
  try {
    sigRows = db.prepare(SIGNALS_SQL).all(side, symbolId, lo, hi)
  } catch { sigRows = [] }
  const signals = []
  for (const r of sigRows) {
    const d = parseDetail(r.detail)
    if (!String(d.profile || '').startsWith(profile)) continue
    signals.push({ seq: Number(d.seq), recvMs: Number(d.recvMs), side: r.code, bootId: r.boot_id })
  }
  let tradeRows = []
  try {
    tradeRows = db.prepare(SHADOW_TRADES_SQL).all(side, symbolId, profile, hi, lo, lo)
  } catch { tradeRows = [] }
  const trades = tradeRows.map(r => ({ side: r.trade_side, entryMs: r.entry_ms, exitMs: r.exit_ms, reason: r.reason, bootId: r.boot_id, row: r }))
  return { signals, trades }
}

/** The ring's health over a window: per boot, the seq span and the count; and lost shadow trades. */
export function sidecarHealth(db, { side, fromMs, toMs }) {
  let boots = []
  try {
    boots = db.prepare(BOOTS_SQL).all(side, fromMs, toMs)
  } catch { boots = [] }
  let lostRestart = 0
  try { lostRestart = db.prepare(`SELECT COUNT(*) AS n FROM tick_shadow_trades WHERE side = ? AND reason = 'lost_restart' AND exit_ms BETWEEN ? AND ?`).get(side, fromMs, toMs).n } catch { lostRestart = 0 }
  return { boots, lostRestart }
}

function trialRow(db, trialId) {
  try { return db.prepare('SELECT * FROM tick_trials WHERE trial_id = ?').get(String(trialId)) || null } catch { return null }
}
const parse = (t, f = null) => { if (t == null) return f; try { return JSON.parse(t) } catch { return f } }

/** One stored trial against the sidecar, optionally inside an asked window and on an asked side. */
export function trialParity(db, row, { side = null, fromMs = null, toMs = null, shadowSim = undefined, schedule = null } = {}) {
  const manifest = parse(row.manifest_json, {})
  const sim = parse(row.sim_json, {})
  const params = parse(row.params_json, {})
  const rec = parse(row.parity_json)
  const base = { trialId: row.trial_id, profileHash: row.profile_hash, symbolId: manifest.symbolId ?? null }
  if (!rec) return { ...base, parity: 'not_comparable', reasons: ['no_replay_record'], note: 'this trial was written before PR-Q1 and stores no signal or trade list to compare. ' + NOT_YET }
  const envs = Array.isArray(manifest.environments) ? manifest.environments : []
  const sideFromData = envs.length === 1 ? SIDE_BY_ENVIRONMENT[envs[0]] || null : null
  const useSide = side || sideFromData
  if (!useSide) return { ...base, parity: 'not_comparable', reasons: [envs.length > 1 ? 'mixed_environments' : 'side_unknown'], note: 'name the side (?side=cpp_exec_demo|cpp_exec): the manifest does not say which sidecar recorded it. ' + NOT_YET }
  if (side && sideFromData && side !== sideFromData) return { ...base, side: useSide, parity: 'not_comparable', reasons: ['side_differs_from_data'], dataSide: sideFromData, note: NOT_YET }
  const replay = { ...rec, gaps: manifest.gaps || [] }
  const record = sidecarRecord(db, { side: useSide, profile: row.profile_hash, symbolId: base.symbolId, fromMs: rec.fromMs ?? 0, toMs: rec.toMs ?? 0 })
  const w = parityWindow(replay, record.trades, { fromMs, toMs })
  if (!w.ok) return { ...base, side: useSide, parity: 'not_comparable', reasons: [w.reason], window: w, note: NOT_YET }
  const health = sidecarHealth(db, { side: useSide, fromMs: w.fromMs, toMs: w.toMs })
  const inW = record.trades.filter(t => t.entryMs >= w.fromMs && t.entryMs <= w.toMs)
  const simCmp = simComparison(sim, params, shadowSim === undefined ? loadShadowSim() : shadowSim, inW, schedule)
  return { ...base, side: useSide, summaryScope: rec.scope, ...compareParity(replay, { ...record, health }, { window: w, sim: simCmp }) }
}

const verdictOf = (items) => {
  const comparable = items.filter(i => i.parity !== 'not_comparable')
  if (!comparable.length) return 'not_comparable'
  return comparable.some(i => i.parity === 'mismatch') ? 'mismatch' : 'ok'
}

/**
 * GET /state/tick-replay-parity. `?trialId=` compares that trial; or
 * `?profile=&side=&from=&to=` compares every stored trial of that profile
 * (newest first, at most `limit`) that carries a parity record, inside the
 * asked window. from/to are epoch ms or ISO times.
 */
export function replayParityView(db, q = {}) {
  const at = new Date().toISOString()
  const toMs = (v) => { if (v == null || v === '') return null; const n = Number(v); if (Number.isFinite(n)) return n; const t = Date.parse(String(v)); return Number.isFinite(t) ? t : NaN }
  const from = toMs(q.from), to = toMs(q.to)
  if (Number.isNaN(from) || Number.isNaN(to)) return { status: 400, body: { at, error: 'bad_window', from: q.from ?? null, to: q.to ?? null, where: 'from and to are epoch milliseconds or ISO times' } }
  const side = q.side == null || q.side === '' ? null : String(q.side)
  if (side && !Object.values(SIDE_BY_ENVIRONMENT).includes(side)) return { status: 400, body: { at, error: 'bad_side', side, where: `side is one of ${Object.values(SIDE_BY_ENVIRONMENT).join(', ')}` } }
  const common = { gates: 'nothing — report only; a blocking parity check is the owner\'s D8', lossySources: 'decision ring 4,096 slots pulled ~2 min, lost at restart; ShadowLedger(4096) loses closed-but-unpulled trades at restart — windows with a boot change, a ring seq gap or a lost_restart row are not_comparable', unobservedLosses: UNOBSERVED }
  if (q.trialId) {
    const row = trialRow(db, q.trialId)
    if (!row) return { status: 404, body: { at, error: 'unknown_trial', trialId: String(q.trialId) } }
    const r = trialParity(db, row, { side, fromMs: from, toMs: to })
    return { status: 200, body: { at, ...common, parity: r.parity, results: [r], note: r.parity === 'ok' || r.parity === 'mismatch' ? null : NOT_YET } }
  }
  const profile = String(q.profile || '').trim().toLowerCase().slice(0, 16)
  if (!/^[0-9a-f]{16}$/.test(profile)) return { status: 400, body: { at, error: 'bad_query', where: 'ask with ?trialId=<id>, or ?profile=<16-hex>&side=&from=&to=' } }
  const limit = Math.min(PROFILE_TRIALS_MAX, Math.max(1, Math.floor(Number(q.limit) || PROFILE_TRIALS_MAX)))
  let rows = []
  try { rows = db.prepare('SELECT * FROM tick_trials WHERE profile_hash = ? AND parity_json IS NOT NULL ORDER BY id DESC LIMIT ?').all(profile, limit) } catch { rows = [] }
  let legacy = 0, withRecord = rows.length
  try { legacy = db.prepare('SELECT COUNT(*) AS n FROM tick_trials WHERE profile_hash = ? AND parity_json IS NULL').get(profile).n } catch { legacy = 0 }
  try { withRecord = db.prepare('SELECT COUNT(*) AS n FROM tick_trials WHERE profile_hash = ? AND parity_json IS NOT NULL').get(profile).n } catch { withRecord = rows.length }
  const shadowSim = loadShadowSim()
  const results = rows.map(r => trialParity(db, r, { side, fromMs: from, toMs: to, shadowSim }))
  const parity = verdictOf(results)
  const notCompared = Math.max(0, withRecord - results.length)
  return { status: 200, body: { at, ...common, profile, side, from, to, parity, limit, trialsCompared: results.length, trialsNotCompared: notCompared, trialsWithoutRecord: legacy, results, ...(notCompared ? { notComparedNote: `${notCompared} older trial(s) of this profile carry a record and were not compared: the profile form compares the newest ${limit} (at most ${PROFILE_TRIALS_MAX}) per request, on the event loop; ask for one with ?trialId=` } : {}), note: parity === 'not_comparable' ? NOT_YET : null } }
}
