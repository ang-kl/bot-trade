// ---------------------------------------------------------------------------
// agent/services/goal-table.js — the goal table (§7,437·B·1, owner 08-09-2026).
//
// Owner: "What must you recode to be efficacy-centric and goal-oriented,
// achievable earlier than waiting to be edge." This is the first half of the
// answer: every subsystem that can be judged is judged here, by ONE metric it
// can move, against a target, on the horizon it works at, with one of three
// verdicts — on_track, off_track, not_measurable. The third is a first-class
// result, not a gap: a subsystem with fewer closes than its floor reports
// "not measurable" with the shortfall named, exactly as exit-counterfactual
// and earned-floor already do, rather than a number that would read as
// authoritative as one that had earned it. V3 M3 adds a fourth, `proposed`,
// for rows judged against limits the owner has not confirmed (the P1/P4
// rows): the reading is shown, not counted on or off track.
//
// Nothing here computes a new metric. Each goal reads an existing one
// (heartbeatView, decision_audit_last_json, exitCounterfactual,
// earnedFloorReport, findIncompleteCloses, inspectorView,
// momentumAccountReport) and applies a target. The targets are data:
// `goal_table_json.targets` in agent_state, defaults below, patched through
// POST /actions/goal-table with the start-from-stored merge rule (CLAUDE.md
// failure mode #5).
//
// Why this and not the edge: the edge answer arrives in months and most of
// the machine cannot influence it. Whether the controllers' records are
// fresh, whether approvals become fills, whether closes are recorded
// complete — those are properties of the code, measurable today, and each
// one confounds the edge answer if it is wrong.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { getState, setState } from '../db.js'
import { p1p4TargetDefaults, p1p4LimitsFromTargets, routeClass, p99Below, p99Unknown } from './p1p4-grade.js'
import { GOAL_SEMANTICS, RECORD_CONTRACTS } from '../lib/record-contracts.js'

export const GOAL_TABLE_KEY = 'goal_table_json'
/** The momentum checkpoint's frozen verdict (Wave 3): written once on the date. */
export const MOMENTUM_CHECKPOINT_KEY = 'momentum_checkpoint_verdict_json'

export const DEFAULT_GOAL_TARGETS = Object.freeze({
  // Share of registered controllers that have beaten at least once and read
  // `ok` (runner fresh AND product fresh where a record is declared).
  controllersOkPct: 100,
  // Share of controllers WITH a declared effect record whose record is fresh.
  recordsFreshPct: 100,
  // §7,437·B·3/B·6: every enabled account carries a day-fresh fundable
  // universe, and every enabled account has declared its horizon.
  fundableFreshPct: 100,
  horizonDeclaredPct: 100,
  // Of the FX-day's approvals, how many became a trade. Below the floor the
  // gate approves what execution cannot fill — sizing, hours, broker.
  pipelineConversionMin: 0.5,
  pipelineMinApprovals: 5,
  // Closed trades in the window still missing P&L or a postmortem.
  incompleteClosesMax: 0,
  incompleteCloseWindowHours: 48,
  // The trail rule's counterfactual: a PF that at least does not lose,
  // measured over the counterfactual's own 30-trade floor; below it the
  // goal is not measurable. The 69% win-rate half of this goal was DELETED
  // in Wave 3 of the first-principles audit (19-09-2026): exit asymmetry
  // sets expectancy, not entry accuracy, and a trail rule that wins 40% of
  // the time at 3R is doing its job.
  trailMinPf: 1.0,
  trailDays: 30,
  // Per-family edge (Wave 3, §K item 10): the three numbers a system is
  // judged by at its horizon — PF, tail share (closes beyond +2R) and max
  // drawdown in R — per strategy family over a rolling window, measurable
  // only from familyMinCloses decidable closes. familyMaxDdR matches the
  // tick-validation programme's owner-set 8R budget; it is an evidence
  // target for a verdict, not a risk limit (nothing sizes or halts on it).
  familyMinPf: 1.5,
  familyTailSharePct: 20,
  familyMaxDdR: 8,
  familyMinCloses: 30,
  familyDays: 90,
  // The momentum trial's pre-registered checkpoint (§K item 12): judged
  // on ONE date, on the trial account's momentum-family closes since the
  // trial began, by the three family targets above. The date is read from
  // agent/config/strategy-pins.json (_trial_note), not restated here; the
  // start is the Wave 1 deploy that switched the trial on.
  momentumTrialSince: '2026-09-18T22:26:00Z',
  // Earned-floor checkpoint: pre-registered in earned-floor.js as 30 closes
  // and PF ≥ 1.5. Read from there, not restated, so the two cannot drift.
  // Open inspector findings older than this many hours count against the
  // inspector, whose job is to close what it opens.
  inspectorOpenMaxHours: 24,
  inspectorOpenMax: 0,
  // Momentum account: share of the configured universe that is tradable on
  // the account. Not measurable until the account is named.
  momentumTradableMinPct: 50,
  // §7,437·B·4: share of the bot's own closes (last N days) that were
  // scored against the plan written at entry.
  plansScoredMinPct: 100,
  plansDays: 30,
  // §7,437·B·2: net R of the refused setups over the window. At or below
  // zero the gate refused net losers; above it, it refused winners. Not
  // measurable under the scored floor.
  refusalNetRMax: 0,
  refusalMinScored: 20,
  refusalDays: 7,
  // PR-C (owner principle 7): vetoes are a cost to minimise. The rate is
  // vetoed / reached-gate this FX day; the target is a ceiling the owner can
  // lower as the pre-gates take effect (11-09-2026 read 99.9 %).
  vetoRateMax: 0.9,
  // 50, not 200: the pre-gates are meant to pull reachedGate from ~10k/day
  // into the hundreds, and a floor the plan expects to fall under would make
  // the goal not_measurable exactly when it starts working (checker, 11-09).
  vetoMinReachedGate: 50,
  // PR-E (owner principle 4): trades since the origin cutoff with no stated
  // reason (origin, strategy, plan, approval id, close reason, scored plan)
  // plus UNKNOWN sends older than the resolver's age floor.
  tradeReasonsMax: 0,
  // Wave 5 (§K·15): the fast monitor's cadence. Share of ticks (10-minute
  // window) skipped because the previous pass was still running — the
  // overrun that used to reach the log only as a throttled count. Read from
  // the monitor's own pass record; not measurable when the record is absent
  // or older than fastMonitorRecordMaxAgeMin.
  fastMonitorSkipMaxPct: 10,
  fastMonitorRecordMaxAgeMin: 5,
  // V3 L1 (owner order 25-09-2026): order-lifecycle records made since the
  // acceptance start (agent/config/order-lifecycle.json) that failed to store
  // or are incomplete — pre-order, order, close — and records stuck now,
  // counted as distinct records. Read from the order_lifecycle snapshot; not
  // measurable when it is older than lifecycleSnapshotMaxAgeMin.
  lifecycleNewDefectsMax: 0,
  lifecycleStuckMax: 0,
  lifecycleSnapshotMaxAgeMin: 30,
  // V3 M3 (P1/P4-3): the startup, lag, protection-freshness and loop-latency
  // limits — PROPOSED, not agreed (closure:205, H-P1-1). They live in
  // p1p4-grade.js so the acceptance harness and these rows read one set.
  // A null is a limit the owner has to set (no proposal exists). The four
  // P1/P4 rows read 'proposed' until the owner stamps p1p4LimitsConfirmedAt
  // with a date through POST /actions/goal-table; until then they are not
  // counted as off track (owner principle 6: a proposal is not a result).
  ...p1p4TargetDefaults(),
})

