import { setImmediate as yieldTurn } from 'node:timers/promises'
import { pollScannerMirrors } from './scanner-candidates.js'
import { TickComparisonReader, retainComparisons, comparisonMemo, validateComparisonPage } from './scanner-comparison.js'
import { scannerRequest } from './scanner-feed.js'
import { setState } from '../db.js'
import { withRetentionDiagnostic } from './contention-diagnostic.js'

// Codex · №12,751 · 2026-10-10; codex-footprint: bounded-comparison-commits.
// The captured 128-row transaction blocked a main state write throughout its
// 572 ms busy interval. Release between pairs; no hardware-time guarantee.
const COMPARISON_COMMIT_ROWS = 2

// Runs only inside the separately enabled observation worker. Each round
// services both candidate streams before a bounded tick-comparison drain.
export function createScannerCollector(db, deps = {}) {
  const tick = deps.reader ?? new TickComparisonReader(), env = deps.env ?? process.env
  const now = deps.now ?? Date.now, request = deps.request ?? scannerRequest
  const mirrors = deps.mirrors ?? (options => pollScannerMirrors(db, options))
  let running = false, lastRetention = null, lastWrite = null, lastError = null
  return async function collect() {
    if (running) return { skipped: 'in_flight', delayMs: 100 }
    running = true
    const started = now(), out = { readAtMs: started, orderAuthority: false, tickPages: 0, tickCommits: 0, tickRecords: 0, tickBacklog: false }
    try {
      if (lastRetention == null || started - lastRetention >= 60_000) {
        // Codex · №12,809 · 2026-10-10; codex-footprint: retention-lifecycle-attribution.
        withRetentionDiagnostic(db, () => retainComparisons(db, started)); lastRetention = started
      }
      out.mirrors = await mirrors({ env, now })
      if (env.SCANNER_TICK_URL && env.SCANNER_TICK_SECRET) {
        // Candidate polling may use its own two-second HTTP deadlines. It
        // must not consume the comparison drain's budget before page one.
        const tickStarted = now()
        for (let pages = 0; pages < 8 && (pages === 0 || now() - tickStarted < 1000); pages++) {
          let page = await request(env.SCANNER_TICK_URL, env.SCANNER_TICK_SECRET, `/comparisons?after=${tick.after}`)
          if (tick.instance && tick.instance !== page.instanceId) page = await request(env.SCANNER_TICK_URL, env.SCANNER_TICK_SECRET, '/comparisons?after=0')
          validateComparisonPage(page)
          const before = tick.instance === page.instanceId ? tick.after : 0
          out.tickBacklog = before < page.latestCursor
          const remaining = page.candidates.filter(row => row.cursor > before), memo = comparisonMemo()
          // One bounded memo per native page: do not reparse the registry and
          // account maps for every prefix. Never retain it for another fetch.
          for (let offset = 0; offset < Math.max(1, remaining.length) && (offset === 0 || now() - tickStarted < 1000); offset += COMPARISON_COMMIT_ROWS) {
            const prefix = { ...page, gap: offset === 0 && page.gap, candidates: remaining.slice(offset, offset + COMPARISON_COMMIT_ROWS) }
            tick.consume(db, prefix, now(), memo)
            if (offset === 0) out.tickPages++
            out.tickCommits++; out.tickRecords += prefix.candidates.length
            out.tickBacklog = tick.after < page.latestCursor
            if (out.tickBacklog && (tick.after === before || !remaining.length)) throw new Error('comparison_cursor_no_progress')
            if (out.tickBacklog) await (deps.yieldTurn ?? yieldTurn)()
          }
          // Budget exhaustion leaves the exact committed cursor. The next
          // fetch resumes its suffix; nothing is dropped or marked consumed.
          if (!out.tickBacklog) break
        }
      }
      const backlog = out.tickBacklog || out.mirrors.outcomes?.some(o => o.backlog)
      const unavailable = out.mirrors.outcomes?.some(o => o.status === 'unavailable')
      out.delayMs = unavailable ? 1000 : backlog ? 10 : 100
    } catch { out.error = 'comparison_read_or_contract_failed'; out.delayMs = 1000 }
    finally { running = false }
    out.tickCursor = tick.after; out.durationMs = now() - started
    // The round record is written at most once a second. Rounds run every
    // 10-100 ms, and each write takes the SQLite write lock that the main
    // thread (busy_timeout 5000, synchronous) waits on. An error in a skipped
    // round is not lost: the latest one rides every later record.
    if (out.error) lastError = { error: out.error, atMs: started }
    if (lastError) out.lastError = lastError
    if (lastWrite == null || started - lastWrite >= 1000) {
      setState(db, 'scanner_bridge_poll_json', JSON.stringify(out)); lastWrite = started
    }
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
