// Backtest sweep — the pure parts of "test several strategies in order".
//
// Task #158 (owner): "Backtest should be wired to selected strategies, include
// one more call 'All Strategies'." The agent runs ONE backtest at a time
// (agent/services/backtest-job.js keeps a single slot per kind and answers 409
// to a second start), so a sweep is a QUEUE the page drains one strategy at a
// time. The state machine that decides what runs next, and what each pill
// shows, lives here so it is testable without a browser.

/**
 * What a strategy pill is currently doing.
 *
 * 'running' beats 'done': a re-run of a strategy that already has results is
 * running, and showing it as finished would misreport the numbers on screen as
 * the ones being produced.
 *
 * @returns {'running'|'done'|'queued'|'idle'}
 */
export function pillState(key, { runs = {}, runningKey = null, queue = [] } = {}) {
  if (runningKey === key) return 'running'
  if (runs && Object.prototype.hasOwnProperty.call(runs, key)) return 'done'
  if (Array.isArray(queue) && queue.includes(key)) return 'queued'
  return 'idle'
}

/**
 * The button's progress label. `total` is how many strategies the sweep
 * started with, `remaining` how many have not been dispatched yet.
 *
 * The count shown is the strategy IN FLIGHT (dispatched but not finished), so
 * a 12-strategy sweep reads "Testing 1 of 12" while the first one runs, not
 * "0 of 12" or "2 of 12".
 */
export function sweepLabel({ running, total = 0, remaining = 0, runningKey = null, symbolCount = 0 } = {}) {
  if (!running) return `Run backtest (${symbolCount})`
  if (total > 1) return `Testing ${Math.min(total, total - remaining)} of ${total} · ${runningKey || '…'}`
  return `Testing ${symbolCount} symbol${symbolCount === 1 ? '' : 's'}…`
}

/**
 * Decide what happens when a job finishes.
 *
 * Pure: hand it the finished job's strategy key and the queue, get back what
 * to store, what to dispatch next, and whether the sweep is over. A failing
 * strategy does NOT abandon the sweep — its error is reported and the queue
 * moves on, because eleven good results plus one named failure beats stopping
 * at the first bad one.
 */
export function advanceSweep({ ranKey = null, result = null, error = null, queue = [] } = {}) {
  const rest = Array.isArray(queue) ? queue : []
  const nextKey = rest.length ? rest[0] : null
  return {
    // Only a successful run with an attributable strategy is stored.
    store: !error && result && ranKey ? { key: ranKey, result } : null,
    error: error ? `${ranKey ? `${ranKey}: ` : ''}${error}` : null,
    nextKey,
    remaining: rest.slice(1),
    done: nextKey == null,
  }
}
