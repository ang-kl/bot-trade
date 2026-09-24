import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { getState } from '../db.js'
import { stageMatrixStats } from './stage-matrix.js'

const flights = new WeakMap()

export function buildHeavyStateReport(db, kind, options = {}) {
  if (kind === 'decisions-daily') {
    const days = Math.min(365, Math.max(1, Number(options.days) || 90))
    const clauses = ["created_at >= datetime('now', ?)"]
    const params = [`-${days} days`]
    if (options.accountId != null) { clauses.push('account_id = ?'); params.push(String(options.accountId)) }
    const rows = db.prepare(
      `SELECT substr(created_at, 1, 10) AS day,
              SUM(approved = 1) AS approved,
              SUM(CASE WHEN approved = 1 THEN 0 ELSE COALESCE(repeat_count, 1) END) AS vetoed,
              SUM(approved != 1 OR approved IS NULL) AS vetoed_distinct
         FROM risk_events
        WHERE ${clauses.join(' AND ')}
        GROUP BY day ORDER BY day`
    ).all(...params)
    return { days, rows }
  }
  if (kind === 'prices') {
    const rows = db.prepare(
      `SELECT s.symbol, s.price, s.bias, s.confidence, s.scanned_at
         FROM scans s
         JOIN (
           SELECT symbol, MAX(id) AS id
             FROM scans
            WHERE price IS NOT NULL
            GROUP BY symbol
         ) latest ON latest.id = s.id
        ORDER BY s.symbol`
    ).all()
    const prices = {}
    for (const r of rows) prices[r.symbol] = { price: r.price, bias: r.bias, confidence: r.confidence, at: r.scanned_at }
    return { prices }
  }
  if (kind === 'stage-matrix-stats') return { stats: stageMatrixStats(db, getState) }
  throw new Error('heavy_state_report_kind')
}

export function readHeavyStateReport(db, kind, options = {}) {
  const run = () => buildHeavyStateReport(db, kind, options)
  if (db.memory || db.name === ':memory:') return Promise.resolve(run())
  if (!flights.has(db)) flights.set(db, new Map())
  const active = flights.get(db), key = JSON.stringify([kind, options])
  if (active.has(key)) return active.get(key)
  if (active.size >= 2) return Promise.reject(new Error('heavy_state_report_worker_capacity'))
  const job = new Promise((resolve, reject) => {
    let worker
    try {
      worker = new Worker(new URL(import.meta.url), {
        workerData: { path: db.name, kind, options },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      })
    } catch (error) {
      queueMicrotask(() => active.delete(key))
      reject(error)
      return
    }
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (error) reject(error); else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('heavy_state_report_deadline')), 15000)
    worker.once('message', msg => finish(msg.ok ? null : new Error(msg.error), msg.report))
    worker.once('error', error => finish(error))
    worker.once('exit', () => {
      active.delete(key)
      if (!settled) finish(new Error('heavy_state_report_worker_exit'))
    })
  })
  active.set(key, job)
  return job
}

if (!isMainThread && workerData?.path) {
  let db
  try {
    db = new Database(workerData.path, { readonly: true, fileMustExist: true, timeout: 1000 })
    const report = db.transaction(() => buildHeavyStateReport(db, workerData.kind, workerData.options))()
    if (Buffer.byteLength(JSON.stringify(report)) > 4 * 1024 * 1024) throw new Error('heavy_state_report_response_bound')
    parentPort.postMessage({ ok: true, report })
  } catch (error) {
    parentPort.postMessage({ ok: false, error: error.message })
  } finally {
    db?.close()
  }
}