export function goalTargets(raw) {
  const out = { ...DEFAULT_GOAL_TARGETS }
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      if (k in DEFAULT_GOAL_TARGETS) {
        if (DEFAULT_GOAL_TARGETS[k] === null) {
          // V3 M3: a limit with no proposed value stays unset until a real
          // number arrives. Number(null) is 0 and Number(true) is 1, so
          // without this branch a stored null (every POST stores the full
          // merged targets) would become a zero limit on the next read.
          if (v !== null && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v))) out[k] = Number(v)
          continue
        }
        if (typeof DEFAULT_GOAL_TARGETS[k] === 'string') {
          // A date-valued target (momentumTrialSince): a string that parses
          // as a date replaces the default; anything else is junk and the
          // default stands — never NaN, never a silently ignored override.
          if (typeof v === 'string' && Number.isFinite(Date.parse(v))) out[k] = v
          continue
        }
        const n = Number(v)
        if (Number.isFinite(n)) out[k] = n
      } else {
        out[k] = v // unknown keys survive — never rebuild from a fixed list
      }
    }
  }
  return out
}

export function loadGoalTable(db) {
  let stored = null
  try { stored = JSON.parse(getState(db, GOAL_TABLE_KEY) || 'null') } catch { stored = null }
  return { ...(stored && typeof stored === 'object' ? stored : {}), targets: goalTargets(stored?.targets) }
}

const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null)

function goal(id, fields) {
  return { id, ...fields }
}

// ---------------------------------------------------------------------------
// Individual goals. Each returns { name, subsystem, metric, target, horizon,
// current, verdict, note, source }. A goal that cannot read its metric
// returns not_measurable with the reason — it never throws, because a goal
// table that can fail to report is the thing it is watching for.
// ---------------------------------------------------------------------------

async function controllersGoal(db, targets, nowMs) {
  const { heartbeatView } = await import('./heartbeat.js')
  const view = heartbeatView(db, { now: new Date(nowMs) })
  // A retired controller (Wave 5, §K·15: pending_orders) is not judged — it
  // is not scheduled, so its freshness is not a fact about the system.
  const ran = view.filter(v => v.verdict !== 'never_ran' && !v.dormant && !v.retired)
  const ok = ran.filter(v => v.verdict === 'ok')
  const bad = ran.filter(v => v.verdict !== 'ok').map(v => `${v.name}:${v.verdict}`)
  const current = pct(ok.length, ran.length)
  return goal('controllers_ok', {
    name: 'Controllers fresh', subsystem: 'heartbeat',
    metric: 'controllers reading ok / controllers that have run', target: `≥ ${targets.controllersOkPct}%`,
    horizon: 'now', current: current == null ? null : `${current}%`,
    verdict: ran.length === 0 ? 'not_measurable' : current >= targets.controllersOkPct ? 'on_track' : 'off_track',
    note: ran.length === 0 ? 'no controller has beaten yet' : bad.length ? `${ok.length}/${ran.length} ok — ${bad.join(', ')}` : `${ok.length}/${ran.length} ok`,
    source: '/state/heartbeats',
  })
}

/**
 * Wave 5 (§K·15): the fast monitor's overrun as a goal. The tick path writes
 * fast_monitor_pass_json (throttled to 5 s) with tick.skipShare10m; this row
 * reads it and compares with fastMonitorSkipMaxPct.
 */
function monitorCadenceGoal(db, targets, nowMs) {
  let rec = null
  try { rec = JSON.parse(getState(db, 'fast_monitor_pass_json') || 'null') } catch { rec = null }
  const atMs = rec?.at ? Date.parse(rec.at) : NaN
  const ageMin = Number.isFinite(atMs) ? (nowMs - atMs) / 60_000 : null
  const stale = ageMin == null || ageMin > targets.fastMonitorRecordMaxAgeMin
  const share = rec?.tick?.skipShare10m
  const measurable = !stale && Number.isFinite(share)
  const pct = measurable ? Math.round(share * 1000) / 10 : null
  const baseNote = !rec ? 'no pass record yet (fast_monitor_pass_json absent)'
    : stale ? `pass record is ${ageMin == null ? 'undated' : `${Math.round(ageMin)} min old`} — older than ${targets.fastMonitorRecordMaxAgeMin} min; the monitor is not writing it`
      : !Number.isFinite(share) ? 'pass record predates the share (written by a build before Wave 5)'
        : `${rec.tick.skipped10m ?? '?'} skipped of ~${Math.round(600_000 / (rec.tick.everyMs || 3_000))} expected; busy ${Math.round((rec.tick.busyShare10m ?? 0) * 100)}% of the window; last tick ${rec.tick.lastMs ?? '?'} ms, max ${rec.tick.max10mMs ?? '?'} ms`
  // 20-09-2026: the sidecar-quote acceptance figure, appended when the
  // record carries a 10-minute window (older records do not — this note is
  // then byte-identical to before). No new goal row, no target/verdict change.
  const q10 = rec?.tick?.quotes10m
  const note = q10 && q10.passes
    ? `${baseNote} · quotes 10m: ${q10.fromSidecar} sidecar / ${q10.fromBroker} broker (${Math.round(q10.sidecarSharePct ?? 0)}% sidecar)`
    : baseNote
  return goal('monitor_cadence', {
    name: 'Fast monitor keeps its cadence', subsystem: 'fast monitor',
    metric: 'share of ticks skipped because the previous pass was still running, 10 min',
    target: `≤ ${targets.fastMonitorSkipMaxPct}%`, horizon: 'now',
    current: pct == null ? null : `${pct}%`,
    verdict: !measurable ? 'not_measurable' : pct <= targets.fastMonitorSkipMaxPct ? 'on_track' : 'off_track',
    note,
    source: '/health (fastMonitor)',
  })
}

async function recordsGoal(db, targets, nowMs) {
  const { heartbeatView } = await import('./heartbeat.js')
  const view = heartbeatView(db, { now: new Date(nowMs) })
  // Only controllers that have RUN are judged on their record: a controller
  // that never beat is the controllers_ok goal's finding, not this one's. A
  // dormant controller (heartbeat `dormantWhen`, V3 I2) is expected to leave
  // its record unwritten, so its age is not staleness — the same exclusion
  // controllers_ok already makes.
  const withRecord = view.filter(v => v.work_product && v.verdict !== 'never_ran' && !v.dormant)
  const fresh = withRecord.filter(v => v.work_product.fresh)
  const stale = withRecord.filter(v => !v.work_product.fresh).map(v => `${v.name} (${v.work_product.summary})`)
  const current = pct(fresh.length, withRecord.length)
  return goal('records_fresh', {
    name: 'Effect records fresh', subsystem: 'heartbeat',
    metric: 'controllers whose product record is within its limit / controllers with a record', target: `≥ ${targets.recordsFreshPct}%`,
    horizon: 'now', current: current == null ? null : `${current}%`,
    verdict: withRecord.length === 0 ? 'not_measurable' : current >= targets.recordsFreshPct ? 'on_track' : 'off_track',
    note: stale.length ? stale.join(' · ') : `${fresh.length}/${withRecord.length} fresh`,
    source: '/state/heartbeats work_product',
  })
}

function pipelineGoal(db, targets) {
  let audit = null
  try { audit = JSON.parse(getState(db, 'decision_audit_last_json') || 'null') } catch { audit = null }
  const approved = Number(audit?.approved ?? NaN)
  const trades = Number(audit?.tradesOpened ?? NaN)
  const measurable = audit && Number.isFinite(approved) && Number.isFinite(trades) && approved >= targets.pipelineMinApprovals
  const ratio = measurable ? Math.round((trades / approved) * 100) / 100 : null
  return goal('pipeline_conversion', {
    name: 'Approvals become trades', subsystem: 'decision audit',
    metric: 'trades opened / proposals approved, this FX day', target: `≥ ${targets.pipelineConversionMin}`,
    horizon: 'FX day', current: ratio,
    verdict: !audit ? 'not_measurable' : !measurable ? 'not_measurable' : ratio >= targets.pipelineConversionMin ? 'on_track' : 'off_track',
    note: !audit ? 'no decision audit on record'
      : !measurable ? `${Number.isFinite(approved) ? approved : 0} approval(s) — below the ${targets.pipelineMinApprovals}-approval floor`
        : `${trades} trade(s) from ${approved} approval(s)${audit.because ? ` — ${audit.because}` : ''}`,
    source: 'decision_audit_last_json',
  })
}

