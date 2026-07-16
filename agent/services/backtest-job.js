// ---------------------------------------------------------------------------
// agent/services/backtest-job.js — single-slot background job for the manual
// backtest.
//
// Why: the backtest used to run inside the POST request, so it lived exactly
// as long as the browser tab that fired it — navigate away and the finished
// results had nobody to deliver them to (owner hit this). Now the agent owns
// the run: POST starts the job and returns immediately; the results wait
// here until any page asks GET /state/backtest-job for them.
//
// Deliberately one slot: backtests hammer the broker's trendbar API, and two
// concurrent manual runs is never what the owner means. A second POST while
// one is running gets a 409 with the running job's metadata. In-memory only —
// a redeploy forgets the result, same as the reports directory.
// ---------------------------------------------------------------------------

let seq = 0
const store = { current: null }

/** Metadata-only view (no result payload — that can be megabytes). */
export function jobMeta(job = store.current) {
  if (!job) return null
  const { id, status, params, startedAt, finishedAt, error } = job
  return { id, status, params, startedAt, finishedAt, error }
}

export function currentJob() {
  return store.current
}

/**
 * Start the single backtest job. `work` is an async fn returning the result
 * payload. Returns { job } on start, { conflict } when one is already
 * running. Failures land in job.error — never thrown to the caller.
 */
export function startBacktestJob(params, work) {
  if (store.current?.status === 'running') return { conflict: store.current }
  const job = {
    id: `bt-${++seq}-${Date.now().toString(36)}`,
    status: 'running',
    params: params || {},
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    result: null,
  }
  store.current = job
  Promise.resolve()
    .then(work)
    .then((result) => { job.result = result; job.status = 'done' })
    .catch((err) => { job.error = err?.message || String(err); job.status = 'error' })
    .finally(() => { job.finishedAt = new Date().toISOString() })
  return { job }
}

/** Test hook — forget the current job. */
export function _resetBacktestJob() {
  store.current = null
}
