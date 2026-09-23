import { setImmediate as yieldTurn } from 'node:timers/promises'
import { pollScannerMirrors } from './scanner-candidates.js'
import { TickComparisonReader, retainComparisons } from './scanner-comparison.js'
import { scannerRequest } from './scanner-feed.js'
import { setState } from '../db.js'

// Runs only inside the separately enabled observation worker. Each round
// services both candidate streams before a bounded tick-comparison drain.
export function createScannerCollector(db, deps = {}) {
  const tick = deps.reader ?? new TickComparisonReader(), env = deps.env ?? process.env
  const now = deps.now ?? Date.now, request = deps.request ?? scannerRequest
  const mirrors = deps.mirrors ?? (options => pollScannerMirrors(db, options))
  let running = false, lastRetention = null
  return async function collect() {
    if (running) return { skipped: 'in_flight', delayMs: 100 }
    running = true
    const started = now(), out = { readAtMs: started, orderAuthority: false, tickPages: 0, tickRecords: 0, tickBacklog: false }
    try {
      if (lastRetention == null || started - lastRetention >= 60_000) { retainComparisons(db, started); lastRetention = started }
      out.mirrors = await mirrors({ env, now })
      if (env.SCANNER_TICK_URL && env.SCANNER_TICK_SECRET) {
        for (let pages = 0; pages < 8 && now() - started < 1000; pages++) {
          let page = await request(env.SCANNER_TICK_URL, env.SCANNER_TICK_SECRET, `/comparisons?after=${tick.after}`)
          if (tick.instance && tick.instance !== page.instanceId) page = await request(env.SCANNER_TICK_URL, env.SCANNER_TICK_SECRET, '/comparisons?after=0')
          const before = tick.after
          tick.consume(db, page, now())
          out.tickPages++; out.tickRecords += page.candidates.length
          out.tickBacklog = tick.after < page.latestCursor
          if (out.tickBacklog && (tick.after === before || !page.candidates.length)) throw new Error('comparison_cursor_no_progress')
          if (!out.tickBacklog) break
          await (deps.yieldTurn ?? yieldTurn)()
        }
      }
      const backlog = out.tickBacklog || out.mirrors.outcomes?.some(o => o.backlog)
      const unavailable = out.mirrors.outcomes?.some(o => o.status === 'unavailable')
      out.delayMs = unavailable ? 1000 : backlog ? 10 : 100
    } catch { out.error = 'comparison_read_or_contract_failed'; out.delayMs = 1000 }
    finally { running = false }
    out.tickCursor = tick.after; out.durationMs = now() - started
    setState(db, 'scanner_bridge_poll_json', JSON.stringify(out))
    return out
  }
}
export function startScannerCollector(db, deps = {}) {
  const collect = createScannerCollector(db, deps), schedule = deps.setTimeout ?? setTimeout
  let stopped = false, timer
  async function round() {
    let delay = 1000
    try { delay = (await collect()).delayMs } catch { /* database unavailable, back off */ }
    if (!stopped) timer = schedule(round, delay)
  }
  timer = schedule(round, 0)
  return () => { stopped = true; (deps.clearTimeout ?? clearTimeout)(timer) }
}
