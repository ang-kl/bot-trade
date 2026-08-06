// ---------------------------------------------------------------------------
// agent/services/housekeeping-run.js — run a housekeeping pass so that one
// broken step cannot silently cancel the rest of it.
//
// THE DEFECT THIS EXISTS FOR (measured 2026-08-06, production, after #668
// deployed). `/state/dispositions?days=7` answered:
//
//   {"counts":{},"dropped":[],"latency":null,"pendingNow":55443}
//
// Fifty-five thousand approvals with no terminal state, and not one settled —
// even though the disposition sweep that settles them had just been restored
// to a wall-clock cadence and the process had restarted onto that fix.
//
// The sweep lives at the END of the housekeeping block in loop.js. Ahead of it
// sit eight retention deletes (`d1`…`d8`) which were NOT individually guarded,
// under a comment asserting the opposite: "Every step below is individually
// try/caught anyway, so a partial pass still makes progress." They are not, and
// it does not. One throw — a lock on a 526 MB database, a table a migration has
// not created yet, a prune helper meeting an unexpected row — lands in the
// block's single outer catch, and everything after the throw is skipped.
//
// And it is skipped for EIGHT HOURS, because the schedule stamp is written
// BEFORE the work (deliberately: a pass that throws must not re-run and
// re-throw on the very next loop). Stamp-before-work is right. Stamp-before-work
// combined with one shared try is what turns a single failing delete into a
// silent, self-renewing outage of every later step.
//
// So the shape of the bug is exactly the shape of the finding it was hiding:
// something said yes, nothing acted, and nobody was told.
//
// THE RULE HERE. Every step runs in its own try. A failure is recorded and the
// pass continues. The caller gets back which steps ran, which failed and why,
// so "housekeeping ran" stops being a claim and becomes a list.
// ---------------------------------------------------------------------------

import { getState } from '../db.js'
import { housekeepingDue, LAST_RUN_KEY, DEFAULT_INTERVAL_MS } from './housekeeping-due.js'

/**
 * Run housekeeping steps, isolating each one.
 *
 * @param {Array<{name: string, run: () => any}>} steps
 *   `run` may be sync or async; its resolved value is kept under `results`.
 * @param {{log?: (msg: string) => void}} [opts]
 * @returns {Promise<{results: Record<string, any>, failed: Array<{name: string, message: string}>, ran: number}>}
 */
export async function runHousekeepingSteps(steps, { log } = {}) {
  const results = {}
  const failed = []
  let ran = 0
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step.run !== 'function') continue
    const name = String(step.name || 'unnamed')
    try {
      results[name] = await step.run()
      ran++
    } catch (err) {
      const message = err?.message ? String(err.message) : String(err)
      failed.push({ name, message })
      // Say it once, here, rather than in eight call sites. A housekeeping
      // step that fails every pass for a week is a thing worth reading in the
      // log; a step that fails silently is how this file came to exist.
      if (typeof log === 'function') log(`Housekeeping step "${name}" failed (non-fatal): ${message}`)
    }
  }
  return { results, failed, ran }
}

/**
 * `changes` from a better-sqlite3 run result, or 0 for a step that failed or
 * returned something else. Keeps the summary line total-safe when a delete
 * did not happen — printing "pruned undefined rows" after a failure would be
 * a second, smaller lie on top of the first.
 */
export function changesOf(result) {
  const n = Number(result?.changes)
  return Number.isFinite(n) ? n : 0
}

/**
 * What the last housekeeping pass actually did — for a read-only route.
 *
 * PR #670 established the mechanism (an unguarded step cancels every later
 * step, including the disposition sweep) but could not name the failing step,
 * because housekeeping's only output was console logging that no route can
 * query. The consequence was visible in the numbers: `/state/dispositions`
 * answered `counts {}` with a rising backlog and nothing on the wire could say
 * whether the sweep had run and failed, or simply never run.
 *
 * `dueIn` is the other half of that question. The schedule stamp is written
 * before the work, so a pass that failed at 04:00 cannot try again until
 * 12:00 — and "the fix is deployed but the window has not come round" reads
 * identically to "the fix did not work" unless the next window is stated.
 *
 * @returns {{lastAt: string|null, nextDueAt: string|null, dueInMs: number|null,
 *   due: boolean, lastResult: object|null}}
 */
export function housekeepingStatus(db, nowMs = Date.now()) {
  let lastAt = null, lastResult = null
  try { lastAt = getState(db, LAST_RUN_KEY) || null } catch { lastAt = null }
  try { lastResult = JSON.parse(getState(db, 'housekeeping_last_result_json') || 'null') } catch { lastResult = null }
  const t = lastAt ? Date.parse(String(lastAt)) : NaN
  const nextMs = Number.isFinite(t) ? t + DEFAULT_INTERVAL_MS : null
  return {
    lastAt,
    nextDueAt: nextMs != null ? new Date(nextMs).toISOString() : null,
    dueInMs: nextMs != null ? Math.max(0, nextMs - nowMs) : null,
    due: housekeepingDue(lastAt, nowMs),
    lastResult,
  }
}
