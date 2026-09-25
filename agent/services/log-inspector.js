// ---------------------------------------------------------------------------
// agent/services/log-inspector.js — the semantic supervisor (owner invariants
// 2–4, 31-08-2026).
//
// Invariant 2 — SPEECH-ACT INSPECTION: every log record type is classified by
//   what it SAID versus what it was trying to DO by saying it (assert / warn /
//   promise / declare / refuse), each with a CHECKABLE success predicate.
// Invariant 3 — PRINCIPLISING: an inspection finding names its next action —
//   change codebase / tweak strategy / change timing / do nothing — and only
//   the bounded classes (timing knobs, strategy toggles) may auto-apply;
//   everything else is a proposal to the owner.
// Invariant 4 — FALSIFICATION: every finding carries a prediction with a
//   metric and a deadline; a pass re-evaluates expired deadlines to
//   confirmed / falsified — and 'expired' when the evidence was pruned,
//   because confirming on absent evidence is fabrication.
//
// THE SHAPE EVERY INSPECTION HUNTS (repo failure modes, all measured here):
// something reports healthy because the thing it measures never reached it.
// Deterministic, rule-based, no LLM calls — per the owner's scope decision,
// this code inspects and the owner's assistant audits THIS at its scheduled
// reads, not the raw logs.
//
// Noise control is STRUCTURAL, not disciplinary: a partial unique index
// allows one live finding per subject_key, ever — the 32,115-identical-vetoes
// lesson applied to the inspector itself. Nothing in this module throws
// (decision-audit's non-negotiable).
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'
import { guardName } from './decision-audit.js'
import { readSnapshot, inspectLifecycleRegression, lifecycleRuleRecurs, lifecycleRulePersists } from './order-lifecycle.js'

export const INSPECTOR_DEFAULTS = {
  on: true,
  refusalAtScaleMin: 50,    // same-guard vetoes over the window to flag
  refusalWindowDays: 7,
  commissiveGraceMin: 120,  // trail_armed must tighten within this, given movement
  directiveRepeatMin: 3,    // identical directives in the window = unheeded
  effectLagMin: 120,        // beat-ok vs effect-record lag that flags
  autoApplyTiming: true,    // owner scope decision: bounded auto ON
}

export function loadInspectorConfig(db) {
  try {
    const p = JSON.parse(getState(db, 'inspector_config_json') || 'null')
    if (p && typeof p === 'object') {
      const num = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt)
      return {
        on: p.on !== false,
        refusalAtScaleMin: num(p.refusalAtScaleMin, INSPECTOR_DEFAULTS.refusalAtScaleMin),
        refusalWindowDays: num(p.refusalWindowDays, INSPECTOR_DEFAULTS.refusalWindowDays),
        commissiveGraceMin: num(p.commissiveGraceMin, INSPECTOR_DEFAULTS.commissiveGraceMin),
        directiveRepeatMin: num(p.directiveRepeatMin, INSPECTOR_DEFAULTS.directiveRepeatMin),
        effectLagMin: num(p.effectLagMin, INSPECTOR_DEFAULTS.effectLagMin),
        autoApplyTiming: p.autoApplyTiming !== false,
      }
    }
  } catch { /* corrupt — defaults */ }
  return { ...INSPECTOR_DEFAULTS }
}