/**
 * PR-C — the veto goal. Reads the decision audit the loop stores every cycle
 * (`decision_audit_last_json`, the same source pipelineGoal reads) and falls
 * back to a live audit when none is stored yet.
 *
 *   vetoRate  = vetoed / reachedGate
 *   wasteRate = (vetoed − vetoedDistinct) / vetoed — the share of refusals
 *               that were repeats of a refusal already on record
 *
 * off_track when the rate is above `vetoRateMax`; not_measurable below the
 * `vetoMinReachedGate` floor, since a rate over a handful of proposals says
 * nothing about the pipeline.
 */
export async function vetoGoal(db, targets, nowMs = Date.now()) {
  let audit = null
  try { audit = JSON.parse(getState(db, 'decision_audit_last_json') || 'null') } catch { audit = null }
  if (!audit) {
    try {
      const { auditDecisions } = await import('./decision-audit.js')
      audit = auditDecisions(db, { now: new Date(nowMs) })
    } catch { audit = null }
  }
  const vetoed = Number(audit?.vetoed ?? NaN)
  const reachedGate = Number(audit?.reachedGate ?? NaN)
  const distinctRaw = Number(audit?.vetoedDistinct ?? NaN)
  const vetoedDistinct = Number.isFinite(distinctRaw) ? distinctRaw : null
  const measurable = !!audit && Number.isFinite(vetoed) && Number.isFinite(reachedGate) && reachedGate >= targets.vetoMinReachedGate
  const vetoRate = measurable ? Math.round((vetoed / reachedGate) * 1000) / 1000 : null
  const wasteRate = measurable && vetoed > 0 && vetoedDistinct != null
    ? Math.round(((vetoed - vetoedDistinct) / vetoed) * 1000) / 1000
    : null
  return goal('veto_rate', {
    name: 'Vetoes minimised', subsystem: 'risk gate',
    metric: 'proposals vetoed / proposals that reached the gate, this FX day (waste = repeats of a refusal already on record)',
    target: `≤ ${targets.vetoRateMax}`,
    horizon: 'FX day',
    current: vetoRate == null ? null : `${vetoRate} (${vetoed} vetoes, ${vetoedDistinct ?? '?'} distinct${wasteRate == null ? '' : `, waste ${Math.round(wasteRate * 100)}%`})`,
    verdict: !audit ? 'not_measurable' : !measurable ? 'not_measurable' : vetoRate <= targets.vetoRateMax ? 'on_track' : 'off_track',
    note: !audit ? 'no decision audit on record'
      : !measurable ? `${Number.isFinite(reachedGate) ? reachedGate : 0} proposal(s) reached the gate — below the ${targets.vetoMinReachedGate} floor`
        : `${vetoed}/${reachedGate} vetoed${audit.topVetoes?.[0]?.key ? ` — top reason: ${String(audit.topVetoes[0].key).split(/[:\s]/)[0]}` : ''}`,
    vetoRate, wasteRate, vetoed, vetoedDistinct, reachedGate,
    source: 'decision_audit_last_json',
  })
}

// V3 B4 (P5b-3): a completeness row carries at most this many named items.
const GOAL_ITEMS_MAX = 50

/**
 * V3 B4: the reading if the owner answered H-P5b-3 "labelled rows meet the
 * target" — shown BESIDE the counted verdict, in the shape of M3's
 * proposedVerdict, never in its place. `current`/`verdict` stay on the raw
 * count; this changes no summary number.
 */
function ifOwnerExcludes(n, max) {
  return { question: GOAL_SEMANTICS.id, counted: false, current: n, verdict: n <= max ? 'on_track' : 'off_track' }
}

async function closesGoal(db, targets, nowMs) {
  const { findIncompleteCloses, countFlatExemptCloses, findUnpricedClosesWithoutCloseStamp, CLOSE_CLASSES } = await import('./close-completeness.js')
  const rows = findIncompleteCloses(db, { windowHours: targets.incompleteCloseWindowHours, now: nowMs })
  const pnl = rows.filter(r => r.missingPnl).length, flat = countFlatExemptCloses(db, { windowHours: targets.incompleteCloseWindowHours, now: nowMs })
  const pm = rows.filter(r => r.missingPostmortem).length, flatNote = flat ? `; ${flat} closed exactly flat carry no postmortem — exempt, there is no outcome to classify (V3 L2b W16)` : flat == null ? '; flat-close exemption count unavailable (read failed)' : ''
  // V3 B4: the count is the whole; its parts are named beside it (the L1c
  // headline shape) and every labelled row is listed with its reason.
  const byClass = Object.fromEntries(Object.keys(CLOSE_CLASSES).map(k => [k, rows.filter(r => r.class === k).length]))
  const order = ['broker_evidence_pending', 'postmortem_pending', 'labelled_unrecoverable']
  const sorted = [...rows].sort((a, b) => order.indexOf(a.class) - order.indexOf(b.class) || a.closedAtMs - b.closedAtMs || a.id - b.id)
  const items = sorted.slice(0, GOAL_ITEMS_MAX)
    .map(r => ({ tradeId: r.id, account: r.accountId, symbol: r.symbol, positionId: r.positionId, closedAt: new Date(r.closedAtMs).toISOString(), missing: [r.missingPnl && 'net_pnl', r.missingPostmortem && 'postmortem'].filter(Boolean), class: r.class, reason: r.reason }))
  const outside = findUnpricedClosesWithoutCloseStamp(db)
  const parts = `${byClass.labelled_unrecoverable} labelled unrecoverable · ${byClass.broker_evidence_pending} awaiting broker evidence · ${byClass.postmortem_pending} awaiting a postmortem`
  const labelledNames = sorted.filter(r => r.class === 'labelled_unrecoverable').slice(0, 5).map(r => `#${r.id} …${String(r.accountId ?? '????').slice(-4)} ${r.symbol}`)
  const labelledNote = byClass.labelled_unrecoverable
    ? `; labelled: ${labelledNames.join(', ')}${byClass.labelled_unrecoverable > labelledNames.length ? `, +${byClass.labelled_unrecoverable - labelledNames.length} more` : ''} (each with its reason in items)`
    : ''
  const semanticsNote = rows.length ? `; every one counted until the owner answers ${GOAL_SEMANTICS.id}` : ''
  const outsideNote = outside == null ? '; unpriced closes without closed_at_ms: unreadable'
    : outside.length ? `; ${outside.length} more unpriced close(s) carry no closed_at_ms and are outside this count, not recovered: ${outside.slice(0, 5).map(o => `#${o.id}${o.writtenOff ? ' (written off)' : ''}`).join(', ')}${outside.length > 5 ? ', …' : ''}` : ''
  return goal('close_completeness', {
    name: 'Closes recorded complete', subsystem: 'record',
    // The sweep's window is a GRACE period: a close is only incomplete once
    // it has had `incompleteCloseWindowHours` to be backfilled and still has
    // no P&L or postmortem.
    metric: `closed trades older than ${targets.incompleteCloseWindowHours}h still missing P&L or a postmortem`, target: `≤ ${targets.incompleteClosesMax}`,
    horizon: `${targets.incompleteCloseWindowHours}h grace`, current: rows.length,
    verdict: rows.length <= targets.incompleteClosesMax ? 'on_track' : 'off_track',
    note: (rows.length ? `${rows.length} incomplete — ${parts} (${pnl} missing P&L, ${pm} missing a postmortem)${labelledNote}${semanticsNote}` : flat !== 0 ? 'every close in the window carries P&L, and a postmortem unless exempt' : 'every close in the window carries P&L and a postmortem') + flatNote + outsideNote,
    // The split is a PARTITION of `current`: raw = the three classes' sum.
    split: { raw: rows.length, ...byClass, classes: CLOSE_CLASSES },
    semantics: { ...GOAL_SEMANTICS, ifOwnerExcludes: ifOwnerExcludes(byClass.broker_evidence_pending + byClass.postmortem_pending, targets.incompleteClosesMax) },
    items, itemsTotal: rows.length,
    outsidePopulation: outside == null ? null : outside.slice(0, GOAL_ITEMS_MAX), outsideTotal: outside == null ? null : outside.length,
    source: 'close-completeness',
  })
}

