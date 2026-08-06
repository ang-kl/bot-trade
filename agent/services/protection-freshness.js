// ---------------------------------------------------------------------------
// agent/services/protection-freshness.js — is the protection audit's ANSWER
// still current, or only its heartbeat?
//
// THE CONTRADICTION THIS RESOLVES (Defensive-Drift audit, 2026-08-06, §5.2
// item 5). Read on the same morning, from the same running system:
//
//   /state/heartbeats   protection_audit  status "ok"
//   /state/protection-audit   at 2026-08-04T08:55Z   ageSec 174,009
//                             lastAttemptAt null
//
// Both readings are correct, and together they are a lie. The heartbeat
// answers "did the controller tick?" — it did. Nobody was asking that. The
// question the audit exists to answer is "is every open position actually
// protected right now?", and the last time anything answered it was two days
// earlier. A green light beside a two-day-old answer is worse than no light,
// because the light is the thing an operator checks.
//
// THE DISTINCTION, stated once. A controller has TWO kinds of liveness:
//
//   TICKER liveness  — the process is running.       `controller_heartbeats`
//   PRODUCT liveness — it is still producing answers. the audit's own record
//
// Every watchdog in this repo has measured the first. This measures the
// second, and only for the controller whose product IS the safety property.
// A ticker that beats while the product ages is precisely the failure mode
// §43 was written about: "a position must never be considered safely managed
// merely because the loop is running."
//
// WHAT THIS DOES NOT DO. It changes no protection behaviour, places no order,
// amends no stop, and never suppresses an existing alert. It downgrades one
// status from `ok` to `warn` and emits one alert on the transition. If the
// audit is healthy this file is silent forever, which is the point: a warning
// that is always on is a warning nobody reads, and this repo has already paid
// for that lesson once (heartbeat.js:126 — eight permanently-stalled
// controllers).
// ---------------------------------------------------------------------------

import { getState, setState } from '../db.js'

/**
 * How old a verified reading may be before it stops counting as an answer.
 *
 * The audit runs on the fast monitor's 60-second band, so fifteen minutes is
 * fifteen missed passes — comfortably past noise, nowhere near the 48 HOURS
 * actually observed. Deliberately NOT derived from the loop cadence: an
 * expectation computed from observed cadence stretches as the system degrades,
 * so the alarm quietly follows the failure it exists to catch. Same reasoning
 * as the fixed 60s expectations in CONTROLLERS.
 */
export const DEFAULT_MAX_AGE_SEC = 900

/** Owner override, seconds. 0 or negative disables the check entirely. */
export const MAX_AGE_STATE_KEY = 'protection_audit_max_age_sec'

/** Remembers whether the stale alert has already been sent, so it fires once. */
export const ALERTED_STATE_KEY = 'protection_audit_product_stale_alerted'

export function maxAgeSecFrom(db, fallback = DEFAULT_MAX_AGE_SEC) {
  try {
    const raw = getState(db, MAX_AGE_STATE_KEY)
    // `Number(null)` and `Number('')` are both 0 and finite — and 0 DISABLES
    // this check. An unset key must not silently switch the watchdog off; only
    // a real, explicit 0 may do that.
    if (raw != null && String(raw).trim() !== '') {
      const n = Number(raw)
      if (Number.isFinite(n)) return n
    }
  } catch { /* fall through */ }
  return fallback
}

/**
 * Pure verdict on a protection-audit record's age.
 *
 * @param {object} args
 * @param {string|null} args.at              when the audit last COMPLETED
 * @param {string|null} [args.lastAttemptAt] when it last tried and failed
 * @param {string|null} [args.lastAttemptError]
 * @param {number} [args.maxAgeSec]          0 or less disables the check
 * @param {number} [args.nowMs]
 *
 * @returns {{hasReading: boolean, ageSec: number|null, maxAgeSec: number,
 *   fresh: boolean, enabled: boolean, at: string|null, summary: string}}
 *
 * `fresh` is the whole answer: true when a completed reading exists and is
 * younger than the threshold. NEVER-RUN counts as not fresh — "no answer yet"
 * and "an answer from two days ago" are different sentences but the same
 * operational fact, which is that nothing has verified these positions.
 */