// ---------------------------------------------------------------------------
// Invariant 2 — the speech-act table. DATA, not code: each entry names a
// record type, its illocution, what writing it was trying to DO, and the
// success predicate that makes the classification checkable. The test suite
// iterates this table and executes every predicate against a fixture DB —
// an entry whose predicate cannot run is decoration and fails the build.
// ---------------------------------------------------------------------------
export const SPEECH_ACTS = [
  {
    source: 'controller_heartbeats', match: 'ok beat',
    speech_act: 'assertion',
    doing: 'claiming the controller ran AND its effect exists — trusted by the operator as "this is being checked"',
    // Success = the controller's measured EFFECT moved, not just the beat.
    successPredicate: (db, { effectKey, sinceMs }) => {
      const raw = getState(db, effectKey)
      if (!raw) return false
      try {
        const at = Date.parse(JSON.parse(raw)?.at || '')
        return Number.isFinite(at) && at >= sinceMs
      } catch { return false }
    },
  },
  {
    source: 'risk_events', match: 'approved = 0',
    speech_act: 'refusal',
    doing: 'refusing one entry so capital survives — worth it only while the gate sometimes admits',
    successPredicate: (db, { sinceIso }) => {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM risk_events WHERE approved = 1 AND created_at >= ?`).get(sinceIso)
      return (r?.n || 0) > 0
    },
  },
  {
    source: 'position_events', match: "kind = 'trail_armed'",
    speech_act: 'commissive',
    doing: 'promising to tighten the stop as price moves favourably from here on',
    successPredicate: (db, { positionId, sinceIso }) => {
      const r = db.prepare(
        `SELECT COUNT(*) AS n FROM position_events
          WHERE position_id = ? AND kind IN ('trail_tightened', 'sl_moved') AND at >= ?`
      ).get(String(positionId), sinceIso)
      return (r?.n || 0) > 0
    },
  },
  {
    source: 'action_log', match: "method IN ('WATCHDOG','BREAKER','DETECTOR')",
    speech_act: 'directive',
    doing: 'telling the operator (or a controller) to act — succeeded only if the condition then cleared',
    successPredicate: (db, { method, path, sinceIso }) => {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE method = ? AND path = ? AND at >= ?`)
        .get(method, path, sinceIso)
      return (r?.n || 0) === 0 // no repetition = the directive was heeded
    },
  },
  {
    source: 'cpp_decisions', match: "component = 'guard' AND kind = 'config_changed'",
    speech_act: 'declaration',
    doing: 'changing what the order guard IS — binding on every later order until changed again',
    successPredicate: (db, { sinceIso }) => {
      const r = db.prepare(
        `SELECT COUNT(*) AS n FROM cpp_decisions WHERE component = 'guard' AND kind = 'config_changed' AND at >= ?`
      ).get(sinceIso)
      return (r?.n || 0) > 0
    },
  },
  {
    source: 'risk_events', match: "disposition = 'dropped'",
    speech_act: 'declaration',
    doing: 'declaring an approval DEAD with nothing to show — the gate said yes and nobody acted',
    successPredicate: (db, { sinceIso }) => {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM risk_events WHERE disposition = 'dropped' AND disposition_at >= ?`).get(sinceIso)
      return (r?.n || 0) === 0 // success for the SYSTEM is this declaration not recurring
    },
  },
]

// ---------------------------------------------------------------------------
// Invariant 3+4 — the inspections. Each returns candidate findings:
// { source, subject_key, speech_act, said, doing, finding, principle_kind,
//   principle_params, falsifier: {prediction, metric: {kind, ...}, deadlineMs} }
// ---------------------------------------------------------------------------

// Per-controller effect map for assertion-vs-effect. Start with the one
// measured offender (the protection audit's stuck record, 31-08 correction
// note in CLAUDE.md); extend per controller as effects gain records.
export const CONTROLLER_EFFECTS = [
  // The protection audit writes PER-ACCOUNT records (`acct:<id>:` prefix)
  // since the 02-09-2026 correction batch; the bare key is the pre-per-account
  // fossil that protection-freshness.js deliberately ignores. Reading the bare
  // key here produced finding 2850 (02-09 13:00 SGT: "effect record 41,525m
  // old") against an audit that runs every 50 seconds — the inspector's own
  // failure mode #3. `effectAt` reads the NEWEST per-account record and falls
  // back to the bare key only for a DB that predates the split.
  { controller: 'protection_audit', effectKey: 'acct:*:protection_audit_last_json', effectAt: newestProtectionAuditAt },
]

/** Newest `at` across the per-account protection-audit records, else the legacy key. NaN when none. */
export function newestProtectionAuditAt(db) {
  let best = NaN
  try {
    const rows = db.prepare(`SELECT value FROM agent_state WHERE key LIKE 'acct:%:protection_audit_last_json'`).all()
    for (const r of rows) {
      const t = Date.parse(JSON.parse(r.value || 'null')?.at || '')
      if (Number.isFinite(t) && !(t <= best)) best = t
    }
  } catch { /* fall through */ }
  if (Number.isFinite(best)) return best
  try { return Date.parse(JSON.parse(getState(db, 'protection_audit_last_json') || 'null')?.at || '') } catch { return NaN }
}

function inspectAssertionVsEffect(db, cfg, nowMs) {
  const out = []
  for (const { controller, effectKey, effectAt: readEffectAt } of CONTROLLER_EFFECTS) {
    let hb = null
    try { hb = db.prepare(`SELECT last_ok_at FROM controller_heartbeats WHERE name = ?`).get(controller) } catch { continue }
    const okAt = Date.parse(hb?.last_ok_at || '')
    if (!Number.isFinite(okAt) || nowMs - okAt > 10 * 60_000) continue // not asserting recently
    let effectAt = NaN
    try {
      effectAt = typeof readEffectAt === 'function'
        ? readEffectAt(db)
        : Date.parse(JSON.parse(getState(db, effectKey) || 'null')?.at || '')
    } catch { /* unreadable */ }
    const lagMin = Number.isFinite(effectAt) ? Math.round((nowMs - effectAt) / 60_000) : null
    if (lagMin !== null && lagMin < cfg.effectLagMin) continue
    out.push({
      source: 'controller_heartbeats',
      subject_key: `assertion_vs_effect:${controller}`,
      speech_act: 'assertion',
      said: `${controller} beat ok at ${hb.last_ok_at}`,
      doing: 'claiming its work is being done and recorded',
      finding: lagMin === null
        ? `${controller} asserts health but its effect record (${effectKey}) is unreadable — the assertion is unverifiable`
        : `${controller} asserts health while its effect record is ${lagMin}m old — the beat measures the runner, not the work (failure mode #3)`,
      principle_kind: 'code_change',
      principle_params: { controller, effectKey },
      falsifier: {
        prediction: `the effect record advances within 24h without any code change — which would mean the writer is alive and the lag was transient, falsifying the stuck-writer reading`,
        metric: { kind: 'state_advanced', key: effectKey, sinceMs: nowMs },
        deadlineMs: nowMs + 24 * 3_600_000,
      },
    })
  }
  return out
}

