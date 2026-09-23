// Question: does the full funnel retain exact counts without monopolising the
// protection event loop? Fixed synthetic population, no broker/production I/O.
// Pass: baseline parity, all rows counted, worker heartbeat maximum < 200 ms.
// Stop after one baseline and one worker report; the worker has a 15 s deadline.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { initDB } from '../agent/db.js'
import { readCupHandleFunnel } from '../agent/services/performance-populations.js'

const rows = Number(process.argv[2] || 2600000)
assert.ok(Number.isInteger(rows) && rows > 0 && rows <= 5000000)
const baselineRef = '92e01e4aa228d621b286c41b4e36d9dc00acf2c2'
const source = execFileSync('git', ['show', `${baselineRef}:agent/services/cup-handle-funnel.js`], { encoding: 'utf8' })
  .replace("'./cup-handle.js'", JSON.stringify(new URL('../agent/services/cup-handle.js', import.meta.url).href))
const { cupHandleFunnel } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const dir = mkdtempSync(join(tmpdir(), 'report-isolation-'))
const db = initDB(join(dir, 'fixture.db'))
const now = Date.UTC(2026, 8, 23, 18)
const insert = db.prepare(`INSERT INTO cup_handle_diagnostics
  (symbol, timeframe, scanned_at, bias, uptrend_ok, candidate_json, blocked_at)
  VALUES (?, '1h', ?, ?, ?, ?, ?)`)
try {
  db.transaction(() => {
    for (let i = 0; i < rows; i++) {
      let at = new Date(now - (i % 144) * 3600000).toISOString()
      if (i % 2) at = at.replace('T', ' ')
      insert.run(`SYM${i % 500}`, at, i % 2 ? 'long' : 'short', i % 3 ? 1 : 0,
        i % 5 ? '{"rim":1,"bottom":0.5,"handle":0.8}' : null, i % 7 ? 'handle_range' : null)
    }
  })()
  db.pragma('wal_checkpoint(TRUNCATE)')
  async function measure(run) {
    const samples = []
    let previous = performance.now()
    const timer = setInterval(() => { const current = performance.now(); samples.push(current - previous); previous = current }, 5)
    try {
      await delay(15)
      const start = performance.now()
      const report = await run()
      const elapsedMs = performance.now() - start
      await delay(15)
      samples.sort((a, b) => a - b)
      const percentile = p => samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)]
      return { report, elapsedMs, heartbeat: { n: samples.length, p95Ms: percentile(.95), p99Ms: percentile(.99), maxMs: samples.at(-1) } }
    } finally { clearInterval(timer) }
  }
  const baseline = await measure(() => cupHandleFunnel(db, { now }))
  const worker = await measure(() => readCupHandleFunnel(db, { now }))
  assert.deepEqual(worker.report, baseline.report)
  assert.equal(worker.report.traces, rows)
  assert.ok(worker.heartbeat.maxMs < 200, `worker heartbeat ${worker.heartbeat.maxMs}ms`)
  console.log(JSON.stringify({ question: 'diagnostic report isolation, not broker-confirmed protection latency',
    timestamp: new Date().toISOString(), baselineRef, rows, symbols: worker.report.symbols,
    parity: 'passed', baseline: { elapsedMs: baseline.elapsedMs, heartbeat: baseline.heartbeat },
    worker: { elapsedMs: worker.elapsedMs, heartbeat: worker.heartbeat } }, null, 2))
} finally {
  db.close()
  rmSync(dir, { recursive: true, force: true })
}