async function trailGoal(db, targets) {
  const { exitCounterfactual } = await import('./exit-counterfactual.js')
  const cf = exitCounterfactual(db, { days: targets.trailDays })
  const trails = (cf.rules || []).filter(r => /^trail_/.test(r.rule))
  const best = trails.sort((a, b) => (b.usable || 0) - (a.usable || 0))[0] || null
  const floor = cf.rules?.length ? undefined : undefined
  const measurable = cf.verdict === 'OK' && best && best.winRate != null && best.profitFactor != null
  const ok = measurable && best.profitFactor >= targets.trailMinPf
  return goal('trail_rule', {
    name: 'Trail rule does not lose', subsystem: 'managed exit',
    metric: best ? `${best.rule} replay: profit factor (win rate shown, not a target)` : 'trail rule replay: profit factor',
    target: `PF ≥ ${targets.trailMinPf}`,
    horizon: `${targets.trailDays}d`,
    current: measurable ? `PF ${best.profitFactor} · WR ${best.winRate}% (measured) · n=${best.usable}` : null,
    verdict: !measurable ? 'not_measurable' : ok ? 'on_track' : 'off_track',
    note: !measurable ? (cf.note || 'insufficient replayable trades') : `${best.usable} replayable trade(s); ${cf.eligible} eligible of ${cf.considered} considered`,
    source: '/state/exit-counterfactual',
    ...(floor === undefined ? {} : {}),
  })
}

async function earnedFloorGoal(db) {
  const { earnedFloorReport, EARNED_FLOOR_VERDICT_TARGET } = await import('./earned-floor.js')
  const r = earnedFloorReport(db)
  const closes = Number(r?.closed?.trades ?? 0)
  const pf = r?.closed?.profitFactor ?? null
  const reached = closes >= EARNED_FLOOR_VERDICT_TARGET.closes
  return goal('earned_floor', {
    name: 'Earned floor keeps its gate', subsystem: 'evidence gate',
    metric: 'profit factor of the admitted population at the pre-registered checkpoint',
    target: `PF ≥ ${EARNED_FLOOR_VERDICT_TARGET.minPf} after ${EARNED_FLOOR_VERDICT_TARGET.closes} closes`,
    horizon: `${EARNED_FLOOR_VERDICT_TARGET.closes} closes`,
    current: `${closes}/${EARNED_FLOOR_VERDICT_TARGET.closes} closes · PF ${pf ?? 'n/a'} · net ${r?.closed?.net ?? 0}`,
    verdict: !r?.config?.on ? 'not_measurable' : !reached ? 'not_measurable' : (pf != null && pf >= EARNED_FLOOR_VERDICT_TARGET.minPf) ? 'on_track' : 'off_track',
    note: !r?.config?.on ? 'earned floor is off' : !reached ? `${EARNED_FLOOR_VERDICT_TARGET.closes - closes} close(s) short of the checkpoint (interim PF ${pf ?? 'n/a'})` : 'checkpoint reached',
    source: '/state/earned-floor',
  })
}

async function inspectorGoal(db, targets, nowMs) {
  const { inspectorView } = await import('./log-inspector.js')
  const v = inspectorView(db)
  const open = Array.isArray(v?.findings) ? v.findings : (Array.isArray(v?.open) ? v.open : [])
  const cutoff = nowMs - targets.inspectorOpenMaxHours * 3_600_000
  const old = open.filter(f => { const t = Date.parse(f.at || ''); return Number.isFinite(t) && t < cutoff })
  const t = v?.terminal || {}
  return goal('inspector_closes_findings', {
    name: 'Inspector closes what it opens', subsystem: 'log inspector',
    metric: `open findings older than ${targets.inspectorOpenMaxHours}h`, target: `≤ ${targets.inspectorOpenMax}`,
    horizon: `${targets.inspectorOpenMaxHours}h`, current: old.length,
    verdict: !v?.lastRun && open.length === 0 && !(t.confirmed || t.falsified || t.expired) ? 'not_measurable' : old.length <= targets.inspectorOpenMax ? 'on_track' : 'off_track',
    note: `${open.length} open · terminal ${t.confirmed || 0} confirmed / ${t.falsified || 0} falsified / ${t.expired || 0} expired`,
    source: '/state/inspector',
  })
}

async function momentumGoal(db, targets) {
  const { momentumAccountReport } = await import('./momentum-account.js')
  const r = momentumAccountReport(db)
  const on = !!r?.config?.accountId
  const built = Number(r?.universe?.built ?? 0)
  const tradable = Number(r?.universe?.tradable ?? 0)
  const share = pct(tradable, built)
  return goal('momentum_universe_tradable', {
    name: 'Momentum universe is fundable', subsystem: 'momentum account',
    metric: 'tradable names / built universe on the momentum account', target: `≥ ${targets.momentumTradableMinPct}%`,
    horizon: 'daily pass', current: share == null ? null : `${share}%`,
    verdict: !on ? 'not_measurable' : built === 0 ? 'not_measurable' : share >= targets.momentumTradableMinPct ? 'on_track' : 'off_track',
    note: !on ? 'momentum account not switched on (momentum_account_json.accountId is null)'
      : built === 0 ? 'no universe built yet — first daily pass pending'
        : `${tradable}/${built} tradable` + (r.universe?.byReason && Object.keys(r.universe.byReason).length ? ` — excluded: ${Object.entries(r.universe.byReason).map(([k, n]) => `${k} ${n}`).join(', ')}` : ''),
    source: '/state/momentum-account',
  })
}

async function plansGoal(db, targets, nowMs) {
  const { tradePlansReport } = await import('./trade-plans.js')
  const r = tradePlansReport(db, { days: targets.plansDays, now: nowMs })
  const c = r.coverage
  const share = pct(c.botScored, c.botClosed)
  return goal('plans_scored', {
    name: 'Closes scored against their plan', subsystem: 'trade plans',
    metric: `bot closes scored against the plan written at entry / bot closes, last ${targets.plansDays}d`, target: `≥ ${targets.plansScoredMinPct}%`,
    horizon: `${targets.plansDays}d`, current: share == null ? null : `${share}%`,
    verdict: c.botClosed === 0 ? 'not_measurable' : share >= targets.plansScoredMinPct ? 'on_track' : 'off_track',
    note: c.botClosed === 0 ? 'no bot close in the window yet'
      : `${c.botScored}/${c.botClosed} scored (${c.botPlanned} carried a plan)` + (r.aggregate.n ? ` · mean slippage ${r.aggregate.meanSlippageR}R · mean realised ${r.aggregate.meanRealisedR}R · exits within rule ${r.aggregate.exitMatchedPct}%` : ''),
    source: '/state/trade-plans',
  })
}

async function refusalGoal(db, targets, nowMs) {
  const { refusalCostReport } = await import('./refusal-ledger.js')
  const r = refusalCostReport(db, { days: targets.refusalDays, now: nowMs })
  const t = r.total
  const measurable = t.scored >= targets.refusalMinScored
  return goal('refusal_cost', {
    name: 'Refusals avoid losers, not winners', subsystem: 'risk gate',
    metric: `net R the refused setups would have reached, last ${targets.refusalDays}d`, target: `≤ ${targets.refusalNetRMax}R`,
    horizon: `${targets.refusalDays}d`, current: measurable ? `${t.sumR}R over ${t.scored} scored` : null,
    verdict: !measurable ? 'not_measurable' : t.sumR <= targets.refusalNetRMax ? 'on_track' : 'off_track',
    note: !measurable ? `${t.scored} scored refusal(s) — below the ${targets.refusalMinScored} floor (${r.waiting} waiting on their horizon)`
      : `${t.wouldHavePaid}/${t.scored} would have paid · ` + r.reasons.slice(0, 3).map(x => `${x.reason} ${x.sumR}R/${x.scored}`).join(' · '),
    source: '/state/refusal-cost',
  })
}