function inspectBrokenCommissive(db, cfg, nowMs) {
  const out = []
  let rows = []
  try {
    // Join on trade_id: position_events carries both the broker position id
    // AND the local trade id; monitored_positions carries trade_id — the one
    // key both sides share natively.
    rows = db.prepare(
      `SELECT pe.position_id, pe.at, pe.account_id, pe.symbol, mp.mfe_r
         FROM position_events pe
         JOIN monitored_positions mp ON mp.trade_id = pe.trade_id
        WHERE pe.kind = 'trail_armed' AND mp.status = 'active' AND pe.trade_id IS NOT NULL
          AND datetime(pe.at) <= datetime(?, '-' || CAST(? AS INTEGER) || ' minutes')`
    ).all(new Date(nowMs).toISOString(), Math.round(cfg.commissiveGraceMin))
  } catch { rows = [] }
  for (const r of rows) {
    if (!(Number(r.mfe_r) >= 1)) continue // no favourable movement — the promise had nothing to keep yet
    let kept = 0
    try {
      kept = db.prepare(
        `SELECT COUNT(*) AS n FROM position_events
          WHERE position_id = ? AND kind IN ('trail_tightened', 'sl_moved') AND at > ?`
      ).get(r.position_id, r.at)?.n || 0
    } catch { kept = 0 }
    if (kept > 0) continue
    out.push({
      source: 'position_events',
      subject_key: `broken_commissive:trail:${r.position_id}`,
      speech_act: 'commissive',
      said: `trail_armed on position ${r.position_id} (${r.symbol}) at ${r.at}`,
      doing: 'promising to tighten the stop as price moves favourably',
      finding: `armed ${cfg.commissiveGraceMin}+ minutes ago, MFE has reached ${r.mfe_r}R, and no tightening event exists — a promise with no keeping (the 0016.HK shape)`,
      principle_kind: 'code_change',
      principle_params: { positionId: r.position_id, symbol: r.symbol },
      falsifier: {
        prediction: 'a tightening event for this position appears within 12h — which would mean the trail was merely slow, falsifying the broken-promise reading',
        metric: { kind: 'position_event_exists', positionId: String(r.position_id), kinds: ['trail_tightened', 'sl_moved'], sinceMs: nowMs },
        deadlineMs: nowMs + 12 * 3_600_000,
      },
    })
  }
  return out
}

