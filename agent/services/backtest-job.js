// ---------------------------------------------------------------------------
// agent/services/backtest-job.js — background jobs for slow owner actions.
//
// Why: long POSTs (backtest, cup screener) used to run inside the request,
// so they lived exactly as long as the browser tab that fired them —
// navigate away and the finished results had nobody to deliver them to
// (owner hit this twice). Now the AGENT owns the run: POST starts the job
// and returns immediately; the results wait here until any page asks
// GET /state/job/:kind for them.
//
// One slot PER KIND: these jobs hammer the broker's trendbar API, and two
// concurrent runs of the same kind is never what the owner means. A second
// start while one runs returns { conflict }. In-memory only — a redeploy
// forgets results, same lifetime as the reports directory.
// ---------------------------------------------------------------------------

let seq = 0
const store = new Map() // kind → job

/** Metadata-only view (no result payload — that can be megabytes). */
export function jobMeta(job = getJob('backtest')) {
  if (!job) return null
  const { id, kind, status, params, startedAt, finishedAt, error } = job
  return { id, kind, status, params, startedAt, finishedAt, error }
}

export function getJob(kind) {
  return store.get(kind) || null
}

/**
 * Start the single job of this kind. `work` is an async fn returning the
 * result payload. Returns { job } on start, { conflict } when one is
 * already running. Failures land in job.error — never thrown to the caller.
 */
export function startJob(kind, params, work) {
  const existing = store.get(kind)
  if (existing?.status === 'running') return { conflict: existing }
  const job = {
    id: `${kind}-${++seq}-${Date.now().toString(36)}`,
    kind,
    status: 'running',
    params: params || {},
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    result: null,
  }
  store.set(kind, job)
  Promise.resolve()
    .then(work)
    .then((result) => { job.result = result; job.status = 'done' })
    .catch((err) => { job.error = err?.message || String(err); job.status = 'error' })
    .finally(() => { job.finishedAt = new Date().toISOString() })
  return { job }
}

// --- Backtest-flavoured aliases (existing callers/tests) -------------------
export const startBacktestJob = (params, work) => startJob('backtest', params, work)
export const currentJob = () => getJob('backtest')

/** Test hook — forget all jobs. */
export function _resetBacktestJob() {
  store.clear()
}