async function reasonsGoal(db, targets, nowMs) {
  const { findUnreasonedTrades, TRADE_REASONS_CUTOFF_ISO } = await import('./close-completeness.js')
  const r = findUnreasonedTrades(db, { now: nowMs })
  const stale = r.counts.byKind.intent_unknown_stale || 0
  const measurable = r.trades > 0 || (r.considered ?? 0) > 0 || stale > 0
  const kinds = Object.entries(r.counts.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')
  // V3 B4 (P5b-3): the violations split by contract, beside the unchanged
  // raw total. pre_contract = a plan kind on a row opened before the plan
  // writer existed (#857); post_contract = every other violation — its
  // writer existed when the row was opened, so the gap is the codebase's.
  const bc = r.counts.byContract || { pre_contract: 0, post_contract: 0 }
  const kindsOf = (cls) => Object.entries(r.counts.byContractKind?.[cls] || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')
  const plan = RECORD_CONTRACTS.plan
  const splitNote = r.counts.total > 0
    ? ` — ${bc.pre_contract} pre-contract (${kindsOf('pre_contract') || 'none'}: opened before the plan writer, ${plan.pr} ${plan.since}) · ${bc.post_contract} post-contract (${kindsOf('post_contract') || 'none'}); every one counted until the owner answers ${GOAL_SEMANTICS.id}`
    : ''
  const order = ['post_contract', 'pre_contract']
  const items = [...r.violations].sort((a, b) => order.indexOf(a.contract) - order.indexOf(b.contract)).slice(0, GOAL_ITEMS_MAX)
    .map(v => ({ ...(v.tradeId != null ? { tradeId: v.tradeId } : { intentId: v.intentId }), kind: v.kind, contract: v.contract, detail: v.detail }))
  return goal('trade_reasons', {
    name: 'Every trade has a reason', subsystem: 'record',
    metric: `bot trades since ${TRADE_REASONS_CUTOFF_ISO} missing origin, strategy, plan, approval id, close reason or a scored plan, plus stale UNKNOWN sends`,
    target: `≤ ${targets.tradeReasonsMax}`,
    horizon: `since ${TRADE_REASONS_CUTOFF_ISO}`, current: measurable ? r.counts.total : null,
    verdict: !measurable ? 'not_measurable' : r.counts.total <= targets.tradeReasonsMax ? 'on_track' : 'off_track',
    note: !measurable ? `no bot trade since ${TRADE_REASONS_CUTOFF_ISO} and no UNKNOWN send — the invariant has nothing to judge; this is a fact about trading volume (the bot has not opened a trade since the cutoff), not a pass`
      : r.counts.total === 0 ? `${r.trades} bot trade(s) since the cutoff, every one with a reason on record`
        : `${r.counts.total} violation(s) over ${r.trades} trade(s): ${kinds}${splitNote}`,
    // A PARTITION of `current`: raw = pre_contract + post_contract.
    split: { raw: r.counts.total, pre_contract: bc.pre_contract, post_contract: bc.post_contract, byContractKind: r.counts.byContractKind ?? null, contract: plan },
    semantics: { ...GOAL_SEMANTICS, ifOwnerExcludes: measurable ? ifOwnerExcludes(bc.post_contract, targets.tradeReasonsMax) : null },
    items, itemsTotal: r.violations.length,
    source: 'close-completeness findUnreasonedTrades',
  })
}

function enabledAccountIds(db) {
  try { return db.prepare(`SELECT account_id FROM accounts WHERE enabled = 1 ORDER BY account_id`).all().map(r => String(r.account_id)) } catch { return [] }
}

async function fundableGoal(db, targets, nowMs) {
  const { fundableUniverseReport } = await import('./fundable-universe.js')
  const ids = enabledAccountIds(db)
  const r = fundableUniverseReport(db, ids, { now: nowMs })
  const fresh = r.accounts.filter(a => a.record !== null && !a.due)
  const current = pct(fresh.length, ids.length)
  return goal('fundable_universe', {
    name: 'Fundable universe current per account', subsystem: 'budget planner',
    metric: 'enabled accounts with a fundable-universe record under a day old / enabled accounts', target: `≥ ${targets.fundableFreshPct}%`,
    horizon: 'day', current: current == null ? null : `${current}%`,
    verdict: ids.length === 0 ? 'not_measurable' : current >= targets.fundableFreshPct ? 'on_track' : 'off_track',
    note: ids.length === 0 ? 'no enabled accounts'
      : r.accounts.map(a => `…${a.accountId.slice(-4)}: ${a.record === null ? 'no record' : `${a.summary.fundable}/${a.summary.total} fundable${a.due ? ' (due)' : ''}`}`).join(' · '),
    source: '/state/fundable-universe',
  })
}

async function horizonGoal(db, targets) {
  const { loadAccountHorizon } = await import('./account-horizon.js')
  const ids = enabledAccountIds(db)
  const decls = ids.map(id => ({ id, ...loadAccountHorizon(db, id) }))
  const declared = decls.filter(d => d.horizon || d.families.length)
  const current = pct(declared.length, ids.length)
  return goal('account_horizon', {
    name: 'One horizon per account', subsystem: 'account gates',
    metric: 'enabled accounts with a declared horizon or family set / enabled accounts', target: `≥ ${targets.horizonDeclaredPct}%`,
    horizon: 'now', current: current == null ? null : `${current}%`,
    verdict: ids.length === 0 ? 'not_measurable' : current >= targets.horizonDeclaredPct ? 'on_track' : 'off_track',
    note: ids.length === 0 ? 'no enabled accounts'
      : decls.map(d => `…${d.id.slice(-4)}: ${d.horizon || 'any horizon'}${d.families.length ? ` [${d.families.join(', ')}]` : ''}`).join(' · '),
    source: '/state/account-horizons',
  })
}

const FAMILY_LABEL = { mean_reversion: 'mean reversion', breakout: 'breakout', trend: 'trend', momentum: 'momentum' }

/**
 * Owner order 20-09-2026 ("retire the intraday paths, keep momentum only").
 * These three families measure a stack no producer can trade any more: their
 * only automatic producer was scan_dispatch, retired in
 * lib/entry-producers.js. The rows STAY — deleting them would delete the
 * measurement the decision was made on — but they read as history, not as
 * live failures. The momentum family is untouched.
 */
const RETIRED_FAMILIES = Object.freeze({
  mean_reversion: 'retired 2026-09-20 (intraday retirement)',
  breakout: 'retired 2026-09-20 (intraday retirement)',
  trend: 'retired 2026-09-20 (intraday retirement)',
})
const RETIRED_FAMILY_NOTE = 'FAMILY RETIRED 2026-09-20 (owner order: intraday paths retired, momentum only) — this row is the historical record of a stack no producer can trade; the strategies keep proposing into the scan and the refusal ledger at zero risk.'

function familyVerdict(f, targets) {
  const measurable = f.decidable >= targets.familyMinCloses && (f.profitFactor != null || f.lossless === true)
  const ddOk = f.maxDrawdownR != null && f.maxDrawdownR <= targets.familyMaxDdR
  const pfOk = f.lossless === true || (f.profitFactor != null && f.profitFactor >= targets.familyMinPf)
  const ok = measurable && pfOk && (f.tailSharePct ?? 0) >= targets.familyTailSharePct && ddOk
  const pfText = f.lossless === true ? 'PF ∞ (no losses)' : (f.profitFactor == null ? 'PF —' : `PF ${f.profitFactor}`)
  const current = f.closes > 0
    ? `${pfText} · tail ${f.tailSharePct ?? '—'}% · maxDD ${f.maxDrawdownR ?? '—'}R · n=${f.decidable}/${f.closes}`
    : null
  return { measurable, ok, current }
}

/** Wave 3 (§K item 10): one row per strategy family, PF / tail share / max DD. */
async function familyGoals(db, targets, now) {
  const { familyEdgeReport } = await import('./family-edge.js')
  const { STRATEGY_FAMILIES, familyOf, horizonJudgedKeys } = await import('./strategies.js')
  const rep = familyEdgeReport(db, { days: targets.familyDays, now })
  const horizonFams = new Set(horizonJudgedKeys().map(k => familyOf(k)).filter(Boolean))
  return STRATEGY_FAMILIES.map(fam => {
    const f = rep.families[fam]
    const v = familyVerdict(f, targets)
    const atHorizon = horizonFams.has(fam)
    const retiredNote = RETIRED_FAMILIES[fam] ? ` · ${RETIRED_FAMILY_NOTE}` : ''
    return goal(`family_edge_${fam}`, {
      name: `${FAMILY_LABEL[fam] || fam} family: PF, tail share and drawdown`, subsystem: 'strategy family',
      metric: 'closed-trade profit factor · share of closes beyond +2R · max drawdown of the cumulative R curve',
      target: `PF ≥ ${targets.familyMinPf} · tail ≥ ${targets.familyTailSharePct}% · maxDD ≤ ${targets.familyMaxDdR}R`,
      horizon: atHorizon ? `${targets.familyDays}d rolling (judged at the checkpoint, not here)` : `${targets.familyDays}d rolling`,
      current: v.current,
      verdict: !v.measurable ? 'not_measurable' : v.ok ? 'on_track' : 'off_track',
      note: (!v.measurable
        ? `${f.decidable} decidable of ${f.closes} close(s); ${targets.familyMinCloses} needed` + (f.undecidable ? ` (${f.undecidable} with no readable R)` : '')
        : `${f.decidable} decidable close(s)` + (f.undecidable ? `, ${f.undecidable} with no readable R` : '') + (atHorizon ? '; the momentum verdict is the checkpoint row' : '')) + retiredNote,
      source: '/state/family-edge',
      retired: RETIRED_FAMILIES[fam] || null,
    })
  })
}

/** The checkpoint date is read from the pins file's _trial_note, never restated. */
export function momentumCheckpointDate() {
  try {
    const cfg = JSON.parse(readFileSync(new URL('../config/strategy-pins.json', import.meta.url), 'utf8'))
    const m = String(cfg._trial_note || '').match(/checkpoint (\d{4}-\d{2}-\d{2})/)
    return m ? m[1] : null
  } catch { return null }
}

/** Wave 3 (§K item 12): the momentum trial's pre-registered checkpoint, one row, one date. */
async function momentumCheckpointGoal(db, targets, now) {
  const { familyEdgeReport } = await import('./family-edge.js')
  const { weekToDateFor, TSMOM_STRATEGY } = await import('./momentum-account.js')
  const date = momentumCheckpointDate()
  let trialIds = []
  try {
    const cfg = JSON.parse(readFileSync(new URL('../config/strategy-pins.json', import.meta.url), 'utf8'))
    trialIds = Array.isArray(cfg._trial?.[TSMOM_STRATEGY]) ? cfg._trial[TSMOM_STRATEGY].map(String) : []
  } catch { trialIds = [] }
  const acct = trialIds[0] ?? null
  const due = date ? now >= Date.parse(`${date}T00:00:00Z`) : false
  // THE VERDICT IS FROZEN ON THE DATE. A pre-registered checkpoint judged
  // on a rolling, growing sample from the date onwards is not pre-
  // registered (checker, Wave 3): the first evaluation on or after the
  // date stores its record under MOMENTUM_CHECKPOINT_KEY, and every later
  // read reports that record, not the live one. Clearing the key re-judges.
  let frozen = null
  try { frozen = JSON.parse(getState(db, MOMENTUM_CHECKPOINT_KEY) || 'null') } catch { frozen = null }
  if (frozen && frozen.date !== date) frozen = null
  const live = familyEdgeReport(db, { since: targets.momentumTrialSince, now, accountId: acct })
  const f = frozen?.family ?? live.families.momentum
  const v = familyVerdict(f, targets)
  if (due && date && acct && !frozen) {
    frozen = { date, judgedAt: new Date(now).toISOString(), family: live.families.momentum, targets: { familyMinPf: targets.familyMinPf, familyTailSharePct: targets.familyTailSharePct, familyMaxDdR: targets.familyMaxDdR, familyMinCloses: targets.familyMinCloses } }
    try { setState(db, MOMENTUM_CHECKPOINT_KEY, JSON.stringify(frozen)) } catch { /* the row still reports the live judgement */ }
  }
  const wtd = acct ? weekToDateFor(db, acct, now) : null
  return goal('momentum_checkpoint', {
    name: `Momentum trial verdict on ${date || '(date unset)'}`, subsystem: 'momentum book',
    metric: `trial account's momentum closes since ${targets.momentumTrialSince.slice(0, 10)}: PF · tail share · max drawdown`,
    target: `on ${date || '?'}: PF ≥ ${targets.familyMinPf} · tail ≥ ${targets.familyTailSharePct}% · maxDD ≤ ${targets.familyMaxDdR}R`,
    horizon: date ? `checkpoint ${date}` : 'checkpoint date unset',
    current: v.current,
    verdict: !date || !acct ? 'not_measurable' : !due ? 'not_measurable' : (v.measurable ? (v.ok ? 'on_track' : 'off_track') : 'off_track'),
    note: !date ? 'no checkpoint date in strategy-pins.json _trial_note'
      : !acct ? 'no trial account in strategy-pins.json _trial'
      : !due ? `pre-registered; judged on ${date}, not before — ${f.decidable} decidable close(s) so far on …${acct.slice(-4)}` + (wtd ? `; week to date ${wtd.closes} close(s), net ${wtd.net}` : '')
      : (v.measurable ? `judged ${frozen?.judgedAt?.slice(0, 10) ?? 'now'} on ${f.decidable} decidable close(s); frozen` : `judged ${frozen?.judgedAt?.slice(0, 10) ?? 'now'} with fewer than ${targets.familyMinCloses} decidable closes (${f.decidable}): the trial did not earn a number; frozen`),
    source: '/state/family-edge?account=<trial>',
    ...(frozen ? { judgedAt: frozen.judgedAt } : {}),
    ...(wtd ? { weekToDate: wtd } : {}),
    trialAccount: acct ? `…${acct.slice(-4)}` : null,
    checkpointDate: date,
  })
}

// ---------------------------------------------------------------------------
// V3 M3 (P1/P4-3): four rows on the startup and load limits. They read the
// boot record V3 M1 persists (boot_record_json: the startup window's stamps,
// the lag tap and the main-loop ring) and each account's raw protection
// timestamps — never a heartbeat verdict, which the boot grace suppresses for
// the first 300 s (heartbeat.js BOOT_GRACE_SEC).
//
// THE VERDICT IS 'proposed' until the owner confirms the limits (closure:205):
// the row still shows the reading and what it WOULD read (`proposedVerdict`),
// but it is not counted as off track — a proposal presented as a result is
// what owner principle 6 forbids. With p1p4LimitsConfirmedAt set, the same
// rows read on_track / off_track. No data is not_measurable, confirmed or not.
// ---------------------------------------------------------------------------

export const BOOT_RECORD_KEY = 'boot_record_json'
/** The boot record is persisted every 30 s in the startup window, every 5 min after; older than this, it is not current. */
export const BOOT_RECORD_MAX_AGE_MIN = 10

function readBootRecord(db) {
  try { return JSON.parse(getState(db, BOOT_RECORD_KEY) || 'null') } catch { return null }
}

function p1p4Verdict(targets, measurable, ok) {
  const { confirmed } = p1p4LimitsFromTargets(targets)
  const limits = confirmed ? 'confirmed' : 'proposed'
  if (!measurable) return { verdict: 'not_measurable', limits }
  const would = ok ? 'on_track' : 'off_track'
  return confirmed ? { verdict: would, limits } : { verdict: 'proposed', proposedVerdict: would, limits }
}

const PROPOSED_SUFFIX = ' · limits PROPOSED, not confirmed by the owner (H-P1-1): reported, not counted as off track'
// The acceptance harness grades a window in which no /health sample saw a
// visible browser tab Not Verifiable (p1p4-grade.js `unrepresentative`: its
// Passed become Not Verifiable). These rows do not judge that — /health's
// visible-tab count is live, not recorded per window — so a quiet window can
// read on track here while the harness grades the same window Not
// Verifiable. Said on every measured row (checker, 25-09) rather than left
// for the reader to discover once the limits are confirmed.
const LOAD_SCOPE = ' · load representativeness (whether a Desk or Performance tab was visible) is not judged here — the acceptance harness grades it'
const secs = (ms) => (ms == null ? '?' : `${Math.round(ms / 100) / 10} s`)

/** The record's age in minutes at `nowMs`, from its own persistedAt; null when undated. */
function recordAgeMin(rec, nowMs) {
  const at = Date.parse(rec?.persistedAt || '')
  return Number.isFinite(at) ? (nowMs - at) / 60_000 : null
}

/** The last recorded boot's startup window: listening, worst stall, critical 5xx, first band and audit, first-evaluation failures. */
function startupWindowGoal(db, targets, nowMs) {
  const rec = readBootRecord(db)
  const { limits } = p1p4LimitsFromTargets(targets)
  const base = {
    name: 'Startup window meets the P1/P4 limits', subsystem: 'boot record',
    metric: `last boot, BOOT → +${limits.startupWindowMin} min: listening, worst event-loop stall, 5xx on critical routes, first protection band and first clean all-account audit`,
    target: `listening ≤ ${limits.listeningMaxSec} s · stall < ${limits.lagMaxMs} ms · critical 5xx ≤ ${limits.critical5xxMax} · first band without overrun · clean audit ≤ ${limits.recoverySec} s`,
    horizon: 'each boot', source: '/health bootRecord (boot_record_json)',
  }
  const bootAtMs = Date.parse(rec?.bootAt || '')
  if (!rec || !Number.isFinite(bootAtMs)) {
    return goal('startup_window', { ...base, current: null, ...p1p4Verdict(targets, false, false), note: 'no boot record (boot_record_json absent — the V3 M1 build is not running yet)' })
  }
  const asOfMs = Date.parse(rec.persistedAt || '') || nowMs
  const sinceBoot = asOfMs - bootAtMs
  const windowDone = rec.startupHttp?.complete === true || sinceBoot >= limits.startupWindowMin * 60_000
  const recoveryDone = sinceBoot >= limits.recoverySec * 1000
  const fails = []
  const listening = rec.listening?.sinceBootMs
  if (listening != null && listening > limits.listeningMaxSec * 1000) fails.push(`listening ${secs(listening)}`)
  const stall = rec.startupLag?.ms
  if (stall != null && stall >= limits.lagMaxMs) fails.push(`stall ${Math.round(stall)} ms (${rec.startupLag.loopPhase ?? '?'})`)
  let crit5 = 0
  let rep5 = 0
  for (const r of rec.startupHttp?.routes || []) {
    if (routeClass(r.route) === 'critical') crit5 += Number(r['5xx']) || 0
    else rep5 += Number(r['5xx']) || 0
  }
  if (crit5 > limits.critical5xxMax) fails.push(`${crit5} critical-route 5xx`)
  const band = rec.first?.band
  if (band && (band.ok !== true || band.overran === true)) fails.push('first band overran or failed')
  if (!band && recoveryDone) fails.push(`no band by +${limits.recoverySec} s`)
  const clean = rec.first?.cleanProtectionAudit
  if (clean && clean.sinceBootMs > limits.recoverySec * 1000) fails.push(`first clean audit at ${secs(clean.sinceBootMs)}`)
  if (!clean && recoveryDone) fails.push(`no clean all-account audit by +${limits.recoverySec} s`)
  const firstFailed = ['loop', 'slowMonitor', 'equityStop', 'adaptiveBreaker', 'performanceBreaker'].filter(k => rec.first?.[k]?.ok === false)
  if (firstFailed.length) fails.push(`first evaluation failed: ${firstFailed.join(', ')}`)
  // A failure already observed cannot be undone by the rest of the window.
  const measurable = fails.length > 0 || windowDone
  const current = [
    `listening ${secs(listening)}`, `worst stall ${stall == null ? '?' : `${Math.round(stall)} ms`}`,
    `critical 5xx ${crit5}`, `report 5xx ${rep5}`,
    `band ${band ? (band.ok === true ? 'ok' : 'failed') : 'none yet'}`,
    `clean audit ${clean ? `+${secs(clean.sinceBootMs)}` : 'none yet'}`,
    `first loop ${rec.first?.loop ? secs(rec.first.loop.ms) : 'not ended'}`,
  ].join(' · ')
  const v = p1p4Verdict(targets, measurable, fails.length === 0)
  const note = !measurable
    ? `boot ${rec.bootAt} (${rec.commit ?? 'commit ?'}): the startup window is still open — ${Math.max(0, Math.round((limits.startupWindowMin * 60_000 - sinceBoot) / 60_000))} min left`
    : `boot ${rec.bootAt} (${rec.commit ?? 'commit ?'}): ${fails.length ? fails.join('; ') : 'every component within the limits'}${rep5 ? `; ${rep5} report-route 5xx listed, tolerance is the owner's (H-P1-2)` : ''}${LOAD_SCOPE}${v.verdict === 'proposed' ? PROPOSED_SUFFIX : ''}`
  return goal('startup_window', { ...base, current, ...v, note, bootAt: rec.bootAt })
}

/** The event-loop lag over the last 10 minutes, from the 100 ms probe's tap (the persisted copy). */
function eventLoopLagGoal(db, targets, nowMs) {
  const rec = readBootRecord(db)
  const { limits } = p1p4LimitsFromTargets(targets)
  const w = rec?.latencyWindows?.eventLoopLag?.last10m
  const age = recordAgeMin(rec, nowMs)
  const stale = age == null || age > BOOT_RECORD_MAX_AGE_MIN
  const read = !!w && !stale && Number(w.n) > 0 && w.maxMs != null
  // p99 against the strict proposal "p99 < limit" (H-P1-1) through the
  // histogram bound (p1p4-grade.js p99Below): a bound that reaches the limit
  // cannot show it, so the row is not measurable then — unless the max has
  // already failed, which decides the row on its own.
  const maxOk = read && w.maxMs < limits.lagMaxMs
  const p99 = read ? p99Below(w.p99LeMs, limits.lagP99MaxMs) : null
  const p99Open = read && maxOk && p99 === 'unknown'
  const measurable = read && !p99Open
  const ok = measurable && maxOk && p99 !== 'fail'
  const v = p1p4Verdict(targets, measurable, ok)
  return goal('event_loop_lag', {
    name: 'Event loop answers in time', subsystem: 'process',
    metric: 'event-loop lag over the last 10 min (100 ms probe): max, and p99 as a histogram upper bound',
    target: `max < ${limits.lagMaxMs} ms · p99 < ${limits.lagP99MaxMs} ms`, horizon: '10 min',
    current: read ? `max ${w.maxMs} ms · p99 ≤ ${w.p99LeMs} ms` : null,
    ...v,
    note: !rec ? 'no boot record (the V3 M1 build is not running yet)'
      : stale ? `the persisted record is ${age == null ? 'undated' : `${Math.round(age)} min old`} — older than ${BOOT_RECORD_MAX_AGE_MIN} min`
        : !read ? 'no probe in the window'
          : p99Open ? `${p99Unknown(w.p99LeMs, limits.lagP99MaxMs)}; max ${w.maxMs} ms is within its limit`
            : `${w.n} probes; worst ${w.worst?.ms ?? w.maxMs} ms at ${w.worst?.at ?? '?'} (${w.worst?.loopPhase ?? '?'})${LOAD_SCOPE}${v.verdict === 'proposed' ? PROPOSED_SUFFIX : ''}`,
    source: '/health latencyWindows.eventLoopLag.last10m',
  })
}

/**
 * Every ENABLED account's Node audit and independent reading, aged from their
 * raw timestamps (the same readers /state/heartbeats runtime.accounts uses).
 */
async function protectionFreshnessGoal(db, targets, nowMs) {
  const { lastProtectionAudit } = await import('./naked-position-guard.js')
  const { independentProtectionView } = await import('./independent-protection.js')
  const { limits } = p1p4LimitsFromTargets(targets)
  const ids = enabledAccountIds(db)
  const late = []
  let auditOk = 0
  let indOk = 0
  for (const id of ids) {
    const a = lastProtectionAudit(db, { accountId: id, nowMs, expectedSec: 60, staleFactor: 3 })
    const auditAt = Date.parse(a?.at || '')
    const auditAge = Number.isFinite(auditAt) ? Math.round((nowMs - auditAt) / 1000) : null
    if (auditAge != null && auditAge <= limits.auditAgeMaxSec) auditOk++
    else late.push(`…${id.slice(-4)} audit ${auditAge == null ? 'never' : `${auditAge} s`}`)
    const ind = independentProtectionView(db, id, nowMs)
    const indAt = Number(ind?.checkedAtMs)
    const indAge = indAt > 0 ? Math.round((nowMs - indAt) / 1000) : null
    if (indAge != null && indAge <= limits.independentAgeMaxSec) indOk++
    else late.push(`…${id.slice(-4)} independent ${indAge == null ? 'none' : `${indAge} s`}`)
  }
  const measurable = ids.length > 0
  const v = p1p4Verdict(targets, measurable, measurable && late.length === 0)
  return goal('protection_freshness', {
    name: 'Protection readings are fresh', subsystem: 'protection',
    metric: 'enabled accounts whose Node protection audit and independent broker reading are within their age limits',
    target: `audit ≤ ${limits.auditAgeMaxSec} s · independent ≤ ${limits.independentAgeMaxSec} s, every enabled account`, horizon: 'now',
    current: measurable ? `${auditOk}/${ids.length} audit · ${indOk}/${ids.length} independent` : null,
    ...v,
    note: !measurable ? 'no enabled account' : `${late.length ? late.join(', ') : 'every reading within its limit'}${LOAD_SCOPE}${v.verdict === 'proposed' ? PROPOSED_SUFFIX : ''}`,
    source: '/state/heartbeats runtime.accounts (protection.at, independentProtection.checkedAtMs)',
  })
}

/** The main loop's duration p95 over the last 360 cycles; the first loop is named beside it. */
function loopLatencyGoal(db, targets, nowMs) {
  const rec = readBootRecord(db)
  const { limits } = p1p4LimitsFromTargets(targets)
  const m = rec?.latencyWindows?.mainLoop
  const age = recordAgeMin(rec, nowMs)
  const stale = age == null || age > BOOT_RECORD_MAX_AGE_MIN
  const measurable = !!m && !stale && Number(m.n) >= 10 && m.p95 != null
  const v = p1p4Verdict(targets, measurable, measurable && m.p95 <= limits.mainLoopP95MaxSec * 1000)
  const first = rec?.first?.loop
  const firstNote = first ? `; first loop ${secs(first.ms)}${limits.firstLoopMaxSec == null ? ' (no bar set — the owner sets it)' : ` against ${limits.firstLoopMaxSec} s`}` : ''
  return goal('loop_latency', {
    name: 'Main loop completes in time', subsystem: 'main loop',
    metric: 'main-loop duration p95 over the last 360 cycles (the first loop reported apart)',
    target: `p95 ≤ ${limits.mainLoopP95MaxSec} s`, horizon: 'last 360 loops',
    current: measurable ? `p95 ${secs(m.p95)} over ${m.n} loops (max ${secs(m.max)})` : null,
    ...v,
    note: !rec ? 'no boot record (the V3 M1 build is not running yet)'
      : stale ? `the persisted record is ${age == null ? 'undated' : `${Math.round(age)} min old`} — older than ${BOOT_RECORD_MAX_AGE_MIN} min`
        : !measurable ? `${m?.n ?? 0} loop(s) recorded — under the 10-loop floor${firstNote}`
          : `p50 ${secs(m.p50)}, p99 ${secs(m.p99)}${firstNote}${LOAD_SCOPE}${v.verdict === 'proposed' ? PROPOSED_SUFFIX : ''}`,
    source: '/health latencyWindows.mainLoop',
  })
}

/** V3 L1: pre-order / order / close / stuck, from order_lifecycle_last_json (order-lifecycle.js lifecycleGoals). */
export async function lifecycleGoalRows(db, targets, now, { read = null } = {}) {
  const { lifecycleGoals, readSnapshot } = await import('./order-lifecycle.js')
  const snapshot = read ? read(db) : readSnapshot(getState, db)
  return lifecycleGoals(snapshot, targets, now)
}

/**
 * The table. Every goal is attempted; one that throws reports not_measurable
 * with the error, so a broken reader is visible as a row rather than as a
 * 500 that hides the other rows.
 */
export async function goalTable(db, { now = Date.now(), lifecycleRead = null } = {}) {
  const cfg = loadGoalTable(db)
  const t = cfg.targets
  const readers = [
    ['controllers_ok', () => controllersGoal(db, t, now)],
    ['records_fresh', () => recordsGoal(db, t, now)],
    ['monitor_cadence', () => monitorCadenceGoal(db, t, now)],
    ['pipeline_conversion', () => pipelineGoal(db, t)],
    ['veto_rate', () => vetoGoal(db, t, now)],
    ['close_completeness', () => closesGoal(db, t, now)],
    ['trail_rule', () => trailGoal(db, t)],
    ['earned_floor', () => earnedFloorGoal(db)],
    ['inspector_closes_findings', () => inspectorGoal(db, t, now)],
    ['momentum_universe_tradable', () => momentumGoal(db, t)],
    ['plans_scored', () => plansGoal(db, t, now)],
    ['refusal_cost', () => refusalGoal(db, t, now)],
    ['trade_reasons', () => reasonsGoal(db, t, now)],
    ['fundable_universe', () => fundableGoal(db, t, now)],
    ['account_horizon', () => horizonGoal(db, t)],
    ['momentum_checkpoint', () => momentumCheckpointGoal(db, t, now)],
    // V3 M3 (P1/P4-3): 'proposed' until the owner confirms the limits.
    ['startup_window', () => startupWindowGoal(db, t, now)],
    ['event_loop_lag', () => eventLoopLagGoal(db, t, now)],
    ['protection_freshness', () => protectionFreshnessGoal(db, t, now)],
    ['loop_latency', () => loopLatencyGoal(db, t, now)],
  ]
  const goals = []
  // Family rows come as a group (one per family) so a failed reader shows
  // as four not_measurable rows, not one.
  try { goals.push(...await familyGoals(db, t, now)) } catch (err) {
    for (const fam of ['mean_reversion', 'breakout', 'trend', 'momentum']) goals.push(goal(`family_edge_${fam}`, { name: `family_edge_${fam}`, subsystem: 'goal table', metric: 'unreadable', target: null, horizon: null, current: null, verdict: 'not_measurable', note: `reader failed: ${err?.message || err}`, source: null }))
  }
  for (const [id, read] of readers) {
    try { goals.push(await read()) } catch (err) {
      goals.push(goal(id, { name: id, subsystem: 'goal table', metric: 'unreadable', target: null, horizon: null, current: null, verdict: 'not_measurable', note: `reader failed: ${err?.message || err}`, source: null }))
    }
  }
  // V3 L1: the four order-lifecycle rows come as a group, read from ONE
  // snapshot row; a failed reader is four not_measurable rows, not one.
  try { goals.push(...await lifecycleGoalRows(db, t, now, { read: lifecycleRead })) } catch (err) {
    for (const stage of ['pre_order', 'order', 'close', 'stuck']) goals.push(goal(`lifecycle_${stage}`, { name: `lifecycle_${stage}`, subsystem: 'goal table', metric: 'unreadable', target: null, horizon: null, current: null, verdict: 'not_measurable', note: `reader failed: ${err?.message || err}`, source: null }))
  }
  // `proposed` (V3 M3) is counted on its own: a reading against limits the
  // owner has not confirmed is neither on nor off track.
  const summary = { on_track: 0, off_track: 0, not_measurable: 0, proposed: 0 }
  for (const g of goals) summary[g.verdict] = (summary[g.verdict] || 0) + 1
  return { at: new Date(now).toISOString(), targets: t, goals, summary, note: 'Three verdicts, and a fourth for unconfirmed limits. not_measurable is a result, not a gap: the metric exists and has not earned a number yet — the note says how far it is from doing so. proposed: the row reads against limits the owner has not confirmed (H-P1-1); proposedVerdict says what it would read, and it is not counted as off track until the owner confirms.' }
}