function inspectRefusalAtScale(db, cfg, nowMs) {
  const out = []
  const sinceIso = new Date(nowMs - cfg.refusalWindowDays * 86_400_000).toISOString()
  let rows = []
  try {
    rows = db.prepare(
      `SELECT veto_reason, SUM(COALESCE(repeat_count, 1)) AS n FROM risk_events
        WHERE approved = 0 AND veto_reason IS NOT NULL AND created_at >= ?
        GROUP BY veto_reason`
    ).all(sinceIso)
  } catch { rows = [] }
  const byGuard = new Map()
  for (const r of rows) {
    const g = guardName(r.veto_reason) || 'unspecified'
    byGuard.set(g, (byGuard.get(g) || 0) + r.n)
  }
  let admits = 0
  try {
    admits = db.prepare(
      `SELECT COUNT(*) AS n FROM risk_events WHERE approved = 1 AND created_at >= ?
          AND (checks_json IS NULL OR checks_json NOT LIKE '%_placed_%')`
    ).get(sinceIso)?.n || 0
  } catch { admits = 0 }
  for (const [g, n] of byGuard) {
    if (n < cfg.refusalAtScaleMin) continue
    if (admits > n / 10) continue // the gate still admits at a real rate — refusals are selection, not a wall
    out.push({
      source: 'risk_events',
      subject_key: `refusal_at_scale:${g}`,
      speech_act: 'refusal',
      said: `${n} '${g}' vetoes in ${cfg.refusalWindowDays}d against ${admits} admissions`,
      doing: 'protecting capital one refusal at a time — worth it only while something is sometimes admitted',
      finding: `the '${g}' guard refuses at scale while the gate admits almost nothing — a gate answering a question nobody asks (the 2,270:1 shape); either the inflow is misconfigured upstream or the floor no longer matches the strategy set`,
      principle_kind: 'none',
      principle_params: { guard: g, vetoes: n, admits },
      falsifier: {
        prediction: `the same guard vetoes at least ${Math.round(n / 4)} more times over the NEXT ${cfg.refusalWindowDays}d — fewer means the mismatch was transient market conditions, falsifying the structural reading`,
        metric: { kind: 'veto_count_at_least', guard: g, sinceMs: nowMs, min: Math.round(n / 4) },
        deadlineMs: nowMs + cfg.refusalWindowDays * 86_400_000,
      },
    })
  }
  return out
}

function inspectUnheededDirective(db, cfg, nowMs) {
  const out = []
  const sinceIso = new Date(nowMs - 7 * 86_400_000).toISOString()
  let rows = []
  try {
    rows = db.prepare(
      `SELECT method, path, COUNT(*) AS n, MAX(at) AS last_at FROM action_log
        WHERE method IN ('WATCHDOG', 'BREAKER', 'DETECTOR') AND at >= ?
        GROUP BY method, path HAVING n >= ?`
    ).all(sinceIso, Math.round(cfg.directiveRepeatMin))
  } catch { rows = [] }
  for (const r of rows) {
    out.push({
      source: 'action_log',
      subject_key: `unheeded_directive:${r.method}:${r.path}`,
      speech_act: 'directive',
      said: `${r.method} ${r.path} fired ${r.n}× in 7d (last ${r.last_at})`,
      doing: 'directing that something change — these actors dedupe per trigger, so repetition means the condition keeps returning',
      finding: `the directive repeats without its condition clearing — either the action it takes does not address the cause, or nothing consumes it`,
      principle_kind: 'none',
      principle_params: { method: r.method, path: r.path, count: r.n },
      falsifier: {
        prediction: 'the same directive does NOT fire again in the next 7d — which would mean it finally bound, falsifying the unheeded reading',
        metric: { kind: 'action_log_absent', method: r.method, path: r.path, sinceMs: nowMs },
        deadlineMs: nowMs + 7 * 86_400_000,
      },
    })
  }
  return out
}

function inspectSilentGap(db, cfg, nowMs) {
  const sinceIso = new Date(nowMs - 86_400_000).toISOString()
  let n = 0
  try {
    n = db.prepare(
      `SELECT COUNT(*) AS n FROM risk_events WHERE disposition = 'dropped' AND disposition_at >= ?`
    ).get(sinceIso)?.n || 0
  } catch { n = 0 }
  if (n === 0) return []
  return [{
    source: 'risk_events',
    subject_key: 'silent_gap:dropped_approvals',
    speech_act: 'declaration',
    said: `${n} approval(s) dispositioned 'dropped' in 24h`,
    doing: 'declaring that the gate said yes and nothing acted — §70.8\'s silent gap, now counted',
    finding: `approvals are dying between the gate and the broker — the exact gap the write-ahead intent row was built to close; something on the dispatch path is eating them again`,
    principle_kind: 'code_change',
    principle_params: { dropped24h: n },
    falsifier: {
      prediction: 'zero further dropped dispositions in the next 24h — which would mean the drops were a transient (deploy window, broker outage), falsifying the recurring-defect reading',
      metric: { kind: 'dropped_absent', sinceMs: nowMs },
      deadlineMs: nowMs + 86_400_000,
    },
  }]
}

