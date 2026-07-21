// ---------------------------------------------------------------------------
// agent/lib/diagnostics.js — exhaustive lifecycle + crash diagnostics.
//
// Owner will paste Railway logs to find why the process restarts every ~4 min.
// Every line is prefixed `[diag]` so it greps cleanly, and each event that
// could end or stall the process is logged with memory + uptime so the LAST
// lines before a restart tell the story:
//
//   · BOOT ................ a fresh process started (deploy OR crash-restart) —
//                           compare `commit` across restarts: SAME commit =
//                           crash/kill; NEW commit = a redeploy (e.g. a merge).
//   · SIGNAL SIGTERM ...... Railway asked it to stop (deploy handover, or a
//                           failed /health healthcheck). Graceful, not a crash.
//   · UNCAUGHT / UNHANDLED  a real error escaped — full stack is logged.
//   · ALIVE ............... periodic heartbeat: rising `rss` before a gap ⇒ OOM
//                           kill (SIGKILL can't log); a big `loopLag` ⇒ the
//                           event loop was blocked (healthcheck would time out).
//   · EXIT code=N ......... the process is leaving; N!=0 ⇒ crash → ON_FAILURE
//                           restart. (An OOM SIGKILL produces NO exit line.)
// ---------------------------------------------------------------------------

function memStr() {
  const m = process.memoryUsage()
  const mb = (b) => (b / 1048576).toFixed(0)
  return `rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ext=${mb(m.external)}MB`
}

/**
 * Install process-lifecycle diagnostics. Safe to call once at boot. Uses
 * `uncaughtExceptionMonitor` (log-only, does NOT change the existing swallow
 * behaviour) so it never alters crash semantics — purely observability.
 */
export function installProcessDiagnostics({ version = '?', commit = '?' } = {}) {
  console.log(`[diag] BOOT pid=${process.pid} node=${process.version} version=${version} commit=${commit} ${memStr()}`)

  process.on('exit', (code) => {
    console.log(`[diag] EXIT code=${code} uptime=${process.uptime().toFixed(1)}s ${memStr()}`)
  })
  process.on('beforeExit', (code) => {
    // Fires only if the event loop emptied with no pending work — for a server
    // that should NEVER happen; if it does, a timer/listener was lost.
    console.log(`[diag] BEFORE_EXIT code=${code} uptime=${process.uptime().toFixed(1)}s — event loop drained (unexpected for a server)`)
  })
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR2']) {
    process.on(sig, () => {
      console.log(`[diag] SIGNAL ${sig} received uptime=${process.uptime().toFixed(1)}s ${memStr()} — external stop (deploy handover or failed healthcheck), not a code crash`)
    })
  }
  // Monitor variant: logs WITHOUT consuming the event, so index.js's own
  // uncaughtException handler still runs and still swallows (keeps the process
  // alive). We just get the full stack for the log.
  process.on('uncaughtExceptionMonitor', (err, origin) => {
    console.error(`[diag] UNCAUGHT_EXCEPTION origin=${origin} uptime=${process.uptime().toFixed(1)}s ${memStr()}\n`, err?.stack || err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error(`[diag] UNHANDLED_REJECTION uptime=${process.uptime().toFixed(1)}s ${memStr()}\n`, reason?.stack || reason)
  })
  process.on('warning', (w) => {
    console.warn(`[diag] WARNING ${w.name}: ${w.message}`)
  })
}

/**
 * Periodic "still alive" heartbeat to stdout with memory, event-loop lag and a
 * few loop stats. `getStats()` returns a plain object (best-effort). Returns the
 * timer (unref'd so it never keeps the process alive on its own).
 */
export function startHeartbeatLog(getStats, intervalMs = 30_000) {
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    const lag = now - last - intervalMs   // how late this tick fired = event-loop block
    last = now
    let s = {}
    try { s = getStats?.() || {} } catch { /* stats best-effort */ }
    console.log(
      `[diag] ALIVE uptime=${process.uptime().toFixed(0)}s ${memStr()} loopLag=${lag}ms ` +
      `loopCount=${s.loopCount ?? '?'} lastLoopMs=${s.lastLoopMs ?? '?'} lastScanMs=${s.lastScanMs ?? '?'} ` +
      `openTrades=${s.openTrades ?? '?'} openPositions=${s.openPositions ?? '?'} lastScanAt=${s.lastScanAt ?? '?'}`,
    )
  }, intervalMs)
  timer.unref?.()
  return timer
}