export function protectionFreshness({
  at = null,
  lastAttemptAt = null,
  lastAttemptError = null,
  maxAgeSec = DEFAULT_MAX_AGE_SEC,
  nowMs = Date.now(),
} = {}) {
  const limit = Number.isFinite(Number(maxAgeSec)) ? Number(maxAgeSec) : DEFAULT_MAX_AGE_SEC
  const enabled = limit > 0
  const t = at == null ? NaN : Date.parse(at)
  const hasReading = Number.isFinite(t)
  const ageSec = hasReading ? Math.max(0, Math.round((nowMs - t) / 1000)) : null

  if (!enabled) {
    return {
      hasReading, ageSec, maxAgeSec: limit, enabled: false, fresh: true, at: hasReading ? at : null,
      summary: 'staleness check disabled by configuration',
    }
  }

  const fresh = hasReading && ageSec <= limit
  const attemptNote = lastAttemptError ? ` Last attempt failed: ${lastAttemptError}.` : ''

  let summary
  if (!hasReading) {
    // The heartbeat can be perfectly green here — beating is not answering.
    summary = 'no completed protection audit on record — nothing has verified that open positions are protected'
      + (lastAttemptAt ? ` (last attempt ${lastAttemptAt})` : '') + attemptNote
  } else if (fresh) {
    summary = `verified ${minutes(ageSec)} ago`
  } else {
    summary = `LAST VERIFIED ${minutes(ageSec)} AGO — past the ${minutes(limit)} freshness limit. `
      + 'The controller may still be beating; its answer is not current.' + attemptNote
  }
  return { hasReading, ageSec, maxAgeSec: limit, enabled: true, fresh, at: hasReading ? at : null, summary }
}

/** 174009 → "48h 20m"; 900 → "15m". Hours matter here — the observed gap was days. */
export function minutes(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h}h ${rem}m` : `${h}h`
}

/**
 * The freshness of the whole book's protection audit, read from the DB.
 * Imports lazily so heartbeat.js does not pull the guard's world in at module
 * load — and returns a shaped answer rather than throwing, because a watchdog
 * that can fail to report is the bug it is watching for.
 */
export function protectionFreshnessFrom(db, { nowMs = Date.now(), maxAgeSec = null, lastAudit = null } = {}) {
  const limit = maxAgeSec != null ? maxAgeSec : maxAgeSecFrom(db)
  let rec = lastAudit
  if (rec == null) {
    try {
      rec = JSON.parse(getState(db, 'protection_audit_last_json') || '{}')
    } catch { rec = {} }
  }
  return protectionFreshness({
    at: rec?.at ?? null,
    lastAttemptAt: rec?.lastAttemptAt ?? null,
    lastAttemptError: rec?.lastAttemptError ?? null,
    maxAgeSec: limit,
    nowMs,
  })
}

/**
 * Alert ONCE when the product goes stale, and once when it comes back.
 *
 * Edge-triggered on purpose. The audit is checked every heartbeat sweep; a
 * level-triggered alert would send the same message every sweep for two days,
 * and the operator would filter it — which is how the original 48-hour gap
 * survived in plain sight beside a green light.
 *
 * @returns {{event: 'stale'|'recovered'|null, freshness: object}}
 */
export function checkProtectionFreshness(db, { nowMs = Date.now(), notify = null, maxAgeSec = null, audit = null } = {}) {
  const freshness = protectionFreshnessFrom(db, { nowMs, maxAgeSec })
  if (!freshness.enabled) return { event: null, freshness }

  let alerted = false
  try { alerted = String(getState(db, ALERTED_STATE_KEY) || '') === '1' } catch { alerted = false }
  const say = (text) => { try { notify?.(text) } catch { /* alerting must never throw */ } }
  const mark = (v) => { try { setState(db, ALERTED_STATE_KEY, v) } catch { /* non-fatal */ } }

  // ALERT ON AN ANSWER THAT WENT STALE, not on one that never existed.
  //
  // A database with no audit record at all is a fresh install or a service that
  // has not completed its first pass — and this function runs on every
  // heartbeat sweep, including the first one after a deploy. Alerting there
  // would put a red line in front of the owner on every boot, which is the
  // "watchdog that is always red" failure this repo has already paid for once
  // (heartbeat.js:126, eight permanently-stalled controllers).
  //
  // Never-run is NOT thereby hidden: `work_product.fresh` is false on the
  // panel, the status is not `ok`, and /state/protection-audit has said "never
  // run — no open position has been verified as protected" since ¶D·2. What was
  // missing, and what this alerts on, is the case actually observed on
  // 2026-08-06 — a real answer, two days old, under a green light.
  if (freshness.hasReading && !freshness.fresh && !alerted) {
    mark('1')
    say(`🔴 PROTECTION AUDIT NOT CURRENT: ${freshness.summary} Its heartbeat may read "ok" — that means the controller ticked, not that any position was checked.`)
    try { audit?.(db, { controller: 'protection_audit', event: 'product_stale', detail: freshness.summary }) } catch { /* non-fatal */ }
    return { event: 'stale', freshness }
  }
  if (freshness.fresh && freshness.hasReading && alerted) {
    mark('0')
    say(`🔵 PROTECTION AUDIT CURRENT AGAIN: ${freshness.summary}.`)
    try { audit?.(db, { controller: 'protection_audit', event: 'product_fresh', detail: freshness.summary }) } catch { /* non-fatal */ }
    return { event: 'recovered', freshness }
  }
  return { event: null, freshness }
}