// V3 L1: a lifecycle rule producing NEW defective records (after the
// acceptance start), or holding records stuck now, whose fix is a writer or
// resolver change — one proposed code_change finding per rule@version, read
// from the order_lifecycle snapshot only (no rule runs here). A stuck rule's
// falsifier asks whether it is still stuck at the deadline
// (lifecycle_rule_persists), not whether it recurred.
function inspectLifecycleRegressionRun(db, _cfg, nowMs) {
  return inspectLifecycleRegression(readSnapshot(getState, db), nowMs)
}

export const INSPECTIONS = [
  { key: 'assertion_vs_effect', run: inspectAssertionVsEffect },
  { key: 'broken_commissive', run: inspectBrokenCommissive },
  { key: 'refusal_at_scale', run: inspectRefusalAtScale },
  { key: 'unheeded_directive', run: inspectUnheededDirective },
  { key: 'silent_gap', run: inspectSilentGap },
  { key: 'lifecycle_regression', run: inspectLifecycleRegressionRun },
]

// ---------------------------------------------------------------------------
// Invariant 4 — falsifier metrics. Named kinds, never raw SQL in data.
// Returns true (prediction held → CONFIRMED), false (→ FALSIFIED), or null
// (unevaluable — evidence pruned/absent → EXPIRED, never confirmed).
// ---------------------------------------------------------------------------
export function evalFalsifierMetric(db, metric) {
  try {
    const sinceIso = new Date(Number(metric.sinceMs) || 0).toISOString()
    switch (metric?.kind) {
      case 'state_advanced': {
        // A key with '*' is a family (the per-account protection-audit
        // records): the newest `at` across the family is the effect time.
        let at = NaN
        if (String(metric.key).includes('*')) {
          const rows = db.prepare(`SELECT value FROM agent_state WHERE key LIKE ?`).all(String(metric.key).replace(/\*/g, '%'))
          if (!rows.length) return null
          for (const r of rows) {
            let t = NaN
            try { const p = JSON.parse(r.value || 'null'); t = Date.parse(p?.at || p?.lastAttemptAt || '') } catch { t = NaN }
            if (Number.isFinite(t) && !(t <= at)) at = t
          }
        } else {
          const raw = getState(db, metric.key)
          if (!raw) return null
          at = Date.parse(JSON.parse(raw)?.at || JSON.parse(raw)?.lastAttemptAt || '')
        }
        if (!Number.isFinite(at)) return null
        // Prediction was "it advances WITHOUT a code change" → advanced = the
        // stuck reading was wrong = the finding's interpretation FALSIFIED.
        return !(at > Number(metric.sinceMs))
      }
      case 'position_event_exists': {
        const r = db.prepare(
          `SELECT COUNT(*) AS n FROM position_events
            WHERE position_id = ? AND kind IN (${metric.kinds.map(() => '?').join(',')}) AND at >= ?`
        ).get(String(metric.positionId), ...metric.kinds, sinceIso)
        // Tightening appeared → the trail was slow, not broken → FALSIFIED.
        return (r?.n || 0) === 0
      }
      case 'veto_count_at_least': {
        const rows = db.prepare(
          `SELECT veto_reason, SUM(COALESCE(repeat_count, 1)) AS n FROM risk_events
            WHERE approved = 0 AND veto_reason IS NOT NULL AND created_at >= ?
            GROUP BY veto_reason`
        ).all(sinceIso)
        let n = 0
        for (const r of rows) if ((guardName(r.veto_reason) || 'unspecified') === metric.guard) n += r.n
        return n >= Number(metric.min)
      }
      case 'action_log_absent': {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM action_log WHERE method = ? AND path = ? AND at >= ?`)
          .get(metric.method, metric.path, sinceIso)
        // Directive repeated → unheeded reading CONFIRMED; absent → falsified.
        return (r?.n || 0) > 0
      }
      case 'dropped_absent': {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM risk_events WHERE disposition = 'dropped' AND disposition_at >= ?`).get(sinceIso)
        return (r?.n || 0) > 0 // more drops → recurring-defect reading confirmed
      }
      case 'lifecycle_rule_recurs':
        // A newer violation of the rule after the finding → the live-defect
        // reading is CONFIRMED; none over a snapshot that covers the window
        // and judged a record made in it → falsified; anything less (no
        // snapshot, a snapshot not after the finding, an unreadable rule) →
        // expired, never decided on absent evidence.
        return lifecycleRuleRecurs(readSnapshot(getState, db), metric)
      case 'lifecycle_rule_persists':
        // A STUCK rule (current state): still violating in a snapshot taken
        // near the deadline → CONFIRMED; 0 → falsified (resolved); no such
        // snapshot (the ticker is dead) → expired.
        return lifecycleRulePersists(readSnapshot(getState, db), metric)
      default:
        return null
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Invariant 3 — the bounded actuator. code_change findings CANNOT reach the
// write path: the whitelist is checked by key shape, never by trust in the
// rule that produced the finding.
// ---------------------------------------------------------------------------
const TIMING_KEY_ALLOWLIST = new Set([
  'monitor_interval_min', // fast-monitor base cadence — the one timing knob today
])

export function applyPrinciple(db, finding, cfg) {
  const kind = finding.principle_kind
  if (kind === 'timing_change' && cfg.autoApplyTiming) {
    const { key, value, revert_to } = finding.principle_params || {}
    if (!TIMING_KEY_ALLOWLIST.has(key)) return { applied: false, status: 'proposed', why: 'key not in timing allowlist' }
    setState(db, key, String(value))
    return { applied: true, status: 'auto_applied', revert_to }
  }
  // strategy_tweak auto-apply REMOVED 02-09-2026 (blueprint audit; owner:
  // "one system"). It was a third strategy-disarm actuator beside the edge
  // watchdog and the adaptive breaker, listed in no design document, and no
  // producer ever emitted `principle_kind: 'strategy_tweak'` — an actuator
  // that was armed, configured and unreachable. The inspector REPORTS; the
  // two live evaluators act, and the autopilot now honours their disarms.
  return { applied: false, status: 'proposed', ...(kind === 'strategy_tweak' ? { why: 'strategy toggles are never the inspector\'s to apply' } : {}) }
}

// ---------------------------------------------------------------------------
// The pass. Called from the fast monitor's due() band (~300s) — NOT the loop,
// so inspection continues when the loop is the broken thing.
// ---------------------------------------------------------------------------
export function runLogInspector(db, { now = Date.now(), notify = null, io = {} } = {}) {
  const cfg = loadInspectorConfig(db)
  if (!cfg.on) return { skipped: 'off' }
  const summary = { found: 0, inserted: 0, autoApplied: 0, proposed: 0, confirmed: 0, falsified: 0, expired: 0, errors: [] }

  // 1. Inspections → candidate findings, deduped structurally on insert.
  const ins = db.prepare(
    `INSERT INTO inspection_findings
       (source, subject_key, speech_act, said, doing, finding, principle_kind, principle_params, falsifier, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(subject_key) WHERE status IN ('open','auto_applied','proposed') DO NOTHING`
  )
  for (const { key, run } of INSPECTIONS) {
    let findings = []
    try { findings = run(db, cfg, now) || [] } catch (e) { summary.errors.push(`${key}: ${e.message}`); continue }
    summary.found += findings.length
    for (const f of findings) {
      try {
        const verdict = f.principle_kind === 'code_change' || f.principle_kind === 'none'
          ? { applied: false, status: 'proposed' }
          : applyPrinciple(db, f, cfg, io)
        const params = { ...(f.principle_params || {}), ...(verdict.revert_to !== undefined ? { revert_to: verdict.revert_to } : {}), ...(verdict.scopes ? { scopes: verdict.scopes } : {}) }
        const r = ins.run(
          f.source, f.subject_key, f.speech_act, f.said, f.doing, f.finding,
          f.principle_kind, JSON.stringify(params), JSON.stringify(f.falsifier), verdict.status,
        )
        if (r.changes > 0) {
          summary.inserted++
          if (verdict.status === 'auto_applied') {
            summary.autoApplied++
            try {
              db.prepare('INSERT INTO action_log (method, path, body) VALUES (?, ?, ?)')
                .run('INSPECTOR', `/auto/${f.subject_key}`, JSON.stringify({ finding: f.finding, falsifier: f.falsifier }).slice(0, 2000))
            } catch { /* audit best-effort */ }
          } else {
            summary.proposed++
          }
        }
      } catch (e) { summary.errors.push(`${f.subject_key}: ${e.message}`) }
    }
  }

  // 2. Falsifier pass: deadlines that have passed get their metric evaluated.
  let due = []
  try {
    due = db.prepare(
      `SELECT id, subject_key, principle_kind, principle_params, falsifier, status
         FROM inspection_findings WHERE status IN ('open','auto_applied','proposed')`
    ).all()
  } catch { due = [] }
  const setStatus = db.prepare(`UPDATE inspection_findings SET status = ?, resolved_at = datetime('now'), resolution = ? WHERE id = ?`)
  for (const row of due) {
    try {
      const fal = JSON.parse(row.falsifier || 'null')
      if (!fal || !(Number(fal.deadlineMs) <= now)) continue
      const held = evalFalsifierMetric(db, fal.metric)
      if (held === null) {
        setStatus.run('expired', 'metric unevaluable at deadline (evidence pruned or absent) — never confirmed on absent evidence', row.id)
        summary.expired++
      } else if (held) {
        setStatus.run('confirmed', `prediction held at deadline: ${fal.prediction}`, row.id)
        summary.confirmed++
      } else {
        setStatus.run('falsified', `prediction failed at deadline: ${fal.prediction}`, row.id)
        summary.falsified++
        // A falsified AUTO action reverts only when its params say so (a
        // timing knob restores its prior value; a disarm stays down — the
        // safe direction is never to re-arm on the inspector's own authority).
        if (row.status === 'auto_applied') {
          try {
            const params = JSON.parse(row.principle_params || '{}')
            if (row.principle_kind === 'timing_change' && params.revert_to !== undefined && TIMING_KEY_ALLOWLIST.has(params.key)) {
              setState(db, params.key, String(params.revert_to))
            }
            notify?.(`🔍 INSPECTOR: auto-action for ${row.subject_key} FALSIFIED — ${row.principle_kind === 'timing_change' ? 'reverted' : 'left in the safe state'}; review from /state/inspector.`)
          } catch { /* revert best-effort; the status row is the record */ }
        }
      }
    } catch (e) { summary.errors.push(`falsifier ${row.subject_key}: ${e.message}`) }
  }

  try { setState(db, 'log_inspector_last_json', JSON.stringify({ at: new Date(now).toISOString(), cfg, ...summary })) } catch { /* best effort */ }
  return summary
}

/** GET /state/inspector payload: open findings + last run + tallies. */
export function inspectorView(db) {
  let open = []
  let terminal = { confirmed: 0, falsified: 0, expired: 0 }
  try {
    open = db.prepare(
      `SELECT id, at, source, subject_key, speech_act, said, doing, finding,
              principle_kind, principle_params, falsifier, status
         FROM inspection_findings WHERE status IN ('open','auto_applied','proposed')
        ORDER BY at DESC LIMIT 100`
    ).all().map(r => ({
      ...r,
      principle_params: (() => { try { return JSON.parse(r.principle_params) } catch { return null } })(),
      falsifier: (() => { try { return JSON.parse(r.falsifier) } catch { return null } })(),
    }))
    for (const r of db.prepare(
      `SELECT status, COUNT(*) AS n FROM inspection_findings
        WHERE status IN ('confirmed','falsified','expired') GROUP BY status`
    ).all()) terminal[r.status] = r.n
  } catch { /* tables absent on first boot */ }
  let lastRun = null
  try { lastRun = JSON.parse(getState(db, 'log_inspector_last_json') || 'null') } catch { /* none */ }
  let history = []
  try {
    history = db.prepare(`SELECT at, verdict, because, considered, approved, vetoed, landed, silent_drops, top_block
                            FROM decision_audit_history ORDER BY id DESC LIMIT 50`).all()
  } catch { /* table absent */ }
  return { findings: open, terminal, lastRun, auditHistory: history }
}
